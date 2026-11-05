/**
 * A program, or one of its workout days, deleted elsewhere (a third-party
 * client's POST /api/sync/push with deleted_at, or a restored backup that
 * holds one): the row stays on the server with deleted_at set, so phones
 * learn of the delete on their next pull. Everything that reads programs
 * for a person hides it, as the app's own delete does:
 *
 * - GET /api/programs, GET /api/programs/:id and GET /api/templates/:id;
 * - the coach's view of a client (GET /api/trainer/members[/:id]);
 * - MCP and /api/v1 (list_programs, get_active_program, start_program_workout);
 * - the program followed without accounts (the pull's solo_active).
 *
 * And what acts on a program refuses one that is deleted, as not found (its
 * readers say the same): activate, the week cursor and a coach's assign.
 * Reorder is an edit of its days, met as PUT meets one (lib/deleted-rows.js):
 * made before the delete it is gone (410), made after it the program is back.
 * The pull still carries the deleted row.
 *
 * Before: every reader listed the deleted program and its days, and all four
 * actions worked on it. Against the real server on scratch databases.
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
const JWT_SECRET = 'deleted-programs-test-0123456789abcdef';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const ALL = `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`;

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-deleted-programs-'));
  s.env = () => ({ ...cleanEnv(), TZ: 'UTC', DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' });
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
  s.call = async (who, method, path, body, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (who && s.tok[who]) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.node = (code) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: serverDir, env: s.env(), encoding: 'utf8', timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))));
  s.user = async (name, role) => {
    const { user } = await s.ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, role });
    s.ids[name] = user.id;
    s.tok[name] = serverRequire('jsonwebtoken').sign({ id: user.id, username: name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    if (role === 'member') await s.ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
  };
  s.close = async () => {
    const p = s.proc; s.proc = null;
    if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); });
    rmSync(s.dir, { recursive: true, force: true });
  };
  return s;
}

const gone = (r) => r.status === 410 && r.data?.gone === true;
const now = () => new Date().toISOString();
const pushDelete = (S, who, table, id) => S.ok(who, 'POST', '/api/sync/push', { [table]: [{ client_id: 1, server_id: id, deleted_at: now(), updated_at: now() }] });

test('a program deleted elsewhere: hidden from every reader, and nothing acts on it', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    await S.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW });
    S.tok.admin = (await S.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    await S.user('coach', 'trainer');
    await S.user('client', 'member');
    const pairing = await S.ok('coach', 'POST', `/api/trainer/members/${S.ids.client}`, {});
    await S.ok('client', 'POST', `/api/coaching/pairings/${pairing.id}/accept`);

    // The client's own: one followed and then deleted elsewhere, one kept
    // (one of its days deleted elsewhere). The coach's, assigned and deleted.
    const gonePlan = await S.ok('client', 'POST', '/api/programs', { name: 'Gone Plan', duration_weeks: 4 });
    const goneDayA = await S.ok('client', 'POST', '/api/templates', { program_id: gonePlan.id, name: 'Gone A', exercises: [] });
    const goneDayB = await S.ok('client', 'POST', '/api/templates', { program_id: gonePlan.id, name: 'Gone B', exercises: [] });
    await S.ok('client', 'POST', `/api/programs/${gonePlan.id}/activate`);
    const keep = await S.ok('client', 'POST', '/api/programs', { name: 'Keep Plan' });
    const keepDay = await S.ok('client', 'POST', '/api/templates', { program_id: keep.id, name: 'Keep Day', exercises: [] });
    const lostDay = await S.ok('client', 'POST', '/api/templates', { program_id: keep.id, name: 'Lost Day', exercises: [] });
    const coachPlan = await S.ok('coach', 'POST', '/api/programs', { name: 'Coach Plan' });
    const coachDay = await S.ok('coach', 'POST', '/api/templates', { program_id: coachPlan.id, name: 'Coach Day', exercises: [] });
    await S.ok('coach', 'POST', `/api/programs/${coachPlan.id}/assign`, { user_id: S.ids.client, make_active: false });

    const listed = async () => (await S.ok('client', 'GET', '/api/programs')).map((p) => p.name).sort();
    assert.deepEqual(await listed(), ['Coach Plan', 'Gone Plan', 'Keep Plan']);

    const beforeDelete = new Date(Date.now() - 60000).toISOString();
    await pushDelete(S, 'client', 'programs', gonePlan.id);
    await pushDelete(S, 'client', 'workout_templates', lostDay.id);
    await pushDelete(S, 'coach', 'programs', coachPlan.id);

    // The web's readers.
    const list = await S.ok('client', 'GET', '/api/programs');
    assert.deepEqual(list.map((p) => p.name).sort(), ['Keep Plan'], 'GET /api/programs lists no deleted program');
    assert.equal(list[0].template_count, 1, 'and counts no deleted day');
    assert.deepEqual(list[0].template_names, ['Keep Day']);
    assert.equal(list.some((p) => p.is_active), false, 'the program followed is gone: none is followed');
    assert.equal((await S.call('client', 'GET', `/api/programs/${gonePlan.id}`)).status, 404, 'GET /api/programs/:id: not found');
    assert.equal((await S.call('coach', 'GET', `/api/programs/${coachPlan.id}`)).status, 404, 'not for its maker either');
    const kept = await S.ok('client', 'GET', `/api/programs/${keep.id}`);
    assert.deepEqual(kept.templates.map((t) => t.name), ['Keep Day'], "a kept program's deleted day is not among its days");
    assert.equal((await S.call('client', 'GET', `/api/templates/${goneDayA.id}`)).status, 404, 'a day of a deleted program: not found');
    assert.equal((await S.call('client', 'GET', `/api/templates/${lostDay.id}`)).status, 404, 'a deleted day: not found');
    assert.equal((await S.ok('client', 'GET', `/api/templates/${keepDay.id}`)).name, 'Keep Day');

    // What acts on a program.
    const notFound = (r) => r.status === 404;
    assert.ok(notFound(await S.call('client', 'POST', `/api/programs/${gonePlan.id}/activate`)), 'activate: not found');
    assert.ok(notFound(await S.call('client', 'POST', `/api/programs/${gonePlan.id}/week-cursor`, { week: 2 })), 'week cursor: not found');
    assert.ok(notFound(await S.call('coach', 'POST', `/api/programs/${coachPlan.id}/assign`, { user_id: S.ids.client, make_active: true })), 'assign: not found');
    assert.ok(gone(await S.call('client', 'PUT', `/api/programs/${gonePlan.id}/reorder`, { ids: [goneDayB.id, goneDayA.id] }, { 'X-Edited-At': beforeDelete })), 'a reorder made before the delete: gone');
    assert.deepEqual(await listed(), ['Keep Plan'], 'and none of them brought it back');
    const sql = (q) => S.node(`const { default: db } = await import('./db.js'); console.log(JSON.stringify(db.prepare(${JSON.stringify(q)}).all()));`).then(JSON.parse);
    assert.deepEqual(await sql(`SELECT name, order_index FROM workout_templates WHERE program_id = ${gonePlan.id} ORDER BY id`), [{ name: 'Gone A', order_index: 0 }, { name: 'Gone B', order_index: 1 }], 'reorder changed nothing');
    assert.deepEqual(await sql(`SELECT active, week_cursor FROM program_assignments WHERE program_id = ${coachPlan.id}`), [{ active: 0, week_cursor: null }], 'assign changed nothing');
    assert.deepEqual(await sql(`SELECT week_cursor FROM program_assignments WHERE program_id = ${gonePlan.id}`), [{ week_cursor: null }], 'week cursor changed nothing');
    // Unknown ids still answer as they did.
    assert.equal((await S.call('client', 'POST', '/api/programs/99999/activate')).status, 404);

    // The coach's view of the client.
    const members = await S.ok('coach', 'GET', '/api/trainer/members');
    assert.equal(members.find((m) => m.id === S.ids.client).active_program, null, 'the members list names no deleted program');
    const overview = await S.ok('coach', 'GET', `/api/trainer/members/${S.ids.client}`);
    assert.equal(overview.active_program, null, "the client's overview: none followed");
    assert.deepEqual(overview.assigned_programs.map((p) => p.name).sort(), [], 'and none of the deleted ones assigned');

    // MCP and /api/v1 (the same cores).
    const core = async (code) => JSON.parse(await S.node(code));
    const mcpList = await core(`const m = await import('./lib/mcp/tools/list-programs.js'); console.log(JSON.stringify(m.listProgramsCore(${S.ids.client})));`);
    assert.deepEqual(mcpList.programs.map((p) => [p.name, p.template_count]), [['Keep Plan', 1]], 'list_programs: no deleted program, no deleted day');
    const mcpActive = await core(`const m = await import('./lib/mcp/tools/get-active-program.js'); console.log(JSON.stringify(m.getActiveProgramCore(${S.ids.client})));`);
    assert.equal(mcpActive.active, false, 'get_active_program: a deleted program is not followed');
    await S.ok('client', 'POST', `/api/programs/${keep.id}/activate`);
    const keptActive = await core(`const m = await import('./lib/mcp/tools/get-active-program.js'); console.log(JSON.stringify(m.getActiveProgramCore(${S.ids.client})));`);
    assert.deepEqual(keptActive.templates.map((t) => t.name), ['Keep Day'], "get_active_program: the active program's deleted day is not among its days");
    const startGone = await S.node(`const m = await import('./lib/mcp/tools/start-program-workout.js'); try { m.startProgramWorkoutCore(${S.ids.client}, { template_id: ${goneDayA.id}, date: '2026-10-01' }); console.log('started'); } catch (e) { console.log('refused'); }`);
    assert.equal(startGone.trim(), 'refused', 'start_program_workout: no day of a deleted program');

    // Phones still learn of the deletes.
    const pull = await S.ok('client', 'GET', ALL);
    assert.ok(pull.programs.find((p) => p.id === gonePlan.id)?.deleted_at, 'the pull carries the deleted program');
    assert.ok(pull.workout_templates.find((t) => t.id === lostDay.id)?.deleted_at, 'and the deleted day');

    // An edit made after the delete still brings it back, and with it everything reads it again.
    await S.ok('client', 'PUT', `/api/programs/${gonePlan.id}`, { name: 'Back Plan' });
    assert.deepEqual(await listed(), ['Back Plan', 'Keep Plan'], 'brought back by an edit made after the delete');
    assert.equal((await S.ok('client', 'GET', `/api/programs/${gonePlan.id}`)).templates.length, 2);
    await S.ok('client', 'POST', `/api/programs/${gonePlan.id}/activate`);
    // A reorder made after a delete brings the program back too, in its order.
    await pushDelete(S, 'coach', 'programs', coachPlan.id);
    assert.equal((await S.call('coach', 'GET', `/api/programs/${coachPlan.id}`)).status, 404);
    const second = await S.ok('coach', 'POST', '/api/templates', { program_id: coachPlan.id, name: 'Coach Day 2', exercises: [] });
    assert.equal((await S.ok('coach', 'GET', `/api/programs/${coachPlan.id}`)).name, 'Coach Plan', 'a day made after the delete brought it back (as before)');
    await pushDelete(S, 'coach', 'programs', coachPlan.id);
    await S.ok('coach', 'PUT', `/api/programs/${coachPlan.id}/reorder`, { ids: [second.id, coachDay.id] });
    assert.deepEqual((await S.ok('coach', 'GET', `/api/programs/${coachPlan.id}`)).templates.map((t) => t.name), ['Coach Day 2', 'Coach Day'], 'a reorder made now: back, in the new order');
  } finally { await S.close(); }
});

test('without accounts: a deleted program is neither listed nor followed', { skip }, async () => {
  const S = server();
  await S.boot();
  try {
    const p = await S.ok(null, 'POST', '/api/programs', { name: 'Solo Gone' });
    await S.ok(null, 'POST', '/api/templates', { program_id: p.id, name: 'Day', exercises: [] });
    const k = await S.ok(null, 'POST', '/api/programs', { name: 'Solo Keep' });
    await S.ok(null, 'POST', `/api/programs/${p.id}/activate`);
    assert.equal((await S.ok(null, 'GET', ALL)).solo_active?.program_id, p.id);
    await pushDelete(S, null, 'programs', p.id);
    const list = await S.ok(null, 'GET', '/api/programs');
    assert.deepEqual(list.map((x) => x.name).filter((n) => n.startsWith('Solo')), ['Solo Keep'], 'not listed');
    assert.equal((await S.call(null, 'GET', `/api/programs/${p.id}`)).status, 404);
    assert.equal((await S.ok(null, 'GET', ALL)).solo_active, null, 'the pull says nothing is followed');
    assert.equal((await S.call(null, 'POST', `/api/programs/${p.id}/activate`)).status, 404, 'activate: not found');
    assert.equal((await S.call(null, 'POST', `/api/programs/${p.id}/week-cursor`, { week: 1 })).status, 404, 'week cursor: not found');
    await S.ok(null, 'POST', `/api/programs/${k.id}/activate`);
    assert.equal((await S.ok(null, 'GET', ALL)).solo_active?.program_id, k.id);
  } finally { await S.close(); }
});
