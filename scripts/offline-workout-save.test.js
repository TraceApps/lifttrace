/**
 * Android, connected to a server, saving a workout offline (issue #102).
 * The whole flow (store, apiFetch's offline path, sync's replay, a real
 * SQLite copy) was run by hand through Vite with the phone-only modules
 * swapped out: the old code blanked the workout in 5 of 7 scenarios, the new
 * code passes all 7. That needs a module loader CI doesn't have, so these
 * guard the pieces that make it work.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const apiFetch = read('../src/lib/apiFetch.js');
const store = read('../src/stores/workout.js');
const sync = read('../src/lib/sync.js');

test('an offline write answers with what the local write returned, not a bare "queued"', () => {
  assert.match(apiFetch, /local = await LtApiNative\.handle\(method, path, body, query\);/);
  assert.match(apiFetch, /return _jsonResponse\(200, \{ \.\.\.local, queued: true, offline: true \}\);/);
});

test('a save reply without a workout never blanks the Diary', () => {
  assert.doesNotMatch(store, /todayLog\.set\(saved\.workout\);\s*\n\s*currentSessionId\.set\(saved\.workout\?\.id \?\? null\);\s*\n\s*_setSnapshot/);
  assert.match(store, /toSaveEpoch === _epoch && saved\?\.workout\) \{\s*\n\s*todayLog\.set\(saved\.workout\);/);
  assert.equal((store.match(/&& saved\?\.workout\) \{/g) || []).length, 2, 'the debounced save and the lifecycle flush');
  assert.match(store, /const workout = saved\?\.workout \|\| stamped;/, 'start new session');
});

test('online saves update the device copy; replayed offline saves bring the date back to the server copy', () => {
  assert.match(apiFetch, /if \(isWrite && res\.ok\) \{\s*\n\s*const copy = res\.clone\(\);/);
  assert.match(sync, /export async function mirrorSavedWorkout\(date, workout\)/);
  assert.match(sync, /export async function reconcileWorkoutDate\(date\)/);
  assert.match(sync, /for \(const d of workoutDates\) \{\s*\n\s*try \{ await reconcileWorkoutDate\(d\); \}/);
  // Nothing is overwritten while offline edits for that date are still waiting.
  assert.equal((sync.match(/\(await _queuedWorkoutDates\(\)\)\.has\(date\)/g) || []).length, 3, 'mirror once, reconcile twice');
});

test('the date matcher only picks out day-level workout writes', () => {
  const re = /^\/api\/workout\/(\d{4}-\d{2}-\d{2})(?:\?|$)/;
  assert.match(sync, /const _WORKOUT_PATH = \/\^\\\/api\\\/workout\\\/\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\(\?:\\\?\|\$\)\/;/);
  assert.equal(re.exec('/api/workout/2026-09-19')[1], '2026-09-19');
  assert.equal(re.exec('/api/workout/2026-09-19?id=5')[1], '2026-09-19');
  assert.equal(re.exec('/api/workout/2026-09-19/sessions'), null);
  assert.equal(re.exec('/api/workout/recent'), null);
});

test('updated_at compares as a time, whichever format it arrives in', () => {
  const src = store.slice(store.indexOf('function _tsMs(v)'), store.indexOf('export async function loadWorkout'));
  const _tsMs = new Function(`${src}; return _tsMs;`)();
  assert.ok(_tsMs('2026-09-19 12:05:00') > _tsMs('2026-09-19T12:00:00.000Z'), 'a later server time is later');
  assert.equal(_tsMs('2026-09-19 12:00:00'), _tsMs('2026-09-19T12:00:00.000Z'));
  assert.equal(_tsMs(null), 0);
  assert.match(store, /_tsMs\(data\.workout\?\.updated_at\) < _tsMs\(current\.updated_at\)/);
});

test('a workout created offline keeps its own edits: device ids are swapped for server ids on replay', () => {
  assert.match(apiFetch, /await noteQueuedLocalId\(queueId, created\)/);
  assert.match(sync, /export async function noteQueuedLocalId\(queueId, localId\)/);
  assert.match(sync, /if \(bodyId != null && idMap\.has\(bodyId\)\) \{\s*\n\s*payload\.body = \{ \.\.\.payload\.body, id: idMap\.get\(bodyId\) \};/);
  assert.match(sync, /waitingIds\.has\(bodyId\) && payload\.localId !== bodyId\) \{\s*\n\s*result\.retained\+\+;/, 'held back until its session exists');
  assert.match(sync, /if \(bodyId != null && refusedIds\.has\(bodyId\)\) \{/, 'dropped if the server refused the session');
  assert.match(sync, /new CustomEvent\('lt:workout-ids'/);
  assert.match(store, /window\.addEventListener\('lt:workout-ids'/, 'the Diary follows the new id');
});

test('reconciling writes the server rows before removing local ones, and yields to new offline edits', () => {
  const fn = sync.slice(sync.indexOf('export async function reconcileWorkoutDate'), sync.indexOf('/**', sync.indexOf('export async function reconcileWorkoutDate')));
  assert.ok(fn.indexOf('_writeServerWorkout(w)') < fn.indexOf('DELETE FROM workout_log'));
  assert.equal((fn.match(/\(await _queuedWorkoutDates\(\)\)\.has\(date\)/g) || []).length, 2);
});

test('a write kept for retry holds later writes to the same thing, and only those', () => {
  assert.match(sync, /const orderKey = \(path\) => \{ const d = workoutDateOf\(path\); return d \? `workout:\$\{d\}` : String\(path \|\| ''\)\.split\('\?'\)\[0\]; \};/);
  assert.match(sync, /if \(blocked\.has\(orderKey\(payload\.path\)\)\) \{/);
  assert.match(sync, /result\.retained\+\+;\s*\n\s*blocked\.add\(orderKey\(payload\.path\)\);/);
});

test('the device-copy update runs behind the save reply, and device reads wait for it', () => {
  assert.match(apiFetch, /_localWrites = _localWrites\.then\(\(\) => _mirrorWorkoutWrite\(url, method, copy\)\)/);
  assert.doesNotMatch(apiFetch, /if \(isWrite && res\.ok\) await _mirrorWorkoutWrite/);
  assert.equal((apiFetch.match(/await _localWrites;\s*\n\s*(const cached = )?(await|return) _dispatchLocal/g) || []).length, 2);
});
