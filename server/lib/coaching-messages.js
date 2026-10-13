/**
 * Coaching messages: one conversation per pairing, text and at most one
 * photo per message (the same table and rules as NutriTrace's).
 *
 * Who reads: the client, while coached and after (the conversation stays
 * theirs), and the coach only while the pairing is active. Who writes: both,
 * only while it is active. Trace never reads any of this: no AI tool, MCP
 * tool or API token route touches these tables.
 *
 * Photos live in UPLOADS_PATH/coaching under unguessable names, kept out of
 * the public /uploads mount (lib/upload-paths.js) and served only to the two
 * people through /api/coaching/photos.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../db.js';
import { logger } from '../logger.js';
import { canCoach, roleOf, personName } from './coaching.js';
import { detectMimeFromBuffer } from './image-magic.js';
import { pushNotifyDefaultOn } from './push-notify.js';
import { sendCoachMessage, isEmailConfigured } from '../email.js';

export const MESSAGE_MAX = 4000;
export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const UUID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PHOTO_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|gif|webp|avif)$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
export const PHOTO_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const EMAIL_EVERY_MS = 30 * 60 * 1000;

export const photoDir = () => path.join(process.env.UPLOADS_PATH || './uploads', 'coaching');
export const photoPath = (name) => (PHOTO_NAME_RE.test(String(name)) ? path.join(photoDir(), name) : null);

const _pairing = (id) => db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(id);
export const pairingById = _pairing;

/** May this person read this pairing's conversation? */
export function canRead(p, userId) {
  if (!p || userId == null) return false;
  if (p.client_id === userId) return p.status === 'active' || p.status === 'ended';
  return p.coach_id === userId && p.status === 'active' && canCoach(roleOf(userId));
}

/** May this person send in it? Only while the pairing is active. */
export function canWrite(p, userId) {
  if (!p || p.status !== 'active' || userId == null) return false;
  return p.client_id === userId || (p.coach_id === userId && canCoach(roleOf(userId)));
}

/** A message as the app sees it: ids and text, never a user row. */
export function messageOut(r) {
  if (!r) return null;
  const gone = !!r.deleted_at;
  return {
    id: r.id,
    uuid: r.uuid,
    pairing_id: r.pairing_id,
    sender_id: r.sender_id,
    body: gone ? null : (r.body ?? null),
    image: !gone && r.image_url ? `/api/coaching/photos/${r.image_url}` : null,
    recommendation_id: r.recommendation_id ?? null,
    read_at: r.read_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at || null,
  };
}

function _bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** A photo sent as a data URL becomes a private file. Returns its name. */
export function savePhoto(dataUrl) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw _bad('That photo could not be read.');
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw _bad('That photo could not be read.');
  if (buf.length > PHOTO_MAX_BYTES) throw _bad('That photo is too large.');
  const ext = EXT[detectMimeFromBuffer(buf)];
  if (!ext) throw _bad('Only JPEG, PNG, GIF, WebP and AVIF photos can be sent.');
  fs.mkdirSync(photoDir(), { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(photoDir(), name), buf, { mode: 0o600 });
  return name;
}

export function removePhoto(name) {
  const p = photoPath(name);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Store a message. The same uuid sent again by the same person returns the
 * message already stored, so a retry after a dropped connection is stored
 * once. Returns { row, created }.
 */
export function createMessage(p, userId, { uuid, body, image } = {}) {
  if (!canWrite(p, userId)) throw _bad('This conversation is closed.', 403);
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw _bad('Missing message id.');
  const existing = db.prepare('SELECT * FROM coach_messages WHERE uuid = ?').get(uuid);
  if (existing) {
    if (existing.sender_id === userId && existing.pairing_id === p.id) return { row: existing, created: false };
    throw _bad('That message id is already used.', 409);
  }
  const text = typeof body === 'string' ? body.replace(/\s+$/, '') : '';
  if (text.length > MESSAGE_MAX) throw _bad(`A message can be up to ${MESSAGE_MAX.toLocaleString('en-US')} characters.`);
  if (!text.trim() && !image) throw _bad('Write a message or add a photo.');
  const photo = image ? savePhoto(image) : null;
  try {
    const id = db.prepare(`
      INSERT INTO coach_messages (uuid, pairing_id, sender_id, body, image_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid, p.id, userId, text.trim() ? text : null, photo).lastInsertRowid;
    return { row: db.prepare('SELECT * FROM coach_messages WHERE id = ?').get(id), created: true };
  } catch (e) {
    if (photo) removePhoto(photo);
    // Two copies of the same message racing: the other one won.
    const won = db.prepare('SELECT * FROM coach_messages WHERE uuid = ?').get(uuid);
    if (won && won.sender_id === userId && won.pairing_id === p.id) return { row: won, created: false };
    throw e;
  }
}

/** Delete your own message: the row stays as "Message deleted", text and photo go. */
export function deleteMessage(uuid, userId) {
  const r = db.prepare('SELECT * FROM coach_messages WHERE uuid = ?').get(uuid);
  if (!r || r.sender_id !== userId || !canRead(_pairing(r.pairing_id), userId)) throw _bad('Message not found', 404);
  if (r.deleted_at) return r;
  db.prepare(`UPDATE coach_messages SET body = NULL, image_url = NULL, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(r.id);
  if (r.image_url) removePhoto(r.image_url);
  return db.prepare('SELECT * FROM coach_messages WHERE id = ?').get(r.id);
}

/** The other person's messages, read now. Returns how many changed. */
export function markRead(pairingId, userId) {
  return db.prepare(`
    UPDATE coach_messages SET read_at = datetime('now'), updated_at = datetime('now')
     WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL
  `).run(pairingId, userId).changes;
}

/** A conversation, oldest first; with `since`, only what changed from then. */
export function listMessages(pairingId, since = null) {
  const s = since ? String(since).replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '') : null;
  const rows = s
    ? db.prepare('SELECT * FROM coach_messages WHERE pairing_id = ? AND updated_at >= ? ORDER BY created_at, id').all(pairingId, s)
    : db.prepare('SELECT * FROM coach_messages WHERE pairing_id = ? ORDER BY created_at, id').all(pairingId);
  return rows.map(messageOut);
}

export function unreadIn(pairingId, userId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL`).get(pairingId, userId).c;
}

/** Every conversation this person can read (for sync): pairing ids. An
 *  ended one only when there is something in it (a request taken back has
 *  nothing to read). */
export function readablePairingIds(userId) {
  return db.prepare(`
    SELECT cc.id FROM coach_clients cc JOIN users c ON c.id = cc.coach_id
     WHERE (cc.client_id = ? AND (cc.status = 'active'
             OR (cc.status = 'ended' AND EXISTS (SELECT 1 FROM coach_messages m WHERE m.pairing_id = cc.id))))
        OR (cc.coach_id = ? AND cc.status = 'active' AND c.role IN ('trainer', 'admin'))
  `).all(userId, userId).map(r => r.id);
}

/** Photos of every conversation this person was in: removed with the account. */
export function deletePhotosForUser(userId) {
  const rows = db.prepare(`
    SELECT m.image_url FROM coach_messages m JOIN coach_clients cc ON cc.id = m.pairing_id
     WHERE (cc.coach_id = ? OR cc.client_id = ?) AND m.image_url IS NOT NULL
  `).all(userId, userId);
  for (const r of rows) removePhoto(r.image_url);
  // The email throttle's notes for this person's conversations go too.
  const pairs = db.prepare('SELECT id FROM coach_clients WHERE coach_id = ? OR client_id = ?').all(userId, userId);
  // By its exact prefix (LIKE would read the underscores as wildcards).
  for (const p of pairs) {
    const prefix = `_coachmail_${p.id}_`;
    db.prepare(`DELETE FROM app_config WHERE substr(key, 1, length(?)) = ?`).run(prefix, prefix);
  }
  return rows.length;
}

/** Every coaching photo (all accounts removed). */
export function deleteAllPhotos() {
  try {
    for (const f of fs.readdirSync(photoDir())) if (PHOTO_NAME_RE.test(f)) removePhoto(f);
  } catch { /* no folder yet */ }
}

// ── Telling the other person ────────────────────────────────────────────────
function _setting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _name(id) {
  return personName(db.prepare('SELECT full_name, nickname, username FROM users WHERE id = ?').get(id)) || 'Someone';
}

/**
 * A new message: a push through the person's ntfy, Gotify or Apprise (on
 * unless they turned it off), and an email if they asked for one, at most
 * once per 30 minutes per conversation. Both say who wrote, never what.
 * Never throws.
 */
export async function notifyMessage(p, row, appBaseOf) {
  try {
    const off = (v) => v === false || v === 'false';
    const to = row.sender_id === p.coach_id ? p.client_id : p.coach_id;
    const from = _name(row.sender_id);
    // Who wrote, never what: a push service (a public ntfy topic, say) is
    // outside the server, and the message stays in the app.
    await pushNotifyDefaultOn(to, 'notifCoachMessage', 'Coaching', `New message from ${from}`, 5).catch(() => {});
    const wantsEmail = _setting(to, 'notifCoachMessageEmail');
    if (off(_setting(to, 'notifCoachMessage')) || !(wantsEmail === true || wantsEmail === 'true')) return;
    if (!isEmailConfigured()) return;
    // The app's address only when an email will go (it may log a warning).
    const appBase = typeof appBaseOf === 'function' ? appBaseOf() : appBaseOf;
    if (!appBase) return;
    const email = db.prepare('SELECT email FROM users WHERE id = ?').get(to)?.email;
    if (!email) return;
    const key = `_coachmail_${p.id}_${to}`;
    const last = Number(db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value || 0);
    if (Date.now() - last < EMAIL_EVERY_MS) return;
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(Date.now()));
    const link = `${appBase}/#/${to === p.client_id ? 'coach' : `coaching/${p.client_id}`}`;
    await sendCoachMessage(email, from, link);
  } catch (e) {
    logger.warn(`[coaching] message notification failed: ${e?.message || e}`);
  }
}
