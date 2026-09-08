import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// better-sqlite3 is a server-only dep. createRequire lets us reach it
// without pulling it into the root package.json (same pattern as
// exercises-clear-reimport.test.js).
const serverRequire = createRequire(new URL('../server/', import.meta.url));
const Database = serverRequire('better-sqlite3');

// Standalone reproduction of the session-identity fix for issue #87.
// Mirrors (does not import) the actual SQL in server/routes/workout.js's
// _resolveWorkout/PUT/DELETE and server/routes/sync.js's push handler, the
// same convention exercises-clear-reimport.test.js already uses. Verifies:
//   - a stale/unknown id on repeated PUTs resolves to the same live row
//     instead of inserting a duplicate live session_seq=0 clone
//   - DELETE soft-deletes (deleted_at set), so a subsequent
//     `WHERE updated_at >= ?` pull can see and propagate the deletion
//   - a genuinely unknown id after delete starts a fresh live session
//     rather than silently resurrecting the deleted one
//   - an EXACT id match on a soft-deleted row still resurrects it
//     (pre-existing, intentional undo-delete behavior, unaffected)
//   - sync-push's server_id fallback excludes soft-deleted rows, so a
//     stale push can't silently write fresh content into a "deleted"
//     row without ever clearing deleted_at

function mkdb() {
  const p = path.join(os.tmpdir(), `session-identity-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(p);
  db.exec(`
    CREATE TABLE workout_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT NOT NULL,
      session_seq INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      completed INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return { db, cleanup: () => { db.close(); try { fs.unlinkSync(p); } catch {} } };
}

const USER = 1;
const DATE = '2099-01-01';

// Mirrors _resolveWorkout(userId, date, explicitId, opts) in workout.js.
function resolveWorkout(db, explicitId, { fallbackToDefault = false, excludeDeleted = false } = {}) {
  if (explicitId != null) {
    const row = db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND date = ?').get(explicitId, USER, DATE);
    if (row || !fallbackToDefault) return row;
    return defaultWorkout(db, excludeDeleted);
  }
  return defaultWorkout(db, excludeDeleted);
}

function defaultWorkout(db, excludeDeleted = false) {
  const clause = excludeDeleted ? 'AND deleted_at IS NULL' : '';
  return db.prepare(`SELECT * FROM workout_log WHERE date = ? AND user_id = ? ${clause} ORDER BY session_seq ASC, id ASC LIMIT 1`).get(DATE, USER);
}

// Mirrors the PUT /:date handler's row-targeting + insert-or-update.
function put(db, bodyId, name, completed) {
  const existing = resolveWorkout(db, bodyId, { fallbackToDefault: true, excludeDeleted: true });
  if (existing) {
    db.prepare(`UPDATE workout_log SET name=?, completed=?, deleted_at=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(name, completed ? 1 : 0, existing.id);
    return existing.id;
  }
  const maxSeq = db.prepare('SELECT COALESCE(MAX(session_seq),-1)+1 AS s FROM workout_log WHERE user_id=? AND date=?').get(USER, DATE).s;
  const r = db.prepare('INSERT INTO workout_log (user_id, date, session_seq, name, completed) VALUES (?,?,?,?,?)')
    .run(USER, DATE, maxSeq, name, completed ? 1 : 0);
  return r.lastInsertRowid;
}

// Mirrors the DELETE /:date handler.
function del(db, explicitId) {
  const existing = resolveWorkout(db, explicitId);
  if (!existing) return false;
  db.prepare(`UPDATE workout_log SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(existing.id);
  return true;
}

// Mirrors sync.js's push handler's existing-row resolution.
function pushResolve(db, serverId) {
  let existing = serverId ? db.prepare('SELECT * FROM workout_log WHERE id = ?').get(serverId) : null;
  if (!existing) {
    existing = db.prepare(`SELECT * FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1`).get(USER, DATE);
  }
  return existing;
}

test('issue #87: repeated PUTs with an unknown id resolve to the same live row, not a duplicate', () => {
  const { db, cleanup } = mkdb();
  try {
    const a = put(db, 1, 'probe', false);
    const b = put(db, 9999999, 'probe', true);
    assert.equal(b, a);
    const liveRows = db.prepare('SELECT id FROM workout_log WHERE user_id=? AND date=?').all(USER, DATE);
    assert.equal(liveRows.length, 1);
  } finally { cleanup(); }
});

test('issue #87: DELETE soft-deletes so a subsequent pull sees it', () => {
  const { db, cleanup } = mkdb();
  try {
    const a = put(db, 1, 'probe', false);
    const beforeDelete = db.prepare("SELECT datetime('now', '-1 second') AS t").get().t;
    del(db, null);
    assert.equal(defaultWorkout(db, true), undefined);
    const pullVisible = db.prepare('SELECT id, deleted_at FROM workout_log WHERE updated_at >= ? AND user_id = ?').all(beforeDelete, USER);
    assert.equal(pullVisible.length, 1);
    assert.notEqual(pullVisible[0].deleted_at, null);
    assert.equal(pullVisible[0].id, a);
  } finally { cleanup(); }
});

test('issue #87: a genuinely unknown id after delete starts a fresh session, does not resurrect', () => {
  const { db, cleanup } = mkdb();
  try {
    const a = put(db, 1, 'probe', false);
    del(db, null);
    const c = put(db, 424242, 'new session after delete', false);
    assert.notEqual(c, a);
    const rowC = db.prepare('SELECT deleted_at FROM workout_log WHERE id=?').get(c);
    assert.equal(rowC.deleted_at, null);
  } finally { cleanup(); }
});

test('regression: an EXACT id match on a soft-deleted row still resurrects it (undo-delete)', () => {
  const { db, cleanup } = mkdb();
  try {
    const a = put(db, 1, 'probe', false);
    del(db, null);
    const d = put(db, a, 're-edit the exact same id', false);
    assert.equal(d, a);
    const rowD = db.prepare('SELECT deleted_at FROM workout_log WHERE id=?').get(a);
    assert.equal(rowD.deleted_at, null);
  } finally { cleanup(); }
});

test('issue #87: sync-push server_id fallback excludes soft-deleted rows', () => {
  const { db, cleanup } = mkdb();
  try {
    db.prepare('INSERT INTO workout_log (id, user_id, date, session_seq, name, deleted_at) VALUES (1, ?, ?, 0, ?, datetime(\'now\'))').run(USER, DATE, 'old');
    const existing = pushResolve(db, 55555);
    assert.equal(existing, undefined);
  } finally { cleanup(); }
});

test('regression: sync-push server_id fallback still finds a genuinely live row', () => {
  const { db, cleanup } = mkdb();
  try {
    db.prepare('INSERT INTO workout_log (id, user_id, date, session_seq, name, deleted_at) VALUES (1, ?, ?, 0, ?, datetime(\'now\'))').run(USER, DATE, 'old');
    db.prepare('INSERT INTO workout_log (id, user_id, date, session_seq, name, deleted_at) VALUES (2, ?, ?, 1, ?, NULL)').run(USER, DATE, 'live');
    const existing = pushResolve(db, 55555);
    assert.ok(existing);
    assert.equal(existing.id, 2);
  } finally { cleanup(); }
});
