/**
 * A program deleted on the server leaves the phone too (issue #139,
 * reported by @surfingbytes).
 *
 * Programs, their workout days and assignments are deleted outright on the
 * server, so the phone's differential sync pull never heard of a deletion
 * and kept showing it: the starter programs deleted on the web stayed on
 * Android. The same held for a deleted custom exercise, and for workouts,
 * body stats and a Trace chat wiped by Clear Data or Clear Chat. Deletions are now recorded by triggers and sent in the pull as
 * { id, deleted_at } rows, which the app already applies, and the ones from
 * before the fix are backfilled once. Also: the starter programs came back
 * after a restart whenever no programs were left; they're seeded once now.
 * Reproduced and verified on an Android emulator against a real server: the
 * unchanged app drops the deleted programs after one sync.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'sync-del-')), 'test.db');
const db = (await import('../server/db.js')).default;
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const tombs = (tbl) => db.prepare('SELECT row_id FROM sync_deletions WHERE tbl = ? ORDER BY row_id').all(tbl).map(r => r.row_id);

test('deleting a program records it and, through the cascade, its days and assignments', () => {
  const p = db.prepare("INSERT INTO programs (name) VALUES ('Plan')").run().lastInsertRowid;
  const t = db.prepare("INSERT INTO workout_templates (program_id, name, exercises) VALUES (?, 'Day A', '[]')").run(p).lastInsertRowid;
  const u = db.prepare("INSERT INTO users (username, password_hash) VALUES ('u1', 'x')").run().lastInsertRowid;
  const a = db.prepare('INSERT INTO program_assignments (program_id, assigned_to) VALUES (?, ?)').run(p, u).lastInsertRowid;
  db.prepare('DELETE FROM programs WHERE id = ?').run(p);
  assert.ok(tombs('programs').includes(Number(p)));
  assert.ok(tombs('workout_templates').includes(Number(t)));
  assert.ok(tombs('program_assignments').includes(Number(a)));
});

test('putting a row back under the same id (a backup restore) clears its record', () => {
  const p = db.prepare("INSERT INTO programs (name) VALUES ('Restored')").run().lastInsertRowid;
  db.prepare('DELETE FROM programs WHERE id = ?').run(p);
  assert.ok(tombs('programs').includes(Number(p)));
  db.prepare("INSERT INTO programs (id, name) VALUES (?, 'Restored')").run(p);
  assert.ok(!tombs('programs').includes(Number(p)));
});

test('a user\'s own rows are recorded with their owner, shared rows without one', () => {
  const owner = db.prepare("INSERT INTO users (username, password_hash) VALUES ('u2', 'x')").run().lastInsertRowid;
  const w = db.prepare("INSERT INTO workout_log (user_id, date, exercises) VALUES (?, '2026-10-01', '[]')").run(owner).lastInsertRowid;
  const b = db.prepare("INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, '2026-10-01', '{}')").run(owner).lastInsertRowid;
  const c = db.prepare("INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, 'user', 'hi')").run(owner).lastInsertRowid;
  const mine = db.prepare("INSERT INTO exercises (name, is_global, created_by, source) VALUES ('Mine', 0, ?, 'custom')").run(owner).lastInsertRowid;
  const lib = db.prepare("INSERT INTO exercises (name, is_global, source) VALUES ('Library', 1, 'wger')").run().lastInsertRowid;
  db.prepare('DELETE FROM workout_log WHERE id = ?').run(w);
  db.prepare('DELETE FROM body_stats_log WHERE id = ?').run(b);
  db.prepare('DELETE FROM ai_chat_history WHERE id = ?').run(c);
  db.prepare('DELETE FROM exercises WHERE id IN (?, ?)').run(mine, lib);
  const ownerOf = (tbl, id) => db.prepare('SELECT user_id FROM sync_deletions WHERE tbl = ? AND row_id = ?').get(tbl, id)?.user_id;
  assert.equal(ownerOf('workout_log', w), Number(owner));
  assert.equal(ownerOf('body_stats_log', b), Number(owner));
  assert.equal(ownerOf('ai_chat_history', c), Number(owner));
  assert.equal(ownerOf('exercises', mine), Number(owner));
  assert.equal(ownerOf('exercises', lib), null, 'a library exercise is everyone\'s');
  assert.ok(tombs('programs').length, 'programs stay shared');
});

test('the pull sends deletions since the cursor as rows the app applies', () => {
  const sync = read('../server/routes/sync.js');
  assert.match(sync, /SELECT row_id AS id, deleted_at FROM sync_deletions\s+WHERE tbl = \? AND deleted_at >= \? \$\{u != null \? 'AND \(user_id IS NULL OR user_id = \?\)' : ''\}/,
    'only this user\'s own deletions, and shared ones');
  for (const t of ['programs', 'workout_templates', 'program_assignments', 'exercises', 'workout_log', 'body_stats_log', 'ai_chat_history']) {
    assert.match(sync, new RegExp(`${t}\\.push\\(\\.\\.\\.gone\\('${t}'\\)\\);`), t);
  }
  assert.match(sync, /const gone = \(tbl\) => \(fullPull \? \[\] : deletedSince\.all\(tbl, sinceSql, \.\.\.userParams\)\);/, 'a first, full pull skips them');
  // The cursor is taken before the queries, so nothing deleted in between is missed.
  assert.ok(sync.indexOf('const serverTime = new Date().toISOString();') < sync.indexOf('deletedSince.all('));
  // and the app removes a pulled row that carries deleted_at
  const app = read('../src/lib/sync.js');
  assert.match(app, /if \(p\.deleted_at\) \{ await dbRun\(`DELETE FROM programs WHERE id = \?`, \[p\.id\]\); continue; \}/);
  assert.match(app, /if \(t\.deleted_at\) \{ await dbRun\(`DELETE FROM workout_templates WHERE id = \?`, \[t\.id\]\); continue; \}/);
  assert.match(app, /if \(a\.deleted_at\) \{ await dbRun\(`DELETE FROM program_assignments WHERE id = \?`, \[a\.id\]\); continue; \}/);
  assert.match(app, /if \(e\.deleted_at\) \{\s*await dbRun\(`DELETE FROM exercises WHERE id = \?`, \[e\.id\]\);/);
  assert.match(app, /if \(w\.deleted_at\) \{\s*await dbRun\(`DELETE FROM workout_log WHERE id = \?`, \[w\.id\]\);/);
  assert.match(app, /if \(b\.deleted_at\) \{ await dbRun\(`DELETE FROM body_stats_log WHERE id = \?`, \[b\.id\]\); continue; \}/);
  assert.match(app, /if \(c\.deleted_at\) \{ await dbRun\(`DELETE FROM ai_chat_history WHERE id = \?`, \[c\.id\]\); continue; \}/);
});

test('deletions from before the fix are backfilled once', () => {
  const src = read('../server/db.js');
  assert.match(src, /sync_deletions_backfill_v1/);
  assert.match(src, /backfill\('sync_deletions_backfill_v2', \['exercises', 'workout_log', 'body_stats_log', 'ai_chat_history'\]\)/);
  assert.match(src, /SELECT seq FROM sqlite_sequence WHERE name = \?/);
  assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = 'sync_deletions_backfill_v1'").get(), 'marked after it ran');
  assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = 'sync_deletions_backfill_v2'").get());
});

test('the starter programs are seeded once, never again after they were deleted', async () => {
  const { seedPrograms } = await import('../server/seed-templates.js');
  db.prepare("DELETE FROM app_config WHERE key = 'starter_programs_seeded'").run();
  db.prepare('DELETE FROM programs').run();
  seedPrograms();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 0, 'a database in use is not seeded again');
  assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = 'starter_programs_seeded'").get());
  seedPrograms();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 0);
});
