/**
 * offline-api.js: the browser's side of working without a connection.
 *
 * Online, every call goes to the server as before and what comes back is kept
 * in IndexedDB (the mirror). When the server can't be reached, the screens
 * that matter are answered from the mirror, and what you change goes into an
 * outbox and shows at once. Back online, the outbox is replayed against the
 * same routes the Android app replays its own queue against, so the merge is
 * the one already in production: no second merge path to keep in step.
 *
 * It hangs off apiFetch.js, which already stands between the app and the
 * network, so no screen needs changing to work offline.
 *
 * Deliberately not the Background Sync API: Safari doesn't have it, and the
 * iPhone is half the point. The page flushes instead, on a backoff, on the
 * browser's own `online` event, and when the tab comes back to the front.
 *
 * Tabs share the outbox: a Web Lock keeps two of them from replaying it at
 * once, and a BroadcastChannel tells the others when it changed.
 */
import { writable } from 'svelte/store';
import {
  isOfflineError, isMirroredGet, mirrorKey, pathOf, writeOp, collapseOps, sentSeqs,
  answerWithOps, queuedWorkoutReply, newTempId, createdId, remapIds, remapPath,
  describeOp, shouldRetryStatus,
} from './offline-edits.js';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let _retryMs = RETRY_MIN_MS;
const _backoff = () => { const ms = _retryMs; _retryMs = Math.min(RETRY_MAX_MS, _retryMs * 2); return ms; };
const _resetBackoff = () => { _retryMs = RETRY_MIN_MS; };

/** { online, pending, syncing, error } for the header badge and Settings. */
export const offlineState = writable({
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  pending: 0,
  syncing: false,
  error: null,
  // Changes the server answered and refused. Kept, and shown once, so nothing
  // disappears without the person who made it being told.
  refused: [],
});

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
// Whose queue this is. The app clears `wl:userId` when it cannot confirm who
// is signed in, which is exactly what a reload with no connection looks like,
// so the last id this browser saw is kept here: without it the queue would be
// orphaned in a database nothing reads, and the work would never go up.
const _USER_KEY = 'lt:offline-user';
function _dbName() {
  let user = null;
  try {
    user = localStorage.getItem('wl:userId');
    if (user) localStorage.setItem(_USER_KEY, user);
    else user = localStorage.getItem(_USER_KEY);
  } catch { /* private mode */ }
  return `lifttrace-offline-${user || 'single'}`;
}
function _db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  // The first reads of a page happen before the app knows who is signed in,
  // so they are filed under the anonymous name. Once the id turns up, bring
  // what was kept with it rather than leaving it in a database nothing reads.
  const leaving = _dbPromise?.name && _dbPromise.name !== name ? _dbPromise.name : null;
  const p = new Promise((resolve) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('answers')) db.createObjectStore('answers', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('refused')) db.createObjectStore('refused', { keyPath: 'at' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  p.name = name;
  _dbPromise = p;
  if (leaving) p.then(db => _absorb(leaving, db));
  return p;
}

/** Move everything from an old database into this one, then drop it. */
async function _absorb(oldName, db) {
  if (!db) return;
  const old = await new Promise((resolve) => {
    const req = indexedDB.open(oldName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!old) return;
  for (const store of ['answers', 'outbox', 'refused']) {
    if (!old.objectStoreNames.contains(store) || !db.objectStoreNames.contains(store)) continue;
    const rows = await new Promise((resolve) => {
      try {
        const q = old.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result || []);
        q.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    if (!rows.length) continue;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        // The outbox is keyed by a running number, so queued work is re-added
        // and given a new one rather than landing on top of something.
        for (const row of rows) { if (store === 'outbox') { const { seq, ...rest } = row; s.add(rest); } else s.put(row); }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  old.close();
  try { indexedDB.deleteDatabase(oldName); } catch { /* another tab has it open */ }
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
}
// Every read and write is wrapped: a blocked, full or private-mode database
// resolves to null instead of throwing, and the app falls back to the server.
function _tx(store, mode, fn) {
  return _db().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    let out;
    try {
      const tx = db.transaction(store, mode);
      out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
const _all = (store) => _tx(store, 'readonly', s => s.getAll()).then(r => r || []);

const _remember = (key, body) => _tx('answers', 'readwrite', s => s.put({ key, body, at: Date.now() }));

/**
 * What was last seen for this call. An exact match first (the query is part
 * of the key), then the same path without one, so a day read as
 * `?id=4` still finds the copy taken from the plain read.
 */
async function _recall(url) {
  const exact = await _tx('answers', 'readonly', s => s.get(mirrorKey(url)));
  if (exact) return exact.body;
  const path = pathOf(url);
  const byPath = await _tx('answers', 'readonly', s => s.get(path));
  if (byPath) return byPath.body;
  const rows = await _all('answers');
  return rows.find(r => pathOf(r.key) === path)?.body;
}

// ── Outbox ───────────────────────────────────────────────────────────
let _ops = null;
async function _loadOps() {
  if (!_ops) _ops = await _all('outbox');
  return _ops;
}
function _publish(extra = {}) {
  offlineState.update(s => ({ ...s, pending: _ops?.length || 0, ...extra }));
}

/** Changes the server refused, so a screen can say so and let them go. */
export async function refusedChanges() {
  return (await _all('refused')).sort((a, b) => a.at - b.at);
}
export async function forgetRefused() {
  await _tx('refused', 'readwrite', s => s.clear());
  _publish({ refused: [] });
}
const _channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lifttrace-offline') : null;
_channel?.addEventListener('message', async (e) => {
  if (e.data?.type !== 'outbox') return;
  if (e.data.ids) _swapped = { ..._swapped, ...e.data.ids };
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lt:offline-synced'));
  }
});

/**
 * What each temporary id became. A screen already open goes on showing the
 * id a row was created with offline, so a change made right after the queue
 * goes up would otherwise be sent against an id the server never had.
 */
let _swapped = {};

const _json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const _offlineReply = (url) => {
  // Shows up in Settings, Diagnostics: which call had no copy to answer with.
  if (url) console.debug('[offline] no copy held for', String(url));
  return _json(503, { error: 'This needs a connection.', offline: true });
};

async function _queue(op) {
  const ops = await _loadOps();
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
  // No database to queue into (private mode, no space): say so rather than
  // pretending it was saved.
  if (seq == null) return null;
  op.seq = seq;
  ops.push(op);
  _publish({ online: _online() });
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return op;
}

// ── Sending ──────────────────────────────────────────────────────────
let _fetch = null;          // the browser's own fetch, before any patching
let _retry = null;
let _flushing = null;

function _scheduleFlush(ms = 0) {
  clearTimeout(_retry);
  _retry = setTimeout(() => { flushOutbox(); }, ms);
}

/** Replay what's waiting. Resolves true when the outbox is empty afterwards. */
export function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const run = () => _flushOnce();
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('lifttrace-offline-flush', run);
      }
      return await run();
    } finally {
      _flushing = null;
    }
  })();
  return _flushing;
}

async function _flushOnce() {
  _ops = null;
  const ops = await _loadOps();
  if (!ops.length) { _publish({ syncing: false, error: null, online: _online() }); return true; }
  if (!_online()) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });

  const send = _fetch || ((...a) => fetch(...a));
  const done = new Set();
  const refused = [];
  const map = {};
  let stopped = null;

  for (const op of collapseOps(ops)) {
    const path = remapPath(op.path, map);
    const body = op.body == null ? undefined : JSON.stringify(remapIds(op.body, map));
    let res;
    try {
      res = await send(path, {
        method: op.method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      });
    } catch (err) {
      // Still unreachable: keep everything and try again later.
      if (isOfflineError(err)) { stopped = { offline: true }; break; }
      stopped = { error: err.message || 'failed' };
      break;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = (await res.clone().json())?.error || message; } catch { /* not json */ }
      // A server that is struggling deserves another go later, and everything
      // behind this waits with it so nothing arrives out of order.
      if (shouldRetryStatus(res.status)) { stopped = { error: message }; break; }
      // A refusal is the server's answer: trying again will not change it.
      // Set it aside, tell the person later, and carry on with the rest, so
      // one rejected change cannot hold up everything queued behind it.
      refused.push({ at: Date.now() + refused.length, what: describeOp(op), reason: message });
      // Also into the log behind Settings, Diagnostics: a toast lasts four
      // seconds, and someone who looked away still deserves to find out.
      console.error(`[offline] your server refused ${describeOp(op)}: ${message} (${op.method} ${op.path})`);
      if (op.key) done.add(op.key);
      continue;
    }
    if (op.tempId != null) {
      let created = null;
      try { created = createdId(await res.clone().json()); } catch { /* not json */ }
      if (created != null) map[Number(op.tempId)] = created;
    }
    if (op.key) done.add(op.key);
  }

  if (refused.length) {
    await _tx('refused', 'readwrite', s => { for (const r of refused) s.put(r); });
  }

  if (Object.keys(map).length) {
    _swapped = { ..._swapped, ...map };
    _channel?.postMessage({ type: 'outbox', ids: map });
  }

  const cleared = new Set(sentSeqs(ops, [...done]));
  if (cleared.size) {
    await _tx('outbox', 'readwrite', s => { for (const seq of cleared) s.delete(seq); });
    _ops = ops.filter(op => !cleared.has(op.seq));
  }

  const standing = await refusedChanges();
  if (stopped) {
    _publish({ syncing: false, online: stopped.offline ? false : _online(), error: stopped.error || null, refused: standing });
    _scheduleFlush(_backoff());
    return false;
  }
  // Anything the replay changed should be read again rather than served from
  // a copy taken before it.
  await _tx('answers', 'readwrite', s => s.clear());
  _resetBackoff();
  _publish({ syncing: false, error: null, online: true, refused: standing });
  _channel?.postMessage({ type: 'outbox', synced: true, ids: map });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lt:offline-synced'));
  if (_ops?.length) _scheduleFlush(0);
  return !(_ops?.length);
}

/** How much is waiting to go up. */
export async function pendingCount() {
  return (await _loadOps()).length;
}

/** Clear the mirror and the queue, e.g. on sign-out. */
export async function clearOffline() {
  await _tx('answers', 'readwrite', s => s.clear());
  await _tx('outbox', 'readwrite', s => s.clear());
  await _tx('refused', 'readwrite', s => s.clear());
  _ops = [];
  _swapped = {};
  _dbPromise = null;
  try { localStorage.removeItem(_USER_KEY); } catch { /* private mode */ }
  _publish({ syncing: false, error: null });
}

// ── The interceptor ──────────────────────────────────────────────────

/**
 * Wire up the listeners and remember the unpatched fetch. Called once, from
 * apiFetch.js, before the app boots.
 */
export function installOffline(origFetch) {
  _fetch = origFetch || _fetch;
  if (typeof window === 'undefined' || window.__ltOfflineWired) return;
  window.__ltOfflineWired = true;
  window.addEventListener('online', () => { _resetBackoff(); _publish({ online: true }); _scheduleFlush(0); });
  window.addEventListener('offline', () => _publish({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _online()) _scheduleFlush(0);
  });
  // A queue left from last time goes up even if the first screen opened
  // never calls the API.
  _loadOps().then(() => { _publish(); if (_ops.length) _scheduleFlush(0); });
}

const _bodyOf = (init) => {
  const raw = init?.body;
  if (typeof raw !== 'string') return undefined;      // FormData: an upload, not ours
  try { return JSON.parse(raw); } catch { return undefined; }
};

/**
 * The web app's request, with the mirror and the outbox behind it. Returns a
 * Response either way, so nothing above this knows the difference.
 */
export async function offlineFetch(url, init, origFetch) {
  _fetch = origFetch || _fetch;
  const send = origFetch || _fetch;
  const method = (init?.method || 'GET').toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    try {
      const res = await send(url, init);
      if (res.ok && isMirroredGet(url)) {
        try { await _remember(mirrorKey(url), await res.clone().json()); } catch { /* not json */ }
      }
      _publish({ online: true });
      return res;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
      if (!isMirroredGet(url)) return _offlineReply(url);
      const mirrored = await _recall(url);
      // Even with no copy of this call, what is queued for it may be the whole
      // answer: a day never opened online, with a run logged on it here.
      const answer = answerWithOps(url, mirrored, await _loadOps());
      if (answer === undefined) return _offlineReply(url);
      return _json(200, answer);
    }
  }

  // An upload with no server to upload to: hand back the photo itself,
  // scaled down, so it can travel inside the row it belongs to. The server
  // turns it back into a file when the queue goes up.
  if (/^\/api\/upload(\/body-stats)?$/.test(String(url).split('?')[0]) && init?.body instanceof FormData) {
    const file = init.body.get('file');
    if (file && (!_online() || (await _loadOps()).length)) {
      try {
        const { embeddableDataUrl } = await import('./image-embed.js');
        return _json(200, { url: await embeddableDataUrl(file), queued: true, offline: true });
      } catch (err) {
        return _json(413, { error: err.message, offline: true });
      }
    }
  }

  const body = _bodyOf(init);
  const target = remapPath(String(url), _swapped);
  const op = writeOp(method, target, body);
  if (!op) {
    // Uploads, imports, Trace, admin: still the server's job.
    try {
      return await send(url, init);
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
      return _offlineReply(url);
    }
  }

  const queued = await _loadOps();
  if (_online() && !queued.length) {
    try {
      const res = await send(target, init);
      if (res.ok) {
        // What the route just answered is the freshest copy there is.
        try {
          const answered = await res.clone().json();
          if (op.kind === 'workout' && answered?.workout) await _remember(pathOf(target), answered);
        } catch { /* not json */ }
        _publish({ online: true, error: null });
      }
      return res;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
    }
  }

  const MAKES_A_ROW = ['exercise-create', 'cardio-create', 'prescription-create'];
  const tempId = MAKES_A_ROW.includes(op.kind) ? newTempId() : null;
  const stored = await _queue({
    method,
    path: remapPath(String(url), _swapped),
    body,
    at: Date.now(),
    ...op,
    ...(tempId != null
      ? { tempId, id: tempId, key: `${op.kind.replace('-create', '')}:${tempId}` }
      : {}),
  });
  if (!stored) return _offlineReply();

  // Answer in the shape the route would have, so the screen carries on.
  if (op.kind === 'workout') {
    const mirrored = await _recall(pathOf(target));
    const reply = queuedWorkoutReply(mirrored, body, newTempId());
    await _remember(pathOf(target), { workout: reply.workout });
    return _json(200, reply);
  }
  if (op.kind === 'workout-delete') {
    await _remember(pathOf(target), { workout: null });
    return _json(200, { ok: true, deleted: true, queued: true, offline: true });
  }
  if (MAKES_A_ROW.includes(op.kind)) {
    // The routes answer with the row they made, so this does too.
    return _json(200, { ...body, id: tempId, queued: true, offline: true });
  }
  return _json(200, { ok: true, ...(body || {}), queued: true, offline: true });
}
