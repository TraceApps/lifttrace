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
 * - and it is never counted as missed (lib/coach-activity.js).
 *
 * A prescription with no day of its own (exercises only) stays, and one whose
 * program comes back by a later edit shows again. Before: all of it listed.
 * Against the real server on a scratch database.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
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
const JWT_SECRET = 'rx-deleted-day-test-0123456789abcdef';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

test("a prescription of a day deleted elsewhere is hidden from the client's and the coach's lists", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-rx-deleted-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...cleanEnv(), TZ: 'UTC', DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' };
  const proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const tok = {}, ids = {};
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
      coach: ['exercises only', 'missed, of gone program', 'of gone program', 'of kept day', 'of lost day'],
    }, 'before the deletes, all of them');

    const at = new Date().toISOString();
    await j('coach', 'POST', '/api/sync/push', { programs: [{ client_id: 1, server_id: gone.id, deleted_at: at, updated_at: at }], workout_templates: [{ client_id: 2, server_id: lostDay.id, deleted_at: at, updated_at: at }] });

    assert.deepEqual(await look(), {
      upcoming: ['exercises only', 'of kept day'],
      today: null, awaiting: 2,
      coach: ['exercises only', 'of kept day'],
    }, 'a deleted day, or a day of a deleted program: hidden everywhere');

    // Never counted as missed.
    const node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env, encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
    const missed = await node(`const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions(); const { default: db } = await import('./db.js'); console.log(JSON.stringify(db.prepare('SELECT prescription_id FROM coach_activity').all().map(r => r.prescription_id)));`);
    assert.deepEqual(JSON.parse(missed.trim().split('\n').pop()), [], 'a prescription of a deleted day is not missed');
    assert.ok(rxMissed.id && rxGone.id);

    // Brought back by an edit made after the delete: it shows again.
    await j('coach', 'PUT', `/api/programs/${gone.id}`, { name: 'Back Block' });
    assert.equal((await look()).today, 'of gone program', 'the program back, its prescription is back');
  } finally {
    if (proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
    rmSync(dir, { recursive: true, force: true });
  }
});
