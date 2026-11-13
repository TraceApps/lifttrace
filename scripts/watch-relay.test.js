/**
 * Local mode on the watch (#156): with no server, the watch sends its four
 * requests to the phone, and the phone's own local handler answers them.
 *
 * The routing is checked on its own, then the whole round trip runs against
 * the phone's real Local mode code (api-native.js on the SQLite shim from
 * scripts/android-sync): a set logged on the watch is saved, read back the
 * way the watch reads it, and shows in "last time".
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { answerWatchRequest, PHONE_ADDRESS } from '../src/lib/watch-relay.js';

const calls = [];
const handle = async (method, path, body, query) => { calls.push([method, path, body, query]); return { ok: true }; };

test('only the four requests the watch makes are answered', async () => {
  const ask = (method, path, body = null) => answerWatchRequest({ method, path, body }, { localMode: true, handle });
  for (const [m, p] of [['GET', '/api/workout/2026-11-13?id=4'], ['GET', '/api/workout/recent?limit=20'], ['GET', '/api/settings'], ['PUT', '/api/workout/2026-11-13']]) {
    assert.equal((await ask(m, p, m === 'PUT' ? '{"exercises":[]}' : null)).status, 200, `${m} ${p}`);
  }
  assert.deepEqual(calls[0], ['GET', '/api/workout/2026-11-13', null, { id: '4' }]);
  assert.deepEqual(calls[3], ['PUT', '/api/workout/2026-11-13', { exercises: [] }, {}]);
  for (const [m, p] of [['DELETE', '/api/workout/2026-11-13'], ['GET', '/api/exercises'], ['PUT', '/api/settings'], ['GET', '/api/workout/2026-11-13/../../auth/me'], ['POST', '/api/ai/chat']]) {
    assert.equal((await ask(m, p)).status, 404, `${m} ${p} is refused`);
  }
  assert.equal(calls.length, 4, 'nothing refused reached the handler');
});

test('a saved day is named, so the phone shows it again; a phone on a server refuses', async () => {
  const saved = await answerWatchRequest({ method: 'PUT', path: '/api/workout/2026-11-13', body: '{}' }, { localMode: true, handle });
  assert.equal(saved.savedDate, '2026-11-13');
  const read = await answerWatchRequest({ method: 'GET', path: '/api/settings' }, { localMode: true, handle });
  assert.equal(read.savedDate, undefined);
  const onServer = await answerWatchRequest({ method: 'GET', path: '/api/settings' }, { localMode: false, handle });
  assert.equal(onServer.status, 409);
  const broken = await answerWatchRequest({ method: 'PUT', path: '/api/workout/2026-11-13', body: '{not json' }, { localMode: true, handle });
  assert.equal(broken.status, 400);
  const failing = await answerWatchRequest({ method: 'GET', path: '/api/settings' }, { localMode: true, handle: async () => { throw new Error('disk full'); } });
  assert.deepEqual([failing.status, JSON.parse(failing.body).error], [500, 'disk full']);
  assert.equal(PHONE_ADDRESS, 'phone:', 'the watch looks for exactly this (Pairing.PHONE)');
});

let sqliteOk = true;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { sqliteOk = false; }

test("the watch's set goes through the phone's own Local mode code and comes back", { skip: !sqliteOk }, () => {
  const script = `
    const store = new Map();
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => {}; globalThis.removeEventListener ??= () => {}; globalThis.dispatchEvent = () => true;
    globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
    globalThis.location = { origin: 'http://localhost', href: 'http://localhost/' };
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: () => null, length: 0 }, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'], userAgent: 'node', onLine: true }, configurable: true });
    const { getDb } = await import('./src/lib/db-native.js');
    await getDb();
    const { LtApiNative } = await import('./src/lib/api-native.js');
    const { answerWatchRequest } = await import('./src/lib/watch-relay.js');
    const ask = async (method, path, body) => {
      const r = await answerWatchRequest({ method, path, body: body ? JSON.stringify(body) : null }, { localMode: true, handle: LtApiNative.handle });
      return { status: r.status, body: JSON.parse(r.body), savedDate: r.savedDate };
    };
    const day = '2026-11-13';
    const before = await ask('GET', '/api/workout/' + day);
    const set = { uuid: 's1', reps: 5, weight: 100, completed: true };
    const saved = await ask('PUT', '/api/workout/' + day, { exercises: [{ uuid: 'e1', exercise_id: 1, name: 'Bench Press', sets: [set] }] });
    const after = await ask('GET', '/api/workout/' + day + '?id=' + (saved.body.workout?.id ?? ''));
    const recent = await ask('GET', '/api/workout/recent?limit=20');
    const settings = await ask('GET', '/api/settings');
    // The watch logs a second set; the phone's Diary, still showing only the
    // first, then saves its own change to that first set (the way
    // stores/workout.js does: what it changed, listed).
    const id = saved.body.workout.id;
    await ask('PUT', '/api/workout/' + day, { id, exercises: [{ uuid: 'e1', exercise_id: 1, name: 'Bench Press', sets: [set, { uuid: 's2', reps: 5, weight: 100, completed: true }] }] });
    await LtApiNative.handle('PUT', '/api/workout/' + day, { id, exercises: [{ uuid: 'e1', exercise_id: 1, name: 'Bench Press', sets: [{ ...set, reps: 6 }] }],
      changed_uuids: { exercises: [], sets: { e1: ['s1'] } }, changed_fields: [] }, {});
    const merged = await ask('GET', '/api/workout/' + day + '?id=' + id);
    // Finishing on the watch is said once by the phone.
    const finish = await answerWatchRequest({ method: 'PUT', path: '/api/workout/' + day, body: JSON.stringify({ ...merged.body.workout, completed: 1, finished_on: 'watch' }) }, { localMode: true, handle: LtApiNative.handle });
    const again = await answerWatchRequest({ method: 'PUT', path: '/api/workout/' + day, body: JSON.stringify({ ...merged.body.workout, completed: 1, finished_on: 'watch' }) }, { localMode: true, handle: LtApiNative.handle });
    console.log(JSON.stringify({ before, saved, after, recent, settings, merged, finished: finish.finished || null, finishedAgain: again.finished || null }));
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['--import', './scripts/android-sync/register.mjs', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.before.status, 200);
  assert.equal(r.saved.status, 200);
  assert.equal(r.saved.savedDate, '2026-11-13');
  const w = r.after.body.workout;
  assert.ok(w, 'the day reads back in the shape a server gives ({ workout })');
  assert.equal(w.exercises[0].sets[0].completed, true);
  assert.equal(w.exercises[0].sets[0].weight, 100);
  const recent = Array.isArray(r.recent.body) ? r.recent.body : r.recent.body.workouts;
  assert.ok(recent?.some(x => x.date === '2026-11-13'), 'last time sees it');
  assert.equal(r.settings.status, 200);
  assert.equal(typeof r.settings.body, 'object');
  // The phone's older copy didn't put back the watch's second set, and its own change to the first stands.
  const sets = r.merged.body.workout.exercises[0].sets;
  assert.deepEqual(sets.map(x => [x.uuid, x.reps]), [['s1', 6], ['s2', 5]]);
  assert.deepEqual(r.finished, { name: '' }, 'the save that finished it says so');
  assert.equal(r.finishedAgain, null, 'one already finished does not say it again');
});
