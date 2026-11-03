/**
 * Whose "today" the server works out for someone else (issue #121,
 * server/lib/user-zone.js), against the real server on scratch databases:
 *
 * - The order: the zone the athlete's own app said last; else the zone the
 *   coach's request says (?tz= on the coach's view of a client); else the
 *   server's own. A zone that isn't one is skipped at every step, and the
 *   coach's is never kept as the client's.
 * - Where there is no request (the scheduler's missed-prescription scan, the
 *   program.advanced webhook and MCP, which call getActiveProgramCore with
 *   no zone) it is the one kept, else the server's, whatever a coach said.
 * - Two devices of one account in different zones don't swap the kept zone
 *   back and forth: a zone that differs waits out ZONE_SETTLE_MS.
 *
 * Two zones that never share a date (25 hours apart) stand for "ahead" and
 * "behind"; the server runs in one of them, the athlete's app in one, the
 * coach's in one, and the client's streak and plan week say whose day it was.
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
const JWT_SECRET = 'user-zone-test-0123456789abcdef0123';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const UTC_TODAY = () => new Date().toISOString().slice(0, 10);
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const lift = [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }];

function server(tz = 'UTC') {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-zone-'));
  s.env = () => ({ ...cleanEnv(), TZ: tz, DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_API_ENABLED: '1' });
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


const AHEAD = 'Pacific/Kiritimati', BEHIND = 'Pacific/Pago_Pago';
const dAhead = dayIn(AHEAD), dBehind = dayIn(BEHIND);
const enc = encodeURIComponent;
const ZONE_ROW = "SELECT value, updated_at FROM user_settings WHERE user_id = ? AND key = 'timezone'";
// Trained the day before BEHIND's today: a streak of 1 there, none ahead
// (its today and yesterday are untrained). A calendar program started 6 days
// before BEHIND's today: week 1 there, week 2 ahead.
const BEHIND_SEES = { streak: 1, week: 1 }, AHEAD_SEES = { streak: 0, week: 2 };

async function pair(S) {
  await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
  S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  await S.user('coach', 'trainer');
  await S.user('client', 'member');
  const r = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
  await S.ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
  const p = await S.ok('coach', 'POST', '/api/programs', { name: 'Coach Block', duration_weeks: 8, advance_mode: 'calendar' });
  await S.ok('coach', 'POST', `/api/programs/${p.id}/assign`, { user_id: S.ids.client, start_date: shift(dBehind, -6), make_active: true });
  await S.ok('client', 'PUT', `/api/workout/${shift(dBehind, -1)}`, { exercises: lift });
  S.view = async (tz) => {
    const o = await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}${tz === undefined ? '' : `?tz=${enc(tz)}`}`);
    return { streak: o.streak, week: o.active_program.current_week };
  };
  S.kept = () => S.sql((d) => d.prepare(ZONE_ROW).get(S.ids.client));
  S.unkeep = () => S.sql((d) => d.prepare("DELETE FROM user_settings WHERE key = 'timezone'").run());
  S.core = async (extra = '') => JSON.parse(await S.node(`const m = await import('./lib/mcp/tools/get-active-program.js'); console.log(JSON.stringify(m.getActiveProgramCore(${S.ids.client}${extra})));`)).current_week;
}

test("the coach's view of a client, on a server in the behind zone: the client's zone, else the coach's, else the server's", { skip }, async () => {
  const S = server(BEHIND);
  await S.boot();
  try {
    await pair(S);
    // 3. Nobody says: the server's (behind).
    assert.deepEqual(await S.view(), BEHIND_SEES, 'no zone from anyone: the server');
    assert.deepEqual(await S.view('Not/AZone'), BEHIND_SEES, 'a coach zone that is not one: the server');
    // 2. The coach's request says: that, for this request only.
    assert.deepEqual(await S.view(AHEAD), AHEAD_SEES, "the coach's zone, when the client's app has not said");
    assert.deepEqual(await S.view(), BEHIND_SEES, "not remembered: the next view without one is the server's again");
    assert.equal(S.kept(), undefined, "the coach's zone is never kept as the client's");
    assert.equal(S.sql((d) => d.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE key = 'timezone'").get().n), 0, 'nor as anyone');
    // A kept value that is not a zone is skipped like none.
    S.sql((d) => d.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'timezone', ?)").run(S.ids.client, JSON.stringify('Not/AZone')));
    assert.deepEqual(await S.view(AHEAD), AHEAD_SEES, 'a kept value that is not a zone: the coach');
    // 1. The client's app has said: that beats the coach's and the server's.
    await S.ok('client', 'GET', `/api/programs?tz=${enc(AHEAD)}`);
    assert.equal(JSON.parse(S.kept().value), AHEAD, 'a real zone replaces one that was not');
    assert.deepEqual(await S.view(BEHIND), AHEAD_SEES, "the client's zone over the coach's and the server's");
    assert.deepEqual(await S.view(), AHEAD_SEES, "the client's zone over the server's");
  } finally { await S.close(); }
});

test("the coach's view of a client, on a server in the ahead zone", { skip }, async () => {
  const S = server(AHEAD);
  await S.boot();
  try {
    await pair(S);
    assert.deepEqual(await S.view(), AHEAD_SEES, 'no zone from anyone: the server');
    assert.deepEqual(await S.view(BEHIND), BEHIND_SEES, "the coach's zone over the server's");
    assert.equal(S.kept(), undefined, "the coach's zone is never kept as the client's");
    await S.ok('client', 'GET', `/api/sync/pull?since=2999-01-01T00:00:00.000Z&tz=${enc(BEHIND)}`);
    assert.deepEqual(await S.view(AHEAD), BEHIND_SEES, "the client's zone (said on a pull) over the coach's, which is also the server's");
  } finally { await S.close(); }
});

test('no request, no coach: the zone kept, else the server\'s, whatever a coach said', { skip }, async () => {
  const S = server(AHEAD);
  await S.boot();
  try {
    await pair(S);
    await S.view(BEHIND); // a coach says their zone
    // MCP, /api/v1 and the program.advanced webhook (getActiveProgramCore with no zone).
    assert.equal(await S.core(), AHEAD_SEES.week, 'none kept: the server\'s, not the coach\'s');
    assert.equal(await S.core(`, { fallbackZone: ${JSON.stringify(BEHIND)} }`), BEHIND_SEES.week, 'a caller that is a coach says theirs');
    // The missed-prescription scan (the scheduler): over when it is before
    // the client's today. dBehind is before the server's today (ahead).
    const rx = S.sql((d) => d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises, date, status) VALUES (?, ?, 'Squats', '[]', ?, 'accepted')`).run(S.ids.coach, S.ids.client, dBehind).lastInsertRowid);
    await S.node("const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();");
    const kind = () => S.sql((d) => d.prepare('SELECT kind FROM coach_activity WHERE prescription_id = ?').get(rx)?.kind ?? null);
    assert.equal(kind(), 'prescription_missed', "over by the server's today, whatever zone a coach had said");
    // Once the client's app has said a zone, that one: dBehind is their today.
    S.sql((d) => d.prepare('DELETE FROM coach_activity WHERE prescription_id = ?').run(rx));
    await S.ok('client', 'GET', `/api/programs?tz=${enc(BEHIND)}`);
    assert.equal(await S.core(), BEHIND_SEES.week, 'the kept zone');
    await S.node("const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();");
    assert.equal(kind(), null, 'not over in the zone the client\'s app said');
    // The athlete's own streaks, with no zone sent: the kept one, then the server's.
    assert.equal((await S.ok('client', 'GET', '/api/stats/streaks')).currentStreak, 1, 'their own: the kept zone');
    S.unkeep();
    assert.equal((await S.ok('client', 'GET', '/api/stats/streaks')).currentStreak, 0, "their own, none kept: the server's");
  } finally { await S.close(); }
});

test('userToday and zoneFor: the order in one place', { skip }, async () => {
  const S = server(AHEAD);
  await S.boot();
  try {
    await pair(S);
    const id = S.ids.client;
    const run = async (code) => JSON.parse(await S.node(`const z = await import('./lib/user-zone.js'); console.log(JSON.stringify(${code}));`));
    assert.equal(await run(`z.userToday(${id})`), dAhead, "none: the server's");
    assert.equal(await run(`z.userToday(${id}, { fallbackZone: ${JSON.stringify(BEHIND)} })`), dBehind, "the fallback");
    assert.equal(await run(`z.userToday(${id}, { fallbackZone: 'Not/AZone' })`), dAhead, 'a fallback that is not a zone: the server');
    assert.equal(await run(`z.userToday(${id}, { fallbackZone: ['${BEHIND}'] })`), dAhead, 'a fallback that is not a string: the server');
    assert.equal(await run(`z.userToday(null, { fallbackZone: ${JSON.stringify(BEHIND)} })`), dBehind, 'no account (single-user): the fallback');
    assert.equal(await run(`z.zoneFor(${id}, undefined) ?? null`), null);
    await S.ok('client', 'GET', `/api/programs?tz=${enc(BEHIND)}`);
    assert.equal(await run(`z.zoneFor(${id}, ${JSON.stringify(AHEAD)})`), BEHIND, 'kept over the fallback');
    assert.equal(await run(`z.userToday(${id}, { fallbackZone: ${JSON.stringify(AHEAD)} })`), dBehind);
  } finally { await S.close(); }
});

test("two devices of one account in different zones don't swap the kept zone back and forth", { skip }, async () => {
  const S = server('UTC');
  await S.boot();
  try {
    await pair(S);
    const kept = () => { const r = S.kept(); return r && JSON.parse(r.value); };
    const age = (hours) => S.sql((d) => d.prepare("UPDATE user_settings SET updated_at = datetime('now', ?) WHERE user_id = ? AND key = 'timezone'").run(`-${hours} hours`, S.ids.client));
    const phone = (z) => S.ok('client', 'GET', `/api/sync/pull?since=2999-01-01T00:00:00.000Z&tz=${enc(z)}`);
    const browser = (z) => S.ok('client', 'GET', `/api/programs?tz=${enc(z)}`);
    await phone(BEHIND);
    assert.equal(kept(), BEHIND, 'the first zone is kept at once');
    await browser(AHEAD);
    assert.equal(kept(), BEHIND, 'another device, moments later: not swapped (dev: it is)');
    await phone(BEHIND); await browser(AHEAD); await phone(BEHIND);
    assert.equal(kept(), BEHIND, 'and again');
    age(11);
    await browser(AHEAD);
    assert.equal(kept(), BEHIND, 'under 12 hours since it was written');
    age(13);
    await browser('Not/AZone');
    assert.equal(kept(), BEHIND, 'a zone that is not one never counts');
    await browser(AHEAD);
    assert.equal(kept(), AHEAD, 'after 12 hours a different zone is taken (moving, or the other device)');
    await phone(BEHIND);
    assert.equal(kept(), AHEAD, 'the first device now waits');
    // The same zone again is no write at all.
    S.sql((d) => d.prepare("UPDATE user_settings SET updated_at = '2000-01-01 00:00:00' WHERE user_id = ? AND key = 'timezone'").run(S.ids.client));
    await browser(AHEAD);
    assert.equal(S.kept().updated_at, '2000-01-01 00:00:00', 'the same zone: no write');
    // Long after: taken at once.
    await browser(BEHIND);
    assert.equal(kept(), BEHIND, 'long after: taken at once');
    // A stamp that can't be read, or is in the future, holds nothing up.
    for (const stamp of ['not a time', '2999-01-01 00:00:00']) {
      S.sql((d) => d.prepare("UPDATE user_settings SET updated_at = ? WHERE user_id = ? AND key = 'timezone'").run(stamp, S.ids.client));
      await browser(AHEAD);
      assert.equal(kept(), AHEAD, `a stamp of ${stamp}: taken at once`);
      await browser(BEHIND);
      assert.equal(kept(), AHEAD, 'and now it waits');
      S.sql((d) => d.prepare("UPDATE user_settings SET updated_at = '2000-01-01 00:00:00' WHERE user_id = ? AND key = 'timezone'").run(S.ids.client));
      await browser(BEHIND);
    }
  } finally { await S.close(); }
});
