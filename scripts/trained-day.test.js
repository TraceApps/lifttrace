/**
 * One rule for a trained day (issue #121), src/lib/trained-day.js.
 *
 * Before it, each place decided on its own: the Diary counted cardio and the
 * server's streak didn't, the Statistics ring counted finished sessions (two
 * workouts on a day counted twice, a day trained without Finish not at all),
 * the weekly summary left warm-ups out while the streak counted them, and
 * the streak alert and rest-day reminder counted a workout opened and never
 * started.
 *
 * Here: the rule itself on the cases that differed; the same cases through
 * the real server's statistics (and android-sync.test.js runs them through
 * the phone's own statistics, standalone); and the places that used to
 * decide for themselves now ask the rule.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rule = await import('../src/lib/trained-day.js');
const { CASES, TODAY, expected } = await import('./fixtures/trained-day-cases.mjs');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const set = (d, extra = {}) => ({ weight: 100, reps: 5, completed: true, ...d, ...extra });
const row = (date, sets, extra = {}) => ({ date, exercises: JSON.stringify([{ exercise_id: 1, exercise_name: 'Squat', sets }]), ...extra });

test('a completed working set makes a trained day; a warm-up, an unticked set or an empty workout does not', () => {
  assert.equal(rule.hasWorkingSet([{ sets: [set({})] }]), true);
  assert.equal(rule.hasWorkingSet([{ sets: [set({ warmup: true })] }]), false, 'warm-up only');
  assert.equal(rule.hasWorkingSet([{ sets: [set({ completed: false })] }]), false, 'not ticked');
  assert.equal(rule.hasWorkingSet([]), false, 'cleared');
  assert.equal(rule.hasWorkingSet(null), false);
  assert.equal(rule.workoutCounts(row('2026-10-01', [set({})], { deleted_at: '2026-10-02 10:00:00' })), false, 'deleted');
  assert.equal(rule.workoutCounts({ date: '2026-10-01', exercises: '{not json' }), false, 'unreadable');
  assert.deepEqual(rule.exercisesOf({ exercises: [{ a: 1 }] }), [{ a: 1 }], 'already read');
});

test('cardio counts only while Track Cardio is on, and two workouts on a day are one day', () => {
  const workouts = [row('2026-10-01', [set({})]), row('2026-10-01', [set({})]), row('2026-10-02', [set({ warmup: true })])];
  const cardio = [{ date: '2026-10-02' }, { date: '2026-10-03' }];
  assert.deepEqual([...rule.trainedDates({ workouts, cardio, cardioOn: false })].sort(), ['2026-10-01']);
  assert.deepEqual([...rule.trainedDates({ workouts, cardio, cardioOn: true })].sort(), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('streaks: back from today, or from yesterday while today is not trained yet', () => {
  const d = new Set(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-14', '2026-10-15']);
  assert.equal(rule.currentStreak(d, '2026-10-15'), 2);
  assert.equal(rule.currentStreak(d, '2026-10-16'), 2, 'today not trained yet');
  assert.equal(rule.currentStreak(d, '2026-10-17'), 0, 'yesterday not trained either');
  assert.equal(rule.longestStreak(d), 3);
  assert.equal(rule.longestStreak(new Set()), 0);
  // Across a month and a year end, on calendar days.
  assert.equal(rule.longestStreak(new Set(['2025-12-30', '2025-12-31', '2026-01-01', '2026-02-28', '2026-03-01'])), 3);
});

test('per week and per weekday count days, Monday-first, as calendar days', () => {
  const d = new Set(['2026-10-12', '2026-10-13', '2026-10-18', '2026-10-19', '2026-11-01']);
  assert.equal(rule.weekStartOf('2026-10-18'), '2026-10-12', 'a Sunday belongs to the week before');
  assert.deepEqual(rule.trainedDaysByWeek(d, '2026-10-01', '2026-10-31'), [{ week: '2026-10-12', count: 3 }, { week: '2026-10-19', count: 1 }]);
  const wd = rule.weekdayCounts(d, null, null);
  assert.equal(wd[1].count, 2, 'Mondays');
  assert.equal(wd[0].count, 2, 'Sundays');
  assert.equal(wd.reduce((n, x) => n + x.count, 0), 5);
  assert.equal(rule.isCalendarDate('2026-02-29'), false);
  assert.equal(rule.isCalendarDate('2028-02-29'), true);
  assert.equal(rule.shiftDate('2026-03-01', -1), '2026-02-28');
});

test('the weekly goal counts trained days against the target', () => {
  const week = { start: '2026-10-12', end: '2026-10-18' };
  const trained = new Set(['2026-10-12', '2026-10-12', '2026-10-14', '2026-10-20']);
  const g = rule.weeklyGoal({ goal: 4, trained, ...week });
  assert.deepEqual(g, { goal: 4, count: 2, excused: 0, target: 4, left: 2, pct: 50, met: false, allExcused: false });
  assert.equal(rule.weeklyGoal({ goal: 2, trained, ...week }).met, true);
  assert.equal(rule.weeklyGoal({ goal: 0, trained, ...week }).met, false, 'no goal, nothing to meet');
});

test('the shared cases give what each case says', () => {
  const r = expected(rule);
  for (const [name, want] of Object.entries(CASES.expect)) {
    assert.deepEqual(r[name], want, name);
  }
});

// ── The real server, on the same cases ─────────────────────────────────────
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const clock = (iso) => `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${Date.parse(iso)} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

test('the server\'s streaks, weekly counts and weekdays follow the rule, cardio on and off', { skip: !ready && 'server packages missing' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-trained-day-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--import', clock(`${TODAY}T12:00:00Z`), 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'trained-day-test-0123456789abcdef012345', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    assert.ok(r.ok, `${method} ${path} ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      if (proc.exitCode != null) throw new Error(`server exited: ${stderr.slice(-500)}`);
      try { up = (await fetch(base + '/api/auth/status')).ok; } catch { /* not up yet */ }
      if (!up) await sleep(200);
    }
    assert.ok(up, `server did not start: ${stderr.slice(-500)}`);
    // Without accounts, as the cases need no one signed in.
    for (const w of CASES.workouts) {
      await call('PUT', `/api/workout/${w.date}`, { ...(w.second ? { new_session: true } : {}), exercises: w.exercises });
    }
    for (const c of CASES.cardio) await call('POST', '/api/cardio', { date: c.date, activity: 'Run', duration_min: 30 });
    for (const cardio of [0, 1]) {
      const want = CASES.expect[cardio ? 'cardioOn' : 'cardioOff'];
      const s = await call('GET', `/api/stats/streaks?cardio=${cardio}`);
      assert.deepEqual({ current: s.currentStreak, longest: s.longestStreak, days: s.totalWorkouts }, want.streaks, `streaks, cardio ${cardio}`);
      assert.equal(s.totalSessions, CASES.expect.sessions, 'workouts with a working set');
      assert.deepEqual(await call('GET', `/api/stats/frequency?start=${CASES.from}&end=${TODAY}&cardio=${cardio}`), want.byWeek, `per week, cardio ${cardio}`);
      const wd = await call('GET', `/api/stats/weekday-distribution?start=${CASES.from}&end=${TODAY}&cardio=${cardio}`);
      assert.deepEqual(wd, want.weekdays, `weekdays, cardio ${cardio}`);
    }
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Nothing decides on its own any more ────────────────────────────────────
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('every place that counts trained days asks the rule', () => {
  const stats = code(read('../server/routes/stats.js'));
  for (const route of ['streaks', 'frequency', 'weekday-distribution']) {
    const at = stats.indexOf(`router.get('/${route}'`);
    assert.match(stats.slice(at, stats.indexOf('}));', at)), /trainedDateSet\(/, `/api/stats/${route}`);
  }
  const sched = code(read('../server/lib/scheduler.js'));
  const streak = sched.slice(sched.indexOf("'notifStreakAlert'"), sched.indexOf("'notifWeeklySummary'"));
  assert.match(streak, /trainedDateSet\(userId\)/, 'streak alert');
  assert.doesNotMatch(streak, /SELECT 1 FROM workout_log/, 'not any workout row');
  const rest = sched.slice(sched.indexOf("'notifRestDay'"), sched.indexOf("'notifStreakAlert'"));
  assert.match(rest, /trainedDateSet\(/, 'rest-day reminder');
  assert.doesNotMatch(rest, /SELECT 1 FROM workout_log/);
  assert.match(code(read('../server/lib/weekly-summary.js')), /trainedDates\(\{[\s\S]*?cardioOn \}\)/, 'weekly summary');
  assert.match(code(read('../server/routes/trainer.js')), /const streak = currentStreak\(trainedDateSet\(memberId\)/, "the coach's view of the streak");

  const page = code(read('../src/routes/Statistics.svelte'));
  assert.match(page, /workoutDates = trainedDates\(\{ workouts: logs, cardio: cardioRows, cardioOn: \$cardioEnabled \}\)/, 'heatmap and sparkline');
  assert.match(page, /weeklyGoal\(\{ goal: \$weeklyWorkoutGoal \|\| 4, trained: workoutDates/, 'the weekly ring counts trained days');
  assert.doesNotMatch(page, /w\.completed &&/, 'not finished sessions');
  assert.match(page, /LtApi\.getStreaks\(\$cardioEnabled\)/);
  assert.match(page, /LtApi\.getFrequency\(startDate, endDate, \$cardioEnabled\)/);
  assert.match(page, /LtApi\.getWeekdayDistribution\(startDate, endDate, \$cardioEnabled\)/);

  const native = read('../src/lib/api-native.js');
  const nstats = code(native.slice(native.indexOf('const Stats = {'), native.indexOf('const AiChat = {')));
  for (const fn of ['streaks', 'frequency', 'weekdayDistribution']) {
    const at = nstats.indexOf(`async ${fn}(`);
    assert.match(nstats.slice(at, nstats.indexOf('\n  },', at)), /Stats\._trained\(cardio\)/, `phone Stats.${fn}`);
  }
  assert.match(code(read('../src/components/ai/Trace.svelte')), /trainedDates\(\{ workouts: recent \|\| \[\], cardio, cardioOn \}\)/, "Trace's recent-activity line");
  assert.match(read('../Dockerfile'), /COPY src\/lib\/trained-day\.js \/src\/lib\/trained-day\.js/, 'the image has the rule where the server imports it');
});

// ── Excused days (issue #121) ───────────────────────────────────────────────
test('an excused day comes off the weekly goal: 4 planned, 1 excused, 3 trained is 3 of 3', () => {
  const week = { start: '2026-10-12', end: '2026-10-18' };
  const trained = new Set(['2026-10-12', '2026-10-14', '2026-10-16']);
  const g = rule.weeklyGoal({ goal: 4, trained, excused: rule.excusedOnly([{ date: '2026-10-13', reason: 'injury' }], trained), ...week });
  assert.deepEqual(g, { goal: 4, count: 3, excused: 1, target: 3, left: 0, pct: 100, met: true, allExcused: false });
});

test('a fully excused week reads as excused, never 0 of 0 or a goal met, and the target never goes below zero', () => {
  const week = { start: '2026-10-12', end: '2026-10-18' };
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  const g = rule.weeklyGoal({ goal: 4, trained: new Set(), excused: new Set(days), ...week });
  assert.equal(g.target, 0, 'not -1');
  assert.equal(g.allExcused, true);
  assert.equal(g.met, false, 'no fake success');
  assert.equal(g.pct, 0);
  assert.equal(g.left, 0);
  assert.equal(g.excused, 5);
  // Excused days outside the week, or a goal of 0, change nothing.
  assert.equal(rule.weeklyGoal({ goal: 4, excused: new Set(['2026-10-19', '2026-10-11']), ...week }).target, 4);
  assert.equal(rule.weeklyGoal({ goal: 0, excused: new Set(days), ...week }).allExcused, false);
});

test('a day trained on counts as trained, whatever its excuse says; removed excuses count for nothing', () => {
  const trained = new Set(['2026-10-13']);
  const rows = [{ date: '2026-10-13', reason: 'illness' }, { date: '2026-10-14', reason: 'other' }, { date: '2026-10-15', reason: 'other', deleted_at: 'x' }];
  assert.deepEqual([...rule.excusedOnly(rows, trained)], ['2026-10-14']);
  const g = rule.weeklyGoal({ goal: 3, trained, excused: new Set(['2026-10-13', '2026-10-14']), start: '2026-10-12', end: '2026-10-18' });
  assert.deepEqual([g.count, g.excused, g.target], [1, 1, 2], 'the trained one is not taken off as well');
  // The streak is unchanged by excuses: an excused day ends it like any day off.
  assert.equal(rule.currentStreak(new Set(['2026-10-15', '2026-10-13']), '2026-10-15'), 1);
});

test('an excuse is one of four reasons, with an optional note of at most 500 characters', () => {
  assert.deepEqual(rule.EXCUSE_REASONS, ['injury', 'illness', 'appointment', 'other']);
  assert.deepEqual(rule.cleanExcuse({ reason: ' Injury ', note: '  sore  ' }), { reason: 'injury', note: 'sore' });
  assert.deepEqual(rule.cleanExcuse({ reason: 'other', note: '' }), { reason: 'other', note: null });
  assert.throws(() => rule.cleanExcuse({ reason: 'tired' }), /reason must be one of/);
  assert.throws(() => rule.cleanExcuse({}), /reason/);
  assert.throws(() => rule.cleanExcuse({ reason: 'other', note: 'x'.repeat(501) }), /at most 500/);
  assert.equal(rule.cleanExcuse({ reason: 'other', note: 'x'.repeat(500) }).note.length, 500);
});

test('every file the server imports from src/lib is in the Docker image', () => {
  const docker = read('../Dockerfile');
  const files = [];
  const walk = (d) => { for (const n of readdirSync(new URL(d, import.meta.url))) { const p = `${d}/${n}`; if (n === 'node_modules') continue; if (statSync(new URL(p, import.meta.url)).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk('../server');
  const missing = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/from '(?:\.\.\/)+src\/lib\/([^']+)'/g)) {
      const covered = docker.includes(`COPY src/lib/${m[1]} /src/lib/${m[1]}`) || [...docker.matchAll(/COPY src\/lib\/([\w-]+)\/ \/src\/lib\//g)].some(c => m[1].startsWith(c[1] + '/'));
      if (!covered) missing.push(`${f}: src/lib/${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'imported by the server but not copied into the image, so the container crashes at start');
});
