/**
 * Which sets wear the PR badge (src/lib/pr-sets.js): a set is a PR only if
 * it beats the history AND every earlier set of the same exercise today,
 * including the day's earlier workouts. A repeat of a set is not a PR.
 *
 * The rule is pure, so these run the real code. The last tests hold it to
 * the records list (server/lib/volume.js accumulateRecord, the definition
 * GET /api/v1/records and the pr.set webhook use) and check the Diary reads
 * it instead of keeping a rule of its own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { prFlags, celebrationFor, earlierWorkouts } = await import('../src/lib/pr-sets.js');
const volume = await import('../server/lib/volume.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const BENCH = 7;
const DATE = '2026-11-04';
const done = (weight, reps, extra = {}) => ({ weight, reps, completed: true, ...extra });
const ex = (sets, extra = {}) => ({ exercise_id: BENCH, exercise_name: 'Bench Press', sets, ...extra });
const past = (...sets) => ({ date: '2026-10-28', sets });
// { exerciseIndex: [setIndex...] }, to compare plainly.
const flags = (args) => Object.fromEntries(Object.entries(prFlags({ date: DATE, ...args })).map(([i, s]) => [i, [...s].sort()]));
const hist = (...entries) => ({ [BENCH]: entries });

test('a repeat of a set is not a PR: 150x8 twice after 145x8 badges the first only', () => {
  const got = flags({ exercises: [ex([done(150, 8), done(150, 8)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0] });
});

test('three identical sets after an easier past: still only the first', () => {
  const got = flags({ exercises: [ex([done(150, 8), done(150, 8), done(150, 8)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0] });
});

test('a heavier second set is a PR as well', () => {
  const got = flags({ exercises: [ex([done(150, 8), done(155, 8)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0, 1] });
});

test('a lighter set then a heavier one: the light one that beats history, then only what beats it', () => {
  const got = flags({
    exercises: [ex([done(110, 5), done(105, 5), done(115, 5), done(115, 5)])],
    history: hist(past(done(100, 5))),
  });
  assert.deepEqual(got, { 0: [0, 2] });
});

test('more reps at the same weight beats an earlier set (estimated 1RM), the same reps do not', () => {
  const got = flags({ exercises: [ex([done(150, 8), done(150, 9), done(150, 9)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0, 1] });
});

test('a set that does not beat history is never a PR, however it follows the others', () => {
  const got = flags({ exercises: [ex([done(140, 8), done(140, 8)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, {});
});

test('a set equal to the past best is not a PR (as before)', () => {
  assert.deepEqual(flags({ exercises: [ex([done(145, 8)])], history: hist(past(done(145, 8))) }), {});
});

test('warm-ups and unfinished sets are excluded, and do not raise the bar', () => {
  const got = flags({
    exercises: [ex([done(200, 5, { warmup: true }), { weight: 190, reps: 5, completed: false }, done(150, 8), done(150, 8)])],
    history: hist(past(done(145, 8))),
  });
  assert.deepEqual(got, { 0: [2] });
});

test('the history\'s own warm-ups do not count either', () => {
  const got = flags({ exercises: [ex([done(150, 8)])], history: hist(past(done(300, 5, { warmup: true }), done(145, 8))) });
  assert.deepEqual(got, { 0: [0] });
});

test('a first session ever: its first set is the record, an identical repeat is not', () => {
  assert.deepEqual(flags({ exercises: [ex([done(100, 5), done(100, 5)])], history: hist() }), { 0: [0] });
});

test('history not loaded yet: no badge on a guess', () => {
  assert.deepEqual(flags({ exercises: [ex([done(100, 5)])], history: {} }), {});
  assert.deepEqual(flags({ exercises: [ex([done(100, 5)])], history: undefined }), {});
});

test('kg and lb: decimal weights compare as they are stored, a repeat is still not a PR', () => {
  assert.deepEqual(flags({ exercises: [ex([done(62.5, 8), done(62.5, 8), done(65, 8)])], history: hist(past(done(60, 8))) }), { 0: [0, 2] });
  assert.deepEqual(flags({ exercises: [ex([done(142.5, 5), done(142.5, 5)])], history: hist(past(done(140, 5))) }), { 0: [0] });
  const third = 0.1 + 0.2;
  assert.deepEqual(flags({ exercises: [ex([done(third, 5), done(0.30000000000000004, 5)])], history: hist(past(done(0.2, 5))) }), { 0: [0] });
});

test('the same day\'s entries in the history are ignored (the server\'s answer includes the open workout)', () => {
  const today = { date: DATE, sets: [done(150, 8), done(150, 8)] };
  const got = flags({ exercises: [ex([done(150, 8), done(150, 8)])], history: hist(today, past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0] });
});

test('badges follow the saved sets, not the order they were ticked in', () => {
  const sets = [done(150, 8), done(150, 8)];
  const args = { exercises: [ex(sets)], history: hist(past(done(145, 8))) };
  const first = flags(args);
  // Reopening the day later gives the same answer, ticked in any order.
  assert.deepEqual(flags({ ...args, exercises: [ex(JSON.parse(JSON.stringify(sets)))] }), first);
  assert.deepEqual(first, { 0: [0] });
});

test('an earlier set edited or unticked re-decides the later ones', () => {
  const history = hist(past(done(145, 8)));
  assert.deepEqual(flags({ exercises: [ex([done(150, 8), done(150, 8)])], history }), { 0: [0] });
  // Earlier set lowered under history: the second is now the first to beat it.
  assert.deepEqual(flags({ exercises: [ex([done(140, 8), done(150, 8)])], history }), { 0: [1] });
  // Earlier set unticked: same.
  assert.deepEqual(flags({ exercises: [ex([{ weight: 150, reps: 8, completed: false }, done(150, 8)])], history }), { 0: [1] });
  // Earlier set raised: the second no longer beats it.
  assert.deepEqual(flags({ exercises: [ex([done(155, 8), done(150, 8)])], history }), { 0: [0] });
});

test('timed holds: a repeat of the longest hold is not a PR, a longer one is', () => {
  const plank = (sets) => ({ exercise_id: BENCH, exercise_name: 'Plank', set_type: 'time', sets });
  const hold = (sec, weight = 0) => ({ duration_sec: sec, weight, completed: true });
  const history = hist({ date: '2026-10-28', set_type: 'time', sets: [hold(50)] });
  assert.deepEqual(flags({ exercises: [plank([hold(60), hold(60), hold(55), hold(65)])], history }), { 0: [0, 3] });
  assert.deepEqual(flags({ exercises: [plank([hold(50)])], history }), {}, 'equal to the past best');
});

test('timed holds: the heaviest load held is a PR once, a repeat of it is not', () => {
  const carry = (sets) => ({ exercise_id: BENCH, exercise_name: 'Farmer Carry', set_type: 'time', sets });
  const hold = (sec, weight) => ({ duration_sec: sec, weight, completed: true });
  const history = hist({ date: '2026-10-28', set_type: 'time', sets: [hold(40, 20)] });
  assert.deepEqual(flags({ exercises: [carry([hold(30, 24), hold(30, 24), hold(30, 28)])], history }), { 0: [0, 2] });
});

test('timed holds: the unfinished and warm-up holds are excluded', () => {
  const plank = { exercise_id: BENCH, exercise_name: 'Plank', set_type: 'time', sets: [
    { duration_sec: 300, completed: true, warmup: true }, { duration_sec: 300, completed: false }, { duration_sec: 60, completed: true }, { duration_sec: 60, completed: true }] };
  assert.deepEqual(flags({ exercises: [plank], history: hist({ date: '2026-10-28', set_type: 'time', sets: [{ duration_sec: 50, completed: true }] }) }), { 0: [2] });
});

test('the same day\'s earlier workout counts: matching it is not a PR, beating it is', () => {
  const earlier = [[ex([done(150, 8)])]];
  const history = hist(past(done(145, 8)));
  assert.deepEqual(flags({ exercises: [ex([done(150, 8), done(155, 8)])], history, earlier }), { 0: [1] });
  // Two earlier workouts: both count.
  assert.deepEqual(flags({ exercises: [ex([done(155, 8)])], history, earlier: [[ex([done(150, 8)])], [ex([done(155, 8)])]] }), {});
  // Another exercise in the earlier workout does not.
  const other = [[{ exercise_id: 99, exercise_name: 'Squat', sets: [done(300, 5)] }]];
  assert.deepEqual(flags({ exercises: [ex([done(150, 8)])], history, earlier: other }), { 0: [0] });
  // Its warm-ups and unfinished sets do not.
  assert.deepEqual(flags({ exercises: [ex([done(150, 8)])], history, earlier: [[ex([done(200, 3, { warmup: true }), { weight: 190, reps: 3, completed: false }])]] }), { 0: [0] });
});

test('the same exercise twice in one workout: the later card is judged against the earlier', () => {
  const got = flags({ exercises: [ex([done(150, 8)]), ex([done(150, 8), done(152.5, 8)])], history: hist(past(done(145, 8))) });
  assert.deepEqual(got, { 0: [0], 1: [1] });
});

test('each exercise is judged on its own history', () => {
  const squat = { exercise_id: 99, exercise_name: 'Squat', sets: [done(200, 5), done(200, 5)] };
  const got = flags({
    exercises: [ex([done(150, 8), done(150, 8)]), squat],
    history: { [BENCH]: [past(done(145, 8))], 99: [past(done(190, 5))] },
  });
  assert.deepEqual(got, { 0: [0], 1: [0] });
});

test('an exercise without an id has no badge', () => {
  assert.deepEqual(flags({ exercises: [{ exercise_name: 'Custom', sets: [done(100, 5)] }], history: {} }), {});
});

test('a set with no weight or no reps is never a PR', () => {
  assert.deepEqual(flags({ exercises: [ex([done(0, 10), done(100, 0)])], history: hist(past(done(50, 5))) }), {});
});

test('the badge count is the number of badged sets', () => {
  const got = prFlags({ date: DATE, exercises: [ex([done(150, 8), done(150, 8), done(155, 8)])], history: hist(past(done(145, 8))) });
  assert.equal(Object.values(got).reduce((n, s) => n + s.size, 0), 2);
});

test('earlierWorkouts: only this day\'s workouts started before the open one', () => {
  const day = (id, date, exercises) => ({ id, date, exercises });
  const a = [ex([done(150, 8)])], b = [ex([done(155, 8)])];
  const sessions = [day(1, DATE, a), day(2, DATE, b), day(3, '2026-11-03', [ex([done(300, 8)])])];
  assert.deepEqual(earlierWorkouts(sessions, 1, DATE), [], 'the first one has nothing before it');
  assert.deepEqual(earlierWorkouts(sessions, 2, DATE), [a]);
  // A workout not in the list yet is a new one, after all of them.
  assert.deepEqual(earlierWorkouts(sessions, null, DATE), [a, b]);
  assert.deepEqual(earlierWorkouts(sessions, -5, DATE), [a, b]);
  // The list of another date still arriving is ignored; so is a missing or odd one.
  assert.deepEqual(earlierWorkouts(sessions, 2, '2026-11-05'), []);
  assert.deepEqual(earlierWorkouts(undefined, 2, DATE), []);
  assert.deepEqual(earlierWorkouts([day(1, DATE, 'x'), day(2, DATE, b)], 2, DATE), [[]]);
});

test('the day\'s earlier workout, as the Diary hands it over, decides the second one\'s badges', () => {
  const sessions = [{ id: 1, date: DATE, exercises: [ex([done(150, 8), done(155, 8)])] }, { id: 2, date: DATE, exercises: [] }];
  const history = hist(past(done(145, 8)));
  const got = flags({ exercises: [ex([done(155, 8), done(160, 8)])], history, earlier: earlierWorkouts(sessions, 2, DATE) });
  assert.deepEqual(got, { 0: [1] });
  // Opening the first one instead: nothing earlier, its own sets only.
  assert.deepEqual(flags({ exercises: sessions[0].exercises, history, earlier: earlierWorkouts(sessions, 1, DATE) }), { 0: [0, 1] });
});

// ── The celebration reads the same rule ─────────────────────────────────

test('celebration: a first record is celebrated, an identical repeat is not', () => {
  const exercises = [ex([done(150, 8), done(150, 8)])];
  const history = [past(done(145, 8))];
  assert.equal(celebrationFor({ exercises, exIdx: 0, setIdx: 0, history, date: DATE }), 'weight');
  assert.equal(celebrationFor({ exercises, exIdx: 0, setIdx: 1, history, date: DATE }), null);
});

test('celebration: more reps at the same weight is an e1rm PR; a weight PR says weight', () => {
  const history = [past(done(150, 8))];
  assert.equal(celebrationFor({ exercises: [ex([done(150, 10)])], exIdx: 0, setIdx: 0, history, date: DATE }), 'e1rm');
  assert.equal(celebrationFor({ exercises: [ex([done(155, 8)])], exIdx: 0, setIdx: 0, history, date: DATE }), 'weight');
});

test('celebration: nothing to beat on the very first session, none for a warm-up, none against the day\'s earlier workout', () => {
  assert.equal(celebrationFor({ exercises: [ex([done(100, 5)])], exIdx: 0, setIdx: 0, history: [], date: DATE }), null);
  assert.equal(celebrationFor({ exercises: [ex([done(500, 5, { warmup: true })])], exIdx: 0, setIdx: 0, history: [past(done(100, 5))], date: DATE }), null);
  assert.equal(celebrationFor({ exercises: [ex([done(150, 8)])], exIdx: 0, setIdx: 0, history: [past(done(145, 8))], date: DATE, earlier: [[ex([done(150, 8)])]] }), null);
  assert.equal(celebrationFor({ exercises: [ex([done(100, 5)])], exIdx: 0, setIdx: 0, history: [past(done(145, 8))], date: DATE }), null);
});

test('celebration: holds', () => {
  const plank = (sets) => ({ exercise_id: BENCH, exercise_name: 'Plank', set_type: 'time', sets });
  const history = [{ date: '2026-10-28', set_type: 'time', sets: [{ duration_sec: 50, completed: true }] }];
  const exercises = [plank([{ duration_sec: 60, completed: true }, { duration_sec: 60, completed: true }])];
  assert.equal(celebrationFor({ exercises, exIdx: 0, setIdx: 0, history, date: DATE }), 'hold');
  assert.equal(celebrationFor({ exercises, exIdx: 0, setIdx: 1, history, date: DATE }), null);
});

// ── One rule with the records list ──────────────────────────────────────

// A tiny seeded generator, so a failure repeats.
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

test('a badged rep set is exactly one that moves the records list (weight or estimated 1RM)', () => {
  const rand = rng(20261104);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  for (let n = 0; n < 400; n++) {
    const sets = (k) => Array.from({ length: k }, () => done(pick([40, 50, 60, 62.5, 70, 80, 100]), pick([1, 3, 5, 5, 8, 8, 12]), rand() < 0.15 ? { warmup: true } : rand() < 0.1 ? { completed: false } : {}));
    const old = sets(Math.floor(rand() * 4));
    const today = sets(1 + Math.floor(rand() * 5));
    const got = prFlags({ date: DATE, exercises: [ex(today)], history: hist(past(...old)) })[0] || new Set();
    // The records list, folded the way get-records.js folds it: history, then today in order.
    const rec = volume.newRecord('Bench Press');
    for (const s of old) volume.accumulateRecord(rec, {}, s, '2026-10-28');
    today.forEach((s, i) => {
      const before = { weight: rec.maxWeight, e1rm: rec.e1rm };
      volume.accumulateRecord(rec, {}, s, DATE);
      const moved = rec.maxWeight > before.weight || rec.e1rm > before.e1rm;
      assert.equal(got.has(i), moved, `set ${i} of ${JSON.stringify({ old, today })}`);
    });
  }
});

test('a badged hold is exactly one that lengthens the longest hold in the records list', () => {
  const rand = rng(77);
  const hold = () => ({ duration_sec: 20 + Math.floor(rand() * 5) * 10, weight: 0, completed: true });
  for (let n = 0; n < 200; n++) {
    const old = Array.from({ length: Math.floor(rand() * 3) }, hold);
    const today = Array.from({ length: 1 + Math.floor(rand() * 4) }, hold);
    const plank = (sets) => ({ exercise_id: BENCH, exercise_name: 'Plank', set_type: 'time', sets });
    const got = prFlags({ date: DATE, exercises: [plank(today)], history: hist({ date: '2026-10-28', set_type: 'time', sets: old }) })[0] || new Set();
    const rec = volume.newRecord('Plank');
    for (const s of old) volume.accumulateRecord(rec, { set_type: 'time' }, s, '2026-10-28');
    today.forEach((s, i) => {
      const before = rec.maxDuration;
      volume.accumulateRecord(rec, { set_type: 'time' }, s, DATE);
      assert.equal(got.has(i), rec.maxDuration > before, `hold ${i} of ${JSON.stringify({ old, today })}`);
    });
  }
});

test('the Diary reads the one rule: no rule of its own for the badge, the count or the celebration', () => {
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /from '\.\.\/lib\/pr-sets\.js'/);
  assert.match(diary, /prFlags\(\{ exercises, history: historyByExId, date: \$currentDate, earlier: earlierToday \}\)/);
  assert.match(diary, /earlierToday = earlierWorkouts\(\$todaySessions, \$currentSessionId, \$currentDate\)/);
  assert.match(diary, /celebrationFor\(/);
  assert.doesNotMatch(diary, /1 \+ r \/ 30/, 'no estimated 1RM worked out in the Diary');
  assert.doesNotMatch(diary, /priorMax|priorE1rm|topE1rm|prevBestsByExId/, 'no bests of its own');
  // The summary's count and the cards' badges both come from the same flags.
  assert.match(diary, /prCountToday = Object\.values\(prFlagsByIdx\)/);
  assert.match(diary, /prCount=\{prCountToday\}/);
  assert.match(diary, /prSetIndices=\{prFlagsByIdx\[group\.startIdx\]\}/);
});

test('nothing else in the app decides a set is a PR', () => {
  for (const f of ['../src/components/diary/ExerciseCard.svelte', '../src/components/diary/SupersetCard.svelte', '../src/components/diary/SetRow.svelte', '../src/components/diary/WorkoutSummary.svelte']) {
    const src = read(f);
    assert.doesNotMatch(src, /calc1RM|1 \+ .* \/ 30|topWeight/, f);
  }
});
