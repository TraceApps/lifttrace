/**
 * Excused days pause a calendar-mode program (issue #121), against the real
 * server on a scratch database, with the dated case from
 * fixtures/program-week-cases.mjs:
 *
 * - GET /api/programs and /api/programs/:id: current_week and paused_days;
 *   a day before the start or ahead doesn't count, a day trained on gives
 *   its day back, removing an excuse undoes its pause.
 * - Choosing a week: only days from then on count.
 * - A coach-assigned program pauses for the client's excused days, and the
 *   coach's view of the client says so.
 * - MCP get_active_program and GET /api/v1/programs/active carry paused_days.
 * - Advanced by sessions: never paused. Without accounts too.
 * - ?tz=: "today" is the athlete's.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { datedCase } = await import('./fixtures/program-week-cases.mjs');

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'program-pause-test-0123456789abcdef0123';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
// The server runs on UTC, and every request says so too, so "today" is one
// date however close to midnight this runs.
const TODAY = new Date().toISOString().slice(0, 10);
const D = datedCase(TODAY);
const Q = '?tz=UTC';
const lift = [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }];

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-pause-'));
  s.env = () => ({ ...cleanEnv(), TZ: 'UTC', DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_API_ENABLED: '1' });
  s.boot = async () => {
    const port = await freePort();
    s.base = `http://127.0.0.1:${port}`;
    s.proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...s.env(), PORT: String(port) }, stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'] });
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(s.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not start');
  };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'lt.db'));
  s.node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env: s.env(), encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
  s.user = async (name, role, full_name) => {
    const { user } = await s.ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name, role });
    s.ids[name] = user.id;
    s.tok[name] = serverRequire('jsonwebtoken').sign({ id: user.id, username: name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await s.ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  };
  s.close = async () => {
    const p = s.proc; s.proc = null;
    if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); });
    rmSync(s.dir, { recursive: true, force: true });
  };
  return s;
}

const week = (p) => ({ week: p.current_week, pausedDays: p.paused_days });

// Excuse the dated case's days, and train on the one it trains on.
async function excuseAll(S, who) {
  for (const [k, d] of Object.entries(D.excused)) {
    await S.ok(who, 'PUT', `/api/excused-days/${d}`, { reason: k === 'ahead' ? 'appointment' : 'injury' });
  }
  await S.ok(who, 'PUT', `/api/workout/${D.excused.trained}`, { exercises: lift });
}

let S;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.boot();
  await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  await S.user('coach', 'trainer', 'Sam Coach');
  await S.user('client', 'member', 'Cleo Client');
  await S.user('solo', 'member', 'Sol Solo');
  const r = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
  await S.ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
});
test.after(async () => { await S?.close(); });

test("your own calendar program: excused days push it back, and undoing them gives the days back", { skip }, async () => {
  const p = await S.ok('solo', 'POST', '/api/programs', { name: 'Block', duration_weeks: 4, advance_mode: 'calendar' });
  await S.ok('solo', 'POST', `/api/programs/${p.id}/activate`);
  const db = S.db();
  db.prepare('UPDATE program_assignments SET start_date = ? WHERE program_id = ?').run(D.start, p.id);
  db.close();
  const now = async () => {
    const list = (await S.ok('solo', 'GET', `/api/programs${Q}`)).find(x => x.id === p.id);
    const one = await S.ok('solo', 'GET', `/api/programs/${p.id}${Q}`);
    assert.deepEqual(week(list), week(one), 'the list and the detail agree');
    return week(one);
  };
  assert.deepEqual(await now(), { week: 3, pausedDays: 0 }, 'nothing excused: week 3');
  await excuseAll(S, 'solo');
  assert.deepEqual(await now(), D.expect, 'the start day and the untrained day count; before, trained and ahead do not');
  await S.ok('solo', 'DELETE', `/api/excused-days/${D.excused.start}`);
  assert.deepEqual(await now(), { week: 2, pausedDays: 1 }, 'removing an excuse undoes its pause');
  await S.ok('solo', 'PUT', `/api/workout/${D.excused.counted}`, { exercises: lift });
  assert.deepEqual(await now(), D.afterUndo, 'training on the day undoes it too');
  // Choosing a week: only days from then on count.
  await S.ok('solo', 'PUT', `/api/excused-days/${TODAY}`, { reason: 'illness' });
  assert.deepEqual(await now(), { week: 2, pausedDays: 1 }, 'today counts');
  const twoAgo = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 2 * 864e5).toISOString().slice(0, 10);
  await S.ok('solo', 'PUT', `/api/excused-days/${twoAgo}`, { reason: 'illness' });
  assert.deepEqual(await now(), { week: 2, pausedDays: 2 }, 'and two days ago');
  await S.ok('solo', 'POST', `/api/programs/${p.id}/week-cursor`, { week: 2 });
  assert.deepEqual(await now(), { week: 2, pausedDays: 1 }, 'a week chosen today: today still counts, two days ago no longer does');
  await S.ok('solo', 'POST', `/api/programs/${p.id}/week-cursor`, { week: null });
  assert.deepEqual(await now(), { week: 2, pausedDays: 2 }, 'back to automatic: every day since the start counts again');
  // "Today" is the athlete's: from a zone where it's already tomorrow, the
  // day ahead has come.
  const ahead = await S.ok('solo', 'GET', `/api/programs/${p.id}?tz=Pacific/Kiritimati`);
  const kiriToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
  assert.equal(ahead.paused_days, kiriToday > TODAY ? 3 : 2, "tomorrow's excuse counts where tomorrow has begun");
  assert.equal((await S.ok('solo', 'GET', `/api/programs/${p.id}?tz=Not/AZone`)).paused_days, 2, 'a zone that is not one: the server\'s today');
});

test('advanced by sessions: excused days never pause it', { skip }, async () => {
  const p = await S.ok('solo', 'POST', '/api/programs', { name: 'By Sessions', duration_weeks: 4, advance_mode: 'sessions' });
  await S.ok('solo', 'POST', `/api/programs/${p.id}/activate`);
  const one = await S.ok('solo', 'GET', `/api/programs/${p.id}${Q}`);
  assert.deepEqual(week(one), { week: 1, pausedDays: 0 });
});

test("a coach-assigned program pauses for the client's excused days, and the coach sees it", { skip }, async () => {
  const p = await S.ok('coach', 'POST', '/api/programs', { name: 'Coach Block', duration_weeks: 4, advance_mode: 'calendar' });
  await S.ok('coach', 'POST', `/api/programs/${p.id}/assign`, { user_id: S.ids.client, start_date: D.start, make_active: true });
  const view = async () => (await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}${Q}`)).active_program;
  assert.deepEqual(week(await view()), { week: 3, pausedDays: 0 });
  await excuseAll(S, 'client');
  const mine = (await S.ok('client', 'GET', `/api/programs${Q}`)).find(x => x.id === p.id);
  assert.deepEqual(week(mine), D.expect, "the client's own list");
  const coach = await view();
  assert.deepEqual(week(coach), D.expect, "the coach's view of the client");
  assert.equal(coach.duration_weeks, 4);
  assert.equal(coach.advance_mode, 'calendar');
  // MCP, as the client.
  const mcp = JSON.parse(await S.node(`const m = await import('./lib/mcp/tools/get-active-program.js'); console.log(JSON.stringify(m.getActiveProgramCore(${S.ids.client})));`));
  assert.deepEqual({ week: mcp.current_week, pausedDays: mcp.paused_days, mode: mcp.advance_mode }, { ...D.expect, mode: 'calendar' });
  await S.ok('client', 'DELETE', `/api/excused-days/${D.excused.counted}`);
  assert.deepEqual(week(await view()), { week: 2, pausedDays: 1 }, 'the coach sees a removal at once');
});

test('/api/v1/programs/active carries paused_days', { skip }, async () => {
  // Tokens are an admin's own.
  const p = await S.ok('admin', 'POST', '/api/programs', { name: 'Admin Block', duration_weeks: 4, advance_mode: 'calendar' });
  await S.ok('admin', 'POST', `/api/programs/${p.id}/activate`);
  const db = S.db();
  db.prepare('UPDATE program_assignments SET start_date = ? WHERE program_id = ?').run(D.start, p.id);
  db.close();
  await excuseAll(S, 'admin');
  const { raw: token } = await S.ok('admin', 'POST', '/api/admin/api-tokens', { name: 'pause', scopes: ['mcp:read'] });
  const r = await fetch(`${S.base}/api/v1/programs/active`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json();
  const out = body.data ?? body;
  assert.deepEqual({ week: out.current_week, pausedDays: out.paused_days }, D.expect);
});

test('without accounts: a chosen week pauses for days from then on', { skip }, async () => {
  const solo = server(); // nobody registered: no accounts
  await solo.boot();
  try {
    const p = await solo.ok(null, 'POST', '/api/programs', { name: 'Home Block', duration_weeks: 4, advance_mode: 'calendar' });
    await solo.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    await solo.ok(null, 'PUT', `/api/excused-days/${D.excused.counted}`, { reason: 'illness' });
    await solo.ok(null, 'PUT', `/api/excused-days/${TODAY}`, { reason: 'illness' });
    await solo.ok(null, 'POST', `/api/programs/${p.id}/week-cursor`, { week: 2 });
    const list = (await solo.ok(null, 'GET', `/api/programs${Q}`)).find(x => x.id === p.id);
    const one = await solo.ok(null, 'GET', `/api/programs/${p.id}${Q}`);
    assert.deepEqual(week(list), { week: 2, pausedDays: 1 }, 'today counts, the earlier day does not');
    assert.deepEqual(week(one), week(list));
  } finally { await solo.close(); }
});
