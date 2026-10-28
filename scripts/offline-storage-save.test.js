/**
 * Saving with a connection must not depend on this browser's own storage
 * (TraceApps/nutritrace#269). Loads the real offline layer against a small
 * stand-in for IndexedDB, so the cases a browser rarely shows on demand can
 * be staged: storage that refuses to open, a change waiting that the server
 * keeps failing on, and a store that breaks after the page loaded.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { fakeIndexedDB } from './fixtures/fake-indexeddb.js';

// Scheduled flushes only run when a test asks for them.
mock.timers.enable({ apis: ['setTimeout'] });
// No other tab to talk to, and nothing left listening when the tests end.
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });

const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

/** The server, recording what reached it. */
function fakeServer() {
  const sent = [];
  const fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push([method, String(url), body]);
    if (fetch.fail) throw fetch.fail;
    const json = String(url) === '/api/auth/profile' ? { user: { id: 1, username: 'alex', role: 'admin', ...body } } : { ok: true, ...(body || {}) };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, fetch };
}

let loads = 0;
/** A fresh copy of the offline layer, as a newly opened page has. */
async function page({ seed = [], openThrows = false } = {}) {
  const { idb, env } = fakeIndexedDB();
  env.openThrows = openThrows;
  for (const op of seed) env.seed(op);
  globalThis.indexedDB = idb;
  const mod = await import(`../src/lib/offline-api.js?page=${++loads}`);
  const server = fakeServer();
  const call = (method, url, body) => mod.offlineFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) }, server.fetch);
  return { mod, call, server, env };
}

// A change the server keeps failing on (a 503 is retried), still waiting.
const WAITING = { method: 'PUT', path: '/api/settings', body: { key: 'units', value: 'kg' }, kind: 'setting', key: 'setting:units', at: 1 };
const PROFILE = { full_name: 'Alex Doe', nickname: 'Lex', birthday: '1990-04-02', gender: 'female', avatar_url: '', email: '' };
const sentPaths = (server) => server.sent.map(s => `${s[0]} ${s[1]}`);

test('storage that refuses to open: a profile save still reaches the server', async () => {
  setOnline(true);
  const { call, server } = await page({ openThrows: true });
  const res = await call('PUT', '/api/auth/profile', PROFILE);
  assert.equal(res.status, 200);
  assert.deepEqual(sentPaths(server), ['PUT /api/auth/profile']);
});

test('a change still waiting does not hold up a profile save', async () => {
  setOnline(true);
  const { mod, call, server, env } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  const res = await call('PUT', '/api/auth/profile', PROFILE);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.role, 'admin');
  assert.deepEqual(sentPaths(server), ['PUT /api/auth/profile']);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units'], 'what was waiting is still kept');
});

test('a change waiting and the store breaking: saves still reach the server', async () => {
  for (const [method, path, body] of [['PUT', '/api/auth/profile', PROFILE], ['PUT', '/api/settings', { key: 'theme', value: 'dark' }]]) {
    setOnline(true);
    const { mod, call, server, env } = await page({ seed: [WAITING] });
    assert.equal(await mod.pendingCount(), 1);
    env.broken = true;
    const res = await call(method, path, body);
    assert.equal(res.status, 200, path);
    assert.deepEqual(sentPaths(server), [`${method} ${path}`]);
    assert.equal(await mod.pendingCount(), 1, 'what was waiting is still counted');
  }
});

test('the queue keeps its order when it can still be read', async () => {
  setOnline(true);
  const { mod, call, server } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  await call('PUT', '/api/settings', { key: 'theme', value: 'dark' });
  assert.equal(server.sent.length, 0, 'nothing sent ahead of what was waiting');
  assert.equal(await mod.pendingCount(), 2);
});

test('an earlier profile save still waiting goes, and the new one takes its place', async () => {
  setOnline(true);
  const older = { method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, kind: 'profile', key: 'profile', at: 1 };
  const { mod, call, server, env } = await page({ seed: [older, WAITING] });
  assert.equal(await mod.pendingCount(), 2);
  await call('PUT', '/api/auth/profile', PROFILE);
  assert.deepEqual(server.sent.map(s => s[2]?.nickname), ['Lex']);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units']);
});

test('with no Web Locks (plain http), a flush asked for during the save waits for it', async () => {
  setOnline(true);
  const older = { method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, kind: 'profile', key: 'profile', at: 1 };
  const { mod, call, server, env } = await page({ seed: [older] });
  assert.equal(await mod.pendingCount(), 1);
  let land;
  const real = server.fetch;
  const slow = (url, init) => (String(url) === '/api/auth/profile' && JSON.parse(init.body).nickname === 'Lex'
    ? new Promise(r => { land = () => r(real(url, init)); }) : real(url, init));
  const saving = mod.offlineFetch('/api/auth/profile', { method: 'PUT', body: JSON.stringify(PROFILE) }, slow);
  for (let i = 0; i < 200 && !land; i++) await new Promise(r => setImmediate(r));
  assert.ok(land, 'the new save went to the server');
  const flushing = mod.flushOutbox();
  land();
  await saving;
  await flushing;
  assert.deepEqual(server.sent.map(s => s[2]?.nickname), ['Lex'], 'the older save is never sent');
  assert.deepEqual(env.outbox(), []);
});

test('no connection and nowhere to keep it: the answer says storage, not offline', async () => {
  for (const breakIt of [(env) => { env.full = true; }, (env) => { env.broken = true; }]) {
    setOnline(false);
    const { mod, call, server, env } = await page();
    await mod.pendingCount();
    breakIt(env);
    const res = await call('PUT', '/api/auth/profile', PROFILE);
    const body = await res.json();
    assert.equal(body.storage, true);
    assert.ok(!body.offline);
    assert.equal(server.sent.length, 0);
  }
  setOnline(true);
});

test('a save tried directly is never sent a second time when it can\'t be kept either', async () => {
  setOnline(true);
  const { mod, call, server, env } = await page();
  await mod.pendingCount();
  env.broken = true;
  server.fetch.fail = new Error('The operation was aborted due to timeout');
  const res = await call('PUT', '/api/settings', { key: 'theme', value: 'dark' });
  assert.equal((await res.json()).storage, true);
  assert.equal(server.sent.length, 1);
});

test('Profile keeps who is signed in after a save kept for later, and says when it could not be kept', async () => {
  const { readFileSync } = await import('node:fs');
  const profile = readFileSync(new URL('../src/routes/Profile.svelte', import.meta.url), 'utf8');
  assert.match(profile, /if \(user\) currentUser\.set\(\{ \.\.\.get\(currentUser\), \.\.\.user \}\);/);
  assert.match(profile, /showError\(e\?\.storage \? \$_\('profile\.errors\.not_kept'\) : e\.message\);/);
  assert.match(readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8'), /if \(data\.storage\) err\.storage = true;/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.ok(en.profile.errors.not_kept);
});

// ── A server that takes the connection and never answers ─────────────
// Past a deadline it counts as no connection (lib/request-deadline.js): a
// read answers from the copy or says it needs a connection, a change goes
// into the queue, and while the server is quiet a change doesn't wait at all.
const deadline = await import('../src/lib/request-deadline.js');
/** A server that takes every request and never answers, until it is given up on. */
function silentServer() {
  const seen = [];
  const fetch = (url, init = {}) => {
    seen.push({ method: (init.method || 'GET').toUpperCase(), url: String(url), signal: init.signal });
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  };
  return { seen, fetch };
}

test('a silent server: a read gives up at its deadline and answers as with no connection', { timeout: 15_000 }, async () => {
  setOnline(true);
  deadline.noteAnswered();
  const { mod } = await page();
  const silent = silentServer();
  let settled = false;
  const answer = mod.offlineFetch('/api/templates', { method: 'GET' }, silent.fetch).finally(() => { settled = true; });
  for (let i = 0; i < 50 && !silent.seen.length; i++) await new Promise(r => setImmediate(r));
  mock.timers.tick(deadline.READ_MS - 1);
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false, 'still waiting just before the deadline');
  mock.timers.tick(1);
  const res = await answer;
  assert.equal(res.status, 503);
  assert.equal((await res.json()).offline, true);
  assert.equal(deadline.isQuiet(), true);
  deadline.noteAnswered();
});

test('reads by kind: the services the server asks wait as long as they take, stats and history longer', async () => {
  deadline.noteAnswered();
  const { readDeadlineMsFor } = await import('../src/lib/offline-api.js');
  for (const p of ['/api/templates', '/api/programs/4', '/api/workout/2026-04-01', '/api/workout/2026-04-01/sessions', '/api/settings', '/api/ai/history', '/api/exercises/12', '/api/cardio/2026-04-01', '/api/body-stats/2026-04-01']) assert.equal(readDeadlineMsFor(p), deadline.READ_MS, p);
  for (const p of ['/api/stats/volume?start=a&end=b', '/api/stats/progress/12?start=a&end=b', '/api/stats/records', '/api/workout/recent?limit=365', '/api/workout/history/12', '/api/exercises', '/api/exercises?search=a&limit=5', '/api/exercises/usage', '/api/cardio?start=a&end=b', '/api/cardio/stats/weekly?start=a&end=b', '/api/body-stats/range?start=a&end=b', '/api/body-stats/photos?start=a&end=b', '/api/set-media?date=2026-04-01', '/lifttrace/api/stats/streaks']) {
    assert.equal(readDeadlineMsFor(p), deadline.HEAVY_READ_MS, p);
  }
  for (const p of ['/api/ai/models', '/api/nt/test', '/api/radio-proxy/info', '/api/exercises/sources/list', '/api/updates/server-status']) assert.equal(readDeadlineMsFor(p), null, p);
});

test('a change that is sent has no deadline; while the server is known quiet, it goes into the queue unsent', async () => {
  setOnline(true);
  deadline.noteAnswered();
  const { mod } = await page();
  // Sent: no deadline of ours (one cut off might have landed).
  const given = [];
  const ok = async (url, init = {}) => { given.push(init.signal ?? null); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  await mod.offlineFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'units', value: 'kg' }) }, ok);
  assert.deepEqual(given, [null], 'sent with no deadline');
  // A read runs out of time: the server is quiet now.
  const timedOut = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
  await mod.offlineFetch('/api/templates', { method: 'GET' }, timedOut);
  assert.equal(deadline.isQuiet(), true);
  const silent = silentServer();
  const queued = await mod.offlineFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'theme', value: 'dark' }) }, silent.fetch);
  assert.equal((await queued.json()).queued, true);
  assert.equal(silent.seen.length, 0, 'not sent while the server is quiet');
  assert.equal(await mod.pendingCount(), 1);
  deadline.noteAnswered();
});

test('work that asks another service, or brings its own deadline, keeps it', async () => {
  setOnline(true);
  deadline.noteAnswered();
  const { mod } = await page();
  const given = [];
  const ok = async (url, init = {}) => { given.push([String(url), init.signal ?? null]); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  for (const url of ['/api/ai/models', '/api/full-backup', '/api/nt/status', '/lifttrace/api/subsonic/ping']) await mod.offlineFetch(url, { method: 'GET' }, ok);
  assert.deepEqual(given.map(g => g[1]), [null, null, null, null]);
  const own = AbortSignal.timeout(60_000);
  await mod.offlineFetch('/api/auth/me', { method: 'GET', signal: own }, ok);
  assert.equal(given.at(-1)[1], own, 'the sign-in check keeps its own deadline');
  await mod.offlineFetch('/lifttrace/api/stats/summary', { method: 'GET' }, ok);
  assert.ok(given.at(-1)[1], 'under BASE_URL too');
});

test('the sign-in check waits less with an account kept here', async () => {
  const { readFileSync } = await import('node:fs');
  const auth = readFileSync(new URL('../src/stores/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /signal: deadlineSignal\(kept \? SIGN_IN_CHECK_MS : 8000\)/);
});
