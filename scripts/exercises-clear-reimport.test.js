import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// better-sqlite3 is a server-only dep. createRequire lets us reach it
// without pulling it into the root package.json (same pattern as the
// dedupe test).
const serverRequire = createRequire(new URL('../server/', import.meta.url));
const Database = serverRequire('better-sqlite3');

// Standalone reproduction of the soft-delete + resurrection behavior added
// for issue #49. Verifies:
//   - clear soft-deletes rather than hard-deletes
//   - re-import resurrects by (source, external_id) preserving the id
//   - re-import falls back to (source, name) when external_id is NULL
//   - workout_log JSON references stay valid after clear + re-import
//   - a live row with the same key doesn't get double-inserted or resurrected
//   - a fully-fresh row still inserts

function mkdb() {
  const p = path.join(os.tmpdir(), `soft-del-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(p);
  db.exec(`
    CREATE TABLE exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, category TEXT,
      primary_muscles TEXT DEFAULT '[]', secondary_muscles TEXT DEFAULT '[]',
      equipment TEXT DEFAULT '[]', instructions TEXT,
      img_url TEXT, gif_url TEXT, video_url TEXT,
      external_id TEXT, source TEXT DEFAULT 'custom',
      is_global INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE TABLE workout_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercises TEXT
    );
  `);
  return { db, cleanup: () => { db.close(); try { fs.unlinkSync(p); } catch {} } };
}

// Small helpers that mirror what the seeders actually do.
function softDeleteSource(db, source) {
  return db.prepare(
    `UPDATE exercises SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE source = ? AND is_global = 1 AND deleted_at IS NULL`
  ).run(source).changes;
}

function seedOne(db, source, row) {
  // Match the free-db seeder shape: check live, then resurrect, then insert.
  const liveExtIds = new Set(
    db.prepare(`SELECT external_id FROM exercises
                WHERE source = ? AND external_id IS NOT NULL AND deleted_at IS NULL`)
      .all(source).map(r => String(r.external_id))
  );
  if (row.external_id != null && liveExtIds.has(String(row.external_id))) return { action: 'skip' };
  if (row.external_id != null) {
    const r = db.prepare(
      `UPDATE exercises SET deleted_at = NULL, updated_at = datetime('now')
       WHERE source = ? AND external_id = ? AND deleted_at IS NOT NULL`
    ).run(source, String(row.external_id));
    if (r.changes > 0) {
      const rr = db.prepare(`SELECT id FROM exercises WHERE source = ? AND external_id = ?`).get(source, String(row.external_id));
      return { action: 'resurrect', id: rr.id };
    }
  } else {
    const r = db.prepare(
      `UPDATE exercises SET deleted_at = NULL, updated_at = datetime('now')
       WHERE source = ? AND external_id IS NULL AND name = ? AND deleted_at IS NOT NULL`
    ).run(source, row.name);
    if (r.changes > 0) {
      const rr = db.prepare(`SELECT id FROM exercises WHERE source = ? AND external_id IS NULL AND name = ?`).get(source, row.name);
      return { action: 'resurrect', id: rr.id };
    }
  }
  const info = db.prepare(
    `INSERT INTO exercises (name, source, is_global, external_id) VALUES (?, ?, 1, ?)`
  ).run(row.name, source, row.external_id != null ? String(row.external_id) : null);
  return { action: 'insert', id: info.lastInsertRowid };
}

test('clear soft-deletes rather than hard-deletes', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench', 'free-db', 1, 'bench-1'),
      (11, 'Squat', 'free-db', 1, 'squat-1')`);
    const changed = softDeleteSource(db, 'free-db');
    assert.equal(changed, 2);
    const rows = db.prepare(`SELECT id, deleted_at FROM exercises`).all();
    assert.equal(rows.length, 2, 'rows should still be present after clear');
    assert.ok(rows.every(r => r.deleted_at != null), 'both rows should be soft-deleted');
  } finally { cleanup(); }
});

test('re-import resurrects by (source, external_id) preserving the id', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench Press', 'free-db', 1, 'bench-1')`);
    softDeleteSource(db, 'free-db');
    const result = seedOne(db, 'free-db', { name: 'Bench Press', external_id: 'bench-1' });
    assert.equal(result.action, 'resurrect');
    assert.equal(result.id, 10, 'id must be preserved so workout_log refs stay valid');
    const row = db.prepare(`SELECT id, deleted_at FROM exercises WHERE id = 10`).get();
    assert.equal(row.deleted_at, null);
  } finally { cleanup(); }
});

test('re-import falls back to (source, name) when external_id is NULL', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (5, 'Dip', 'free-db', 1, NULL)`);
    softDeleteSource(db, 'free-db');
    const result = seedOne(db, 'free-db', { name: 'Dip', external_id: null });
    assert.equal(result.action, 'resurrect');
    assert.equal(result.id, 5);
  } finally { cleanup(); }
});

test('workout_log JSON references stay valid across clear + re-import', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench Press', 'free-db', 1, 'bench-1')`);
    db.exec(`INSERT INTO workout_log (id, exercises) VALUES
      (1, '[{"exercise_id":10,"exercise_name":"Bench Press"}]')`);
    softDeleteSource(db, 'free-db');
    seedOne(db, 'free-db', { name: 'Bench Press', external_id: 'bench-1' });
    // The blob was untouched (no rewrite needed) and now resolves cleanly:
    const blob = JSON.parse(db.prepare(`SELECT exercises FROM workout_log WHERE id = 1`).get().exercises);
    const live = db.prepare(`SELECT * FROM exercises WHERE id = ? AND deleted_at IS NULL`).get(blob[0].exercise_id);
    assert.ok(live, 'workout_log ref must resolve to a live exercise row post re-import');
    assert.equal(live.name, 'Bench Press');
  } finally { cleanup(); }
});

test('live row with the same key is skipped, not double-inserted or resurrected', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench', 'free-db', 1, 'bench-1')`);
    const result = seedOne(db, 'free-db', { name: 'Bench', external_id: 'bench-1' });
    assert.equal(result.action, 'skip');
    const count = db.prepare(`SELECT COUNT(*) as c FROM exercises`).get().c;
    assert.equal(count, 1);
  } finally { cleanup(); }
});

test('a fully-fresh row still inserts', () => {
  const { db, cleanup } = mkdb();
  try {
    const result = seedOne(db, 'free-db', { name: 'Squat', external_id: 'squat-1' });
    assert.equal(result.action, 'insert');
    const row = db.prepare(`SELECT * FROM exercises`).get();
    assert.equal(row.name, 'Squat');
    assert.equal(row.deleted_at, null);
  } finally { cleanup(); }
});

test('soft-deleted row with a different external_id does not block a fresh insert of the same name', () => {
  // Edge case: two rows same name, different ids/external_ids.
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench', 'free-db', 1, 'bench-old')`);
    softDeleteSource(db, 'free-db');
    // Upstream schema changed the id — different external_id, same name.
    const result = seedOne(db, 'free-db', { name: 'Bench', external_id: 'bench-new' });
    assert.equal(result.action, 'insert', 'different external_id should not resurrect the wrong row');
    const rows = db.prepare(`SELECT id, name, external_id, deleted_at FROM exercises ORDER BY id`).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].deleted_at != null, true, 'old row stays soft-deleted');
    assert.equal(rows[1].external_id, 'bench-new');
    assert.equal(rows[1].deleted_at, null);
  } finally { cleanup(); }
});
