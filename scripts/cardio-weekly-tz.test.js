/**
 * Cardio minutes by week land in the right week in every time zone.
 *
 * Statistics > Cardio groups sessions into Monday weeks. The server and the
 * phone's own copy (api-native.js) read each session's date with
 * new Date('YYYY-MM-DD'), which is UTC midnight, and then took its weekday
 * and moved it in local time. West of UTC that is the evening before: a
 * Monday session counted in the week before, and the week was labeled with
 * a Tuesday. The same thing #101 fixed for the other Statistics weeks; both
 * copies now use that fix's math (calendar days, in UTC).
 *
 * The server runs in five time zones; the phone's copy runs in the same
 * five, from its own source.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

const ZONES = ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Pacific/Kiritimati'];
// Sun Oct 11, Mon Oct 12, Sun Oct 18, Mon Oct 19 2026; Mon Dec 29 2025 and Thu Jan 1 2026.
const SESSIONS = [['2026-10-11', 10], ['2026-10-12', 20], ['2026-10-18', 30], ['2026-10-19', 40], ['2025-12-29', 5], ['2026-01-01', 6]];
// A date stored with a time on it (an API client, an old backup) counts by its day.
const PHONE_ROWS = [...SESSIONS.map(([date, duration_min]) => ({ date, duration_min })), { date: '2026-10-19T07:30', duration_min: 0 }];
const EXPECTED = [
  { week: '2025-12-29', minutes: 11 },
  { week: '2026-10-05', minutes: 10 },
  { week: '2026-10-12', minutes: 50 },
  { week: '2026-10-19', minutes: 40 },
];

async function serverWeeks(TZ) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cardio-tz-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ, PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'cardio-tz-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
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
    for (const [date, duration_min] of SESSIONS) {
      const r = await fetch(base + '/api/cardio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, activity: 'Run', duration_min }) });
      assert.equal(r.status, 200, `POST ${date} in ${TZ}`);
    }
    const r = await fetch(base + '/api/cardio/stats/weekly?start=2025-12-01&end=2026-10-31');
    assert.equal(r.status, 200);
    return await r.json();
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const TZ of ZONES) {
  test(`the server groups cardio into Monday weeks in ${TZ}`, { skip: !ready && 'server packages missing' }, async () => {
    assert.deepEqual(await serverWeeks(TZ), EXPECTED);
  });
}

// The phone's copy, run from its source: Cardio.weekly with its database
// read stood in for, and the Stats week helper it may call.
const native = readFileSync(new URL('../src/lib/api-native.js', import.meta.url), 'utf8');
const method = (obj, name) => {
  const from = native.indexOf(`  async ${name}(`, native.indexOf(`const ${obj} = {`));
  const end = native.indexOf('\n  },\n', from);
  return native.slice(from, end + 4);
};
const statsHelpers = ['_weekStart'].map((n) => {
  const s = native.indexOf(`  ${n}(date)`, native.indexOf('const Stats = {'));
  return native.slice(s, native.indexOf('\n  },\n', s) + 4);
}).join('\n');

for (const TZ of ZONES) {
  test(`the phone's copy groups cardio into Monday weeks in ${TZ}`, () => {
    const script = `
      const rows = ${JSON.stringify(PHONE_ROWS)};
      const dbQuery = async () => rows; const ME = 1;
      const Stats = {\n${statsHelpers}\n};
      const Cardio = {\n${method('Cardio', 'weekly')}\n};
      Cardio.weekly('2025-12-01', '2026-10-31').then(r => process.stdout.write(JSON.stringify(r)));`;
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), EXPECTED);
  });
}
