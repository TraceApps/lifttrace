/**
 * Reminders set just after midnight fire.
 *
 * The scheduler read the clock with Intl and `hour12: false`. On Node 20
 * (the server image) that writes the hour after midnight as "24", so from
 * 00:00 to 00:59 the time read as 24:xx and a workout reminder at 00:00 never
 * fired. The hour is now read with `hourCycle: 'h23'`, and the window runs
 * across midnight in the late direction, so a 23:55 reminder still fires at
 * 00:05 and one for 00:05 never goes out the evening before.
 *
 * The real server and scheduler (first pass 30 s in), on a clock at 00:05
 * UTC, with a stand-in ntfy.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }
const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const NOW = Date.parse('2026-10-15T00:05:00Z');
const CLOCK = `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${NOW} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;
const PEOPLE = { at0000: '00:00', at2355: '23:55', at2230: '22:30', at0015: '00:15' };
// Weekly summaries at 23:50: Wednesday's (just missed, due late on Thursday
// 00:05) and Thursday's (due tonight, not this morning). Oct 15 2026 is a Thursday.
const WEEKLY = { wed2350: 3, thu2350: 4 };
let proc, dir, ntfy, started;
const pushes = [];

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const title = String(req.headers.title || '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
        pushes.push({ topic: req.url.slice(1), title }); resp.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'lt-midnight-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  started = Date.now();
  proc = spawn(process.execPath, ['--import', CLOCK, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'lt-midnight-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  let tok = null;
  const j = async (method, p, body, t = tok) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${p} -> ${r.status} ${text.slice(0, 150)}`);
    return text ? JSON.parse(text) : null;
  };
  await j('POST', '/api/auth/register', { username: 'admin', password: PW });
  tok = (await j('POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  for (const [name, time] of Object.entries(PEOPLE)) {
    await j('POST', '/api/auth/register', { username: name, password: PW });
    const t = (await j('POST', '/api/auth/login', { username: name, password: PW }, null)).token;
    for (const [key, value] of Object.entries({ notifWorkoutReminder: true, notifWorkoutTime: time, notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `lt-${name}` })) {
      await j('PUT', '/api/settings', { key, value }, t);
    }
  }
  for (const [name, day] of Object.entries(WEEKLY)) {
    await j('POST', '/api/auth/register', { username: name, password: PW });
    const t = (await j('POST', '/api/auth/login', { username: name, password: PW }, null)).token;
    for (const [key, value] of Object.entries({ notifWeeklySummary: true, weeklySummaryDay: day, weeklySummaryTime: '23:50', notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `lt-${name}` })) {
      await j('PUT', '/api/settings', { key, value }, t);
    }
  }
  assert.ok(Date.now() < started + 28000, "setup ran past the scheduler's first pass: rerun on a less busy machine");
  // The 23:55 reminder fires on old and new code alike: it marks the first pass.
  for (let i = 0; i < 180 && !pushes.some((p) => p.topic === 'lt-at2355'); i++) await sleep(500);
  await sleep(3000);
});
test.after(() => { proc?.kill(); ntfy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const got = (name) => pushes.filter((p) => p.topic === `lt-${name}` && /Workout Reminder/.test(p.title)).length;

test('a workout reminder at 00:00 fires at 00:05', { skip: !ready && 'server packages missing' }, () => assert.equal(got('at0000'), 1));
test('a workout reminder at 23:55 still fires at 00:05', { skip: !ready && 'server packages missing' }, () => assert.equal(got('at2355'), 1));
test('a workout reminder at 00:15 fires early at 00:05, as on any hour', { skip: !ready && 'server packages missing' }, () => assert.equal(got('at0015'), 1));
test('a workout reminder at 22:30 does not fire at 00:05', { skip: !ready && 'server packages missing' }, () => assert.equal(got('at2230'), 0));

const weekly = (name) => pushes.filter((p) => p.topic === `lt-${name}` && /Weekly Summary/.test(p.title)).length;
test('a weekly summary for Wednesday 23:50 goes at Thursday 00:05', { skip: !ready && 'server packages missing' }, () => assert.equal(weekly('wed2350'), 1));
test('a weekly summary for Thursday 23:50 does not go out on Thursday morning', { skip: !ready && 'server packages missing' }, () => assert.equal(weekly('thu2350'), 0));

test('the clock is read with h23, and the window crosses midnight only late', async () => {
  const src = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
  assert.match(src, /hourCycle: 'h23'/);
  assert.doesNotMatch(src, /minute: 'numeric', hour12: false/);
  if (!ready) return;
  const work = mkdtempSync(join(tmpdir(), 'lt-midnight-lib-'));
  process.env.DB_PATH = join(work, 'lt.db');
  try {
    const { _withinWindow, _dueDay } = await import('../server/lib/scheduler.js');
    const at = (h, m) => ({ hour: h, minute: m });
    assert.equal(_withinWindow(at(0, 5), '23:55'), true, 'late, across midnight');
    assert.equal(_withinWindow(at(0, 5), '00:00'), true);
    assert.equal(_withinWindow(at(23, 55), '00:05'), false, 'never the evening before');
    assert.equal(_withinWindow(at(9, 50), '10:00'), true, 'early on the same day, as before');
    assert.equal(_withinWindow(at(10, 16), '10:00'), false);
    assert.equal(_withinWindow(at(24, 5), '00:00'), true, 'an hour of 24 counts as 0');
    assert.equal(_dueDay(at(0, 5), '23:55'), -1, "a late match after midnight is yesterday's");
    assert.equal(_dueDay(at(0, 5), '00:00'), 0);
    assert.equal(_dueDay(at(9, 50), '10:00'), 0);
    assert.equal(_dueDay(at(12, 0), '10:00'), null);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
