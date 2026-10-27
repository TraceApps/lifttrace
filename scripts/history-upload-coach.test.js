/**
 * A coach and the Android app's Upload (#134), against the real server on a
 * scratch database with a stand-in ntfy service.
 *
 * Finishing a workout a coach prescribed for that day records it on the
 * coach's feed (Coaching, Activity) and sends the coach a push. Upload sends
 * a phone's history through the same workout route, so an old prescribed
 * workout going up told the coach it had just been finished. Now an Upload's
 * save (history_upload, or the 1.4.0 app's upload: keys) still records it on
 * the feed, where the prescription shows done, and sends no push. A workout
 * finished now still sends one.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'history-upload-coach-0123456789abcdef012';
let proc = null, base = null, dir = null, ntfy = null;
const tok = {}, ids = {}, pushes = [];

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return data;
}
// A push is sent after the answer: wait for the stand-in to go quiet.
async function quiet() {
  let last = -1;
  for (let i = 0; i < 20 && pushes.length !== last; i++) { last = pushes.length; await sleep(150); }
}
const finished = () => pushes.filter(p => p.path === '/lt-coach' && /finished/.test(p.body)).length;

const opts = { skip: !ready && 'server packages not installed' };

test.before(async () => {
  if (!ready) return;
  ntfy = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { pushes.push({ path: req.url, body: b }); res.end('{}'); }); });
  await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
  dir = mkdtempSync(join(tmpdir(), 'lt-upload-coach-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 150) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  await call(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  tok.admin = (await call(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, role, full] of [['coach', 'trainer', 'Sam Coach'], ['client', 'member', 'Cleo Client']]) {
    const { user } = await call('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name: full, role });
    ids[name] = user.id;
    tok[name] = jwt.sign({ id: user.id, username: name, role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await call('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  }
  const pairing = await call('coach', 'POST', `/api/trainer/members/${ids.client}`, {});
  await call('client', 'POST', `/api/coaching/pairings/${pairing.id}/accept`);
  await call('coach', 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
  await call('coach', 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfy.address().port}` });
  await call('coach', 'PUT', '/api/settings', { key: 'ntfyTopic', value: 'lt-coach' });
});

test.after(async () => {
  try {
    if (proc) {
      const p = proc; proc = null;
      await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
    }
    if (ntfy) await new Promise((r) => ntfy.close(r));
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A prescription for `date`, accepted, then the client's save of that day. */
async function prescribedAndSaved(date, body) {
  const px = await call('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name: 'Leg Day', exercises: [], date });
  await call('client', 'POST', `/api/prescriptions/${px.id}/answer`, { answer: 'accept' });
  await quiet();
  const before = finished();
  await call('client', 'PUT', `/api/workout/${date}`, { name: 'Legs', completed: true, exercises: [], ...body });
  await quiet();
  const feed = await call('coach', 'GET', '/api/trainer/activity');
  const rows = feed.filter(a => a.prescription_id === px.id && a.kind === 'prescription_completed');
  return { pushed: finished() - before, onFeed: rows.length, onItsDay: rows.every(a => a.occurred_at.startsWith(date)), unread: rows.filter(a => !a.seen_at).length };
}

test("Upload of a prescribed workout tells the coach's feed, without a push", opts, async () => {
  const up = await prescribedAndSaved('2026-02-02', { new_session: true, history_upload: true, client_key: 'upload:workout:0123456789abcdef' });
  // On the day it was done, already read: nothing new for the coach.
  assert.deepEqual(up, { pushed: 0, onFeed: 1, onItsDay: true, unread: 0 });
});

test("the 1.4.0 app's Upload (known by its upload: key) sends no push either", opts, async () => {
  const up = await prescribedAndSaved('2026-02-03', { new_session: true, client_key: 'upload:workout:fedcba9876543210' });
  assert.deepEqual(up, { pushed: 0, onFeed: 1, onItsDay: true, unread: 0 });
});

test('a prescribed workout finished now still tells the coach, once', opts, async () => {
  const now = await prescribedAndSaved('2026-02-04', {});
  assert.deepEqual(now, { pushed: 1, onFeed: 1, onItsDay: false, unread: 1 });
  // Saved again: already on the feed, no second push.
  const before = finished();
  await call('client', 'PUT', '/api/workout/2026-02-04', { name: 'Legs', completed: true, exercises: [], notes: 'again' });
  await quiet();
  assert.equal(finished(), before);
});
