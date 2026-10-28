/**
 * Leftovers from excused days pausing a calendar program (issue #121),
 * against the real server on scratch databases (server on UTC):
 *
 * - Without accounts a program becomes the one followed with a start
 *   (app_config `active_program_start`, lib/solo-program.js), so a calendar
 *   program moves a week every 7 days and excused days pause it. Switching,
 *   choosing it again, stopping and starting again, a backup and restore,
 *   and the phone's pull all carry it. One followed from before starts were
 *   kept gets one at startup (or on its next read): the first completed
 *   workout from it, else the time of the migration. The first account
 *   goes on following it, from the same start, with the same workouts
 *   counted.
 * - The account's zone, as its app said it last (`?tz=` on a program read
 *   or a pull), is kept, and the coach's view of the client (week, pause,
 *   streak), MCP, the client's missed prescriptions and their streaks count
 *   their days in it. A zone that isn't one is never kept.
 * - The Programs card's "Week N" for a one-week program counts calendar
 *   days at the athlete's midnight, not 24-hour blocks.
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
const JWT_SECRET = 'program-start-test-0123456789abcdef0123';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const UTC_TODAY = () => new Date().toISOString().slice(0, 10);
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// A zone whose date isn't UTC's right now (14 hours ahead from 10:00 UTC,
// 11 behind until 11:00), so a server on UTC gets the day wrong for it.
const ZONE = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => dayIn(z) !== UTC_TODAY());
const lift = [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }];

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-start-'));
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
  s.stop = async () => {
    const p = s.proc; s.proc = null;
    if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); });
  };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.sql = (fn) => { const d = new (serverRequire('better-sqlite3'))(join(s.dir, 'lt.db')); try { return fn(d); } finally { d.close(); } };
  s.config = (key) => s.sql((d) => d.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null);
  s.node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env: s.env(), encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
  s.user = async (name, role) => {
    const { user } = await s.ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, role });
    s.ids[name] = user.id;
    s.tok[name] = serverRequire('jsonwebtoken').sign({ id: user.id, username: name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await s.ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}

const week = (p) => ({ week: p.current_week, pausedDays: p.paused_days });
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

test('without accounts: a program followed has a start, so a calendar program moves and excused days pause it', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'Home Block', duration_weeks: 4, advance_mode: 'calendar' });
    const q = await S.ok(null, 'POST', '/api/programs', { name: 'Other Block', duration_weeks: 4, advance_mode: 'calendar' });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    const start = S.config('active_program_start');
    assert.match(start, STAMP, 'started now, a UTC stamp');
    const both = async (tz = 'UTC') => {
      const list = (await S.ok(null, 'GET', `/api/programs?tz=${tz}`)).find((x) => x.id === p.id);
      const one = await S.ok(null, 'GET', `/api/programs/${p.id}?tz=${tz}`);
      assert.deepEqual(week(list), week(one), 'the list and the detail agree');
      return week(one);
    };
    assert.deepEqual(await both(), { week: 1, pausedDays: 0 });
    await S.ok(null, 'PUT', `/api/excused-days/${UTC_TODAY()}`, { reason: 'illness' });
    assert.deepEqual(await both(), { week: 1, pausedDays: 1 }, 'an excused day today pauses it (dev: no start, so nothing paused)');
    // Started 14 days ago: week 3, less the day excused today.
    S.sql((d) => d.prepare("UPDATE app_config SET value = datetime('now', '-14 days') WHERE key = 'active_program_start'").run());
    assert.deepEqual(await both(), { week: 2, pausedDays: 1 });
    await S.ok(null, 'DELETE', `/api/excused-days/${UTC_TODAY()}`);
    assert.deepEqual(await both(), { week: 3, pausedDays: 0 }, 'it moves a week every 7 days');
    const card = (await S.ok(null, 'GET', '/api/programs?tz=UTC')).find((x) => x.id === p.id);
    assert.deepEqual({ days: card.days_active, weeks: card.weeks_active }, { days: 14, weeks: 3 }, 'the card counts from the start too');
    const moved = S.config('active_program_start');
    // The phone's pull carries it.
    assert.equal((await S.ok(null, 'GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z')).solo_active.started_at, moved);
    // Choosing it again restarts nothing; a chosen week still counts from then.
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    assert.equal(S.config('active_program_start'), moved, 'choosing the same program again keeps its start');
    await S.ok(null, 'POST', `/api/programs/${p.id}/week-cursor`, { week: 2 });
    assert.deepEqual(await both(), { week: 2, pausedDays: 0 }, 'a chosen week');
    await S.ok(null, 'POST', `/api/programs/${p.id}/week-cursor`, { week: null });
    assert.deepEqual(await both(), { week: 3, pausedDays: 0 }, 'back to the calendar, from the start');
    // A backup keeps it; a restore brings it back.
    const made = await S.ok(null, 'POST', '/api/full-backup');
    // Switching restarts the clock; stopping clears it.
    await S.ok(null, 'POST', `/api/programs/${q.id}/activate`);
    assert.equal(S.config('active_program'), String(q.id));
    assert.notEqual(S.config('active_program_start'), moved, 'another program starts now');
    assert.deepEqual(week(await S.ok(null, 'GET', `/api/programs/${q.id}?tz=UTC`)), { week: 1, pausedDays: 0 });
    await S.ok(null, 'POST', '/api/programs/deactivate');
    assert.equal(S.config('active_program_start'), null, 'stopping drops the start');
    assert.equal((await S.ok(null, 'GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z')).solo_active, null);
    await S.ok(null, 'POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
    assert.equal(S.config('active_program_start'), moved, 'restored with its start');
    assert.deepEqual(await both(), { week: 3, pausedDays: 0 });
    // Without a zone from the app, the server's (UTC here).
    assert.deepEqual(week(await S.ok(null, 'GET', `/api/programs/${p.id}`)), { week: 3, pausedDays: 0 });
  } finally { await S.close(); }
});

test('without accounts: a program followed from before starts were kept gets one, by the best evidence, once', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'Home Block', duration_weeks: 4, advance_mode: 'calendar' });
    const t = await S.ok(null, 'POST', '/api/templates', { name: 'Day A', program_id: p.id, exercises: [] });
    const other = await S.ok(null, 'POST', '/api/programs', { name: 'Old Plan', duration_weeks: 4 });
    const ot = await S.ok(null, 'POST', '/api/templates', { name: 'Old Day', program_id: other.id, exercises: [] });
    const today = UTC_TODAY();
    // An earlier run of this program, then another program's workout, one
    // of this program's not completed, then its first completed one since
    // the other program, 10 days ago.
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -50)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -40)}`, { template_id: ot.id, completed: true, exercises: lift });
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -12)}`, { template_id: t.id, completed: false, exercises: lift });
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -10)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -3)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    await S.stop();
    // As a build from before left it: the program, no start.
    S.sql((d) => d.prepare("DELETE FROM app_config WHERE key = 'active_program_start'").run());
    await S.boot();
    await sleep(300); // the startup migration runs as the server starts listening
    assert.equal(S.config('active_program_start'), shift(today, -10), 'the first completed workout from it since another program');
    const one = await S.ok(null, 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.deepEqual(week(one), { week: 2, pausedDays: 0 }, '10 days in');
    assert.equal(one.sessions_in_program, 3, 'the same workouts count as before (all of them)');
    // Idempotent: a restart keeps it.
    await S.stop(); await S.boot(); await sleep(300);
    assert.equal(S.config('active_program_start'), shift(today, -10));
    // No workouts from it: the time of the migration (here, the read that
    // finds none: a backup from before restored, say).
    await S.ok(null, 'POST', `/api/programs/${other.id}/activate`);
    S.sql((d) => {
      d.prepare("DELETE FROM app_config WHERE key = 'active_program_start'").run();
      d.prepare('UPDATE workout_log SET deleted_at = datetime(\'now\') WHERE template_id = ?').run(ot.id);
    });
    const before = Date.now() - 1000;
    assert.deepEqual(week(await S.ok(null, 'GET', `/api/programs/${other.id}?tz=UTC`)), { week: 1, pausedDays: 0 });
    const made = S.config('active_program_start');
    assert.match(made, STAMP);
    assert.ok(Date.parse(made.replace(' ', 'T') + 'Z') >= before, 'now');
  } finally { await S.close(); }
});

test('the migration on a database a build from before made: its start and its week', { skip: process.env.LT_OLD_DB ? skip : 'set LT_OLD_DB to a database from v1.4.0 or dev before this' }, async () => {
  const S = server();
  try {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(process.env.LT_OLD_DB, join(S.dir, 'lt.db'));
    assert.equal(S.config('active_program_start'), null, 'none before');
    await S.boot();
    await sleep(300);
    const start = S.config('active_program_start');
    assert.ok(start, 'one after');
    const id = Number(S.config('active_program'));
    const one = await S.ok(null, 'GET', `/api/programs/${id}?tz=UTC`);
    console.log(JSON.stringify({ start, week: one.current_week, paused: one.paused_days, sessions: one.sessions_in_program }));
    if (process.env.LT_OLD_DB_EXPECT) assert.deepEqual({ start, week: one.current_week }, JSON.parse(process.env.LT_OLD_DB_EXPECT));
  } finally { await S.close(); }
});

test('switching on accounts: the first account goes on following the program, from its start, the same workouts counted', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'By Sessions', duration_weeks: 4, advance_mode: 'sessions' });
    const t = await S.ok(null, 'POST', '/api/templates', { name: 'Day A', program_id: p.id, exercises: [] });
    const today = UTC_TODAY();
    for (const n of [-20, -15, -9]) await S.ok(null, 'PUT', `/api/workout/${shift(today, n)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    S.sql((d) => d.prepare("UPDATE app_config SET value = datetime('now', '-5 days') WHERE key = 'active_program_start'").run());
    await S.ok(null, 'POST', `/api/programs/${p.id}/week-cursor`, { week: 2 });
    await S.ok(null, 'PUT', `/api/workout/${shift(today, -1)}`, { template_id: t.id, completed: true, exercises: lift });
    const solo = await S.ok(null, 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.deepEqual({ week: solo.current_week, sessions: solo.sessions_in_program }, { week: 3, sessions: 4 }, 'week 2 chosen after 3 workouts, one since, one a week');
    const start = S.config('active_program_start');
    const { token } = await S.ok(null, 'POST', '/api/auth/register', { username: 'first', password: PW });
    S.tok.first = token;
    const mine = await S.ok('first', 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.equal(mine.is_active, true, 'still the one followed');
    assert.deepEqual({ week: mine.current_week, sessions: mine.sessions_in_program }, { week: 3, sessions: 4 }, 'the same week and workouts');
    const a = S.sql((d) => d.prepare('SELECT start_date, assigned_at, week_cursor FROM program_assignments WHERE program_id = ?').get(p.id));
    assert.deepEqual(a, { start_date: start, assigned_at: shift(today, -20), week_cursor: 2 });
    assert.equal(S.config('active_program'), null, 'the keys without accounts are gone');
    assert.equal(S.config('active_program_start'), null);
    // A calendar program's start carries over too.
    const c = await S.ok('first', 'POST', '/api/programs', { name: 'Cal', duration_weeks: 4, advance_mode: 'calendar' });
    await S.ok('first', 'POST', `/api/programs/${c.id}/activate`);
    assert.equal((await S.ok('first', 'GET', `/api/programs/${c.id}?tz=UTC`)).current_week, 1);
  } finally { await S.close(); }
});

test('switching on accounts with a calendar program 15 days in: still 15 days in', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'Cal', duration_weeks: 4, advance_mode: 'calendar' });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    S.sql((d) => d.prepare("UPDATE app_config SET value = datetime('now', '-15 days') WHERE key = 'active_program_start'").run());
    assert.equal((await S.ok(null, 'GET', `/api/programs/${p.id}?tz=UTC`)).current_week, 3);
    const { token } = await S.ok(null, 'POST', '/api/auth/register', { username: 'first', password: PW });
    S.tok.first = token;
    assert.equal((await S.ok('first', 'GET', `/api/programs/${p.id}?tz=UTC`)).current_week, 3);
    const card = (await S.ok('first', 'GET', '/api/programs?tz=UTC')).find((x) => x.id === p.id);
    assert.deepEqual({ week: card.current_week, weeks: card.weeks_active }, { week: 3, weeks: 3 }, "the card's count from the same start");
  } finally { await S.close(); }
});

test('switching on accounts before a start was chosen: the start comes from the workouts, not the moment of the switch', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'Cal', duration_weeks: 4, advance_mode: 'calendar' });
    const t = await S.ok(null, 'POST', '/api/templates', { name: 'Day A', program_id: p.id, exercises: [] });
    await S.ok(null, 'PUT', `/api/workout/${shift(UTC_TODAY(), -15)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    // As a backup from before restored: no start, and nothing read since.
    S.sql((d) => d.prepare("DELETE FROM app_config WHERE key = 'active_program_start'").run());
    const { token } = await S.ok(null, 'POST', '/api/auth/register', { username: 'first', password: PW });
    S.tok.first = token;
    assert.equal(S.sql((d) => d.prepare('SELECT start_date FROM program_assignments WHERE program_id = ?').get(p.id).start_date), shift(UTC_TODAY(), -15));
    assert.equal((await S.ok('first', 'GET', `/api/programs/${p.id}?tz=UTC`)).current_week, 3);
  } finally { await S.close(); }
});

test('turning accounts off and on again: the program followed, its start and its chosen week go along', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    // A key an older build left behind when accounts were turned on.
    const stale = await S.ok('admin', 'POST', '/api/programs', { name: 'Stale', duration_weeks: 4 });
    S.sql((d) => d.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('active_program', ?)").run(String(stale.id)));
    const p = await S.ok('admin', 'POST', '/api/programs', { name: 'By Sessions', duration_weeks: 6, advance_mode: 'sessions' });
    const t = await S.ok('admin', 'POST', '/api/templates', { name: 'Day A', program_id: p.id, exercises: [] });
    const today = UTC_TODAY();
    await S.ok('admin', 'PUT', `/api/workout/${shift(today, -30)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok('admin', 'POST', `/api/programs/${p.id}/activate`);
    S.sql((d) => d.prepare('UPDATE program_assignments SET assigned_at = ? WHERE program_id = ?').run(`${shift(today, -20)} 08:00:00`, p.id));
    await S.ok('admin', 'PUT', `/api/workout/${shift(today, -10)}`, { template_id: t.id, completed: true, exercises: lift });
    await S.ok('admin', 'POST', `/api/programs/${p.id}/week-cursor`, { week: 3 });
    await S.ok('admin', 'PUT', `/api/workout/${shift(today, -2)}`, { template_id: t.id, completed: true, exercises: lift });
    const withAccounts = await S.ok('admin', 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.deepEqual({ week: withAccounts.current_week, sessions: withAccounts.sessions_in_program }, { week: 4, sessions: 2 });
    await S.ok('admin', 'DELETE', '/api/auth/management');
    assert.equal(S.config('active_program'), String(p.id), 'the one followed, not the key left behind');
    assert.equal(S.config('active_program_start'), `${shift(today, -20)} 08:00:00`);
    const solo = await S.ok(null, 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.deepEqual({ active: solo.is_active, week: solo.current_week, sessions: solo.sessions_in_program }, { active: true, week: 4, sessions: 3 }, 'the same week, every workout counted');
    const { token } = await S.ok(null, 'POST', '/api/auth/register', { username: 'again', password: PW });
    S.tok.again = token;
    const back = await S.ok('again', 'GET', `/api/programs/${p.id}?tz=UTC`);
    assert.deepEqual({ active: back.is_active, week: back.current_week, sessions: back.sessions_in_program }, { active: true, week: 4, sessions: 3 });
  } finally { await S.close(); }
});

test("the coach's view of a client counts the client's days, in the zone the client's app said last", { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    await S.user('coach', 'trainer');
    await S.user('client', 'member');
    const r = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
    await S.ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
    const zToday = dayIn(ZONE);
    const p = await S.ok('coach', 'POST', '/api/programs', { name: 'Coach Block', duration_weeks: 4, advance_mode: 'calendar' });
    await S.ok('coach', 'POST', `/api/programs/${p.id}/assign`, { user_id: S.ids.client, start_date: shift(zToday, -14), make_active: true });
    await S.ok('client', 'PUT', `/api/excused-days/${zToday}`, { reason: 'injury' });
    await S.ok('client', 'PUT', `/api/workout/${shift(zToday, -2)}`, { exercises: lift });
    await S.ok('client', 'PUT', `/api/workout/${shift(zToday, -1)}`, { exercises: lift });
    const view = async (tz) => S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}${tz ? `?tz=${tz}` : ''}`);
    // Not known yet: the server's day (UTC), whatever the coach's zone.
    // Ahead of UTC: 13 days in there, today's excuse not come yet; behind
    // it: 15 days in, the excuse a day ago.
    const utc = zToday > UTC_TODAY() ? { week: 2, pausedDays: 0 } : { week: 3, pausedDays: 1 };
    assert.deepEqual(week((await view()).active_program), utc, 'unknown: the server\'s today');
    // A zone that isn't one is never kept.
    await S.ok('client', 'GET', '/api/programs?tz=Not/AZone');
    assert.equal(S.sql((d) => d.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone'").get(S.ids.client)), undefined);
    // The client's app reads its program: its zone is kept.
    const mine = (await S.ok('client', 'GET', `/api/programs?tz=${encodeURIComponent(ZONE)}`)).find((x) => x.id === p.id);
    assert.deepEqual(week(mine), { week: 2, pausedDays: 1 }, '14 days in, one excused today');
    assert.equal(S.sql((d) => d.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone'").get(S.ids.client).value), JSON.stringify(ZONE));
    for (const tz of [undefined, 'UTC', 'America/New_York']) {
      const o = await view(tz);
      assert.deepEqual(week(o.active_program), week(mine), `the coach (zone ${tz}) sees what the client sees`);
      assert.equal(o.streak, 2, "the streak runs to the client's today");
      assert.ok(o.excused_days.some((e) => e.date === zToday));
    }
    // MCP's (no zone sent).
    const mcp = JSON.parse(await S.node(`const m = await import('./lib/mcp/tools/get-active-program.js'); console.log(JSON.stringify(m.getActiveProgramCore(${S.ids.client})));`));
    assert.deepEqual({ week: mcp.current_week, pausedDays: mcp.paused_days }, week(mine));
    // Trained today (theirs): 3 days running, for the coach and in their own
    // statistics (a day ahead of the server's today, when they're ahead).
    await S.ok('client', 'PUT', `/api/workout/${zToday}`, { exercises: lift });
    assert.equal((await view('UTC')).streak, 3);
    assert.equal((await S.ok('client', 'GET', '/api/stats/streaks')).currentStreak, 3);
    // The phone's pull says it too; written only when it changes.
    await S.ok('client', 'GET', '/api/sync/pull?since=2999-01-01T00:00:00.000Z&tz=Europe/Paris');
    assert.equal(S.sql((d) => d.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone'").get(S.ids.client).value), JSON.stringify('Europe/Paris'));
    S.sql((d) => d.prepare("UPDATE user_settings SET updated_at = '2000-01-01 00:00:00' WHERE user_id = ? AND key = 'timezone'").run(S.ids.client));
    await S.ok('client', 'GET', '/api/sync/pull?since=2999-01-01T00:00:00.000Z&tz=Europe/Paris');
    assert.equal(S.sql((d) => d.prepare("SELECT updated_at FROM user_settings WHERE user_id = ? AND key = 'timezone'").get(S.ids.client).updated_at), '2000-01-01 00:00:00', 'the same zone: no write');
  } finally { await S.close(); }
});

test("a client's prescription is missed once their day is over, in their zone", { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    await S.user('coach', 'trainer');
    await S.user('client', 'member');
    const r = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
    await S.ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
    await S.ok('client', 'GET', `/api/programs?tz=${encodeURIComponent(ZONE)}`);
    // The earlier of the client's today and UTC's: over for the client only
    // when it is before their today.
    const zToday = dayIn(ZONE), utc = UTC_TODAY();
    const date = zToday < utc ? zToday : utc;
    const id = S.sql((d) => d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises, date, status) VALUES (?, ?, 'Squats', '[]', ?, 'accepted')`).run(S.ids.coach, S.ids.client, date).lastInsertRowid);
    await S.node("const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();");
    const kind = S.sql((d) => d.prepare('SELECT kind FROM coach_activity WHERE prescription_id = ?').get(id)?.kind ?? null);
    assert.equal(kind, date < zToday ? 'prescription_missed' : null, `${date} in ${ZONE}, today there ${zToday}`);
  } finally { await S.close(); }
});

test("a one-week program's card counts calendar days at the athlete's midnight", { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    const one = await S.ok('admin', 'POST', '/api/programs', { name: 'One Week', duration_weeks: 1 });
    await S.ok('admin', 'POST', `/api/programs/${one.id}/activate`);
    // Assigned at 23:59 UTC seven days ago: under 7 days by the clock,
    // 7 calendar days in UTC.
    const at = `${shift(UTC_TODAY(), -7)} 23:59:59`;
    S.sql((d) => d.prepare('UPDATE program_assignments SET assigned_at = ? WHERE program_id = ?').run(at, one.id));
    const card = (await S.ok('admin', 'GET', '/api/programs?tz=UTC')).find((x) => x.id === one.id);
    assert.deepEqual({ days: card.days_active, weeks: card.weeks_active }, { days: 7, weeks: 2 });
  } finally { await S.close(); }
});
