/**
 * Webhooks and the Android app's Upload (#134), against the real server
 * (server/index.js on a scratch database) and a local receiver that checks
 * each delivery's signature.
 *
 * A phone used without a server keeps its history on the phone. When it
 * connects to a server, Upload (src/lib/migrate.js) sends that history
 * through the app's own routes, one save per workout, body-stat day and
 * cardio session, the same routes a connected phone logs through. Every
 * one of those saves sent its webhooks as if it had just been logged: a
 * year of history was a workout.completed per workout, a pr.set for each
 * step up, a body_stat.logged per day and a cardio.logged per session.
 *
 * Now an Upload's saves send none. The app marks them `history_upload`;
 * an app that doesn't yet (1.4.0) is known by the key its Upload gives
 * every workout and cardio session (`upload:<kind>:<hash>`). Ordinary logs,
 * online or replayed from the offline queue, still send theirs once, and
 * /api/sync/push (which the app doesn't use) sends none.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const EVENTS = ['workout.completed', 'body_stat.logged', 'pr.set', 'program.advanced', 'cardio.logged'];
let proc = null, base = null, dir = null, receiver = null;
let secret = null;
const deliveries = [];

async function call(auth, method, path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (auth) h.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// Every delivery `fn` caused, by event. Delivery is fire-and-forget, so
// this waits for the receiver to go quiet.
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) assert.ok(d.signed, `${d.event} delivery carries a valid signature`);
  const count = Object.fromEntries(EVENTS.map(e => [e, got.filter(d => d.event === e).length]));
  return { out, got, count, total: got.length };
}

// A new account with a webhook for every log event, and a Bench Press.
// The first account registers itself; it makes the rest. Each is an admin,
// since webhooks are an admin's (routes/webhooks.js).
let n = 0, admin = null;
async function account() {
  const username = `lifter${++n}`;
  const reg = await call(admin, 'POST', '/api/auth/register', { username, password: PW, role: 'admin' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  if (!admin) admin = reg.data.token;
  const login = reg.data.token ? null : await call(null, 'POST', '/api/auth/login', { username, password: PW });
  const token = reg.data.token || login.data.token;
  assert.ok(token, JSON.stringify(login?.data));
  const hook = await call(token, 'POST', '/api/webhooks', { url: `${hookUrl}/hook`, events: EVENTS });
  assert.ok(hook.data.secret, JSON.stringify(hook.data));
  secrets.add(hook.data.secret);
  const exerciseId = (await call(token, 'POST', '/api/exercises', { name: 'Bench Press' })).data.id;
  assert.ok(exerciseId);
  await call(token, 'PUT', '/api/settings', { key: 'cardioEnabled', value: true });
  return { token, exerciseId };
}
const secrets = new Set();
let hookUrl = null;

// The phone's history, oldest first, as migrate.js reads it: a bench press
// going up 5 kg a week, a weigh-in a day, and a few runs.
function history(exerciseId) {
  const workouts = [], bodyStats = [], cardio = [];
  for (let i = 0; i < 8; i++) {
    const date = `2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4) * 7).padStart(2, '0')}`;
    workouts.push({
      date, name: `Push ${i + 1}`, created_at: `${date} 18:00:00`, session_seq: 0, completed: 1, notes: null, duration_min: 60,
      exercises: [{ uuid: `ex-${i}`, exercise_id: exerciseId, name: 'Bench Press', sets: [{ uuid: `set-${i}`, reps: 5, weight: 60 + i * 5, completed: true }] }],
    });
  }
  for (let i = 1; i <= 6; i++) bodyStats.push({ date: `2026-03-0${i}`, stats: { weight: 82 - i * 0.2 } });
  for (let i = 1; i <= 3; i++) cardio.push({ date: `2026-03-1${i}`, activity: 'Run', duration_min: 30, distance: 5, distance_unit: 'km', avg_hr: null, notes: null, is_template: 0, created_at: `2026-03-1${i} 07:00:00` });
  return { workouts, bodyStats, cardio };
}

// migrate.js _key: from what the row is, not its id on the phone.
const key = (kind, r) => `upload:${kind}:${createHash('md5').update(JSON.stringify([r.created_at || '', r.date || '', r.name ?? r.activity ?? '', r.session_seq ?? 0])).digest('hex')}`;

// Upload as migrate.js sends it: workouts, then body stats, then cardio,
// each through the app's own route. `marked`: this app marks the saves
// (history_upload); 1.4.0's Upload doesn't.
async function upload(token, h, { marked = true } = {}) {
  const mark = marked ? { history_upload: true } : {};
  for (const w of h.workouts) {
    const r = await call(token, 'PUT', `/api/workout/${w.date}`, {
      new_session: true, client_key: key('workout', w), template_id: null, program_id: null, program_week: null,
      name: w.name, exercises: w.exercises, notes: w.notes, duration_min: w.duration_min, completed: !!w.completed, ...mark,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (const b of h.bodyStats) {
    const r = await call(token, 'PUT', `/api/body-stats/${b.date}`, { stats: b.stats, ...mark });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (const c of h.cardio) {
    const r = await call(token, 'POST', '/api/cardio', {
      date: c.date, activity: c.activity, duration_min: c.duration_min, distance: c.distance, distance_unit: c.distance_unit,
      avg_hr: c.avg_hr, notes: c.notes, is_template: !!c.is_template, client_key: key('cardio', c), ...mark,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-history-upload-'));
  const hookPort = await freePort();
  hookUrl = `http://127.0.0.1:${hookPort}`;
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let env = {};
      try { env = JSON.parse(raw); } catch { /* counted as unsigned below */ }
      const sig = req.headers['x-lifttrace-signature'];
      const signed = [...secrets].some(s => sig === `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`);
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
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'history-upload-test-0123456789abcdef0123',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 150) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
});

test.after(async () => {
  if (proc) {
    const p = proc; proc = null;
    await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
  }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !ready && 'server packages not installed' };
const none = Object.fromEntries(EVENTS.map(e => [e, 0]));

test('Upload of a phone\'s history sends no webhooks, and uploading again sends none', opts, async () => {
  const { token, exerciseId } = await account();
  const h = history(exerciseId);
  const first = await sent(() => upload(token, h));
  assert.deepEqual(first.count, none, 'the first Upload');
  const again = await sent(() => upload(token, h));
  assert.deepEqual(again.count, none, 'the same Upload again');
  // It all went up: the next log compares against it.
  const day = (await call(token, 'GET', `/api/workout/${h.workouts[7].date}`)).data.workout;
  assert.equal(day.exercises[0].sets[0].weight, 95);
  const next = await sent(() => call(token, 'PUT', '/api/workout/2026-04-01', {
    exercises: [{ uuid: 'ex-new', exercise_id: exerciseId, name: 'Bench Press', sets: [{ uuid: 'set-new', reps: 5, weight: 100, completed: true }] }],
  }, { 'X-Changed-Fields': 'exercises' }));
  assert.equal(next.count['pr.set'], 1);
  assert.equal(next.got.find(d => d.event === 'pr.set').data.previous_max_weight, 95);
});

test('Upload from the 1.4.0 app (not marked) sends no workout, record or cardio webhooks', opts, async () => {
  const { token, exerciseId } = await account();
  const h = history(exerciseId);
  const first = await sent(() => upload(token, { workouts: h.workouts, bodyStats: [], cardio: h.cardio }, { marked: false }));
  assert.deepEqual(first.count, none);
});

test('a connected phone\'s logs still send once: online, and replayed from the offline queue', opts, async () => {
  const { token, exerciseId } = await account();
  const body = {
    exercises: [{ uuid: 'ex-a', exercise_id: exerciseId, name: 'Bench Press', sets: [{ uuid: 'set-a', reps: 5, weight: 70, completed: true }] }],
    completed: true,
  };
  const online = await sent(() => call(token, 'PUT', '/api/workout/2026-05-01', body, { 'X-Changed-Fields': 'exercises,completed' }));
  assert.equal(online.count['pr.set'], 1);
  assert.equal(online.count['workout.completed'], 1);
  // The same save replayed from the queue (its answer was lost).
  const replay = await sent(() => call(token, 'PUT', '/api/workout/2026-05-01', body, { 'X-Changed-Fields': 'exercises,completed' }));
  assert.equal(replay.count['pr.set'], 0);
  assert.equal(replay.count['workout.completed'], 0);
  // A workout made offline goes up as a new session under a device key.
  const offline = { ...body, new_session: true, client_key: 'device-workout:-1761500000000',
    exercises: [{ uuid: 'ex-b', exercise_id: exerciseId, name: 'Bench Press', sets: [{ uuid: 'set-b', reps: 5, weight: 75, completed: true }] }] };
  const queued = await sent(() => call(token, 'PUT', '/api/workout/2026-05-02', offline));
  assert.equal(queued.count['pr.set'], 1);
  assert.equal(queued.count['workout.completed'], 1);
  const queuedAgain = await sent(() => call(token, 'PUT', '/api/workout/2026-05-02', offline));
  assert.deepEqual(queuedAgain.count, none);

  const weigh = await sent(() => call(token, 'PUT', '/api/body-stats/2026-05-01', { stats: { weight: 80 } }));
  assert.equal(weigh.count['body_stat.logged'], 1);

  const run = { date: '2026-05-01', activity: 'Run', duration_min: 30, client_key: '6f1c2a4e-run-key' };
  const ran = await sent(() => call(token, 'POST', '/api/cardio', run));
  assert.equal(ran.count['cardio.logged'], 1);
  const ranAgain = await sent(() => call(token, 'POST', '/api/cardio', run));
  assert.equal(ranAgain.count['cardio.logged'], 0);
});

test('editing or deleting an uploaded workout sends nothing', opts, async () => {
  const { token, exerciseId } = await account();
  const h = history(exerciseId);
  await sent(() => upload(token, h));
  const w = h.workouts[7];
  const day = (await call(token, 'GET', `/api/workout/${w.date}`)).data.workout;
  assert.ok(day?.id, 'the uploaded workout is there');
  // The app sends the whole workout with what it changed.
  const edit = await sent(() => call(token, 'PUT', `/api/workout/${w.date}`,
    { id: day.id, name: day.name, exercises: day.exercises, completed: true, notes: 'felt strong' }, { 'X-Changed-Fields': 'notes' }));
  assert.equal(edit.out.status, 200, JSON.stringify(edit.out.data));
  assert.deepEqual(edit.count, none);
  const del = await sent(() => call(token, 'DELETE', `/api/workout/${w.date}?id=${day.id}`));
  assert.equal(del.out.status, 200, JSON.stringify(del.out.data));
  assert.deepEqual(del.count, none);
});

test('/api/sync/push (not used by the app) sends no webhooks', opts, async () => {
  const { token, exerciseId } = await account();
  const pushed = await sent(() => call(token, 'POST', '/api/sync/push', {
    workout_log: [{ client_id: 1, date: '2026-06-01', completed: 1, updated_at: new Date().toISOString(),
      exercises: [{ uuid: 'ex-p', exercise_id: exerciseId, name: 'Bench Press', sets: [{ uuid: 'set-p', reps: 5, weight: 200, completed: true }] }] }],
    body_stats_log: [{ client_id: 2, date: '2026-06-01', stats: { weight: 79 }, updated_at: new Date().toISOString() }],
  }));
  assert.equal(pushed.out.status, 200, JSON.stringify(pushed.out.data));
  assert.deepEqual(pushed.count, none);
});

test('the app\'s Upload marks its workouts, body stats and cardio as history', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/migrate.js', import.meta.url), 'utf8');
  for (const route of ['`/api/workout/', '`/api/body-stats/', "'/api/cardio'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, route);
    const call = src.slice(at, src.indexOf('});', at));
    assert.match(call, /history_upload: true/, `${route} goes up marked`);
  }
});
