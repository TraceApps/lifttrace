/**
 * create-keys.js: a create sent twice makes one row.
 *
 * The Android app replays creates made offline. When the server's answer is
 * lost on the way back (the connection drops after the row is written), the
 * app can't tell the create happened and sends it again, which made a second
 * program, workout day, exercise, cardio session or workout session. A
 * create carries `client_key`, made once on the phone; the server notes the
 * row it made under that key, and the same key again gets that row back
 * instead of a new one.
 *
 * Keys are per account ('solo' without user accounts) and kept 30 days,
 * far longer than a replay waits.
 */
import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS create_keys (
    owner      TEXT NOT NULL,
    client_key TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_id     INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner, client_key)
  );
`);
db.exec(`DELETE FROM create_keys WHERE created_at < datetime('now', '-30 days')`);

const owner = (userId) => (userId == null ? 'solo' : String(userId));
const keyOf = (req) => {
  const k = req.body?.client_key;
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : null;
};

/** The row an earlier send of this create made. `{ gone: true }` when it
 *  has been deleted since: a late repeat must not bring it back. */
export function createdBefore(req, userId, table) {
  const key = keyOf(req);
  if (!key) return null;
  const hit = db.prepare('SELECT table_name, row_id FROM create_keys WHERE owner = ? AND client_key = ?').get(owner(userId), key);
  if (!hit || hit.table_name !== table) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(hit.row_id);
  return row && !row.deleted_at ? row : { gone: true };
}

/** Answer a repeat whose row was deleted since: done, nothing to make. */
export function answerGone(res) {
  return res.status(410).json({ error: 'Deleted since it was made', gone: true });
}

/** Note the row this create made, under its key. */
export function rememberCreated(req, userId, table, rowId) {
  const key = keyOf(req);
  if (!key || rowId == null) return;
  db.prepare('INSERT OR IGNORE INTO create_keys (owner, client_key, table_name, row_id) VALUES (?, ?, ?, ?)')
    .run(owner(userId), key, table, Number(rowId));
}
