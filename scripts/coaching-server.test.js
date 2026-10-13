/**
 * Coaching with consent, against the real server (server/index.js on a
 * scratch database).
 *
 * - Privacy: every coach route answers only the coach with an active
 *   pairing the client accepted. Another coach's client, a request still
 *   waiting, coaching that ended, a non-coach and an admin who isn't the
 *   coach all get nothing. The routes are read from server/routes/trainer.js,
 *   so one added later has to be listed here too.
 * - The unpaired list carries id and name only; the activity feed is each
 *   coach's own.
 * - Requests, answers, leaving, ending, one coach per client, the admin's
 *   trainer picker, role changes, invites and new accounts, account deletion,
 *   backup and restore (with a backup from before consent), and pairings
 *   from before consent kept as they were.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'coaching-test-0123456789abcdef0123456789';
const TODAY = new Date().toLocaleDateString('sv-SE');
let proc = null, base = null, dir = null;
const tok = {};
const ids = {};

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise((r) => { p.once('exit', r); p.kill(); });
}

// Signing in is rate limited per address, so the other accounts get the
// token the server signs at sign-in, made here with the server's secret.
function sign(name, role) {
  const jwt = serverRequire('jsonwebtoken');
  tok[name] = jwt.sign({ id: ids[name], username: name, role }, JWT_SECRET, { expiresIn: '1h' });
}
async function makeUser(name, role, full_name) {
  const { user } = await ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name, role });
  ids[name] = user.id;
  sign(name, user.role);
  // Creating a member sends the admin's request (it used to make the admin
  // their trainer); start everyone with no coach and nothing waiting.
  if (role === 'member') await ok('admin', 'PUT', `/api/auth/users/${user.id}/trainer`, { trainer_id: null });
}
const db = () => { const D = serverRequire('better-sqlite3'); return new D(join(dir, 'lt.db')); };
const state = async (who) => (await ok(who, 'GET', '/api/coaching/state'));
const request = (coach, client, note) => call(coach, 'POST', `/api/trainer/members/${ids[client]}`, note ? { note } : {});
const requestId = async (client, coach) => (await state(client)).requests.find(r => r.coach.id === ids[coach])?.id;
async function pair(coach, client) {
  await ok(coach, 'POST', `/api/trainer/members/${ids[client]}`, {});
  await ok(client, 'POST', `/api/coaching/pairings/${await requestId(client, coach)}/accept`, {});
}
async function workoutFor(who, date = TODAY) {
  const r = await ok(who, 'PUT', `/api/workout/${date}`, {
    name: 'Push', completed: true, duration_min: 40, notes: '',
    exercises: [{ uuid: `ex-${who}-${date}`, exercise_name: 'Bench Press', sets: [{ uuid: `s-${who}-${date}`, reps: 5, weight: 100, completed: true }] }],
  });
  return r.workout?.id ?? r.id;
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-coaching-'));
  await boot();
  await ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  const r = await ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW });
  tok.admin = r.token; ids.admin = r.user.id;
  await makeUser('admin2', 'admin', 'Second Admin');
  await makeUser('coach1', 'trainer', 'Sam Coach');
  await makeUser('coach2', 'trainer', 'Kim Coach');
  for (const [n, f] of [['client1', 'Cleo Client'], ['client2', 'Dev Client'], ['client3', 'Eli Client'], ['client4', 'Fay Client'], ['plain', 'Pat Plain']]) await makeUser(n, 'member', f);
});
test.after(async () => { await stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// Any object that looks like a person must be { id, name } and nothing else.
const ROW_KEYS = ['password_hash', 'email', 'username', 'birthday', 'gender', 'avatar_url', 'nickname', 'trainer_id', 'created_at'];
function assertNoUserRows(value, where) {
  if (Array.isArray(value)) return value.forEach((v) => assertNoUserRows(v, where));
  if (!value || typeof value !== 'object') return;
  for (const k of ROW_KEYS) assert.ok(!(k in value), `${where}: ${k} leaked in ${JSON.stringify(value).slice(0, 200)}`);
  for (const k of ['coach', 'client']) if (value[k] && typeof value[k] === 'object') assert.deepEqual(Object.keys(value[k]).sort(), ['id', 'name'], `${where}: ${k}`);
  for (const v of Object.values(value)) assertNoUserRows(v, where);
}

test('the server says it supports coaching, and /me says where you stand', { skip: !ready }, async () => {
  assert.equal((await call(null, 'GET', '/api/auth/status')).data.coaching, 2, '1 consent, 2 the conversation');
  const me = (await call('plain', 'GET', '/api/auth/me')).data;
  assert.deepEqual(me.coaching, { role: 'member', can_coach: false, as_client: null, requests: [], past: [], as_coach: { pending: 0, active: 0, recent: 0, active_ids: [], unread: 0 }, unread: 0, awaiting: 0 });
  assert.equal((await call('coach1', 'GET', '/api/auth/me')).data.coaching.can_coach, true);
});

test('the unpaired list carries id and name only', { skip: !ready }, async () => {
  const list = await ok('coach1', 'GET', '/api/trainer/unassigned-members');
  assert.ok(list.length >= 5);
  for (const p of list) {
    assert.deepEqual(Object.keys(p).sort(), ['full_name', 'id', 'name'], JSON.stringify(p));
    assert.equal(p.full_name, p.name, 'full_name is the same name, for released apps');
  }
  assert.ok(list.some(p => p.id === ids.client1 && p.name === 'Cleo Client'));
  assert.ok(!list.some(p => p.id === ids.coach1 || p.id === ids.admin), 'members only, never yourself');
});

test('a request shares nothing until the client accepts; then the coach sees them', { skip: !ready }, async () => {
  const r = await request('coach1', 'client1', 'Let us train together');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'pending');
  assert.equal((await call('coach1', 'GET', `/api/trainer/members/${ids.client1}`)).status, 404, 'nothing before Accept');
  assert.ok(!(await ok('coach1', 'GET', '/api/trainer/members')).some(m => m.id === ids.client1));
  const asked = await ok('coach1', 'GET', '/api/coaching/requests');
  assert.deepEqual(asked.map(x => [x.client.id, x.status]), [[ids.client1, 'pending']]);
  assertNoUserRows(asked, 'requests');
  assert.ok(!(await ok('coach1', 'GET', '/api/trainer/unassigned-members')).some(p => p.id === ids.client1), 'someone already asked leaves the list');
  // Asking twice says so.
  assert.equal((await request('coach1', 'client1')).status, 409);

  const s = await state('client1');
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0].coach, { id: ids.coach1, name: 'Sam Coach' });
  assert.equal(s.requests[0].note, 'Let us train together');
  assert.equal(s.awaiting, 1);
  assertNoUserRows(s, 'state');
  // Only the client answers.
  assert.equal((await call('coach1', 'POST', `/api/coaching/pairings/${s.requests[0].id}/accept`, {})).status, 404);
  assert.equal((await call('client2', 'POST', `/api/coaching/pairings/${s.requests[0].id}/accept`, {})).status, 404);
  const after = await ok('client1', 'POST', `/api/coaching/pairings/${s.requests[0].id}/accept`, {});
  assert.equal(after.as_client.coach.id, ids.coach1);
  assert.equal(after.requests.length, 0);
  assert.equal((await call('client1', 'GET', '/api/auth/me')).data.user.trainer_id, ids.coach1, 'trainer_id follows the pairing');
  const members = await ok('coach1', 'GET', '/api/trainer/members');
  assert.equal(members.find(m => m.id === ids.client1)?.pairing_id, after.as_client.id);
  for (const k of ['email', 'birthday', 'gender', 'password_hash', 'trainer_id']) {
    assert.ok(!(k in members[0]), `the client list carries no ${k}`);
    assert.ok(!(k in (await ok('coach1', 'GET', `/api/trainer/members/${ids.client1}`)).user), `the overview carries no ${k}`);
  }
  assert.equal((await call('coach1', 'GET', `/api/trainer/members/${ids.client1}`)).status, 200);
  assert.equal((await call('client1', 'POST', `/api/coaching/pairings/${s.requests[0].id}/accept`, {})).status, 409, 'answered once');
});

test('declining leaves nothing shared and tells the coach', { skip: !ready }, async () => {
  await ok('coach2', 'POST', `/api/trainer/members/${ids.client2}`, {});
  const id = await requestId('client2', 'coach2');
  await ok('client2', 'POST', `/api/coaching/pairings/${id}/decline`, {});
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client2}`)).status, 404);
  const asked = await ok('coach2', 'GET', '/api/coaching/requests');
  assert.equal(asked.find(x => x.client.id === ids.client2)?.status, 'declined');
  assert.equal((await state('coach2')).as_coach.recent, 1);
});

test('one coach at a time: another coach may ask, the client leaves before accepting', { skip: !ready }, async () => {
  const r = await request('coach2', 'client1');
  assert.equal(r.status, 200, 'asking never reveals the person already has a coach');
  const id = await requestId('client1', 'coach2');
  const a = await call('client1', 'POST', `/api/coaching/pairings/${id}/accept`, {});
  assert.equal(a.status, 409);
  assert.equal(a.data.code, 'leave_first');
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client1}`)).status, 404);
  // The coach can take a request back.
  await ok('coach2', 'POST', `/api/coaching/pairings/${id}/end`, { expect: 'pending' });
  assert.equal((await state('client1')).requests.length, 0);
  // Taking back a request the client has accepted meanwhile ends nothing.
  const active = (await state('client1')).as_client.id;
  const late = await call('coach1', 'POST', `/api/coaching/pairings/${active}/end`, { expect: 'pending' });
  assert.equal(late.status, 409);
  assert.equal((await state('client1')).as_client?.id, active, 'still coached');
});

// ── Privacy on every coach route ────────────────────────────────────────────
const GUARDED = [
  ['GET', '/members/:id'],
  ['GET', '/members/:id/workout/:date'],
  ['GET', '/members/:id/prescriptions'],
  ['POST', '/members/:id/prescriptions'],
  ['DELETE', '/members/:id'],
  ['POST', '/feedback'],
  ['PUT', '/prescriptions/:id'],
  ['DELETE', '/prescriptions/:id'],
];
// Not about one client: the coach's own lists, asking someone, read state.
const NOT_ABOUT_ONE_CLIENT = [['GET', '/members'], ['GET', '/unassigned-members'], ['POST', '/members/:id'], ['GET', '/activity'], ['POST', '/activity/seen']];

test('every trainer route is either guarded here or about no one client', { skip: !ready }, () => {
  const src = readFileSync(new URL('../server/routes/trainer.js', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map(([, m, p]) => `${m.toUpperCase()} ${p}`).sort();
  const known = [...GUARDED, ...NOT_ABOUT_ONE_CLIENT].map(([m, p]) => `${m} ${p}`).sort();
  assert.deepEqual(routes, known, 'a new coach route needs a privacy test');
});

test('privacy: own client, another coach\'s client, pending, ended, non-coach, admin who isn\'t the coach', { skip: !ready }, async () => {
  // client1: coach1's client. client2: a request from coach1, waiting.
  // client3: was coach1's client and left. plain: a Member.
  await ok('coach1', 'POST', `/api/trainer/members/${ids.client2}`, {});
  await pair('coach1', 'client3');
  const w1 = await workoutFor('client1');
  const w2 = await workoutFor('client2');
  const w3 = await workoutFor('client3');
  const px1 = (await ok('coach1', 'POST', `/api/trainer/members/${ids.client1}/prescriptions`, { name: 'Squat day', exercises: [], date: TODAY })).id;
  const px3 = (await ok('coach1', 'POST', `/api/trainer/members/${ids.client3}/prescriptions`, { name: 'Pull day', exercises: [] })).id;
  const pairing3 = (await state('client3')).as_client.id;
  await ok('client3', 'POST', `/api/coaching/pairings/${pairing3}/end`, {});
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM coach_prescriptions WHERE id = ${px3}`).c, 0, 'leaving takes that coach\'s prescriptions with it, as releasing did');

  // A prescription for each of the others, as an older server could have
  // left one: refused all the same.
  const leftover = (client) => { const d = db(); try { return d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises) VALUES (?, ?, 'Leftover', '[]')`).run(ids.coach1, ids[client]).lastInsertRowid; } finally { d.close(); } };
  const target = { client1: { w: w1, px: px1 }, client2: { w: w2, px: leftover('client2') }, client3: { w: w3, px: leftover('client3') } };
  const fill = (m, p, who, client) => {
    const t = target[client];
    const path = '/api/trainer' + p.replace(':id', p.startsWith('/prescriptions') ? t.px : ids[client]).replace(':date', TODAY);
    const body = m === 'GET' || m === 'DELETE' ? undefined
      : p === '/feedback' ? { workout_id: t.w, note: `Note by ${who}` }
      : p === '/members/:id/prescriptions' ? { name: `Rx by ${who}`, exercises: [] }
      : { notes: `Edit by ${who}` };
    return [path, body];
  };
  const cases = [
    ['coach2', 'client1', 404, 'another coach\'s client'],
    ['coach1', 'client2', 404, 'a request still waiting'],
    ['coach1', 'client3', 404, 'coaching that ended'],
    ['plain', 'client1', 403, 'a non-coach'],
    ['admin', 'client1', 404, 'an admin who isn\'t the coach'],
  ];
  for (const [m, p] of GUARDED) {
    for (const [who, client, want, what] of cases) {
      const [path, body] = fill(m, p, who, client);
      const r = await call(who, m, path, body);
      assert.equal(r.status, want, `${m} ${path} as ${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    }
  }
  // Program assignment: the same rule (an admin used to assign to anyone).
  const prog = await ok('coach1', 'POST', '/api/programs', { name: 'Coach plan', goal: 'strength' });
  const progAdmin = await ok('admin', 'POST', '/api/programs', { name: 'Admin plan', goal: 'strength' });
  for (const [who, client, want, what] of cases) {
    const pid = who === 'admin' ? progAdmin.id : prog.id;
    const a = await call(who, 'POST', `/api/programs/${pid}/assign`, { user_id: ids[client] });
    assert.equal(a.status, want === 403 ? 403 : 404, `assign as ${what}: ${a.status}`);
    const d = await call(who, 'DELETE', `/api/programs/${pid}/assign/${ids[client]}`);
    assert.equal(d.status, want === 403 ? 403 : 404, `unassign as ${what}: ${d.status}`);
  }
  // Nothing written by anyone refused.
  const notes = readRow(`SELECT COUNT(*) AS c FROM coach_feedback WHERE note LIKE 'Note by %'`).c;
  assert.equal(notes, 0);
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM coach_prescriptions WHERE name LIKE 'Rx by %'`).c, 0);

  // The coach of client1 can do all of it (DELETE /members/:id ends coaching: last).
  for (const [m, p] of GUARDED) {
    if (m === 'DELETE') continue;
    const [path, body] = fill(m, p, 'coach1', 'client1');
    const r = await call('coach1', m, path, body);
    assert.ok(r.status < 300, `${m} ${path} as the coach: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  }
  assert.equal((await call('coach1', 'POST', `/api/programs/${prog.id}/assign`, { user_id: ids.client1 })).status, 200);
  assert.equal((await call('coach1', 'DELETE', `/api/programs/${prog.id}/assign/${ids.client1}`)).status, 200);
});

test('privacy: set videos reach the client and their coach only', { skip: !ready }, async () => {
  // A clip row straight in the database (the upload itself is not what this is about).
  const w = await workoutFor('client1', '2026-01-02');
  const d = db();
  const id = d.prepare(`INSERT INTO set_media (user_id, workout_id, date, exercise_uuid, url, mime) VALUES (?, ?, '2026-01-02', 'ex-x', '/uploads/set-videos/none.mp4', 'video/mp4')`).run(ids.client1, w).lastInsertRowid;
  d.close();
  const listFor = async (who) => (await ok(who, 'GET', `/api/set-media?workout_id=${w}`)).media.map(m => m.id);
  assert.deepEqual(await listFor('client1'), [id]);
  assert.deepEqual(await listFor('coach1'), [id]);
  for (const who of ['coach2', 'admin', 'plain']) {
    assert.deepEqual(await listFor(who), [], `${who} sees no clip`);
    assert.equal((await call(who, 'GET', `/api/set-media/${id}/file`)).status, 404);
  }
});

function readRow(sql) { const d = db(); try { return d.prepare(sql).get(); } finally { d.close(); } }

test('the activity feed is each coach\'s own, for clients still coached', { skip: !ready }, async () => {
  // client1 completes the workout coach1 prescribed for today: an event for coach1.
  await workoutFor('client1');
  const d = db();
  d.prepare(`INSERT INTO coach_activity (trainer_id, member_id, kind) VALUES (?, ?, 'prescription_completed')`).run(ids.coach1, ids.client1);
  d.prepare(`INSERT INTO coach_activity (trainer_id, member_id, kind) VALUES (?, ?, 'prescription_completed')`).run(ids.coach1, ids.client3);
  d.close();
  const mine = await ok('coach1', 'GET', '/api/trainer/activity');
  assert.ok(mine.length >= 1);
  assert.ok(mine.every(a => a.trainer_id === ids.coach1 && a.member_id === ids.client1), 'own clients still coached, never a client who left');
  assert.deepEqual(await ok('admin', 'GET', '/api/trainer/activity'), [], 'an admin no longer sees every coach\'s events');
  assert.deepEqual(await ok('coach2', 'GET', '/api/trainer/activity'), []);
});

test('the client can leave; the coach can end it; either way access goes', { skip: !ready }, async () => {
  await pair('coach2', 'client4');
  const prog = await ok('coach2', 'POST', '/api/programs', { name: 'Kim plan', goal: 'strength' });
  await ok('coach2', 'POST', `/api/programs/${prog.id}/assign`, { user_id: ids.client4 });
  const pid = (await state('client4')).as_client.id;
  // Someone else can't end it.
  assert.equal((await call('coach1', 'POST', `/api/coaching/pairings/${pid}/end`, {})).status, 404);
  const after = await ok('client4', 'POST', `/api/coaching/pairings/${pid}/end`, {});
  assert.equal(after.as_client, null);
  assert.equal((await call('client4', 'GET', '/api/auth/me')).data.user.trainer_id, null);
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client4}`)).status, 404);
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM program_assignments WHERE assigned_to = ${ids.client4}`).c, 0, 'what that coach assigned goes, as releasing did');
  const asked = await ok('coach2', 'GET', '/api/coaching/requests');
  assert.equal(asked.find(x => x.client.id === ids.client4)?.status, 'ended', 'the coach sees the client left');
  assert.equal((await call('client4', 'POST', `/api/coaching/pairings/${pid}/end`, {})).status, 409);

  // The coach ends it (End Coaching), same path as before.
  await pair('coach2', 'client4');
  await ok('coach2', 'DELETE', `/api/trainer/members/${ids.client4}`);
  assert.equal((await state('client4')).as_client, null);
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client4}`)).status, 404);
});

test('the admin trainer picker sends a request; No Trainer ends coaching and requests', { skip: !ready }, async () => {
  const r = await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: ids.coach1 });
  assert.equal(r.status, 'pending');
  assert.equal((await call('client4', 'GET', '/api/auth/me')).data.user.trainer_id, null, 'not paired outright');
  assert.equal((await call('coach1', 'GET', `/api/trainer/members/${ids.client4}`)).status, 404);
  const users = await ok('admin', 'GET', '/api/auth/users');
  assert.deepEqual(users.find(u => u.id === ids.client4).coaching_requests.map(r => r.coach), [{ id: ids.coach1, name: 'Sam Coach' }], 'Users shows the request with no extra call');
  const pairs = await ok('admin', 'GET', '/api/coaching/admin/pairings');
  assert.ok(pairs.some(p => p.client.id === ids.client4 && p.coach.id === ids.coach1 && p.status === 'pending'));
  assertNoUserRows(pairs, 'admin pairings');
  assert.equal((await call('coach1', 'GET', '/api/coaching/admin/pairings')).status, 403);
  await ok('client4', 'POST', `/api/coaching/pairings/${await requestId('client4', 'coach1')}/accept`, {});
  assert.equal((await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: ids.coach1 })).status, 'active');
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: null });
  assert.equal((await state('client4')).as_client, null);
  // An admin can also end any pairing directly.
  await pair('coach2', 'client4');
  await ok('admin', 'POST', `/api/coaching/pairings/${(await state('client4')).as_client.id}/end`, {});
  assert.equal((await state('client4')).as_client, null);
});

test('an admin ending coaching (No Trainer, a role change) keeps the client\'s programs and prescriptions', { skip: !ready }, async () => {
  await pair('coach2', 'client4');
  const prog = await ok('coach2', 'POST', '/api/programs', { name: 'Kept plan', goal: 'strength' });
  await ok('coach2', 'POST', `/api/programs/${prog.id}/assign`, { user_id: ids.client4 });
  await ok('coach2', 'POST', `/api/trainer/members/${ids.client4}/prescriptions`, { name: 'Kept Rx', exercises: [] });
  const count = () => readRow(`SELECT (SELECT COUNT(*) FROM program_assignments WHERE assigned_to = ${ids.client4}) + (SELECT COUNT(*) FROM coach_prescriptions WHERE member_id = ${ids.client4}) AS c`).c;
  assert.equal(count(), 2);
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: null });
  assert.equal((await state('client4')).as_client, null);
  assert.equal(count(), 2, 'No Trainer only ended it, as it only cleared the trainer before');
  await pair('coach2', 'client4');
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'member' });
  assert.equal((await state('client4')).as_client, null);
  assert.equal(count(), 2, 'a role change only ends it too');
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'trainer' });
  const d = db();
  d.prepare(`DELETE FROM program_assignments WHERE assigned_to = ?`).run(ids.client4);
  d.prepare(`DELETE FROM coach_prescriptions WHERE member_id = ?`).run(ids.client4);
  d.close();
});

test('a client given another role outside Settings is no longer readable by their coach', { skip: !ready }, async () => {
  // An SSO group mapping sets the role at sign-in; the guard checks it too.
  await pair('coach2', 'client4');
  const d = db();
  d.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(ids.client4);
  d.close();
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client4}`)).status, 404);
  const d2 = db();
  d2.prepare(`UPDATE users SET role = 'member' WHERE id = ?`).run(ids.client4);
  d2.close();
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client4}`)).status, 200);
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: null });
});

test('a reply to a former coach\'s note reaches nobody', { skip: !ready }, async () => {
  await pair('coach2', 'client4');
  const w = await workoutFor('client4', '2026-02-03');
  await ok('coach2', 'POST', '/api/trainer/feedback', { workout_id: w, note: 'Good depth' });
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: null });
  const note = (await ok('client4', 'GET', '/api/coach-feedback/inbox')).find(n => n.note === 'Good depth');
  await ok('client4', 'PUT', `/api/coach-feedback/${note.id}/reply`, { reply: 'Thanks' });
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM coach_activity WHERE feedback_id = ${note.id}`).c, 0);
});

test('role changes end coaching that no longer fits', { skip: !ready }, async () => {
  await pair('coach2', 'client4');
  // The client made a Trainer: only Members are coached.
  const r = await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/role`, { role: 'trainer' });
  assert.equal(r.coaching_ended, 1);
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client4}`)).status, 404);
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/role`, { role: 'member' });
  // The coach made a Member: their coaching ends, and the token's old role doesn't help.
  await pair('coach2', 'client4');
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'member' });
  assert.equal((await state('client4')).as_client, null);
  assert.equal((await call('coach2', 'GET', '/api/trainer/members')).status, 403);
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'trainer' });
  // A Trainer made an admin keeps their clients (admins can coach).
  await pair('coach2', 'client4');
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'admin' });
  assert.equal((await state('client4')).as_client?.coach.id, ids.coach2);
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach2}/role`, { role: 'trainer' });
});

test('a new account and an invite bring a request, never a coach', { skip: !ready }, async () => {
  const { user } = await ok('admin', 'POST', '/api/auth/register', { username: 'newbie', password: PW, full_name: 'New Bie', role: 'member' });
  ids.newbie = user.id; sign('newbie', user.role);
  assert.equal(user.trainer_id ?? null, null);
  const s = await state('newbie');
  assert.equal(s.as_client, null);
  assert.deepEqual(s.requests.map(r => r.coach.id), [ids.admin], 'the admin who made it asks');

  const inv = await ok('admin', 'POST', '/api/auth/invite', { role: 'member' });
  const token = new URL(inv.inviteUrl.replace('#/', '')).searchParams.get('token');
  const acc = await ok(null, 'POST', '/api/auth/accept-invite', { token, username: 'invited', password: PW, full_name: 'In Vited' });
  ids.invited = acc.user.id; tok.invited = acc.token;
  assert.equal(acc.user.trainer_id ?? null, null);
  assert.deepEqual((await state('invited')).requests.map(r => r.coach.id), [ids.admin]);
});

test('deleting an account removes its pairings; the other person is fine', { skip: !ready }, async () => {
  await makeUser('tmpcoach', 'trainer', 'Tim Porary');
  await makeUser('tmpclient', 'member', 'Tam Porary');
  await ok('admin', 'PUT', `/api/auth/users/${ids.client4}/trainer`, { trainer_id: null });
  await pair('tmpcoach', 'client4');
  await pair('coach1', 'tmpclient');
  await ok('admin', 'DELETE', `/api/auth/users/${ids.tmpcoach}`);
  assert.equal((await state('client4')).as_client, null);
  assert.equal((await call('client4', 'GET', '/api/auth/me')).data.user.trainer_id, null);
  await ok('tmpclient', 'DELETE', '/api/auth/me');
  assert.ok(!(await ok('coach1', 'GET', '/api/trainer/members')).some(m => m.id === ids.tmpclient));
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM coach_clients WHERE coach_id = ${ids.tmpcoach} OR client_id = ${ids.tmpclient}`).c, 0);
});

test('pairings from before consent stay active, with nothing to accept', { skip: !ready }, async () => {
  // An older server paired by trainer_id alone. Write that straight into the
  // database with this server stopped, as an upgrade finds it.
  await stop();
  const d = db();
  d.prepare(`DELETE FROM coach_clients WHERE client_id = ?`).run(ids.client2);
  d.prepare(`UPDATE users SET trainer_id = ? WHERE id = ?`).run(ids.coach2, ids.client2);
  d.prepare(`INSERT INTO coach_prescriptions (trainer_id, member_id, name, exercises) VALUES (?, ?, 'Old Rx', '[]')`).run(ids.coach2, ids.client2);
  d.close();
  await boot();
  const s = await state('client2');
  assert.equal(s.as_client?.coach.id, ids.coach2, 'kept as the coach');
  assert.equal(s.requests.length, 0, 'no request sent');
  assert.equal((await call('coach2', 'GET', `/api/trainer/members/${ids.client2}`)).status, 200);
  assert.ok((await ok('coach2', 'GET', `/api/trainer/members/${ids.client2}/prescriptions`)).some(p => p.name === 'Old Rx'));
  assert.equal(s.as_client.responded_at, null, 'no made-up "since" date');
  // A second start adds nothing.
  await stop();
  // A trainer pointing at someone who can't coach gave no access before;
  // it is cleared, so a coach can ask that person.
  const d2 = db();
  d2.prepare(`UPDATE users SET trainer_id = ? WHERE id = ?`).run(ids.plain, ids.client3);
  d2.close();
  await boot();
  assert.equal(readRow(`SELECT COUNT(*) AS c FROM coach_clients WHERE client_id = ${ids.client2} AND status = 'active'`).c, 1);
  assert.equal(readRow(`SELECT trainer_id FROM users WHERE id = ${ids.client3}`).trainer_id, null);
  assert.ok((await ok('coach2', 'GET', '/api/trainer/unassigned-members')).some(p => p.id === ids.client3));
});

test('backup and restore keep coaching; a backup from before consent keeps its trainers', { skip: !ready }, async () => {
  const before = await state('client1');
  const { filename } = await ok('admin', 'POST', '/api/full-backup');
  await ok('admin', 'POST', `/api/full-backup/${filename}/restore`);
  const after = await state('client1');
  assert.equal(after.as_client?.id, before.as_client?.id);
  assert.equal(after.as_client?.coach.id, ids.coach1);
  assert.ok((await ok('coach2', 'GET', '/api/coaching/requests')).length >= 0);

  // The same backup with no pairings in it (as an older server writes it).
  const AdmZip = serverRequire('adm-zip');
  const zip = new AdmZip(join(dir, 'backups', filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  delete data.coach_clients;
  zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
  const old = join(dir, 'old-backup.zip');
  zip.writeZip(old);
  const form = new FormData();
  form.append('backup', new Blob([readFileSync(old)], { type: 'application/zip' }), 'old-backup.zip');
  const r = await fetch(base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${tok.admin}` }, body: form });
  assert.ok(r.ok, await r.text());
  const kept = await state('client1');
  assert.equal(kept.as_client?.coach.id, ids.coach1, 'its trainer kept, accepted');
  assert.equal(kept.requests.length, 0);
  assert.equal((await call('coach1', 'GET', `/api/trainer/members/${ids.client1}`)).status, 200);
});

test('the fingerprint rides on a read the Diary already makes', { skip: !ready }, async () => {
  const r = await call('client1', 'GET', '/api/coach-feedback/unread-dates');
  assert.equal(r.status, 200);
  const sig = r.headers.get('x-lt-coaching');
  assert.ok(sig && sig.startsWith('member;'), sig);
  await ok('coach2', 'POST', `/api/trainer/members/${ids.plain}`, {});
  const a = (await call('plain', 'GET', '/api/coach-feedback/unread-dates')).headers.get('x-lt-coaching');
  await ok('admin', 'PUT', `/api/auth/users/${ids.plain}/trainer`, { trainer_id: null });
  const b = (await call('plain', 'GET', '/api/coach-feedback/unread-dates')).headers.get('x-lt-coaching');
  assert.notEqual(a, b, 'a request coming and going changes it');
});
