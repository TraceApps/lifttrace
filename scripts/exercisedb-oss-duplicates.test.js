/**
 * ExerciseDB (open-source) lists some names two to four times, and the GIF
 * of many of those copies is gone from its CDN (#155). Every copy was
 * imported, so the library showed one exercise several times, all but one
 * with a broken image.
 *
 * Now a copy is left out when its name repeats and its GIF answers 404 while
 * another copy remains, and importing again clears such copies an earlier
 * import added, unless a workout, template, prescription or setting uses one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  brokenDuplicateIds,
  referencedExerciseIds,
  fetchExerciseDbOssRows,
} from '../src/lib/exercise-sources/exercisedb-oss.js';

// A catalog shaped like oss.exercisedb.dev's: "band alternating v-up" three
// times with two GIFs gone, a single entry whose GIF is gone, and a pair.
const CATALOG = [
  { exerciseId: 'a1', name: 'band alternating v-up' },
  { exerciseId: 'a2', name: 'band alternating v-up' },
  { exerciseId: 'a3', name: 'band alternating v-up' },
  { exerciseId: 'b1', name: 'lonely lift' },
  { exerciseId: 'c1', name: 'inverted row' },
  { exerciseId: 'c2', name: 'Inverted Row' },
].map(e => ({ ...e, gifUrl: `https://static.example/media/${e.exerciseId}.gif`, bodyParts: ['waist'], equipments: ['band'], targetMuscles: ['abs'], secondaryMuscles: [], instructions: ['Step:1 Go.'] }));
const GONE = new Set(['a2', 'a3', 'b1', 'c2']);

function fakeFetch(log) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'HEAD') {
      log.push(u.pathname);
      const id = u.pathname.split('/').pop().replace('.gif', '');
      return { ok: !GONE.has(id), status: GONE.has(id) ? 404 : 200, headers: { get: () => null } };
    }
    // Two pages, then the host's habit of starting over: it says there's a
    // next page and hands back the first one (the cursor loop).
    const after = u.searchParams.get('after');
    const data = after === 'p2' ? CATALOG.slice(3) : CATALOG.slice(0, 3);
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ success: true, data, meta: { hasNextPage: true, nextCursor: after === 'p2' ? 'p3' : 'p2' } }),
    };
  };
}

test('a repeated name loses only the copies whose GIF is gone, and a single entry is never checked', async () => {
  const heads = [];
  const { rows, brokenIds } = await fetchExerciseDbOssRows({ fetchFn: fakeFetch(heads), base: 'https://api.example' });
  assert.deepEqual([...brokenIds].sort(), ['a2', 'a3', 'c2']);
  assert.deepEqual(rows.map(r => r.external_id).sort(), ['a1', 'b1', 'c1']);
  assert.ok(!heads.some(p => p.includes('b1')), 'a name listed once is not checked');
});

test('a re-import whose first page is all imported still reads the rest (it stopped at page one)', async () => {
  const { rows } = await fetchExerciseDbOssRows({
    fetchFn: fakeFetch([]), base: 'https://api.example', existingIds: new Set(['a1', 'a2', 'a3']),
  });
  assert.deepEqual(rows.map(r => r.external_id).sort(), ['b1', 'c1']);
});

test('already-imported copies still count toward a repeated name, and stay out of the new rows', async () => {
  const { rows, brokenIds } = await fetchExerciseDbOssRows({
    fetchFn: fakeFetch([]), base: 'https://api.example', existingIds: new Set(['a1', 'a2', 'c1']),
  });
  assert.deepEqual([...brokenIds].sort(), ['a2', 'a3', 'c2']);
  assert.deepEqual(rows.map(r => r.external_id), ['b1']);
});

test('every copy gone keeps them all, and a check that fails keeps the copy', async () => {
  const rows = [{ name: 'X', gif_url: 'u1', external_id: 'x1' }, { name: 'x', gif_url: 'u2', external_id: 'x2' }];
  assert.equal((await brokenDuplicateIds(rows, async () => true)).size, 0);
  const failing = async () => { throw new Error('offline'); };
  const { rows: got, brokenIds } = await fetchExerciseDbOssRows({
    fetchFn: async (url, init = {}) => {
      if (init.method === 'HEAD') return failing();
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, data: CATALOG, meta: { hasNextPage: false } }) };
    },
    base: 'https://api.example',
  });
  assert.equal(brokenIds.size, 0);
  assert.equal(got.length, CATALOG.length);
});

test('in use: exercise ids in workouts, and every number in a setting, but not weights or reps', () => {
  const used = referencedExerciseIds({
    exerciseBlobs: [JSON.stringify([{ exercise_id: 41, sets: [{ weight: 135, reps: 8 }] }]), null, 'not json'],
    settingValues: [JSON.stringify([7, 9]), JSON.stringify({ 12: 'unilateral' }), '"lbs"', '90'],
  });
  assert.deepEqual([...used].sort((a, b) => a - b), [7, 9, 12, 41, 90]);
});

test('a thumbnail falls back from a failed GIF to its image, then to none', async () => {
  const { workingMedia } = await import('../src/lib/media-fallback.js');
  assert.equal(workingMedia(new Set(), 'g', 'i'), 'g');
  assert.equal(workingMedia(new Set(['g']), 'g', 'i'), 'i');
  assert.equal(workingMedia(new Set(['g', 'i']), 'g', 'i'), null);
  assert.equal(workingMedia(new Set(), null, 'i'), 'i');
});

// The server's import, against a scratch database, with the fake host as fetch.
let db = null, dir = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'exercisedb-oss-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
} catch { /* server deps not installed: the server test skips */ }

test('the server import clears unused broken copies an earlier import added, and keeps used ones', { skip: !db }, async (t) => {
  t.after(() => { db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch([]);
  t.after(() => { globalThis.fetch = realFetch; });
  const { seedFromExerciseDbOss } = await import('../server/exercise-sources/exercisedb-oss.js');

  // What an earlier import left: every copy.
  const ins = db.prepare(`INSERT INTO exercises (name, gif_url, external_id, source, is_global) VALUES (?, ?, ?, 'exercisedb-oss', 1)`);
  const id = {};
  for (const e of CATALOG) id[e.exerciseId] = Number(ins.run(e.name, e.gifUrl, e.exerciseId).lastInsertRowid);
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'x')`).run();
  db.prepare(`INSERT INTO workout_log (user_id, date, exercises) VALUES (1, '2026-11-01', ?)`).run(JSON.stringify([{ exercise_id: id.a3, sets: [] }]));
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (1, 'favoriteExercises', ?)`).run(JSON.stringify([id.c2]));

  await seedFromExerciseDbOss();
  const live = () => db.prepare(`SELECT external_id FROM exercises WHERE source = 'exercisedb-oss' AND deleted_at IS NULL ORDER BY external_id`).all().map(r => r.external_id);
  assert.deepEqual(live(), ['a1', 'a3', 'b1', 'c1', 'c2'], 'a2 cleared; a3 in a workout and c2 a favorite stay');

  // Importing again neither brings a2 back nor adds anything.
  await seedFromExerciseDbOss();
  assert.deepEqual(live(), ['a1', 'a3', 'b1', 'c1', 'c2']);
  assert.ok(db.prepare(`SELECT deleted_at FROM exercises WHERE id = ?`).get(id.a2).deleted_at, 'cleared, not deleted: its id still resolves');

  // Clearing the source, then importing it again, brings back what's in use
  // (as on dev) but not the unused broken copy.
  const { clearSource } = await import('../server/exercise-sources/index.js');
  clearSource('exercisedb-oss');
  assert.deepEqual(live(), []);
  await seedFromExerciseDbOss();
  assert.deepEqual(live(), ['a1', 'a3', 'b1', 'c1', 'c2']);
});

test('on Android, a catalog import waits minutes for the server and is never queued or run on the phone', () => {
  // apiFetch.js needs Capacitor: run it with the phone shims (scripts/android-sync).
  const script = `const m = await import('./src/lib/apiFetch.js');
    console.log(JSON.stringify([m.requestDeadlineMs('/api/exercises/sources/import', true),
      m.needsServerNow('/api/exercises/sources/import', 'POST'),
      m.requestDeadlineMs('/api/exercises', true), m.needsServerNow('/api/exercises', 'POST')]));
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['--import', './scripts/android-sync/register.mjs', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000 });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [300000, true, 30000, false]);
});
