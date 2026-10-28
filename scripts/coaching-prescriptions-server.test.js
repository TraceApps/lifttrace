/**
 * Prescriptions ask first (Accept or Decline, then Load), against the real
 * server on a scratch database, with a stand-in ntfy service:
 *
 * - A new prescription waits for the client's answer; prescriptions made
 *   before this (and a backup from before it) count as accepted.
 * - Only the client answers, only while that coach coaches them; the same
 *   answer again is fine, a different one later is refused.
 * - The client hears of a new prescription (who, never the note); the coach
 *   hears the answer. Waiting ones light the client's dot.
 * - A declined prescription is never reported as missed.
 * - Offline: an answer queues on the web and shows answered (offline-edits).
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeOp, answerWithOps, queuedReply } from '../src/lib/offline-edits.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'coaching-rx-test-0123456789abcdef0123456';
const ROLE = { coach: 'trainer', coach2: 'trainer', client: 'member', other: 'member' };
const TODAY = new Date().toLocaleDateString('sv-SE');
let proc, base, dir, ntfy;
const tok = {}, ids = {}, pushes = [];
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
const db = () => new (serverRequire('better-sqlite3'))(join(dir, 'lt.db'));
const waitFor = async (pred, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); };

async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
// A server that already exited never says so again: waiting for it hung.
async function stop() { const p = proc; proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); }

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { pushes.push({ path: req.url, body: b }); resp.end('{}'); }); });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'lt-coach-rx-'));
  await boot();
  await ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  tok.admin = (await ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, full] of [['coach', 'Sam Coach'], ['coach2', 'Kim Coach'], ['client', 'Cleo Client'], ['other', 'Oli Other']]) {
    const { user } = await ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name: full, role: ROLE[name] });
    ids[name] = user.id;
    tok[name] = jwt.sign({ id: user.id, username: name, role: ROLE[name] }, JWT_SECRET, { expiresIn: '1h' });
    if (ROLE[name] === 'member') await ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  }
  for (const [coach, client] of [['coach', 'client'], ['coach2', 'other']]) {
    const r = await ok(coach, 'POST', `/api/trainer/members/${ids[client]}`, {});
    await ok(client, 'POST', `/api/coaching/pairings/${r.id}/accept`);
  }
  for (const who of ['coach', 'client']) {
    await ok(who, 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfy.address().port}` });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyTopic', value: `lt-${who}` });
  }
});
test.after(async () => { try { await stop(); ntfy?.close(); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); } });

const prescribe = (body) => ok('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name: 'Leg Day', exercises: [], ...body });

test('a new prescription waits for the client; the client hears who, never the note', { skip: !ready }, async () => {
  pushes.length = 0;
  const px = await prescribe({ date: TODAY, notes: 'Secret cue inside' });
  assert.equal(px.status, 'pending');
  assert.equal((await ok('client', 'GET', `/api/prescriptions/my/${TODAY}`)).status, 'pending');
  assert.ok((await ok('client', 'GET', '/api/prescriptions/my/upcoming/list')).some(p => p.id === px.id && p.status === 'pending'));
  assert.equal((await ok('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).find(p => p.id === px.id).status, 'pending');
  assert.ok(await waitFor(() => pushes.some(p => p.path === '/lt-client')));
  assert.equal(pushes.find(p => p.path === '/lt-client').body, 'Sam Coach prescribed a workout.');
  assert.doesNotMatch(JSON.stringify(pushes), /Secret cue/);
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).awaiting, 1, 'the dot');
});

test('only the client answers, while coached; answering twice the same way is fine', { skip: !ready }, async () => {
  const px = await prescribe({ date: TODAY });
  const path = `/api/prescriptions/${px.id}/answer`;
  assert.equal((await call('coach', 'POST', path, { answer: 'accept' })).status, 404, 'not the coach');
  assert.equal((await call('other', 'POST', path, { answer: 'accept' })).status, 404, 'not someone else');
  assert.equal((await call('client', 'POST', path, { answer: 'maybe' })).status, 400);
  pushes.length = 0;
  const a = await ok('client', 'POST', path, { answer: 'accept' });
  assert.equal(a.status, 'accepted');
  assert.ok(a.responded_at);
  assert.equal((await ok('client', 'POST', path, { answer: 'accept' })).status, 'accepted', 'a retry after a lost reply');
  const late = await call('client', 'POST', path, { answer: 'decline' });
  assert.equal(late.status, 409);
  assert.ok(await waitFor(() => pushes.some(p => p.path === '/lt-coach')));
  assert.equal(pushes.find(p => p.path === '/lt-coach').body, 'Cleo Client accepted the workout you prescribed.');
  // Declining: the coach sees it; the client's reads leave it out (so a
  // released app never offers to Load it), and an accepted one the same day
  // still shows.
  const px2 = await prescribe({ date: TODAY, name: 'Second for today' });
  await ok('client', 'POST', `/api/prescriptions/${px2.id}/answer`, { answer: 'decline' });
  assert.equal((await ok('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).find(p => p.id === px2.id).status, 'declined');
  assert.equal((await ok('client', 'GET', `/api/prescriptions/my/${TODAY}`)).id, px.id, 'the accepted one, not the newer declined one');
  assert.ok(!(await ok('client', 'GET', '/api/prescriptions/my/upcoming/list')).some(p => p.id === px2.id));
  // Every waiting one is listed (two on one day: the banner shows one, the
  // list the other), from yesterday on, as the dot counts them.
  const older = await prescribe({ date: TODAY, name: 'Older for today' });
  const newer = await prescribe({ date: TODAY, name: 'Newer for today' });
  const up = await ok('client', 'GET', '/api/prescriptions/my/upcoming/list');
  assert.ok(up.some(p => p.id === older.id) && up.some(p => p.id === newer.id));
  for (const p of [older, newer]) await ok('client', 'POST', `/api/prescriptions/${p.id}/answer`, { answer: 'decline' });
  // The coach gives the declined one again (a new date): it asks again.
  pushes.length = 0;
  await ok('coach', 'PUT', `/api/trainer/prescriptions/${px2.id}`, { date: TODAY });
  assert.equal((await ok('client', 'GET', '/api/prescriptions/my/upcoming/list')).find(p => p.id === px2.id).status, 'pending');
  assert.ok(await waitFor(() => pushes.some(p => p.path === '/lt-client')), 'and the client hears of it');
  // An accepted one changed to another workout asks again; a new date alone doesn't.
  await ok('coach', 'PUT', `/api/trainer/prescriptions/${px.id}`, { date: '2099-01-01' });
  assert.equal((await ok('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).find(p => p.id === px.id).status, 'accepted');
  await ok('coach', 'PUT', `/api/trainer/prescriptions/${px.id}`, { name: 'Another workout' });
  assert.equal((await ok('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).find(p => p.id === px.id).status, 'pending');
});

// A prescription sent again after its answer was lost, and one deleted by
// its create's key before the coach learned its id (#134).
test('sent again with its key: one prescription, one notification; deleted by key only by its coach', { skip: !ready }, async () => {
  const K = 'web-rx-0123456789abcdef';
  const rows = async () => (await ok('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).filter(p => p.name === 'Keyed Rx');
  // A notification from the test before may still be on its way.
  await sleep(500);
  pushes.length = 0;
  const first = await prescribe({ name: 'Keyed Rx', client_key: K });
  assert.ok(await waitFor(() => pushes.some(p => p.path === '/lt-client')));
  const again = await prescribe({ name: 'Keyed Rx', client_key: K });
  assert.equal(again.id, first.id, 'answered with the one made');
  assert.equal(again.client_key, undefined, 'the key is the request\'s, never the row\'s');
  assert.equal((await rows()).length, 1);
  await sleep(300);
  assert.equal(pushes.filter(p => p.path === '/lt-client').length, 1, 'the client hears of it once');

  const byKey = (who, key = K) => call(who, 'DELETE', `/api/trainer/prescriptions/by-key/${key}`);
  // Another coach's create with the same key makes their own, never
  // answered with this coach's.
  const theirs = await ok('coach2', 'POST', `/api/trainer/members/${ids.other}/prescriptions`, { name: 'Keyed Rx', exercises: [], client_key: K });
  assert.notEqual(theirs.id, first.id);
  assert.equal(theirs.member_id, ids.other);
  // And their delete by that key deletes theirs, not this coach's.
  assert.deepEqual((await byKey('coach2')).data, { ok: true, by_key: true, deleted: true });
  // The client, and an admin who isn't the coach, delete nothing.
  assert.equal((await byKey('client')).status, 403);
  assert.deepEqual((await byKey('admin')).data, { ok: true, by_key: true, deleted: false });
  // Nor does another coach by its id: answered as one already gone.
  assert.deepEqual(await ok('coach2', 'DELETE', `/api/trainer/prescriptions/${first.id}`), { ok: true, deleted: false });
  // A key already used for another client (its row moved there here) is
  // no repeat of this create: refused, nothing made.
  {
    const K3 = 'web-rx-moved-0123456789';
    const moved = await prescribe({ name: 'Moved Rx', client_key: K3 });
    const d = db();
    d.prepare('UPDATE coach_prescriptions SET member_id = ? WHERE id = ?').run(ids.other, moved.id);
    d.close();
    const r = await call('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name: 'Moved Rx', exercises: [], client_key: K3 });
    assert.equal(r.status, 409);
    const d2 = db();
    assert.equal(d2.prepare(`SELECT COUNT(*) AS c FROM coach_prescriptions WHERE name = 'Moved Rx'`).get().c, 1);
    d2.prepare('DELETE FROM coach_prescriptions WHERE id = ?').run(moved.id);
    d2.close();
  }
  assert.equal((await rows()).length, 1, 'still there');

  // Its coach: deleted, and asked again, already gone.
  assert.deepEqual((await byKey('coach')).data, { ok: true, by_key: true, deleted: true });
  assert.deepEqual(await rows(), []);
  assert.deepEqual((await byKey('coach')).data, { ok: true, by_key: true, deleted: false });
  // A delete by id sent again (its answer lost, a second tab) is done too.
  assert.deepEqual(await ok('coach', 'DELETE', `/api/trainer/prescriptions/${first.id}`), { ok: true, deleted: false });
  // The create sent again is answered as deleted since: nothing made, no notification.
  pushes.length = 0;
  const late = await call('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name: 'Keyed Rx', exercises: [], client_key: K });
  assert.equal(late.status, 410);
  assert.equal(late.data.gone, true);
  // Deleted by a key no create has arrived with yet: a late one makes nothing.
  assert.deepEqual((await byKey('coach', 'web-rx-never-arrived-01')).data, { ok: true, by_key: true, deleted: false });
  assert.equal((await call('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name: 'Keyed Rx', exercises: [], client_key: 'web-rx-never-arrived-01' })).status, 410);
  assert.deepEqual(await rows(), []);
  await sleep(300);
  assert.equal(pushes.filter(p => p.path === '/lt-client').length, 0, 'no notification for either');
  assert.equal((await byKey('coach', 'short')).status, 400);

  // Coaching that ended: its coach can't delete it by key or by id, and a
  // repeat of the create makes nothing.
  const K2 = 'web-rx-ended-0123456789';
  const ended = await ok('coach2', 'POST', `/api/trainer/members/${ids.other}/prescriptions`, { name: 'Ended Rx', exercises: [], client_key: K2 });
  const pairing = (await ok('other', 'GET', '/api/coaching/state')).as_client.id;
  const d = db();
  d.prepare(`UPDATE coach_clients SET status = 'ended' WHERE id = ?`).run(pairing);
  d.close();
  try {
    const r = await byKey('coach2', K2);
    assert.equal(r.status, 404);
    assert.equal(r.data.by_key, true, 'from the route, not a server without it');
    assert.equal((await call('coach2', 'DELETE', `/api/trainer/prescriptions/${ended.id}`)).status, 404);
    assert.equal((await call('coach2', 'POST', `/api/trainer/members/${ids.other}/prescriptions`, { name: 'Ended Rx', exercises: [], client_key: K2 })).status, 404);
    const d2 = db();
    assert.equal(d2.prepare('SELECT COUNT(*) AS c FROM coach_prescriptions WHERE id = ?').get(ended.id).c, 1, 'kept');
    d2.close();
  } finally {
    const d3 = db();
    d3.prepare(`UPDATE coach_clients SET status = 'active' WHERE id = ?`).run(pairing);
    d3.close();
  }
});

test('prescriptions from before the Accept step count as accepted, and nothing asks again', { skip: !ready }, async () => {
  // As an older server left them: no status column. Write one the way it
  // did (no status given), then restart (the column's default applies).
  const d = db();
  const id = d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises) VALUES (?, ?, 'Old Rx', '[]')`).run(ids.coach, ids.client).lastInsertRowid;
  d.close();
  await stop(); await boot();
  const rows = await ok('client', 'GET', '/api/prescriptions/my/upcoming/list');
  assert.equal(rows.find(p => p.id === id).status, 'accepted');
  // And a backup from before it restores the same way.
  const { filename } = await ok('admin', 'POST', '/api/full-backup');
  const AdmZip = serverRequire('adm-zip');
  const zip = new AdmZip(join(dir, 'backups', filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  for (const p of data.coach_prescriptions) { delete p.status; delete p.responded_at; }
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  zip.writeZip(join(dir, 'old.zip'));
  const form = new FormData();
  form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'old.zip');
  const r = await fetch(base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${tok.admin}` }, body: form });
  assert.ok(r.ok, await r.text());
  const after = await ok('client', 'GET', '/api/prescriptions/my/upcoming/list');
  assert.ok(after.length >= 1 && after.every(p => p.status === 'accepted'), JSON.stringify(after.map(p => p.status)));
});

test('the dot counts waiting prescriptions, not past ones; leaving ends answering', { skip: !ready }, async () => {
  const d = db();
  d.prepare(`UPDATE coach_prescriptions SET status = 'accepted' WHERE member_id = ?`).run(ids.client);
  d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises, date, status) VALUES (?, ?, 'Long ago', '[]', '2020-01-01', 'pending')`).run(ids.coach, ids.client);
  d.close();
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).awaiting, 0);
  const px = await prescribe({});
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).awaiting, 1);
  // A prescription from a coach who no longer coaches them can't be answered.
  const pid = (await ok('client', 'GET', '/api/coaching/state')).as_client.id;
  const d2 = db();
  d2.prepare(`UPDATE coach_clients SET status = 'ended' WHERE id = ?`).run(pid);
  d2.prepare(`UPDATE users SET trainer_id = NULL WHERE id = ?`).run(ids.client);
  d2.close();
  assert.equal((await call('client', 'POST', `/api/prescriptions/${px.id}/answer`, { answer: 'accept' })).status, 404);
});

test('a declined prescription is never reported as missed', { skip: !ready }, async () => {
  const d = db();
  const declined = d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises, date, status) VALUES (?, ?, 'Skipped', '[]', '2026-01-05', 'declined')`).run(ids.coach2, ids.other).lastInsertRowid;
  const accepted = d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises, date, status) VALUES (?, ?, 'Forgot', '[]', '2026-01-06', 'accepted')`).run(ids.coach2, ids.other).lastInsertRowid;
  d.close();
  // The scheduler's daily check, run as the scheduler runs it.
  execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();"], {
    cwd: serverDir, env: { ...cleanEnv(), DB_PATH: join(dir, 'lt.db'), JWT_SECRET, NODE_ENV: 'test', LOG_LEVEL: 'error', UPLOADS_PATH: join(dir, 'uploads') }, stdio: 'ignore',
  });
  const d2 = db();
  const kinds = (id) => d2.prepare(`SELECT kind FROM coach_activity WHERE prescription_id = ?`).all(id).map(r => r.kind);
  assert.deepEqual(kinds(declined), []);
  assert.deepEqual(kinds(accepted), ['prescription_missed']);
  d2.close();
});

test('offline on the web: an answer queues and shows answered', () => {
  const op = writeOp('POST', '/api/prescriptions/42/answer', { answer: 'accept' });
  assert.deepEqual(op, { kind: 'prescription-answer', key: 'prescription-answer:42', id: 42 });
  const queued = [{ ...op, seq: 1, body: { answer: 'accept' } }];
  assert.equal(answerWithOps('/api/prescriptions/my/2026-10-13', { id: 42, status: 'pending' }, queued).status, 'accepted');
  const list = answerWithOps('/api/prescriptions/my/upcoming/list', [{ id: 42, status: 'pending' }, { id: 7, status: 'pending' }], queued);
  assert.deepEqual(list.map(p => p.status), ['accepted', 'pending']);
  assert.equal(answerWithOps('/api/prescriptions/my/2026-10-13', null, queued), null, 'no prescription that day: none');
  assert.equal(queuedReply(op, { answer: 'decline' }).status, 'declined', 'the reply the screen gets offline');
  assert.equal(queuedReply(op, { answer: 'accept' }).status, 'accepted');
});
