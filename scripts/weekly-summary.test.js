/**
 * Weekly summary (issue #98): the numbers behind the email and the push.
 * buildWeeklySummary is pure, so these run the real thing on sample weeks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { buildWeeklySummary, summaryLine, changeVsAvg, shiftDate, fmtMinutes } =
  await import('../server/lib/weekly-summary.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const TODAY = '2026-09-20'; // the week is 09-14 .. 09-20
const library = new Map([
  [1, { muscles: ['Chest'], category: 'strength', load_type: null }],
  [2, { muscles: ['Quadriceps', 'Glutes'], category: 'strength', load_type: null }],
  [3, { muscles: ['Abdominals'], category: 'strength', load_type: null }],
  [4, { muscles: [], category: 'strength', load_type: 'unilateral' }],
]);
const bench = (weight, reps = 5, extra = {}) => ({ weight, reps, completed: true, ...extra });
const w = (date, exercises, duration_min = null) => ({ date, duration_min, exercises: JSON.stringify(exercises) });
const ex = (id, name, sets, extra = {}) => ({ exercise_id: id, exercise_name: name, sets, ...extra });

test('the week is the last seven local dates, today included', () => {
  const s = buildWeeklySummary({ workouts: [], today: TODAY });
  assert.equal(s.start, '2026-09-14');
  assert.equal(s.end, '2026-09-20');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});

test('sessions, sets, volume and time count only completed working sets', () => {
  const s = buildWeeklySummary({
    library, today: TODAY, goal: 5,
    workouts: [
      w('2026-09-14', [ex(1, 'Bench Press', [bench(100), bench(100), bench(60, 10, { warmup: true }), bench(100, 5, { completed: false })])], 60),
      w('2026-09-16', [ex(2, 'Squat', [bench(140), bench(140)])], 45),
      w('2026-09-17', [ex(1, 'Bench Press', [bench(100, 5, { completed: false })])]), // opened, never trained
      w('2026-09-13', [ex(1, 'Bench Press', [bench(100)])]),                         // the day before the week
      w('2026-09-21', [ex(1, 'Bench Press', [bench(100)])]),                         // tomorrow, planned
    ],
  });
  assert.equal(s.week.sessions, 2, 'a workout with no completed set is not a session');
  assert.equal(s.week.sets, 4, 'warm-ups and unticked sets do not count');
  assert.equal(s.week.volume, 100 * 5 * 2 + 140 * 5 * 2);
  assert.equal(s.week.minutes, 105);
  assert.equal(s.goal, 5);
});

test('the comparison is the average week over the 28 days before', () => {
  const prior = [];
  // Four weeks before the week: 3 sessions each of 3 sets of 100x5.
  for (let d = 1; d <= 28; d++) {
    if (d % 7 === 1 || d % 7 === 3 || d % 7 === 5) {
      prior.push(w(shiftDate('2026-09-14', -d), [ex(1, 'Bench Press', [bench(100), bench(100), bench(100)])], 50));
    }
  }
  prior.push(w('2026-08-01', [ex(1, 'Bench Press', [bench(100)])])); // older than 28 days: ignored
  const s = buildWeeklySummary({
    library, today: TODAY,
    workouts: [...prior, w('2026-09-15', [ex(1, 'Bench Press', [bench(100), bench(100), bench(100), bench(100)])], 60)],
  });
  assert.equal(s.hasBaseline, true);
  assert.equal(s.avg.sessions, 3);
  assert.equal(s.avg.sets, 9);
  assert.equal(s.avg.volume, 4500);
  assert.equal(changeVsAvg(s.week.sets, s.avg.sets), Math.round((4 - 9) / 9 * 100));
  assert.equal(changeVsAvg(5, 0), null, 'nothing to compare against');
});

test('PRs are new bests on lifts trained before, including holds', () => {
  const s = buildWeeklySummary({
    library, today: TODAY,
    workouts: [
      w('2026-09-01', [ex(1, 'Bench Press', [bench(100)]), ex(3, 'Plank', [{ duration_sec: 60, completed: true }], { set_type: 'time' })]),
      w('2026-09-02', [ex(2, 'Squat', [bench(150)])]),
      w('2026-09-15', [
        ex(1, 'Bench Press', [bench(105, 3)]),                                          // new best
        ex(2, 'Squat', [bench(150)]),                                                  // tie: not a PR
        ex(3, 'Plank', [{ duration_sec: 75, completed: true }], { set_type: 'time' }), // longer hold
        ex(4, 'Lunge', [bench(40)]),                                                   // first time: not a PR
      ]),
    ],
  });
  assert.deepEqual(s.prs.map(p => p.name), ['Bench Press', 'Plank']);
  assert.deepEqual(s.prs.find(p => p.name === 'Bench Press'), { name: 'Bench Press', weight: 105, reps: 3 });
  assert.equal(s.prs.find(p => p.name === 'Plank').durationSec, 75);
});

test('sets per muscle group, most trained first, timed and bodyweight sets included', () => {
  const s = buildWeeklySummary({
    library, today: TODAY,
    workouts: [w('2026-09-16', [
      ex(2, 'Squat', [bench(140), bench(140), bench(140)]),
      ex(1, 'Push Up', [bench(0, 20)]),
      ex(3, 'Plank', [{ duration_sec: 60, completed: true }], { set_type: 'time' }),
    ])],
  });
  assert.deepEqual(s.muscles, [
    { muscle: 'glutes', sets: 3 }, { muscle: 'quads', sets: 3 },
    { muscle: 'chest', sets: 1 }, { muscle: 'core', sets: 1 },
  ]);
});

test('unilateral volume follows the load type, like Statistics', () => {
  const s = buildWeeklySummary({ library, today: TODAY, workouts: [w('2026-09-16', [ex(4, 'Lunge', [bench(40, 10)])])] });
  assert.equal(s.week.volume, 40 * 10 * 2);
});

test('the push line has the goal, sets, PRs and volume with its unit', () => {
  const s = buildWeeklySummary({
    library, today: TODAY, goal: 4,
    workouts: [
      w('2026-09-01', [ex(1, 'Bench Press', [bench(100)])]),
      w('2026-09-15', [ex(1, 'Bench Press', [bench(105), bench(100)])]),
    ],
  });
  const line = summaryLine(s, { unit: 'kg', locale: 'en' });
  assert.match(line, /^1 of 4 sessions, 2 sets, 1 PR, 1,025 kg volume \([+-]\d+% vs your 4-week average\)\.$/);
  assert.equal(summaryLine(buildWeeklySummary({ today: TODAY, workouts: [] })), 'No workouts logged this week.');
  assert.match(summaryLine(s, { unit: 'kg', locale: 'de' }), /1\.025 kg/, 'numbers follow the language setting');
});

test('time trained reads as hours and minutes', () => {
  assert.equal(fmtMinutes(250), '4h 10m');
  assert.equal(fmtMinutes(45), '45m');
  assert.equal(fmtMinutes(0), '');
});

test('the scheduler uses the user\'s own weekday and the shared summary', () => {
  const src = read('../server/lib/scheduler.js');
  assert.match(src, /_localWeekday\(tz\) === targetDay/);
  assert.doesNotMatch(src, /new Date\(\)\.getDay\(\) === targetDay|const currentDay = new Date\(\)\.getDay\(\)/);
  assert.match(src, /buildWeeklySummary\(/);
  assert.match(src, /summaryLine\(summary/);
  assert.doesNotMatch(src, /prCount/, 'the PR count is no longer a stub');
});

test('the email links back to that week in Statistics', () => {
  assert.match(read('../server/email.js'), /\/#\/statistics\?range=1W/);
  assert.match(read('../src/routes/Statistics.svelte'), /get\('range'\)/);
});
