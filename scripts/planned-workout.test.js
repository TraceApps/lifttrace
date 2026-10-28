/**
 * planned-workout.js (issue #140): the one rule for planning a program's
 * workout day and for logging a done set into it, in two identical copies,
 * src/lib (the Diary, Trace, the Android app) and server/lib
 * (start_program_workout and log_set over MCP and /api/v1).
 *
 * - The two copies are the same file and give the same answers.
 * - The Diary's Load Workout plans every day exactly as it did before the
 *   move (fixtures/diary-load-template-before-140.mjs is the old code), over
 *   a few thousand generated days.
 * - The server reads the same settings the app has, with the same defaults.
 * - logIntoSets fills the next planned set still to do, of the same kind,
 *   and adds a set when none is left.
 * program-workout-api.test.js runs the server side end to end.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const client = await import('../src/lib/planned-workout.js');
const server = await import('../server/lib/planned-workout.js');
const { diaryLoadTemplateBefore140 } = await import('./fixtures/diary-load-template-before-140.mjs');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the two copies are the same file', () => {
  assert.equal(read('../src/lib/planned-workout.js'), read('../server/lib/planned-workout.js'));
});

test('the moved helpers are still where every caller imports them from', async () => {
  const workout = await import('../src/lib/workout.js');
  assert.equal(workout.parseDuration, client.parseDuration);
  assert.equal(workout.generateWarmupSets, client.generateWarmupSets);
  assert.equal(workout.lastCompletedSession, client.lastCompletedSession);
});

test('the defaults are the app\'s own defaults for those settings', () => {
  const settings = read('../src/stores/settings.js');
  const def = (key) => {
    const m = settings.match(new RegExp(`createSettingStore\\('${key}',\\s*([^)]+)\\)`));
    return JSON.parse(m[1].trim().replace(/'/g, '"'));
  };
  for (const key of ['autoFillLastWeights', 'autoGenerateWarmups', 'weightUnit']) {
    assert.equal(def(key), client.PLAN_SETTING_DEFAULTS[key], key);
  }
  // And each is synced to the server, where start_program_workout reads it.
  const synced = settings.slice(settings.indexOf('const SERVER_SETTINGS'), settings.indexOf(']);'));
  for (const key of ['autoFillLastWeights', 'autoGenerateWarmups', 'weightUnit']) assert.match(synced, new RegExp(`'${key}'`));
});

test('the Diary, Trace and the server plan through it', () => {
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /import \{ buildPlannedExercises \} from '\.\.\/lib\/planned-workout\.js';/);
  const load = diary.slice(diary.indexOf('async function loadTemplate('), diary.indexOf('// ── Load from prescription'));
  assert.match(load, /const withWarmups = buildPlannedExercises\(exs, \{\s*planWeek,\s*lastSets: \(ex, i\) => lastAll\[i\],\s*autoWarmups: \$autoGenerateWarmups,\s*weightUnit: \$weightUnit,\s*\}\);/);
  assert.match(load, /exercises: withFreshIds\(withWarmups\),/);
  assert.doesNotMatch(diary, /function resolveWeek\(/, 'no second copy in the Diary');
  const tools = read('../src/lib/aiTools.js');
  const start = tools.slice(tools.indexOf('async function _startWorkoutFromTemplate('), tools.indexOf('async function _setActiveProgram('));
  assert.match(start, /const tplExs = withFreshIds\(await _plannedExercises\(tpl\.exercises, \{ planWeek, date: d \}\)\);/);
  assert.match(tools, /return buildPlannedExercises\(exs, \{/);
  const logSet = tools.slice(tools.indexOf('async function _logSet('), tools.indexOf('async function _logBodyStat('));
  assert.match(logSet, /logIntoSets\(exs\[idx\]\.sets, \{/);
  const srv = read('../server/lib/mcp/tools/start-program-workout.js');
  assert.match(srv, /buildPlannedExercises\(tplExercises, \{/);
  assert.match(read('../server/lib/mcp/tools/log-set.js'), /logIntoSets\(target\.sets, sent, newSet, \{ at: new Date\(\)\.toISOString\(\) \}\)/);
});

// ── The Diary plans as before ───────────────────────────────────────────

// A small seeded generator, so a failure names a case that comes back.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function genDay(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const maybe = (v, p = 0.5) => (r() < p ? v : undefined);
  const num = () => pick(['', '0', '5', '20', '42.5', '100', 'Body', '2x35', 7, 60, null, undefined]);
  const dur = () => pick(['', '0:30', '45', '130', '1m', 'abc', null, undefined, 90]);
  const exercises = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => {
    const timed = r() < 0.3;
    const ex = {
      uuid: `t-${i}`, exercise_id: maybe(1 + Math.floor(r() * 6), 0.9), exercise_name: `Ex ${i}`,
      ...(timed ? { set_type: 'time' } : maybe({ set_type: 'reps' }, 0.2) || {}),
      target_sets: pick([undefined, 0, 1, 3, 5, '4']), target_reps: maybe(num()), target_weight: maybe(num()),
      target_duration: maybe(dur()), tempo: maybe('3-1-1'), rest_sec: maybe(pick([60, 90])),
      notes: maybe('keep tight'), superset_id: maybe(1, 0.2),
    };
    if (r() < 0.4) {
      ex.weeks = Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.2 ? null : {
        sets: maybe(pick([2, 3, 4])), reps: maybe(num()), weight: maybe(num()), duration: maybe(dur()), tempo: maybe('2-0-2'), rest_sec: maybe(120),
      })).map(w => w || undefined);
    }
    if (r() < 0.35) {
      ex.set_specs = Array.from({ length: Math.floor(r() * 5) }, () => ({
        weight: maybe(num()), reps: maybe(num()), duration: maybe(dur()), warmup: maybe(true, 0.3), rpe: maybe(pick([7, 8.5, null]), 0.3),
        reps_l: maybe(pick(['5', 6]), 0.15), reps_r: maybe(pick(['5', 'x']), 0.15), number: maybe(pick([1, 2]), 0.2),
      }));
    }
    return ex;
  });
  // Last session's completed sets per exercise id, warm-ups included.
  const last = {};
  for (let id = 1; id <= 6; id++) {
    if (r() < 0.4) continue;
    last[id] = Array.from({ length: Math.floor(r() * 5) }, () => ({
      weight: maybe(pick([0, 20, 45, 60, 102.5, 135])), reps: maybe(pick([0, 5, 8, 12])), duration_sec: maybe(pick([20, 45, 60]), 0.3),
      warmup: maybe(true, 0.3), completed: true,
    }));
  }
  return {
    template: { exercises },
    planWeek: pick([null, null, 1, 2, 3, 5]),
    last,
    autoGenerateWarmups: r() < 0.5,
    weightUnit: pick(['lbs', 'kg']),
  };
}

test('the Diary plans every day exactly as it did before the move', async () => {
  const r = rng(140);
  for (let n = 0; n < 3000; n++) {
    const c = genDay(r);
    const getLastSets = async (id) => (id ? (c.last[id] ?? null) : null);
    const before = await diaryLoadTemplateBefore140(c.template, { planWeek: c.planWeek, getLastSets, autoGenerateWarmups: c.autoGenerateWarmups, weightUnit: c.weightUnit });
    // The Diary now: last sessions first, then the shared planner.
    const exs = c.template.exercises || [];
    const lastAll = await Promise.all(exs.map(ex => getLastSets(ex.exercise_id, { withWarmups: true })));
    for (const lib of [client, server]) {
      const now = lib.buildPlannedExercises(exs, { planWeek: c.planWeek, lastSets: (ex, i) => lastAll[i], autoWarmups: c.autoGenerateWarmups, weightUnit: c.weightUnit });
      assert.deepEqual(now, before, `case ${n}: ${JSON.stringify(c).slice(0, 400)}`);
    }
  }
});

test('planning: the week wins inside a block, history otherwise, timed sets and warm-ups', () => {
  for (const lib of [client, server]) {
    const hold = { exercise_id: 1, set_type: 'time', target_sets: 3, target_duration: '0:30', weeks: [{ duration: '0:30' }, { sets: 2, duration: '0:40' }] };
    const dips = { exercise_id: 2, target_sets: 2, target_reps: '8', target_weight: '50' };
    const last = { 1: [{ duration_sec: 35, completed: true }], 2: [{ weight: 30, reps: 5, completed: true, warmup: true }, { weight: 60, reps: 8, completed: true }] };
    const plan = (planWeek, autoWarmups = false, weightUnit = 'lbs') =>
      lib.buildPlannedExercises([hold, dips], { planWeek, lastSets: (ex) => last[ex.exercise_id] || null, autoWarmups, weightUnit });
    const [h2, d2] = plan(2);
    assert.deepEqual(h2.sets.map(s => s.duration_sec), [40, 40], "week 2's plan wins over last time's 35 s");
    assert.deepEqual(d2.sets.map(s => [s.weight, s.reps]), [[60, 8], [60, 8]], 'no weeks matrix: last session wins');
    const [hNone] = plan(null);
    assert.deepEqual(hNone.sets.map(s => s.duration_sec), [35, 35, 35], 'outside the program: last time');
    const [hw, dw] = plan(null, true, 'kg');
    assert.ok(!hw.sets.some(s => s.warmup), 'never a ramp before a hold');
    assert.deepEqual(dw.sets.filter(s => s.warmup).map(s => s.weight), [20, 30, 42.5, 50]);
    assert.ok(dw.sets.every(s => s.completed === false));
    assert.deepEqual(lib.buildPlannedExercises(null), []);
  }
});

// ── Logging a done set into planned ones ────────────────────────────────

test('a done set fills the first planned set still to do, of its own kind, keeping what it doesn\'t send', () => {
  for (const lib of [client, server]) {
    const sets = [
      { uuid: 'w', weight: 20, reps: 10, completed: false, warmup: true, notes: '' },
      { uuid: 'a', weight: 60, reps: 8, completed: true, notes: '' },
      { uuid: 'b', weight: 60, reps: 8, completed: false, notes: '', rpe: 8, reps_l: 4, reps_r: 4, number: 2 },
      { uuid: 'c', weight: 60, reps: 8, completed: false, notes: '' },
    ];
    const added = { uuid: 'new', weight: 0, reps: 5, completed: true, warmup: false, rpe: null };
    const working = lib.logIntoSets(sets, { reps: 6, warmup: false, completed: true }, added);
    assert.deepEqual([working.index, working.filled], [2, true]);
    assert.deepEqual(working.sets[2], { uuid: 'b', weight: 60, reps: 6, completed: true, notes: '', rpe: 8, number: 2 }, 'planned weight, RPE and round kept; the L/R target goes');
    assert.equal(sets[2].completed, false, 'the sets given are not changed');
    const warm = lib.logIntoSets(sets, { reps: 10, weight: 25, warmup: true }, added);
    assert.deepEqual([warm.index, warm.sets[0].weight, warm.sets[0].completed], [0, 25, true]);
    const held = lib.logIntoSets([{ uuid: 'h', weight: 0, reps: 0, duration_sec: 30, completed: false }], { duration_sec: 33, weight: 10, rpe: 9 }, added);
    assert.deepEqual(held.sets[0], { uuid: 'h', weight: 10, reps: 0, duration_sec: 33, completed: true, rpe: 9 }, 'the hold logged replaces the one planned');
  }
});

test('nothing left to do, a set sent as not done, or no sets: added, as before', () => {
  for (const lib of [client, server]) {
    const added = { uuid: 'new', weight: 0, reps: 5, completed: true, warmup: false, rpe: null };
    const done = [{ uuid: 'a', reps: 5, weight: 0, completed: true }];
    assert.deepEqual(lib.logIntoSets(done, { reps: 5 }, added), { sets: [...done, added], index: 1, filled: false });
    const todo = [{ uuid: 'a', reps: 5, weight: 0, completed: false }];
    const notDone = { ...added, completed: false };
    assert.deepEqual(lib.logIntoSets(todo, { reps: 5, completed: false }, notDone), { sets: [...todo, notDone], index: 1, filled: false });
    assert.deepEqual(lib.logIntoSets(undefined, { reps: 5 }, added), { sets: [added], index: 0, filled: false });
    assert.deepEqual(lib.logIntoSets([{ uuid: 'w', completed: false, warmup: true }], { reps: 5 }, added).filled, false, 'a working set never fills a warm-up');
  }
});

test('a filled set keeps when it was done, so a copy saved from before it can\'t untick it', async () => {
  const { mergeExercises } = await import('../server/lib/workout-merge.js');
  for (const lib of [client, server]) {
    const planned = [{ uuid: 's1', weight: 0, reps: 0, duration_sec: 30, completed: false }, { uuid: 's2', weight: 0, reps: 0, duration_sec: 30, completed: false }];
    const at = '2026-10-28T08:00:00.000Z';
    const { sets } = lib.logIntoSets(planned, { duration_sec: 31 }, { uuid: 'x' }, { at });
    assert.equal(sets[0].completedAt, at);
    const server = [{ uuid: 'e', exercise_id: 1, sets }];
    // An older app's save of its copy from before the fill, ticking s2.
    const stale = [{ uuid: 'e', exercise_id: 1, sets: [planned[0], { ...planned[1], duration_sec: 27, completed: true }] }];
    const merged = mergeExercises(server, stale, [], [], {}, {}).merged[0].sets;
    assert.deepEqual(merged.map(x => [x.uuid, x.duration_sec, x.completed]), [['s1', 31, true], ['s2', 27, true]]);
    // A copy loaded after it carries the time along, and its own edit stays.
    const later = [{ uuid: 'e', exercise_id: 1, sets: [{ ...sets[0], duration_sec: 33 }, sets[1]] }];
    assert.equal(mergeExercises(server, later, [], [], {}, {}).merged[0].sets[0].duration_sec, 33);
  }
});
