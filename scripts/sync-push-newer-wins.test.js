/**
 * POST /api/sync/push meets each row field by field, as the app's own saves
 * do (server/lib/newer-wins.js, PUT /api/workout/:date and friends).
 *
 * No LiftTrace app has ever sent it (the Android app writes through the
 * app's routes and only pulls), but the route is there for third-party
 * clients. A row may list the fields it changed (`changed_fields`), as the
 * app's saves do with X-Changed-Fields; without that list, every field it
 * sends counts as changed at its updated_at.
 * It used to write a pushed row whole whenever its updated_at was as new as
 * the server's, to the second, compared as text:
 *
 * - a copy made just before a workout was started (from Home Assistant, the
 *   API, another device), in the same second, put back its empty program,
 *   program workout, week and name;
 * - a copy an hour old, its time written with a zone offset, read as newer
 *   and overwrote everything;
 * - what it wrote wasn't stamped, so an older edit queued on a phone
 *   overwrote it afterwards;
 * - the same for exercises, programs, program days, body stats, settings.
 *
 * Against the real server (server/index.js on a scratch database).
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
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = ready ? false : 'needs the server dependencies';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
let proc = null, base = null, dir = null, token = null, apiToken = null;
let ex = null, prog = null, day = null;

async function call(method, path, body, headers = {}, auth = token) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
}
const push = (body) => call('POST', '/api/sync/push', body);
const pullAll = () => call('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
const workoutRow = async (id) => (await pullAll()).workout_log.find((w) => w.id === id);
const parsed = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const fields = (w) => ({ name: w.name, notes: w.notes, template_id: w.template_id, program_id: w.program_id, program_week: w.program_week });
// The device's copy of a pulled row, as it would push it back.
const copyOf = (w, extra) => ({
  client_id: 9, server_id: w.id, date: w.date, name: w.name, notes: w.notes, duration_min: w.duration_min,
  completed: !!w.completed, template_id: w.template_id, program_id: w.program_id, program_week: w.program_week,
  exercises: parsed(w.exercises), ...extra,
});
let n = 0;
const DAY = () => new Date(Date.now() - (++n) * 864e5).toISOString().slice(0, 10);
// Early in the next second, so a time earlier in that same second exists
// and everything done before is in an earlier one.
const freshSecond = async () => { const next = Math.ceil((Date.now() + 1) / 1000) * 1000 + 20; while (Date.now() < next) await sleep(5); };
const earlierSameSecond = (iso) => new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString();
const newWorkout = async (date, body, headers) => {
  const r = await call('PUT', `/api/workout/${date}`, { exercises: [], ...body }, headers);
  return r.id ?? r.workout?.id;
};

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-sync-push-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'sync-push-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  await call('POST', '/api/auth/register', { username: 'sam', password: PW, full_name: 'Sam Lee' }, {}, null);
  token = (await call('POST', '/api/auth/login', { username: 'sam', password: PW }, {}, null)).token;
  apiToken = (await call('POST', '/api/admin/api-tokens', { name: 'Home Assistant', scopes: ['mcp:read', 'mcp:write'] })).raw;
  ex = await call('POST', '/api/exercises', { name: 'Ring Dips', set_type: 'reps' });
  prog = await call('POST', '/api/programs', { name: 'Push Plan', duration_weeks: 4 });
  day = await call('POST', '/api/templates', { program_id: prog.id, name: 'Day A', exercises: [{ exercise_id: ex.id, exercise_name: ex.name, target_sets: 3, target_reps: '8', target_weight: '40' }] });
  await call('POST', `/api/programs/${prog.id}/activate`);
});
test.after(async () => {
  try {
    if (proc && proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('a copy made just before a workout was started can\'t clear its program', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Morning', notes: 'Felt good' });
  const copy = await workoutRow(id);
  await freshSecond();
  const started = await call('POST', `/api/v1/workouts/${d}/start`, {}, {}, apiToken);
  assert.equal(started.workout_id, id, 'started into the empty workout');
  const stamp = JSON.parse((await workoutRow(id)).field_times).program_id;
  // The phone's notes edit, made a moment before the start, in that second.
  const editedAt = earlierSameSecond(stamp);
  assert.ok(Date.parse(editedAt) < Date.parse(stamp));
  await push({ workout_log: [copyOf(copy, { notes: 'Felt great', updated_at: editedAt })] });
  const after = await workoutRow(id);
  assert.deepEqual(fields(after), { name: 'Day A', notes: 'Felt great', template_id: day.id, program_id: prog.id, program_week: started.program_week ?? 1 },
    'the start stays; the notes edit, newer than the notes, goes in');
  assert.equal(parsed(after.exercises)[0].sets.length, 3, 'the planned sets stay');
});

test('a copy edited after a start it never saw: listing what it changed keeps the start', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Copy', notes: 'a' });
  const copy = await workoutRow(id);
  await call('POST', `/api/v1/workouts/${d}/start`, {}, {}, apiToken);
  await sleep(5);
  // Edited after the start, from a copy pulled before it, saying it changed
  // only the notes: what it only carried along stays as the server has it.
  await push({ workout_log: [copyOf(copy, { notes: 'b', changed_fields: ['notes'], updated_at: new Date().toISOString() })] });
  const after = await workoutRow(id);
  assert.deepEqual([after.notes, after.name, after.program_id, after.template_id], ['b', 'Day A', prog.id, day.id]);
  // An empty list changes nothing but the exercises' merge.
  await push({ workout_log: [copyOf(copy, { notes: 'c', changed_fields: [], updated_at: new Date().toISOString() })] });
  assert.equal((await workoutRow(id)).notes, 'b');
});

test('an hour-old copy written with a zone offset changes nothing', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Evening', notes: 'Old note' });
  const copy = await workoutRow(id);
  await call('POST', `/api/v1/workouts/${d}/start`, {}, {}, apiToken);
  const before = await workoutRow(id);
  // An hour ago, as a phone five hours east of UTC writes it.
  const hourAgo = new Date(Date.now() - 3600e3 + 5 * 3600e3).toISOString().replace('Z', '+05:00');
  await push({ workout_log: [copyOf(copy, { notes: 'Older note', updated_at: hourAgo })] });
  const after = await workoutRow(id);
  assert.deepEqual(fields(after), fields(before));
  assert.equal(after.notes, 'Old note');
});

test('what a push writes is stamped: an older queued edit can\'t overwrite it', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Noon', notes: 'First' }, { 'X-Edited-At': new Date(Date.now() - 120e3).toISOString() });
  const copy = await workoutRow(id);
  const pushedAt = new Date().toISOString();
  await push({ workout_log: [copyOf(copy, { notes: 'Pushed now', updated_at: pushedAt })] });
  assert.equal(JSON.parse((await workoutRow(id)).field_times).notes, pushedAt, 'stamped with the row\'s own time');
  await call('PUT', `/api/workout/${d}`, { id, name: 'Noon', notes: 'Queued 30 s ago', exercises: [] },
    { 'X-Edited-At': new Date(Date.now() - 30e3).toISOString(), 'X-Changed-Fields': 'notes' });
  assert.equal((await workoutRow(id)).notes, 'Pushed now');
});

test('a newer push still wins, the program trio together, and an older one changes nothing', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Late', notes: 'n' });
  await call('POST', `/api/v1/workouts/${d}/start`, {}, {}, apiToken);
  const row = await workoutRow(id);
  // Edited on the phone after the start: taken off the program, renamed.
  await sleep(5);
  await push({ workout_log: [copyOf(row, { name: 'Just Dips', template_id: null, program_id: null, program_week: null, duration_min: 30, completed: true, updated_at: new Date().toISOString() })] });
  let after = await workoutRow(id);
  assert.deepEqual([after.name, after.template_id, after.program_id, after.program_week, after.duration_min, after.completed], ['Just Dips', null, null, null, 30, 1]);
  // A week-old copy: nothing.
  await push({ workout_log: [copyOf(row, { name: 'Stale', updated_at: new Date(Date.now() - 7 * 864e5).toISOString() })] });
  after = await workoutRow(id);
  assert.equal(after.name, 'Just Dips');
  // Server times as the server writes them still compare: an older one loses.
  await push({ workout_log: [copyOf(row, { name: 'Stale 2', updated_at: '2020-01-01 00:00:00' })] });
  assert.equal((await workoutRow(id)).name, 'Just Dips');
});

test('a pushed new workout is stamped as made at its own time', { skip }, async () => {
  const d = DAY();
  const madeAt = new Date(Date.now() - 60e3).toISOString();
  const r = await push({ workout_log: [{ client_id: 5, date: d, name: 'Offline', notes: 'x', exercises: [], updated_at: madeAt }] });
  const id = r.workout_log[0].server_id;
  assert.equal(JSON.parse((await workoutRow(id)).field_times)._base, madeAt);
  // An edit queued before it was made can't overwrite it; one made after can.
  await call('PUT', `/api/workout/${d}`, { id, name: 'Before', notes: 'x', exercises: [] }, { 'X-Edited-At': new Date(Date.now() - 120e3).toISOString(), 'X-Changed-Fields': 'name' });
  assert.equal((await workoutRow(id)).name, 'Offline');
  await call('PUT', `/api/workout/${d}`, { id, name: 'After', notes: 'x', exercises: [] }, { 'X-Edited-At': new Date(Date.now() - 30e3).toISOString(), 'X-Changed-Fields': 'name' });
  assert.equal((await workoutRow(id)).name, 'After');
});

test('a pushed delete made before a later edit leaves the workout, and the device gets it back', { skip }, async () => {
  const d = DAY();
  const id = await newWorkout(d, { name: 'Keep Me', notes: 'n' });
  const copy = await workoutRow(id);
  await freshSecond();
  await call('PUT', `/api/workout/${d}`, { id, name: 'Keep Me', notes: 'edited', exercises: [] });
  const stamp = JSON.parse((await workoutRow(id)).field_times).notes;
  await sleep(1100);
  const pulledAt = (await pullAll()).server_time;
  await push({ workout_log: [copyOf(copy, { deleted_at: earlierSameSecond(stamp), updated_at: earlierSameSecond(stamp) })] });
  const after = await workoutRow(id);
  assert.equal(after.deleted_at, null, 'kept');
  const next = await call('GET', `/api/sync/pull?since=${encodeURIComponent(pulledAt)}`);
  assert.ok(next.workout_log.some((w) => w.id === id), 'in the next pull, so the device gets it back');
  // A delete made after the last edit goes ahead.
  await push({ workout_log: [copyOf(after, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })] });
  assert.ok((await workoutRow(id)).deleted_at);
});

test('the other tables push writes: a copy from before a newer edit leaves that edit', { skip }, async () => {
  const d = DAY();
  const p0 = await pullAll();
  const exRow = p0.exercises.find((e) => e.id === ex.id);
  const progRow = p0.programs.find((p) => p.id === prog.id);
  const dayRow = p0.workout_templates.find((t) => t.id === day.id);
  await call('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } });
  await call('PUT', '/api/settings', { key: 'restDuration', value: 90 });
  await freshSecond();
  await call('PUT', `/api/exercises/${ex.id}`, { name: 'Ring Dips', tips: 'New tip' });
  await call('PUT', `/api/programs/${prog.id}`, { name: 'Push Plan', description: 'New description' });
  await call('PUT', `/api/templates/${day.id}`, { day_label: 'Mon' });
  await call('PUT', `/api/body-stats/${d}`, { stats: { weight: 81 } });
  await call('PUT', '/api/settings', { key: 'restDuration', value: 120 });
  const p1 = await pullAll();
  const at = earlierSameSecond(JSON.parse(p1.exercises.find((e) => e.id === ex.id).field_times).tips);
  await push({
    exercises: [{ ...exRow, client_id: 1, server_id: ex.id, tips: null, instructions: 'Lean forward', updated_at: at }],
    programs: [{ ...progRow, client_id: 2, server_id: prog.id, description: null, goal: 'strength', updated_at: at }],
    workout_templates: [{ ...dayRow, client_id: 3, server_id: day.id, day_label: null, name: 'Day A (old)', exercises: parsed(dayRow.exercises), updated_at: at }],
    body_stats_log: [{ client_id: 4, date: d, stats: { weight: 80, waist: 89 }, updated_at: at }],
    user_settings: [{ key: 'restDuration', value: '90', updated_at: at }],
  });
  const p2 = await pullAll();
  const e2 = p2.exercises.find((e) => e.id === ex.id);
  assert.deepEqual([e2.tips, e2.instructions], ['New tip', 'Lean forward'], 'the newer tip stays; the instructions, not edited since, go in');
  const pr2 = p2.programs.find((p) => p.id === prog.id);
  assert.deepEqual([pr2.description, pr2.goal], ['New description', 'strength']);
  const t2 = p2.workout_templates.find((t) => t.id === day.id);
  assert.deepEqual([t2.day_label, t2.name], ['Mon', 'Day A (old)']);
  const b2 = parsed(p2.body_stats_log.find((b) => b.date === d).stats);
  assert.deepEqual([b2.weight, b2.waist], [81, 89], 'the newer weight stays; the waist goes in');
  const s2 = p2.user_settings.find((s) => s.key === 'restDuration');
  assert.equal(JSON.parse(s2.value), 120);
});
