/**
 * Auto-Fill Last Weights (issue #103). History lists every workout the
 * exercise appears in, newest first, including ones where nothing was ticked,
 * so "last completed session" has to skip those. The Last Time row and
 * auto-fill now share one function, so they can't pick different sessions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { lastCompletedSession } = await import('../src/lib/workout.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const set = (weight, reps, extra = {}) => ({ weight, reps, completed: true, ...extra });

test('the reported shape: a newer entry with nothing ticked is skipped', () => {
  const history = [
    { date: '2026-09-19', sets: [{ weight: 100, reps: 10, completed: false }, { weight: 100, reps: 10, completed: false }] },
    { date: '2026-09-15', sets: [set(100, 10), set(100, 10), set(100, 8)] },
  ];
  const last = lastCompletedSession(history);
  assert.equal(last.date, '2026-09-15');
  assert.deepEqual(last.working.map(s => [s.weight, s.reps]), [[100, 10], [100, 10], [100, 8]]);
});

test('warm-ups are shown in Last Time but never copied as working weights', () => {
  const last = lastCompletedSession([{ date: '2026-09-15', sets: [set(45, 10, { warmup: true }), set(135, 8, { warmup: true }), set(185, 5), set(185, 5)] }]);
  assert.equal(last.completed.length, 4, 'the row shows everything completed');
  assert.deepEqual(last.working.map(s => s.weight), [185, 185], 'auto-fill copies working sets only');
});

test('a session where only warm-ups were done is not the last working session', () => {
  const last = lastCompletedSession([
    { date: '2026-09-19', sets: [set(45, 10, { warmup: true })] },
    { date: '2026-09-12', sets: [set(185, 5)] },
  ]);
  assert.equal(last.date, '2026-09-12');
});

test('no completed working set anywhere means no history to fill from', () => {
  assert.equal(lastCompletedSession([]), null);
  assert.equal(lastCompletedSession(null), null);
  assert.equal(lastCompletedSession([{ date: 'x', sets: [{ weight: 1, reps: 1 }] }]), null);
});

test('timed sets count as completed working sets too', () => {
  const last = lastCompletedSession([{ date: '2026-09-15', set_type: 'time', sets: [{ duration_sec: 60, completed: true }] }]);
  assert.equal(last.working[0].duration_sec, 60);
  assert.equal(last.set_type, 'time');
});

test('auto-fill and the Last Time row both use it; template precedence is untouched', () => {
  const diary = read('../src/routes/Diary.svelte');
  const fn = diary.slice(diary.indexOf('async function getLastSets'), diary.indexOf('let pickerTargetSupersetId'));
  assert.match(fn, /lastCompletedSession\(await LtApi\.getWorkoutHistory\(exerciseId\)\)/);
  assert.match(fn, /return withWarmups \? last\.completed : last\.working;/);
  // Adding one exercise brings warm-ups back as warm-ups; template and quick
  // load fill working-set slots, so they take working sets only.
  assert.match(diary, /getLastSets\(ex\.id, \{ withWarmups: true \}\)/);
  assert.match(diary, /if \(s\.warmup\) next\.warmup = true;/);
  assert.match(diary, /const working = lastSets\.filter\(s => !s\.warmup\);\s*\n\s*targetSets = working\.length;/);
  assert.equal((diary.match(/await getLastSets\(ex\.exercise_id\)/g) || []).length, 1, 'quick load');
  // Template load pairs warm-up rows with last time's warm-ups and working
  // rows with last time's working sets, never by raw position.
  assert.match(diary, /const lastAll = await getLastSets\(ex\.exercise_id, \{ withWarmups: true \}\);/);
  assert.match(diary, /const past = spec\.warmup \? lastWarmups\[warmIdx\+\+\] : lastSets\?\.\[workIdx\+\+\];/);
  // Quick load keeps the loaded workout's warm-ups as warm-ups and sizes the
  // working sets from its working sets only.
  const quick = diary.slice(diary.indexOf('async function quickLoad'), diary.indexOf('// ── Exercise management'));
  assert.match(quick, /const numSets = \(ex\.sets \|\| \[\]\)\.filter\(s => !s\?\.warmup\)\.length/);
  assert.match(quick, /completed: false, notes: '', warmup: true,/);
  assert.match(quick, /sets = \[\.\.\.warmups, \.\.\.sets\];/);
  assert.doesNotMatch(fn, /history\[0\]/);
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.match(card, /lastCompletedSession\(await LtApi\.getWorkoutHistory\(exercise\.exercise_id\)\)/);
  // Per-set specs and an active periodized week still win over history.
  assert.match(diary, /if \(ex\.set_specs && ex\.set_specs\.length > 0\) \{/);
  assert.match(diary, /const planWins = !!\(planWeek && ex\.weeks\?\.length\);/);
  assert.match(diary, /if \(lastSets && !planWins\) \{/);
});
