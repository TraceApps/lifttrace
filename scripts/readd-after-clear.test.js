/**
 * Issue #99: after Clear Workout, loading the same workout again did nothing.
 *
 * Runs the reported steps through the real merge the server applies on every
 * save (server/lib/workout-merge.js) and the client's own tombstone diff, so
 * the failure is reproduced first and the fix is shown against it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { mergeExercises } = await import('../server/lib/workout-merge.js');
const { withFreshIds, ensureExerciseUuids, diffTombstones } = await import('../src/lib/workout-uuid.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A saved template: its exercises keep the same ids for as long as it exists.
const template = [
  { uuid: 'tpl-bench', exercise_id: 1, exercise_name: 'Bench Press', sets: [{ weight: 100, reps: 5 }] },
  { uuid: 'tpl-row', exercise_id: 2, exercise_name: 'Row', sets: [{ weight: 80, reps: 8 }] },
];

/** One save, the way the store and PUT /api/workout/:date do it. */
function save(day, clientExercises) {
  const next = ensureExerciseUuids(clientExercises);
  const deleted = diffTombstones(day.exercises, next).exercises || [];
  const r = mergeExercises(day.exercises, next, deleted, day.tombstones);
  return { exercises: r.merged, tombstones: [...day.tombstones, ...r.newTombstoneExerciseUuids] };
}

const loadOld = () => template.map(ex => ({ ...ex, sets: ex.sets.map(s => ({ ...s })) })); // before the fix
const loadNew = () => withFreshIds(template);                                              // after

test('the report, before the fix: the reloaded workout is dropped', () => {
  let day = { exercises: [], tombstones: [] };
  day = save(day, loadOld());
  assert.equal(day.exercises.length, 2, 'first load works');
  day = save(day, []);                                  // Clear Workout
  assert.equal(day.exercises.length, 0);
  day = save(day, loadOld());                           // add it back
  assert.equal(day.exercises.length, 0, 'reproduces #99: the save "succeeds" with nothing in it');
});

test('the report, after the fix: the workout comes back', () => {
  let day = { exercises: [], tombstones: [] };
  day = save(day, loadNew());
  day = save(day, []);
  day = save(day, loadNew());
  assert.deepEqual(day.exercises.map(e => e.exercise_name), ['Bench Press', 'Row']);
  // And again, any number of times.
  day = save(day, []);
  day = save(day, loadNew());
  assert.equal(day.exercises.length, 2);
});

test('a day cleared before the fix recovers without any data change', () => {
  let day = { exercises: [], tombstones: [] };
  day = save(day, loadOld());
  day = save(day, []);                                  // tombstones for the template ids stay on the server
  day = save(day, loadNew());
  assert.equal(day.exercises.length, 2);
});

test('removing one exercise and reloading the template brings it back too', () => {
  let day = { exercises: [], tombstones: [] };
  day = save(day, loadNew());
  day = save(day, day.exercises.filter(e => e.exercise_name !== 'Row'));
  day = save(day, loadNew());                           // replace with the template again
  assert.deepEqual(day.exercises.map(e => e.exercise_name), ['Bench Press', 'Row']);
});

test('fresh ids are new for every exercise and set, and nothing else changes', () => {
  const src = [{ uuid: 'a', exercise_id: 7, exercise_name: 'Plank', set_type: 'time', superset_id: 's1',
    sets: [{ uuid: 'x', duration_sec: 60, completed: true }] }];
  const [out] = withFreshIds(src);
  assert.notEqual(out.uuid, 'a');
  assert.notEqual(out.sets[0].uuid, 'x');
  assert.ok(out.uuid && out.sets[0].uuid);
  const strip = ({ uuid, sets, ...r }) => ({ ...r, sets: sets.map(({ uuid: _u, ...s }) => s) });
  assert.deepEqual(strip(out), strip(src[0]));
  assert.equal(src[0].uuid, 'a', 'the source is not modified');
  assert.notEqual(withFreshIds(src)[0].uuid, out.uuid, 'each load gets its own ids');
});

test('every Diary path that copies exercises in uses fresh ids', () => {
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /exercises: withFreshIds\(withWarmups\)/, 'templates and prescriptions');
  assert.match(diary, /exercises: withFreshIds\(yesterdayExercises\)/, 'copy from yesterday');
  assert.match(diary, /exercises: withFreshIds\(filled\)/, 'recent workouts');
});
