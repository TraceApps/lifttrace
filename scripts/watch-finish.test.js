/**
 * A workout finished on the watch gets what one finished on the phone gets.
 *
 * - The server sends the "Workout Complete" push and the NutriTrace
 *   calories for a save that says it finished the workout on the watch
 *   (`finished_on: 'watch'`), once, when that save is what marks it done
 *   (server/lib/watch-finish.js). A finish on the phone gets neither from
 *   the server: the phone sends its own, so nothing is doubled.
 * - The calories are worked out the same way on both sides: the server's
 *   copy (server/lib/workout-calories.js) runs the app's cases here.
 * - The watch's save says which of the session's own fields it changed
 *   (X-Changed-Fields), and the phone's says it in the body
 *   (`changed_fields`), so neither puts back a detail from a copy older
 *   than the server's: a workout finished on the watch stays finished when
 *   the Android app, still holding its own copy from before, saves a set.
 *
 * Against the real server (server/index.js on a scratch database), with a
 * stand-in push service and a stand-in NutriTrace on this machine.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const client = await import('../src/lib/workout.js');
const serverCalories = await import('../server/lib/workout-calories.js');

// ── One estimate on both sides ──────────────────────────────────────────

const PROFILES = [
  { weight_kg: 80, height_cm: 180, age: 34, sex: 'male' },
  { weight_kg: 62, height_cm: 165, age: 41, sex: 'female' },
  { weight_kg: 70, height_cm: 172, age: 28, sex: null },
  { weight_kg: 0, height_cm: 172, age: 28, sex: 'male' },
  { weight_kg: 70, height_cm: null, age: 28, sex: 'male' },
  { weight_kg: 70, height_cm: 172, age: null, sex: 'male' },
];
const WORKOUTS = [
  { duration_min: 47.3, exercises: [{ sets: [{ weight: 185, reps: 5, completed: true }, { weight: 95, reps: 10, completed: true, warmup: true }] }] },
  { duration_min: 0, exercises: [{ sets: [{ weight: 185, reps: 5, completed: true }, { weight: 185, reps: 5, completed: false }] }] },
  { duration_min: null, exercises: [{ sets: [{ weight: 185, reps: 5, completed: false }] }] },
  { duration_min: 10, exercises: [{ load_type: 'paired', sets: [{ weight: 100, reps: 12, completed: true }] }, { load_type: 'unilateral', sets: [{ weight: 60, reps_l: 8, reps_r: 7, completed: true }] }] },
  { duration_min: 5, exercises: [{ set_type: 'time', sets: [{ weight: 500, reps: 9, duration_sec: 60, completed: true }] }, { sets: [{ weight: 400, reps: 10, completed: true }] }] },
  { duration_min: 30, exercises: [] },
];

test('the server works out a workout\'s calories exactly as the app does', () => {
  for (const w of WORKOUTS) for (const p of PROFILES) {
    assert.equal(serverCalories.estimateWorkoutCalories(w, p), client.estimateWorkoutCalories(w, p), JSON.stringify({ w, p }));
  }
  assert.equal(serverCalories.estimateWorkoutCalories(null, PROFILES[0]), client.estimateWorkoutCalories(null, PROFILES[0]));
  for (const dob of ['1990-05-04', '2000-12-31', '1985-01-01', '', null, 'not a date']) {
    assert.equal(serverCalories.ageFromDob(dob), client.ageFromDob(dob), String(dob));
  }
});

// ── The real server ─────────────────────────────────────────────────────

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
let proc = null, base = null, dir = null, token = null, stand = null, standBase = null;
const heard = []; // what the stand-in push service and NutriTrace were sent

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
}
const setting = (key, value) => call('PUT', '/api/settings', { key, value });

async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'watch-finish-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

test.before(async () => {
  if (!ready) return;
  stand = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      heard.push({ path: req.url, title: req.headers.title || null, body: raw });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => stand.listen(0, '127.0.0.1', r));
  standBase = `http://127.0.0.1:${stand.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'lt-watch-finish-'));
  await boot();
  await call('POST', '/api/auth/register', { username: 'alex', password: PW, full_name: 'Alex Rivera', birthday: '1990-05-04', gender: 'male' });
  token = (await call('POST', '/api/auth/login', { username: 'alex', password: PW })).token;
  await setting('notifPushService', 'ntfy');
  await setting('ntfyUrl', standBase);
  await setting('ntfyTopic', 'lifts');
  await setting('ntInstanceUrl', standBase);
  await setting('ntInstanceToken', 'nt-token');
  await setting('ntFederationEnabled', true);
  await setting('caloriesBurnedEnabled', true);
  await setting('currentWeightKg', 80);
  await setting('heightCm', 180);
});
test.after(async () => {
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
  if (stand) await new Promise((r) => stand.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const exercises = (date, doneUpTo) => [
  { uuid: `e1-${date}`, exercise_name: 'Bench Press', sets: [
    { uuid: `s1-${date}`, reps: 5, weight: 185, completed: true },
    { uuid: `s2-${date}`, reps: 5, weight: 185, completed: doneUpTo >= 2 },
  ] },
  { uuid: `e2-${date}`, exercise_name: 'Overhead Press', load_type: 'paired', sets: [
    { uuid: `s3-${date}`, reps: 6, weight: 50, completed: doneUpTo >= 3 },
  ] },
];
async function startDay(date) {
  return (await call('PUT', `/api/workout/${date}`, { name: 'Push', notes: '', exercises: exercises(date, 1) })).workout;
}
/** The watch's save: the day it read, its changes on top, and what it changed. */
async function watchSave(date, change, fields) {
  const { workout } = await call('GET', `/api/workout/${date}`);
  const body = { ...workout, ...change.details };
  if (change.done) body.exercises = exercises(date, change.done);
  body.changed_uuids = { exercises: [], sets: change.sets || {} };
  if (change.finished) body.finished_on = 'watch';
  return (await call('PUT', `/api/workout/${date}`, body, { 'X-Changed-Fields': fields.join(',') })).workout;
}
async function heardFor(ms = 1500) {
  const before = heard.length;
  await sleep(ms);
  return heard.slice(before);
}

test('finished on the watch: one push and one NutriTrace entry, from the server', { skip: !ready }, async () => {
  const date = '2026-10-21';
  await startDay(date);
  const saved = await watchSave(date, {
    done: 3, sets: { [`e1-${date}`]: [`s2-${date}`], [`e2-${date}`]: [`s3-${date}`] },
    details: { completed: 1, duration_min: 47.3 }, finished: true,
  }, ['completed', 'duration_min']);
  assert.equal(saved.completed, 1);
  assert.equal(saved.duration_min, 47.3);
  const got = await heardFor();
  const push = got.filter((h) => h.path === '/lifts');
  const nt = got.filter((h) => h.path === '/api/v1/workouts');
  assert.equal(push.length, 1, JSON.stringify(got));
  assert.match(push[0].body, /"Push" is done/);
  assert.equal(nt.length, 1, JSON.stringify(got));
  const sent = JSON.parse(nt[0].body);
  // What the phone would have sent for the same workout and profile.
  const kcal = client.estimateWorkoutCalories(
    { exercises: saved.exercises, duration_min: 47.3 },
    { weight_kg: 80, height_cm: 180, age: client.ageFromDob('1990-05-04'), sex: 'male' },
  );
  assert.deepEqual(sent, { date, name: 'Push', duration_min: 47.3, calories_burned: kcal, external_id: `lt:workout:${date}`, start_time: null });
});

test('sent again (its answer lost), the same finish says nothing twice', { skip: !ready }, async () => {
  const date = '2026-10-21';
  await watchSave(date, { done: 3, details: { completed: 1, duration_min: 47.3 }, finished: true }, ['completed', 'duration_min']);
  assert.deepEqual(await heardFor(), []);
});

test('finished on the phone: the server sends neither, the phone does', { skip: !ready }, async () => {
  const date = '2026-10-22';
  await startDay(date);
  const { workout } = await call('GET', `/api/workout/${date}`);
  const saved = (await call('PUT', `/api/workout/${date}`, { ...workout, exercises: exercises(date, 3), completed: 1, duration_min: 40 })).workout;
  assert.equal(saved.completed, 1);
  assert.deepEqual(await heardFor(), []);
});

test('the account\'s settings decide, as on the phone', { skip: !ready }, async () => {
  await setting('notifWorkoutComplete', false);
  await setting('caloriesBurnedEnabled', false);
  try {
    const date = '2026-10-23';
    await startDay(date);
    await watchSave(date, { done: 3, details: { completed: 1 }, finished: true }, ['completed']);
    assert.deepEqual(await heardFor(), []);
  } finally {
    await setting('notifWorkoutComplete', true);
    await setting('caloriesBurnedEnabled', true);
  }
});

test('a set saved on the watch leaves the session\'s details as the phone left them', { skip: !ready }, async () => {
  const date = '2026-10-24';
  await startDay(date);
  // The watch read the day, then the phone renamed it.
  const { workout: read } = await call('GET', `/api/workout/${date}`);
  await call('PUT', `/api/workout/${date}`, { ...read, name: 'Push Day', changed_fields: ['name'] });
  const body = { ...read, exercises: exercises(date, 2), changed_uuids: { exercises: [], sets: { [`e1-${date}`]: [`s2-${date}`] } } };
  const saved = (await call('PUT', `/api/workout/${date}`, body, { 'X-Changed-Fields': '' })).workout;
  assert.equal(saved.name, 'Push Day', 'the name the watch read is not put back');
  assert.equal(saved.exercises[0].sets[1].completed, true, 'the set is saved');
});

// ── The phone's own save, run through the real store ────────────────────

const STUB = `export const LtApi = globalThis.__ltApi;`;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '../lib/api.js' && context.parentURL?.endsWith('/src/stores/workout.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
    }
    return next(specifier, context);
  }`), import.meta.url);

// The Android app reads the day from its own copy first, which can be a
// moment behind the server; `copy` stands in for it.
let copy = null;
const sent = [];
globalThis.__ltApi = {
  async getWorkout(date, id = null) {
    if (copy) return { workout: structuredClone(copy) };
    return call('GET', `/api/workout/${date}${id != null ? `?id=${id}` : ''}`);
  },
  async saveWorkout(date, data) { sent.push(structuredClone(data)); return call('PUT', `/api/workout/${date}`, data); },
  async getWorkoutSessions() { return { sessions: [] }; },
  async getMyPrescriptionForDate() { return null; },
};
globalThis.window = new EventTarget();

test('a set saved on the phone from a copy older than the watch\'s finish keeps it finished', { skip: !ready }, async () => {
  const { get } = await import('svelte/store');
  const store = await import('../src/stores/workout.js');
  const date = '2026-10-25';
  await startDay(date);
  copy = null;
  await store.loadWorkout(date);
  const shown = get(store.todayLog);
  assert.equal(shown.completed, 0);
  // The watch finishes it; the phone's copy is still from before.
  copy = structuredClone(shown);
  await watchSave(date, { done: 3, details: { completed: 1, duration_min: 47.3 }, finished: true }, ['completed', 'duration_min']);
  await heardFor(300);
  // A set changed on the phone, against the screen it has.
  const next = structuredClone(shown);
  next.exercises[0].sets[1].reps = 6;
  const saved = await store.saveWorkout(date, next);
  const body = sent.at(-1);
  assert.equal(body.completed, 0, 'the phone sends what its copy says');
  assert.deepEqual(body.changed_fields, [], 'and says it changed none of the details');
  assert.equal(saved.completed, 1, 'so the server keeps the workout finished');
  assert.equal(saved.duration_min, 47.3);
  assert.equal(saved.exercises[0].sets[1].reps, 6, 'with the set as the phone changed it');
  copy = null;
});

test('a detail the phone did change still counts, and a queued save counts all it sends', { skip: !ready }, async () => {
  const { get } = await import('svelte/store');
  const store = await import('../src/stores/workout.js');
  const date = '2026-10-26';
  await startDay(date);
  await store.loadWorkout(date);
  const next = { ...structuredClone(get(store.todayLog)), notes: 'heavy day' };
  const saved = await store.saveWorkout(date, next);
  assert.deepEqual(sent.at(-1).changed_fields, ['notes']);
  assert.equal(saved.notes, 'heavy day');
  // A queued save (X-Edited-At) says what it changed in its header, or
  // counts everything it sends: the body's list isn't read for it.
  const { workout } = await call('GET', `/api/workout/${date}`);
  const later = new Date(Date.now() + 1000).toISOString();
  const replay = (await call('PUT', `/api/workout/${date}`, { ...workout, name: 'Renamed offline', changed_fields: [] }, { 'X-Edited-At': later })).workout;
  assert.equal(replay.name, 'Renamed offline');
});
