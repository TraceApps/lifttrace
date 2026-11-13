/**
 * TraceApps/cooktrace#92: the secrets people keep in their settings, on a real server. Every one
 * is stored encrypted; the ones only the server uses (the NutriTrace
 * federation token, the ntfy and Gotify tokens) are never sent back, only
 * said to be set, and saving that placeholder (from the page, the bulk save
 * or a phone's sync) leaves the secret as it is. The server still uses the
 * real token, a secret saved in the clear before is encrypted when the
 * server starts, and a backup restored from before is encrypted too.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const SET = '••••••••';
const PW = 'Str0ng-Pass-88!y';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, port) {
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'lt-secret-settings-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill('SIGKILL'); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  const stop = () => new Promise(r => {
    if (proc.exitCode != null || proc.signalCode != null) return r();
    proc.once('exit', r); proc.kill('SIGKILL');
  });
  return { base, stop };
}

// A NutriTrace (its /api/v1/me) and an ntfy that say which token they were sent.
function services() {
  const seen = [];
  return new Promise(res => {
    const s = httpServer((req, r) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      if (req.url === '/api/v1/me') {
        const ok = req.headers.authorization === 'Bearer nt-token-123';
        r.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        // NutriTrace's /api/v1/me names its own instance URL and the token
        // owner's id; the federation check stores that pair as the connection
        // identity the body-composition import is bound to. A stub missing
        // them is not the real /api/v1/me contract.
        r.end(JSON.stringify(ok
          ? {
            user: { id: 1, username: 'pat' },
            instance: { url: `http://${req.headers.host}` },
            scopes: ['write:workouts'],
          }
          : { error: 'no' }));
        return;
      }
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{}');
    });
    s.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() }));
  });
}

test('secrets in settings: encrypted, server-only ones never sent back, placeholder keeps them', { skip, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-secrets-'));
  const port = await freePort();
  const svc = await services();
  let srv = await boot(dir, port);
  try {
    const call = async (method, path, body, tok) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    await call('POST', '/api/auth/register', { username: 'cook', password: PW });
    const tok = (await call('POST', '/api/auth/login', { username: 'cook', password: PW })).token;
    const as = (method, path, body) => call(method, path, body, tok);
    const stored = key => {
      const db = new Database(join(dir, 'app.db'), { readonly: true });
      try { return db.prepare('SELECT value FROM user_settings WHERE key = ?').get(key)?.value ?? null; } finally { db.close(); }
    };

    // Saved: the server-only token is said to be set; the AI key, which the
    // browser calls the provider with, comes back. Both stored encrypted.
    await as('PUT', '/api/settings', { key: 'ntInstanceUrl', value: svc.base });
    await as('PUT', '/api/settings', { key: 'ntInstanceToken', value: 'nt-token-123' });
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: 'sk-test-456' });
    await as('PUT', '/api/settings', { key: 'aiModel', value: 'some-model' });
    let got = await as('GET', '/api/settings');
    assert.equal(got.ntInstanceToken, SET, 'never sent back');
    assert.equal(got.aiApiKey, 'sk-test-456', 'the app still has the key it uses itself');
    assert.equal(got.aiModel, 'some-model', 'other settings as they were');
    for (const [key, plain] of [['ntInstanceToken', 'nt-token-123'], ['aiApiKey', 'sk-test-456']]) {
      const v = stored(key);
      assert.match(JSON.parse(v), /^enc:v1:/, `${key} stored encrypted`);
      assert.ok(!v.includes(plain), `${key} not in the clear`);
    }
    assert.equal(stored('aiModel'), '"some-model"', 'not a secret: stored as before');

    // The placeholder sent back changes nothing; the same key again is no change.
    const before = stored('ntInstanceToken');
    await as('PUT', '/api/settings', { key: 'ntInstanceToken', value: SET });
    assert.equal(stored('ntInstanceToken'), before);
    const aiBefore = stored('aiApiKey');
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: 'sk-test-456' });
    assert.equal(stored('aiApiKey'), aiBefore, 'same key, same stored value');
    // Something already encrypted is never taken from an app: else anyone
    // with an account could have the server read out a leaked backup.
    const sealedOther = JSON.parse(stored('ntInstanceToken'));
    await as('PUT', '/api/settings', { key: 'aiApiKey', value: sealedOther });
    assert.equal(stored('aiApiKey'), aiBefore, 'a sealed value sent in is refused');
    assert.equal((await as('GET', '/api/settings')).aiApiKey, 'sk-test-456');

    // The server uses the real token: Test with the page's placeholder.
    const t1 = await as('POST', '/api/nt/test', { url: svc.base, token: SET });
    assert.equal(t1.ok, true, JSON.stringify(t1));
    assert.equal(svc.seen.at(-1).auth, 'Bearer nt-token-123');
    // A new token typed in is tested as typed.
    const t2 = await as('POST', '/api/nt/test', { url: svc.base, token: 'typed-new' });
    assert.equal(t2.ok, false);
    assert.equal(svc.seen.at(-1).auth, 'Bearer typed-new');
    // The saved token never goes to an address other than its own.
    const seenBefore = svc.seen.length;
    const other = await call('POST', '/api/nt/test', { url: 'http://127.0.0.1:9/other', token: SET }, tok).catch(e => e.message);
    assert.match(String(other), /400.*Enter the access token again/);
    assert.equal(svc.seen.length, seenBefore, 'nothing was sent anywhere');

    // ntfy: a new token encrypted, never sent back, and sent by the server.
    await as('PUT', '/api/settings', { key: 'ntfyUrl', value: svc.base });
    await as('PUT', '/api/settings', { key: 'ntfyTopic', value: 'kitchen' });
    await as('PUT', '/api/settings', { key: 'ntfyToken', value: 'tk_ntfy' });
    // The music server password: the app uses it, so it comes back.
    await as('PUT', '/api/settings', { key: 'radioPassword', value: 'music-pw' });
    got = await as('GET', '/api/settings');
    assert.equal(got.ntfyToken, SET);
    assert.equal(got.radioPassword, 'music-pw');
    assert.match(JSON.parse(stored('ntfyToken')), /^enc:v1:/);
    assert.match(JSON.parse(stored('radioPassword')), /^enc:v1:/);
    // The save answers with what the app is to show, never the token.
    const put = await as('PUT', '/api/settings', { key: 'gotifyToken', value: 'gt-first' });
    assert.equal(put.value, SET);
    await as('POST', '/api/settings/push-test', { service: 'ntfy' });
    assert.deepEqual(svc.seen.at(-1), { url: '/kitchen', auth: 'Bearer tk_ntfy' });

    // A phone's sync: pulled, the server-only tokens are placeholders and the
    // AI key is the key; pushed back unchanged, nothing changes; a new token
    // pushed is stored encrypted.
    const pull = await as('GET', '/api/sync/pull');
    const pulled = Object.fromEntries(pull.user_settings.map(s => [s.key, JSON.parse(s.value)]));
    assert.equal(pulled.ntInstanceToken, SET);
    assert.equal(pulled.ntfyToken, SET);
    assert.equal(pulled.aiApiKey, 'sk-test-456');
    const ntBefore = stored('ntInstanceToken');
    const now = new Date().toISOString();
    await as('POST', '/api/sync/push', { client_now: now, user_settings: [
      { key: 'ntInstanceToken', value: JSON.stringify(SET), updated_at: now },
      { key: 'gotifyToken', value: JSON.stringify('gt-789'), updated_at: now },
    ] });
    assert.equal(stored('ntInstanceToken'), ntBefore, 'the placeholder pushed back leaves the token');
    assert.match(JSON.parse(stored('gotifyToken')), /^enc:v1:/);
    assert.ok(!stored('gotifyToken').includes('gt-789'));
    assert.equal((await as('GET', '/api/settings')).gotifyToken, SET);

    // Cleared: an empty token is no token.
    await as('PUT', '/api/settings', { key: 'ntfyToken', value: '' });
    assert.equal(stored('ntfyToken'), '""');
    assert.equal((await as('GET', '/api/settings')).ntfyToken, '');

    // Saved in the clear before this: encrypted when the server starts, and
    // still the same token to the server and the app.
    await srv.stop();
    const db = new Database(join(dir, 'app.db'));
    db.prepare(`UPDATE user_settings SET value = ? WHERE key = 'ntInstanceToken'`).run(JSON.stringify('nt-token-123'));
    db.prepare(`UPDATE user_settings SET value = ? WHERE key = 'aiApiKey'`).run(JSON.stringify('sk-old-plain'));
    db.close();
    srv = await boot(dir, port);
    for (let i = 0; i < 50 && !String(stored('aiApiKey')).includes('enc:v1:'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(JSON.parse(stored('ntInstanceToken')), /^enc:v1:/, 'sealed at start');
    assert.match(JSON.parse(stored('aiApiKey')), /^enc:v1:/, 'sealed at start');
    assert.equal((await as('GET', '/api/settings')).aiApiKey, 'sk-old-plain');
    assert.equal((await as('POST', '/api/nt/test', { url: svc.base, token: SET })).ok, true);
  } finally {
    svc.close();
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup restore, the server readers and the phone sync all go through the secret rules', () => {
  const read = p => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');
  assert.match(read('routes/full-backup.js'), /sealStoredSecrets\(db\)/, 'a restored backup is sealed');
  assert.match(read('index.js'), /sealStoredSecrets\(db\)/, 'sealed at start');
  for (const f of ['lib/push-notify.js', 'lib/scheduler.js', 'routes/subsonic-proxy.js', 'routes/nt-federation.js', 'routes/settings.js']) {
    const src = read(f);
    assert.match(src, /readSettingRaw\(key, /, `${f} reads secrets in the clear through readSettingRaw`);
  }
  const sync = read('routes/sync.js');
  assert.match(sync, /clientSettingRaw\(s\.key, s\.value\)/, 'the pull');
  assert.match(sync, /settingToStoreRaw\(s\.key/, 'the push');
});

// The same file in every Trace app (CookTrace, NutriTrace, LiftTrace,
// NoteTrace); each app's keys are its own (secret-setting-keys.js).
test('secret-settings.js matches the hash every Trace app pins', () => {
  const src = readFileSync(new URL('../server/lib/secret-settings.js', import.meta.url));
  assert.equal(createHash('sha256').update(src).digest('hex'), 'b9186d99e01bcef9c7fc18e396db77756c6b36f0bec28d8ac00b8122728cb5b8');
});
