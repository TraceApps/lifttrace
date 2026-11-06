/**
 * Distance and calorie sets (issue #119): rower, SkiErg, sled, carries and
 * runs logged by distance, air bikes by the calories the machine shows.
 *
 * On dev "Tracked By" offered only Reps and Time, so a 500 m row or a
 * 20 cal bike had to be logged as fake reps. Now:
 * - a set stores `distance_m` (meters) or `calories`; an exercise entry's
 *   `set_type` is 'distance' or 'calories', and a distance entry carries the
 *   unit it is shown in (`distance_unit`: m, km, yd or mi);
 * - neither kind has weight x reps volume or an estimated 1RM; each has its
 *   own record (longest distance, most calories, the load breaking a tie);
 * - built-ins that are naturally distance or calorie based start that way,
 *   but only for an exercise never logged before: history logged with reps
 *   keeps its reps;
 * - the REST API, MCP, webhooks, CSV export and the Hevy and FitNotes
 *   importers carry them.
 *
 * The first half runs the pure modules; the second the real server on a
 * scratch database, with a local webhook receiver.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const client = await import('../src/lib/workout.js');
const server = await import('../server/lib/volume.js');
const prSets = await import('../src/lib/pr-sets.js');
const planned = await import('../src/lib/planned-workout.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── What kind a set is ───────────────────────────────────────────────────

test('client and server agree on the kind of every set', () => {
  const cases = [
    [{}, { reps: 5, weight: 100 }],
    [{}, { distance_m: 500 }],
    [{}, { calories: 20 }],
    [{}, { duration_sec: 60, distance_m: 5000 }],   // a timed run read as before
    [{ set_type: 'distance' }, { reps: 10 }],        // flipped to distance, reps left over
    [{ set_type: 'calories' }, { distance_m: 400 }],
    [{ set_type: 'reps' }, { distance_m: 400 }],
    [{ set_type: 'bogus' }, { calories: 12 }],
    [null, null],
  ];
  for (const [ex, set] of cases) {
    assert.equal(client.setKind(ex, set), server.setKind(ex, set), `disagree on ${JSON.stringify(ex)} / ${JSON.stringify(set)}`);
    assert.equal(client.isRepSet(ex, set), server.isRepSet(ex, set));
    assert.equal(client.isTimedSet(ex, set), server.isTimedSet(ex, set));
  }
  assert.equal(client.setKind({}, { distance_m: 500 }), 'distance');
  assert.equal(client.setKind({}, { calories: 20 }), 'calories');
  assert.equal(client.setKind({}, { duration_sec: 60, distance_m: 5000 }), 'time', 'a duration still reads as timed');
  assert.equal(client.isTimedSet({ set_type: 'distance' }, { duration_sec: 60 }), false, 'the entry decides');
});

test('distance and calorie sets have no volume, on both sides, whatever reps they carry', () => {
  const sled = { set_type: 'distance', sets: [
    { completed: true, weight: 90, reps: 10, distance_m: 20 },   // reps typed before switching
    { completed: true, weight: 90, reps: 0, distance_m: 20 },
  ] };
  const bike = { sets: [{ completed: true, weight: 0, reps: 0, calories: 20 }] };
  for (const ex of [sled, bike]) {
    assert.equal(client.exerciseVolume(ex), 0);
    assert.equal(server.exerciseVolume(ex), 0);
  }
  const bench = { sets: [{ completed: true, weight: 100, reps: 5 }] };
  assert.equal(client.exerciseVolume(bench), 500, 'rep volume unchanged');
  assert.equal(server.exerciseVolume(bench), 500, 'rep volume unchanged');
});

// ── Which input an exercise starts with ─────────────────────────────────

test('built-ins that are distance or calorie based by nature, matched exactly', () => {
  const D = client.defaultSetTypeForName;
  for (const n of ['Rowing, Stationary', 'SkiErg', 'Ski Erg', 'Bike Erg', 'Sled Push', 'Sled Drag - Harness', 'Prowler Sprint',
    "Farmer's Walk", 'Farmers Carry', 'Yoke Walk', 'Rickshaw Carry', 'Running, Treadmill', 'Trail Running/Walking', 'Bicycling']) {
    assert.equal(D(n), 'distance', n);
  }
  for (const n of ['Assault Bike', 'Echo Bike', 'Airdyne']) assert.equal(D(n), 'calories', n);
  // Rep lifts whose names share words with them, from the same catalogue.
  for (const n of ['Air Bike', 'Bent Over Barbell Row', 'Seated Cable Rows', 'Sled Row', 'Sled Reverse Flye',
    'Upright Row', 'Barbell Walking Lunge', 'Sledgehammer Swings', 'Bench Press']) {
    assert.equal(D(n), null, `${n} must stay reps`);
  }
});

test('a built-in turned distance never changes an exercise already logged with reps', () => {
  const R = client.resolveSetType;
  const row = { exercise_id: 7, exercise_name: 'Rowing, Stationary', sets: [] };
  assert.equal(R(row), 'distance', 'never logged: starts as distance');
  assert.equal(R(row, null, null, [{ reps: 10, weight: 0, completed: true }]), 'reps', 'last session in reps keeps reps');
  assert.equal(R({ ...row, sets: [{ reps: 12 }] }), 'reps', 'its own reps keep reps');
  assert.equal(R(row, null, null, [{ distance_m: 2000, completed: true }]), 'distance');
  assert.equal(R({ ...row, set_type: 'reps' }), 'reps', 'an explicit choice wins');
  assert.equal(R(row, null, { 7: 'reps' }), 'reps', 'a remembered choice beats the name');
  assert.equal(R({ exercise_name: 'Plank', sets: [] }, null, null, [{ distance_m: 50 }]), 'distance', 'data beats the name list');

  const S = client.startSetType;
  assert.equal(S([{ reps: 8 }], 'distance', 'distance', 'Rowing'), 'reps', 'history beats library and memory');
  assert.equal(S(null, null, null, 'Rowing'), 'distance');
  assert.equal(S([], 'calories', null, 'Rowing'), 'calories', 'the library beats the name');
  assert.equal(S([{ duration_sec: 40 }], null, null, "Farmer's Walk"), 'time', 'a carry logged as timed stays timed');
  assert.equal(S(null, null, null, 'Bench Press'), 'reps');
  // The last session said reps: a distance left on its sets from a flip
  // back does not make the next one distance.
  assert.equal(S([{ reps: 8, weight: 50, distance_m: 500 }], null, null, 'Rowing', 'reps'), 'reps');
  // History that couldn't be read is not "never logged": no guess by name.
  assert.equal(S(undefined, null, null, 'Rowing'), 'reps');
  assert.equal(S(undefined, 'distance', null, 'Rowing'), 'distance', 'an explicit library type still applies');
});

test('the Diary and the program editor decide by history, even with Auto-Fill off', () => {
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /const lastEntry = await lastEntryForType\(ex\.id\);/);
  assert.match(diary, /ex\.set_type, remembered, ex\.name, lastEntry\?\.set_type\);/);
  assert.match(diary, /\{ before: `\$\{\$currentDate\}~` \}/, 'an earlier workout today counts');
  assert.match(diary, /\} catch \{ return undefined; \}/, 'an unread history is not an empty one');
  const editor = read('../src/routes/WorkoutEditor.svelte');
  assert.match(editor, /ex\.set_type, remembered, ex\.name, last\?\.set_type\);/);
  assert.match(read('../src/components/diary/ExerciseCard.svelte'), /lastSession\?\.sets \|\| null,\s*lastSession\?\.set_type \|\| null,/);
});

// ── Units ───────────────────────────────────────────────────────────────

test('distances are stored in meters and shown in the exercise unit', () => {
  assert.equal(client.toMeters('500', 'm'), 500);
  assert.equal(client.toMeters('5,2', 'km'), 5200, 'a decimal comma reads too');
  assert.equal(client.toMeters('1', 'mi'), 1609.344);
  assert.equal(client.toMeters('40', 'yd'), 36.576);
  for (const bad of ['', '0', '-3', 'abc', null]) assert.equal(client.toMeters(bad, 'm'), null);
  assert.equal(client.fromMeters(1609.344, 'mi'), 1);
  assert.equal(client.fromMeters(36.576, 'yd'), 40);
  assert.equal(client.fromMeters(5234, 'km'), 5.23);
  assert.equal(client.fmtDistance(500, 'm'), '500 m');
  assert.equal(client.fmtDistance(0, 'm'), '');
  assert.equal(client.fmtCalories(20), '20 cal');
  // A typed value survives the round trip in its own unit.
  for (const [v, u] of [['500', 'yd'], ['3.1', 'mi'], ['2000', 'm'], ['5.25', 'km']]) {
    assert.equal(client.fromMeters(client.toMeters(v, u), u), Number(v), `${v} ${u}`);
  }
});

test('the default unit follows the exercise and the account', () => {
  const U = client.distanceUnitOf;
  assert.equal(U({ exercise_name: 'Rowing, Stationary' }), 'm');
  assert.equal(U({ exercise_name: 'Rowing, Stationary' }, true), 'yd');
  assert.equal(U({ exercise_name: 'Running, Treadmill' }), 'km');
  assert.equal(U({ exercise_name: 'Running, Treadmill' }, true), 'mi');
  assert.equal(U({ exercise_name: 'Running, Treadmill', distance_unit: 'm' }, true), 'm', "the entry's own unit wins");
  assert.equal(U({ exercise_id: 3, exercise_name: 'Sled Push' }, false, { 3: 'yd' }), 'yd', 'then the remembered one');
  assert.equal(U({ exercise_name: 'Sled Push', distance_unit: 'furlong' }), 'm', 'an unknown unit is ignored');
});

test('set labels read as distance and calories', () => {
  assert.equal(client.fmtSetLabel({ set_type: 'distance', distance_unit: 'm' }, { distance_m: 20, weight: 90 }), '90×20 m');
  assert.equal(client.fmtSetLabel({}, { calories: 15 }), '15 cal');
  assert.equal(client.fmtSetLabel({ set_type: 'distance' }, { distance_m: 5000 }, 'km'), '5 km');
  assert.equal(client.fmtSetLabel({}, { reps: 8, weight: 135 }), '135×8', 'rep labels unchanged');
});

// ── Records ─────────────────────────────────────────────────────────────

test('distance and calorie sets move their own records and never the rep ones', () => {
  const r = server.newRecord('Sled Push');
  const sled = { set_type: 'distance' };
  server.accumulateRecord(r, sled, { completed: true, distance_m: 20, weight: 90 }, '2026-11-01');
  server.accumulateRecord(r, sled, { completed: true, distance_m: 20, weight: 110 }, '2026-11-02');
  server.accumulateRecord(r, sled, { completed: true, distance_m: 15, weight: 140 }, '2026-11-03');
  server.accumulateRecord(r, sled, { completed: true, distance_m: 40, warmup: true }, '2026-11-04');
  server.accumulateRecord(r, sled, { completed: false, distance_m: 50 }, '2026-11-05');
  assert.deepEqual([r.maxDistance, r.maxDistanceWeight, r.distanceDate], [20, 110, '2026-11-02'], 'a tie goes to the heavier load');
  assert.deepEqual([r.maxWeight, r.e1rm, r.maxDuration], [0, 0, 0], 'no 1RM or max weight for a sled');
  assert.equal(r.maxDistanceLoad, 140, 'the heaviest load at any distance, as maxHoldWeight is for holds');

  const b = server.newRecord('Assault Bike');
  server.accumulateRecord(b, {}, { completed: true, calories: 18 }, '2026-11-01');
  server.accumulateRecord(b, {}, { completed: true, calories: 22 }, '2026-11-02');
  assert.deepEqual([b.maxCalories, b.caloriesDate, b.maxWeight], [22, '2026-11-02', 0]);
});

test('PR badge and celebration: longest distance, most calories, heaviest load', () => {
  const hist = [{ date: '2026-11-01', set_type: 'distance', sets: [{ completed: true, distance_m: 500, weight: 0 }] }];
  const today = (sets) => [{ exercise_id: 4, set_type: 'distance', sets }];
  const flags = prSets.prFlags({
    exercises: today([{ completed: true, distance_m: 400 }, { completed: true, distance_m: 600 }, { completed: true, distance_m: 600 }]),
    history: { 4: hist }, date: '2026-11-05',
  });
  assert.deepEqual([...(flags[0] || [])], [1], 'the longer row is a PR, a repeat of it is not');
  assert.equal(prSets.celebrationFor({
    exercises: today([{ completed: true, distance_m: 600 }]), exIdx: 0, setIdx: 0, history: hist, date: '2026-11-05',
  }), 'distance');
  const bikeHist = [{ date: '2026-11-01', sets: [{ completed: true, calories: 20 }] }];
  assert.equal(prSets.celebrationFor({
    exercises: [{ exercise_id: 5, sets: [{ completed: true, calories: 25 }] }], exIdx: 0, setIdx: 0, history: bikeHist, date: '2026-11-05',
  }), 'calories');
  assert.equal(prSets.celebrationFor({
    exercises: [{ exercise_id: 5, sets: [{ completed: true, calories: 25 }] }], exIdx: 0, setIdx: 0, history: [], date: '2026-11-05',
  }), null, 'nothing to beat on a first session');
  // A row set never counts against a rep lift's bests, nor the other way.
  const b = prSets.newBests();
  prSets.absorbSet(b, { set_type: 'distance' }, { completed: true, distance_m: 500, weight: 50 });
  assert.deepEqual([b.weight, b.reps, b.distance, b.distanceLoad], [0, 0, 500, 50]);
});

// ── Programs ────────────────────────────────────────────────────────────

test('a program prescribes distance in its unit and calories, filled into the sets', () => {
  const [row, bike, sled] = planned.buildPlannedExercises([
    { exercise_id: 1, set_type: 'distance', distance_unit: 'km', target_sets: 2, target_distance: '2' },
    { exercise_id: 2, set_type: 'calories', set_specs: [{ calories: '15' }, { calories: '20', weight: '' }] },
    { exercise_id: 3, set_type: 'distance', target_sets: 1, target_distance: '40', target_weight: '90' },
  ], { weightUnit: 'lbs', autoWarmups: true });
  assert.deepEqual(row.sets.map(s => s.distance_m), [2000, 2000]);
  assert.deepEqual(bike.sets.map(s => s.calories), [15, 20]);
  assert.equal(sled.sets[0].distance_m, 36.576, 'no unit on the entry: yards for a pounds account');
  assert.equal(sled.sets.filter(s => s.warmup).length, 0, 'no warm-up ramp for a sled push');
  const { sets } = planned.logIntoSets(row.sets, { distance_m: 2100, completed: true }, {});
  assert.deepEqual([sets[0].distance_m, sets[0].completed], [2100, true]);
  assert.equal(read('../server/lib/planned-workout.js'), read('../src/lib/planned-workout.js'), 'server and app plan alike');
});

// ── Export and import ───────────────────────────────────────────────────

test('CSV export appends distance_m and calories after duration_sec', async () => {
  const { workoutToCsv } = await import('../src/lib/workoutCsv.js');
  const { csv } = workoutToCsv({ date: '2026-11-06', exercises: [
    { exercise_name: 'Bench', sets: [{ reps: 5, weight: 100, completed: true }] },
    { exercise_name: 'Row', set_type: 'distance', sets: [{ reps: 0, weight: 0, distance_m: 500, completed: true }] },
    { exercise_name: 'Bike', set_type: 'calories', sets: [{ reps: 0, weight: 0, calories: 20, completed: true }] },
  ] });
  const [header, bench, row, bike] = csv.trim().split('\r\n').map(l => l.split(','));
  assert.deepEqual(header.slice(17), ['duration_sec', 'distance_m', 'calories'], 'appended, so positions before stay');
  assert.deepEqual([bench[7], bench[18], bench[19]], ['5', '', '']);
  assert.deepEqual([row[7], row[18], row[19]], ['', '500', ''], 'no reps, so meters are never summed as reps');
  assert.deepEqual([bike[7], bike[18], bike[19]], ['', '', '20']);
});

test('Hevy and FitNotes imports keep distances instead of empty sets', async () => {
  const { parseHevy } = await import('../server/lib/workout-import/hevy.js');
  const [h] = parseHevy([
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    'Engine,"01 Aug 2024, 18:23","01 Aug 2024, 19:00",,Rowing (Machine),,,0,normal,,,0.5,105,',
    'Engine,"01 Aug 2024, 18:23","01 Aug 2024, 19:00",,Squat,,,0,normal,100,5,,,',
  ].join('\n') + '\n', 'kg');
  const byName = Object.fromEntries(h.exercises.map(e => [e.exercise_name, e]));
  assert.equal(byName['Rowing (Machine)'].set_type, 'distance');
  assert.deepEqual([byName['Rowing (Machine)'].sets[0].distance_m, byName['Rowing (Machine)'].sets[0].duration_sec], [500, 105],
    'the time of the row is kept beside it');
  assert.equal(byName.Squat.set_type, undefined);
  // A run with one time-only row is still a distance exercise, not a hold.
  const [h2] = parseHevy([
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    'Run,"02 Aug 2024, 18:23","02 Aug 2024, 19:00",,Running,,,0,warmup,,,,300,',
    'Run,"02 Aug 2024, 18:23","02 Aug 2024, 19:00",,Running,,,1,normal,,,5,1500,',
  ].join('\n') + '\n', 'kg');
  assert.equal(h2.exercises[0].set_type, 'distance');

  const { parseFitnotes } = await import('../server/lib/workout-import/fitnotes.js');
  const f = parseFitnotes([
    'Date,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time',
    '2024-08-01,Sled Push,Legs,90,kgs,,20,m,',
    '2024-08-01,Run,Cardio,,,,3.1,mi,',
    '2024-08-01,Odd,Cardio,,,,5,leagues,',
  ].join('\n') + '\n', 'kg');
  const fx = Object.fromEntries(f[0].exercises.map(e => [e.exercise_name, e]));
  assert.deepEqual([fx['Sled Push'].set_type, fx['Sled Push'].sets[0].distance_m, fx['Sled Push'].sets[0].weight], ['distance', 20, 90]);
  assert.equal(fx.Run.sets[0].distance_m, 4988.966);
  assert.equal(fx.Odd.sets[0].distance_m, undefined, 'a unit it does not name plainly is left out, not guessed');
  for (const n of ['hevy.js', 'fitnotes.js', 'strong.js']) {
    assert.equal(read(`../server/lib/workout-import/${n}`), read(`../src/lib/workout-import/${n}`), `${n} copies differ`);
  }
});

test('the weekly summary lists distance and calorie records', async () => {
  const { fmtDistanceM } = await import('../server/lib/weekly-summary.js');
  assert.equal(fmtDistanceM(500, 'kg'), '500 m');
  assert.equal(fmtDistanceM(5000, 'kg'), '5 km');
  assert.equal(fmtDistanceM(36.576, 'lbs'), '40 yd');
  assert.equal(fmtDistanceM(1609.344 * 3, 'lbs'), '3 mi');
});

test('the remembered distance unit is a per-exercise setting everywhere the others are', () => {
  assert.match(read('../src/stores/settings.js'), /'exerciseSetTypes', 'exerciseDistanceUnits',/);
  for (const f of ['../src/lib/migrate.js', '../src/lib/sync.js']) {
    assert.match(read(f), /'exerciseSetTypes', 'exerciseDistanceUnits', 'favoriteExercises'\]/, f);
  }
});

test('library set types accept distance and calories in the server and on Android', () => {
  for (const f of ['../server/routes/exercises.js', '../src/lib/api-native.js']) {
    assert.match(read(f), /v === 'reps' \|\| v === 'time' \|\| v === 'distance' \|\| v === 'calories' \? v : null/, f);
  }
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
let proc = null, base = null, dir = null, receiver = null, secret = null, token = null, apiToken = null;
const deliveries = [];
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
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  return { out, events: deliveries.slice(from) };
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-distance-'));
  const hookPort = await freePort();
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const env = JSON.parse(raw);
      const signed = !!secret && req.headers['x-lifttrace-signature'] === `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      deliveries.push({ event: env.event, data: env.data, signed });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(hookPort, '127.0.0.1', r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'distance-calories-test-0123456789abcdef', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'],
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  token = (await call(null, 'POST', '/api/auth/register', { username: 'erg', password: PW, full_name: 'Erg Rower' })).data.token;
  apiToken = (await app('POST', '/api/admin/api-tokens', { name: 'Concept2 bridge', scopes: ['mcp:read', 'mcp:write'], password: PW })).raw;
  secret = (await app('POST', '/api/webhooks', { url: `http://127.0.0.1:${hookPort}/hook`, events: ['pr.set'] })).secret;
  ex.row = (await app('POST', '/api/exercises', { name: 'Erg Row', set_type: 'distance' })).id;
  ex.bike = (await app('POST', '/api/exercises', { name: 'Fan Bike Sprint', set_type: 'calories' })).id;
  ex.bench = (await app('POST', '/api/exercises', { name: 'Flat Bench', set_type: 'reps' })).id;
  ex.ski = (await app('POST', '/api/exercises', { name: 'Ski Intervals', set_type: 'distance' })).id;
});

test.after(async () => {
  if (proc) { const p = proc; proc = null; await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); }); }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the library keeps distance and calories as an exercise type', opts, async () => {
  const row = await app('GET', `/api/exercises/${ex.row}`);
  assert.equal(row.set_type, 'distance');
  const s = await rest('GET', '/exercises?query=fan bike');
  assert.equal(s.data.exercises[0].set_type, 'calories');
  await app('PUT', `/api/exercises/${ex.bench}`, { set_type: 'calories' });
  assert.equal((await app('GET', `/api/exercises/${ex.bench}`)).set_type, 'calories');
  await app('PUT', `/api/exercises/${ex.bench}`, { set_type: 'reps' });
});

test('REST log_set takes distance_m and calories, keeps kinds apart, and records them with pr.set', opts, async () => {
  const D1 = '2026-11-02', D2 = '2026-11-03';
  const a = await rest('POST', `/workouts/${D1}/sets`, { exercise_id: ex.row, distance_m: 500 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual([a.data.logged_set.distance_m, a.data.logged_set.reps], [500, 0]);
  const b = await rest('POST', `/workouts/${D1}/sets`, { exercise_id: ex.bike, calories: 20 });
  assert.equal(b.status, 200, JSON.stringify(b.data));

  const day = (await rest('GET', `/workouts/${D1}`)).data;
  const byId = Object.fromEntries(day.exercises.map(e => [e.exercise_id, e]));
  assert.equal(byId[ex.row].set_type, 'distance', 'a new entry is stamped with its kind');
  assert.equal(byId[ex.row].sets[0].distance_m, 500);
  assert.equal(byId[ex.bike].sets[0].calories, 20);

  // Kinds are not mixed on an entry.
  const mixed = await rest('POST', `/workouts/${D1}/sets`, { exercise_id: ex.row, reps: 10 });
  assert.equal(mixed.status, 400);
  assert.match(mixed.data.error, /tracked by distance .*send distance_m instead of reps/);
  const both = await rest('POST', `/workouts/${D1}/sets`, { exercise_id: ex.row, distance_m: 500, calories: 30 });
  assert.equal(both.status, 400);
  assert.match(both.data.error, /only one of/);
  for (const bad of [{ distance_m: -5 }, { distance_m: 2e6 }, { calories: 0.4 }]) {
    const r = await rest('POST', `/workouts/${D1}/sets`, { exercise_id: ex.row, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  // A longer row next time is a record, sent as pr.set.
  const { events } = await sent(() => rest('POST', `/workouts/${D2}/sets`, { exercise_id: ex.row, distance_m: 750, weight: 0 }));
  const pr = events.find(e => e.event === 'pr.set');
  assert.ok(pr, 'pr.set for the longer row');
  assert.equal(pr.signed, true);
  assert.deepEqual([pr.data.exercise_id, pr.data.new_max_distance_m, pr.data.previous_max_distance_m, pr.data.new_max_weight],
    [String(ex.row), 750, 500, 0]);
  const shorter = await sent(() => rest('POST', `/workouts/${D2}/sets`, { exercise_id: ex.row, distance_m: 600 }));
  assert.equal(shorter.events.filter(e => e.event === 'pr.set').length, 0, 'a shorter row is no record');
  const cals = await sent(() => mcp('log_set', { exercise_id: ex.bike, calories: 24, date: D2 }));
  const calPr = cals.events.find(e => e.event === 'pr.set');
  assert.deepEqual([calPr?.data.new_max_calories, calPr?.data.previous_max_calories], [24, 20], 'over MCP too');

  const recs = (await rest('GET', '/records')).data.records;
  const r = recs.find(x => Number(x.exercise_id) === ex.row);
  assert.deepEqual([r.maxDistance, r.distanceDate, r.maxWeight, r.e1rm], [750, D2, 0, 0]);
  assert.equal(recs.find(x => Number(x.exercise_id) === ex.bike).maxCalories, 24);

  const prog = (await app('GET', `/api/stats/progress/${ex.row}?start=${D1}&end=${D2}`));
  assert.deepEqual(prog.map(p => [p.date, p.maxDistance, p.totalVolume]), [[D1, 500, 0], [D2, 750, 0]]);
  const progress = await mcp('get_exercise_progress', { exercise_name: 'Erg Row', start: D1, end: D2 });
  const body = JSON.parse(progress.content[0].text);
  assert.deepEqual(body.progress.map(p => p.max_distance_m), [500, 750]);
});

test('a program day prescribes distance and the API fills it', opts, async () => {
  const prog = await app('POST', '/api/programs', { name: 'Engine' });
  const day = await app('POST', '/api/templates', { program_id: prog.id, name: 'Intervals', exercises: [
    { exercise_id: ex.ski, exercise_name: 'Ski Intervals', set_type: 'distance', distance_unit: 'km', target_sets: 3, target_distance: '0.5' },
  ] });
  await app('POST', `/api/programs/${prog.id}/activate`);
  const D = '2026-11-04';
  const w = (await rest('POST', `/workouts/${D}/start`, { template_id: day.id })).data;
  assert.deepEqual(w.exercises[0].sets.map(s => s.distance_m), [500, 500, 500]);
  const filled = (await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.ski, distance_m: 520 })).data;
  assert.deepEqual([filled.filled_planned_set, filled.logged_set.distance_m, filled.sets_on_exercise], [true, 520, 3]);
});

test('an older app saving the day back keeps every distance set as it was', opts, async () => {
  // What an app from before #119 sends: it never heard of distance_m and
  // reads the entry as reps, but edits a set by spreading it, so the fields
  // it does not know ride along. Simulated by ticking a set off without
  // naming them, as the 1.4 Diary does ({ ...set, completed }).
  const D = '2026-11-05';
  await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.row, distance_m: 1000, completed: false });
  const w = (await app('GET', `/api/workout/${D}`)).workout;
  const exs = w.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, completed: true, reps: 0 })) }));
  await app('PUT', `/api/workout/${D}`, { ...w, exercises: exs });
  const back = (await app('GET', `/api/workout/${D}`)).workout;
  assert.deepEqual(back.exercises[0].sets.map(s => [s.distance_m, s.completed]), [[1000, true]]);
  assert.equal(back.exercises[0].set_type, 'distance');
});

// ── Records list and the Diary header (follow-ups) ──────────────────────

test('a records row with no record in it is left out, and every kind keeps its date', async () => {
  const { hasRecord, recordDate } = await import('../src/lib/statsFormat.js');
  // A bodyweight rep exercise: the records track weight, so it has none.
  // It used to read "0 kg × undefined".
  assert.equal(hasRecord({ name: 'Pull-Up', maxWeight: 0, e1rm: 0, date: '' }), false);
  assert.equal(hasRecord({ maxWeight: 100, maxReps: 5 }), true);
  assert.equal(hasRecord({ maxWeight: 0, maxDuration: 60 }), true);
  assert.equal(hasRecord({ maxWeight: 0, maxDistance: 500 }), true);
  assert.equal(hasRecord({ maxWeight: 0, maxCalories: 20 }), true);
  assert.equal(recordDate({ date: '', distanceDate: '2026-11-05' }), '2026-11-05');
  assert.equal(recordDate({ date: '', caloriesDate: '2026-11-04' }), '2026-11-04');
  assert.equal(recordDate({ date: '2026-11-01', durationDate: '' }), '2026-11-01');
  const stats = read('../src/routes/Statistics.svelte');
  assert.match(stats, /records = \(r \|\| \[\]\)\.filter\(hasRecord\);/);
  assert.match(stats, /\.map\(r => \(!r\.date && recordDate\(r\) \?/, 'recent PRs date every kind');
});

test('the Diary column header says Distance and the unit sits in the field, so it fits on a phone', () => {
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.doesNotMatch(card, /exercise_card\.distance'\)\} \(\$\{distanceUnit\}\)/);
  assert.match(read('../src/components/diary/SetRow.svelte'), /<span class="set-unit">\{distanceUnit\}<\/span>/);
  // With RPE on there is no room for it in the field: the header names it.
  assert.match(read('../src/components/diary/SetRow.svelte'), /\.set-row:has\(\.rpe-wrap\) \.amount-input \+ \.set-unit \{ display: none; \}/);
  assert.match(card, /\.sets-wrap:has\(:global\(\.rpe-wrap\)\) \.sh-dist-unit \{ display: inline; \}/);
  // The rows are SetRow's: a plain class inside :has() is dropped from the
  // build as unused, which had left the RPE heading rule out entirely.
  assert.doesNotMatch(card, /:has\(\.(rpe-wrap|amount-input)\)/);
});

// ── Trace: records of every kind ─────────────────────────────────────────

test('Trace get_stats_overview and get_prs report hold, distance and calorie records with their heaviest loads', async () => {
  const { execFileSync } = await import('node:child_process');
  const lib = new URL('../src/lib/aiTools.js', import.meta.url).href;
  const script = `
    const today = new Date().toLocaleDateString('sv-SE');
    const records = [
      { exerciseId: '1', name: 'Bench Press', maxWeight: 100, maxReps: 5, e1rm: 117, date: today },
      { exerciseId: '2', name: 'Plank', maxWeight: 0, e1rm: 0, date: '', maxDuration: 90, maxDurationWeight: 0, maxHoldWeight: 25, durationDate: today },
      { exerciseId: '3', name: 'Sled Push', maxWeight: 0, e1rm: 0, date: '', maxDistance: 20, maxDistanceWeight: 110, maxDistanceLoad: 140, distanceDate: today },
      { exerciseId: '4', name: 'Assault Bike', maxWeight: 0, e1rm: 0, date: '', maxCalories: 24, maxCaloriesWeight: 0, caloriesDate: today },
      { exerciseId: '5', name: 'Pull Up', maxWeight: 0, e1rm: 0, date: '' },
    ];
    globalThis.localStorage = { getItem: () => null };
    globalThis.fetch = async (path) => ({ ok: true, json: async () => (String(path).startsWith('/api/stats/records') ? records : String(path).includes('streaks') ? {} : []) });
    const { runTool } = await import(${JSON.stringify(lib)});
    const overview = await runTool('get_stats_overview', { range: '30d' });
    const prs = await runTool('get_prs', {});
    process.stdout.write(JSON.stringify({ top: overview.top_prs_in_range, prs }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const byName = (list) => Object.fromEntries(list.map(r => [r.exercise_name, r]));
  for (const list of [out.top, out.prs]) {
    const r = byName(list);
    assert.deepEqual(Object.keys(r).sort(), ['Assault Bike', 'Bench Press', 'Plank', 'Sled Push'], 'every kind, and no row without a record');
    assert.equal(r['Bench Press'].one_rep_max_estimate, 117);
    assert.deepEqual([r.Plank.longest_hold_sec, r.Plank.heaviest_load], [90, 25]);
    assert.deepEqual([r['Sled Push'].longest_distance_m, r['Sled Push'].distance_weight, r['Sled Push'].heaviest_load], [20, 110, 140]);
    assert.equal(r['Assault Bike'].most_calories, 24);
    for (const x of list) assert.ok(x.date, `${x.exercise_name} carries its date`);
  }
});

test('the weight is never squeezed out of its field on a phone', () => {
  // With RPE on, or beside an L/R split, a timer or a distance, the weight
  // field was too narrow for the ± buttons and the number, and the number
  // gave (nothing showed at 360px). The buttons and then the unit go first.
  const row = read('../src/components/diary/SetRow.svelte');
  assert.match(row, /\.weight-field \{ padding: 0 4px; gap: 2px; container-type: inline-size; \}/);
  assert.match(row, /@container \(max-width: 124px\) \{\s*\.weight-field \.step-btn \{ display: none; \}/);
  assert.match(row, /@container \(max-width: 72px\) \{\s*\.weight-field \.set-unit:not\(\.each\) \{ display: none; \}/);
  // The heading follows the input when the buttons go.
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.match(card, /class:compact=\{weightCompact\}/);
  assert.match(card, /getComputedStyle\(btn\)\.display === 'none'/, 'read from the rows, not guessed from the heading cell');
});

test('the Records page shows a hold, distance or calorie record\'s heaviest load when heavier than the record\'s own', () => {
  const stats = read('../src/routes/Statistics.svelte');
  assert.match(stats, /function heaviestLoad\(r\)/);
  assert.match(stats, /\[r\.maxHoldWeight, r\.maxDurationWeight\]/);
  assert.match(stats, /\[r\.maxDistanceLoad, r\.maxDistanceWeight\]/);
  assert.match(stats, /\[r\.maxCaloriesLoad, r\.maxCaloriesWeight\]/);
  assert.equal((stats.match(/statistics\.heaviest_load/g) || []).length, 2, 'both record row shapes');
});
