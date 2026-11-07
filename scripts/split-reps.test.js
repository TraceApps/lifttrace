/**
 * Split reps count at the weaker side (found in review while building #143).
 *
 * An Alternating exercise (load_type 'unilateral') can log a set's reps per
 * side, reps_l and reps_r. Splitting copied `reps` into both sides and
 * editing a side never touched `reps` again, so a set of L 10 / R 6 split
 * from 12 still read as 12 to records, PR badges, the estimated 1RM,
 * charts, Trace and the API. Now:
 * - every reader of a set's reps reads the weaker side when the set has
 *   sides (setReps, mirrored in src/lib/workout.js and server/lib/volume.js),
 *   which also covers sets saved before this fix;
 * - everything that writes the sides (the Diary row, the planned workout
 *   fill, the watch) keeps `reps` the weaker side, so an older app, watch or
 *   server reading only `reps` reads it right from now on;
 * - merging the sides keeps the weaker side, as a hold per side (#143) does;
 * - volume still counts both sides (reps_l + reps_r).
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
const prSets = await import('../src/lib/pr-sets.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const lunge = (sets, over = {}) => ({
  uuid: 'ex-lu', exercise_id: 9, exercise_name: 'Dumbbell Lunge', load_type: 'unilateral', sets, ...over,
});
// Split from 12, then the sides edited to 10 and 6: `reps` stayed 12 on dev.
const stale = { completed: true, weight: 100, reps: 12, reps_l: 10, reps_r: 6 };

// ── The rule ────────────────────────────────────────────────────────────

test('client and server agree on a set\'s reps: the weaker side when it has sides', () => {
  const sides = [[10, 6], [6, 10], [10, null], [null, 7], [null, null], [0, 8], ['9', '11'], [undefined, undefined]];
  for (const [l, r] of sides) assert.equal(client.sideReps(l, r), server.sideReps(l, r), `${l} / ${r}`);
  assert.equal(client.sideReps(10, 6), 6);
  assert.equal(client.sideReps(10, null), 10, 'a side not given is not the weaker side');
  assert.equal(client.sideReps(0, 8), 0, 'a side typed as 0 is the weaker side');
  assert.equal(client.sideReps(null, null), null);

  const sets = [stale, { reps: 8 }, { reps: 8, reps_l: null, reps_r: null }, { reps: '8' }, {}, null,
    { reps: 12, reps_l: 10 }, { reps_l: 5, reps_r: 7 }];
  for (const s of sets) assert.equal(client.setReps(s), server.setReps(s), JSON.stringify(s));
  assert.equal(client.setReps(stale), 6);
  assert.equal(client.setReps({ reps: 8 }), 8);
  assert.equal(client.setReps({ reps: '8' }), '8', 'a set without sides reads as it always did');
  assert.equal(client.setReps({}), undefined);
});

test('records and the estimated 1RM read the weaker side; volume still counts both', () => {
  const ex = lunge([stale]);
  const rec = server.newRecord('Dumbbell Lunge');
  server.accumulateRecord(rec, ex, stale, '2026-11-07');
  assert.equal(rec.maxReps, 6);
  assert.equal(rec.e1rm, Math.round(100 * (1 + 6 / 30)), 'e1RM of 100 x 6, not 100 x 12');
  assert.equal(server.setVolume(stale, 'unilateral'), 1600);
  assert.equal(client.setVolume(stale, 'unilateral'), 1600);
  // A set with no sides is unchanged.
  const plain = server.newRecord('Bench');
  server.accumulateRecord(plain, {}, { completed: true, weight: 100, reps: 12 }, '2026-11-07');
  assert.deepEqual([plain.maxReps, plain.e1rm], [12, 140]);
});

test('PR badges and the celebration read the weaker side', () => {
  // Best so far: 100 x 8, e1RM 127. Today 100 x L 10 / R 6 is e1RM 120.
  const history = [{ date: '2026-11-01', sets: [{ completed: true, weight: 100, reps: 8 }] }];
  const bests = prSets.historyBests(history, '2026-11-07');
  assert.equal(bests.e1rm, 127);
  const ex = lunge([stale]);
  assert.deepEqual(prSets.prKinds(bests, ex, stale), [], 'the weaker side beats nothing');
  assert.equal(prSets.celebrationFor({ exercises: [ex], exIdx: 0, setIdx: 0, history, date: '2026-11-07' }), null);
  // The stronger side's 10 is not a PR either; both sides at 10 are.
  const both = { ...stale, reps_r: 10 };
  assert.deepEqual(prSets.prKinds(bests, ex, both), ['e1rm']);
  // An earlier split day counts at its weaker side.
  const b2 = prSets.historyBests([{ date: '2026-11-01', sets: [stale] }], '2026-11-07');
  assert.equal(b2.e1rm, 120);
});

test('labels show both sides: the Last row, the summary, the share card, the coach\'s view', () => {
  assert.equal(client.fmtSetLabel(lunge([]), stale), '100×10/6');
  assert.equal(client.fmtSetLabel(lunge([]), { weight: 100, reps: 12 }), '100×12');
  assert.equal(client.fmtSetLabel(lunge([]), { weight: 0, reps: 0, reps_l: 8, reps_r: null }), '0×8/0');
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.doesNotMatch(card, /\{s\.weight \|\| 0\}×\{s\.reps \|\| 0\}/, 'the Last row goes through fmtSetLabel');
  const coaching = read('../src/routes/Coaching.svelte');
  assert.match(coaching, /× \{repsLabel\(s\)\}/);
});

// ── Writing ─────────────────────────────────────────────────────────────

test('the Diary row keeps reps the weaker side as the sides are typed, and merging keeps the weaker side', () => {
  const row = read('../src/components/diary/SetRow.svelte');
  const toggle = row.slice(row.indexOf('function toggleSplit()'), row.indexOf('function toggleTimeSplit()'));
  assert.doesNotMatch(toggle, /Math\.max/, 'merging no longer keeps the higher side');
  assert.match(toggle, /reps: sideReps\(set\.reps_l, set\.reps_r\) \?\? 0, reps_l: null, reps_r: null/);
  const commit = row.slice(row.indexOf('function commitSideReps('), row.indexOf('function commitSideReps(') + 600);
  assert.match(commit, /if \(n === set\[field\]\) return;/, 'focusing and leaving a side writes nothing');
  assert.match(commit, /const reps = sideReps\(l, r\) \?\? 0;[\s\S]*\{ \.\.\.set, reps_l: l, reps_r: r, reps \}/);
  // A set with sides shown as one count reads as the weaker side, and a
  // count typed over it replaces the sides.
  assert.match(row, /let repsStr = _fmt\(setReps\(set\)\);/);
  const single = row.slice(row.indexOf('function commitReps('), row.indexOf('function commitReps(') + 500);
  assert.match(single, /\{ \.\.\.set, reps: n, reps_l: null, reps_r: null \}/);
  assert.match(row, /on:input=\{\(\) => commitSideReps\('reps_l', repsLStr\)\}/);
  assert.match(row, /on:blur=\{\(\) => \{ repsRFocused = false; commitSideReps\('reps_r', repsRStr\); \}\}/);
  assert.doesNotMatch(row, /commitNumber\('reps_[lr]'/);
});

test('a planned set with a left/right target plans reps as the weaker side, and history fills from it', async () => {
  for (const lib of [await import('../src/lib/planned-workout.js'), await import('../server/lib/planned-workout.js')]) {
    const tpl = { exercise_id: 9, exercise_name: 'Dumbbell Lunge', set_specs: [{ reps: 10, reps_l: 10, reps_r: 8, weight: 40 }] };
    const [ex] = lib.buildPlannedExercises([tpl], { lastSets: () => null });
    assert.deepEqual([ex.sets[0].reps, ex.sets[0].reps_l, ex.sets[0].reps_r], [8, 10, 8]);
    // A spec without reps fills them from last time's set, at its weaker side.
    const tpl2 = { exercise_id: 9, exercise_name: 'Dumbbell Lunge', set_specs: [{ weight: 40 }] };
    const [ex2] = lib.buildPlannedExercises([tpl2], { lastSets: () => [stale] });
    assert.equal(ex2.sets[0].reps, 6);
    // A uniform target fills from last time's sets the same way.
    const tpl3 = { exercise_id: 9, exercise_name: 'Dumbbell Lunge', target_sets: 2, target_reps: 12 };
    const [ex3] = lib.buildPlannedExercises([tpl3], { lastSets: () => [stale] });
    assert.deepEqual(ex3.sets.map(s => s.reps), [6, 6]);
  }
});

test('Trace and the Android app\'s own records read the weaker side', () => {
  const lib = new URL('../src/lib/aiTools.js', import.meta.url).href;
  const script = `
    const day = { id: 41, date: '2026-11-07', completed: 0, exercises: [
      { uuid: 'ex-lu', exercise_id: 9, exercise_name: 'Dumbbell Lunge', load_type: 'unilateral', sets: [
        { uuid: 'q1', weight: 100, reps: 12, reps_l: 10, reps_r: 6, completed: true },
        { uuid: 'q2', weight: 90, reps: 8, completed: true },
      ] },
    ] };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = async (path) => {
      const p = String(path);
      if (p.startsWith('/api/workout/recent')) return { ok: true, headers: { get: () => null }, json: async () => [day] };
      if (p.startsWith('/api/workout/2026-11-07')) return { ok: true, headers: { get: () => null }, json: async () => ({ workout: day }) };
      return { ok: true, headers: { get: () => null }, json: async () => ({}) };
    };
    const { runTool } = await import(${JSON.stringify(lib)});
    process.stdout.write(JSON.stringify(await runTool('get_workout', { id: 41 })));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const ex = (out.workout || out).exercises[0];
  assert.deepEqual([ex.sets[0].reps, ex.sets[0].reps_l, ex.sets[0].reps_r], [6, 10, 6]);
  assert.ok(!('reps_l' in ex.sets[1]));
  assert.deepEqual(ex.top_set, { weight: 100, reps: 6 });

  const native = read('../src/lib/api-native.js');
  const recs = native.slice(native.indexOf('Mirror of accumulateRecord'), native.indexOf('async progressFor('));
  assert.match(recs, /const reps = Number\(setReps\(s\)\) \|\| 0;/);
});

test('the watch writes reps as the weaker side and picks its best set by it', () => {
  const kt = read('../android/wear/src/main/java/com/lifttrace/app/wear/Session.kt');
  const write = kt.slice(kt.indexOf('private fun write('), kt.indexOf('fun applyChange'));
  assert.match(write, /s\.put\("reps", change\.countedReps\)/);
  assert.match(kt, /done\.maxWithOrNull\(compareBy\(\{ it\.weight \}, \{ it\.countedReps \}\)\)/);
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
let proc = null, base = null, dir = null, token = null, apiToken = null, lungeId = null;

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
  dir = mkdtempSync(join(tmpdir(), 'lt-split-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'split-reps-test-0123456789abcdef', INSECURE_COOKIES: '1',
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
  token = (await call(null, 'POST', '/api/auth/register', { username: 'legs', password: PW, full_name: 'Leg Day' })).data.token;
  apiToken = (await app('POST', '/api/admin/api-tokens', { name: 'Split bridge', scopes: ['mcp:read', 'mcp:write'], password: PW })).raw;
  lungeId = (await app('POST', '/api/exercises', { name: 'Split Lunge Test', load_type: 'unilateral' })).id;
});

test.after(async () => {
  if (proc) { const p = proc; proc = null; await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); }); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a set saved with a stale reps (an older app, or before this fix) counts at its weaker side everywhere the server reads it', opts, async () => {
  const D = '2026-11-04';
  // Exactly what an app before this fix saves after splitting 12 and typing 10 and 6.
  await app('PUT', `/api/workout/${D}`, {
    name: 'Legs', exercises: [{ uuid: 'e1', exercise_id: lungeId, exercise_name: 'Split Lunge Test', load_type: 'unilateral',
      sets: [{ uuid: 's1', ...stale }] }],
  });
  const e1rm = Math.round(100 * (1 + 6 / 30));
  const viaApp = (await app('GET', '/api/stats/records')).find(r => Number(r.exerciseId ?? r.exercise_id) === lungeId);
  assert.deepEqual([viaApp.maxReps, viaApp.e1rm], [6, e1rm]);
  const viaRest = (await rest('GET', '/records')).data.records.find(r => Number(r.exercise_id) === lungeId);
  assert.deepEqual([viaRest.maxReps, viaRest.e1rm], [6, e1rm]);
  const viaMcp = JSON.parse((await mcp('get_records', {})).content[0].text).records.find(r => Number(r.exercise_id) === lungeId);
  assert.deepEqual([viaMcp.maxReps, viaMcp.e1rm], [6, e1rm]);

  const day = (await rest('GET', `/workouts/${D}`)).data.exercises[0].sets[0];
  assert.deepEqual([day.reps, day.reps_l, day.reps_r], [6, 10, 6]);
  const range = JSON.parse((await mcp('get_workouts', { start: D, end: D })).content[0].text).workouts[0].exercises[0].sets[0];
  assert.deepEqual([range.reps, range.reps_l, range.reps_r], [6, 10, 6]);
  // The stored set is left as it was: nothing rewrites history.
  const stored = (await app('GET', `/api/workout/${D}`)).workout.exercises[0].sets[0];
  assert.equal(stored.reps, 12);
});
