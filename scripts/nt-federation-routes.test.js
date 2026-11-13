/**
 * The NutriTrace federation routes against the real server and a NutriTrace
 * stub: a connection is saved as one atomic transition, body reads carry a
 * receipt tied to that saved connection, and one account can never see or
 * change another's.
 *
 * These are behaviour tests, not route-source checks: the transition is
 * driven through HTTP, with two writers interleaved, and the assertions are
 * about what GET /api/nt/federation-connection and the body proxy answer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try {
  const D = serverRequire('better-sqlite3');
  new D(':memory:').close();
  ready = true;
} catch { /* server packages missing: skip */ }

const freePort = () => new Promise((resolve, reject) => {
  const s = netServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-99!z';
const JWT_SECRET = 'nt-federation-routes-0123456789abcdef';
const SET = '••••••••';
let dir = null;
let LT = null;
let NT = null;          // { base, state, close }
let A = null;           // { id, token }
let B = null;

async function boot() {
  const port = await freePort();
  LT = { base: `http://127.0.0.1:${port}`, proc: null };
  LT.proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(),
      PORT: String(port),
      DB_PATH: join(dir, 'lt.db'),
      UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET,
      INSECURE_COOKIES: '1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      UPDATE_CHECK: 'off',
      // The body deadline, size ceiling and receipt TTL are exercised quickly.
      NT_TIMEOUT_MS: '500',
      NT_MAX_REPLY_BYTES: '65536',
      NT_READ_TTL_MS: '800',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(LT.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('LiftTrace server did not start');
}

async function stop() {
  if (!LT?.proc) return;
  const proc = LT.proc;
  LT.proc = null;
  if (proc.exitCode != null || proc.signalCode != null) return;
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
}

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who?.token) headers.Authorization = `Bearer ${who.token}`;
  const res = await fetch(LT.base + path, {
    method,
    headers,
    body: body == null || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const ok = async (...args) => {
  const res = await call(...args);
  assert.ok(res.status < 300, `${args[1]} ${args[2]} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
};

/** A NutriTrace stub whose address path names the connection it answers for. */
async function fakeNt() {
  const state = { base: '', seen: [], meDelayMs: 0, bodyMode: 'ok', bodyBytes: 0 };
  const users = {
    'token-a': { id: 1, name: 'alice', prefix: '/a' },
    'token-a2': { id: 1, name: 'alice', prefix: '/a' },  // rotated token, same user
    'token-b': { id: 2, name: 'bob', prefix: '/b' },
  };
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const server = httpServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    state.seen.push({ url: req.url, token });
    const prefix = req.url.startsWith('/a/') ? '/a' : req.url.startsWith('/b/') ? '/b' : '';
    const rest = req.url.slice(prefix.length);
    const who = users[token];
    if (!prefix || !who || who.prefix !== prefix) return json(res, 401, { error: 'invalid token' });

    if (rest === '/api/v1/me') {
      const answer = {
        user: { id: who.id, username: who.name },
        instance: { url: state.base + prefix },
        scopes: ['write:workouts', 'mcp:read'],
      };
      if (state.meDelayMs) setTimeout(() => json(res, 200, answer), state.meDelayMs);
      else json(res, 200, answer);
      return;
    }
    if (rest === '/api/v1/body-composition') {
      if (state.bodyMode === 'slow') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"measurements":');
        return; // never finishes: the proxy deadline has to end this
      }
      if (state.bodyMode === 'large') {
        const padding = 'x'.repeat(state.bodyBytes);
        return json(res, 200, { measurements: [], padding });
      }
      return json(res, 200, {
        measurements: [{
          date: '2026-11-01',
          source: 'source-a',
          metrics: { weight_kg: 70 + who.id },
        }],
      });
    }
    if (rest === '/api/v1/workouts') return json(res, 200, { ok: true });
    json(res, 404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    url: path => state.base + path,
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function signIn() {
  const first = await ok(null, 'POST', '/api/auth/register', { username: 'alice', password: PW });
  A = { id: first.user.id, token: first.token };
  const second = await ok(A, 'POST', '/api/auth/register', { username: 'bob', password: PW, role: 'member' });
  const jwt = serverRequire('jsonwebtoken');
  B = { id: second.user.id, token: jwt.sign({ id: second.user.id, username: 'bob', role: 'member' }, JWT_SECRET, { expiresIn: '1h' }) };
}

const connection = who => call(who, 'GET', '/api/nt/federation-connection');
const save = (who, body) => call(who, 'PUT', '/api/nt/federation-connection', body);
const current = async who => (await connection(who)).data.connection;

test('a connection transition is atomic between two tabs', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-routes-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    // Two tabs of the SAME account, each saving a different connection. The
    // address path and the identity NutriTrace reports for it identify the
    // same pair, so a mixed answer (one Save's address, the other's identity)
    // is visible here.
    for (let round = 0; round < 5; round++) {
      NT.state.meDelayMs = 15;
      const a = save(A, { url: NT.url('/a'), token: 'token-a', enabled: true });
      const b = save(A, { url: NT.url('/b'), token: 'token-b', enabled: true });
      for (let read = 0; read < 3; read++) {
        const got = await connection(A);
        assert.ok(got.status < 300, JSON.stringify(got.data));
        if (!got.data.connection) continue;
        const c = got.data.connection;
        const expectedUser = c.url.endsWith('/a') ? '1' : c.url.endsWith('/b') ? '2' : null;
        assert.ok(expectedUser, `unexpected saved address ${c.url}`);
        assert.equal(c.identity.instanceUrl, c.url, 'address and identity come from the same Save');
        assert.equal(c.identity.userId, expectedUser, 'identity belongs to the saved address');
        assert.equal(typeof c.identity.fingerprint, 'string');
        assert.ok(Number.isSafeInteger(c.version) && c.version > 0, 'every committed transition has a version');
        assert.equal('token' in c, false, 'the token is never sent back');
      }
      const [ra, rb] = await Promise.allSettled([a, b]);
      for (const settled of [ra, rb]) {
        assert.equal(settled.status, 'fulfilled', String(settled.reason));
        assert.ok(settled.value.status < 300, JSON.stringify(settled.value.data));
      }
    }
    NT.state.meDelayMs = 0;

    // A read uses the stored token and the receipt names the saved pair.
    const read = await call(A, 'GET', '/api/nt/body-composition');
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.ok(read.headers.get('x-lt-nt-read-id'));
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Save based on an older version is refused, including OFF then stale ON', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-cas-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    await ok(A, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });
    const loaded = await current(A);
    const loadedVersion = loaded.version;

    // Tab 2 saves B while tab 1 still shows A at `loadedVersion`.
    const savedB = await save(A, {
      url: NT.url('/b'), token: 'token-b', enabled: true, ifVersion: loadedVersion,
    });
    assert.equal(savedB.status, 200, JSON.stringify(savedB.data));
    assert.ok(savedB.data.connection.version > loadedVersion);

    // Tab 1's stale Save is refused and names what the server holds now.
    const stale = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: loadedVersion,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'connection-changed');
    assert.equal(stale.data.connection.url, NT.url('/b'), 'the refusal carries the connection to reconcile with');
    assert.equal(stale.data.connection.version, savedB.data.connection.version);
    assert.equal((await current(A)).url, NT.url('/b'));

    // OFF bumps the version even though URL, token and identity stay the same...
    const offVersion = (await current(A)).version;
    const off = await save(A, {
      url: NT.url('/b'), token: SET, enabled: false, ifVersion: offVersion,
    });
    assert.equal(off.status, 200, JSON.stringify(off.data));
    assert.ok(off.data.connection.version > offVersion);

    // ...so a second tab that loaded the connection while it was on cannot
    // turn it back on with its stale snapshot.
    const staleOn = await save(A, {
      url: NT.url('/b'), token: SET, enabled: true, ifVersion: offVersion,
    });
    assert.equal(staleOn.status, 409);
    assert.equal(staleOn.data.code, 'connection-changed');
    assert.equal((await current(A)).enabled, false, 'the stale ON did not re-enable federation');

    // A -> B -> A bumps the version on every step, so an old A snapshot is
    // still stale even though the address and identity are A again.
    const v1 = (await current(A)).version;
    await ok(A, 'PUT', '/api/nt/federation-connection', {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: v1,
    });
    const v2 = (await current(A)).version;
    await ok(A, 'PUT', '/api/nt/federation-connection', {
      url: NT.url('/b'), token: 'token-b', enabled: true, ifVersion: v2,
    });
    const v3 = (await current(A)).version;
    await ok(A, 'PUT', '/api/nt/federation-connection', {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: v3,
    });
    const staleA = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: v1,
    });
    assert.equal(staleA.status, 409, 'A -> B -> A does not make an old A Save current again');
    assert.ok((await current(A)).version > v1);

    // An explicitly typed token is still sent to the new address, and a
    // refusal there leaves the saved connection whole.
    const before = await current(A);
    const wrongAddress = await save(A, {
      url: NT.url('/b'), token: 'token-a', enabled: true, ifVersion: before.version,
    });
    assert.equal(wrongAddress.status, 502);
    assert.equal(wrongAddress.data.code, 'nt-error');
    const after = await current(A);
    assert.equal(after.url, NT.url('/a'));
    assert.equal(after.version, before.version, 'a refused verification writes nothing');

    // A client from before the atomic endpoint writes one key directly. That
    // is a transition too: it bumps the version, so a Save already on its way
    // with the old one cannot pass.
    const beforeGeneric = after.version;
    await ok(A, 'PUT', '/api/settings', { key: 'ntFederationEnabled', value: false });
    const generic = await current(A);
    assert.equal(generic.enabled, false);
    assert.equal(generic.version, beforeGeneric + 1, 'a direct connection write bumps the version');
    const staleAfterGeneric = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: beforeGeneric,
    });
    assert.equal(staleAfterGeneric.status, 409);

    // Clear All Settings removes the connection rows and bumps the version,
    // so a Save waiting on NutriTrace cannot restore it alone.
    const beforeClear = generic.version;
    await ok(A, 'DELETE', '/api/settings');
    assert.equal(await current(A), null);
    const staleAfterClear = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: beforeClear,
    });
    assert.equal(staleAfterClear.status, 409, 'the cleared connection is not restored by a stale Save');
    assert.equal(await current(A), null);
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tab opened before the first connection cannot turn federation back on', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-zero-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    // Tab 1 has never connected: version 0, no identity.
    // Tab 2 connects, then switches federation off.
    const first = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: 0,
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const off = await save(A, {
      url: NT.url('/a'), token: SET, enabled: false, ifVersion: first.data.connection.version,
    });
    assert.equal(off.status, 200, JSON.stringify(off.data));

    // Tab 1's Save still says version 0 and must not pass.
    const stale = await save(A, {
      url: NT.url('/a'), token: 'token-a', enabled: true, ifVersion: 0,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'connection-changed');
    assert.equal((await current(A)).enabled, false, 'the stale version-0 Save did not re-enable it');
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection change is all-or-nothing, and a write-only token stays on its server', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-transition-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    let res = await save(A, { url: NT.url('/a'), token: 'token-a', enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const before = await current(A);

    // The page sends the placeholder it was shown: the server reuses the
    // secret saved for this address, so nothing changes.
    res = await save(A, { url: NT.url('/a'), token: SET, enabled: true, ifVersion: before.version });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    let after = await current(A);
    assert.equal(after.identity.fingerprint, before.identity.fingerprint, 'the same credential is still in place');
    assert.ok(after.version > before.version, 'the transition still has its own version');

    // A placeholder cannot travel to another address.
    res = await save(A, { url: NT.url('/b'), token: SET, enabled: true, ifVersion: after.version });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'token-required');
    after = await current(A);
    assert.equal(after.url, NT.url('/a'));

    // A token NutriTrace refuses leaves the previous connection whole.
    res = await save(A, { url: NT.url('/a'), token: 'not-a-token', enabled: true, ifVersion: after.version });
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'nt-error');
    const unchanged = await current(A);
    assert.equal(unchanged.url, NT.url('/a'));
    assert.equal(unchanged.enabled, true);
    assert.equal(unchanged.version, after.version);

    // Turning it off is a transition too, and does not need NutriTrace.
    NT.state.seen.length = 0;
    res = await save(A, { url: NT.url('/a'), token: SET, enabled: false, ifVersion: unchanged.version });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(NT.state.seen.length, 0, 'disabling writes no request to NutriTrace');
    assert.equal((await current(A)).enabled, false);
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connections are per account and the server-owned keys stay server-owned', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-owner-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    assert.equal((await current(B)), null, 'a new account has no connection');
    await ok(A, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });
    await ok(B, 'PUT', '/api/nt/federation-connection', { url: NT.url('/b'), token: 'token-b', enabled: true });

    assert.equal((await current(A)).url, NT.url('/a'));
    assert.equal((await current(B)).url, NT.url('/b'));
    assert.equal((await call(A, 'POST', '/api/nt/body-provenance', {
      connectionIdentity: { instanceUrl: NT.url('/b'), userId: '2' }, source: 'source-b', readId: 'x',
    })).status, 409, 'one account cannot claim the other account\'s connection');

    for (const key of [
      'ntBodyProvenance', 'ntBodySyncedSource', 'ntBodySyncedConnectionIdentity',
      'ntConnectionVersion', 'ntConnectionScopes',
    ]) {
      const put = await call(A, 'PUT', '/api/settings', { key, value: { source: 'forged' } });
      assert.equal(put.status, 403, `${key} is refused by the generic settings API`);
      assert.equal(put.data.code, 'reserved-setting');
    }
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection saved before identities keeps sending workouts; body import waits for verification', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-legacy-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();

    // Exactly what a connection saved before this PR has: URL, token and the
    // workout switch, no identity and no version.
    for (const [key, value] of [
      ['ntInstanceUrl', NT.url('/a')],
      ['ntInstanceToken', 'token-a'],
      ['ntFederationEnabled', true],
      ['ntConnectionVerified', true],
    ]) {
      await ok(A, 'PUT', '/api/settings', { key, value });
    }

    const legacy = await current(A);
    assert.equal(legacy.url, NT.url('/a'));
    assert.equal(legacy.enabled, true, 'the workout switch stays on');
    assert.equal(legacy.identity, null);
    assert.equal(legacy.verified, false);

    const workout = await call(A, 'POST', '/api/nt/log-workout', {
      date: '2026-11-01', name: 'Legacy day', calories_burned: 120, external_id: 'legacy-1',
    });
    assert.equal(workout.status, 200, JSON.stringify(workout.data));

    // Body measurements cannot be imported until the connection is verified
    // again; the saved URL and token are enough to verify without retyping.
    const read = await call(A, 'GET', '/api/nt/body-composition');
    assert.equal(read.status, 503);
    assert.equal(read.data.code, 'connection-unverified');

    const verified = await save(A, {
      url: NT.url('/a'), token: SET, enabled: true, ifVersion: legacy.version,
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.ok(verified.data.connection.identity);
    assert.equal((await call(A, 'GET', '/api/nt/body-composition')).status, 200);
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a receipt is single-use, per account, expires, and is bound to the saved configuration', { skip: ready ? false : 'no server dependencies' }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'lt-nt-receipt-'));
  dir = dirPath;
  NT = await fakeNt();
  try {
    await boot();
    await signIn();
    await ok(A, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });

    const readOnce = async (who = A) => {
      // The Android WebView reads the receipt header from another origin;
      // the server only exposes it to an allowed Origin.
      const res = await fetch(LT.base + '/api/nt/body-composition', {
        headers: { Authorization: `Bearer ${who.token}`, Origin: 'https://app.lifttrace.local' },
      });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      assert.match(res.headers.get('access-control-expose-headers') || '', /X-LT-Nt-Read-Id/i);
      return res.headers.get('x-lt-nt-read-id');
    };
    const claim = (who, source, readId, identity) => call(who, 'POST', '/api/nt/body-provenance', {
      connectionIdentity: identity, source, readId,
    });

    let id = await readOnce();
    let identity = (await current(A)).identity;
    let res = await claim(A, 'source-a', id, identity);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.first, true);

    // The same receipt cannot be presented twice.
    res = await claim(A, 'source-a', id, identity);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'read-receipt-missing');

    // The native pull carries the authoritative provenance as its own field,
    // so a phone that only runs pullSnapshot learns it too.
    const pulled = await ok(A, 'GET', '/api/sync/pull?held=1');
    assert.equal(pulled.nt_body_provenance.source, 'source-a');
    assert.equal(pulled.nt_body_provenance.instanceUrl, NT.url('/a'));

    // Another account cannot use a valid receipt of this one.
    const foreignId = await readOnce();
    await ok(B, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });
    res = await claim(B, 'source-a', foreignId, (await current(B)).identity);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'read-receipt-missing');

    // A different source needs a new read, and the fixed claim refuses it.
    const second = await claim(A, 'source-b', await readOnce(), identity);
    assert.equal(second.status, 409);
    assert.equal(second.data.code, 'source-provenance-conflict');

    // A receipt from before a token rotation (same NT user, new fingerprint
    // and version) cannot be attributed to the connection now saved.
    const beforeRotation = await readOnce();
    await ok(A, 'PUT', '/api/nt/federation-connection', {
      url: NT.url('/a'), token: 'token-a2', enabled: true, ifVersion: (await current(A)).version,
    });
    res = await claim(A, 'source-a', beforeRotation, (await current(A)).identity);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'read-identity-mismatch');

    // A receipt lives in memory: a restart refuses it (fail closed).
    id = await readOnce();
    await stop();
    await boot();
    identity = (await current(A)).identity;
    res = await claim(A, 'source-a', id, identity);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'read-receipt-missing');

    // It also expires.
    const shortLived = await readOnce();
    await sleep(1200);
    res = await claim(A, 'source-a', shortLived, (await current(A)).identity);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'read-receipt-missing');

    // Clear Data deletes the imported history and releases the claim, so a
    // different source can be chosen afterwards. It also deletes the throttle
    // on the server and the pull carries the absence.
    await ok(A, 'PUT', '/api/settings', { key: 'ntBodyLastSyncAt', value: Date.now() });
    await ok(A, 'DELETE', '/api/settings/clear-data');
    const settings = await ok(A, 'GET', '/api/settings');
    assert.equal('ntBodyLastSyncAt' in settings, false, 'Clear Data clears the throttle on the server');
    const pull = await ok(A, 'GET', '/api/sync/pull?held=1');
    assert.equal(pull.nt_body_provenance, null, 'the pull carries the released claim as null');

    res = await claim(A, 'source-b', await readOnce(), (await current(A)).identity);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.first, true);
    assert.equal(res.data.provenance.source, 'source-b');
  } finally {
    NT?.close();
    await stop();
    rmSync(dirPath, { recursive: true, force: true });
  }
});

test('NutriTrace answers are bounded: a slow body and an oversized body both fail', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-limits-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();
    await ok(A, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });

    NT.state.bodyMode = 'slow';
    const started = Date.now();
    let res = await call(A, 'GET', '/api/nt/body-composition');
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    assert.match(String(res.data.error), /answer in time/i);
    assert.ok(elapsed < 3000, `the deadline covers the body, not just headers (took ${elapsed} ms)`);

    NT.state.bodyMode = 'large';
    NT.state.bodyBytes = 200000;
    res = await call(A, 'GET', '/api/nt/body-composition');
    assert.equal(res.status, 502);
    assert.match(String(res.data.error), /too large/i);
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable NutriTrace leaves the saved connection untouched and never echoes the token', { skip: ready ? false : 'no server dependencies' }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'lt-nt-errors-'));
  NT = await fakeNt();
  try {
    await boot();
    await signIn();
    await ok(A, 'PUT', '/api/nt/federation-connection', { url: NT.url('/a'), token: 'token-a', enabled: true });
    const before = await current(A);

    const res = await save(A, { url: 'http://127.0.0.1:1', token: 'never-sent', enabled: true });
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'nt-unreachable');
    assert.doesNotMatch(JSON.stringify(res.data), /never-sent/, 'the token is never echoed');

    const after = await current(A);
    assert.equal(after.url, before.url);
    assert.equal(after.version, before.version);

    // The check route names NutriTrace's error and not the token either.
    const tested = await call(A, 'POST', '/api/nt/test', { url: NT.url('/a'), token: 'secret-token-value' });
    assert.equal(tested.data.ok, false);
    assert.match(String(tested.data.error), /401/);
    assert.doesNotMatch(JSON.stringify(tested.data), /secret-token-value/);
  } finally {
    NT?.close();
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
