/**
 * Excused days (issue #121) against the real server on a scratch database:
 *
 * - /api/excused-days: excuse a day, change it, remove it; one row per
 *   account and date; another account sees none of it; a bad date, reason
 *   or note is refused; removing twice is fine.
 * - An edit made offline (X-Edited-At) never overwrites a later one, and a
 *   removal made before a later edit loses to it (409, the day stays).
 * - The sync pull carries changes, removals and rows deleted outright.
 * - Full backup: restored as backed up, and a backup from before excused
 *   days restores none.
 * - Clear Data, account deletion, and the first account claiming what was
 *   excused without accounts.
 * - Coaching: a prescribed day the client excused tells the coach the
 *   reason (activity kind prescription_excused, a push with the reason),
 *   and the coach's views carry it.
 * - MCP and /api/v1 read them through the same core.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
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
const JWT_SECRET = 'excused-days-test-0123456789abcdef01234';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const TODAY = new Date().toLocaleDateString('sv-SE');

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-excused-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_API_ENABLED: '1' });
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
  s.stop = async () => { const p = s.proc; s.proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); };
  s.call = async (who, method, path, body, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'lt.db'));
  // Async, so the stand-in ntfy in this process can answer the pushes the
  // child sends while it runs.
  s.node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env: s.env(), encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
  s.user = async (name, role, full_name) => {
    const { user } = await s.ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name, role });
    s.ids[name] = user.id;
    s.tok[name] = serverRequire('jsonwebtoken').sign({ id: user.id, username: name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await s.ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}

let S, ntfy;
const pushes = [];
test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const h = http.createServer((req, resp) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { pushes.push({ path: req.url, body: b }); resp.end('{}'); }); });
    h.listen(0, '127.0.0.1', () => res(h));
  });
  S = server();
  await S.boot();
  await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  await S.user('coach', 'trainer', 'Sam Coach');
  await S.user('client', 'member', 'Cleo Client');
  await S.user('other', 'member', 'Oli Other');
  const r = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
  await S.ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
  await S.ok('coach', 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
  await S.ok('coach', 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfy.address().port}` });
  await S.ok('coach', 'PUT', '/api/settings', { key: 'ntfyTopic', value: 'lt-coach' });
});
test.after(async () => { await S?.close(); ntfy?.close(); });

test('excuse a day, change it, remove it: one row per account and date, and nobody else sees it', { skip }, async () => {
  const d = '2026-03-10';
  const made = await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'injury', note: 'Tweaked my back' });
  assert.deepEqual({ date: made.excused.date, reason: made.excused.reason, note: made.excused.note }, { date: d, reason: 'injury', note: 'Tweaked my back' });
  const changed = await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'Illness' });
  assert.equal(changed.excused.id, made.excused.id, 'the same row');
  assert.equal(changed.excused.reason, 'illness', 'reasons are read without case');
  assert.equal(changed.excused.note, 'Tweaked my back', 'a note left out stays');
  assert.equal((await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'illness', note: '  ' })).excused.note, null, 'an empty note clears it');
  assert.deepEqual((await S.ok('other', 'GET', '/api/excused-days')).map(r => r.date), [], "another account's are not yours");
  assert.equal((await S.call('other', 'DELETE', `/api/excused-days/${d}`)).data.removed, false, 'nor can they remove it');
  assert.deepEqual((await S.ok('client', 'GET', '/api/excused-days')).map(r => r.date), [d]);
  assert.deepEqual(await S.ok('client', 'DELETE', `/api/excused-days/${d}`), { ok: true, removed: true });
  assert.deepEqual(await S.ok('client', 'DELETE', `/api/excused-days/${d}`), { ok: true, removed: false }, 'removing twice is fine');
  assert.deepEqual(await S.ok('client', 'GET', '/api/excused-days'), []);
  const again = await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'appointment' });
  assert.equal(again.excused.id, made.excused.id, 'excused again: the same row, back');
  const range = await S.ok('client', 'GET', `/api/excused-days?start=2026-03-01&end=2026-03-31`);
  assert.equal(range.length, 1);
  await S.ok('client', 'DELETE', `/api/excused-days/${d}`);
});

test('a bad date, reason or note is refused', { skip }, async () => {
  for (const [path, body] of [
    ['/api/excused-days/2026-02-30', { reason: 'injury' }],
    ['/api/excused-days/today', { reason: 'injury' }],
    ['/api/excused-days/2026-03-11', { reason: 'lazy' }],
    ['/api/excused-days/2026-03-11', {}],
    ['/api/excused-days/2026-03-11', { reason: 'other', note: 'x'.repeat(501) }],
  ]) {
    assert.equal((await S.call('client', 'PUT', path, body)).status, 400, `${path} ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.equal((await S.call('client', 'GET', '/api/excused-days?start=nope')).status, 400);
  assert.equal((await S.call('client', 'DELETE', '/api/excused-days/2026-13-01')).status, 400);
  assert.equal((await S.call(null, 'GET', '/api/excused-days')).status, 401, 'signed in only');
});

test('an edit made offline never overwrites a later one, and a removal loses to a later edit', { skip }, async () => {
  const d = '2026-03-12';
  const at = (min) => new Date(Date.now() - min * 60000).toISOString();
  await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'injury', note: 'from the web' });
  // The phone's change, made ten minutes ago, arrives now.
  const late = await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'illness', note: 'from the phone' }, { 'X-Edited-At': at(10), 'X-Changed-Fields': 'reason,note' });
  assert.deepEqual([late.excused.reason, late.excused.note], ['injury', 'from the web'], 'the newer edit stays');
  // Only the note changed on the phone after the web's edit: that one goes in.
  const newer = await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'injury', note: 'phone, later' }, { 'X-Edited-At': at(0), 'X-Changed-Fields': 'note' });
  assert.equal(newer.excused.note, 'phone, later');
  // Removed on the phone before the last edit: refused, and the day stays.
  const gone = await S.call('client', 'DELETE', `/api/excused-days/${d}`, null, { 'X-Edited-At': at(20) });
  assert.equal(gone.status, 409);
  assert.equal(gone.data.kept, true);
  assert.equal((await S.ok('client', 'GET', '/api/excused-days')).filter(r => r.date === d).length, 1);
  // Removed later than any edit: removed. Then an edit made before the
  // removal, arriving after it, doesn't bring it back.
  assert.equal((await S.ok('client', 'DELETE', `/api/excused-days/${d}`)).removed, true);
  await S.ok('client', 'PUT', `/api/excused-days/${d}`, { reason: 'other' }, { 'X-Edited-At': at(5), 'X-Changed-Fields': 'reason' });
  assert.equal((await S.ok('client', 'GET', '/api/excused-days')).filter(r => r.date === d).length, 0, 'the later removal stands');
});

test('the sync pull carries excused days, removals and rows deleted outright', { skip }, async () => {
  const since = new Date(Date.now() - 2000).toISOString();
  await sleep(1100);
  await S.ok('client', 'PUT', '/api/excused-days/2026-03-20', { reason: 'illness', note: 'Flu' });
  await S.ok('client', 'PUT', '/api/excused-days/2026-03-21', { reason: 'illness' });
  await S.ok('client', 'DELETE', '/api/excused-days/2026-03-21');
  const pull = await S.ok('client', 'GET', `/api/sync/pull?since=${encodeURIComponent(since)}`);
  const byDate = Object.fromEntries(pull.excused_days.filter(r => r.date).map(r => [r.date, r]));
  assert.equal(byDate['2026-03-20'].reason, 'illness');
  assert.equal(byDate['2026-03-20'].note, 'Flu');
  assert.ok(byDate['2026-03-21'].deleted_at, 'a removal comes as a removed row');
  assert.ok(!(await S.ok('other', 'GET', `/api/sync/pull?since=${encodeURIComponent(since)}`)).excused_days.some(r => r.date), "never in another account's pull");
  // Clear Data deletes them outright: the pull names them by id.
  const id = byDate['2026-03-20'].id;
  const t2 = new Date(Date.now() - 1000).toISOString();
  await S.ok('other', 'PUT', '/api/excused-days/2026-03-22', { reason: 'other' });
  await S.ok('other', 'DELETE', '/api/settings/clear-data');
  assert.deepEqual(await S.ok('other', 'GET', '/api/excused-days'), [], 'Clear Data clears them');
  assert.ok((await S.ok('client', 'GET', '/api/excused-days')).some(r => r.id === id), "and only that account's");
  const p2 = await S.ok('other', 'GET', `/api/sync/pull?since=${encodeURIComponent(t2)}`);
  assert.ok(p2.excused_days.some(r => r.id && r.deleted_at && !r.date), 'deleted outright: { id, deleted_at }');
});

test('full backup: excused days restore as backed up; a backup from before them restores none', { skip }, async () => {
  await S.ok('client', 'PUT', '/api/excused-days/2026-04-01', { reason: 'appointment', note: 'Dentist' });
  const before = (await S.ok('client', 'GET', '/api/excused-days')).map(r => `${r.date}:${r.reason}:${r.note}`);
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  await S.ok('client', 'DELETE', '/api/excused-days/2026-04-01');
  await S.ok('client', 'PUT', '/api/excused-days/2026-04-02', { reason: 'other' });
  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  assert.deepEqual((await S.ok('client', 'GET', '/api/excused-days')).map(r => `${r.date}:${r.reason}:${r.note}`), before);
  // From before excused days: no key at all.
  const AdmZip = serverRequire('adm-zip');
  const zip = new AdmZip(join(S.dir, 'backups', filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  delete data.excused_days;
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  const form = new FormData();
  form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'old.zip');
  const r = await fetch(S.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${S.tok.admin}` }, body: form });
  assert.ok(r.ok, await r.text());
  assert.deepEqual(await S.ok('client', 'GET', '/api/excused-days'), []);
});

test("a prescribed day the client excused tells the coach why, and the coach's views show it", { skip }, async () => {
  const day = shift(TODAY, -3), missed = shift(TODAY, -4);
  const px = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}/prescriptions`, { name: 'Leg Day', exercises: [], date: day });
  const px2 = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}/prescriptions`, { name: 'Push Day', exercises: [], date: missed });
  for (const p of [px, px2]) await S.ok('client', 'POST', `/api/prescriptions/${p.id}/answer`, { answer: 'accept' });
  await S.ok('client', 'PUT', `/api/excused-days/${day}`, { reason: 'injury', note: 'Sprained ankle' });
  pushes.length = 0;
  await S.node("const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();");
  const d = S.db();
  const kinds = (id) => d.prepare('SELECT kind FROM coach_activity WHERE prescription_id = ?').all(id).map(r => r.kind);
  assert.deepEqual(kinds(px.id), ['prescription_excused']);
  assert.deepEqual(kinds(px2.id), ['prescription_missed'], 'a day not excused is still missed');
  d.close();
  for (let i = 0; i < 60 && pushes.length < 2; i++) await sleep(50);
  const bodies = pushes.filter(p => p.path === '/lt-coach').map(p => p.body);
  assert.ok(bodies.includes(`Cleo Client excused Leg Day on ${day}: Injury.`), JSON.stringify(bodies));
  assert.ok(!bodies.some(b => /Sprained/.test(b)), 'the push says the reason, not the note');
  const feed = await S.ok('coach', 'GET', '/api/trainer/activity');
  const row = feed.find(a => a.prescription_id === px.id);
  assert.deepEqual([row.kind, row.excused_reason, row.excused_note], ['prescription_excused', 'injury', 'Sprained ankle']);
  const list = await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}/prescriptions`);
  assert.equal(list.find(p => p.id === px.id).excused_reason, 'injury');
  assert.equal(list.find(p => p.id === px2.id).excused_reason, null);
  const overview = await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}`);
  assert.ok(overview.excused_days.some(e => e.date === day && e.reason === 'injury' && e.note === 'Sprained ankle'));
  // Trained anyway: the day's workout carries the excuse too.
  await S.ok('client', 'PUT', `/api/workout/${day}`, { exercises: [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }] });
  const w = await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}/workout/${day}`);
  assert.equal(w.excused.reason, 'injury');
  // Another coach's client: nothing.
  assert.equal((await S.call('coach', 'GET', `/api/trainer/members/${S.ids.other}`)).status >= 400, true);
});

test('MCP and /api/v1 read excused days through the same core', { skip }, async () => {
  await S.ok('client', 'PUT', `/api/excused-days/${shift(TODAY, -1)}`, { reason: 'illness', note: 'Cold' });
  await S.ok('client', 'PUT', `/api/excused-days/${shift(TODAY, 5)}`, { reason: 'appointment' });
  const out = JSON.parse(await S.node(`const m = await import('./lib/mcp/tools/get-excused-days.js'); console.log(JSON.stringify(m.getExcusedDaysCore(${S.ids.client}, { start: '${shift(TODAY, -2)}' })));`));
  assert.deepEqual(out.excused_days.map(e => e.reason), ['illness', 'appointment'], 'a start alone leaves the end open: days marked ahead too');
  assert.deepEqual(out.excused_days[0], { date: shift(TODAY, -1), reason: 'illness', note: 'Cold' });
  const def = JSON.parse(await S.node(`const m = await import('./lib/mcp/tools/get-excused-days.js'); console.log(JSON.stringify(m.getExcusedDaysCore(${S.ids.client}, {})));`));
  assert.ok(def.excused_days.some(e => e.reason === 'illness') && !def.excused_days.some(e => e.reason === 'appointment'), 'both bounds left out: the last 90 days');
  await assert.rejects(S.node(`const m = await import('./lib/mcp/tools/get-excused-days.js'); m.getExcusedDaysCore(1, { start: '2026-05-02', end: '2026-05-01' });`));
  // Through the REST API, with a token (tokens are an admin's own).
  await S.ok('admin', 'PUT', `/api/excused-days/${shift(TODAY, -1)}`, { reason: 'illness' });
  await S.ok('admin', 'PUT', `/api/excused-days/${shift(TODAY, 3)}`, { reason: 'other' });
  const { raw: token } = await S.ok('admin', 'POST', '/api/admin/api-tokens', { name: 'test', scopes: ['mcp:read'] });
  const r = await fetch(`${S.base}/api/v1/excused-days?start=${shift(TODAY, -2)}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).count, 2);
});

test('account deletion takes them; the first account claims those excused without accounts', { skip }, async () => {
  await S.ok('other', 'PUT', '/api/excused-days/2026-05-01', { reason: 'other' });
  await S.ok('admin', 'DELETE', `/api/auth/users/${S.ids.other}`);
  const d = S.db();
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM excused_days WHERE user_id = ?').get(S.ids.other).n, 0);
  d.close();

  const solo = server();
  try {
    await solo.boot();
    await solo.ok(null, 'PUT', '/api/excused-days/2026-05-03', { reason: 'illness' });
    assert.equal((await solo.ok(null, 'GET', '/api/excused-days')).length, 1, 'without accounts');
    assert.equal((await solo.ok(null, 'PUT', '/api/excused-days/2026-05-03', { reason: 'injury' })).excused.reason, 'injury', 'one row without accounts too');
    await solo.ok(null, 'POST', '/api/auth/register', { username: 'first', password: PW });
    solo.tok.first = (await solo.ok(null, 'POST', '/api/auth/login', { username: 'first', password: PW })).token;
    assert.deepEqual((await solo.ok('first', 'GET', '/api/excused-days')).map(r => `${r.date}:${r.reason}`), ['2026-05-03:injury']);
  } finally { await solo.close(); }
});

test('excused after the coach was told it was missed: the coach hears it as excused, and as missed again if removed', { skip }, async () => {
  const day = shift(TODAY, -6);
  const px = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}/prescriptions`, { name: 'Late Day', exercises: [], date: day });
  await S.ok('client', 'POST', `/api/prescriptions/${px.id}/answer`, { answer: 'accept' });
  await S.node("const m = await import('./lib/coach-activity.js'); m.checkMissedPrescriptions();");
  const kind = async () => (await S.ok('coach', 'GET', '/api/trainer/activity')).find(a => a.prescription_id === px.id);
  assert.equal((await kind()).kind, 'prescription_missed');
  await S.ok('client', 'PUT', `/api/excused-days/${day}`, { reason: 'illness', note: 'Migraine' });
  const now = await kind();
  assert.deepEqual([now.kind, now.excused_reason], ['prescription_excused', 'illness']);
  await S.ok('client', 'DELETE', `/api/excused-days/${day}`);
  assert.equal((await kind()).kind, 'prescription_missed');
});
