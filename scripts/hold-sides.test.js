/**
 * A hold timed per side (issue #143): an Alternating exercise tracked by
 * Time (side plank, single-arm carry, single-leg balance) times the left
 * side, counts a switch down, times the right side, and keeps each.
 *
 * On dev a timed set had one time and the hold timer one clock, so the
 * second side had to be timed by hand. Now:
 * - a set keeps `duration_l_sec` and `duration_r_sec`, and `duration_sec`
 *   is the shorter side, so records (the longest hold tracks the weaker
 *   side), charts, an older app, the watch and an older server read it
 *   unchanged;
 * - a set changed to one time by something that knows only duration_sec
 *   reads as that time, and the sides stay on it untouched;
 * - the hold timer runs lead-in, left, a switch countdown, right; stopping
 *   in each phase writes what was held and ticks only a full set;
 * - the REST API, MCP, Trace, the CSV export and the rest notification
 *   carry the sides; the watch keeps them.
 *
 * The first half runs the pure modules; the second the real server on a
 * scratch database.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const client = await import('../src/lib/workout.js');
const server = await import('../server/lib/volume.js');
const phase = await import('../src/lib/holdPhase.js');
const prSets = await import('../src/lib/pr-sets.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sidePlank = (sets, over = {}) => ({
  uuid: 'ex-sp', exercise_id: 8, exercise_name: 'Side Plank', set_type: 'time', load_type: 'unilateral', sets, ...over,
});

// ── The sides of a set ───────────────────────────────────────────────────

test('client and server agree on a hold\'s sides, and duration_sec is the shorter side', () => {
  const cases = [
    [45, 40], [40, 45], [30, 0], [0, 30], [0, 0], [null, 50], [61.4, 60.6], ['45', '40'],
  ];
  for (const [l, r] of cases) assert.equal(client.sideHoldSec(l, r), server.sideHoldSec(l, r), `${l} / ${r}`);
  assert.equal(client.sideHoldSec(45, 40), 40);
  assert.equal(client.sideHoldSec(30, 0), 30, 'a side not timed yet is not the shorter side');
  assert.equal(client.sideHoldSec(0, 0), 0);

  const sets = [
    { duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 },
    { duration_sec: 40 },                                        // one time
    { duration_sec: 50, duration_l_sec: 45, duration_r_sec: 40 }, // changed to one time by an older app
    { duration_sec: 30, duration_l_sec: 30, duration_r_sec: null }, // left only
    { duration_sec: 0, duration_l_sec: 0, duration_r_sec: 0 },    // split, nothing typed yet
    { duration_l_sec: 45, duration_r_sec: 40 },                   // no duration_sec at all
    null,
  ];
  for (const s of sets) assert.deepEqual(client.holdSides(s), server.holdSides(s), JSON.stringify(s));
  assert.deepEqual(client.holdSides(sets[0]), { l: 45, r: 40 });
  assert.equal(client.holdSides(sets[1]), null);
  assert.equal(client.holdSides(sets[2]), null, 'a newer single time wins over sides it did not know');
  assert.deepEqual(client.holdSides(sets[3]), { l: 30, r: 0 });
  assert.deepEqual(client.holdSides(sets[4]), { l: 0, r: 0 });
  assert.equal(client.holdSides(sets[5]), null);
});

test('records and PR badges read the weaker side, through duration_sec, as for any hold', () => {
  const ex = sidePlank([{ completed: true, weight: 0, duration_sec: 40, duration_l_sec: 55, duration_r_sec: 40 }]);
  const rec = server.newRecord('Side Plank');
  server.accumulateRecord(rec, ex, ex.sets[0], '2026-11-07');
  assert.equal(rec.maxDuration, 40);
  // A PR badge: 40 on the weaker side does not beat an earlier 45 hold,
  // even though the stronger side held 55.
  const bests = prSets.historyBests([{ date: '2026-11-01', set_type: 'time', sets: [{ completed: true, duration_sec: 45 }] }], '2026-11-07');
  assert.equal(bests.duration, 45);
  assert.deepEqual(prSets.prKinds(bests, ex, ex.sets[0]), []);
  assert.deepEqual(prSets.prKinds(bests, ex, { ...ex.sets[0], duration_sec: 46, duration_r_sec: 46 }), ['duration']);
});

// ── The hold timer's phases ──────────────────────────────────────────────

test('a hold per side: lead-in, left, switch countdown, right, and both sides are written', () => {
  const t0 = 1_000_000;
  let s = phase.newHold({ date: '2026-11-07', sides: true, targetL: 45, targetR: 40, targetSec: 40 }, t0);
  assert.deepEqual([s.side, s.targetSec, s.goAt], ['L', 45, t0 + phase.LEAD_IN_MS]);
  assert.deepEqual(phase.holdPhase(s, t0 + 500), { side: 'L', leadIn: 3, elapsed: 0, switching: false, leftSec: null });
  assert.equal(phase.switchSide(s, t0 + 500), null, 'no switching out of the lead-in');

  // Left side held 50 s.
  const leftEnd = s.goAt + 50_000;
  assert.equal(phase.holdPhase(s, leftEnd).elapsed, 50);
  s = phase.switchSide(s, leftEnd);
  assert.deepEqual([s.side, s.leftSec, s.targetSec, s.goAt], ['R', 50, 40, leftEnd + phase.LEAD_IN_MS]);
  assert.deepEqual(phase.holdPhase(s, leftEnd + 100), { side: 'R', leadIn: 3, elapsed: 0, switching: true, leftSec: 50 });
  assert.equal(phase.switchSide(s, leftEnd + 5000), null, 'only one switch');

  // A reload mid-switch reads the same phase from what was saved.
  const reloaded = JSON.parse(JSON.stringify(s));
  assert.deepEqual(phase.holdPhase(reloaded, leftEnd + 1200), phase.holdPhase(s, leftEnd + 1200));
  assert.equal(phase.holdPhase(reloaded, leftEnd + 1200).leadIn, 2);

  // Right side held 42 s, then Stop.
  const rightEnd = s.goAt + 42_000;
  const r = phase.stopResult(s, rightEnd);
  assert.deepEqual([r.sideSec, r.elapsedSec, r.held, r.done], [{ l: 50, r: 42 }, 42, true, true]);
  const set = phase.applyHold({ uuid: 'q1', duration_sec: 40, weight: 0, completed: false }, r);
  assert.deepEqual([set.duration_l_sec, set.duration_r_sec, set.duration_sec, set.completed], [50, 42, 42, true]);
  assert.deepEqual(client.holdSides(set), { l: 50, r: 42 });
});

test('stopping in each phase writes what was held, and ticks only a full set', () => {
  const t0 = 2_000_000;
  const start = phase.newHold({ sides: true, targetSec: 30 }, t0);
  // In the lead-in: nothing held, nothing written.
  assert.equal(phase.stopResult(start, t0 + 1000).held, false);
  // During the left side: the left side alone, the set stays open.
  const left = phase.stopResult(start, start.goAt + 20_000);
  assert.deepEqual([left.sideSec, left.done, left.elapsedSec], [{ l: 20, r: null }, false, 20]);
  const openSet = phase.applyHold({ duration_sec: 30, completed: false }, left);
  assert.deepEqual([openSet.duration_l_sec, openSet.duration_r_sec, openSet.duration_sec, openSet.completed], [20, null, 20, false]);
  // In the switch countdown: the left side, set open.
  const sw = phase.switchSide(start, start.goAt + 25_000);
  const inSwitch = phase.stopResult(sw, sw.goAt - 1000);
  assert.deepEqual([inSwitch.sideSec, inSwitch.done], [{ l: 25, r: null }, false]);
  // A left-only stop keeps a right side the set already had.
  const kept = phase.applyHold({ duration_sec: 33, duration_l_sec: 35, duration_r_sec: 33, completed: false }, inSwitch);
  assert.deepEqual([kept.duration_l_sec, kept.duration_r_sec, kept.duration_sec], [25, 33, 25]);
  // Skipping the switch countdown starts the right side at once.
  const skipped = phase.skipCountdown(sw, sw.goAt - 2000);
  assert.equal(phase.holdPhase(skipped, sw.goAt - 2000).switching, false);
  assert.equal(phase.skipCountdown(skipped, sw.goAt), null, 'nothing to skip once counting');
});

test('a single hold is unchanged: one clock, written to duration_sec and ticked', () => {
  const t0 = 3_000_000;
  const s = phase.newHold({ targetSec: 60 }, t0);
  assert.equal(phase.switchSide(s, s.goAt + 5000), null);
  assert.equal(phase.holdPhase(s, s.goAt + 5000).side, null);
  const r = phase.stopResult(s, s.goAt + 65_000);
  assert.deepEqual([r.elapsedSec, r.done, r.sideSec], [65, true, undefined]);
  assert.deepEqual(phase.applyHold({ duration_sec: 60, completed: false }, r), { duration_sec: 65, completed: true });
  // A hold saved by the app before #143 (no `sides`) resumes as a single hold.
  const old = { date: '2026-11-07', targetSec: 60, startedAt: t0, goAt: t0 + 3000 };
  assert.equal(phase.holdPhase(old, t0 + 9000).side, null);
  assert.equal(phase.stopResult(old, t0 + 9000).elapsedSec, 6);
});

// ── Logging and reading ──────────────────────────────────────────────────

test('a done set filling a planned one takes both sides, and one time drops sides it says nothing about', async () => {
  for (const lib of [await import('../src/lib/planned-workout.js'), await import('../server/lib/planned-workout.js')]) {
    const planned = [{ duration_sec: 30, completed: false, weight: 0, reps: 0 }];
    const a = lib.logIntoSets(planned, { duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40, completed: true }, {});
    assert.deepEqual([a.filled, a.sets[0].duration_sec, a.sets[0].duration_l_sec, a.sets[0].duration_r_sec], [true, 40, 45, 40]);
    const split = [{ duration_sec: 30, duration_l_sec: 35, duration_r_sec: 30, completed: false }];
    const b = lib.logIntoSets(split, { duration_sec: 50, completed: true }, {});
    assert.equal(b.sets[0].duration_sec, 50);
    assert.ok(!('duration_l_sec' in b.sets[0]) && !('duration_r_sec' in b.sets[0]));
  }
});

test('CSV export: a hold per side is a row for each side, as split reps are', async () => {
  const { workoutToCsv } = await import('../src/lib/workoutCsv.js');
  const { csv } = workoutToCsv({ date: '2026-11-07', name: 'Core', exercises: [
    sidePlank([{ completed: true, weight: 0, duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 },
      { completed: true, weight: 0, duration_sec: 50, duration_l_sec: 45, duration_r_sec: 40 }]),
  ] }, 'kg');
  const rows = csv.trim().split('\r\n').map(l => l.split(','));
  const head = rows[0];
  const col = (r, name) => r[head.indexOf(name)];
  assert.deepEqual(rows.slice(1).map(r => [col(r, 'set_index'), col(r, 'side'), col(r, 'reps'), col(r, 'duration_sec')]),
    [['1', 'L', '', '45'], ['1', 'R', '', '40'], ['2', '', '', '50']]);
});

test('the Last row, the summary and exercise history show a hold per side as both times', () => {
  assert.equal(client.fmtSetLabel({ set_type: 'time' }, { duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 }), '0:45/0:40');
  assert.equal(client.fmtSetLabel({ set_type: 'time' }, { weight: 10, duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 }), '10×0:45/0:40');
  assert.equal(client.fmtSetLabel({ set_type: 'time' }, { duration_sec: 50, duration_l_sec: 45, duration_r_sec: 40 }), '0:50');
});

test('the rest notification and "last time" show a hold per side as both times', async () => {
  const { nextUp, setWords } = await import('../src/lib/rest-next.js');
  const ex = sidePlank([
    { uuid: 'a', completed: true, duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 },
    { uuid: 'b', completed: false, duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40 },
  ]);
  const next = nextUp([ex], 0);
  assert.deepEqual([next.durationL, next.durationR], [45, 40]);
  assert.equal(setWords(next, { timed: true }), '0:45 / 0:40');
  assert.equal(setWords(ex.sets[0], { timed: true }), '0:45 / 0:40', 'a raw set from history');
  assert.equal(setWords({ duration_sec: 50, duration_l_sec: 45, duration_r_sec: 40 }, { timed: true }), '0:50');
});

test('Trace sees both sides and logs them, with duration_sec the shorter side', () => {
  const lib = new URL('../src/lib/aiTools.js', import.meta.url).href;
  const script = `
    const day = { id: 41, date: '2026-11-07', completed: 0, exercises: [
      { uuid: 'ex-sp', exercise_id: 8, exercise_name: 'Side Plank', set_type: 'time', load_type: 'unilateral', sets: [
        { uuid: 'q1', duration_sec: 40, duration_l_sec: 45, duration_r_sec: 40, completed: true, weight: 0, reps: 0 },
        { uuid: 'q2', duration_sec: 40, completed: false, weight: 0, reps: 0 },
      ] },
    ] };
    const puts = [];
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = async (path, opts = {}) => {
      const p = String(path);
      if (opts.method === 'PUT') { const body = JSON.parse(opts.body); puts.push(body); return { ok: true, headers: { get: () => null }, json: async () => ({ workout: { ...day, ...body } }) }; }
      if (p.startsWith('/api/workout/recent')) return { ok: true, headers: { get: () => null }, json: async () => [day] };
      if (p.startsWith('/api/workout/2026-11-07')) return { ok: true, headers: { get: () => null }, json: async () => ({ workout: day }) };
      if (p.startsWith('/api/exercises')) return { ok: true, headers: { get: () => null }, json: async () => [{ id: 8, name: 'Side Plank', set_type: 'time' }] };
      return { ok: true, headers: { get: () => null }, json: async () => ({}) };
    };
    const { runTool } = await import(${JSON.stringify(lib)});
    const seen = await runTool('get_workout', { id: 41 });
    await runTool('log_set', { workout_id: 41, exercise_name: 'Side Plank', weight: 0, duration_l_sec: 38, duration_r_sec: 44 });
    await runTool('log_workout', { date: '2026-11-08', exercises: [{ name: 'Side Plank', sets: [{ weight: 0, duration_l_sec: 30, duration_r_sec: 35 }] }] });
    process.stdout.write(JSON.stringify({ seen, puts }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const shown = (out.seen.workout || out.seen).exercises[0].sets;
  assert.deepEqual([shown[0].duration_sec, shown[0].duration_l_sec, shown[0].duration_r_sec], [40, 45, 40]);
  assert.ok(!('duration_l_sec' in shown[1]));
  const logged = out.puts[0].exercises[0].sets[1];
  assert.deepEqual([logged.duration_sec, logged.duration_l_sec, logged.duration_r_sec, logged.completed], [38, 38, 44, true]);
  const workout = out.puts[1].exercises.find(e => e.exercise_name === 'Side Plank').sets[0];
  assert.deepEqual([workout.duration_sec, workout.duration_l_sec, workout.duration_r_sec], [30, 30, 35]);
});

// ── The Diary row and the timer ─────────────────────────────────────────

test('the Diary row splits an Alternating hold into L and R times, typed by hand or by the timer', () => {
  const row = read('../src/components/diary/SetRow.svelte');
  assert.match(row, /\$: perSide = timed && loadType === 'unilateral';/);
  assert.match(row, /\$: sides = perSide \? holdSides\(set\) : null;/);
  const split = row.slice(row.indexOf('{:else if isTimeSplit}'), row.indexOf('{:else if timed}'));
  assert.match(split, /commitSideDuration\('duration_l_sec'/);
  assert.match(split, /commitSideDuration\('duration_r_sec'/);
  assert.match(split, /class="split-btn hold-btn tap"/, 'the timer stays in the split field');
  assert.match(split, /on:click=\{toggleTimeSplit\}/);
  // Typing a side keeps duration_sec the shorter side.
  assert.match(row, /dispatch\('update', \{ \.\.\.set, duration_l_sec: l, duration_r_sec: r, duration_sec: sideHoldSec\(l, r\) \}\)/);
  const single = row.slice(row.indexOf('{:else if timed}'), row.indexOf('{:else if distance}'));
  assert.match(single, /\{#if perSide && !holdRunning\}/, 'a single time on an Alternating hold offers the split');
});

test('the card times an Alternating hold per side and applies the result through its normal update', () => {
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.match(card, /const perSide = loadType === 'unilateral';/);
  assert.match(card, /sides: true,/);
  assert.match(card, /updateSet\(target, applyHold\(sets\[target\], r\)\);/);
  const overlay = read('../src/components/diary/HoldTimer.svelte');
  assert.match(overlay, /on:click=\{switchHoldSide\}/);
  assert.match(overlay, /hold_timer\.side_left/);
  assert.match(overlay, /hold_timer\.switch_ready/);
  const store = read('../src/stores/holdTimer.js');
  assert.match(store, /export function switchHoldSide\(\)/);
  assert.match(store, /if \(result\.held\) holdResult\.set\(result\)/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['side_left', 'side_right', 'switch_sides', 'switch_ready', 'skip_switch', 'left_held', 'sides_held', 'left_only_held', 'left_time', 'right_time', 'split_sides', 'merge_sides']) {
    assert.ok(en.hold_timer[k], `hold_timer.${k}`);
  }
});

test('the watch reads the sides and keeps them on what it writes', () => {
  const kt = read('../android/wear/src/main/java/com/lifttrace/app/wear/Session.kt');
  assert.match(kt, /durationLeft = if \(s\.isNull\("duration_l_sec"\)\) null/);
  assert.match(kt, /durationLeft = existing\?\.durationLeft,/);
  // write() puts only what it knows onto the set the server holds.
  const write = kt.slice(kt.indexOf('private fun write('), kt.indexOf('fun applyChange'));
  assert.doesNotMatch(write, /duration_l_sec|remove\(/);
});

// ── The real server ─────────────────────────────────────────────────────

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const opts = { skip: !ready && 'server packages missing' };

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
let proc = null, base = null, dir = null, token = null, apiToken = null;
const ex = {};

async function call(auth, method, path, body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch {
    const line = text.split('\n').filter(l => l.startsWith('data:')).pop();
    try { data = JSON.parse(line.slice(5)); } catch { data = text; }
  }
  return { status: r.status, data };
}
const app = async (method, path, body) => {
  const r = await call(token, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
};
const rest = (method, path, body) => call(apiToken, method, `/api/v1${path}`, body);
let rpc = 0;
async function mcp(name, args) {
  const r = await call(apiToken, 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.result;
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-sides-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'hold-sides-test-0123456789abcdef', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1',
      API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'],
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  token = (await call(null, 'POST', '/api/auth/register', { username: 'core', password: PW, full_name: 'Core Work' })).data.token;
  apiToken = (await app('POST', '/api/admin/api-tokens', { name: 'Hold bridge', scopes: ['mcp:read', 'mcp:write'], password: PW })).raw;
  ex.side = (await app('POST', '/api/exercises', { name: 'Side Plank Hold', set_type: 'time', load_type: 'unilateral' })).id;
});

test.after(async () => {
  if (proc) { const p = proc; proc = null; await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); }); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('REST and MCP log_set take both sides, store duration_sec as the shorter, and read them back', opts, async () => {
  const D = '2026-11-02';
  const a = await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.side, duration_l_sec: 45, duration_r_sec: 40 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual([a.data.logged_set.duration_sec, a.data.logged_set.duration_l_sec, a.data.logged_set.duration_r_sec], [40, 45, 40]);
  const b = await mcp('log_set', { exercise_id: ex.side, duration_l_sec: 50, duration_r_sec: 52, date: D });
  assert.ok(!b.isError, JSON.stringify(b));
  const day = (await rest('GET', `/workouts/${D}`)).data;
  const sets = day.exercises[0].sets;
  assert.deepEqual(sets.map(s => [s.duration_sec, s.duration_l_sec, s.duration_r_sec]), [[40, 45, 40], [50, 50, 52]]);
  const viaMcp = JSON.parse((await mcp('get_workout', { date: D })).content[0].text);
  assert.equal(viaMcp.exercises[0].sets[1].duration_r_sec, 52);

  // Wrong shapes are refused.
  for (const bad of [{ duration_l_sec: 45 }, { duration_l_sec: 45, duration_r_sec: 0 }, { duration_l_sec: 45, duration_r_sec: 40, duration_sec: 45 },
    { duration_l_sec: 45, duration_r_sec: 40, distance_m: 100 }]) {
    const r = await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.side, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const ok = await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.side, duration_l_sec: 30, duration_r_sec: 31, duration_sec: 30 });
  assert.equal(ok.status, 200, 'a matching duration_sec is fine');

  // The record is the weaker side's: 50 (of 50/52), not 52.
  const recs = (await rest('GET', '/records')).data.records;
  assert.equal(recs.find(x => Number(x.exercise_id) === ex.side).maxDuration, 50);
});

test('an older app, watch or server keeps the sides: a tick or edit by spreading, and one time reads as that time', opts, async () => {
  const D = '2026-11-03';
  await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.side, duration_l_sec: 45, duration_r_sec: 40, completed: false });
  const w = (await app('GET', `/api/workout/${D}`)).workout;
  // An app from before #143 ticks the set as it ticks any set: { ...set, completed }.
  const ticked = w.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, completed: true })) }));
  await app('PUT', `/api/workout/${D}`, { ...w, exercises: ticked });
  let back = (await app('GET', `/api/workout/${D}`)).workout.exercises[0].sets[0];
  assert.deepEqual([back.duration_sec, back.duration_l_sec, back.duration_r_sec, back.completed], [40, 45, 40, true]);
  assert.deepEqual(client.holdSides(back), { l: 45, r: 40 });
  // It types a new single time: { ...set, duration_sec }. The sides stay,
  // and every reader shows the newer single time.
  const w2 = (await app('GET', `/api/workout/${D}`)).workout;
  const edited = w2.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, duration_sec: 60 })) }));
  await app('PUT', `/api/workout/${D}`, { ...w2, exercises: edited });
  back = (await app('GET', `/api/workout/${D}`)).workout.exercises[0].sets[0];
  assert.deepEqual([back.duration_sec, back.duration_l_sec, back.duration_r_sec], [60, 45, 40]);
  assert.equal(client.holdSides(back), null);
  const api = (await rest('GET', `/workouts/${D}`)).data.exercises[0].sets[0];
  assert.deepEqual([api.duration_sec, 'duration_l_sec' in api], [60, false]);
});
