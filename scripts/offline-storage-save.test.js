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
