/**
 * Rows deleted elsewhere (a third-party client's POST /api/sync/push with
 * deleted_at, or a backup restored with such a row in it) meeting an edit,
 * against the real server (server/index.js on a scratch database): workouts,
 * exercises, programs and workout days. Body-stats days are in
 * body-stats-revive.test.js; this is the same rule for the other tables
 * (lib/newer-wins.js editBringsBack):
 *   - an edit made before the delete (or in its own second): the row stays
 *     deleted, nothing is written into it, REST answers 410 `gone: true` and
 *     a push touches the row so the device gets the delete;
 *   - an edit made after it, or now (no time): the row is back, with the
 *     delete's time replaced by the revive's in field_times.deleted_at;
 *   - a delete pushed keeps its own time in field_times.deleted_at, and a
 *     second one doesn't move it.
 * A program and its days: a day is edited against its own delete and its
 * program's; a program's edit revives that program row alone.
 *
 * Before: a push (and PUT, for programs and days) wrote into the deleted row
 * and left deleted_at set, so a pull handed phones the deleted row with the
 * new content and they dropped it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let Database = null;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); Database = D; } catch { /* server packages missing: skip */ }
const skip = Database ? false : 'needs the server dependencies';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
let proc = null, base = null, dir = null, token = null, userId = null;

async function call(method, path, body, headers = {}, auth = token, root = base) {
  const r = await fetch(root + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function ok(method, path, body, headers, auth) {
  const r = await call(method, path, body, headers, auth);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
const iso = (ms) => new Date(ms).toISOString();
const nextSecond = async () => { const t = Math.ceil((Date.now() + 1) / 1000) * 1000 + 30; while (Date.now() < t) await sleep(5); };
let n = 0;
const DAY = () => new Date(Date.now() - (++n) * 864e5).toISOString().slice(0, 10);
const pullAll = (get = call) => get('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
const pulledRow = async (table, id) => (await ok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`))[table].find((r) => r.id === id);
const push = (body) => ok('POST', '/api/sync/push', body);
const rawDb = () => new Database(join(dir, 'lt.db'));
const raw = (sql, ...args) => { const db = rawDb(); try { return db.prepare(sql).get(...args); } finally { db.close(); } };
const times = (table, id) => JSON.parse(raw(`SELECT field_times FROM ${table} WHERE id = ?`, id).field_times || '{}');
const exercisesOf = (row) => (typeof row.exercises === 'string' ? JSON.parse(row.exercises) : row.exercises);
const gone = (r) => r.status === 410 && r.data?.gone === true;

test.before(async () => {
  if (!Database) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-deleted-rows-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'deleted-rows-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  await ok('POST', '/api/auth/register', { username: 'sam', password: PW, full_name: 'Sam Lee' }, {}, null);
  const login = await ok('POST', '/api/auth/login', { username: 'sam', password: PW }, {}, null);
  token = login.token;
  userId = (login.user || (await ok('GET', '/api/auth/me'))).id;
});
test.after(async () => {
  try {
    if (proc && proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// A row made, then deleted by a third-party push at `deleteAt`. `before` is a
// time before the delete, `after` one after it.
async function afterDelete(make, table, key) {
  const row = await make();
  await nextSecond();
  const before = iso(Date.now());
  await nextSecond();
  const deleteAt = iso(Date.now());
  await push({ [table]: [{ client_id: 1, server_id: row.id, ...(key ? { date: row.date } : {}), deleted_at: deleteAt, updated_at: deleteAt }] });
  assert.ok((await pulledRow(table, row.id)).deleted_at, 'deleted');
  await nextSecond();
  const after = iso(Date.now());
  return { row, id: row.id, before, deleteAt, after };
}

// ── workouts: POST /api/sync/push by server_id ───────────────────────────

const lift = (reps, extra = {}) => ({ exercise_id: null, name: 'Squat', sets: [{ reps, weight: 100, completed: true }], ...extra });
const makeWorkout = async () => {
  const date = DAY();
  const r = await ok('PUT', `/api/workout/${date}`, { name: 'Leg Day', notes: 'felt good', exercises: [lift(5)] });
  return { id: r.workout.id, date, name: 'Leg Day' };
};
const deletedWorkout = () => afterDelete(makeWorkout, 'workout_log', true);
const workoutRow = async (id) => pulledRow('workout_log', id);

test('workout push: an edit made before the delete writes nothing; the device gets the deleted workout', { skip }, async () => {
  const { id, row, before } = await deletedWorkout();
  const was = await workoutRow(id);
  await nextSecond();
  const r = await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Old Edit', notes: 'edited early', exercises: [lift(8)], updated_at: before }] });
  assert.equal(r.workout_log[0].server_id, id, 'answered, so the device stops sending it');
  const now = await workoutRow(id);
  assert.ok(now.deleted_at, 'still deleted');
  assert.equal(now.name, 'Leg Day');
  assert.equal(now.notes, 'felt good');
  assert.equal(exercisesOf(now)[0].sets[0].reps, 5, 'nothing written into it');
  assert.ok(now.updated_at > was.updated_at, 'touched, so the device gets the deleted workout');
});

test('workout push: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { id, row, deleteAt } = await deletedWorkout();
  await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Tie', updated_at: deleteAt }] });
  const now = await workoutRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, 'Leg Day');
});

test('workout push: an edit made after the delete brings the workout back', { skip }, async () => {
  const { id, row, after } = await deletedWorkout();
  const r = await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Revived', exercises: [lift(9)], updated_at: after, changed_fields: ['name', 'exercises'] }] });
  assert.equal(r.workout_log[0].server_id, id);
  const now = await workoutRow(id);
  assert.equal(now.deleted_at, null, 'live again for every device');
  assert.equal(now.name, 'Revived');
  assert.equal(now.notes, 'felt good', 'what the edit did not touch is as it was');
  assert.ok(exercisesOf(now).length >= 1);
  const t = times('workout_log', id);
  assert.ok(Date.parse(t.deleted_at) >= Date.parse(after), 'the revive is stamped, so a delete made before it loses');
  assert.equal((await call('GET', `/api/workout/${row.date}`)).data.workout.name, 'Revived');
});

test('workout push: a copy made now (no time) brings the workout back', { skip }, async () => {
  const { id, row } = await deletedWorkout();
  await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Now' }] });
  const now = await workoutRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Now');
});

test('workout push: a delete made before the workout came back loses to it; a later one wins', { skip }, async () => {
  const { id, row, deleteAt, after } = await deletedWorkout();
  await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Back', updated_at: after, changed_fields: ['name'] }] });
  await nextSecond();
  await push({ workout_log: [{ client_id: 1, server_id: id, date: row.date, deleted_at: iso(Date.parse(deleteAt) + 100), updated_at: iso(Date.parse(deleteAt) + 100) }] });
  assert.equal((await workoutRow(id)).deleted_at, null, 'the later edit keeps the workout');
  await nextSecond();
  const second = iso(Date.now());
  await nextSecond();
  await push({ workout_log: [{ client_id: 1, server_id: id, date: row.date, deleted_at: second, updated_at: second }] });
  assert.ok((await workoutRow(id)).deleted_at, 'a delete after the edit goes through');
  const old = await push({ workout_log: [{ client_id: 7, server_id: id, date: row.date, name: 'Older', updated_at: after, changed_fields: ['name'] }] });
  assert.equal(old.workout_log[0].server_id, id);
  assert.ok((await workoutRow(id)).deleted_at, 'an edit older than this delete is gone');
  assert.equal((await workoutRow(id)).name, 'Back');
});

test('workout push: a second delete does not move the first one\'s time', { skip }, async () => {
  const { id, row, deleteAt, after } = await deletedWorkout();
  const first = (await workoutRow(id)).deleted_at;
  assert.equal(times('workout_log', id).deleted_at, deleteAt, 'the pushed delete is stamped with its own time');
  await nextSecond();
  await push({ workout_log: [{ client_id: 1, server_id: id, date: row.date, deleted_at: after, updated_at: after }] });
  assert.equal((await workoutRow(id)).deleted_at, first);
  assert.equal(times('workout_log', id).deleted_at, deleteAt);
});

test('workout: REST PUT keeps answering 410 for an older edit and reviving for a newer one', { skip }, async () => {
  const { row, before, after } = await deletedWorkout();
  const old = await call('PUT', `/api/workout/${row.date}`, { id: row.id, name: 'Early' }, { 'X-Edited-At': before, 'X-Changed-Fields': 'name' });
  assert.ok(gone(old), `${old.status}`);
  const fresh = await call('PUT', `/api/workout/${row.date}`, { id: row.id, name: 'Late' }, { 'X-Edited-At': after, 'X-Changed-Fields': 'name' });
  assert.equal(fresh.status, 200);
  assert.equal((await workoutRow(row.id)).deleted_at, null);
});

test('workout push: a workout that was never deleted is written as before', { skip }, async () => {
  const w = await makeWorkout();
  await nextSecond();
  await push({ workout_log: [{ client_id: 7, server_id: w.id, date: w.date, name: 'Plain', updated_at: iso(Date.now()), changed_fields: ['name'] }] });
  const now = await workoutRow(w.id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Plain');
  assert.equal(times('workout_log', w.id).deleted_at, undefined, 'a live workout has no delete stamp');
});

// ── exercises: POST /api/sync/push ───────────────────────────────────────

const makeExercise = async () => ok('POST', '/api/exercises', { name: `Cable Row ${++n}`, category: 'strength', primary_muscles: ['back'], equipment: ['cable'], instructions: 'pull' });
const deletedExercise = () => afterDelete(makeExercise, 'exercises');
const exRow = (id) => pulledRow('exercises', id);

test('exercise push: an edit made before the delete writes nothing; the device gets the deleted exercise', { skip }, async () => {
  const { id, row, before } = await deletedExercise();
  const was = await exRow(id);
  await nextSecond();
  const r = await push({ exercises: [{ client_id: 7, server_id: id, name: 'Early Name', instructions: 'early', updated_at: before }] });
  assert.equal(r.exercises[0].server_id, id);
  const now = await exRow(id);
  assert.ok(now.deleted_at, 'still deleted');
  assert.equal(now.name, row.name);
  assert.equal(now.instructions, 'pull');
  assert.ok(now.updated_at > was.updated_at, 'touched, so the device gets the deleted exercise');
});

test('exercise push: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { id, row, deleteAt } = await deletedExercise();
  await push({ exercises: [{ client_id: 7, server_id: id, name: 'Tie', updated_at: deleteAt }] });
  const now = await exRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, row.name);
});

test('exercise push: an edit made after the delete brings the exercise back', { skip }, async () => {
  const { id, after } = await deletedExercise();
  await push({ exercises: [{ client_id: 7, server_id: id, name: 'Seated Row', updated_at: after, changed_fields: ['name'] }] });
  const now = await exRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Seated Row');
  assert.equal(now.instructions, 'pull', 'what the edit did not touch is as it was');
  assert.ok(Date.parse(times('exercises', id).deleted_at) >= Date.parse(after));
  const list = (await ok('GET', '/api/exercises?search=Seated')).map((e) => e.id);
  assert.ok(list.includes(id), 'back in the library');
});

test('exercise push: a copy made now (no time) brings the exercise back', { skip }, async () => {
  const { id } = await deletedExercise();
  await push({ exercises: [{ client_id: 7, server_id: id, name: 'Now Row' }] });
  const now = await exRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Now Row');
});

test('exercise push: a delete made before the exercise came back loses to it; a later one wins', { skip }, async () => {
  const { id, deleteAt, after } = await deletedExercise();
  await push({ exercises: [{ client_id: 7, server_id: id, name: 'Back Row', updated_at: after, changed_fields: ['name'] }] });
  await nextSecond();
  await push({ exercises: [{ client_id: 1, server_id: id, deleted_at: iso(Date.parse(deleteAt) + 100), updated_at: iso(Date.parse(deleteAt) + 100) }] });
  assert.equal((await exRow(id)).deleted_at, null);
  await nextSecond();
  const second = iso(Date.now());
  await nextSecond();
  await push({ exercises: [{ client_id: 1, server_id: id, deleted_at: second, updated_at: second }] });
  assert.ok((await exRow(id)).deleted_at);
  await push({ exercises: [{ client_id: 7, server_id: id, name: 'Older Row', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await exRow(id)).name, 'Back Row');
  assert.ok((await exRow(id)).deleted_at);
});

test('exercise push: a second delete does not move the first one\'s time', { skip }, async () => {
  const { id, deleteAt, after } = await deletedExercise();
  const first = (await exRow(id)).deleted_at;
  assert.equal(times('exercises', id).deleted_at, deleteAt, 'stamped with the pushed delete\'s time');
  await nextSecond();
  await push({ exercises: [{ client_id: 1, server_id: id, deleted_at: after, updated_at: after }] });
  assert.equal((await exRow(id)).deleted_at, first);
  assert.equal(times('exercises', id).deleted_at, deleteAt);
});

test('exercise: a deleted exercise is still read by id (#49) and refused by PUT, as before', { skip }, async () => {
  const { id, after } = await deletedExercise();
  const r = await call('GET', `/api/exercises/${id}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.deleted_at);
  assert.equal((await call('PUT', `/api/exercises/${id}`, { name: 'Nope' }, { 'X-Edited-At': after })).status, 404);
  const list = (await ok('GET', '/api/exercises')).map((e) => e.id);
  assert.ok(!list.includes(id), 'not in the library while deleted');
});

test('exercise push: an exercise that was never deleted is written as before; a library one is still not', { skip }, async () => {
  const e = await makeExercise();
  await nextSecond();
  await push({ exercises: [{ client_id: 7, server_id: e.id, name: 'Plain Row', updated_at: iso(Date.now()), changed_fields: ['name'] }] });
  assert.equal((await exRow(e.id)).name, 'Plain Row');
  assert.equal(times('exercises', e.id).deleted_at, undefined);
  const db = rawDb();
  let lib;
  try { lib = db.prepare(`INSERT INTO exercises (name, source, is_global, deleted_at) VALUES ('Library Lift', 'wger', 1, datetime('now', '-1 day'))`).run().lastInsertRowid; } finally { db.close(); }
  await push({ exercises: [{ client_id: 8, server_id: lib, name: 'Hijack', updated_at: iso(Date.now()) }] });
  const row = raw('SELECT name, deleted_at FROM exercises WHERE id = ?', lib);
  assert.equal(row.name, 'Library Lift');
  assert.ok(row.deleted_at, 'a library exercise is not the account\'s to change, deleted or not');
});

// ── programs ─────────────────────────────────────────────────────────────

const makeProgram = async (extra = {}) => ok('POST', '/api/programs', { name: `Plan ${++n}`, description: 'six weeks', goal: 'strength', duration_weeks: 6, ...extra });
const makeDay = async (programId, name = `Day ${++n}`) => ok('POST', '/api/templates', { program_id: programId, name, day_label: 'A', exercises: [{ exercise_id: null, name: 'Press', sets: [{ reps: 5 }] }] });
const deletedProgram = () => afterDelete(makeProgram, 'programs');
const progRow = (id) => pulledRow('programs', id);
const dayRow = (id) => pulledRow('workout_templates', id);

test('program push: an edit made before the delete writes nothing; the device gets the deleted program', { skip }, async () => {
  const { id, row, before } = await deletedProgram();
  const was = await progRow(id);
  await nextSecond();
  const r = await push({ programs: [{ client_id: 7, server_id: id, name: 'Early', description: 'early', updated_at: before }] });
  assert.equal(r.programs[0].server_id, id);
  const now = await progRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, row.name);
  assert.equal(now.description, 'six weeks');
  assert.ok(now.updated_at > was.updated_at);
});

test('program push: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { id, row, deleteAt } = await deletedProgram();
  await push({ programs: [{ client_id: 7, server_id: id, name: 'Tie', updated_at: deleteAt }] });
  const now = await progRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, row.name);
});

test('program push: an edit made after the delete brings the program back', { skip }, async () => {
  const { id, after } = await deletedProgram();
  await push({ programs: [{ client_id: 7, server_id: id, name: 'Revived Plan', updated_at: after, changed_fields: ['name'] }] });
  const now = await progRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Revived Plan');
  assert.equal(now.description, 'six weeks');
  assert.equal(now.duration_weeks, 6);
  assert.ok(Date.parse(times('programs', id).deleted_at) >= Date.parse(after));
});

test('program push: a copy made now (no time) brings the program back', { skip }, async () => {
  const { id } = await deletedProgram();
  await push({ programs: [{ client_id: 7, server_id: id, name: 'Now Plan' }] });
  const now = await progRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Now Plan');
});

test('program push: a delete made before the program came back loses to it; a later one wins', { skip }, async () => {
  const { id, deleteAt, after } = await deletedProgram();
  await push({ programs: [{ client_id: 7, server_id: id, name: 'Back Plan', updated_at: after, changed_fields: ['name'] }] });
  await nextSecond();
  await push({ programs: [{ client_id: 1, server_id: id, deleted_at: iso(Date.parse(deleteAt) + 100), updated_at: iso(Date.parse(deleteAt) + 100) }] });
  assert.equal((await progRow(id)).deleted_at, null);
  await nextSecond();
  const second = iso(Date.now());
  await nextSecond();
  await push({ programs: [{ client_id: 1, server_id: id, deleted_at: second, updated_at: second }] });
  assert.ok((await progRow(id)).deleted_at);
  await push({ programs: [{ client_id: 7, server_id: id, name: 'Older Plan', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await progRow(id)).name, 'Back Plan');
});

test('program push: a second delete does not move the first one\'s time', { skip }, async () => {
  const { id, deleteAt, after } = await deletedProgram();
  const first = (await progRow(id)).deleted_at;
  assert.equal(times('programs', id).deleted_at, deleteAt);
  await nextSecond();
  await push({ programs: [{ client_id: 1, server_id: id, deleted_at: after, updated_at: after }] });
  assert.equal((await progRow(id)).deleted_at, first);
  assert.equal(times('programs', id).deleted_at, deleteAt);
});

test('program PUT: older is gone (410), newer or now brings it back', { skip }, async () => {
  const a = await deletedProgram();
  const old = await call('PUT', `/api/programs/${a.id}`, { name: 'Early' }, { 'X-Edited-At': a.before, 'X-Changed-Fields': 'name' });
  assert.ok(gone(old), `${old.status}`);
  const tie = await call('PUT', `/api/programs/${a.id}`, { name: 'Tie' }, { 'X-Edited-At': a.deleteAt, 'X-Changed-Fields': 'name' });
  assert.ok(gone(tie), `a tie keeps the delete: ${tie.status}`);
  assert.ok((await progRow(a.id)).deleted_at);
  assert.equal((await progRow(a.id)).name, a.row.name);
  const fresh = await call('PUT', `/api/programs/${a.id}`, { name: 'Late' }, { 'X-Edited-At': a.after, 'X-Changed-Fields': 'name' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal((await progRow(a.id)).deleted_at, null);
  assert.equal((await progRow(a.id)).name, 'Late');
  const b = await deletedProgram();
  const now = await call('PUT', `/api/programs/${b.id}`, { name: 'Web Rename' });
  assert.equal(now.status, 200);
  assert.equal((await progRow(b.id)).deleted_at, null, 'a save made now (the web, the app online) brings it back');
});

test('program PUT: a program that was never deleted saves as before', { skip }, async () => {
  const p = await makeProgram();
  const r = await call('PUT', `/api/programs/${p.id}`, { name: 'Renamed' });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Renamed');
  assert.equal(times('programs', p.id).deleted_at, undefined);
});

test('program: bringing it back leaves its days as they are, and its assignment untouched', { skip }, async () => {
  const p = await makeProgram();
  const live = await makeDay(p.id, 'Live Day');
  const dead = await makeDay(p.id, 'Dead Day');
  await ok('POST', `/api/programs/${p.id}/activate`);
  const assignment = raw('SELECT id, active FROM program_assignments WHERE program_id = ? AND assigned_to = ?', p.id, userId);
  await nextSecond();
  const dayDeleted = iso(Date.now());
  await push({ workout_templates: [{ client_id: 1, server_id: dead.id, deleted_at: dayDeleted, updated_at: dayDeleted }] });
  await nextSecond();
  const progDeleted = iso(Date.now());
  await push({ programs: [{ client_id: 1, server_id: p.id, deleted_at: progDeleted, updated_at: progDeleted }] });
  await nextSecond();
  const after = iso(Date.now());
  await push({ programs: [{ client_id: 2, server_id: p.id, name: 'Plan Again', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await progRow(p.id)).deleted_at, null);
  assert.equal((await dayRow(live.id)).deleted_at, null, 'a live day is live');
  assert.ok((await dayRow(dead.id)).deleted_at, 'a day deleted by itself stays deleted');
  assert.deepEqual(raw('SELECT id, active FROM program_assignments WHERE program_id = ? AND assigned_to = ?', p.id, userId), assignment);
  const pull = await ok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
  assert.ok(pull.keep.programs.includes(p.id) && pull.keep.workout_templates.includes(live.id));
  assert.ok(pull.program_assignments.some((a) => a.id === assignment.id && !a.deleted_at));
});

// ── workout days ─────────────────────────────────────────────────────────

const deletedDay = async () => {
  const p = await makeProgram();
  const d = await afterDelete(() => makeDay(p.id), 'workout_templates');
  return { ...d, program: p };
};

test('day push: an edit made before the delete writes nothing; the device gets the deleted day', { skip }, async () => {
  const { id, row, before } = await deletedDay();
  const was = await dayRow(id);
  await nextSecond();
  const r = await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Early', day_label: 'Z', updated_at: before }] });
  assert.equal(r.workout_templates[0].server_id, id);
  const now = await dayRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, row.name);
  assert.equal(now.day_label, 'A');
  assert.ok(now.updated_at > was.updated_at);
});

test('day push: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { id, row, deleteAt } = await deletedDay();
  await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Tie', updated_at: deleteAt }] });
  const now = await dayRow(id);
  assert.ok(now.deleted_at);
  assert.equal(now.name, row.name);
});

test('day push: an edit made after the delete brings the day back', { skip }, async () => {
  const { id, after } = await deletedDay();
  await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Day Again', updated_at: after, changed_fields: ['name'] }] });
  const now = await dayRow(id);
  assert.equal(now.deleted_at, null);
  assert.equal(now.name, 'Day Again');
  assert.equal(now.day_label, 'A');
  assert.ok(Date.parse(times('workout_templates', id).deleted_at) >= Date.parse(after));
});

test('day push: a copy made now (no time) brings the day back', { skip }, async () => {
  const { id } = await deletedDay();
  await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Now Day' }] });
  assert.equal((await dayRow(id)).deleted_at, null);
});

test('day push: a delete made before the day came back loses to it; a later one wins', { skip }, async () => {
  const { id, deleteAt, after } = await deletedDay();
  await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Back Day', updated_at: after, changed_fields: ['name'] }] });
  await nextSecond();
  await push({ workout_templates: [{ client_id: 1, server_id: id, deleted_at: iso(Date.parse(deleteAt) + 100), updated_at: iso(Date.parse(deleteAt) + 100) }] });
  assert.equal((await dayRow(id)).deleted_at, null);
  await nextSecond();
  const second = iso(Date.now());
  await nextSecond();
  await push({ workout_templates: [{ client_id: 1, server_id: id, deleted_at: second, updated_at: second }] });
  assert.ok((await dayRow(id)).deleted_at);
  await push({ workout_templates: [{ client_id: 7, server_id: id, name: 'Older Day', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await dayRow(id)).name, 'Back Day');
});

test('day push: a second delete does not move the first one\'s time', { skip }, async () => {
  const { id, deleteAt, after } = await deletedDay();
  const first = (await dayRow(id)).deleted_at;
  assert.equal(times('workout_templates', id).deleted_at, deleteAt);
  await nextSecond();
  await push({ workout_templates: [{ client_id: 1, server_id: id, deleted_at: after, updated_at: after }] });
  assert.equal((await dayRow(id)).deleted_at, first);
  assert.equal(times('workout_templates', id).deleted_at, deleteAt);
});

test('day PUT: older is gone (410), newer or now brings it back', { skip }, async () => {
  const a = await deletedDay();
  const old = await call('PUT', `/api/templates/${a.id}`, { name: 'Early' }, { 'X-Edited-At': a.before, 'X-Changed-Fields': 'name' });
  assert.ok(gone(old), `${old.status}`);
  const tie = await call('PUT', `/api/templates/${a.id}`, { name: 'Tie' }, { 'X-Edited-At': a.deleteAt, 'X-Changed-Fields': 'name' });
  assert.ok(gone(tie), `${tie.status}`);
  assert.ok((await dayRow(a.id)).deleted_at);
  assert.equal((await dayRow(a.id)).name, a.row.name);
  const fresh = await call('PUT', `/api/templates/${a.id}`, { name: 'Late' }, { 'X-Edited-At': a.after, 'X-Changed-Fields': 'name' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal((await dayRow(a.id)).deleted_at, null);
  const b = await deletedDay();
  assert.equal((await call('PUT', `/api/templates/${b.id}`, { name: 'Web Rename' })).status, 200);
  assert.equal((await dayRow(b.id)).deleted_at, null);
});

test('day PUT: a day that was never deleted saves as before', { skip }, async () => {
  const p = await makeProgram();
  const d = await makeDay(p.id);
  const r = await call('PUT', `/api/templates/${d.id}`, { name: 'Renamed Day' });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Renamed Day');
  assert.equal(times('workout_templates', d.id).deleted_at, undefined);
});

// ── a day and its program ────────────────────────────────────────────────

// A program with two days, deleted by a push at `deleteAt`; the days alive.
async function deletedProgramWithDays() {
  const p = await makeProgram();
  const a = await makeDay(p.id, 'Day A');
  const b = await makeDay(p.id, 'Day B');
  await nextSecond();
  const before = iso(Date.now());
  await nextSecond();
  const deleteAt = iso(Date.now());
  await push({ programs: [{ client_id: 1, server_id: p.id, deleted_at: deleteAt, updated_at: deleteAt }] });
  assert.ok((await progRow(p.id)).deleted_at);
  await nextSecond();
  const after = iso(Date.now());
  return { p, a, b, before, deleteAt, after };
}

test('a live day keeps its edits when its program was deleted before them; the program stays deleted', { skip }, async () => {
  const { p, a, before } = await deletedProgramWithDays();
  const r = await push({ workout_templates: [{ client_id: 7, server_id: a.id, name: 'Early', updated_at: before, changed_fields: ['name'] }] });
  assert.equal(r.workout_templates[0].server_id, a.id);
  assert.equal((await dayRow(a.id)).name, 'Early', 'a pushed delete of a program leaves its days as they are, so the day takes the edit as it always did');
  assert.equal((await dayRow(a.id)).deleted_at, null);
  assert.ok((await progRow(p.id)).deleted_at, 'only an edit made after the delete brings the program back');
  const put = await call('PUT', `/api/templates/${a.id}`, { name: 'Early 2' }, { 'X-Edited-At': before, 'X-Changed-Fields': 'name' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok((await progRow(p.id)).deleted_at);
});

test('a day edited after its program was deleted brings the program back with it, and only that day', { skip }, async () => {
  const { p, a, b, after } = await deletedProgramWithDays();
  await push({ workout_templates: [{ client_id: 7, server_id: a.id, name: 'Day A2', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await dayRow(a.id)).name, 'Day A2');
  assert.equal((await dayRow(a.id)).deleted_at, null);
  assert.equal((await progRow(p.id)).deleted_at, null, 'the program is back, so the day is not an orphan');
  assert.equal((await progRow(p.id)).name, p.name, 'its other fields are as they were');
  assert.equal((await dayRow(b.id)).name, 'Day B');
  assert.equal((await dayRow(b.id)).deleted_at, null);
  assert.ok(Date.parse(times('programs', p.id).deleted_at) >= Date.parse(after));
});

test('a day PUT after its program was deleted brings the program back', { skip }, async () => {
  const { p, a, after } = await deletedProgramWithDays();
  const r = await call('PUT', `/api/templates/${a.id}`, { name: 'Day A3' }, { 'X-Edited-At': after, 'X-Changed-Fields': 'name' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await progRow(p.id)).deleted_at, null);
  assert.equal((await dayRow(a.id)).name, 'Day A3');
});

test('a deleted day under a deleted program needs an edit newer than both', { skip }, async () => {
  const p = await makeProgram();
  const d = await makeDay(p.id, 'Day D');
  await nextSecond();
  const dayAt = iso(Date.now());
  await push({ workout_templates: [{ client_id: 1, server_id: d.id, deleted_at: dayAt, updated_at: dayAt }] });
  await nextSecond();
  const between = iso(Date.now());
  await nextSecond();
  const progAt = iso(Date.now());
  await push({ programs: [{ client_id: 1, server_id: p.id, deleted_at: progAt, updated_at: progAt }] });
  await nextSecond();
  const after = iso(Date.now());
  // After the day's delete, before the program's: the program's delete is newer, so it stays.
  await push({ workout_templates: [{ client_id: 7, server_id: d.id, name: 'Middle', updated_at: between, changed_fields: ['name'] }] });
  assert.ok((await dayRow(d.id)).deleted_at, 'the day stays deleted');
  assert.ok((await progRow(p.id)).deleted_at, 'and so does the program');
  assert.equal((await dayRow(d.id)).name, 'Day D');
  assert.ok(gone(await call('PUT', `/api/templates/${d.id}`, { name: 'Middle' }, { 'X-Edited-At': between, 'X-Changed-Fields': 'name' })));
  // After both: day and program come back.
  await push({ workout_templates: [{ client_id: 7, server_id: d.id, name: 'Last', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await dayRow(d.id)).deleted_at, null);
  assert.equal((await dayRow(d.id)).name, 'Last');
  assert.equal((await progRow(p.id)).deleted_at, null);
});

test('a deleted day edited in the same second its program was deleted stays deleted', { skip }, async () => {
  const p = await makeProgram();
  const d = await makeDay(p.id, 'Day T');
  await nextSecond();
  const dayAt = iso(Date.now());
  await push({ workout_templates: [{ client_id: 1, server_id: d.id, deleted_at: dayAt, updated_at: dayAt }] });
  await nextSecond();
  const progAt = iso(Date.now());
  await push({ programs: [{ client_id: 1, server_id: p.id, deleted_at: progAt, updated_at: progAt }] });
  await push({ workout_templates: [{ client_id: 7, server_id: d.id, name: 'Tie Day', updated_at: progAt, changed_fields: ['name'] }] });
  assert.ok((await dayRow(d.id)).deleted_at);
  assert.ok((await progRow(p.id)).deleted_at);
  assert.equal((await dayRow(d.id)).name, 'Day T');
  assert.ok(gone(await call('PUT', `/api/templates/${d.id}`, { name: 'Tie Day' }, { 'X-Edited-At': progAt, 'X-Changed-Fields': 'name' })));
});

test('a program edited after it was deleted does not bring back a day deleted on its own', { skip }, async () => {
  const p = await makeProgram();
  const d = await makeDay(p.id, 'Day E');
  await nextSecond();
  const dayAt = iso(Date.now());
  await push({ workout_templates: [{ client_id: 1, server_id: d.id, deleted_at: dayAt, updated_at: dayAt }] });
  await nextSecond();
  const progAt = iso(Date.now());
  await push({ programs: [{ client_id: 1, server_id: p.id, deleted_at: progAt, updated_at: progAt }] });
  await nextSecond();
  const after = iso(Date.now());
  await push({ programs: [{ client_id: 2, server_id: p.id, name: 'Plan Back', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await progRow(p.id)).deleted_at, null);
  assert.ok((await dayRow(d.id)).deleted_at, 'the day was deleted by itself, so it stays deleted');
});

test('a day made in a deleted program: gone if older, and it brings the program back if newer', { skip }, async () => {
  const { p, before, after } = await deletedProgramWithDays();
  const old = await call('POST', '/api/templates', { program_id: p.id, name: 'Early New' }, { 'X-Edited-At': before });
  assert.ok(gone(old), `${old.status}`);
  assert.ok((await progRow(p.id)).deleted_at);
  await push({ workout_templates: [{ client_id: 5, program_id: p.id, name: 'Early Pushed', updated_at: before }] });
  assert.ok((await progRow(p.id)).deleted_at);
  assert.ok(!(await ok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`)).workout_templates.some((t) => t.name === 'Early Pushed' || t.name === 'Early New'), 'no day made under a deleted program');
  const made = await call('POST', '/api/templates', { program_id: p.id, name: 'Late New' }, { 'X-Edited-At': after });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await progRow(p.id)).deleted_at, null, 'the new day is not an orphan');
  assert.equal((await dayRow(made.data.id)).deleted_at, null);
  const q = await deletedProgramWithDays();
  const pushed = await push({ workout_templates: [{ client_id: 6, program_id: q.p.id, name: 'Late Pushed', updated_at: q.after }] });
  assert.ok(pushed.workout_templates[0].server_id);
  assert.equal((await progRow(q.p.id)).deleted_at, null);
  assert.equal((await dayRow(pushed.workout_templates[0].server_id)).name, 'Late Pushed');
});

test('a day made in a program that was never deleted is made as before', { skip }, async () => {
  const p = await makeProgram();
  const d = await call('POST', '/api/templates', { program_id: p.id, name: 'Fresh' });
  assert.equal(d.status, 200);
  const pushed = await push({ workout_templates: [{ client_id: 6, program_id: p.id, name: 'Fresh Pushed', updated_at: iso(Date.now()) }] });
  assert.ok(pushed.workout_templates[0].server_id);
  assert.equal(times('programs', p.id).deleted_at, undefined);
});

// ── the other tables push writes ─────────────────────────────────────────

test('progress photos, set videos and Trace messages: a push writes no content into a deleted row, and a second delete moves nothing', { skip }, async () => {
  const db = rawDb();
  let photo, chat;
  try {
    photo = db.prepare(`INSERT INTO body_stat_media (user_id, date, kind, url, created_at, deleted_at) VALUES (?, '2026-02-02', 'photo', '/uploads/body-stats/x.jpg', datetime('now'), '2026-02-03 10:00:00')`).run(userId).lastInsertRowid;
    chat = db.prepare(`INSERT INTO ai_chat_history (user_id, role, content, deleted_at) VALUES (?, 'user', 'hi', '2026-02-03 10:00:00')`).run(userId).lastInsertRowid;
  } finally { db.close(); }
  await push({
    body_stat_media: [{ client_id: 1, server_id: photo, date: '2026-02-05', url: '/uploads/body-stats/y.jpg', updated_at: iso(Date.now()) }],
    ai_chat_history: [{ client_id: 1, server_id: chat, role: 'user', content: 'changed', updated_at: iso(Date.now()) }],
  });
  const p = raw('SELECT date, url, deleted_at FROM body_stat_media WHERE id = ?', photo);
  assert.deepEqual([p.date, p.url, p.deleted_at], ['2026-02-02', '/uploads/body-stats/x.jpg', '2026-02-03 10:00:00']);
  const c = raw('SELECT content, deleted_at FROM ai_chat_history WHERE id = ?', chat);
  assert.deepEqual([c.content, c.deleted_at], ['hi', '2026-02-03 10:00:00']);
});

// ── a server without user accounts (rows with no user_id) ────────────────

test('without user accounts the same holds for workouts, exercises, programs and days', { skip }, async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'lt-deleted-rows-solo-'));
  const port = await freePort();
  const sbase = `http://127.0.0.1:${port}`;
  const sproc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(sdir, 'lt.db'), UPLOADS_PATH: join(sdir, 'uploads'),
      BACKUPS_PATH: join(sdir, 'backups'), JWT_SECRET: 'deleted-rows-solo-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 300; i++) {
      if (sproc.exitCode != null) throw new Error('server exited at startup');
      try { if ((await fetch(sbase + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    const sc = (method, path, body, headers) => call(method, path, body, headers, null, sbase);
    const sok = async (method, path, body, headers) => {
      const r = await sc(method, path, body, headers);
      assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
      return r.data;
    };
    const spull = async () => (await sok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`));
    const find = async (table, id) => (await spull())[table].find((r) => r.id === id);
    const w = (await sok('PUT', '/api/workout/2026-03-03', { name: 'Solo Day', exercises: [lift(5)] })).workout;
    const e = await sok('POST', '/api/exercises', { name: 'Solo Row' });
    const p = await sok('POST', '/api/programs', { name: 'Solo Plan' });
    const d = await sok('POST', '/api/templates', { program_id: p.id, name: 'Solo Day A' });
    await nextSecond();
    const before = iso(Date.now());
    await nextSecond();
    const at = iso(Date.now());
    await sok('POST', '/api/sync/push', {
      workout_log: [{ client_id: 1, server_id: w.id, date: w.date, deleted_at: at, updated_at: at }],
      exercises: [{ client_id: 1, server_id: e.id, deleted_at: at, updated_at: at }],
      programs: [{ client_id: 1, server_id: p.id, deleted_at: at, updated_at: at }],
      workout_templates: [{ client_id: 1, server_id: d.id, deleted_at: at, updated_at: at }],
    });
    for (const [t, id] of [['workout_log', w.id], ['exercises', e.id], ['programs', p.id], ['workout_templates', d.id]]) assert.ok((await find(t, id)).deleted_at, `${t} deleted`);
    await sok('POST', '/api/sync/push', {
      workout_log: [{ client_id: 1, server_id: w.id, date: w.date, name: 'Early', updated_at: before }],
      exercises: [{ client_id: 1, server_id: e.id, name: 'Early', updated_at: before }],
      programs: [{ client_id: 1, server_id: p.id, name: 'Early', updated_at: before }],
      workout_templates: [{ client_id: 1, server_id: d.id, name: 'Early', updated_at: before }],
    });
    for (const [t, id, name] of [['workout_log', w.id, 'Solo Day'], ['exercises', e.id, 'Solo Row'], ['programs', p.id, 'Solo Plan'], ['workout_templates', d.id, 'Solo Day A']]) {
      const row = await find(t, id);
      assert.ok(row.deleted_at, `${t}: an older edit leaves it deleted`);
      assert.equal(row.name, name);
    }
    await nextSecond();
    const after = iso(Date.now());
    await sok('POST', '/api/sync/push', {
      workout_log: [{ client_id: 1, server_id: w.id, date: w.date, name: 'Late', updated_at: after, changed_fields: ['name'] }],
      exercises: [{ client_id: 1, server_id: e.id, name: 'Late', updated_at: after, changed_fields: ['name'] }],
      workout_templates: [{ client_id: 1, server_id: d.id, name: 'Late', updated_at: after, changed_fields: ['name'] }],
    });
    for (const [t, id] of [['workout_log', w.id], ['exercises', e.id], ['workout_templates', d.id], ['programs', p.id]]) {
      const row = await find(t, id);
      assert.equal(row.deleted_at, null, `${t}: a newer edit brings it back (the program with its day)`);
      if (t !== 'programs') assert.equal(row.name, 'Late');
    }
    assert.equal((await find('programs', p.id)).name, 'Solo Plan');
  } finally {
    if (sproc.exitCode == null && sproc.signalCode == null) await new Promise((r) => { sproc.once('exit', r); sproc.kill(); });
    rmSync(sdir, { recursive: true, force: true });
  }
});

// ── rows restored from a backup, or touched by an older edit ─────────────

test('a row restored deleted with no times, its updated_at later than an edit made after the delete: the edit still applies', { skip }, async () => {
  const db = rawDb();
  let prog, ex, day, work;
  try {
    // As a backup from before the times were kept restores them: deleted at
    // 2026-01-01 10:00, updated_at the restore's (now), no field_times.
    prog = db.prepare(`INSERT INTO programs (name, description, created_by, deleted_at, field_times) VALUES ('Restored Plan', 'old', ?, '2026-01-01 10:00:00', NULL)`).run(userId).lastInsertRowid;
    ex = db.prepare(`INSERT INTO exercises (name, instructions, source, is_global, created_by, deleted_at, field_times) VALUES ('Restored Row', 'old', 'custom', 0, ?, '2026-01-01 10:00:00', NULL)`).run(userId).lastInsertRowid;
    day = db.prepare(`INSERT INTO workout_templates (program_id, name, day_label, deleted_at, field_times) VALUES (?, 'Restored Day', 'old', '2026-01-01 10:00:00', NULL)`).run(prog).lastInsertRowid;
    work = db.prepare(`INSERT INTO workout_log (user_id, date, name, notes, exercises, deleted_at, field_times) VALUES (?, '2025-12-24', 'Restored Workout', 'old', '[]', '2026-01-01 10:00:00', NULL)`).run(userId).lastInsertRowid;
  } finally { db.close(); }
  const edit = '2026-01-02T10:00:00.000Z';
  const older = '2025-12-31T10:00:00.000Z';
  // An edit made before the delete leaves each deleted, touched (the touch must not
  // make the later edit older than the row's content).
  await push({
    programs: [{ client_id: 1, server_id: prog, name: 'Stale', updated_at: older }],
    exercises: [{ client_id: 1, server_id: ex, name: 'Stale', updated_at: older }],
    workout_log: [{ client_id: 1, server_id: work, date: '2025-12-24', name: 'Stale', updated_at: older }],
  });
  for (const [t, id] of [['programs', prog], ['exercises', ex], ['workout_log', work]]) {
    const row = await pulledRow(t, id);
    assert.ok(row.deleted_at, `${t} stays deleted`);
    assert.notEqual(row.name, 'Stale');
  }
  await push({
    programs: [{ client_id: 1, server_id: prog, name: 'Edited Plan', updated_at: edit, changed_fields: ['name'] }],
    exercises: [{ client_id: 1, server_id: ex, name: 'Edited Row', updated_at: edit, changed_fields: ['name'] }],
    workout_templates: [{ client_id: 1, server_id: day, name: 'Edited Day', updated_at: edit, changed_fields: ['name'] }],
    workout_log: [{ client_id: 1, server_id: work, date: '2025-12-24', name: 'Edited Workout', exercises: [lift(7)], updated_at: edit, changed_fields: ['name', 'exercises'] }],
  });
  for (const [t, id, name] of [['programs', prog, 'Edited Plan'], ['exercises', ex, 'Edited Row'], ['workout_templates', day, 'Edited Day'], ['workout_log', work, 'Edited Workout']]) {
    const row = await pulledRow(t, id);
    assert.equal(row.deleted_at, null, `${t} is back`);
    assert.equal(row.name, name, `${t}: the edit made after the delete applies`);
  }
  assert.equal(exercisesOf(await pulledRow('workout_log', work))[0].sets[0].reps, 7, 'and so do the workout\'s exercises');
  assert.equal((await pulledRow('programs', prog)).description, 'old', 'what it did not touch is as it was');
  assert.equal(times('programs', prog).deleted_at, edit, 'stamped with the edit\'s time');
});

test('the same through REST: a stale push touched the restored row, and the later edit still applies', { skip }, async () => {
  const db = rawDb();
  let prog, day, work;
  try {
    prog = db.prepare(`INSERT INTO programs (name, description, created_by, deleted_at, field_times) VALUES ('Restored Plan B', 'old', ?, '2026-01-01 10:00:00', NULL)`).run(userId).lastInsertRowid;
    day = db.prepare(`INSERT INTO workout_templates (program_id, name, day_label, deleted_at, field_times) VALUES (?, 'Restored Day B', 'old', '2026-01-01 10:00:00', NULL)`).run(prog).lastInsertRowid;
    work = db.prepare(`INSERT INTO workout_log (user_id, date, name, notes, exercises, deleted_at, field_times) VALUES (?, '2025-12-23', 'Restored Workout B', 'old', '[]', '2026-01-01 10:00:00', NULL)`).run(userId).lastInsertRowid;
  } finally { db.close(); }
  const edit = '2026-01-02T10:00:00.000Z';
  const older = '2025-12-31T10:00:00.000Z';
  await push({
    programs: [{ client_id: 1, server_id: prog, name: 'Stale', updated_at: older }],
    workout_templates: [{ client_id: 1, server_id: day, name: 'Stale', updated_at: older }],
    workout_log: [{ client_id: 1, server_id: work, date: '2025-12-23', name: 'Stale', updated_at: older }],
  });
  assert.ok(gone(await call('PUT', `/api/programs/${prog}`, { name: 'Early' }, { 'X-Edited-At': older, 'X-Changed-Fields': 'name' })));
  assert.ok(gone(await call('PUT', `/api/templates/${day}`, { name: 'Early' }, { 'X-Edited-At': older, 'X-Changed-Fields': 'name' })));
  assert.ok(gone(await call('PUT', '/api/workout/2025-12-23', { id: work, name: 'Early' }, { 'X-Edited-At': older, 'X-Changed-Fields': 'name' })));
  const h = { 'X-Edited-At': edit, 'X-Changed-Fields': 'name' };
  assert.equal((await call('PUT', `/api/programs/${prog}`, { name: 'REST Plan' }, h)).status, 200);
  assert.equal((await call('PUT', `/api/templates/${day}`, { name: 'REST Day' }, h)).status, 200);
  assert.equal((await call('PUT', '/api/workout/2025-12-23', { id: work, name: 'REST Workout' }, h)).status, 200);
  for (const [t, id, name] of [['programs', prog, 'REST Plan'], ['workout_templates', day, 'REST Day'], ['workout_log', work, 'REST Workout']]) {
    const row = await pulledRow(t, id);
    assert.equal(row.deleted_at, null, `${t} is back`);
    assert.equal(row.name, name, `${t}: the edit made after the delete applies`);
  }
  assert.equal((await pulledRow('programs', prog)).description, 'old');
});

test('an exercise cleared with its catalog keeps the clear\'s time; an older push stays out, a newer one brings it back', { skip }, async () => {
  await ok('POST', '/api/exercise-import/import-json', { catalogName: 'Gym', exercises: [{ name: 'Gym Press' }] });
  const id = raw(`SELECT id FROM exercises WHERE name = 'Gym Press' AND created_by = ?`, userId).id;
  await nextSecond();
  const before = iso(Date.now());
  await nextSecond();
  await ok('POST', '/api/exercise-import/catalogs/delete', { name: 'Gym' });
  const clearedAt = times('exercises', id).deleted_at;
  assert.ok(Number.isFinite(Date.parse(clearedAt)), 'the clear is stamped');
  await nextSecond();
  const after = iso(Date.now());
  await push({ exercises: [{ client_id: 1, server_id: id, name: 'Early', updated_at: before }] });
  assert.ok((await exRow(id)).deleted_at);
  assert.equal((await exRow(id)).name, 'Gym Press');
  await push({ exercises: [{ client_id: 1, server_id: id, name: 'Late', updated_at: after, changed_fields: ['name'] }] });
  assert.equal((await exRow(id)).deleted_at, null);
  assert.equal((await exRow(id)).name, 'Late');
});

// ── another account's rows, and a clock ahead ────────────────────────────

test('another account\'s push, newer or older, changes none of the deleted rows', { skip }, async () => {
  const bobPw = 'Str0ng-Pass-88!y';
  await ok('POST', '/api/auth/register', { username: 'bob', password: bobPw, role: 'member' });
  const bob = (await ok('POST', '/api/auth/login', { username: 'bob', password: bobPw }, {}, null)).token;
  const w = await deletedWorkout();
  const e = await deletedExercise();
  const p = await deletedProgram();
  const dd = await deletedDay();
  const bobPush = (body) => ok('POST', '/api/sync/push', body, {}, bob);
  const later = iso(Date.now() + 1000);
  const named = (n) => ({ client_id: 1, name: n, updated_at: later });
  await bobPush({
    workout_log: [{ ...named('Bob'), server_id: w.id, date: w.row.date }],
    exercises: [{ ...named('Bob'), server_id: e.id }],
    programs: [{ ...named('Bob'), server_id: p.id }],
    workout_templates: [{ ...named('Bob'), server_id: dd.id }],
  });
  for (const [t, id] of [['workout_log', w.id], ['exercises', e.id], ['programs', p.id], ['workout_templates', dd.id]]) {
    const row = raw(`SELECT name, deleted_at FROM ${t} WHERE id = ?`, id);
    assert.ok(row.deleted_at, `${t}: still deleted`);
    assert.notEqual(row.name, 'Bob');
  }
  // And he can't bring back a day of Sam's deleted program by making one in it.
  const before = raw('SELECT deleted_at FROM programs WHERE id = ?', p.id);
  await bobPush({ workout_templates: [{ client_id: 2, program_id: p.id, name: 'Bob Day', updated_at: later }] });
  assert.ok(raw('SELECT deleted_at FROM programs WHERE id = ?', p.id).deleted_at);
  assert.equal(raw(`SELECT COUNT(*) AS n FROM workout_templates WHERE name = 'Bob Day'`).n, 0);
  assert.deepEqual(raw('SELECT deleted_at FROM programs WHERE id = ?', p.id), before);
});

test('a copy dated in the future counts as made now, so it brings a deleted row back', { skip }, async () => {
  const { id, deleteAt } = await deletedProgram();
  await push({ programs: [{ client_id: 1, server_id: id, name: 'Ahead', updated_at: iso(Date.now() + 3600e3), changed_fields: ['name'] }] });
  assert.equal((await progRow(id)).deleted_at, null);
  assert.ok(Date.parse(times('programs', id).deleted_at) <= Date.now() + 5000, 'stamped no later than now');
  assert.ok(Date.parse(times('programs', id).deleted_at) > Date.parse(deleteAt));
});
