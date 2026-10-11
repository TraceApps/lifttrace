/**
 * A background refresh keeps the workout that's open (#142, reported by
 * @surfingbytes).
 *
 * With two workouts on one day (mobility in the morning, push in the
 * evening), logging a set in the evening one switched the Android app to
 * the morning one: every sync that brought a workout back reloaded the
 * date, and by date alone the server and the phone's copy answer with the
 * date's first workout. Reproduced on an Android emulator against a real
 * server; with the fix the evening workout stays put.
 *
 * These run the real store (src/stores/workout.js) with its API module
 * swapped for an in-memory one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

const STUB = `export const LtApi = globalThis.__ltApi;`;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '../lib/api.js' && context.parentURL?.endsWith('/src/stores/workout.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
    }
    return next(specifier, context);
  }`), import.meta.url);

// Workouts by date, in the order the date's sessions were started.
const days = new Map();
const calls = [];
globalThis.__ltApi = {
  async getWorkout(date, id = null) {
    calls.push([date, id]);
    if (globalThis.__answer) { const a = globalThis.__answer(date, id); if (a !== undefined) return a; }
    const list = days.get(date) || [];
    const w = id != null ? list.find(x => x.id === id) : list[0];
    return { workout: w ? structuredClone(w) : null };
  },
  async getWorkoutSessions(date) { return { sessions: structuredClone(days.get(date) || []) }; },
  async getMyPrescriptionForDate() { return null; },
};
const { get } = await import('svelte/store');
const store = await import('../src/stores/workout.js');
const shown = () => ({ id: get(store.todayLog)?.id ?? null, session: get(store.currentSessionId) });

const DAY = '2026-10-07';
const morning = { id: 1, date: DAY, name: 'Mobility', session_seq: 0, updated_at: '2026-10-07 08:00:00', exercises: [] };
const evening = { id: 2, date: DAY, name: 'Push', session_seq: 1, updated_at: '2026-10-07 18:00:00', exercises: [] };

test('a refresh after logging a set in the second workout stays on it', async () => {
  days.set(DAY, [morning, evening]);
  await store.loadWorkout(DAY);
  assert.deepEqual(shown(), { id: 1, session: 1 }, 'the date opens on its first workout');
  await store.switchSession(DAY, 2);
  assert.deepEqual(shown(), { id: 2, session: 2 });
  days.set(DAY, [morning, { ...evening, updated_at: '2026-10-07 18:05:00' }]); // the set came back in a sync
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.deepEqual(shown(), { id: 2, session: 2 }, 'still the evening workout');
  assert.equal(get(store.todayLog).updated_at, '2026-10-07 18:05:00', 'with what the sync brought');
});

test('the open workout deleted on another device: the date shows its first one', async () => {
  days.set(DAY, [morning, evening]);
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  days.set(DAY, [morning]);
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.deepEqual(shown(), { id: 1, session: 1 });
});

test('going to a date still opens its first workout', async () => {
  days.set(DAY, [morning, evening]);
  days.set('2026-10-08', [{ ...morning, id: 3, date: '2026-10-08' }, { ...evening, id: 4, date: '2026-10-08' }]);
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  await store.loadWorkout('2026-10-08');
  assert.deepEqual(shown(), { id: 3, session: 3 }, 'not the second one because the second was open on another date');
  await store.loadWorkout(DAY);
  assert.deepEqual(shown(), { id: 1, session: 1 }, 'a plain reload of a date is unchanged');
});

test('a refresh with no workout open loads the date as before', async () => {
  days.set('2026-10-09', []);
  await store.loadWorkout('2026-10-09');
  assert.deepEqual(shown(), { id: null, session: null });
  days.set('2026-10-09', [{ ...morning, id: 5, date: '2026-10-09' }]); // made on another device
  calls.length = 0;
  await store.loadWorkout('2026-10-09', { preferFresher: true });
  assert.deepEqual(shown(), { id: 5, session: 5 });
  assert.deepEqual(calls, [['2026-10-09', null]]);
});

test('an explicit workout is loaded, and null means the date\'s first', async () => {
  days.set(DAY, [morning, evening]);
  await store.loadWorkout(DAY, { sessionId: 2 });
  assert.deepEqual(shown(), { id: 2, session: 2 });
  await store.loadWorkout(DAY, { sessionId: null });
  assert.deepEqual(shown(), { id: 1, session: 1 });
});

test('an older copy of the open workout still never replaces a newer one on screen', async () => {
  days.set(DAY, [morning, evening]);
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  store.todayLog.update(w => ({ ...w, name: 'Push (edited)', updated_at: '2026-10-07 18:10:00' }));
  await store.loadWorkout(DAY, { preferFresher: true }); // the copy still says 18:00
  assert.equal(get(store.todayLog).name, 'Push (edited)');
  assert.equal(get(store.currentSessionId), 2);
});

test('copy from yesterday saves into the workout that was open, not the date\'s first', () => {
  const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  const fn = diary.slice(diary.indexOf('async function copyFromYesterday()'), diary.indexOf('// ── Load Workout from Program'));
  assert.match(fn, /const sessionBackup = \$currentSessionId;/);
  assert.equal((fn.match(/await loadWorkout\(currentDateBackup, \{ sessionId: sessionBackup \}\);/g) || []).length, 2, 'after the copy and after a failure');
  assert.doesNotMatch(fn, /await loadWorkout\(currentDateBackup\);/);
});

test('the server answering by id with a deleted workout, or the offline copy with another one: the date shows its first', async () => {
  days.set(DAY, [morning, evening]);
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  globalThis.__answer = (date, id) => (id === 2 ? { workout: { ...evening, deleted_at: '2026-10-07 19:00:00' } } : undefined);
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.deepEqual(shown(), { id: 1, session: 1 }, 'a deleted workout is never shown again');
  await store.switchSession(DAY, 2);
  globalThis.__answer = (date, id) => (id === 2 ? { workout: { ...morning } } : undefined);
  await store.loadWorkout(DAY, { sessionId: 2 });
  assert.deepEqual(shown(), { id: 1, session: 1 }, 'and another workout is never taken for it');
  globalThis.__answer = null;
});

test('a workout made offline on this device stays open when it comes back under the server\'s id', async () => {
  const made = { ...evening, id: -1791674512861001 };
  days.set(DAY, [morning, made]);
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, made.id);
  assert.deepEqual(shown(), { id: made.id, session: made.id });
  // The request for the device id is answered with the server's row (apiFetch swapKnownIds).
  globalThis.__answer = (date, id) => (id === made.id ? { workout: { ...evening, id: 6 } } : undefined);
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.deepEqual(shown(), { id: 6, session: 6 });
  globalThis.__answer = null;
});

test("the phone's copy never answers with a deleted workout by id", () => {
  const native = readFileSync(new URL('../src/lib/api-native.js', import.meta.url), 'utf8');
  const byDate = native.slice(native.indexOf('async byDate(date, explicitId = null)'), native.indexOf('async sessions(date)'));
  assert.match(byDate, /if \(row\?\.deleted_at\) return null;/);
});
