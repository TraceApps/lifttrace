/**
 * Whose day it is, where the server counts days for someone without being
 * asked a date: in the zone the athlete's app said last, else the zone the
 * coach's request says (a coach viewing clients), else the server's own
 * (server/lib/user-zone.js zoneFor, issue #121's order). Before, these used
 * UTC's day whatever anyone's zone:
 *
 * - the coach's client list, `week_count`: completed workouts in the last
 *   seven days (SQLite date('now', '-7 days'));
 * - a client's waiting prescriptions (the dot on Programs, GET
 *   /api/coaching/state `awaiting`) and their upcoming list (GET
 *   /api/prescriptions/my/upcoming/list): dated ones from yesterday in UTC.
 *
 * The scheduler's own fallback (UTC with no zone kept) is
 * scheduler-zone-fallback.test.js. Two zones 25 hours apart that never share
 * a date stand for "ahead" and "behind"; at any hour at least one of them
 * has a different day from UTC, so each check below fails on the UTC rule.
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
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'zone-days-test-0123456789abcdef0123';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const AHEAD = 'Pacific/Kiritimati', BEHIND = 'Pacific/Pago_Pago';
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const enc = encodeURIComponent;
const lift = [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }];

let S = null;
test.before(async () => {
  if (!ready) return;
  S = { tok: {}, ids: {}, dir: mkdtempSync(join(tmpdir(), 'lt-zone-days-')) };
  const port = await freePort();
  S.base = `http://127.0.0.1:${port}`;
  // The server's own zone: ahead.
  S.proc = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...cleanEnv(), TZ: AHEAD, PORT: String(port), DB_PATH: join(S.dir, 'lt.db'), UPLOADS_PATH: join(S.dir, 'uploads'), BACKUPS_PATH: join(S.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'],
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(S.base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  S.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${S.tok[who]}`;
    const r = await fetch(S.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
    return data;
  };
  await S.call(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
  S.tok.admin = (await S.call(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  const user = async (name, role) => {
    const { user: u } = await S.call('admin', 'POST', '/api/auth/register', { username: name, password: PW, role });
    S.ids[name] = u.id;
    S.tok[name] = serverRequire('jsonwebtoken').sign({ id: u.id, username: name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await S.call('admin', 'PUT', `/api/auth/users/${u.id}/trainer`, { trainer_id: null });
  };
  await user('coach', 'trainer');
  // One client whose app said "ahead", one "behind", one whose app has said nothing.
  for (const [name, zone] of [['ahead', AHEAD], ['behind', BEHIND], ['silent', null]]) {
    await user(name, 'member');
    const r = await S.call('coach', 'POST', `/api/trainer/members/${S.ids[name]}`, {});
    await S.call(name, 'POST', `/api/coaching/pairings/${r.id}/accept`);
    if (zone) await S.call(name, 'GET', `/api/programs?tz=${enc(zone)}`);
  }
});
test.after(async () => {
  if (!S) return;
  const p = S.proc;
  if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); });
  rmSync(S.dir, { recursive: true, force: true });
});

// The zone each client's days are counted in: their own, else the server's (ahead).
const ZONE = { ahead: AHEAD, behind: BEHIND, silent: AHEAD };

test("the coach's client list counts each client's last seven days in the client's zone", { skip }, async () => {
  for (const name of Object.keys(ZONE)) {
    const today = dayIn(ZONE[name]);
    // Eight days ago (out), seven days ago and today (in).
    for (const d of [shift(today, -8), shift(today, -7), today]) {
      await S.call(name, 'PUT', `/api/workout/${d}`, { name: 'Lift', exercises: lift, completed: true });
    }
  }
  const counts = async (q = '') => Object.fromEntries((await S.call('coach', 'GET', `/api/trainer/members${q}`)).map((m) => [m.username, m.week_count]));
  assert.deepEqual(await counts(), { ahead: 2, behind: 2, silent: 2 }, "each in their own zone, the silent one in the server's");
  // A coach whose app says a zone: that, for a client whose app has said none.
  await S.call('silent', 'PUT', `/api/workout/${shift(dayIn(BEHIND), -7)}`, { name: 'Lift', exercises: lift, completed: true });
  const withCoachZone = await counts(`?tz=${enc(BEHIND)}`);
  const silentDays = new Set([shift(dayIn(AHEAD), -8), shift(dayIn(AHEAD), -7), dayIn(AHEAD), shift(dayIn(BEHIND), -7)]);
  const expected = [...silentDays].filter((d) => d >= shift(dayIn(BEHIND), -7)).length;
  assert.deepEqual(withCoachZone, { ahead: 2, behind: 2, silent: expected }, "the coach's zone for the silent client only");
});

test("a client's waiting and upcoming prescriptions start at the client's today", { skip }, async () => {
  for (const name of Object.keys(ZONE)) {
    const today = dayIn(ZONE[name]);
    for (const [label, d] of [['yesterday', shift(today, -1)], ['today', today], ['undated', null]]) {
      await S.call('coach', 'POST', `/api/trainer/members/${S.ids[name]}/prescriptions`, { name: label, date: d, exercises: [] });
    }
  }
  for (const name of Object.keys(ZONE)) {
    const upcoming = (await S.call(name, 'GET', '/api/prescriptions/my/upcoming/list')).map((p) => p.name).sort();
    assert.deepEqual(upcoming, ['today', 'undated'], `${name}: yesterday's is not upcoming`);
    const state = await S.call(name, 'GET', '/api/coaching/state');
    assert.equal(state.awaiting, 2, `${name}: two waiting for an answer`);
  }
});
