/**
 * The scheduler's reminders run on the account's clock: the zone its app
 * said last, else the server's own zone (server/lib/user-zone.js zoneFor),
 * the order everything else that counts someone's days uses. With no zone
 * kept it used to fall back to UTC, so on a server whose zone isn't UTC a
 * reminder went out at the wrong hour.
 *
 * And a reminder names the first day of the program being followed, never
 * one of a program deleted elsewhere (a third-party client's push).
 *
 * The real server and scheduler (first pass 30 s in), on a clock at 12:05
 * UTC, which is 02:05 the next day in the server's zone (Kiritimati, UTC+14)
 * and 01:05 the same day in Pago Pago (UTC-11), with a stand-in ntfy.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
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
const NOW = Date.parse('2026-10-15T12:05:00Z');
const CLOCK = `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${NOW} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;
// name: [reminder time, zone its app said (none: the server's), program]
const PEOPLE = {
  server0200: ['02:00', null, null],       // the server's 02:05: due
  utc1200: ['12:00', null, null],          // UTC's 12:05: not the server's hour
  kept0100: ['01:00', 'Pacific/Pago_Pago', null], // its own zone's 01:05: due
  kept0200: ['02:00', 'Pacific/Pago_Pago', null], // the server's hour, not its own
  followed: ['02:00', null, 'live'],
  deleted: ['02:00', null, 'deleted'],
};
let proc, dir, ntfy, started;
const pushes = [];

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const title = String(req.headers.title || '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
        pushes.push({ topic: req.url.slice(1), title, body }); resp.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'lt-sched-zone-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  started = Date.now();
  proc = spawn(process.execPath, ['--import', CLOCK, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'Pacific/Kiritimati', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'lt-sched-zone-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const j = async (method, p, body, t) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${p} -> ${r.status} ${text.slice(0, 150)}`);
    return text ? JSON.parse(text) : null;
  };
  await j('POST', '/api/auth/register', { username: 'admin', password: PW });
  const admin = (await j('POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  for (const [name, [time, zone, program]] of Object.entries(PEOPLE)) {
    await j('POST', '/api/auth/register', { username: name, password: PW }, admin);
    const t = (await j('POST', '/api/auth/login', { username: name, password: PW })).token;
    for (const [key, value] of Object.entries({ notifWorkoutReminder: true, notifWorkoutTime: time, notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `lt-${name}` })) {
      await j('PUT', '/api/settings', { key, value }, t);
    }
    if (zone) await j('GET', `/api/programs?tz=${encodeURIComponent(zone)}`, null, t);
    if (program) {
      const p = await j('POST', '/api/programs', { name: `${program} plan` }, t);
      await j('POST', '/api/templates', { program_id: p.id, name: program === 'live' ? 'Push Day' : 'Leg Day', exercises: [] }, t);
      await j('POST', `/api/programs/${p.id}/activate`, null, t);
      if (program === 'deleted') {
        // Deleted elsewhere, as a restored backup holds it (a third-party
        // client's push is scripts/deleted-programs-server.test.js; here the
        // server's clock is set back and SQLite's is not, so a push's time
        // can't be made to beat the row's own).
        const D = serverRequire('better-sqlite3');
        const db = new D(join(dir, 'lt.db'));
        try { db.prepare("UPDATE programs SET deleted_at = datetime('now') WHERE id = ?").run(p.id); } finally { db.close(); }
      }
    }
  }
  assert.ok(Date.now() < started + 28000, "setup ran past the scheduler's first pass: rerun on a less busy machine");
  // kept0100 is due on old and new code alike: it marks the first pass.
  for (let i = 0; i < 180 && !pushes.some((p) => p.topic === 'lt-kept0100'); i++) await sleep(500);
  await sleep(3000);
});
test.after(() => { proc?.kill(); ntfy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const got = (name) => pushes.filter((p) => p.topic === `lt-${name}` && /Workout Reminder/.test(p.title));

test("no zone kept: a reminder goes at its hour on the server's clock, not UTC's", { skip }, () => {
  assert.equal(got('server0200').length, 1, "02:00 on the server's clock");
  assert.equal(got('utc1200').length, 0, "12:00 is UTC's hour, not the server's");
});
test("a zone kept: the account's own clock, as before", { skip }, () => {
  assert.equal(got('kept0100').length, 1);
  assert.equal(got('kept0200').length, 0);
});
test("a reminder names the program followed, never one deleted elsewhere", { skip }, () => {
  assert.deepEqual(got('followed').map((p) => p.body), ["Time to train! Today's workout: Push Day"]);
  assert.deepEqual(got('deleted').map((p) => p.body), ['Time to train! Open LiftTrace and get after it.']);
});
