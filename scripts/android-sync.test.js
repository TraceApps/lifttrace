/**
 * The Android app, connected to a server, keeping its copy in step.
 *
 * Runs the app's own sync code (src/lib/sync.js, apiFetch.js, api-native.js,
 * db-native.js, migrate.js; Capacitor swapped for scripts/android-sync/)
 * against a real server started from server/index.js, one fresh server per
 * scenario. Each scenario failed before the fix it covers:
 *
 *   - rows made offline went up under the phone's own ids, which named other
 *     accounts' programs, days and exercises on the server;
 *   - those ids also hid the server's row with the same number from the phone;
 *   - an offline edit left the row deaf to every later change from the web;
 *   - rows deleted outright on the server stayed on the phone, as did days
 *     older servers handed every phone;
 *   - a write the server refused vanished without a word, and the phone kept
 *     showing it;
 *   - a second sync pulled while the first was still sending;
 *   - a prescribed day from a program the athlete doesn't follow didn't open;
 *   - and the rest listed test by test below.
 *
 * Plus the server's own checks, on the real schema.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const SECRET = 'android-sync-test-secret-0123456789abcdef';
let jwt = null, Database = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  Database = req('better-sqlite3');
  // The native part loads on first use, so use it: a build for another
  // Node fails here and the server scenarios skip, rather than failing.
  new Database(':memory:').close();
  jwt = req('jsonwebtoken');
} catch { Database = null; jwt = null; /* server deps not installed or not built for this Node */ }
const ready = !!jwt && typeof nodeModule.register === 'function';
const skip = ready ? false : 'needs the server dependencies and Node 20.6 or later';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

// Every server and phone process this file starts, so none outlives it:
// stopped after each scenario, after the whole file, and on any exit.
const children = new Set();
const track = (proc) => { children.add(proc); proc.on('exit', () => children.delete(proc)); return proc; };
const killAll = () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });
test.after(killAll);

// Generous on a loaded machine; a server that never comes up fails the
// scenario (and is killed) instead of hanging the run.
const START_WAIT_MS = 120000;
// Each test: a server start, a phone run (killed at 300 s) and its checks.
// A test that hangs fails here instead of holding the whole run.
const SCENARIO_MS = 480000;
// Any one request to a test server.
const CALL_MS = 30000;

async function startServer({ accounts = true, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-android-sync-'));
  const port = await freePort();
  const proc = track(spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: SECRET, INSECURE_COOKIES: '1', UPDATE_CHECK: '0', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const stop = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* still closing */ } };
  const base = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  for (;;) {
    try { await fetch(base + '/api/auth/me', { signal: AbortSignal.timeout(5000) }); break; } catch { /* not listening yet */ }
    if (proc.exitCode != null || Date.now() - startedAt > START_WAIT_MS) {
      stop();
      throw new Error('server did not start: ' + errors.slice(-500));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  const call = async (token, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CALL_MS) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  if (!accounts) return { base, call, tokens: { other: '', phone: '' }, memberId: 1, dbPath: join(dir, 'app.db'), stop };
  // The first account is the admin (and coach); the phone belongs to a member.
  let admin, member;
  try {
    admin = await call(null, 'POST', '/api/auth/register', { username: 'coach', password: 'Str0ng-Pass-77!x' });
    member = await call(admin.token, 'POST', '/api/auth/register', { username: 'athlete', password: 'Str0ng-Pass-88!y', role: 'member' });
  } catch (e) { stop(); throw e; }
  const memberToken = jwt.sign({ id: member.user.id, username: member.user.username, role: member.user.role }, SECRET, { expiresIn: '1h' });
  const expired = jwt.sign({ id: member.user.id, username: member.user.username, role: member.user.role, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
  return {
    base, call, tokens: { other: admin.token, phone: memberToken, expired }, memberId: member.user.id, adminId: admin.user.id, dbPath: join(dir, 'app.db'),
    stop,
  };
}

function runPhone(srv, scenario, second = null) {
  return new Promise((resolve, reject) => {
    track(execFile(process.execPath, ['--import', './scripts/android-sync/register.mjs', 'scripts/android-sync/phone.mjs', scenario], {
      cwd: root,
      env: { ...process.env, LT_SERVER: srv.base, LT_TOKEN: srv.tokens.phone, LT_TOKENS: JSON.stringify(srv.tokens), LT_PHONE_USER: String(srv.memberId),
        LT_OTHER_USER: String(srv.adminId ?? ''),
        // A second server (another one the phone connects to after Disconnect).
        LT_SERVER_B: second?.base || '', LT_TOKENS_B: JSON.stringify(second?.tokens || {}), LT_B_USER: String(second?.memberId ?? '') },
      timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
    }, (err, stdout, stderr) => {
      const last = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch { reject(new Error(`${scenario}: ${err?.message || ''}\n${stderr.slice(-1500)}\n${stdout.slice(-500)}`)); }
    }));
  });
}

async function scenario(name, opts = {}) {
  const srv = await startServer(opts);
  let second = null;
  try {
    if (opts.second) second = await startServer();
    return { srv, second, out: await runPhone(srv, name, second) };
  } finally { srv.stop(); second?.stop(); }
}

test('rows made offline go up under the server\'s ids, and point at each other there', { skip, timeout: SCENARIO_MS }, async () => {
  const { srv, out } = await scenario('offlineIds');
  assert.ok(out.deviceIds.every(id => id < 0), 'made offline with ids below zero');
  // Made by the signed-in account (not account 1), as the server records it,
  // so the program's screens treat it as theirs before and after it syncs.
  const me = Number(srv.memberId);
  assert.notEqual(me, 1);
  assert.deepEqual(out.madeBy, { program: me, exercise: me });
  assert.equal(out.serverMadeBy, me);
  assert.equal(out.pulledMadeBy, me);
  assert.equal(out.serverPlans, 1);
  assert.deepEqual(out.serverDay, ['Phone Day']);
  assert.deepEqual(out.workout, { program: 'Phone Plan', template: 'Phone Day', exercise: 'Phone Curl' });
  assert.deepEqual(out.phonePlans, ['Phone Plan'], 'one copy on the phone');
  assert.equal(out.phoneDeviceRows, 0);
  assert.equal(out.queue, 0);
  assert.equal(out.staleIdOpens, 'Phone Plan', 'a screen still holding the device id finds the row');
  assert.deepEqual(out.refused, []);
});

test('a row made offline never hides the server\'s row with the same number', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('collide');
  assert.deepEqual(out.phone, ['Phone Plan', 'Web Plan', 'Web Plan 2']);
});

test('after an offline edit has gone up, later changes on the web still arrive', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('editThenWeb');
  assert.deepEqual(out, { program: 'Renamed on the web', exercise: 'Ex renamed on the web' });
});

test('rows deleted on the server leave the phone, as do days it should never have had', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('deletes');
  assert.ok(out.before.programs.includes('Gone Plan') && out.before.programs.includes('Other Private') && out.before.chat === 1);
  assert.deepEqual(out.programs, ['Keep Plan']);
  assert.deepEqual(out.days, []);
  assert.deepEqual(out.exercises, []);
  assert.equal(out.assignments, 0);
  assert.equal(out.chat, 0);
  assert.equal(out.weightUnit, null);
});

test('a refused write is reported and the phone shows what the server has', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('refused');
  assert.equal(out.ok, false);
  // The day added to the refused program went with it, under that one message.
  assert.deepEqual(out.refused, ['a program workout you changed', 'a program you added', 'a program you changed']);
  assert.equal(out.coachDay, 'Coach Day');
  assert.deepEqual(out.programs, ['Coach Plan']);
  assert.equal(out.orphanDay, 0);
  assert.equal(out.queue, 0);
});

test('a second sync waits for the first to finish sending', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('overlap');
  assert.ok(out.timeline.includes('write'));
  assert.ok(out.timeline.every(e => !/writes in flight: [1-9]/.test(e)), out.timeline.join(', '));
  assert.deepEqual(out.activeAfterSecond, ['Plan X']);
  assert.deepEqual(out.listed, ['Plan X'], 'the program list shows it active');
});

test('a prescribed day opens on the phone, online and offline', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('prescribed');
  assert.deepEqual(out, { online: 'Rx Day: 1', offline: 'Rx Day: 1' });
});

test('without user accounts, deleting all custom exercises works and writes queued after it go up', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('singleUser', { accounts: false });
  assert.deepEqual(out.web, { ok: true, removed: 1 }, 'the web, online');
  assert.deepEqual(out.refused, []);
  assert.equal(out.queue, 0);
  assert.equal(out.stillSignedIn, true);
  assert.deepEqual(out.serverCustom, ['Phone Custom C']);
  assert.deepEqual(out.serverWorkout, ['Queued after delete-all']);
  assert.deepEqual(out.phoneCustom, ['Phone Custom C']);
});

test('an earlier version\'s queued workouts go up, edits included, and leave pulled rows alone', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('legacySameId');
  assert.deepEqual(out.server05, { name: 'Offline edited', sets: 2 }, 'the edit behind a create the server gave the same id');
  assert.equal(out.server06, 'Other offline edited');
  assert.deepEqual(out.phoneDayA, ['Server Day A'], 'the pulled row with that id stays put');
  assert.deepEqual(out.refused, []);
});

test('rows only this phone has stay; Upload leaves one copy and keeps references', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('localOnly');
  assert.deepEqual(out.programs, ['Fails To Upload', 'Standalone Plan']);
  assert.deepEqual(out.workoutProgram, ['Standalone Plan']);
});

test('a write naming a row made offline waits for it, even once back online', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('beforeFlush');
  assert.equal(out.dayError, null);
  assert.equal(out.workoutExercise, true);
  assert.deepEqual(out.serverDays, ['Day added online']);
  assert.deepEqual(out.refused, []);
});

test('a create sent again after its answer was lost makes one row', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('lostAnswer');
  assert.deepEqual(out, { serverPlans: 1, serverCardio: 1, queue: 0 });
});

test('per-exercise settings and cardio follow an offline-made row to its server id', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('followIds');
  assert.deepEqual(out.rest, { [out.serverEx]: 150 });
  assert.deepEqual(out.fav, [out.serverEx]);
  assert.deepEqual(out.cardio, ['Phone Row 25', 'Web Run 30']);
});

test('without user accounts, the program being followed syncs both ways', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('soloActive', { accounts: false });
  assert.deepEqual(out, { afterSync: ['Push / Pull / Legs'], afterWeb: ['Upper / Lower'] });
});

test('rows a pull leaves for a queued write are asked for again', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('skippedRows');
  assert.deepEqual(out.assigned, ['Plan X', 'Plan Z']);
});

test('a shared sync round answers every caller alike; an already-gone delete is quiet', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('rounds');
  assert.deepEqual(out.first, { ok: false, refused: ['a program you changed'] });
  assert.deepEqual(out.third, { hasOk: true, hasRefused: true });
});

test('Replace with server deletes the phone\'s data', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('download', { accounts: false });
  assert.equal(out.before, 2);
  assert.equal(out.after, 0);
});

test('body stats only this phone has are kept and merged, never written over', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('bodyStats');
  assert.deepEqual(out.phone01, { weight: 79, waist: 81 }, 'same date: the server\'s weight stands, the phone\'s waist stays');
  assert.deepEqual(out.server01, { weight: 79, waist: 81 }, 'and goes up');
  assert.deepEqual(out.phone02, { arms: 35 }, 'another date under an id the server uses: kept');
  assert.deepEqual(out.phone0901, { weight: 80 });
});

test('rows only this phone has, written to, are created on the server first and never lost', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('movedRows');
  assert.deepEqual(out.movedIds, [true, true], 'moved out of the way of the server\'s rows');
  assert.deepEqual(out.server01, ['Local Only edited precious 12']);
  assert.deepEqual(out.serverPlanDays, ['Local Day 1', 'Local Day 2']);
  assert.deepEqual(out.phone03, ['Local Untouched', 'Offline Session'], 'a new session doesn\'t take the place of a row only here');
  assert.deepEqual(out.phoneDays, ['Local Day 1', 'Local Day 2']);
  assert.deepEqual(out.refused, []);
});

test('Upload keeps sessions apart, leaves the server\'s alone, sends body stats and the program being followed', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('uploadSessions');
  assert.equal(out.errors, 0);
  assert.deepEqual(out.server01, ['Evening PM', 'Morning AM']);
  assert.deepEqual(out.server02, ['Phone 2nd', 'Web Session web notes 45']);
  assert.deepEqual(out.body01, { weight: 80, waist: 81 });
  assert.equal(out.serverActive, 'Standalone Plan week 2');
  assert.deepEqual(out.phoneActive, ['Standalone Plan']);
  assert.equal(out.phoneSessions, 4, 'one copy of each on the phone');
});

test('create keys: a deleted row isn\'t made again, a lost online answer makes one row', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('createKeys');
  assert.deepEqual(out.afterReplay, { server: 0, phone: 0, queue: 0, refused: 0 });
  assert.equal(out.onlineCopies, 1);
});

test('a write the server keeps failing doesn\'t make every pull bigger', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('floorAges');
  assert.notEqual(out.whileFailing.since, out.oldFloor, 'the old floor is let go');
  assert.notEqual(out.whileFailing.floor, out.oldFloor);
  assert.equal(out.whileFailing.later, '1');
  assert.equal(out.sinceAfterDrained, '1970-01-01T00:00:00.000Z', 'one full pull once the queue has gone up');
  assert.equal(out.laterAfter, '');
  assert.equal(out.server, 'P renamed');
});

test('another account signing in never sees or sends the first one\'s data', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('accounts');
  assert.equal(out.early, 'other_account', 'no sync before the check');
  assert.deepEqual(out.keep, { kept: false, asked: 1, afterKeep: ['Athlete Offline', 'Athlete Synced'] }, 'keep: the sign-in is undone, nothing cleared');
  assert.deepEqual(out.back, { back: true, askedAthlete: null }, 'the same account back: no question');
  assert.deepEqual(out.discard, { discarded: true, askedAgain: 1, coachPhone: [] }, 'discard: the copy is cleared and filled from the coach');
  assert.deepEqual(out.clean, { clean: true, askedClean: null, athletePhone: ['Athlete Offline', 'Athlete Synced'] }, 'nothing waiting: no question, a fresh copy');
  assert.deepEqual(out.athleteServer, ['Athlete Offline', 'Athlete Synced']);
  assert.deepEqual(out.coachServer, []);
  assert.equal(out.athleteWritesUnderCoach, 0);
});

test('the same account at another address, or opened offline, is still the same account', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('sameAccountElsewhere');
  assert.deepEqual(out, { offlineOk: true, askedOffline: null, ok: true, asked: null, server: 1 });
});

test('an expired session: the queue is kept through the sign-out and goes up after signing back in', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('expiredToken');
  assert.deepEqual(out, { ok: true, asked: null, signedOut: true, queuedAfter401: 1, ok2: true, asked2: null, server: 1 });
});

test('signing out part way through a sync never sends the rest under the next session', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('signOutMidSync');
  assert.equal(out.sent, 4);
  assert.equal(out.allAthlete, true);
  assert.equal(out.coachServer, 0);
});

test('after Disconnect the data is the phone\'s own: the next account signs in with no question, nothing lost', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('disconnectThenOther');
  assert.deepEqual(out, { ok: true, asked: null, kept: ['Made On Its Own'] });
});

test('Settings: Disconnect sends or asks, Download clears the phone\'s data and asks before dropping unsent changes', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('settingsDownload');
  assert.deepEqual(out.disconnect, { stopped: false, asked: 1, queueKept: 1, went: true, asked2: null, onServer: 1 });
  assert.deepEqual(out.download, { declined: false, asked3: 1, stillThere: ['Standalone Before Download'], go: true, signIn: true, asked4: null,
    phone: ['Coach Server Plan'], queue: 0, leftSent: 0 });
});

test('if the phone cannot tell whose data it holds, it shows none of it and can try again', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('gateError');
  assert.deepEqual(out, { first: false, state1: 'error', shown1: false, second: true, shown2: true });
});

test('a slow link: the pull is compressed and finishes; a hung one isn\'t stacked', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('slowLink');
  assert.equal(out.firstOk, true);
  assert.ok(out.wire * 4 < out.raw, `compressed: ${out.wire} of ${out.raw} bytes`);
  assert.equal(out.fullPullAfter, '', 'the full pull is done, not left pending');
  assert.equal(out.stuckOk, false, 'given up on at its deadline');
  assert.equal(out.nextOk, false, 'and the next one waits for it');
  assert.equal(out.nativePullsStarted, 1, 'one download, not two');
  assert.equal(out.workouts, 120);
});

test('another account signing in while a pull is downloading gets none of the first one\'s data', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('accountRace');
  assert.equal(out.switched, true);
  assert.equal(out.quick, true, 'the sign-in doesn\'t wait for the download');
  assert.deepEqual(out.r1, { ok: false, reason: 'account_changed' });
  assert.deepEqual(out.afterRace, { workouts: [], programs: [], setting: 0, fullPull: '1' }, 'nothing landed, and the full pull is still to do');
  assert.deepEqual(out.coachPhone, { workouts: ['Coach Session'], programs: ['Coach Plan'], setting: 0 });
});

test('Upload after Disconnect sends everything the phone had, as counted, and keeps it until it\'s there', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('uploadAfterDisconnect', { second: true });
  assert.deepEqual(out.afterDisconnect, { workouts: ['A Session own'], programs: ['A Plan'] }, 'the phone\'s own after Disconnect');
  assert.deepEqual(out.counts, { w: 2, p: 1, t: 1, b: 1 });
  assert.deepEqual(out.uploaded, out.counts, 'the dialog counted exactly what went up');
  assert.equal(out.errors, 0);
  assert.deepEqual(out.onB, { workouts: ['A Session', 'Local Session'], days: ['A Day'], weight: 80 });
  assert.deepEqual(out.phone, { workouts: ['A Session', 'Local Session'], programs: ['A Plan'], days: ['A Day'] });
});

test('a pulled deletion never takes a row only this phone has, or one with a change still to go up', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('pulledDeletes');
  assert.ok(out.localIds.includes(1), 'the phone\'s row had an id the server\'s deleted sessions used');
  assert.equal(out.uploadErrors, 1);
  assert.deepEqual(out.localOnly, ['Local Keep pending']);
  assert.deepEqual(out.whileWaiting, { program: ['Edited Here, renamed'], workout: ['Edited Session, renamed'] });
});

test('a copy from an earlier version: queued creates, edited rows and the phone\'s own rows each end up as one', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('legacyUpgrade');
  assert.deepEqual(out.phone, ['Already Up server clean', 'Legacy Plan server clean', 'No Time Plan own pending', 'Phone Only Plan own pending',
    'Server Plan One server clean', 'Server Plan Three server clean', 'Server Plan Two server clean']);
  assert.equal(out.serverLegacy, 1);
  assert.equal(out.serverTwo, 1);
  assert.equal(out.serverUp, 1);
  assert.equal(out.flag, '1');
  assert.deepEqual(out.refused, []);
});

test('a create whose answer was lost, then an edit to the server\'s copy: one row', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('lostAnswerEdit');
  assert.deepEqual(out, { phone: ['Phone Plan edited'], server: ['Phone Plan edited'], queue: 0 });
});

test('the next account never sees or saves what the app held for the last one', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('storesReset');
  assert.deepEqual(out.seen, { gotify: '', radio: '', favorites: [], rest: {}, workout: null });
  assert.deepEqual(out.coachServer, { gotify: null, radio: null, favorites: null, rest: { 202: 60 } });
  assert.equal(out.athleteServer, 'athlete-secret', 'the change still waiting at the switch went nowhere');
  assert.equal(out.afterSignOut, '', 'signing out clears them too');
});

test('Disconnect, then the same account again with Upload: each row once, changes made meanwhile go up as changes', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('sameAccountUpload');
  assert.deepEqual(out.counts, { w: 1, p: 0, c: 1 }, 'only what is new is counted');
  assert.deepEqual(out.uploaded, out.counts);
  assert.equal(out.errors, 0);
  assert.deepEqual(out.server, { sessions: ['B Session', 'Offline Session', 'S Session'], plans: ['S Plan renamed here'], days: ['S Day'], curls: 1, cardio: ['Phone Row', 'Server Row'] });
  assert.deepEqual(out.phone, { sessions: ['B Session', 'Offline Session', 'S Session'], plans: ['S Plan renamed here server'], curlRef: [true] });
  assert.equal(out.queue, 0);
});

test('Disconnect stopped part way leaves the copy as it was, still the account\'s', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('disconnectKilled');
  const unchanged = { err: 'killed', plans: ['K Plan server'], orphanDays: 0, danglingWorkouts: 0, ownRows: 0, owner: out.killed.first.owner, origins: 0 };
  assert.ok(out.killed.first.owner != null);
  for (const at of ['first', 'days', 'ids', 'tag']) assert.deepEqual(out.killed[at], unchanged, `stopped at ${at}`);
  assert.deepEqual(out.after, { plans: ['K Plan renamed own'], orphanDays: 0, danglingWorkouts: 0, ownRows: 8, owner: null, origins: 8 });
  assert.deepEqual(out.server, ['K Plan renamed'], 'one plan, renamed');
});

test('no sync runs while Disconnect is moving the rows', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('syncDuringDisconnect');
  assert.deepEqual(out, { poll: { ok: false, reason: 'other_account' }, programs: ['P0 own', 'P1 own', 'P2 own', 'P3 own'], serverRows: 0 });
});

test('Disconnect on a big account is a few dozen statements, in one transaction, and every reference follows', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('bigDisconnect');
  assert.ok(out.statements < 300, `${out.statements} statements`);
  assert.ok(out.calls < 60, `${out.calls} database calls`);
  assert.deepEqual({ own: out.own, workoutRefs: out.workoutRefs, rxRefs: out.rxRefs, favorites: out.favorites, unchangedSets: out.unchangedSets },
    { own: true, workoutRefs: true, rxRefs: true, favorites: true, unchangedSets: true });
});

test('the account check and a sync claiming the same copy at once leave every link intact', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('claimRace');
  for (const round of out) assert.deepEqual(round, { own: 3, orphanDays: 0, danglingProgram: 0, danglingDay: 0 });
});

test('a save still out when another account signs in never lands in that account', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('writeDuringSwitch');
  assert.deepEqual(out, { queue: [], local: 0, coachServer: null });
});

test('an earlier version\'s queued creates are linked only on an exact match, never to a same-name row', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('legacySameName');
  const both = ['- [New Push Day]', 'edited offline [Server Push Day]'];
  assert.deepEqual(out, { server: both, phone: both, queue: 0, refused: [] });
});

test('Upload where one program workout fails: it goes up later, and nothing is left twice', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('uploadPartialDay');
  assert.deepEqual(out, { errors: ['U Plan / U D2'], server: { plans: 1, days: ['U D1', 'U D2'] }, phone: { plans: 1, days: ['U D1', 'U D2'] }, queue: 0 });
});

test('the same user id on a server that can\'t say which it is is asked about, and a copy from before tags isn\'t handed over', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('ambiguousServer', { second: true });
  assert.equal(out.different.sameIds, true, 'the same user id on both servers');
  assert.deepEqual(out.different, { sameIds: true, early: false, ok: true, askedServer: [true, true], askedDiscard: 2, onB: [], phoneShowsA: [] });
  assert.deepEqual(out.legacy, { tagged: true, coachOk: false, askedCoach: 1, kept: ['Athlete Waiting'] });
});

test('signing out sends a setting changed just before, ends the session, and the next account\'s own values show at once', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('signOutIn');
  assert.deepEqual(out, { afterSignOut: { token: null, ntfy: '' }, athleteServer: 'athlete-ntfy-late', coachLocal: true });
});

test('a program workout added while its phone-only program is on its way up is made once', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('createDuringFlush');
  assert.deepEqual(out, { plans: ['Race Plan renamed'], days: ['Race Day'], phoneDays: ['Race Day'] });
});

test('reconnecting where the server can\'t say which it is: asked once; same server puts rows back, a different one uploads them as new', { skip, timeout: SCENARIO_MS }, async () => {
  const same = (await scenario('unknownSameServer')).out;
  assert.deepEqual(same, { asked: [[true, true]], counts: { w: 0, p: 0 }, uploaded: { w: 0, p: 0 },
    server: { sessions: ['Q Session'], plans: 1 }, phone: { sessions: ['Q Session'], plans: 1 } });
  const different = (await scenario('unknownDifferentServer')).out;
  assert.deepEqual(different, { asked: [[true, true]], counts: { w: 1, p: 1 }, uploaded: { w: 1, p: 1 },
    server: { sessions: ['Q Session', 'Q Session'], plans: 2 }, phone: { sessions: ['Q Session', 'Q Session'], plans: 2 } });
});

test('the server reads the session from the header, never from another account\'s cookie left in the phone\'s jar', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('cookieSwitch');
  assert.deepEqual(out, { coachSees: ['Coach Private'], athleteSees: ['Athlete Own'],
    cookies: { server: { CF_Authorization: 'keep-me-too' }, app: {}, gate: { gate_session: 'keep-me' } } },
    'lt_token is gone everywhere; a gate\'s cookies, on this host or another, stay');
  const srv = await startServer({ env: { PUBLIC_API_ENABLED: '1' } });
  try {
    const login = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'coach', password: 'Str0ng-Pass-77!x' }), signal: AbortSignal.timeout(CALL_MS) });
    const cookie = login.headers.getSetCookie().find(c => c.startsWith('lt_token=')).split(';')[0];
    const me = await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie, Authorization: `Bearer ${srv.tokens.phone}` }, signal: AbortSignal.timeout(CALL_MS) })).json();
    assert.equal(me.user.id, srv.memberId, 'the header\'s account');
    const bad = await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie, Authorization: `Bearer ${srv.tokens.expired}` }, signal: AbortSignal.timeout(CALL_MS) })).json();
    assert.equal(bad.user ?? null, null, 'an expired header is no session, not the cookie\'s');
    const web = await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(CALL_MS) })).json();
    assert.equal(web.user.id, srv.adminId, 'the web still signs in with its cookie');
    // A reverse proxy's own Authorization (not one of this server's
    // sessions) leaves the cookie to decide: web sign-in behind it works.
    const foreignJwt = jwt.sign({ id: srv.memberId, username: 'proxy' }, 'some-other-secret-0123456789abcdef');
    for (const foreign of ['opaque-proxy-token', foreignJwt]) {
      const behind = await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie, Authorization: `Bearer ${foreign}` }, signal: AbortSignal.timeout(CALL_MS) })).json();
      assert.equal(behind.user?.id, srv.adminId, 'the cookie\'s account behind a proxy');
    }
    // API tokens still work on their own routes, with or without a cookie.
    const made = await (await fetch(srv.base + '/api/admin/api-tokens', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 't', scopes: ['mcp:read'] }), signal: AbortSignal.timeout(CALL_MS) })).json();
    for (const extra of [{}, { Cookie: cookie }]) {
      const v1 = await fetch(srv.base + '/api/v1/workouts/recent', { headers: { Authorization: `Bearer ${made.raw}`, ...extra }, signal: AbortSignal.timeout(CALL_MS) });
      assert.equal(v1.status, 200, 'an API token on its routes');
    }
  } finally { srv.stop(); }
});

test('an edit made offline never overwrites a later one: the newer edit of each field stays, everywhere', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('newerWins');
  const want = { program: 'Web Rename strength', day: 'Web Day', exercise: 'Web Curl arms', workout: 'Web Session sets:2', body: { weight: 81, waist: 90 }, goal: 5 };
  assert.deepEqual(out.server, want);
  assert.deepEqual(out.phone, want);
  assert.deepEqual(out.laterPhone, ['Phone Later', 'Phone Later'], 'the phone\'s edit, made later, stays');
});

test('a sync that runs while a change is half-way into the queue never makes its row twice', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('queueRace');
  assert.deepEqual(out, { server: ['QR Day'], phone: ['QR Day'] });
});

test('made offline then deleted or renamed offline: the delete and the rename win over the create', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('createThenEdit');
  assert.deepEqual(out, { server: { programs: ['CT Plan renamed'], curls: 0, sessions: 0 }, phone: ['CT Plan renamed'], refused: [] });
});

test('a program and an old session under it deleted offline: both go, no refusal', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('deleteProgramThenSession');
  assert.deepEqual(out, { server: { plan: 0, sessions: [] }, phone: [], refused: [] });
});

test('a queued change stuck half-way never blocks syncing, and its row is made once', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('stuckQueueWrite');
  assert.deepEqual(out, { finished: [true, true], quick: true, whileStuck: 0, days: ['SQ Day'], phone: ['SQ Day'] }, 'nothing of it goes up while it is stuck');
});

test('deleting something already deleted on the server is done, not refused as kept', { skip, timeout: SCENARIO_MS }, async () => {
  const srv = await startServer();
  try {
    const ex = await srv.call(srv.tokens.phone, 'POST', '/api/exercises', { name: 'Soft Gone' });
    await srv.call(srv.tokens.phone, 'PUT', `/api/exercises/${ex.id}`, { name: 'Soft Gone edited' });
    // Soft-deleted, as a catalog clear or an older app's push leaves it.
    const file = new Database(srv.dbPath);
    file.prepare(`UPDATE exercises SET deleted_at = datetime('now') WHERE id = ?`).run(ex.id);
    file.close();
    const r = await fetch(`${srv.base}/api/exercises/${ex.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${srv.tokens.phone}`, 'X-Edited-At': '2020-01-01T00:00:00.000Z' }, signal: AbortSignal.timeout(CALL_MS) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  } finally { srv.stop(); }
});

test('a program deleted offline stays when one of its workouts was edited elsewhere later', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('deleteProgramDayEdited');
  const kept = { programs: ['PD Plan'], days: ['PD Day edited later', 'PD Other Day'] };
  assert.deepEqual(out.server, kept, 'edited first or never edited: deleted; edited later: kept with all its workouts');
  assert.deepEqual(out.phone, kept);
  assert.deepEqual(out.refused, ['deleting a program']);
});

test('a delete made offline never beats a later edit made elsewhere; the row comes back', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('deleteVsEdit');
  assert.equal(out.phoneWhileOffline, 0, 'deleted on the phone while offline');
  assert.deepEqual(out.refused, ['an exercise you deleted', 'deleting a program', 'deleting a workout from a program', 'deleting the workout on 2026-09-03'], 'each losing delete is reported');
  assert.deepEqual(out.server, { programs: ['DV Plan edited later'], day: 'DV Day edited later', exercise: 'DV Curl edited later', sessions: ['DV Session sets:2'] });
  assert.deepEqual(out.phone, { programs: ['DV Plan edited later'], day: 'DV Day edited later', exercise: 'DV Curl edited later', sessions: ['DV Session sets:2'] });
});

test('signing out offline: signed out at once, the sign-in screen offline, the queue waits for the same account', { skip, timeout: SCENARIO_MS }, async () => {
  const { out } = await scenario('logoutOffline');
  assert.deepEqual(out, {
    queue: ['/api/programs'], right: { token: null, user: null, quick: true }, relaunch: { mgmt: true, user: null },
    sync1: 'other_account', serverWhileOut: 0, afterSignIn: 1,
  });
});

test('after Disconnect the phone is set up already: no first-run welcome', () => {
  const settings = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
  const disc = settings.slice(settings.indexOf('async function disconnectServer'));
  assert.match(disc, /localStorage\.setItem\('wl:userId', '1'\);\s*\n\s*localStorage\.setItem\('wl_u1_setupComplete', 'true'\);/);
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /getNativeMode\(\) === 'local'\s*\n\s*&& !DB\.getSetting\('setupComplete', false\)/, 'the welcome reads setupComplete for the user in wl:userId');
});

test('the 30-second sync runs only for a signed-in account whose data is shown; reminders follow the account', () => {
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /if \(user\?\.id == null \|\| !accountReadyFor\(getStore\(accountGate\), user\.id\)\) return;\s*\n\s*sync\.fullSync\(true\)/);
  const state = readFileSync(new URL('../src/lib/user-state.js', import.meta.url), 'utf8');
  assert.match(state, /scheduleNativeReminders\(\)/);
});

test('a logged workout keeps a coach\'s exercises and a prescribed program', { skip, timeout: SCENARIO_MS }, async () => {
  const srv = await startServer();
  try {
    const { call, tokens, memberId } = srv;
    await call(tokens.other, 'POST', `/api/trainer/members/${memberId}`);
    const ex = await call(tokens.other, 'POST', '/api/exercises', { name: 'Coach Sled Push' });
    const plan = await call(tokens.other, 'POST', '/api/programs', { name: 'Coach 8wk', duration_weeks: 8 });
    const day = await call(tokens.other, 'POST', '/api/templates', { program_id: plan.id, name: 'Rx Day', exercises: [{ exercise_id: ex.id, name: 'Coach Sled Push' }] });
    const other = await call(tokens.other, 'POST', '/api/programs', { name: 'Other', duration_weeks: 4 });
    await call(tokens.other, 'POST', `/api/trainer/members/${memberId}/prescriptions`, { template_id: day.id, date: '2026-10-07' });
    const w = (await call(tokens.phone, 'PUT', '/api/workout/2026-10-07', { program_id: plan.id, template_id: day.id, program_week: 2, exercises: [{ exercise_id: ex.id, name: 'Coach Sled Push', sets: [] }] })).workout;
    assert.deepEqual([w.program_id, w.template_id, w.exercises[0].exercise_id, w.program_duration_weeks], [plan.id, day.id, ex.id, 8]);
    const wrong = (await call(tokens.phone, 'PUT', '/api/workout/2026-10-08', { program_id: other.id, template_id: day.id, exercises: [] })).workout;
    assert.equal(wrong.program_id, null, 'not a way into any program: the day must belong to it');
  } finally { srv.stop(); }
});

test('a workout keeps only a program, day and exercises its account may see', { skip, timeout: SCENARIO_MS }, async () => {
  const srv = await startServer();
  try {
    const { call, tokens } = srv;
    const priv = await call(tokens.other, 'POST', '/api/programs', { name: 'Private', duration_weeks: 12 });
    const privDay = await call(tokens.other, 'POST', '/api/templates', { program_id: priv.id, name: 'Private Day' });
    const privEx = await call(tokens.other, 'POST', '/api/exercises', { name: 'Private Curl' });
    const own = await call(tokens.phone, 'POST', '/api/programs', { name: 'Own', duration_weeks: 6 });
    const ownDay = await call(tokens.phone, 'POST', '/api/templates', { program_id: own.id, name: 'Own Day' });
    const ownEx = await call(tokens.phone, 'POST', '/api/exercises', { name: 'Own Curl' });
    const refs = w => [w.program_id, w.template_id, w.exercises[0].exercise_id];
    const theirs = (await call(tokens.phone, 'PUT', '/api/workout/2026-10-01', { program_id: priv.id, template_id: privDay.id, exercises: [{ exercise_id: privEx.id, name: 'a', sets: [] }] })).workout;
    assert.deepEqual(refs(theirs), [null, null, null]);
    assert.equal(theirs.program_duration_weeks ?? null, null);
    const mine = (await call(tokens.phone, 'PUT', '/api/workout/2026-10-02', { program_id: own.id, template_id: ownDay.id, exercises: [{ exercise_id: ownEx.id, name: 'b', sets: [] }] })).workout;
    assert.deepEqual(refs(mine), [own.id, ownDay.id, ownEx.id]);
    assert.equal(mine.program_duration_weeks, 6);
    // Ids the server never handed out used to fail the save on the foreign key.
    const unknown = (await call(tokens.phone, 'PUT', '/api/workout/2026-10-03', { program_id: 99999, template_id: -5, exercises: [{ exercise_id: 99999, name: 'c', sets: [] }] })).workout;
    assert.deepEqual(refs(unknown), [null, null, null]);
    const pushed = await call(tokens.phone, 'POST', '/api/sync/push', { workout_log: [{ client_id: 1, date: '2026-10-04', program_id: priv.id, template_id: privDay.id, exercises: [{ exercise_id: privEx.id, name: 'd', sets: [] }], updated_at: new Date().toISOString() }] });
    const viaPush = (await call(tokens.phone, 'GET', `/api/workout/2026-10-04?id=${pushed.workout_log[0].server_id}`)).workout;
    assert.deepEqual(refs(viaPush), [null, null, null]);
    // The pull lists what the phone may keep, and what was deleted.
    await call(tokens.phone, 'DELETE', `/api/exercises/${ownEx.id}`);
    const since = encodeURIComponent('2000-01-01T00:00:00.000Z');
    const pull = await call(tokens.phone, 'GET', `/api/sync/pull?since=${since}`);
    assert.ok(pull.keep.programs.includes(own.id) && !pull.keep.programs.includes(priv.id));
    assert.ok(pull.keep.workout_templates.includes(ownDay.id) && !pull.keep.workout_templates.includes(privDay.id));
    const goneIds = (p) => p.exercises.filter(e => e.deleted_at && !e.name).map(e => e.id);
    assert.deepEqual(goneIds(pull), [ownEx.id]);
    // A first, full pull leaves deletions out; one from a phone that holds
    // rows (held=1) has them.
    assert.deepEqual(goneIds(await call(tokens.phone, 'GET', '/api/sync/pull')), []);
    assert.deepEqual(goneIds(await call(tokens.phone, 'GET', '/api/sync/pull?held=1')), [ownEx.id]);
    // Put back by a restore (same id): not gone after all.
    const file = new Database(srv.dbPath);
    file.prepare(`INSERT INTO exercises (id, name, is_global, created_by) VALUES (?, 'Own Curl', 0, ?)`).run(ownEx.id, srv.memberId);
    file.close();
    assert.deepEqual(goneIds(await call(tokens.phone, 'GET', `/api/sync/pull?since=${since}`)), []);
  } finally { srv.stop(); }
});

// ── The deletion triggers, on the real schema ────────────────────────────

let db = null, dir = null;
if (ready) {
  try {
    dir = mkdtempSync(join(tmpdir(), 'lt-sync-deletions-'));
    process.env.DB_PATH = join(dir, 'test.db');
    db = (await import('../server/db.js')).default;
  } catch { db = null; }
}
test.after(() => { try { db?.close(); } catch { /* closed */ } if (dir) rmSync(dir, { recursive: true, force: true }); });

const user = n => Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(n + Math.random(), 'x', 'member').lastInsertRowid);
const notes = (u, table) => db.prepare('SELECT row_id, row_key FROM sync_deletions WHERE user_id IS ? AND tbl = ?').all(u, table);

test('deletes are noted for the account whose phones hold the row', { skip: db ? false : 'better-sqlite3 not built for this Node' }, () => {
  const a = user('a'), b = user('b');
  const p = Number(db.prepare(`INSERT INTO programs (name, created_by) VALUES ('P', ?)`).run(a).lastInsertRowid);
  const asg = Number(db.prepare('INSERT INTO program_assignments (program_id, assigned_to) VALUES (?, ?)').run(p, b).lastInsertRowid);
  const custom = Number(db.prepare(`INSERT INTO exercises (name, is_global, created_by) VALUES ('C', 0, ?)`).run(a).lastInsertRowid);
  const lib = Number(db.prepare(`INSERT INTO exercises (name, is_global) VALUES ('L', 1)`).run().lastInsertRowid);
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'k', '1')`).run(a);
  db.prepare('DELETE FROM programs WHERE id = ?').run(p);   // the assignment goes with it
  db.prepare('DELETE FROM exercises WHERE id IN (?, ?)').run(custom, lib);
  db.prepare(`DELETE FROM user_settings WHERE user_id = ? AND key = 'k'`).run(a);
  // An assignment and a library exercise are shared (no owner: every
  // account's phones get them); a custom exercise and a setting are the
  // account's own.
  assert.ok(notes(null, 'program_assignments').map(r => r.row_id).includes(asg));
  assert.deepEqual(notes(a, 'exercises').map(r => r.row_id), [custom]);
  assert.ok(notes(null, 'exercises').map(r => r.row_id).includes(lib), 'a library exercise goes to every account');
  assert.deepEqual(notes(a, 'user_settings').map(r => r.row_key), ['k']);
  // Set again: no longer gone.
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'k', '2')`).run(a);
  assert.deepEqual(notes(a, 'user_settings'), []);
});

test('deleting an account still works, and leaves nothing behind for it', { skip: db ? false : 'better-sqlite3 not built for this Node' }, async () => {
  const a = user('gone');
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'k', '1')`).run(a);
  db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, 'user', 'hi')`).run(a);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(a);
  db.prepare('DELETE FROM ai_chat_history WHERE user_id = ?').run(a);
  // As the account's deletion does it (claim-anonymous-data.js).
  const { purgeUserRows } = await import('../server/lib/claim-anonymous-data.js');
  purgeUserRows(a);
  db.prepare(`INSERT INTO workout_log (user_id, date, exercises) VALUES (?, '2026-10-01', '[]')`).run(a);
  db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_deletions WHERE user_id = ?').get(a).n, 0, 'nor rows its own deletion removes');
  // Removed by the cascade with the account: no FK in the way.
  const b = user('cascade');
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'k', '1')`).run(b);
  assert.doesNotThrow(() => db.prepare('DELETE FROM users WHERE id = ?').run(b));
});

test('single-user mode notes deletes with no account, which every later account\'s phones still get', { skip: db ? false : 'better-sqlite3 not built for this Node' }, async () => {
  db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (NULL, 'user', 'solo')`).run();
  db.prepare('DELETE FROM ai_chat_history WHERE user_id IS NULL').run();
  assert.equal(notes(null, 'ai_chat_history').length, 1);
  // No owner means shared, so they are not claimed by the first account.
  const { CLAIM_NULL } = await import('../server/lib/claim-anonymous-data.js');
  assert.ok(!CLAIM_NULL.includes('sync_deletions'));
});

test('a program\'s maker sees its owner controls in every mode, starters stay read-only', () => {
  const detail = readFileSync(new URL('../src/routes/ProgramDetail.svelte', import.meta.url), 'utf8');
  const m = detail.match(/\$: isOwner = ([\s\S]*?\)\)\));/);
  assert.ok(m, 'isOwner in ProgramDetail.svelte');
  const expr = m[1].replace(/\$currentUser/g, 'u').replace(/\$userMgmtActive/g, 'active');
  const isOwner = new Function('u', 'program', 'active', `return ${expr};`);
  // Accounts: a program made by this account (offline too, now); not one by another.
  assert.equal(isOwner({ id: 2 }, { created_by: 2, visibility: 'private' }, true), true);
  assert.equal(isOwner({ id: 2 }, { created_by: 1, visibility: 'private' }, true), false);
  assert.equal(isOwner({ id: 2 }, { created_by: null, visibility: 'shared' }, true), false);
  // A server without accounts: nothing has a maker; starters are still starters.
  assert.equal(isOwner({ id: 1 }, { created_by: null, visibility: 'private' }, false), true);
  assert.equal(isOwner({ id: 1 }, { created_by: null, visibility: 'shared' }, false), false);
  // Standalone: the one local user made them.
  assert.equal(isOwner({ id: 1 }, { created_by: 1, visibility: 'private' }, false), true);
});
