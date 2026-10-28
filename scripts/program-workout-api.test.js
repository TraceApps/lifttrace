/**
 * Starting a program's workout day from the API, and logging sets into it
 * (issue #140), against the real server on a scratch database, with a local
 * webhook receiver.
 *
 * The report: Home Assistant times planche-lean holds on a Wii Fit board and
 * logs them with POST /api/v1/workouts/:date/sets, but the sets went into a
 * plain workout outside the program, which never moved on. On dev there was
 * no way to start the program's day, and a day started in the app got the
 * logged sets after its planned ones (three planned, three logged: six).
 *
 * Now:
 * - POST /api/v1/workouts/:date/start and MCP start_program_workout start
 *   the active program's next day (or template_id), planned as the Diary
 *   plans it (lib/planned-workout.js), filed under the program and week;
 *   sent again, the same workout comes back.
 * - log_set fills the next planned set still to do in an unfinished
 *   workout, and goes to the program day started after another workout.
 * - A plain workout gets its sets exactly as before.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { buildPlannedExercises, lastCompletedSession } = await import('../src/lib/planned-workout.js');

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
const JWT_SECRET = 'program-workout-api-test-0123456789abcdef';

let proc = null, base = null, dir = null, receiver = null, secret = null;
const deliveries = [];
const tok = {};      // session tokens by user
const api = {};      // API tokens by user
const ex = {};       // exercises by key
let prog = null, A = null, B = null, C = null;

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
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const app = (method, path, body, who = 'surf') => ok(tok[who], method, path, body);
const rest = (method, path, body, who = 'surf') => call(api[who], method, `/api/v1${path}`, body);
const start = async (date, body = {}, who = 'surf') => { const r = await rest('POST', `/workouts/${date}/start`, body, who); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const logSet = async (date, body, who = 'surf') => { const r = await rest('POST', `/workouts/${date}/sets`, body, who); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
let rpc = 0;
async function mcp(name, args, who = 'surf') {
  const r = await call(api[who], 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.result;
}
const sessions = async (date, who = 'surf') => (await app('GET', `/api/workout/${date}/sessions`, null, who)).sessions;
const finish = async (date, id) => {
  const w = (await app('GET', `/api/workout/${date}?id=${id}`)).workout;
  await app('PUT', `/api/workout/${date}`, { ...w, id, completed: true });
};
const setsOf = (w, exerciseId) => (w.exercises.find(e => e.exercise_id === exerciseId)?.sets || []);
const shape = (sets) => sets.map(s => [s.duration_sec ?? null, s.reps, s.weight, !!s.completed, !!s.warmup]);
// Deliveries `fn` caused; delivery is fire-and-forget, so wait for quiet.
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  return { out, events: deliveries.slice(from) };
}
// Days from today on (UTC, as the server runs): a program counts only days
// since it was started, and it starts when this test does.
const DAY = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
// As stored: ids aside, through JSON (an undefined tempo is no tempo).
const noIds = (exs) => JSON.parse(JSON.stringify(exs.map(({ uuid: _u, ...e }) => ({ ...e, sets: e.sets.map(({ uuid: _s, ...s }) => s) }))));

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-program-workout-'));
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
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
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
  // The reporter (admin, so it may hold API tokens) and a second admin with a
  // private program of its own.
  tok.surf = (await ok(null, 'POST', '/api/auth/register', { username: 'surf', password: PW, full_name: 'Surf Bytes' })).token;
  const other = await app('POST', '/api/auth/register', { username: 'other', password: PW, full_name: 'Otto Other', role: 'admin' });
  tok.other = serverRequire('jsonwebtoken').sign({ id: other.user.id, username: 'other', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
  for (const who of ['surf', 'other']) {
    api[who] = (await app('POST', '/api/admin/api-tokens', { name: 'Home Assistant', scopes: ['mcp:read', 'mcp:write'] }, who)).raw;
    assert.ok(api[who]);
  }
  secret = (await app('POST', '/api/webhooks', { url: `http://127.0.0.1:${hookPort}/hook`, events: ['pr.set', 'workout.completed', 'program.advanced'] })).secret;
  const mk = async (key, name, set_type) => { ex[key] = (await app('POST', '/api/exercises', { name, set_type })).id; };
  await mk('planche', 'Planche Lean', 'time');
  await mk('pushup', 'Pseudo Planche Push-Up', 'reps');
  await mk('dips', 'Ring Dips', 'reps');
  await mk('hip', 'Hip Opener', 'reps');
  await mk('row', 'Ring Row', 'reps');
  // A program like the reporter's: three days, four weeks, the hold growing
  // week by week.
  prog = await app('POST', '/api/programs', { name: 'Planche Path', duration_weeks: 4 });
  const day = (name, exercises) => app('POST', '/api/templates', { program_id: prog.id, name, exercises });
  A = await day('Day A', [
    { exercise_id: ex.planche, exercise_name: 'Planche Lean', set_type: 'time', target_sets: 3, target_duration: '0:30',
      weeks: [{ sets: 3, duration: '0:30' }, { sets: 3, duration: '0:40' }, { sets: 4, duration: '0:45' }, { sets: 4, duration: '0:50' }] },
    { exercise_id: ex.pushup, exercise_name: 'Pseudo Planche Push-Up', target_sets: 3, target_reps: '10', target_weight: '0' },
  ]);
  B = await day('Day B', [
    { exercise_id: ex.dips, exercise_name: 'Ring Dips', target_sets: 3, target_reps: '8', target_weight: '20' },
    { exercise_id: ex.row, exercise_name: 'Ring Row', set_specs: [{ warmup: true, reps: '12' }, { reps: '10', weight: '' }, { reps: '8', rpe: 8 }] },
  ]);
  C = await day('Day C', [
    { exercise_id: ex.pushup, exercise_name: 'Pseudo Planche Push-Up', target_sets: 4, target_reps: '12', target_weight: '0' },
  ]);
  await app('POST', `/api/programs/${prog.id}/activate`);
});

test.after(async () => {
  if (proc) { const p = proc; proc = null; await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); }); }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("Home Assistant's day: start the program's day, log three holds into it, finish it, and the program moves on", opts, async () => {
  const D = DAY(1);
  const { out: w, events } = await sent(() => start(D));
  assert.equal(events.length, 0, 'starting sends no webhook, as the app saving a loaded day sends none');
  assert.equal(w.started, true);
  assert.equal(w.new_session, false);
  assert.deepEqual([w.template_id, w.template_name, w.program_id, w.program_name, w.program_week, w.duration_weeks, w.completed],
    [A.id, 'Day A', prog.id, 'Planche Path', 1, 4, false]);
  assert.deepEqual(w.exercises.map(e => [e.exercise_name, e.set_type, e.sets.length]), [['Planche Lean', 'time', 3], ['Pseudo Planche Push-Up', null, 3]]);
  assert.deepEqual(shape(w.exercises[0].sets), [[30, 0, 0, false, false], [30, 0, 0, false, false], [30, 0, 0, false, false]], "week 1's 0:30");
  // Sent again (a retried automation): the same workout, not a second.
  const again = await start(D);
  assert.deepEqual([again.started, again.workout_id], [false, w.workout_id]);
  assert.equal((await sessions(D)).length, 1);

  for (const [i, sec] of [31, 28, 25].entries()) {
    const r = await logSet(D, { exercise_id: ex.planche, duration_sec: sec });
    assert.equal(r.filled_planned_set, true, `hold ${i + 1} fills a planned set`);
    assert.equal(r.workout_id, w.workout_id);
    assert.equal(r.sets_on_exercise, 3);
  }
  const day = (await sessions(D))[0];
  assert.deepEqual(shape(setsOf(day, ex.planche)), [[31, 0, 0, true, false], [28, 0, 0, true, false], [25, 0, 0, true, false]]);
  assert.deepEqual(shape(setsOf(day, ex.pushup)).map(s => s[3]), [false, false, false], 'the push-ups stay to do');
  assert.equal(day.template_id, A.id);
  // One more hold than planned: added after them, in the same workout.
  const extra = await logSet(D, { exercise_id: ex.planche, duration_sec: 20 });
  assert.deepEqual([extra.filled_planned_set, extra.sets_on_exercise, extra.workout_id], [false, 4, w.workout_id]);

  const before = await app('GET', `/api/programs/${prog.id}`);
  const fin = await sent(() => finish(D, w.workout_id));
  const after = await app('GET', `/api/programs/${prog.id}`);
  assert.equal(after.sessions_in_program, before.sessions_in_program + 1, 'it counts toward the program');
  assert.equal(fin.events.filter(e => e.event === 'workout.completed').length, 1);
});

test("the next day is the one after the last finished, around to the first, in the next week's numbers", opts, async () => {
  const b = await start(DAY(2));
  assert.equal(b.template_id, B.id, 'after Day A');
  await finish(DAY(2), b.workout_id);
  const c = await start(DAY(3));
  assert.equal(c.template_id, C.id);
  const { events } = await sent(() => finish(DAY(3), c.workout_id));
  assert.ok(events.some(e => e.event === 'program.advanced' && e.data.new_week === 2), 'three days done: week 2');
  const a2 = await start(DAY(4));
  assert.deepEqual([a2.template_id, a2.program_week], [A.id, 2], 'around to Day A, week 2');
  assert.deepEqual(a2.exercises[0].sets.map(s => s.duration_sec), [40, 40, 40], "week 2's 0:40");
  // An unfinished day doesn't move the next one on: the same date's start
  // returns it, a later date gets the same day again.
  const a2b = await start(DAY(5));
  assert.equal(a2b.template_id, A.id);
  await app('DELETE', `/api/workout/${DAY(5)}?id=${a2b.workout_id}`);
  await app('DELETE', `/api/workout/${DAY(4)}?id=${a2.workout_id}`);
});

test('planned exactly as the Diary plans it: last session, set specs, Auto Warm-Ups, the unit, and Auto-Fill off', opts, async () => {
  // Last session of the dips and rows, before the day.
  await app('PUT', `/api/workout/${DAY(6)}`, { name: 'Extra', exercises: [
    { exercise_id: ex.dips, exercise_name: 'Ring Dips', sets: [{ weight: 25, reps: 8, completed: true }, { weight: 27.5, reps: 6, completed: true }] },
    { exercise_id: ex.row, exercise_name: 'Ring Row', sets: [{ weight: 5, reps: 12, completed: true, warmup: true }, { weight: 10, reps: 10, completed: true }, { weight: 12, reps: 8, completed: false }] },
  ] });
  const history = async (id) => (await app('GET', `/api/workout/history/${id}`));
  const expected = async (date, { autoFill = true, autoWarmups = false, unit = 'lbs' } = {}) => {
    const tpl = await app('GET', `/api/templates/${B.id}`);
    const last = {};
    for (const e of tpl.exercises) last[e.exercise_id] = autoFill ? (lastCompletedSession(await history(e.exercise_id), { before: date })?.completed || null) : null;
    // Day B of a program in week 2, as the Diary's Load Workout would build it.
    return noIds(buildPlannedExercises(tpl.exercises, { planWeek: 2, lastSets: (e) => last[e.exercise_id], autoWarmups, weightUnit: unit }));
  };
  const startedB = async (date) => {
    const w = await start(date, { template_id: B.id });
    const row = (await app('GET', `/api/workout/${date}?id=${w.workout_id}`)).workout;
    await app('DELETE', `/api/workout/${date}?id=${w.workout_id}`);
    return noIds(row.exercises);
  };
  const plain = await startedB(DAY(7));
  assert.deepEqual(plain, await expected(DAY(7)));
  assert.deepEqual(plain[0].sets.map(s => s.weight), [25, 27.5, 27.5], "last session's weights");
  assert.deepEqual(plain[1].sets.map(s => [s.weight, s.reps, !!s.warmup, s.rpe ?? null]), [[5, 12, true, null], [10, 10, false, null], [0, 8, false, 8]], 'set specs, warm-ups paired with warm-ups; a third working set last time was never done');

  await app('PUT', '/api/settings', { key: 'autoGenerateWarmups', value: true });
  await app('PUT', '/api/settings', { key: 'weightUnit', value: 'kg' });
  const warm = await startedB(DAY(8));
  assert.deepEqual(warm, await expected(DAY(8), { autoWarmups: true, unit: 'kg' }));
  assert.equal(warm[0].sets.find(s => s.warmup).weight, 20, 'a 20 kg bar first');

  await app('PUT', '/api/settings', { key: 'autoFillLastWeights', value: false });
  const noFill = await startedB(DAY(9));
  assert.deepEqual(noFill, await expected(DAY(9), { autoFill: false, autoWarmups: true, unit: 'kg' }));
  assert.deepEqual(noFill[0].sets.filter(s => !s.warmup).map(s => s.weight), [20, 20, 20], 'the plan, not last time');
  await app('PUT', '/api/settings', { key: 'autoGenerateWarmups', value: false });
  await app('PUT', '/api/settings', { key: 'weightUnit', value: 'lbs' });
  await app('PUT', '/api/settings', { key: 'autoFillLastWeights', value: true });
  await app('DELETE', `/api/workout/${DAY(6)}`);
});

test('the "six sets" case: a day started in the app gets the logged holds in its planned sets', opts, async () => {
  const D = DAY(10);
  const planned = (n) => Array.from({ length: n }, () => ({ weight: 0, reps: 0, duration_sec: 30, completed: false, notes: '' }));
  await app('PUT', `/api/workout/${D}`, { name: 'Day A', template_id: A.id, program_id: prog.id, program_week: 2,
    exercises: [{ exercise_id: ex.planche, exercise_name: 'Planche Lean', set_type: 'time', sets: planned(3) }] });
  for (const sec of [31, 28, 25]) await logSet(D, { exercise_id: ex.planche, duration_sec: sec });
  const day = (await sessions(D))[0];
  assert.deepEqual(setsOf(day, ex.planche).map(s => [s.duration_sec, s.completed]), [[31, true], [28, true], [25, true]], 'three sets, not six');
  // start for that date finds it rather than starting another.
  assert.deepEqual([(await start(D)).started, (await sessions(D)).length], [false, 1]);
  await app('DELETE', `/api/workout/${D}`);
});

test('a plain workout gets its sets exactly as before', opts, async () => {
  const D = DAY(11);
  const a = await logSet(D, { exercise_id: ex.hip, reps: 10 });
  const b = await logSet(D, { exercise_id: String(ex.hip), reps: 8, weight: 5, rpe: 7 });
  assert.equal(a.filled_planned_set, false);
  const day = (await sessions(D))[0];
  assert.equal(day.template_id, null);
  assert.equal(day.exercises.length, 1, 'an id sent as text is the same exercise');
  assert.deepEqual(setsOf(day, ex.hip).map(({ uuid, ...s }) => s), [
    { reps: 10, weight: 0, completed: true, warmup: false, rpe: null },
    { reps: 8, weight: 5, completed: true, warmup: false, rpe: 7 },
  ]);
  assert.equal(b.sets_on_exercise, 2);
  // A finished workout's unticked sets are skipped, not to do: added after.
  await app('PUT', `/api/workout/${D}`, { ...day, exercises: day.exercises.map(e => ({ ...e, sets: [...e.sets, { weight: 0, reps: 10, completed: false }] })), completed: true });
  const c = await logSet(D, { exercise_id: ex.hip, reps: 12 });
  assert.deepEqual([c.filled_planned_set, c.sets_on_exercise], [false, 4]);
  // A set sent as not done is added, never filling one.
  const D2 = DAY(12);
  await app('PUT', `/api/workout/${D2}`, { exercises: [{ exercise_id: ex.hip, exercise_name: 'Hip Opener', sets: [{ reps: 10, weight: 0, completed: false }] }] });
  const d = await logSet(D2, { exercise_id: ex.hip, reps: 9, completed: false });
  assert.deepEqual([d.filled_planned_set, d.sets_on_exercise], [false, 2]);
  await app('DELETE', `/api/workout/${D}`);
  await app('DELETE', `/api/workout/${D2}`);
});

test('a day with another workout already: a new workout of the day, which later sets reach; an empty one is filled', opts, async () => {
  const D = DAY(13);
  await app('PUT', `/api/workout/${D}`, { name: 'Mobility', exercises: [{ exercise_id: ex.hip, exercise_name: 'Hip Opener', sets: [{ reps: 10, weight: 0, completed: true }] }] });
  const mobility = (await sessions(D))[0];
  const w = await start(D);
  assert.deepEqual([w.started, w.new_session], [true, true]);
  const both = await sessions(D);
  assert.equal(both.length, 2);
  assert.deepEqual(both[0].exercises, mobility.exercises, 'Mobility untouched');
  assert.equal(both[0].name, 'Mobility');
  // A planned hold, an exercise the day doesn't plan, and one Mobility has:
  // all to the program day under way.
  assert.equal((await logSet(D, { exercise_id: ex.planche, duration_sec: 33 })).workout_id, w.workout_id);
  assert.equal((await logSet(D, { exercise_id: ex.dips, reps: 8 })).workout_id, w.workout_id);
  assert.equal((await logSet(D, { exercise_id: ex.hip, reps: 10 })).workout_id, w.workout_id);
  assert.equal((await logSet(D, { exercise_id: ex.hip, reps: 10, workout_id: mobility.id })).workout_id, mobility.id, 'workout_id names one');
  const bad = await rest('POST', `/workouts/${D}/sets`, { exercise_id: ex.hip, reps: 10, workout_id: 999999 });
  assert.equal(bad.status, 400);
  // Finished, the program day no longer takes sets by default: the first
  // workout does, as before.
  await finish(D, w.workout_id);
  assert.equal((await logSet(D, { exercise_id: ex.hip, reps: 11 })).workout_id, mobility.id);

  // An empty workout on the day is filled, keeping its notes.
  const E = DAY(14);
  const empty = (await app('PUT', `/api/workout/${E}`, { notes: 'garage gym', exercises: [] })).workout;
  const s = await start(E);
  assert.deepEqual([s.workout_id, s.started, s.new_session], [empty.id, true, false]);
  const filled = (await sessions(E))[0];
  assert.deepEqual([filled.notes, filled.template_id, filled.name], ['garage gym', s.template_id, s.template_name]);
  for (const d of [D, E]) for (const x of await sessions(d)) await app('DELETE', `/api/workout/${d}?id=${x.id}`);
});

test("only a day this account may see; none without an active program; another program's day has no week", opts, async () => {
  const theirs = await app('POST', '/api/programs', { name: 'Secret', duration_weeks: 2 }, 'other');
  const t = await app('POST', '/api/templates', { program_id: theirs.id, name: 'Hidden', exercises: [{ exercise_id: ex.hip, exercise_name: 'Hip Opener', target_sets: 1 }] }, 'other');
  const r = await rest('POST', `/workouts/${DAY(15)}/start`, { template_id: t.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No workout day/);
  assert.equal((await sessions(DAY(15))).length, 0, 'nothing written');
  for (const bad of ['abc', -1, 1.5]) assert.equal((await rest('POST', `/workouts/${DAY(15)}/start`, { template_id: bad })).status, 400);
  assert.equal((await rest('POST', '/workouts/2026-13-45/start', {})).status, 400);
  const none = await rest('POST', `/workouts/${DAY(15)}/start`, {}, 'other');
  assert.equal(none.status, 400);
  assert.match(none.data.error, /No active program/);
  // The other account's own day, its program not active: started, no week.
  const own = await rest('POST', `/workouts/${DAY(15)}/start`, { template_id: t.id }, 'other');
  assert.equal(own.status, 200);
  assert.deepEqual([own.data.program_id, own.data.program_week], [theirs.id, null]);
});

test('writes need the write scope and the server switch, like every other write', opts, async () => {
  const readOnly = (await app('POST', '/api/admin/api-tokens', { name: 'ro', scopes: ['mcp:read'] })).raw;
  const r = await call(readOnly, 'POST', `/api/v1/workouts/${DAY(16)}/start`, {});
  assert.equal(r.status, 403);
  assert.equal((await call(null, 'POST', `/api/v1/workouts/${DAY(16)}/start`, {})).status, 401);
});

test('MCP: start_program_workout is a write tool, and log_set takes workout_id', opts, async () => {
  const list = await call(api.surf, 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/list', params: {} });
  const tool = list.data.result.tools.find(x => x.name === 'start_program_workout');
  assert.ok(tool, 'listed');
  assert.ok(tool.inputSchema.properties.template_id && tool.inputSchema.properties.date);
  assert.ok(list.data.result.tools.find(x => x.name === 'log_set').inputSchema.properties.workout_id);
  const readOnly = (await app('POST', '/api/admin/api-tokens', { name: 'ro2', scopes: ['mcp:read'] })).raw;
  const roList = await call(readOnly, 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/list', params: {} });
  assert.ok(!roList.data.result.tools.some(x => x.name === 'start_program_workout'), 'not without mcp:write');

  const D = DAY(17);
  const res = await mcp('start_program_workout', { date: D });
  assert.ok(!res.isError, JSON.stringify(res));
  const w = res.structuredContent ?? JSON.parse(res.content[0].text);
  assert.equal(w.started, true);
  const again = await mcp('start_program_workout', { date: D });
  assert.equal((again.structuredContent ?? JSON.parse(again.content[0].text)).workout_id, w.workout_id);
  const firstEx = w.exercises[0].exercise_id;
  const logged = await mcp('log_set', { exercise_id: firstEx, date: D, workout_id: w.workout_id, ...(w.exercises[0].set_type === 'time' ? { duration_sec: 30 } : { reps: 5 }) });
  const out = logged.structuredContent ?? JSON.parse(logged.content[0].text);
  assert.deepEqual([out.workout_id, out.filled_planned_set], [w.workout_id, true]);
  const err = await mcp('start_program_workout', { template_id: 999999, date: D });
  assert.equal(err.isError, true);
  for (const x of await sessions(D)) await app('DELETE', `/api/workout/${D}?id=${x.id}`);
});

test('pr.set: a hold that fills a planned set and beats the record sends one; a shorter one sends none', opts, async () => {
  const D = DAY(18);
  const w = await start(D, { template_id: A.id });
  const first = await sent(() => logSet(D, { exercise_id: ex.planche, duration_sec: 90 }));
  const prs = first.events.filter(e => e.event === 'pr.set');
  assert.equal(prs.length, 1);
  assert.ok(prs[0].signed);
  assert.deepEqual([Number(prs[0].data.exercise_id), prs[0].data.date], [ex.planche, D]);
  const second = await sent(() => logSet(D, { exercise_id: ex.planche, duration_sec: 10 }));
  assert.equal(second.events.filter(e => e.event === 'pr.set').length, 0);
  // A planned weighted set filled without a weight sent keeps the planned
  // weight, and that can be a record.
  const E = DAY(19);
  await app('PUT', `/api/workout/${E}`, { template_id: B.id, program_id: prog.id, exercises: [
    { exercise_id: ex.dips, exercise_name: 'Ring Dips', sets: [{ weight: 40, reps: 5, completed: false }] }] });
  const weighted = await sent(() => logSet(E, { exercise_id: ex.dips, reps: 5 }));
  assert.equal(weighted.out.logged_set.weight, 40);
  assert.equal(weighted.events.filter(e => e.event === 'pr.set').length, 1);
  for (const d of [D, E]) for (const x of await sessions(d)) await app('DELETE', `/api/workout/${d}?id=${x.id}`);
  assert.ok(w.workout_id);
});

test('a phone gets the started workout and the filled sets by sync, and its saves keep them', opts, async () => {
  const D = DAY(20);
  const since = new Date(Date.now() - 1000).toISOString();
  const w = await start(D, { template_id: A.id });
  await logSet(D, { exercise_id: ex.planche, duration_sec: 29 });
  const pull = await app('GET', `/api/sync/pull?since=${encodeURIComponent(since)}`);
  const row = pull.workout_log.find(r => r.id === w.workout_id);
  assert.ok(row, 'pulled');
  const exs = typeof row.exercises === 'string' ? JSON.parse(row.exercises) : row.exercises;
  assert.ok(exs.every(e => e.uuid && e.sets.every(s => s.uuid)), 'every exercise and set has an id');
  assert.deepEqual([row.template_id, row.program_id, row.program_week], [A.id, prog.id, w.program_week]);
  const plan = w.exercises[0].sets.map(s => s.duration_sec);
  assert.deepEqual(exs[0].sets.map(s => [s.duration_sec, s.completed]), [[29, true], [plan[1], false], [plan[2], false]]);
  // The app (1.4.0 and later) ticks the next set, saying what it changed:
  // the hold filled on the server stays, nothing doubles.
  const shown = (await app('GET', `/api/workout/${D}?id=${w.workout_id}`)).workout;
  const ticked = shown.exercises.map((e, i) => (i ? e : { ...e, sets: e.sets.map((s, j) => (j === 1 ? { ...s, duration_sec: 27, completed: true } : s)) }));
  await app('PUT', `/api/workout/${D}`, { ...shown, id: w.workout_id, exercises: ticked,
    changed_uuids: { exercises: [ticked[0].uuid], sets: { [ticked[0].uuid]: [ticked[0].sets[1].uuid] } } });
  // An older app (no changed_uuids) saving its copy from before the fill,
  // with the third hold ticked: both stay.
  const fromBefore = { ...shown, id: w.workout_id, exercises: exs.map((e, i) => (i ? e : { ...e, sets: e.sets.map((s, j) => (j === 0 ? { ...s, duration_sec: plan[0], completed: false, completedAt: undefined } : j === 1 ? { ...s, duration_sec: 27, completed: true } : s)) })) };
  await app('PUT', `/api/workout/${D}`, fromBefore);
  assert.deepEqual(setsOf((await sessions(D))[0], ex.planche).map(s => [s.duration_sec, s.completed]), [[29, true], [27, true], [plan[2], false]], 'the filled hold is not unticked');
  // A phone's sync push of an older copy (edited before these): nothing
  // doubles, nothing goes back.
  const older = new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19);
  await app('POST', '/api/sync/push', { workout_log: [{ ...row, server_id: row.id, client_id: 77, exercises: exs, updated_at: older }] });
  const after = (await sessions(D));
  assert.equal(after.length, 1);
  assert.deepEqual(setsOf(after[0], ex.planche).map(s => [s.duration_sec, s.completed]), [[29, true], [27, true], [plan[2], false]]);
  await app('DELETE', `/api/workout/${D}`);
});

test('a deleted workout day is never started; a day naming an exercise by text stores its number', opts, async () => {
  const p = await app('POST', '/api/programs', { name: 'Two Days', duration_weeks: 1 });
  const one = await app('POST', '/api/templates', { program_id: p.id, name: 'One', exercises: [{ exercise_id: String(ex.hip), exercise_name: 'Hip Opener', target_sets: 2, target_reps: '10' }] });
  const two = await app('POST', '/api/templates', { program_id: p.id, name: 'Two', exercises: [{ exercise_id: ex.dips, exercise_name: 'Ring Dips', target_sets: 1 }] });
  // A phone deleted day One (sync soft-deletes it).
  const later = new Date(Date.now() + 60000).toISOString().replace('T', ' ').slice(0, 19);
  await app('POST', '/api/sync/push', { workout_templates: [{ server_id: one.id, program_id: p.id, name: 'One', deleted_at: later, updated_at: later, exercises: [] }] });
  await app('POST', `/api/programs/${p.id}/activate`);
  try {
    const w = await start(DAY(30));
    assert.equal(w.template_id, two.id, 'day One is gone');
    const r = await rest('POST', `/workouts/${DAY(30)}/start`, { template_id: one.id });
    assert.equal(r.status, 400);
    // Undeleted, a text id is kept as the number, so log_set finds it.
    serverRequire('better-sqlite3');
    const d = new (serverRequire('better-sqlite3'))(join(dir, 'lt.db'));
    d.prepare('UPDATE workout_templates SET deleted_at = NULL WHERE id = ?').run(one.id);
    d.close();
    const o = await start(DAY(31), { template_id: one.id });
    assert.equal(o.exercises[0].exercise_id, ex.hip);
    assert.equal((await logSet(DAY(31), { exercise_id: ex.hip, reps: 9 })).filled_planned_set, true);
  } finally {
    await app('POST', `/api/programs/${prog.id}/activate`);
  }
});
