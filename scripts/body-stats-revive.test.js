/**
 * A day's body stats edited after the day was deleted elsewhere (a third-party
 * client's POST /api/sync/push with deleted_at, or a restored backup that holds
 * such a day), against the real server (server/index.js on a scratch database).
 *
 * Before: a PUT, a push or a logged measurement wrote into the deleted row and
 * left deleted_at set, so a pull handed phones the deleted row with the new
 * measurement in it and they dropped the day; GET and the MCP readers showed the
 * deleted day as if it were there.
 *
 * Now (lib/body-stats-day.js): an edit made before the delete is answered as
 * gone (410, gone: true) and writes nothing; one made after it, or now, brings
 * the day back with only what was measured after the delete; and a deleted day
 * is not shown by the readers (the pull still sends it, so devices drop it).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let Database = null;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); Database = D; } catch { /* server packages missing: skip */ }
const skip = Database ? false : 'needs the server dependencies';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
let proc = null, base = null, dir = null, token = null, apiToken = null, userId = null;

async function call(method, path, body, headers = {}, auth = token) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function ok(method, path, body, headers, auth) {
  const r = await call(method, path, body, headers, auth);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
const iso = (ms) => new Date(ms).toISOString();
const nextSecond = async () => { const t = Math.ceil((Date.now() + 1) / 1000) * 1000 + 30; while (Date.now() < t) await sleep(5); };
let n = 0;
const DAY = () => new Date(Date.now() - (++n) * 864e5).toISOString().slice(0, 10);
const pullAll = () => ok('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
const pulled = async (d) => {
  const row = (await pullAll()).body_stats_log.find((b) => b.date === d);
  return row && { ...row, stats: typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats };
};
const push = (rows) => ok('POST', '/api/sync/push', { body_stats_log: rows });
const put = (d, stats, headers) => call('PUT', `/api/body-stats/${d}`, { stats }, headers);
const rawDb = () => new Database(join(dir, 'lt.db'));

test.before(async () => {
  if (!Database) return;
  dir = mkdtempSync(join(tmpdir(), 'lt-body-revive-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'body-revive-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1', API_RATE_LIMIT_PER_MIN: '5000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  await ok('POST', '/api/auth/register', { username: 'sam', password: PW, full_name: 'Sam Lee' }, {}, null);
  const login = await ok('POST', '/api/auth/login', { username: 'sam', password: PW }, {}, null);
  token = login.token;
  userId = (login.user || (await ok('GET', '/api/auth/me'))).id;
  apiToken = (await ok('POST', '/api/admin/api-tokens', { name: 'Home Assistant', scopes: ['mcp:read', 'mcp:write', 'mcp:destroy'], password: PW })).raw;
});
test.after(async () => {
  try {
    if (proc && proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function mcp(name, args) {
  const r = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(line ? line.slice(5) : text);
  assert.ok(!msg.error && !msg.result?.isError, `${name}: ${text.slice(0, 300)}`);
  return JSON.parse(msg.result.content[0].text);
}

// A day with weight 80 and waist 90, deleted by a third-party client's push.
// `before`: a time before the delete, `deleteAt`: the delete's, `after`: later.
async function deletedDay() {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } });
  await nextSecond();
  const before = iso(Date.now());
  await nextSecond();
  const deleteAt = iso(Date.now());
  await push([{ client_id: 1, date: d, deleted_at: deleteAt, updated_at: deleteAt }]);
  assert.ok((await pulled(d)).deleted_at, 'deleted');
  await nextSecond();
  const after = iso(Date.now());
  return { d, before, deleteAt, after };
}
const gone = (r) => r.status === 410 && r.data?.gone === true;

// ── PUT /api/body-stats/:date ────────────────────────────────────────────

test('PUT: an edit made before the delete is answered as gone and writes nothing', { skip }, async () => {
  const { d, before } = await deletedDay();
  const r = await put(d, { weight: 79 }, { 'X-Edited-At': before, 'X-Changed-Fields': 'weight' });
  assert.ok(gone(r), `answered as gone: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const row = await pulled(d);
  assert.ok(row.deleted_at, 'still deleted');
  assert.deepEqual(row.stats, { weight: 80, waist: 90 }, 'nothing written into it');
});

test('PUT: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { d, deleteAt } = await deletedDay();
  const r = await put(d, { weight: 79 }, { 'X-Edited-At': deleteAt, 'X-Changed-Fields': 'weight' });
  assert.ok(gone(r), `a tie goes to the delete: ${r.status}`);
  const row = await pulled(d);
  assert.ok(row.deleted_at);
  assert.equal(row.stats.weight, 80);
});

test('PUT: an edit made after the delete brings the day back with only what it measured', { skip }, async () => {
  const { d, after } = await deletedDay();
  const r = await put(d, { weight: 79 }, { 'X-Edited-At': after, 'X-Changed-Fields': 'weight' });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  assert.deepEqual(r.data.stats.stats, { weight: 79 }, 'the waist it was deleted with does not come back');
  const row = await pulled(d);
  assert.equal(row.deleted_at, null, 'live again for every device');
  assert.deepEqual(row.stats, { weight: 79 });
  assert.deepEqual((await call('GET', `/api/body-stats/${d}`)).data.stats.stats, { weight: 79 });
  const range = (await call('GET', `/api/body-stats/range?start=${d}&end=${d}`)).data;
  assert.equal(range.length, 1);
  assert.deepEqual(range[0].stats, { weight: 79 });
});

test('PUT: a save made now (the web, the app online) brings the day back', { skip }, async () => {
  const { d } = await deletedDay();
  const r = await put(d, { weight: 78, bodyFat: 18 });
  assert.equal(r.status, 200);
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { weight: 78, bodyFat: 18 });
});

test('PUT: of two edits sent as one, the one made before the delete still loses', { skip }, async () => {
  const { d, before, after } = await deletedDay();
  const r = await put(d, { weight: 79, waist: 88 }, {
    'X-Edited-At': after, 'X-Changed-Fields': 'weight,waist', 'X-Field-Edits': JSON.stringify({ weight: before, waist: after }),
  });
  assert.equal(r.status, 200);
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { waist: 88 }, 'the weight was changed before the delete: it stays deleted with it');
});

test('PUT: an edit with no measurements does not bring a deleted day back', { skip }, async () => {
  const { d, before, after } = await deletedDay();
  for (const body of [{}, { stats: null }, { stats: [] }, { stats: {} }, { stats: { foo: 1 } }, { stats: { weight: null } }]) {
    const r = await call('PUT', `/api/body-stats/${d}`, body, { 'X-Edited-At': after });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.stats, null, JSON.stringify(body));
  }
  // Nor does one that says it changed nothing, or whose every measurement was made before the delete.
  for (const headers of [{ 'X-Changed-Fields': '' }, { 'X-Changed-Fields': 'waist' }, { 'X-Field-Edits': JSON.stringify({ weight: before }) }]) {
    const r = await put(d, { weight: 79 }, { 'X-Edited-At': after, ...headers });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.stats, null, JSON.stringify(headers));
  }
  assert.ok((await pulled(d)).deleted_at, 'still deleted');
  assert.deepEqual((await pulled(d)).stats, { weight: 80, waist: 90 }, 'and untouched');
});

test('PUT: a delete made before the day came back loses to it; a later one wins, and an edit before that is gone', { skip }, async () => {
  const { d, deleteAt, after } = await deletedDay();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 79 } }, { 'X-Edited-At': after, 'X-Changed-Fields': 'weight' });
  await nextSecond();
  // A delete made offline right after the first delete, arriving now.
  await push([{ client_id: 1, date: d, deleted_at: iso(Date.parse(deleteAt) + 100), updated_at: iso(Date.parse(deleteAt) + 100) }]);
  assert.equal((await pulled(d)).deleted_at, null, 'the later edit keeps the day');
  await nextSecond();
  const second = iso(Date.now());
  await nextSecond();
  await push([{ client_id: 1, date: d, deleted_at: second, updated_at: second }]);
  assert.ok((await pulled(d)).deleted_at, 'a delete after the edit goes through');
  const r = await put(d, { weight: 77 }, { 'X-Edited-At': after, 'X-Changed-Fields': 'weight' });
  assert.ok(gone(r), `an edit older than this delete is gone: ${r.status}`);
});

test('PUT: an offline delete arriving late does not make an edit made after it gone', { skip }, async () => {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } });
  await nextSecond();
  const deletedOffline = iso(Date.now());
  await nextSecond();
  const editedOffline = iso(Date.now());
  await nextSecond();
  // The delete reaches the server after the edit was made, before it arrives.
  await push([{ client_id: 1, date: d, deleted_at: deletedOffline, updated_at: deletedOffline }]);
  assert.ok((await pulled(d)).deleted_at);
  const r = await put(d, { weight: 79 }, { 'X-Edited-At': editedOffline, 'X-Changed-Fields': 'weight' });
  assert.equal(r.status, 200, 'made after the delete was: it brings the day back');
  assert.deepEqual((await pulled(d)).stats, { weight: 79 });
});

// ── POST /api/sync/push ──────────────────────────────────────────────────

test('push: an edit made before the delete writes nothing; the device gets the deleted day', { skip }, async () => {
  const { d, before } = await deletedDay();
  const was = await pulled(d);
  await nextSecond();
  const r = await push([{ client_id: 7, date: d, stats: { weight: 79 }, updated_at: before }]);
  assert.equal(r.body_stats_log[0].server_id, was.id, 'answered, so the device stops sending it');
  const row = await pulled(d);
  assert.ok(row.deleted_at, 'still deleted');
  assert.deepEqual(row.stats, { weight: 80, waist: 90 });
  assert.ok(row.updated_at > was.updated_at, 'touched, so the device gets the deleted day');
});

test('push: an edit made in the delete\'s own moment keeps the delete', { skip }, async () => {
  const { d, deleteAt } = await deletedDay();
  await push([{ client_id: 7, date: d, stats: { weight: 79 }, updated_at: deleteAt }]);
  const row = await pulled(d);
  assert.ok(row.deleted_at);
  assert.equal(row.stats.weight, 80);
});

test('push: an edit made after the delete brings the day back with only what it measured', { skip }, async () => {
  const { d, after } = await deletedDay();
  const r = await push([{ client_id: 7, date: d, stats: { weight: 79 }, updated_at: after, changed_fields: ['weight'] }]);
  assert.ok(r.body_stats_log[0].server_id);
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { weight: 79 });
});

test('push: a copy with no measurements does not bring a deleted day back', { skip }, async () => {
  const { d, before, after } = await deletedDay();
  await push([{ client_id: 7, date: d, updated_at: after }]);
  await push([{ client_id: 8, date: d, stats: [], updated_at: after }]);
  await push([{ client_id: 9, date: d, stats: { foo: 1, weight: null }, updated_at: after }]);
  await push([{ client_id: 10, date: d, stats: { weight: 79 }, updated_at: after, changed_fields: [] }]);
  await push([{ client_id: 11, date: d, stats: { weight: 79 }, updated_at: after, field_edits: { weight: before } }]);
  const row = await pulled(d);
  assert.ok(row.deleted_at);
  assert.deepEqual(row.stats, { weight: 80, waist: 90 });
});

test('push: a copy made now (no time) brings the day back', { skip }, async () => {
  const { d } = await deletedDay();
  await push([{ client_id: 7, date: d, stats: { waist: 85 } }]);
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { waist: 85 });
});

// ── logged by MCP, REST v1 ───────────────────────────────────────────────

test('log_body_stat brings a deleted day back with only what it logged', { skip }, async () => {
  const { d, after } = await deletedDay();
  await nextSecond();
  const r = await mcp('log_body_stat', { date: d, weight: 79 });
  assert.deepEqual(r.stats, { weight: 79 });
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { weight: 79 });
  // An edit queued on a phone after the delete but before the weight was logged doesn't beat it.
  await put(d, { weight: 70 }, { 'X-Edited-At': after, 'X-Changed-Fields': 'weight' });
  assert.deepEqual((await pulled(d)).stats, { weight: 79 }, 'the older edit does not beat the logged one');
  // Nor does one made before the delete bring back a measurement it was deleted with.
  await put(d, { waist: 70 }, { 'X-Edited-At': iso(Date.parse(after) - 5000), 'X-Changed-Fields': 'waist' });
  assert.deepEqual((await pulled(d)).stats, { weight: 79 });
});

test('log_body_stat and REST v1 with nothing to measure leave a deleted day deleted', { skip }, async () => {
  const { d } = await deletedDay();
  const r = await call('PUT', `/api/v1/body-stats/${d}`, { foo: 1 }, {}, apiToken);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.stats, {});
  const row = await pulled(d);
  assert.ok(row.deleted_at);
  assert.deepEqual(row.stats, { weight: 80, waist: 90 });
});

test('REST v1 PUT /body-stats/:date brings a deleted day back', { skip }, async () => {
  const { d } = await deletedDay();
  const r = await call('PUT', `/api/v1/body-stats/${d}`, { weight: 77.5 }, {}, apiToken);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await pulled(d);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(row.stats, { weight: 77.5 });
});

// ── readers ──────────────────────────────────────────────────────────────

test('a deleted day is not shown by any reader; the pull still sends it', { skip }, async () => {
  const { d } = await deletedDay();
  assert.equal((await call('GET', `/api/body-stats/${d}`)).data.stats, null);
  assert.deepEqual((await call('GET', `/api/body-stats/range?start=${d}&end=${d}`)).data, []);
  const one = await mcp('get_body_stat', { date: d });
  assert.equal(one.logged, false);
  assert.deepEqual(one.stats, {});
  const many = await mcp('get_body_stats', { start: d, end: d });
  assert.equal(many.count, 0);
  assert.equal((await call('GET', `/api/v1/body-stats/${d}`, null, {}, apiToken)).data.logged, false);
  assert.equal((await call('GET', `/api/v1/body-stats?start=${d}&end=${d}`, null, {}, apiToken)).data.count, 0);
  assert.ok((await pulled(d)).deleted_at, 'the pull sends the deleted day');
});

test('a day that was never deleted reads as before', { skip }, async () => {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80 } });
  assert.deepEqual((await call('GET', `/api/body-stats/${d}`)).data.stats.stats, { weight: 80 });
  assert.equal((await call('GET', `/api/body-stats/range?start=${d}&end=${d}`)).data.length, 1);
  assert.equal((await mcp('get_body_stat', { date: d })).logged, true);
  assert.equal((await mcp('get_body_stats', { start: d, end: d })).count, 1);
});

// ── a day from a restored backup, or written into while deleted (before) ─

test('a deleted day with no times, or one measurement written after the delete, comes back with only what was measured since', { skip }, async () => {
  const d = DAY();
  const db = rawDb();
  try {
    // As a backup from before the times were kept restores it.
    db.prepare(`INSERT INTO body_stats_log (user_id, date, stats, field_times, deleted_at) VALUES (?, ?, ?, NULL, '2026-01-01 10:00:00')`).run(userId, d, '{"weight":80,"waist":90}');
    // As the old server left one: the weight written after the delete.
    const e = DAY();
    db.prepare(`INSERT INTO body_stats_log (user_id, date, stats, field_times, deleted_at) VALUES (?, ?, ?, ?, '2026-01-01 10:00:00')`)
      .run(userId, e, '{"weight":79,"waist":90}', JSON.stringify({ _base: '2025-12-01T09:00:00.000Z', weight: '2026-01-02T09:00:00.000Z' }));
    // Deleted at a time the server has no stamp for, edited later (2026).
    for (const date of [d]) {
      const r = await put(date, { bodyFat: 18 }, { 'X-Edited-At': iso(Date.now() - 1000), 'X-Changed-Fields': 'bodyFat' });
      assert.equal(r.status, 200);
      assert.deepEqual((await pulled(date)).stats, { bodyFat: 18 }, 'nothing it was deleted with comes back');
    }
    const r = await put(e, { bodyFat: 18 }, { 'X-Edited-At': iso(Date.now() - 1000), 'X-Changed-Fields': 'bodyFat' });
    assert.equal(r.status, 200);
    assert.deepEqual((await pulled(e)).stats, { weight: 79, bodyFat: 18 }, 'what was measured after the delete stays');
    assert.equal((await pulled(e)).deleted_at, null);
  } finally { db.close(); }
});

// ── a server without user accounts (rows with no user_id) ────────────────

test('without user accounts the same holds: gone if older, back if newer, hidden while deleted', { skip }, async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'lt-body-revive-solo-'));
  const port = await freePort();
  const sbase = `http://127.0.0.1:${port}`;
  const sproc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(sdir, 'lt.db'), UPLOADS_PATH: join(sdir, 'uploads'),
      BACKUPS_PATH: join(sdir, 'backups'), JWT_SECRET: 'body-revive-solo-0123456789abcdef0123456789', INSECURE_COOKIES: '1',
      NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 300; i++) {
      if (sproc.exitCode != null) throw new Error('server exited at startup');
      try { if ((await fetch(sbase + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    const sc = async (method, path, body, headers = {}) => {
      const r = await fetch(sbase + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body) });
      const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data };
    };
    const d = '2026-03-03';
    assert.equal((await sc('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, waist: 90 } })).status, 200);
    await nextSecond();
    const before = iso(Date.now());
    await nextSecond();
    const deleteAt = iso(Date.now());
    assert.equal((await sc('POST', '/api/sync/push', { body_stats_log: [{ client_id: 1, date: d, deleted_at: deleteAt, updated_at: deleteAt }] })).status, 200);
    await nextSecond();
    const after = iso(Date.now());
    assert.equal((await sc('GET', `/api/body-stats/${d}`)).data.stats, null, 'a deleted day is not shown');
    assert.deepEqual((await sc('GET', `/api/body-stats/range?start=${d}&end=${d}`)).data, []);
    const old = await sc('PUT', `/api/body-stats/${d}`, { stats: { weight: 79 } }, { 'X-Edited-At': before, 'X-Changed-Fields': 'weight' });
    assert.ok(gone(old), `older: ${old.status}`);
    const fresh = await sc('PUT', `/api/body-stats/${d}`, { stats: { weight: 78 } }, { 'X-Edited-At': after, 'X-Changed-Fields': 'weight' });
    assert.equal(fresh.status, 200);
    assert.deepEqual((await sc('GET', `/api/body-stats/${d}`)).data.stats.stats, { weight: 78 });
    const row = (await sc('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`)).data.body_stats_log.find((b) => b.date === d);
    assert.equal(row.deleted_at, null);
  } finally {
    if (sproc.exitCode == null && sproc.signalCode == null) await new Promise((r) => { sproc.once('exit', r); sproc.kill(); });
    rmSync(sdir, { recursive: true, force: true });
  }
});

test('only measurements are stamped: a key such as deleted_at or _base in a save is not one', { skip }, async () => {
  const d = DAY();
  await ok('PUT', `/api/body-stats/${d}`, { stats: { weight: 80, deleted_at: 'x', _base: 'y', foo: 1 } });
  await push([{ client_id: 1, date: `${d}`, stats: { waist: 90, deleted_at: 'x', _base: 'y' }, updated_at: iso(Date.now()) }]);
  await mcp('log_body_stat', { date: d, hips: 95 });
  const db = rawDb();
  try {
    const row = db.prepare('SELECT stats, field_times FROM body_stats_log WHERE date = ? AND user_id = ?').get(d, userId);
    assert.deepEqual(JSON.parse(row.stats), { weight: 80, waist: 90, hips: 95 });
    const times = JSON.parse(row.field_times);
    for (const k of Object.keys(times)) assert.ok(['weight', 'waist', 'hips', '_base'].includes(k) && (k !== '_base' || typeof times._base === 'string'), `stamped ${k}`);
    assert.ok(!('deleted_at' in times), 'a live day has no delete stamp');
    assert.ok(!('foo' in times));
    assert.ok(Number.isFinite(Date.parse(times.weight)) && Number.isFinite(Date.parse(times.waist)) && Number.isFinite(Date.parse(times.hips)));
  } finally { db.close(); }
});
