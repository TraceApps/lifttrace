/**
 * The web app's creates sent again after their answer was lost (#134):
 * the real offline layer (src/lib/offline-api.js) against the real server
 * (server/index.js on a scratch database), through a stand-in for a
 * connection that drops the server's answer after the server has done the
 * work, with a receiver checking each webhook's signature.
 *
 * Online, a cardio session or a new workout of the day whose answer was lost
 * was queued and sent again, and the server made a second row and sent a
 * second cardio.logged or workout.completed; so was one made with no
 * connection whose answer was lost on the way back from the replay. The
 * Android app avoids this with a key made once per create, which the server
 * notes the row under (server/lib/create-keys.js). The web app now does the
 * same: the key is made before the create is first tried and goes with it
 * every time it is sent.
 *
 * A day's first workout sent online whose answer was lost went up again as
 * a new workout of the day, so the server kept both. It now goes up as it
 * was sent, a save of the day's first.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fakeIndexedDB } from './fixtures/fake-indexeddb.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

// No other tab to talk to, and no browser storage to name the queue by.
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
let proc = null, dir = null, proxy = null, receiver = null;
let base = null, through = null, token = null, secret = null;
const deliveries = [];
// Requests matching one of these reach the server, and its answer is lost.
const drops = [];
// Requests matching one of these never reach the server.
const blocks = [];
// While set, a delete by key is answered as a server from before that route
// answers it (no such route).
let oldServer = false;
const sent = [];

async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

// While set, the answer to a matching request is held until `gate.open()`.
let gate = null;

/** The browser's fetch as the offline layer sees it, through the proxy. */
async function browserFetch(url, init = {}) {
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
  let res;
  try {
    res = await fetch(through + String(url), { ...init, headers });
  } catch {
    // What a browser says when the connection drops.
    throw new TypeError('Failed to fetch');
  }
  const g = gate;
  if (g && !g.hit && g.method === (init.method || 'GET') && String(url).split('?')[0] === g.path) {
    g.hit = true;
    await g.held;
  }
  return res;
}
const holdAnswer = (method, path) => {
  let open;
  gate = { method, path, hit: false, held: new Promise((r) => { open = r; }) };
  gate.open = () => { gate = null; open(); };
  return gate;
};

let loads = 0;
const pages = [];
/** A fresh copy of the offline layer, as a newly opened page has. */
async function page() {
  setOnline(true);
  const { idb, env } = fakeIndexedDB();
  globalThis.indexedDB = idb;
  const mod = await import(`../src/lib/offline-api.js?create-keys=${++loads}`);
  pages.push(mod);
  const send = (method, url, body) => mod.offlineFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, browserFetch);
  return { mod, env, send };
}

/** Until the queue is empty (the layer flushes on its own, as in a browser). */
async function drained(mod, env) {
  for (let i = 0; i < 300 && env.outbox().length; i++) await sleep(50);
  // A flush still running finishes before anything is counted.
  await mod.flushOutbox();
  assert.deepEqual(env.outbox(), [], 'nothing left waiting');
}

/** The webhooks sent since `from`, once the receiver has gone quiet. */
async function hooksSince(from) {
  let last = -1;
  for (let i = 0; i < 20 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) assert.ok(d.signed, `${d.event} carries a valid signature`);
  return got.map(d => d.event).sort();
}

const opts = { skip: !ready && 'server packages not installed' };

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-create-keys-'));
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let env = {};
      try { env = JSON.parse(raw); } catch { /* counted as unsigned */ }
      const signed = req.headers['x-lifttrace-signature'] === `sha256=${createHmac('sha256', secret || '-').update(raw).digest('hex')}`;
      deliveries.push({ event: env.event, signed });
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'create-keys-test-0123456789abcdef0123456',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 150) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // Forwards everything; for a request matching a drop, the server does the
  // work and the answer never comes back.
  proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      sent.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
      const blocked = blocks.findIndex(d => d.method === req.method && d.path === path);
      if (blocked >= 0) { blocks.splice(blocked, 1); req.socket.destroy(); return; }
      if (oldServer && req.method === 'DELETE' && path.includes('/by-key/')) {
        res.writeHead(404, { 'Content-Type': 'text/html', connection: 'close' });
        res.end(`Cannot DELETE ${path}`);
        return;
      }
      const at = drops.findIndex(d => d.method === req.method && d.path === path);
      const drop = at >= 0 ? drops.splice(at, 1)[0] : null;
      const up = http.request(base + req.url, { method: req.method, headers: req.headers }, (ur) => {
        const out = [];
        ur.on('data', (c) => out.push(c));
        ur.on('end', () => {
          if (drop) { req.socket.destroy(); return; }
          res.writeHead(ur.statusCode, { ...ur.headers, connection: 'close' });
          res.end(Buffer.concat(out));
        });
      });
      up.on('error', () => req.socket.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  through = `http://127.0.0.1:${proxy.address().port}`;

  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lifter', password: PW }) })).json();
  token = reg.token || (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lifter', password: PW }) })).json()).token;
  assert.ok(token);
  const hook = await call('POST', '/api/webhooks', { url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['workout.completed', 'cardio.logged'] });
  secret = hook.secret;
  assert.ok(secret, JSON.stringify(hook));
  await call('PUT', '/api/settings', { key: 'cardioEnabled', value: true });
});

test.after(async () => {
  try {
    // Nothing left queued to retry, so nothing keeps the run open.
    setOnline(true);
    for (const mod of pages) await mod.clearOffline().catch(() => {});
    if (proc) {
      const p = proc; proc = null;
      await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
    }
    for (const s of [proxy, receiver]) if (s) await new Promise((r) => s.close(r));
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const run = (date) => ({ date, activity: 'Run', duration_min: 30, distance: 5, distance_unit: 'km' });
const cardioOn = async (date) => (await call('GET', `/api/cardio/${date}`)).length;
const workoutsOn = async (date) => (await call('GET', `/api/workout/${date}/sessions`)).sessions;

test('a cardio session whose answer was lost online is logged once, with one webhook', opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  drops.push({ method: 'POST', path: '/api/cardio' });
  const res = await send('POST', '/api/cardio', run('2026-04-01'));
  assert.equal((await res.json()).queued, true, 'the lost answer queued it');
  await drained(mod, env);
  assert.equal(await cardioOn('2026-04-01'), 1);
  assert.deepEqual(await hooksSince(from), ['cardio.logged']);
});

test('a cardio session logged offline whose answer was lost on the replay is logged once', opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  setOnline(false);
  const res = await send('POST', '/api/cardio', run('2026-04-02'));
  const queued = await res.json();
  assert.equal(queued.queued, true);
  assert.equal(queued.client_key, undefined, 'the screen never sees the key');
  assert.equal(typeof env.outbox()[0].body.client_key, 'string', 'kept with the queued create');
  setOnline(true);
  drops.push({ method: 'POST', path: '/api/cardio' });
  await mod.flushOutbox();
  assert.equal(env.outbox().length, 1, 'still waiting after the lost answer');
  await drained(mod, env);
  assert.equal(await cardioOn('2026-04-02'), 1);
  assert.deepEqual(await hooksSince(from), ['cardio.logged']);
});

test('a new workout of the day whose answer was lost online is one workout, with one webhook', opts, async () => {
  const { mod, env, send } = await page();
  await send('PUT', '/api/workout/2026-04-03', { name: 'Mobility', completed: false, exercises: [] });
  const from = deliveries.length;
  drops.push({ method: 'PUT', path: '/api/workout/2026-04-03' });
  const res = await send('PUT', '/api/workout/2026-04-03', { name: 'Push', new_session: true, completed: true, exercises: [] });
  assert.equal((await res.json()).queued, true);
  await drained(mod, env);
  assert.deepEqual((await workoutsOn('2026-04-03')).map(w => w.name), ['Mobility', 'Push']);
  assert.deepEqual(await hooksSince(from), ['workout.completed']);
});

test("a day's first workout whose answer was lost online stays one workout, and the next save goes into it", opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  drops.push({ method: 'PUT', path: '/api/workout/2026-04-04' });
  const first = await (await send('PUT', '/api/workout/2026-04-04', {
    name: 'Push', completed: true, exercises: [{ uuid: 'e1', name: 'Bench', sets: [{ uuid: 's1', reps: 5, weight: 60, completed: true }] }],
  })).json();
  assert.equal(first.queued, true);
  assert.ok(first.workout.id < 0, 'a temporary id until the server says');
  await drained(mod, env);
  // What the Diary does next: save into the workout it was answered with.
  await send('PUT', '/api/workout/2026-04-04', {
    id: first.workout.id, name: 'Push', completed: true, notes: 'two sets',
    exercises: [{ uuid: 'e1', name: 'Bench', sets: [{ uuid: 's1', reps: 5, weight: 60, completed: true }, { uuid: 's2', reps: 5, weight: 62.5, completed: true }] }],
  });
  await drained(mod, env);
  const day = await workoutsOn('2026-04-04');
  assert.equal(day.length, 1, JSON.stringify(day));
  assert.equal(day[0].notes, 'two sets');
  assert.equal((typeof day[0].exercises === 'string' ? JSON.parse(day[0].exercises) : day[0].exercises)[0].sets.length, 2);
  assert.deepEqual(await hooksSince(from), ['workout.completed']);
});

test('a change made after the answer was lost still goes up, once the create is repeated', opts, async () => {
  for (const [path, made, change, check] of [
    ['/api/cardio', run('2026-04-08'), { notes: 'felt good', duration_min: 35 }, async () => {
      const rows = await call('GET', '/api/cardio/2026-04-08');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].notes, 'felt good');
      assert.equal(rows[0].duration_min, 35);
    }],
    ['/api/exercises', { name: 'Curl 0408' }, { name: 'Hammer Curl 0408' }, async () => {
      const all = await call('GET', '/api/exercises');
      const list = Array.isArray(all) ? all : all.exercises;
      assert.deepEqual(list.filter(e => /Curl 0408/.test(e.name)).map(e => e.name), ['Hammer Curl 0408']);
    }],
  ]) {
    const { mod, env, send } = await page();
    const from = deliveries.length;
    // Lost twice: tried straight away, then on the replay that followed.
    drops.push({ method: 'POST', path }, { method: 'POST', path });
    const first = await (await send('POST', path, made)).json();
    assert.equal(first.queued, true);
    for (let i = 0; i < 200 && drops.length; i++) await sleep(25);
    assert.equal(drops.length, 0, 'the server made it, and both answers were lost');
    await sleep(100);
    // Changed while it waits to go again.
    await send('PUT', `${path}/${first.id}`, change);
    await mod.flushOutbox();
    await drained(mod, env);
    await check();
    if (path === '/api/cardio') assert.deepEqual(await hooksSince(from), ['cardio.logged']);
  }
});

test('a create sent again after it was deleted is done quietly, not refused', opts, async () => {
  const made = await call('POST', '/api/cardio', { ...run('2026-04-05'), client_key: 'web-gone-0123456789' });
  await call('DELETE', `/api/cardio/${made.id}`);
  const { mod, env } = await page();
  env.seed({ method: 'POST', path: '/api/cardio', body: { ...run('2026-04-05'), client_key: 'web-gone-0123456789' }, kind: 'cardio-create', key: 'cardio:-5', tempId: -5, id: -5, at: 1 });
  // The page's first request is what tells the layer how to reach the server.
  await mod.offlineFetch('/api/auth/status', { method: 'GET' }, browserFetch);
  await mod.flushOutbox();
  assert.deepEqual(env.outbox(), []);
  assert.deepEqual(await mod.refusedChanges(), [], 'nobody is told their change was refused');
  assert.equal(await cardioOn('2026-04-05'), 0, 'not brought back');
});

test('ordinary logs, online and offline, still send once', opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  await send('POST', '/api/cardio', run('2026-04-06'));
  await send('PUT', '/api/workout/2026-04-06', { name: 'Legs', completed: true, exercises: [] });
  setOnline(false);
  await send('POST', '/api/cardio', run('2026-04-07'));
  setOnline(true);
  await mod.flushOutbox();
  await drained(mod, env);
  assert.equal(await cardioOn('2026-04-06'), 1);
  assert.equal(await cardioOn('2026-04-07'), 1);
  assert.equal((await workoutsOn('2026-04-06')).length, 1);
  assert.deepEqual(await hooksSince(from), ['cardio.logged', 'cardio.logged', 'workout.completed']);
});

// Made, its answer lost on the way back, and deleted before the server's id
// was known: both used to be dropped here as if never made, and the
// server kept what it had made (and its webhook had gone).
test('deleted before its lost answer came back: deleted on the server too', opts, async () => {
  const left = {};
  for (const [path, made, gone, count] of [
    ['/api/cardio', run('2026-04-09'), (id) => `/api/cardio/${id}`, () => cardioOn('2026-04-09')],
    ['/api/exercises', { name: 'Curl 0409' }, (id) => `/api/exercises/${id}`, async () => {
      const all = await call('GET', '/api/exercises');
      return (Array.isArray(all) ? all : all.exercises).filter(e => e.name === 'Curl 0409').length;
    }],
    ['/api/workout/2026-04-09', { name: 'Pull 0409', new_session: true, completed: true, exercises: [] }, (id) => `/api/workout/2026-04-09?id=${id}`,
      async () => (await workoutsOn('2026-04-09')).filter(w => w.name === 'Pull 0409').length],
  ]) {
    const { mod, env, send } = await page();
    const from = deliveries.length;
    const method = path.startsWith('/api/workout/') ? 'PUT' : 'POST';
    drops.push({ method, path }, { method, path });
    const first = await (await send(method, path, made)).json();
    assert.equal(first.queued, true, path);
    for (let i = 0; i < 200 && drops.length; i++) await sleep(25);
    assert.equal(drops.length, 0, 'the server made it, and both answers were lost');
    await sleep(100);
    assert.equal(await count(), 1, `${path}: on the server`);
    const id = first.workout?.id ?? first.id;
    assert.ok(id < 0, 'still known by its temporary id');
    await mod.offlineFetch(gone(id), { method: 'DELETE' }, browserFetch);
    await mod.flushOutbox();
    await drained(mod, env);
    left[path] = await count();
    assert.deepEqual(await mod.refusedChanges(), []);
    // Its webhook went when it was made, and no second one since.
    if (path === '/api/cardio') assert.deepEqual(await hooksSince(from), ['cardio.logged']);
    if (method === 'PUT') assert.deepEqual(await hooksSince(from), ['workout.completed']);
  }
  assert.deepEqual(left, { '/api/cardio': 0, '/api/exercises': 0, '/api/workout/2026-04-09': 0 }, 'deleted on the server as well');
});

const exercisesNamed = async (name) => {
  const all = await call('GET', '/api/exercises');
  return (Array.isArray(all) ? all : all.exercises).filter(e => e.name === name).length;
};

test('logged offline, sent by a replay whose answer was lost, then deleted: deleted on the server too', opts, async () => {
  const { mod, env, send } = await page();
  setOnline(false);
  const first = await (await send('POST', '/api/cardio', run('2026-04-10'))).json();
  assert.equal(env.outbox()[0].sent, undefined, 'not tried yet');
  setOnline(true);
  drops.push({ method: 'POST', path: '/api/cardio' });
  await mod.flushOutbox();
  assert.equal(env.outbox()[0].sent, true, 'noted as tried, where it is kept');
  assert.equal(await cardioOn('2026-04-10'), 1);
  await mod.offlineFetch(`/api/cardio/${first.id}`, { method: 'DELETE' }, browserFetch);
  await drained(mod, env);
  assert.equal(await cardioOn('2026-04-10'), 0);
});

test('made and deleted before it was ever tried: neither goes up', opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  const before = sent.length;
  setOnline(false);
  const c = await (await send('POST', '/api/cardio', run('2026-04-11'))).json();
  const e = await (await send('POST', '/api/exercises', { name: 'Curl 0411' })).json();
  const w = (await (await send('PUT', '/api/workout/2026-04-11', { name: 'Never 0411', new_session: true, completed: true, exercises: [] })).json()).workout;
  await send('DELETE', `/api/cardio/${c.id}`);
  await send('DELETE', `/api/exercises/${e.id}`);
  await mod.offlineFetch(`/api/workout/2026-04-11?id=${w.id}`, { method: 'DELETE' }, browserFetch);
  setOnline(true);
  await drained(mod, env);
  // (Another test's page may still be retrying its own.)
  assert.deepEqual(sent.slice(before).filter(r => !r.startsWith('GET ') && /0411|2026-04-11/.test(r)), [], 'nothing of these sent at all');
  assert.equal(await cardioOn('2026-04-11'), 0);
  assert.equal(await exercisesNamed('Curl 0411'), 0);
  assert.deepEqual(await hooksSince(from), []);
});

test('tried but never arrived, then deleted: nothing made, no webhook, and a late arrival makes nothing', opts, async () => {
  const { mod, env, send } = await page();
  const from = deliveries.length;
  blocks.push({ method: 'POST', path: '/api/cardio' }, { method: 'POST', path: '/api/cardio' });
  const first = await (await send('POST', '/api/cardio', run('2026-04-12'))).json();
  assert.equal(first.queued, true);
  for (let i = 0; i < 200 && blocks.length; i++) await sleep(25);
  assert.equal(blocks.length, 0, 'tried twice, and neither arrived');
  await sleep(100);
  const create = env.outbox()[0];
  assert.equal(create.sent, true);
  await mod.offlineFetch(`/api/cardio/${first.id}`, { method: 'DELETE' }, browserFetch);
  await drained(mod, env);
  assert.equal(await cardioOn('2026-04-12'), 0);
  // The create, held up on the way, arrives after all.
  const late = await fetch(base + '/api/cardio', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(create.body) });
  assert.equal(late.status, 410);
  assert.equal(await cardioOn('2026-04-12'), 0, 'not made late');
  assert.deepEqual(await hooksSince(from), [], 'no webhook for something never kept');
});

test('a server from before deletes by key: the create goes again and its row is deleted by id', opts, async () => {
  oldServer = true;
  try {
    for (const [path, made, gone, count] of [
      ['/api/cardio', run('2026-04-13'), (id) => `/api/cardio/${id}`, () => cardioOn('2026-04-13')],
      ['/api/exercises', { name: 'Curl 0413' }, (id) => `/api/exercises/${id}`, () => exercisesNamed('Curl 0413')],
      ['/api/workout/2026-04-13', { name: 'Old 0413', new_session: true, completed: true, exercises: [] }, (id) => `/api/workout/2026-04-13?id=${id}`,
        async () => (await workoutsOn('2026-04-13')).filter(w => w.name === 'Old 0413').length],
    ]) {
      const { mod, env, send } = await page();
      const method = path.startsWith('/api/workout/') ? 'PUT' : 'POST';
      drops.push({ method, path }, { method, path });
      const first = await (await send(method, path, made)).json();
      for (let i = 0; i < 200 && drops.length; i++) await sleep(25);
      await sleep(100);
      assert.equal(await count(), 1, path);
      await mod.offlineFetch(gone(first.workout?.id ?? first.id), { method: 'DELETE' }, browserFetch);
      await drained(mod, env);
      assert.equal(await count(), 0, `${path}: deleted on the server as well`);
      assert.deepEqual(await mod.refusedChanges(), []);
    }
  } finally { oldServer = false; }
});

test('a delete by key reaches only your own row, once', opts, async () => {
  const made = await call('POST', '/api/cardio', { ...run('2026-04-14'), client_key: 'web-mine-0123456789' });
  assert.ok(made.id > 0);
  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ username: 'other0414', password: PW }) })).json();
  const other = reg.token || (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other0414', password: PW }) })).json()).token;
  assert.ok(other);
  const as = async (who, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who}` }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  // Another account with the same key deletes nothing of yours.
  assert.deepEqual((await as(other, 'DELETE', '/api/cardio/by-key/web-mine-0123456789')).data, { ok: true, by_key: true, deleted: false });
  assert.equal(await cardioOn('2026-04-14'), 1);
  // A key for another kind of row deletes nothing either.
  assert.deepEqual((await as(token, 'DELETE', '/api/exercises/by-key/web-mine-0123456789')).data, { ok: true, by_key: true, deleted: false });
  assert.equal(await cardioOn('2026-04-14'), 1);
  // Yours: deleted, and asked again, already gone.
  assert.deepEqual((await as(token, 'DELETE', '/api/cardio/by-key/web-mine-0123456789')).data, { ok: true, by_key: true, deleted: true });
  assert.deepEqual((await as(token, 'DELETE', '/api/cardio/by-key/web-mine-0123456789')).data, { ok: true, by_key: true, deleted: false });
  assert.equal(await cardioOn('2026-04-14'), 0);
  // The create sent again is answered as deleted since, not made again.
  assert.equal((await as(token, 'POST', '/api/cardio', { ...run('2026-04-14'), client_key: 'web-mine-0123456789' })).status, 410);
  assert.equal(await cardioOn('2026-04-14'), 0);
  assert.equal((await as(token, 'DELETE', '/api/cardio/by-key/short')).status, 400);
});

// Changed or deleted while the replay sending its create waited for the
// server's answer: the change was queued during the replay, under the same
// temporary id, and cleared with the create once its answer came, never sent
// (found in review of the fix above).
test('changed or deleted while its create is on its way up: the change still goes', opts, async () => {
  const { mod, env, send } = await page();
  setOnline(false);
  const kept = await (await send('POST', '/api/cardio', { ...run('2026-04-15'), activity: 'Kept 0415' })).json();
  const doomed = await (await send('POST', '/api/exercises', { name: 'Curl 0415' })).json();
  setOnline(true);
  const g = holdAnswer('POST', '/api/cardio');
  const flushing = mod.flushOutbox();
  for (let i = 0; i < 200 && !g.hit; i++) await sleep(25);
  assert.equal(g.hit, true, 'the create reached the server, its answer held');
  // Made while the replay waits.
  await send('PUT', `/api/cardio/${kept.id}`, { notes: 'changed meanwhile', duration_min: 41 });
  await send('DELETE', `/api/exercises/${doomed.id}`);
  g.open();
  await flushing;
  await drained(mod, env);
  const rows = await call('GET', '/api/cardio/2026-04-15');
  assert.deepEqual(rows.map(r => [r.notes, r.duration_min]), [['changed meanwhile', 41]]);
  assert.equal(await exercisesNamed('Curl 0415'), 0);
});

// Deleted a second time (another tab, a double tap) while the replay sending
// the first delete waited for the server's answer: the second waited for the
// next replay and went as a delete of a row already gone, by a temporary id
// the server never had when the first went by key, or by the id the first
// just deleted. The server answered "not found", and the person was told
// their server refused deleting a cardio session (found in review).
test('deleted again while the first delete is on its way up: done, not refused', opts, async () => {
  // By key: made, its answer lost, then deleted twice.
  {
    const { mod, env, send } = await page();
    drops.push({ method: 'POST', path: '/api/cardio' }, { method: 'POST', path: '/api/cardio' });
    const first = await (await send('POST', '/api/cardio', run('2026-04-16'))).json();
    for (let i = 0; i < 200 && drops.length; i++) await sleep(25);
    assert.equal(drops.length, 0, 'the server made it, and both answers were lost');
    await sleep(100);
    assert.equal(await cardioOn('2026-04-16'), 1);
    const key = env.outbox()[0].body.client_key;
    const g = holdAnswer('DELETE', `/api/cardio/by-key/${encodeURIComponent(key)}`);
    await mod.offlineFetch(`/api/cardio/${first.id}`, { method: 'DELETE' }, browserFetch);
    const flushing = mod.flushOutbox();
    for (let i = 0; i < 200 && !g.hit; i++) await sleep(25);
    assert.equal(g.hit, true, 'the delete by key reached the server, its answer held');
    await mod.offlineFetch(`/api/cardio/${first.id}`, { method: 'DELETE' }, browserFetch);
    g.open();
    await flushing;
    await drained(mod, env);
    assert.equal(await cardioOn('2026-04-16'), 0);
    assert.deepEqual(await mod.refusedChanges(), [], 'by key: nobody is told their delete was refused');
  }
  // By id: a session the server's id is known for, deleted with no
  // connection, then again while that delete goes up.
  {
    const { mod, env, send } = await page();
    const made = await (await send('POST', '/api/cardio', run('2026-04-17'))).json();
    assert.ok(made.id > 0);
    setOnline(false);
    await send('DELETE', `/api/cardio/${made.id}`);
    setOnline(true);
    const g = holdAnswer('DELETE', `/api/cardio/${made.id}`);
    const flushing = mod.flushOutbox();
    for (let i = 0; i < 200 && !g.hit; i++) await sleep(25);
    assert.equal(g.hit, true, 'the delete reached the server, its answer held');
    await send('DELETE', `/api/cardio/${made.id}`);
    g.open();
    await flushing;
    await drained(mod, env);
    assert.equal(await cardioOn('2026-04-17'), 0);
    assert.deepEqual(await mod.refusedChanges(), [], 'by id: nobody is told their delete was refused');
  }
  // Another account's session: answered as one already gone, and kept.
  {
    const mine = await call('POST', '/api/cardio', run('2026-04-18'));
    const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ username: 'other0418', password: PW }) })).json();
    const other = reg.token || (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other0418', password: PW }) })).json()).token;
    assert.ok(other);
    const del = async (who, id) => {
      const r = await fetch(`${base}/api/cardio/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${who}` } });
      return { status: r.status, data: await r.json() };
    };
    const theirs = await del(other, mine.id);
    assert.deepEqual(theirs, await del(other, 999999), "someone else's reads as no such session");
    assert.deepEqual(theirs, { status: 200, data: { ok: true, deleted: false } });
    assert.equal(await cardioOn('2026-04-18'), 1, 'still there');
    assert.deepEqual(await del(token, mine.id), { status: 200, data: { ok: true, deleted: true } });
    assert.deepEqual(await del(token, mine.id), { status: 200, data: { ok: true, deleted: false } });
    assert.equal(await cardioOn('2026-04-18'), 0);
  }
});
