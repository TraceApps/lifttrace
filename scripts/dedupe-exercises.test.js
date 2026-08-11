import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Use better-sqlite3 from server/node_modules — the same driver
// production actually runs against. createRequire lets us reach it
// without hoisting it into the root package.json (it's a server-only
// dep). CI installs both root + server deps so this works in the
// Checks workflow.
import { createRequire } from 'node:module';
const serverRequire = createRequire(new URL('../server/', import.meta.url));
const Database = serverRequire('better-sqlite3');

// Standalone reproduction of the dedupe logic in server/db.js so the tests
// can drive it against a scratch SQLite file without importing all of the
// server bootstrap (which touches process.env, PORT, etc.). If either
// copy drifts, the other should follow — the check is straightforward:
// this file must pass, AND the same logic must appear in server/db.js.

const MERGEABLE = ['load_type', 'tips', 'video_url', 'img_url', 'gif_url', 'category', 'instructions'];

function dedupeExercisesOnce(db, { force = false } = {}) {
  const MARK = 'exercises_dedupe_v1_done';
  if (!force) {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(MARK);
    if (row) return { skipped: true };
  }

  function pickSurvivorAndPatch(ids) {
    const sorted = ids.slice().sort((a, b) => a - b);
    const survivorId = sorted[0];
    const dupIds = sorted.slice(1);
    const survivor = db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(survivorId);
    const placeholders = dupIds.map(() => '?').join(',');
    const dups = db.prepare(`SELECT * FROM exercises WHERE id IN (${placeholders}) ORDER BY id`).all(...dupIds);
    const patch = {};
    for (const field of MERGEABLE) {
      if (survivor[field] != null && survivor[field] !== '' && survivor[field] !== '[]') continue;
      for (const d of dups) {
        if (d[field] != null && d[field] !== '' && d[field] !== '[]') {
          patch[field] = d[field];
          break;
        }
      }
    }
    if (Object.keys(patch).length) {
      const setClause = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE exercises SET ${setClause} WHERE id = ?`).run(...Object.values(patch), survivorId);
    }
    return { survivorId, dupIds };
  }

  function rewriteBlobs(table, remap) {
    if (remap.size === 0) return 0;
    const rows = db.prepare(`SELECT id, exercises FROM ${table} WHERE exercises IS NOT NULL`).all();
    const upd = db.prepare(`UPDATE ${table} SET exercises = ? WHERE id = ?`);
    let touched = 0;
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.exercises); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      let changed = false;
      for (const ex of parsed) {
        if (ex && typeof ex === 'object' && remap.has(ex.exercise_id)) {
          ex.exercise_id = remap.get(ex.exercise_id);
          changed = true;
        }
      }
      if (changed) { upd.run(JSON.stringify(parsed), row.id); touched++; }
    }
    return touched;
  }

  const remap = new Map();
  let groups = 0;
  let stats = { wl: 0, wt: 0, cp: 0 };

  // node:sqlite lacks better-sqlite3's db.transaction() helper; use raw
  // BEGIN/COMMIT/ROLLBACK. Production (better-sqlite3) wraps this the
  // native way.
  db.exec('BEGIN');
  try {
    const body = () => {
    const byExtId = db.prepare(`
      SELECT source, external_id, GROUP_CONCAT(id) AS ids FROM exercises
      WHERE is_global = 1 AND external_id IS NOT NULL
      GROUP BY source, external_id HAVING COUNT(*) > 1
    `).all();
    for (const g of byExtId) {
      const { survivorId, dupIds } = pickSurvivorAndPatch(g.ids.split(',').map(Number));
      for (const d of dupIds) remap.set(d, survivorId);
      groups++;
    }
    const byName = db.prepare(`
      SELECT source, name, GROUP_CONCAT(id) AS ids FROM exercises
      WHERE is_global = 1 AND external_id IS NULL
      GROUP BY source, name HAVING COUNT(*) > 1
    `).all();
    for (const g of byName) {
      const { survivorId, dupIds } = pickSurvivorAndPatch(g.ids.split(',').map(Number));
      for (const d of dupIds) remap.set(d, survivorId);
      groups++;
    }
    const wl = rewriteBlobs('workout_log', remap);
    const wt = rewriteBlobs('workout_templates', remap);
    const cp = rewriteBlobs('coach_prescriptions', remap);
    if (remap.size > 0) {
      const del = db.prepare(`DELETE FROM exercises WHERE id = ?`);
      for (const id of remap.keys()) del.run(id);
    }
    db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(MARK, new Date().toISOString());
    stats = { wl, wt, cp };
    };
    body();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { skipped: false, merged: remap.size, groups, ...stats };
}

function mkdb() {
  const p = path.join(os.tmpdir(), `dedupe-test-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(p);
  db.exec(`
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, category TEXT,
      primary_muscles TEXT DEFAULT '[]', secondary_muscles TEXT DEFAULT '[]',
      equipment TEXT DEFAULT '[]', instructions TEXT, tips TEXT,
      img_url TEXT, gif_url TEXT, video_url TEXT,
      external_id INTEGER, source TEXT DEFAULT 'custom',
      is_global INTEGER DEFAULT 0, load_type TEXT DEFAULT NULL
    );
    CREATE TABLE workout_log (id INTEGER PRIMARY KEY AUTOINCREMENT, exercises TEXT);
    CREATE TABLE workout_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, exercises TEXT);
    CREATE TABLE coach_prescriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, exercises TEXT);
  `);
  return { db, cleanup: () => { db.close(); try { fs.unlinkSync(p); } catch {} } };
}

test('dedupe: keeps lowest id and remaps blobs', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Bench', 'free-db', 1, 'bench-1'),
      (20, 'Bench', 'free-db', 1, 'bench-1'),
      (30, 'Bench', 'free-db', 1, 'bench-1')`);
    db.exec(`INSERT INTO workout_log (id, exercises) VALUES
      (1, '[{"exercise_id":20,"exercise_name":"Bench"}]'),
      (2, '[{"exercise_id":30,"exercise_name":"Bench"},{"exercise_id":99,"exercise_name":"Other"}]')`);
    const res = dedupeExercisesOnce(db);
    assert.equal(res.merged, 2);
    assert.equal(res.groups, 1);
    const rows = db.prepare(`SELECT id FROM exercises ORDER BY id`).all();
    assert.deepEqual(rows.map(r => r.id), [10]);
    const w1 = JSON.parse(db.prepare(`SELECT exercises FROM workout_log WHERE id=1`).get().exercises);
    assert.equal(w1[0].exercise_id, 10);
    const w2 = JSON.parse(db.prepare(`SELECT exercises FROM workout_log WHERE id=2`).get().exercises);
    assert.equal(w2[0].exercise_id, 10);
    assert.equal(w2[1].exercise_id, 99, 'unrelated exercise_id must not be remapped');
  } finally { cleanup(); }
});

test('dedupe: merges non-null user edits onto survivor', () => {
  const { db, cleanup } = mkdb();
  try {
    // Survivor (id 10) has null load_type + null video_url.
    // Duplicate id 20 has user-pinned video_url; id 30 has load_type.
    // Expect the survivor to inherit both.
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id, load_type, video_url, tips) VALUES
      (10, 'Squat', 'free-db', 1, 'squat-1', NULL, NULL, NULL),
      (20, 'Squat', 'free-db', 1, 'squat-1', NULL, 'https://youtu.be/x', NULL),
      (30, 'Squat', 'free-db', 1, 'squat-1', 'unilateral', NULL, 'lock knees out')`);
    dedupeExercisesOnce(db);
    const s = db.prepare(`SELECT * FROM exercises WHERE id = 10`).get();
    assert.equal(s.video_url, 'https://youtu.be/x');
    assert.equal(s.load_type, 'unilateral');
    assert.equal(s.tips, 'lock knees out');
  } finally { cleanup(); }
});

test('dedupe: survivor edits win over duplicate edits', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id, load_type) VALUES
      (10, 'Row', 'free-db', 1, 'row-1', 'bilateral'),
      (20, 'Row', 'free-db', 1, 'row-1', 'unilateral')`);
    dedupeExercisesOnce(db);
    const s = db.prepare(`SELECT load_type FROM exercises WHERE id = 10`).get();
    assert.equal(s.load_type, 'bilateral', 'survivor value takes precedence over duplicate');
  } finally { cleanup(); }
});

test('dedupe: falls back to (source, name) when external_id is NULL', () => {
  const { db, cleanup } = mkdb();
  try {
    // Simulates the legacy free-db state before external_id populate.
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (5, 'Dip', 'free-db', 1, NULL),
      (6, 'Dip', 'free-db', 1, NULL)`);
    db.exec(`INSERT INTO workout_log (id, exercises) VALUES
      (1, '[{"exercise_id":6}]')`);
    const res = dedupeExercisesOnce(db);
    assert.equal(res.merged, 1);
    const ids = db.prepare(`SELECT id FROM exercises`).all().map(r => r.id);
    assert.deepEqual(ids, [5]);
    const w = JSON.parse(db.prepare(`SELECT exercises FROM workout_log WHERE id=1`).get().exercises);
    assert.equal(w[0].exercise_id, 5);
  } finally { cleanup(); }
});

test('dedupe: leaves is_global=0 (user-created) exercises alone', () => {
  const { db, cleanup } = mkdb();
  try {
    // Two users creating a "My Bench" custom exercise is intentional.
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (1, 'My Bench', 'custom', 0, NULL),
      (2, 'My Bench', 'custom', 0, NULL)`);
    const res = dedupeExercisesOnce(db);
    assert.equal(res.merged, 0);
    const rows = db.prepare(`SELECT id FROM exercises ORDER BY id`).all();
    assert.deepEqual(rows.map(r => r.id), [1, 2]);
  } finally { cleanup(); }
});

test('dedupe: idempotent (second call is a no-op)', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Curl', 'free-db', 1, 'curl-1'),
      (20, 'Curl', 'free-db', 1, 'curl-1')`);
    const first = dedupeExercisesOnce(db);
    assert.equal(first.merged, 1);
    const second = dedupeExercisesOnce(db);
    assert.equal(second.skipped, true);
  } finally { cleanup(); }
});

test('dedupe: force re-runs even after the marker is set', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'Press', 'free-db', 1, 'press-1'),
      (20, 'Press', 'free-db', 1, 'press-1')`);
    dedupeExercisesOnce(db);
    // Manually reintroduce a duplicate (as a bad backup restore would).
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (30, 'Press', 'free-db', 1, 'press-1')`);
    const forced = dedupeExercisesOnce(db, { force: true });
    assert.equal(forced.merged, 1);
    const ids = db.prepare(`SELECT id FROM exercises`).all().map(r => r.id);
    assert.deepEqual(ids, [10]);
  } finally { cleanup(); }
});

test('dedupe: malformed JSON blob is skipped, not thrown', () => {
  const { db, cleanup } = mkdb();
  try {
    db.exec(`INSERT INTO exercises (id, name, source, is_global, external_id) VALUES
      (10, 'X', 'free-db', 1, 'x-1'),
      (20, 'X', 'free-db', 1, 'x-1')`);
    db.exec(`INSERT INTO workout_log (id, exercises) VALUES (1, 'not-json')`);
    // Should not throw.
    const res = dedupeExercisesOnce(db);
    assert.equal(res.merged, 1);
  } finally { cleanup(); }
});
