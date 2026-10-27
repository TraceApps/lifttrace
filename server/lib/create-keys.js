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

// Keys past 30 days go: at start, and while the server runs, on the next
// key noted at most once an hour (a server left running for months, and a
// delete by key notes one too), so nothing has to wake up just for this.
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let _prunedAt = 0;
function _prune() {
  const now = Date.now();
  if (now - _prunedAt < PRUNE_EVERY_MS) return;
  _prunedAt = now;
  db.prepare(`DELETE FROM create_keys WHERE created_at < datetime('now', '-30 days')`).run();
}
_prune();

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
  _prune();
  db.prepare('INSERT OR IGNORE INTO create_keys (owner, client_key, table_name, row_id) VALUES (?, ?, ?, ?)')
    .run(owner(userId), key, table, Number(rowId));
}

/**
 * A delete that names a row by the key of the create that made it: the web
 * app's queue, when the row was deleted there before the create's answer
 * (and so its id) came back. `{ id }`: the row that create made, for the
 * route to delete as it would by id. `{ id: null }`: none, because the
 * create never arrived (or made a row of another kind): the key is noted
 * as made and gone, so a create still on its way is answered as deleted
 * since (createdBefore) and makes nothing. `null`: not a usable key.
 */
export function rowForKey(userId, table, key) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) return null;
  const who = owner(userId);
  _prune();
  // Row id 0 is never a row: a create arriving after this finds none.
  db.prepare('INSERT OR IGNORE INTO create_keys (owner, client_key, table_name, row_id) VALUES (?, ?, ?, 0)').run(who, key, table);
  const hit = db.prepare('SELECT table_name, row_id FROM create_keys WHERE owner = ? AND client_key = ?').get(who, key);
  return { id: hit && hit.table_name === table && hit.row_id > 0 ? hit.row_id : null };
}
