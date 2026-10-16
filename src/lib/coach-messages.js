/**
 * coach-messages.js: a coaching conversation on this device (the same design
 * as NutriTrace's).
 *
 * Messages are kept on the device (the browser's offline database, the
 * Android app's SQLite) so a conversation opens in a dead zone. A message
 * written here is kept first, with a uuid made here, and then sent; one
 * that can't go waits and goes later (when the connection is back, the app
 * comes to the front, or the Android app syncs). The server stores a uuid
 * once, so a retry after a lost answer never makes a second copy.
 *
 * They are sent from here rather than through the offline outbox: neither
 * the web app's offline layer nor the Android app's queue takes a coaching
 * write (they refuse it offline), so nothing sends one twice.
 *
 * A conversation is { pairingId, side: 'client' | 'coach', clientId }: the
 * client reaches theirs by the pairing, a coach by the client.
 */
import { isNative } from './platform.js';
import { coachingFetch } from '../stores/coaching.js';
import { forgetCoachPhotos } from './coach-photos.js';

export const MESSAGE_MAX = 4000;

export function conversationPath(conv) {
  return conv.side === 'coach'
    ? `/api/coaching/clients/${conv.clientId}/messages`
    : `/api/coaching/pairings/${conv.pairingId}/messages`;
}

const _sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const _me = () => Number(localStorage.getItem('wl:userId')) || null;
export const newMessageId = () => (globalThis.crypto?.randomUUID?.()
  || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ── Where the messages are kept ─────────────────────────────────────────────
async function _store() {
  if (isNative) {
    const n = await import('./db-native.js');
    return {
      available: async () => true,
      forget: (uuid) => n.dbForgetCoachMessage(uuid),
      list: (pid) => n.dbCoachMessages(pid),
      upsert: (rows) => n.dbUpsertCoachMessages(rows),
      queue: async (row) => { await n.dbQueueCoachMessage(row); return true; },
      pending: () => n.dbPendingCoachMessages(),
      fail: (uuid, err) => n.dbFailCoachMessage(uuid, err),
      remove: (uuid) => n.dbDeleteCoachMessage(uuid),
      keep: (pids) => n.dbKeepCoachConversations(pids),
    };
  }
  const { coachStore: s } = await import('./offline-api.js');
  const all = async () => (await s.all('coach_messages')) || [];
  // Same second: in the server's order, and what hasn't gone yet after.
  const byTime = (a, b) => String(a.created_at).localeCompare(String(b.created_at))
    || ((a.id ?? Infinity) - (b.id ?? Infinity)) || String(a.uuid).localeCompare(String(b.uuid));
  return {
    available: () => s.available(),
    forget: (uuid) => s.del('coach_messages', [uuid]),
    list: async (pid) => (await all()).filter(m => m.pairing_id === Number(pid)).sort(byTime),
    upsert: async (rows) => {
      const mine = new Map((await all()).map(m => [m.uuid, m]));
      const put = rows.filter(r => r?.uuid && !(mine.get(r.uuid)?.sync_status === 'pending_delete' && !r.deleted_at))
        .map(r => ({ ...r, sync_status: 'synced', image_local: null, error: null }));
      if (put.length) await s.put('coach_messages', put);
    },
    queue: (row) => s.put('coach_messages', [row]),
    pending: async () => (await all()).filter(m => m.sync_status === 'pending' || m.sync_status === 'pending_delete').sort(byTime),
    fail: async (uuid, err) => {
      const m = (await all()).find(x => x.uuid === uuid);
      if (m) await s.put('coach_messages', [{ ...m, sync_status: 'failed', error: String(err || '') }]);
    },
    remove: async (uuid) => {
      const m = (await all()).find(x => x.uuid === uuid);
      if (!m) return;
      // Never could go: gone. Still going (perhaps already arrived): the delete
      // follows it, so an answer coming back can't bring it back.
      if (m.sync_status === 'failed') return s.del('coach_messages', [uuid]);
      await s.put('coach_messages', [{ ...m, body: null, image: null, image_local: null, deleted_at: _sqlNow(), sync_status: 'pending_delete' }]);
    },
    keep: async (pids) => {
      const keep = new Set((pids || []).map(Number));
      // Never what is still waiting to go: a stale list must not lose it.
      const gone = (await all()).filter(m => !keep.has(m.pairing_id) && m.sync_status !== 'pending' && m.sync_status !== 'pending_delete');
      if (gone.length) await s.del('coach_messages', gone.map(m => m.uuid));
      return gone.map(m => m.image).filter(Boolean);
    },
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────
/** What this device holds for a conversation, oldest first. */
export async function loadConversation(conv) {
  return (await _store()).list(conv.pairingId);
}

const _cursorKey = (conv) => `lt:coach-cursor:${_me() || ''}:${conv.pairingId}`;

/** Photos of messages deleted on the other side: their copies here go too. */
async function _forgetDeletedPhotos(store, rows) {
  const gone = rows.filter(r => r?.deleted_at);
  if (!gone.length) return;
  const paths = [];
  for (const pid of new Set(gone.map(r => r.pairing_id))) {
    for (const m of await store.list(pid)) if (m.image && gone.some(g => g.uuid === m.uuid)) paths.push(m.image);
  }
  if (paths.length) await forgetCoachPhotos(paths);
}

/**
 * Ask the server what changed since the last look, and keep it.
 * Returns { can_send, status } (throws when it can't be reached).
 */
export async function refreshConversation(conv) {
  const store = await _store();
  const usable = await store.available();
  // The cursor only counts while this device holds the conversation it
  // followed (signed out and back in, the copy is empty: start over).
  let since = null;
  try { since = localStorage.getItem(_cursorKey(conv)); } catch { /* private mode */ }
  if (since && (!usable || !(await store.list(conv.pairingId)).length)) since = null;
  const path = conversationPath(conv) + (since ? `?since=${encodeURIComponent(since)}` : '');
  const r = await coachingFetch('GET', path);
  await _forgetDeletedPhotos(store, r.messages || []);
  await store.upsert(r.messages || []);
  try { if (r.server_time && usable) localStorage.setItem(_cursorKey(conv), r.server_time); } catch { /* private mode */ }
  return { can_send: !!r.can_send, status: r.status };
}

/** The other person's messages, read now (needs the server; skipped offline). */
export async function markConversationRead(conv) {
  try { await coachingFetch('POST', `${conversationPath(conv)}/read`, {}); return true; } catch { return false; }
}

// ── Writing ─────────────────────────────────────────────────────────────────
/** Keep a new message here, then send it (or leave it waiting). */
export async function sendMessage(conv, { body = '', image = null } = {}) {
  const text = String(body || '').replace(/\s+$/, '');
  if (text.length > MESSAGE_MAX) throw new Error('too long');
  const now = _sqlNow();
  const row = {
    uuid: newMessageId(),
    pairing_id: Number(conv.pairingId),
    sender_id: _me(),
    body: text.trim() ? text : null,
    image: null,
    image_local: image || null,
    post_path: conversationPath(conv),
    read_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    error: null,
    sync_status: 'pending',
  };
  const store = await _store();
  // Nowhere to keep it (the browser's database blocked by another tab, or
  // private mode): send it straight away, and say so if that fails.
  if (!(await store.available())) {
    const sent = await coachingFetch('POST', row.post_path, { uuid: row.uuid, body: row.body, image: row.image_local || undefined });
    return { ...sent, offline: false };
  }
  // Kept only if the store took it (a full browser database refuses): else
  // sent straight away, and if that fails too the text stays to try again.
  if (!(await store.queue(row))) {
    const sent = await coachingFetch('POST', row.post_path, { uuid: row.uuid, body: row.body, image: row.image_local || undefined });
    return { ...sent, offline: false };
  }
  const r = await flushCoachMessages().catch(() => ({ offline: true }));
  return { ...row, offline: !!r?.offline };
}

/** A message marked Not Sent, tried again. */
export async function retryMessage(m) {
  await (await _store()).queue({ ...m, sync_status: 'pending', error: null });
  return flushCoachMessages().catch(() => ({ offline: true }));
}

/** Delete your own message ("Message deleted"); a delete made offline waits. */
export async function deleteOwnMessage(m) {
  await (await _store()).remove(m.uuid);
  if (m.image) forgetCoachPhotos([m.image]).catch(() => {});
  await flushCoachMessages().catch(() => {});
}

let _flushing = null;
let _again = false;
/** Send everything waiting, oldest first. Stops at the first sign of no
 *  connection; a message the server refuses (the conversation closed) is
 *  kept and marked instead of retried forever. Returns { sent, offline }.
 *  A message written while a send is under way goes in the same run. */
export function flushCoachMessages() {
  if (_flushing) { _again = true; return _flushing; }
  _flushing = (async () => {
    let total = 0, offline = false;
    do {
      _again = false;
      const r = await _flushOnce();
      total += r.sent; offline = r.offline;
    } while (_again && !offline);
    return { sent: total, offline };
  })().finally(() => { _flushing = null; });
  return _flushing;
}

async function _flushOnce() {
  {
    const store = await _store();
    let sent = 0, offline = false;
    for (const m of await store.pending()) {
      try {
        if (m.sync_status === 'pending_delete') {
          let row = null;
          try { row = await coachingFetch('DELETE', `/api/coaching/messages/${encodeURIComponent(m.uuid)}`); }
          catch (e) {
            // Never reached the server (deleted while waiting): nothing to undo there.
            if (e?.status === 404) { await store.forget(m.uuid); sent++; continue; }
            throw e;
          }
          await store.upsert([row]);
        } else {
          const row = await coachingFetch('POST', m.post_path, { uuid: m.uuid, body: m.body, image: m.image_local || undefined });
          await store.upsert([row]);
        }
        sent++;
      } catch (e) {
        // No connection, the server having a moment (5xx, a restart behind a
        // proxy), a session to sign in again, a timeout or too many at once:
        // it waits and goes later.
        const status = Number(e?.status) || 0;
        if (e?.offline || status >= 500 || !status || [401, 408, 429].includes(status)) { offline = true; break; }
        // Refused for good (the conversation closed): kept here, marked.
        await store.fail(m.uuid, e.message);
      }
    }
    if (sent && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lt:coach-messages'));
    return { sent, offline };
  }
}

/** Waiting messages on this device (for sign-out). */
export async function pendingCoachMessages() {
  return (await _store()).pending();
}

/** Keep only conversations this account may still read; drop the rest and
 *  their photo copies (a coach whose client left loses the conversation). */
export async function keepConversations(pairingIds) {
  const photos = await (await _store()).keep(pairingIds);
  if (photos.length) await forgetCoachPhotos(photos);
}

/** Messages that came with the Android sync. */
export async function storeSyncedMessages(rows) {
  if (!rows?.length) return;
  const store = await _store();
  await _forgetDeletedPhotos(store, rows);
  await store.upsert(rows);
}
