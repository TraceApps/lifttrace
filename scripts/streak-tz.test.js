/**
 * The current streak counts the server's calendar days, near midnight too.
 *
 * GET /api/stats/streaks stepped back from "now" in the server's local time
 * and then read each day as its UTC date. On a server not set to UTC that
 * is the wrong day for part of every night: west of UTC in the evening it
 * started from tomorrow, so a streak through yesterday read 0; east of UTC
 * after midnight it started from yesterday, so today's workout didn't
 * count. The days are now calendar days from the server's local today,
 * stepped in UTC, as #101 did for weeks and as the phone's copy already
 * does (api-native.js).
 *
 * The real server, on a clock set near local midnight, in several zones.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const clock = (iso) => `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${Date.parse(iso)} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function streakAt(TZ, now, localToday, trained) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-streak-tz-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--import', clock(now), 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ, PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'streak-tz-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      if (proc.exitCode != null) throw new Error(`server exited in ${TZ}: ${stderr.slice(-500)}`);
      try { up = (await fetch(base + '/api/auth/status')).ok; } catch { /* not up yet */ }
      if (!up) await sleep(200);
    }
    assert.ok(up, `server did not start in ${TZ}: ${stderr.slice(-500)}`);
    for (const n of trained) {
      const date = shift(localToday, n);
      const r = await fetch(`${base}/api/workout/${date}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        exercises: [{ uuid: `ex-${date}`, exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: `set-${date}`, weight: 100, reps: 5, completed: true }] }],
      }) });
      assert.equal(r.status, 200, `PUT ${date}`);
    }
    return await (await fetch(base + '/api/stats/streaks')).json();
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [
  // 23:30 on Thursday Oct 15 in New York is already Oct 16 in UTC.
  { TZ: 'America/New_York', now: '2026-10-16T03:30:00Z', today: '2026-10-15', trained: [-1, -2, -3], current: 3, why: 'trained through yesterday, not yet today' },
  { TZ: 'America/Los_Angeles', now: '2026-10-16T06:45:00Z', today: '2026-10-15', trained: [0, -1, -2], current: 3, why: 'trained today and the two days before' },
  // 00:30 on Friday Oct 16 in Berlin is still Oct 15 in UTC.
  { TZ: 'Europe/Berlin', now: '2026-10-15T22:30:00Z', today: '2026-10-16', trained: [0, -1, -2, -3], current: 4, why: 'trained today (just after midnight) and the three days before' },
  { TZ: 'Pacific/Auckland', now: '2026-10-15T12:30:00Z', today: '2026-10-16', trained: [0, -1], current: 2, why: 'trained today and yesterday' },
  // Controls: midday, and UTC itself.
  { TZ: 'UTC', now: '2026-10-15T23:30:00Z', today: '2026-10-15', trained: [-1, -2, -3], current: 3, why: 'UTC near midnight' },
  { TZ: 'America/New_York', now: '2026-10-15T16:00:00Z', today: '2026-10-15', trained: [-1, -2, -3], current: 3, why: 'New York at noon' },
];

for (const c of CASES) {
  test(`current streak in ${c.TZ} at ${c.now}: ${c.why}`, { skip: !ready && 'server packages missing' }, async () => {
    const r = await streakAt(c.TZ, c.now, c.today, c.trained);
    assert.equal(r.currentStreak, c.current);
    assert.equal(r.longestStreak, c.trained.length);
  });
}

test('the streak-at-risk alert walks back from the same today it checked', () => {
  const sched = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
  const block = sched.slice(sched.indexOf('// \u2500\u2500 Streak alert'), sched.indexOf('Weekly summary (issue #98)'));
  assert.match(block, /let ds = shiftDay\(today, -1\);/);
  assert.doesNotMatch(block, /checkDate|toISOString\(\)\.slice\(0, 10\);\s*const row/);
});
