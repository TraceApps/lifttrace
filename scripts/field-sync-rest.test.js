/**
 * LiftTrace on the rule every Trace app shares (server/lib/field-sync.js
 * through server/lib/newer-wins.js): the newer edit of each field stays, on
 * every route that writes a row and on POST /api/sync/push.
 *
 * What went wrong before, each case below:
 * - a save that sent a whole form (the web, the app online) stamped every
 *   field it sent, changed or not, so an older edit queued offline of a
 *   field nobody else had changed was dropped;
 * - two edits queued offline for one row went up as one, every field at the
 *   later edit's time, so the earlier one beat a newer edit made elsewhere;
 * - POST /api/sync/push dropped a whole row older than the server's
 *   updated_at, which housekeeping and edits of other fields move;
 * - a workout save queued offline before the workout was deleted elsewhere
 *   brought it back;
 * - a measurement logged by MCP (Home Assistant, Trace) wasn't stamped, so
 *   an older measurement queued on a phone overwrote it;
 * - a set logged by MCP wasn't stamped either, so a delete made offline
 *   before it removed the workout and the set.
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
import { collapseOps } from '../src/lib/offline-edits.js';
import * as edits from '../src/lib/offline-edits.js';

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

async function call(method, path, body, headers = {}, auth = token) {
  const r = await fetch(base + path, {
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
// The next whole second has begun: times taken before are in earlier seconds.
const nextSecond = async () => { const t = Math.ceil((Date.now() + 1) / 1000) * 1000 + 30; while (Date.now() < t) await sleep(5); };
let n = 0;
const DAY = () => new Date(Date.now() - (++n) * 864e5).toISOString().slice(0, 10);
const pullAll = () => ok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
// What the web outbox sends for a queued op (src/lib/offline-api.js).
const opHeaders = (op) => (typeof edits.opHeaders === 'function' ? edits.opHeaders(op) : {
  ...(op.editedAt ? { 'X-Edited-At': op.editedAt } : {}),
  ...(Array.isArray(op.changed) ? { 'X-Changed-Fields': op.changed.join(',') } : {}),
});

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-field-sync-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'field-sync-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  await ok('POST', '/api/auth/register', { username: 'sam', password: PW, full_name: 'Sam Lee' }, {}, null);
  token = (await ok('POST', '/api/auth/login', { username: 'sam', password: PW }, {}, null)).token;
  apiToken = (await ok('POST', '/api/admin/api-tokens', { name: 'Home Assistant', scopes: ['mcp:read', 'mcp:write', 'mcp:destroy'] })).raw;
});
test.after(async () => {
  try {
    if (proc && proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function mcp(name, args) {
  const r = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(line ? line.slice(5) : text);
  assert.ok(!msg.error && !msg.result?.isError, `${name}: ${text.slice(0, 300)}`);
  return msg.result;
}

test('a whole form saved elsewhere leaves an older offline edit of another field alone', { skip }, async () => {
  const p = await ok('POST', '/api/programs', { name: 'Plan A', description: 'first', duration_weeks: 4 });
  await nextSecond();
  const phoneAt = iso(Date.now()); // the description, changed offline now
  await nextSecond();
  // The web saves its whole form, the name changed (no headers: made now).
  await ok('PUT', `/api/programs/${p.id}`, { name: 'Plan B', description: 'first', goal: p.goal, visibility: p.visibility, duration_weeks: 4, advance_mode: p.advance_mode, on_complete: p.on_complete });
  // The phone's queued edit arrives.
  await ok('PUT', `/api/programs/${p.id}`, { name: 'Plan A', description: 'changed offline' }, { 'X-Edited-At': phoneAt, 'X-Changed-Fields': 'description' });
  const now = await ok('GET', `/api/programs/${p.id}`);
  assert.equal(now.name, 'Plan B', 'the newer rename stays');
  assert.equal(now.description, 'changed offline', 'nobody else changed the description: the phone\'s edit goes in');
});

// A change queued in this browser, as offline-api.js queues it.
const queued = (seq, method, path, body, at, changed) => ({ seq, method, path, body, at, editedAt: iso(at), ...edits.writeOp(method, path, body), ...(changed === undefined ? {} : { changed }) });

test('two edits queued for one row keep their own times', { skip }, async () => {
  const ex = await ok('POST', '/api/exercises', { name: 'Row', tips: 'x' });
  await nextSecond();
  const t1 = Date.now();
  await nextSecond();
  const t2 = Date.now();
  await nextSecond();
  const t3 = Date.now();
  // Offline: the name at t1, the tips at t3. Elsewhere, at t2: the name.
  const ops = collapseOps([
    queued(1, 'PUT', `/api/exercises/${ex.id}`, { name: 'Row (offline)', tips: 'x' }, t1, ['name']),
    queued(2, 'PUT', `/api/exercises/${ex.id}`, { name: 'Row (offline)', tips: 'y' }, t3, ['tips']),
  ]);
  assert.equal(ops.length, 1, 'one request');
  await ok('PUT', `/api/exercises/${ex.id}`, { name: 'Row (web)' }, { 'X-Edited-At': iso(t2), 'X-Changed-Fields': 'name' });
  await ok(ops[0].method, ops[0].path, ops[0].body, opHeaders(ops[0]));
  const now = (await ok('GET', `/api/exercises/${ex.id}`));
  assert.equal(now.name, 'Row (web)', 'the rename elsewhere is newer than the offline one');
  assert.equal(now.tips, 'y');
});

test('an edit queued by an older app and one queued after, sent as one, keep their times', { skip }, async () => {
  const ex = await ok('POST', '/api/exercises', { name: 'Fly', tips: 'a' });
  await nextSecond();
  const t1 = Date.now();
  await nextSecond();
  const t2 = Date.now();
  await nextSecond();
  const t3 = Date.now();
  // Queued by the version before (no list: all it sends) at t1, then by
  // this one at t3 (the tips).
  const ops = collapseOps([
    queued(1, 'PUT', `/api/exercises/${ex.id}`, { name: 'Fly (old app)', tips: 'a' }, t1),
    queued(2, 'PUT', `/api/exercises/${ex.id}`, { name: 'Fly (old app)', tips: 'b' }, t3, ['tips']),
  ]);
  assert.equal(ops.length, 1, 'one request');
  await ok('PUT', `/api/exercises/${ex.id}`, { name: 'Fly (web)' }, { 'X-Edited-At': iso(t2), 'X-Changed-Fields': 'name' });
  await ok(ops[0].method, ops[0].path, ops[0].body, opHeaders(ops[0]));
  const now = await ok('GET', `/api/exercises/${ex.id}`);
  assert.equal(now.name, 'Fly (web)', 'the old op\'s name is from t1, older than the web\'s');
  assert.equal(now.tips, 'b');
});

test('push: a row older than the server\'s updated_at still changes the fields nobody else did', { skip }, async () => {
  const p = await ok('POST', '/api/programs', { name: 'Core', description: 'one', duration_weeks: 4 });
  const copy = (await pullAll()).programs.find((r) => r.id === p.id);
  await nextSecond();
  const phoneAt = iso(Date.now());
  await nextSecond();
  await ok('PUT', `/api/programs/${p.id}`, { name: 'Core (web)' }, { 'X-Changed-Fields': 'name' });
  await ok('POST', '/api/sync/push', { programs: [{ client_id: 5, server_id: p.id, name: copy.name, description: 'two (phone)', goal: copy.goal, visibility: copy.visibility, duration_weeks: copy.duration_weeks, advance_mode: copy.advance_mode, on_complete: copy.on_complete, updated_at: phoneAt, changed_fields: ['description'] }] });
  const now = await ok('GET', `/api/programs/${p.id}`);
  assert.equal(now.name, 'Core (web)');
  assert.equal(now.description, 'two (phone)', 'the description changed only on the phone');
});

test('push: per-field edit times (field_edits) keep a field edited earlier at its own time', { skip }, async () => {
  const p = await ok('POST', '/api/programs', { name: 'Back', description: 'one', duration_weeks: 4 });
  const copy = (await pullAll()).programs.find((r) => r.id === p.id);
  await nextSecond();
  const t1 = iso(Date.now());
  await nextSecond();
  await ok('PUT', `/api/programs/${p.id}`, { name: 'Back (web)' }, { 'X-Changed-Fields': 'name' });
  await nextSecond();
  const t3 = iso(Date.now());
  await ok('POST', '/api/sync/push', { programs: [{ client_id: 5, server_id: p.id, name: 'Back (phone)', description: 'two', goal: copy.goal, visibility: copy.visibility, duration_weeks: copy.duration_weeks, advance_mode: copy.advance_mode, on_complete: copy.on_complete, updated_at: t3, changed_fields: ['name', 'description'], field_edits: { name: t1, description: t3 } }] });
  const now = await ok('GET', `/api/programs/${p.id}`);
  assert.equal(now.name, 'Back (web)', 'the phone renamed it before the web did');
  assert.equal(now.description, 'two');
});

test('a workout save queued before the workout was deleted elsewhere doesn\'t bring it back', { skip }, async () => {
  const d = DAY();
  const w = await ok('PUT', `/api/workout/${d}`, { name: 'Pull', exercises: [] });
  const id = w.id ?? w.workout?.id;
  await nextSecond();
  const phoneAt = iso(Date.now());
  await nextSecond();
  await ok('DELETE', `/api/workout/${d}?id=${id}`);
  const r = await call('PUT', `/api/workout/${d}`, { id, name: 'Pull (offline)', exercises: [] }, { 'X-Edited-At': phoneAt, 'X-Changed-Fields': 'name' });
  assert.ok(r.status === 410 && r.data?.gone === true, `answered as gone: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const row = (await pullAll()).workout_log.find((x) => x.id === id);
  assert.ok(row.deleted_at, 'still deleted');
  // An edit made after the delete (or now, online) still brings it back.
  await ok('PUT', `/api/workout/${d}`, { id, name: 'Pull again', exercises: [] });
  const back = (await pullAll()).workout_log.find((x) => x.id === id);
  assert.equal(back.deleted_at, null);
  assert.equal(back.name, 'Pull again');
});

test('a measurement logged by MCP beats an older one queued on a phone', { skip }, async () => {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } });
  await nextSecond();
  const phoneAt = iso(Date.now());
  await nextSecond();
  await mcp('log_body_stat', { date: d, weight: 79 });
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 81, waist: 89 } }, { 'X-Edited-At': phoneAt, 'X-Changed-Fields': 'weight,waist' });
  const day = (await pullAll()).body_stats_log.find((b) => b.date === d);
  const stats = typeof day.stats === 'string' ? JSON.parse(day.stats) : day.stats;
  assert.equal(stats.weight, 79, 'MCP logged the weight after the phone');
  assert.equal(stats.waist, 89, 'only the phone changed the waist');
});

test('a set logged by MCP after an offline delete keeps the workout', { skip }, async () => {
  const d = DAY();
  const ex = await ok('POST', '/api/exercises', { name: `Curl ${n}` });
  const w = await ok('PUT', `/api/workout/${d}`, { name: 'Arms', exercises: [] });
  const id = w.id ?? w.workout?.id;
  await nextSecond();
  const phoneAt = iso(Date.now());
  await nextSecond();
  await mcp('log_set', { date: d, exercise_id: ex.id, reps: 10, weight: 20 });
  const r = await call('DELETE', `/api/workout/${d}?id=${id}`, null, { 'X-Edited-At': phoneAt });
  assert.equal(r.status, 409, `the delete is older than the set: ${r.status}`);
  const row = (await pullAll()).workout_log.find((x) => x.id === id);
  assert.equal(row.deleted_at, null);
});

test('no answer carries field_times', { skip }, async () => {
  const d = DAY();
  const p = await ok('POST', '/api/programs', { name: 'Leak', duration_weeks: 2 }, { 'X-Edited-At': iso(Date.now()) });
  await ok('PUT', `/api/programs/${p.id}`, { name: 'Leak 2' });
  await ok('PUT', `/api/workout/${d}`, { name: 'Leak', exercises: [] });
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 70 } });
  await ok('PUT', '/api/settings', { key: 'units', value: 'kg' });
  const answers = [
    await pullAll(),
    await ok('GET', `/api/programs/${p.id}`),
    await ok('GET', '/api/programs'),
    await ok('GET', `/api/workout/${d}`),
    await ok('GET', `/api/body-stats/${d}`),
    await ok('GET', '/api/body-stats/range?start=2000-01-01&end=2100-01-01'),
    await ok('GET', '/api/exercises'),
    await ok('PUT', `/api/programs/${p.id}`, { name: 'Leak 3' }),
    await ok('PUT', `/api/workout/${d}`, { name: 'Leak 2', exercises: [] }),
  ];
  for (const a of answers) assert.ok(!JSON.stringify(a).includes('field_times'), JSON.stringify(a).slice(0, 300));
});

// ── Found in review ──────────────────────────────────────────────────

const statsOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
const dayStats = async (d) => { const r = await ok('GET', `/api/body-stats/${d}`); return statsOf(r?.stats?.stats ?? r?.stats ?? r); };

test('a measurement cleared (null) is taken away, saved or pushed', { skip }, async () => {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } });
  await nextSecond();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: null } });
  assert.deepEqual(await dayStats(d), { waist: 90 });
  const e = DAY();
  await ok('PUT', `/api/body-stats/${e}`, { stats: { weight: 80, waist: 90 } });
  await nextSecond();
  await ok('POST', '/api/sync/push', { body_stats_log: [{ client_id: 1, date: e, stats: { weight: null }, updated_at: iso(Date.now()) }] });
  assert.deepEqual(await dayStats(e), { waist: 90 });
});

test('push: a row that leaves fields out leaves them as they are, older or newer', { skip }, async () => {
  for (const when of [-3600e3, 0]) {
    const d = DAY();
    const w = await ok('PUT', `/api/workout/${d}`, { name: 'Legs', notes: 'heavy', duration_min: 50, completed: true, exercises: [] });
    const id = w.id ?? w.workout?.id;
    await nextSecond();
    await ok('POST', '/api/sync/push', { workout_log: [{ client_id: 1, server_id: id, date: d, exercises: [], updated_at: iso(Date.now() + when) }] });
    const row = (await pullAll()).workout_log.find((x) => x.id === id);
    assert.deepEqual({ name: row.name, notes: row.notes, duration_min: row.duration_min, completed: row.completed }, { name: 'Legs', notes: 'heavy', duration_min: 50, completed: 1 }, `pushed ${when ? 'older' : 'now'}`);
  }
  const p = await ok('POST', '/api/programs', { name: 'Partial', description: 'keep me', duration_weeks: 3 });
  const r = await call('POST', '/api/sync/push', { programs: [{ client_id: 2, server_id: p.id, description: 'pushed', updated_at: iso(Date.now()) }] });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  const after = await ok('GET', `/api/programs/${p.id}`);
  assert.deepEqual([after.name, after.description, after.duration_weeks], ['Partial', 'pushed', 3]);
});

test('a save made now brings back a workout deleted in the same second', { skip }, async () => {
  const d = DAY();
  const ex = await ok('POST', '/api/exercises', { name: `Press ${n}` });
  await mcp('log_set', { date: d, exercise_id: ex.id, reps: 5, weight: 50 });
  const id = (await pullAll()).workout_log.find((x) => x.date === d && !x.deleted_at).id;
  await mcp('delete_workout', { date: d, confirm: true });
  // Online, at once: no X-Edited-At, so it's made now.
  const r = await call('PUT', `/api/workout/${d}`, { id, name: 'Back again', exercises: [] });
  assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const row = (await pullAll()).workout_log.find((x) => x.id === id);
  assert.equal(row.deleted_at, null);
});
