/**
 * The Diary's volume chip compares set for set (src/lib/workout.js
 * volumeDelta, used by src/components/diary/ExerciseCard.svelte).
 *
 * Mid-workout, after 2 of 3 sets, it used to set today's two sets against all
 * of last time's three and read -28% (red) while the lifter was ahead. Now
 * today's N completed working sets are set against the first N of last time,
 * however many are ticked; a finished workout is compared whole, as it
 * always was.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { volumeDelta, exerciseVolume } = await import('../src/lib/workout.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const set = (weight, reps, extra = {}) => ({ weight, reps, completed: true, ...extra });
const todo = (weight, reps) => ({ weight, reps, completed: false });
const ex = (sets, extra = {}) => ({ load_type: 'bilateral', sets, ...extra });
// What the chip did before: all of today's completed sets against all of last time's.
const wholeSession = (exercise, lastSets) => {
  const cur = exerciseVolume(exercise);
  const last = exerciseVolume({ load_type: exercise.load_type, sets: lastSets.map(s => ({ ...s, completed: true })) });
  return last > 0 && cur > 0 ? Math.round((cur - last) / last * 100) : null;
};

const LAST = [set(135, 8), set(135, 8), set(135, 8)]; // 3240

test('2 of 3 sets done, heavier: set for set, not -28% against the whole session', () => {
  const today = ex([set(145, 8), set(145, 8), todo(145, 8)]);
  assert.equal(wholeSession(today, LAST), -28, 'the old chip');
  const d = volumeDelta(today, LAST);
  assert.equal(d.pct, 7, '2320 against 2160');
  assert.deepEqual({ sets: d.sets, partial: d.partial }, { sets: 2, partial: true });
});

test('1 set done reads as that set against last time\'s first', () => {
  const d = volumeDelta(ex([set(145, 8), todo(145, 8), todo(145, 8)]), LAST);
  assert.deepEqual(d, { pct: 7, sets: 1, partial: true });
  assert.equal(volumeDelta(ex([set(135, 8), todo(135, 8)]), LAST).pct, 0, 'an even set is 0, which the chip hides');
  assert.equal(volumeDelta(ex([set(100, 8), todo(135, 8)]), LAST).pct, -26, 'a lighter one still says so');
});

test('every set done: the whole session, as before', () => {
  const today = ex([set(145, 8), set(145, 8), set(145, 8)]);
  const d = volumeDelta(today, LAST);
  assert.equal(d.pct, 7);
  assert.equal(d.pct, wholeSession(today, LAST));
  assert.equal(d.partial, false);
});

test('every set ticked but the workout not finished, with fewer planned than last time: still set for set', () => {
  const today = ex([set(135, 8), set(135, 8)]);
  const d = volumeDelta(today, LAST);
  assert.equal(d.pct, 0);
  assert.equal(d.sets, 2);
  assert.equal(d.partial, true);
});

test('finished with fewer sets than last time: the whole session, not the first N', () => {
  const today = ex([set(135, 8), set(135, 8)]);
  assert.equal(volumeDelta(today, LAST, { done: true }).pct, -33);
  assert.equal(volumeDelta(today, LAST, { done: true }).pct, wholeSession(today, LAST));
});

test('last time 4 sets, today 3 planned: ticking the third keeps comparing set for set, not 3 against all 4', () => {
  const last = [set(135, 8), set(135, 8), set(135, 8), set(135, 8)];
  const after2 = volumeDelta(ex([set(145, 8), set(145, 8), todo(145, 8)]), last);
  assert.equal(after2.pct, 7);
  const after3 = volumeDelta(ex([set(145, 8), set(145, 8), set(145, 8)]), last);
  assert.equal(after3.pct, 7, 'still ahead set for set, not -19% (red) against all four');
  assert.equal(after3.sets, 3);
  assert.equal(after3.partial, true);
  // Finishing the workout is when the whole of both counts.
  assert.equal(volumeDelta(ex([set(145, 8), set(145, 8), set(145, 8)]), last, { done: true }).pct, -19);
});

test('a finished workout compares whole even with sets never ticked', () => {
  const today = ex([set(145, 8), set(145, 8), todo(145, 8)]);
  const d = volumeDelta(today, LAST, { done: true });
  assert.equal(d.pct, wholeSession(today, LAST));
  assert.equal(d.pct, -28);
  assert.equal(d.partial, false);
});

test('more sets today than last time: all of last time, no zeros invented', () => {
  const last = [set(100, 10), set(100, 10)]; // 2000
  const today = ex([set(100, 10), set(100, 10), set(100, 10), todo(100, 10), todo(100, 10)]);
  assert.deepEqual(volumeDelta(today, last), { pct: 50, sets: 2, partial: false });
});

test('warm-ups are left out of both sides', () => {
  const last = [set(45, 8, { warmup: true }), set(95, 3, { warmup: true }), set(135, 8), set(135, 8), set(135, 8)];
  const today = ex([set(45, 8, { warmup: true }), set(145, 8), todo(145, 8), todo(145, 8)]);
  assert.deepEqual(volumeDelta(today, last), { pct: 7, sets: 1, partial: true });
  // A warm-up not ticked doesn't keep the exercise from being done.
  const done = ex([{ weight: 45, reps: 8, completed: false, warmup: true }, set(145, 8), set(145, 8), set(145, 8)]);
  assert.equal(volumeDelta(done, last).partial, false);
});

test('timed sets have no volume and are left out', () => {
  const last = [set(135, 8), { weight: 0, reps: 0, duration_sec: 60, completed: true }, set(135, 8)];
  const today = ex([set(145, 8), todo(145, 8)]);
  assert.deepEqual(volumeDelta(today, last), { pct: 7, sets: 1, partial: true });
  // An exercise set to Time: nothing to compare.
  assert.equal(volumeDelta(ex([set(0, 0, { duration_sec: 60 })], { set_type: 'time' }), LAST), null);
  assert.equal(volumeDelta(ex([set(0, 0, { duration_sec: 60 }), todo(0, 0)]), LAST), null);
});

test('load types count the same on both sides', () => {
  const last = [set(50, 10), set(50, 10), set(50, 10)];
  const paired = ex([set(55, 10), todo(55, 10)], { load_type: 'paired' });
  assert.deepEqual(volumeDelta(paired, last), { pct: 10, sets: 1, partial: true });
  const uni = ex([set(55, 10, { reps_l: 10, reps_r: 8 }), todo(55, 10)], { load_type: 'unilateral' });
  assert.equal(volumeDelta(uni, [set(50, 10, { reps_l: 10, reps_r: 10 }), set(50, 10)]).pct, -1);
});

test('nothing to compare reads as no chip', () => {
  assert.equal(volumeDelta(ex([set(145, 8)]), []), null, 'no last session');
  assert.equal(volumeDelta(ex([set(145, 8)]), null), null);
  assert.equal(volumeDelta(ex([todo(145, 8)]), LAST), null, 'nothing done yet');
  assert.equal(volumeDelta(ex([set(0, 12), todo(0, 12)]), LAST), null, 'bodyweight today');
  assert.equal(volumeDelta(ex([set(145, 8)]), [set(0, 12)]), null, 'bodyweight last time');
  assert.equal(volumeDelta(null, LAST), null);
});

test('done: the same number as the whole-session comparison for any mix of sets', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const make = (n, completedOnly) => Array.from({ length: n }, () => {
    const s = { weight: pick([0, 20, 45, 100, 135]), reps: pick([0, 5, 8, 12]), completed: completedOnly || rnd() < 0.7 };
    if (rnd() < 0.15) s.warmup = true;
    if (rnd() < 0.1) { s.duration_sec = 30; }
    if (rnd() < 0.2) { s.reps_l = pick([4, 6]); s.reps_r = pick([4, 6]); }
    return s;
  });
  for (let i = 0; i < 500; i++) {
    const loadType = pick(['bilateral', 'paired', 'unilateral']);
    const today = ex(make(1 + Math.floor(rnd() * 6), false), { load_type: loadType });
    const last = make(Math.floor(rnd() * 6), true);
    const old = wholeSession(today, last);
    assert.equal(volumeDelta(today, last, { done: true })?.pct ?? null, old, `finished ${i}`);
    // Unfinished, it is set for set however many are ticked.
    const n = today.sets.filter(s => s.completed && !s.warmup && !(s.duration_sec > 0)).length;
    const firstN = last.filter(s => !s.warmup && !(s.duration_sec > 0)).slice(0, n);
    assert.equal(volumeDelta(today, last)?.pct ?? null, wholeSession({ ...today, sets: today.sets.filter(s => s.completed) }, firstN), `unfinished ${i}`);
  }
});

test('the card uses it and says what it compares', () => {
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.match(card, /volumeDelta\(/);
  assert.doesNotMatch(card, /lastVolume/, 'no second copy of the rule');
  assert.match(card, /\$: volumeCmp = [^\n]*\{ done: workoutDone \}/, 'reacts to the workout finishing');
  // Every card is told whether the workout is finished (each tag on its own).
  const tags = (src, name) => src.match(new RegExp(`<${name}\\b[\\s\\S]*?/>`, 'g')) || [];
  const diary = read('../src/routes/Diary.svelte');
  for (const name of ['ExerciseCard', 'SupersetCard']) {
    const found = tags(diary, name);
    assert.equal(found.length, 1);
    assert.match(found[0], /workoutDone=\{!!\$todayLog\?\.completed\}/, `Diary's ${name}`);
  }
  const inSuperset = tags(read('../src/components/diary/SupersetCard.svelte'), 'ExerciseCard');
  assert.equal(inSuperset.length, 2, 'alone and in a superset');
  for (const tag of inSuperset) assert.match(tag, /\{workoutDone\}/);
});
