/**
 * Webhooks from every way a log reaches the server, against the real server
 * (server/index.js on a scratch database) and a local receiver that checks
 * each delivery's signature.
 *
 * Before this, log_body_stat and log_set over MCP and their REST routes
 * (PUT /api/v1/body-stats/:date, POST /api/v1/workouts/:date/sets) saved
 * without sending body_stat.logged or pr.set, while the app's own routes
 * sent them. Now each save sends them once, with the app's payload: body
 * stats on every save, a record only when one improved, never twice for a
 * repeated save. The cardio-off refusal carries code: 'cardio_disabled' in
 * the REST body and in the MCP tool's structuredContent.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const DAY = '2026-10-20';
let proc = null, base = null, dir = null, receiver = null;
let session = null, apiToken = null, secret = null, exerciseId = null;
const deliveries = [];

async function call(auth, method, path, body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch {
    // MCP over Streamable HTTP may answer as an event stream.
    const line = text.split('\n').filter(l => l.startsWith('data:')).pop();
    try { data = JSON.parse(line.slice(5)); } catch { data = text; }
  }
  return { status: r.status, data };
}
const app = (method, path, body) => call(session, method, path, body);
const rest = (method, path, body) => call(apiToken, method, `/api/v1${path}`, body);
let rpc = 0;
async function mcp(name, args) {
  const r = await call(apiToken, 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.result;
}

// Deliveries of `event` that `fn` caused. Delivery is fire-and-forget, so
// this waits for the receiver to go quiet.
async function sent(event, fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) {
    assert.ok(d.signed, `${d.event} delivery carries a valid signature`);
    assert.equal(d.header, d.event);
  }
  return { out, events: got.filter(d => d.event === event).map(d => d.data), all: got };
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-write-webhooks-'));
  const hookPort = await freePort();
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const env = JSON.parse(raw);
      const signed = !!secret && req.headers['x-lifttrace-signature'] === `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      deliveries.push({ event: env.event, data: env.data, signed, header: req.headers['x-lifttrace-event'] });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(hookPort, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'write-webhooks-test-0123456789abcdef0123',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const reg = await call(null, 'POST', '/api/auth/register', { username: 'lifter', password: PW });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  session = reg.data.token;
  const tok = await app('POST', '/api/admin/api-tokens', { name: 'test', scopes: ['mcp:read', 'mcp:write'], password: PW });
  apiToken = tok.data.raw;
  assert.ok(apiToken, JSON.stringify(tok.data));
  const hook = await app('POST', '/api/webhooks', { url: `http://127.0.0.1:${hookPort}/hook`, events: ['body_stat.logged', 'pr.set', 'cardio.logged'] });
  secret = hook.data.secret;
  assert.ok(secret, JSON.stringify(hook.data));
  exerciseId = (await app('POST', '/api/exercises', { name: 'Bench Press' })).data.id;
  assert.ok(exerciseId);
});

test.after(async () => {
  if (proc) {
    const p = proc; proc = null;
    await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
  }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !ready && 'server packages not installed' };

test('body_stat.logged: app, REST and MCP each send one, with the day\'s merged stats', opts, async () => {
  const viaApp = await sent('body_stat.logged', () => app('PUT', `/api/body-stats/${DAY}`, { stats: { weight: 80 } }));
  assert.deepEqual(viaApp.events, [{ date: DAY, stats: { weight: 80 } }]);

  const viaRest = await sent('body_stat.logged', () => rest('PUT', `/body-stats/${DAY}`, { bodyFat: 18 }));
  assert.equal(viaRest.out.status, 200);
  assert.deepEqual(viaRest.events, [{ date: DAY, stats: { weight: 80, bodyFat: 18 } }]);

  const viaMcp = await sent('body_stat.logged', () => mcp('log_body_stat', { waist: 85, date: DAY }));
  assert.ok(!viaMcp.out.isError, JSON.stringify(viaMcp.out));
  assert.deepEqual(viaMcp.events, [{ date: DAY, stats: { weight: 80, bodyFat: 18, waist: 85 } }]);

  // A refused save sends nothing.
  const refused = await sent('body_stat.logged', () => rest('PUT', `/body-stats/${DAY}`, { weight: 9999 }));
  assert.equal(refused.out.status, 400);
  assert.equal(refused.all.length, 0);
});

test('pr.set: REST and MCP send one for a new record, as the app does, and nothing otherwise', opts, async () => {
  const set = (weight, extra = {}) => ({ uuid: `s-${weight}-${Math.random()}`, reps: 5, weight, completed: true, ...extra });
  const day = (weight) => ({ exercises: [{ uuid: 'ex-1', exercise_id: exerciseId, exercise_name: 'Bench Press', sets: [set(weight)] }], client_key: `workout-${weight}-key` });

  const viaApp = await sent('pr.set', () => app('PUT', '/api/workout/2026-10-18', day(100)));
  assert.equal(viaApp.events.length, 1);
  const shape = Object.keys(viaApp.events[0]).sort();
  // The same save again (a replayed write) changes no record.
  const replay = await sent('pr.set', () => app('PUT', '/api/workout/2026-10-18', day(100)));
  assert.equal(replay.events.length, 0);

  const viaRest = await sent('pr.set', () => rest('POST', `/workouts/${DAY}/sets`, { exercise_id: exerciseId, reps: 5, weight: 120 }));
  assert.equal(viaRest.out.status, 200);
  assert.equal(viaRest.events.length, 1);
  assert.deepEqual(Object.keys(viaRest.events[0]).sort(), shape, 'same payload fields as the app');
  assert.equal(viaRest.events[0].date, DAY);
  assert.equal(viaRest.events[0].new_max_weight, 120);
  assert.equal(viaRest.events[0].previous_max_weight, 100);
  assert.equal(viaRest.events[0].exercise_name, 'Bench Press');

  const lighter = await sent('pr.set', () => rest('POST', `/workouts/${DAY}/sets`, { exercise_id: exerciseId, reps: 5, weight: 50 }));
  assert.equal(lighter.events.length, 0);

  const viaMcp = await sent('pr.set', () => mcp('log_set', { exercise_id: exerciseId, reps: 5, weight: 130, date: DAY }));
  assert.ok(!viaMcp.out.isError, JSON.stringify(viaMcp.out));
  assert.equal(viaMcp.events.length, 1);
  assert.deepEqual(Object.keys(viaMcp.events[0]).sort(), shape);
  assert.equal(viaMcp.events[0].new_max_weight, 130);
  assert.equal(viaMcp.events[0].previous_max_weight, 120);

  // Unfinished and warm-up sets never hold a record.
  const unfinished = await sent('pr.set', () => mcp('log_set', { exercise_id: exerciseId, reps: 5, weight: 200, completed: false, date: DAY }));
  assert.equal(unfinished.events.length, 0);
  const warmup = await sent('pr.set', () => mcp('log_set', { exercise_id: exerciseId, reps: 5, weight: 200, warmup: true, date: DAY }));
  assert.equal(warmup.events.length, 0);
});

test('pr.set: a longer hold over MCP is a record too', opts, async () => {
  const plank = (await app('POST', '/api/exercises', { name: 'Plank', set_type: 'time' })).data.id;
  const first = await sent('pr.set', () => mcp('log_set', { exercise_id: plank, duration_sec: 60, date: DAY }));
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].new_max_duration_sec, 60);
  const shorter = await sent('pr.set', () => mcp('log_set', { exercise_id: plank, duration_sec: 30, date: DAY }));
  assert.equal(shorter.events.length, 0);
});

test('cardio off: REST and MCP refuse with code cardio_disabled and send nothing', opts, async () => {
  const viaRest = await sent('cardio.logged', () => rest('POST', '/cardio', { activity: 'Run', duration_min: 30, date: DAY }));
  assert.equal(viaRest.out.status, 400);
  assert.equal(viaRest.out.data.code, 'cardio_disabled');
  assert.match(viaRest.out.data.error, /^Cardio is off for this account\. Turn on Track Cardio in LiftTrace under Settings > Workout\./);
  assert.equal(viaRest.all.length, 0);

  const viaMcp = await sent('cardio.logged', () => mcp('log_cardio', { activity: 'Run', duration_min: 30, date: DAY }));
  assert.equal(viaMcp.out.isError, true);
  assert.equal(viaMcp.out.structuredContent?.code, 'cardio_disabled');
  assert.equal(viaMcp.out.content[0].text, viaRest.out.data.error, 'the text stays the message alone');
  assert.equal(viaMcp.all.length, 0);

  // Other refusals carry no code.
  const bad = await rest('PUT', `/body-stats/${DAY}`, { weight: 9999 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, undefined);

  // Reads still work while it's off, and say so.
  const read = await rest('GET', `/cardio?start=${DAY}&end=${DAY}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.cardio_enabled, false);
});

test('cardio on: one cardio.logged per new session, none for a repeat', opts, async () => {
  await app('PUT', '/api/settings', { key: 'cardioEnabled', value: true });
  const first = await sent('cardio.logged', () => rest('POST', '/cardio', { activity: 'Run', duration_min: 30, date: DAY, external_id: 'run-1' }));
  assert.equal(first.events.length, 1);
  const again = await sent('cardio.logged', () => rest('POST', '/cardio', { activity: 'Run', duration_min: 30, date: DAY, external_id: 'run-1' }));
  assert.equal(again.events.length, 0);
  const viaMcp = await sent('cardio.logged', () => mcp('log_cardio', { activity: 'Ride', duration_min: 40, date: DAY }));
  assert.equal(viaMcp.events.length, 1);
  const body = { date: DAY, activity: 'Walk', duration_min: 20, client_key: 'cardio-walk-key' };
  const viaApp = await sent('cardio.logged', () => app('POST', '/api/cardio', body));
  assert.equal(viaApp.events.length, 1);
  const replayed = await sent('cardio.logged', () => app('POST', '/api/cardio', body));
  assert.equal(replayed.events.length, 0);
});
