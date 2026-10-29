/**
 * A full backup restore keeps what was deleted, against the real server on
 * a scratch database:
 *
 * - Rows deleted softly (deleted_at) stay deleted after a restore: workouts,
 *   custom exercises, programs, workout days, program assignments, body
 *   stats and Trace chat. They used to come back, on the server and, through
 *   the pull, on every phone.
 * - A phone that pulled before the restore is told: the row arrives with its
 *   deleted_at, so it drops it rather than keeping it.
 * - Sets and exercises deleted inside a workout (workout_tombstones): the
 *   backup keeps them, so a restore on another server still refuses a stale
 *   device putting a deleted set back; and a deletion made after the backup
 *   no longer eats what the restore brought back, on the next save.
 * - A backup from before these columns (and before tombstones were kept)
 *   restores, with every row alive.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
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
const JWT_SECRET = 'restore-deletes-test-0123456789abcdef0123';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-restore-del-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' });
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
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'lt.db'));
  s.sql = (fn) => { const d = s.db(); try { return fn(d); } finally { d.close(); } };
  s.setup = async () => {
    await s.boot();
    await s.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
    s.tok.admin = (await s.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    const { user } = await s.ok('admin', 'POST', '/api/auth/register', { username: 'lifter', password: PW, full_name: 'Lee Lifter', role: 'member' });
    s.ids.lifter = user.id;
    s.tok.lifter = serverRequire('jsonwebtoken').sign({ id: user.id, username: 'lifter', role: user.role }, JWT_SECRET, { expiresIn: '1h' });
  };
  // A backup file, its database.json changed by `edit`, restored by upload.
  s.uploadRestore = async (zipPath, edit = () => {}) => {
    const AdmZip = serverRequire('adm-zip');
    const zip = new AdmZip(zipPath);
    const data = JSON.parse(zip.readAsText('database.json'));
    edit(data);
    zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
    const form = new FormData();
    form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(s.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${s.tok.admin}` }, body: form });
    assert.ok(r.ok, await r.text());
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}

// The tables whose rows are deleted softly (deleted_at), as the sync push,
// the workout delete and MCP leave them.
const SOFT = ['workout_log', 'exercises', 'programs', 'workout_templates', 'program_assignments', 'body_stats_log', 'ai_chat_history'];

const ex = (uuid, sets) => ({ uuid, exercise_id: null, name: 'Bench Press', sets: sets.map((u, i) => ({ uuid: u, reps: 5 + i, weight: 100 })) });
const setUuids = (w) => (w?.exercises || []).flatMap((e) => (e.sets || []).map((s) => s.uuid));

let S, S2;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.setup();
});
test.after(async () => { await S?.close(); await S2?.close(); });

test('rows deleted before the backup stay deleted after a restore, and a phone is told', { skip }, async () => {
  const u = S.ids.lifter;
  // A workout deleted the way the app deletes one, and one kept.
  await S.ok('lifter', 'PUT', '/api/workout/2026-05-01', { name: 'Gone Day', exercises: [ex('ea', ['s1'])] });
  await S.ok('lifter', 'DELETE', '/api/workout/2026-05-01');
  await S.ok('lifter', 'PUT', '/api/workout/2026-05-02', { name: 'Kept Day', exercises: [ex('eb', ['s2'])] });
  // The rest as the sync push deletes them (sync.js): deleted_at set.
  S.sql((d) => {
    const now = "datetime('now')";
    const ins = (sql, ...a) => d.prepare(sql).run(...a).lastInsertRowid;
    const exId = ins('INSERT INTO exercises (name, is_global, created_by) VALUES (?, 0, ?)', 'Gone Curl', u);
    const progId = ins('INSERT INTO programs (name, created_by) VALUES (?, ?)', 'Gone Program', u);
    const keptProg = ins('INSERT INTO programs (name, created_by) VALUES (?, ?)', 'Kept Program', u);
    const dayId = ins('INSERT INTO workout_templates (program_id, name, exercises) VALUES (?, ?, ?)', keptProg, 'Gone Day', '[]');
    const asgId = ins('INSERT INTO program_assignments (program_id, assigned_to, assigned_by) VALUES (?, ?, ?)', keptProg, u, u);
    const bodyId = ins('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)', u, '2026-05-01', '{"weight":80}');
    const chatId = ins('INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)', u, 'user', 'gone message');
    for (const [t, id] of [['exercises', exId], ['programs', progId], ['workout_templates', dayId], ['program_assignments', asgId], ['body_stats_log', bodyId], ['ai_chat_history', chatId]]) {
      d.prepare(`UPDATE ${t} SET deleted_at = ${now}, updated_at = ${now} WHERE id = ?`).run(id);
    }
  });
  const deletedBefore = S.sql((d) => Object.fromEntries(SOFT.map((t) => [t, d.prepare(`SELECT id, deleted_at FROM ${t} WHERE deleted_at IS NOT NULL ORDER BY id`).all()])));
  for (const t of SOFT) assert.equal(deletedBefore[t].length, 1, `${t}: one deleted row to back up`);

  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  // A phone that has everything so far.
  const cursor = (await S.ok('lifter', 'GET', '/api/sync/pull')).server_time;
  await sleep(1100); // the next second, so the restore's changes are after the cursor
  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);

  // The server: deleted as backed up, with the time it was deleted.
  const deletedAfter = S.sql((d) => Object.fromEntries(SOFT.map((t) => [t, d.prepare(`SELECT id, deleted_at FROM ${t} WHERE deleted_at IS NOT NULL ORDER BY id`).all()])));
  assert.deepEqual(deletedAfter, deletedBefore);
  assert.equal((await S.ok('lifter', 'GET', '/api/workout/2026-05-01')).workout, null, 'the deleted workout is not shown');
  assert.equal((await S.ok('lifter', 'GET', '/api/workout/2026-05-02')).workout?.name, 'Kept Day');

  // The phone: the deleted workout arrives deleted, not alive.
  const p = await S.ok('lifter', 'GET', `/api/sync/pull?since=${encodeURIComponent(cursor)}`);
  const gone = p.workout_log.filter((w) => w.id === deletedBefore.workout_log[0].id);
  assert.ok(gone.length >= 1, 'the restore reaches the phone');
  assert.ok(gone.every((w) => w.deleted_at), 'and says it is deleted');
  assert.ok(p.workout_log.some((w) => w.name === 'Kept Day' && !w.deleted_at));
  for (const [list, t] of [[p.exercises, 'exercises'], [p.programs, 'programs'], [p.workout_templates, 'workout_templates'], [p.program_assignments, 'program_assignments'], [p.body_stats_log, 'body_stats_log'], [p.ai_chat_history, 'ai_chat_history']]) {
    const id = deletedBefore[t][0].id;
    assert.ok(!list.some((r) => r.id === id && !r.deleted_at), `${t}: not sent alive`);
  }
});

test('sets deleted in a workout: kept by the backup, and one deleted after it no longer eats the restore', { skip }, async () => {
  const date = '2026-06-01';
  const w = (await S.ok('lifter', 'PUT', `/api/workout/${date}`, { name: 'Sets Day', exercises: [ex('ec', ['a1', 'a2', 'a3'])] })).workout;
  // a3 deleted before the backup, a2 after it.
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ec', ['a1', 'a2'])], deleted_uuids: { sets: { ec: ['a3'] } } });
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ec', ['a1'])], deleted_uuids: { sets: { ec: ['a2'] } } });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['a1']);

  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['a1', 'a2'], 'restored as backed up');
  // A device that pulled the restored workout saves it: a2 stays (the
  // deletion after the backup was undone by the restore).
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, notes: 'felt good', exercises: [ex('ec', ['a1', 'a2'])] });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['a1', 'a2']);
  // A stale device still holding a3 can't put it back.
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ec', ['a1', 'a2', 'a3'])] });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['a1', 'a2']);

  // The same backup restored on another server (a move, or after a disk
  // loss): a3 is still known as deleted there.
  S2 = server();
  await S2.setup();
  await S2.uploadRestore(join(S.dir, 'backups', filename));
  S2.tok.admin = S.tok.admin; S2.tok.lifter = S.tok.lifter;
  await S2.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ec', ['a1', 'a2', 'a3'])] });
  assert.deepEqual(setUuids((await S2.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['a1', 'a2']);
});

test('a backup from before deleted_at and tombstones were kept restores, every row alive', { skip }, async () => {
  const date = '2026-08-02';
  await S.ok('lifter', 'PUT', '/api/workout/2026-08-01', { name: 'Old Gone Day', exercises: [ex('eo', ['o1'])] });
  await S.ok('lifter', 'DELETE', '/api/workout/2026-08-01');
  const w = (await S.ok('lifter', 'PUT', `/api/workout/${date}`, { name: 'Old Sets Day', exercises: [ex('ed', ['c1', 'c2', 'c3'])] })).workout;
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ed', ['c1', 'c2'])], deleted_uuids: { sets: { ed: ['c3'] } } });
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  // c2 deleted after the backup.
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ed', ['c1'])], deleted_uuids: { sets: { ed: ['c2'] } } });
  let rows = 0;
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => {
    delete data.workout_tombstones;
    for (const t of SOFT) for (const r of data[t] || []) { delete r.deleted_at; delete r.updated_at; delete r.field_times; rows++; }
  });
  assert.ok(rows > 0);
  const deleted = S.sql((d) => SOFT.map((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NOT NULL`).get().n));
  assert.deepEqual(deleted, SOFT.map(() => 0));
  assert.equal((await S.ok('lifter', 'GET', '/api/workout/2026-08-01')).workout?.name, 'Old Gone Day', 'nothing said it was deleted, so it is back');
  // The sets the backup holds, kept on the next save; c3, deleted before
  // the backup (its tombstone is still on this server), can't come back.
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['c1', 'c2']);
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('ed', ['c1', 'c2', 'c3'])] });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['c1', 'c2']);
});

test('a workout day: an exercise deleted after the backup no longer eats the restore; one deleted before stays deleted', { skip }, async () => {
  const prog = await S.ok('lifter', 'POST', '/api/programs', { name: 'Restore Program' });
  const day = await S.ok('lifter', 'POST', '/api/templates', { program_id: prog.id, name: 'Push', exercises: [ex('t1', ['x1']), ex('t2', ['x2']), ex('t3', ['x3'])] });
  const names = async () => (await S.ok('lifter', 'GET', `/api/templates/${day.id}`)).exercises.map((e) => e.uuid);
  await S.ok('lifter', 'PUT', `/api/templates/${day.id}`, { exercises: [ex('t1', ['x1']), ex('t2', ['x2'])], deleted_uuids: { exercises: ['t3'] } });
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  await S.ok('lifter', 'PUT', `/api/templates/${day.id}`, { exercises: [ex('t1', ['x1'])], deleted_uuids: { exercises: ['t2'] } });
  assert.deepEqual(await names(), ['t1']);
  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  assert.deepEqual(await names(), ['t1', 't2']);
  // Saved again from a device holding all three: t2 kept, t3 not back.
  await S.ok('lifter', 'PUT', `/api/templates/${day.id}`, { exercises: [ex('t1', ['x1']), ex('t2', ['x2']), ex('t3', ['x3'])] });
  assert.deepEqual(await names(), ['t1', 't2']);
});

test('a whole exercise deleted from a workout after the backup no longer eats the restore', { skip }, async () => {
  const date = '2026-07-01';
  const w = (await S.ok('lifter', 'PUT', `/api/workout/${date}`, { name: 'Two Lifts', exercises: [ex('e1', ['b1']), ex('e2', ['b2'])] })).workout;
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('e1', ['b1'])], deleted_uuids: { exercises: ['e2'] } });
  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('e1', ['b1']), ex('e2', ['b2'])] });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['b1', 'b2']);
});

test('a tombstone from before sessions had ids, in the backup and here with its id, stays one', { skip }, async () => {
  const u = S.ids.lifter, date = '2026-09-01';
  const w = (await S.ok('lifter', 'PUT', `/api/workout/${date}`, { name: 'Legacy Day', exercises: [ex('el', ['l1'])] })).workout;
  // One written before workout_id (0), then given its workout's id by a start-up.
  S.sql((d) => d.prepare(`INSERT INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid) VALUES (?, ?, 0, 'set', 'el', 'l9')`).run(u, date));
  const { filename } = await S.ok('admin', 'POST', '/api/full-backup');
  S.sql((d) => d.prepare(`UPDATE workout_tombstones SET workout_id = ? WHERE uuid = 'l9'`).run(w.id));
  await S.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM workout_tombstones WHERE uuid = 'l9'`).get().n), 1);
  // So the start-up step that gives a 0 one its id still runs (db.js).
  S.sql((d) => d.prepare(`UPDATE workout_tombstones SET workout_id = COALESCE((SELECT wl.id FROM workout_log wl WHERE wl.date = workout_tombstones.date AND wl.user_id IS workout_tombstones.user_id LIMIT 1), 0) WHERE workout_id = 0`).run());
  await S.ok('lifter', 'PUT', `/api/workout/${date}`, { id: w.id, exercises: [ex('el', ['l1', 'l9'])] });
  assert.deepEqual(setUuids((await S.ok('lifter', 'GET', `/api/workout/${date}`)).workout), ['l1']);
});
