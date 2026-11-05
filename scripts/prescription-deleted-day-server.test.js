/**
 * A coach's prescription of a program workout whose day, or whose program,
 * was deleted elsewhere (a third-party client's POST /api/sync/push, or a
 * restored backup that holds it deleted): the day is hidden from every
 * reader (GET /api/templates/:id answers 404), so the prescription would
 * offer a workout that can't be started. It is hidden too, as the day is:
 *
 * - the client's day (GET /api/prescriptions/my/:date, the Diary's card and
 *   its Start) and upcoming list (GET /api/prescriptions/my/upcoming/list);
 * - the dot (GET /api/coaching/state `awaiting`);
 * - the coach's list of the client's prescriptions
 *   (GET /api/trainer/members/:id/prescriptions);
 * - it is never counted as missed while hidden (lib/coach-activity.js), and
 *   no new one can be made out to such a day (404, as the day's readers say).
 *
 * A prescription with no day of its own (exercises only) stays, and one whose
 * program comes back by a later edit shows again; the missed ones of its past
 * days are then recorded, with a push only for the last week (no burst
 * for dates long past). Before: all of it listed, and creating one worked.
 * Against the real server on a scratch database.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
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
const JWT_SECRET = 'rx-deleted-day-test-0123456789abcdef';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const longAgo = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);

test("a prescription of a day deleted elsewhere is hidden from the client's and the coach's lists", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-rx-deleted-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...cleanEnv(), TZ: 'UTC', DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' };
  const proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const tok = {}, ids = {};
  const pushes = [];
  const ntfy = await new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { pushes.push(body); resp.end('{}'); });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
  const j = async (who, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: `Bearer ${tok[who]}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text();
    assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 150)}`);
    return t ? JSON.parse(t) : null;
  };
  try {
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    await j(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    tok.admin = (await j(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    for (const [name, role] of [['coach', 'trainer'], ['client', 'member']]) {
      const { user } = await j('admin', 'POST', '/api/auth/register', { username: name, password: PW, role });
      ids[name] = user.id;
      tok[name] = serverRequire('jsonwebtoken').sign({ id: user.id, username: name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    }
    await j('admin', 'PUT', `/api/auth/users/${ids.client}/trainer`, { trainer_id: null });
    const pairing = await j('coach', 'POST', `/api/trainer/members/${ids.client}`, {});
    await j('client', 'POST', `/api/coaching/pairings/${pairing.id}/accept`);
    await j('client', 'GET', '/api/programs?tz=UTC');
    for (const [key, value] of Object.entries({ notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: 'coach' })) {
      await j('coach', 'PUT', '/api/settings', { key, value });
    }

    // Two programs: one deleted whole, one that loses a day.
    const gone = await j('coach', 'POST', '/api/programs', { name: 'Gone Block' });
    const goneDay = await j('coach', 'POST', '/api/templates', { program_id: gone.id, name: 'Gone Day', exercises: [] });
    const kept = await j('coach', 'POST', '/api/programs', { name: 'Kept Block' });
    const keptDay = await j('coach', 'POST', '/api/templates', { program_id: kept.id, name: 'Kept Day', exercises: [] });
    const lostDay = await j('coach', 'POST', '/api/templates', { program_id: kept.id, name: 'Lost Day', exercises: [] });
    const rx = async (name, date, template_id) => j('coach', 'POST', `/api/trainer/members/${ids.client}/prescriptions`, { name, date, template_id, exercises: [] });
    const rxGone = await rx('of gone program', today, goneDay.id);
    await rx('of lost day', null, lostDay.id);
    await rx('of kept day', null, keptDay.id);
    await rx('exercises only', null, null);
    const rxMissed = await rx('missed, of gone program', yesterday, goneDay.id);
    const rxOld = await rx('long ago, of gone program', longAgo, goneDay.id);
    const rxLive = await rx('missed, exercises only', yesterday, null);

    const names = (rows) => rows.map((r) => r.name).sort();
    const look = async () => ({
      upcoming: names(await j('client', 'GET', '/api/prescriptions/my/upcoming/list?tz=UTC')),
      today: (await j('client', 'GET', `/api/prescriptions/my/${today}`))?.name ?? null,
      awaiting: (await j('client', 'GET', '/api/coaching/state')).awaiting,
      coach: names(await j('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)),
    });
    assert.deepEqual(await look(), {
      upcoming: ['exercises only', 'of gone program', 'of kept day', 'of lost day'],
      today: 'of gone program', awaiting: 4,
      coach: ['exercises only', 'long ago, of gone program', 'missed, exercises only', 'missed, of gone program', 'of gone program', 'of kept day', 'of lost day'],
    }, 'before the deletes, all of them');

    const at = new Date().toISOString();
    await j('coach', 'POST', '/api/sync/push', { programs: [{ client_id: 1, server_id: gone.id, deleted_at: at, updated_at: at }], workout_templates: [{ client_id: 2, server_id: lostDay.id, deleted_at: at, updated_at: at }] });

    assert.deepEqual(await look(), {
      upcoming: ['exercises only', 'of kept day'],
      today: null, awaiting: 2,
      coach: ['exercises only', 'missed, exercises only', 'of kept day'],
    }, 'a deleted day, or a day of a deleted program: hidden everywhere');

    // No new one onto a deleted day, nor one moved onto it.
    const made = await fetch(`${base}/api/trainer/members/${ids.client}/prescriptions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.coach}` }, body: JSON.stringify({ name: 'new', template_id: lostDay.id, exercises: [] }) });
    assert.equal(made.status, 404, 'a deleted day: not found');
    const moved = await fetch(`${base}/api/trainer/prescriptions/${rxLive.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.coach}` }, body: JSON.stringify({ template_id: goneDay.id }) });
    assert.equal(moved.status, 404, 'a day of a deleted program: not found');
    // A hidden one is neither edited in place nor answered (stale screens).
    const hiddenRx = (await j('coach', 'GET', `/api/trainer/members/${ids.client}/prescriptions`)).length;
    const edited = await fetch(`${base}/api/trainer/prescriptions/${rxGone.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.coach}` }, body: JSON.stringify({ name: 'renamed' }) });
    assert.equal(edited.status, 404, 'edit of a hidden prescription: not found');
    const answered = await fetch(`${base}/api/prescriptions/${rxGone.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.client}` }, body: JSON.stringify({ answer: 'accept' }) });
    assert.equal(answered.status, 404, 'answer to a hidden prescription: not found');
    assert.equal(hiddenRx, 3);

    // Never counted as missed.
    const node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env, encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
    const scan = async () => {
      const out = await node(`const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions(); await new Promise(r => setTimeout(r, 1500)); const { default: db } = await import('./db.js'); console.log(JSON.stringify(db.prepare('SELECT prescription_id FROM coach_activity ORDER BY prescription_id').all().map(r => r.prescription_id)));`);
      return JSON.parse(out.trim().split('\n').pop());
    };
    assert.deepEqual(await scan(), [rxLive.id], 'only the live one is missed, not those of a deleted day');
    assert.equal(pushes.length, 1, 'and only it is pushed');

    // Brought back by an edit made after the delete: it shows again.
    await j('coach', 'PUT', `/api/programs/${gone.id}`, { name: 'Back Block' });
    assert.equal((await look()).today, 'of gone program', 'the program back, its prescription is back');
    pushes.length = 0;
    assert.deepEqual(await scan(), [rxLive.id, rxMissed.id, rxOld.id].sort((a, b) => a - b), 'its past ones are recorded now');
    assert.equal(pushes.length, 1, "with a push for yesterday's only, not the one long past");
    assert.ok(rxGone.id);
  } finally {
    ntfy.close();
    if (proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
    rmSync(dir, { recursive: true, force: true });
  }
});
