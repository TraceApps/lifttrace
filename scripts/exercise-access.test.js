/**
 * An access audit after cooktrace#110: GET /api/exercises/:id answered any
 * exercise by its id, so a member could read another member's private
 * custom exercise by counting. It now follows the rule logging a set uses.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'exercise-access-secret-xx-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  return { base, stop: () => new Promise(r => { proc.on('exit', r); proc.kill(); }) };
}




test("another member's private exercise can't be read by its id", { skip, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-exercise-access-'));
  const srv = await boot(dir);
  try {
    const call = async (method, path, body, jwt) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(jwt ? { Cookie: `lt_token=${jwt}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const login = async (username, password, adminJwt) => {
      const reg = await fetch(srv.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(adminJwt ? { Cookie: `lt_token=${adminJwt}` } : {}) }, body: JSON.stringify({ username, password }) });
      assert.ok(reg.status < 300, `register ${username}: ${reg.status}`);
      const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return l.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    };
    const admin = await login('coach', 'Str0ng-Pass-88!y');
    const ana = await login('ana', 'Str0ng-Pass-77!z', admin);
    const ben = await login('ben', 'Str0ng-Pass-66!q', admin);
    const made = await call('POST', '/api/exercises', { name: 'Ana Secret Press', category: 'strength', instructions: 'private cue' }, ana);
    assert.ok(made.status < 300 && made.body?.id, `create: ${made.status} ${JSON.stringify(made.body)}`);
    const id = made.body.id;
    // Its maker reads it; another member gets 404, as if it didn't exist.
    assert.equal((await call('GET', `/api/exercises/${id}`, null, ana)).status, 200);
    const other = await call('GET', `/api/exercises/${id}`, null, ben);
    assert.equal(other.status, 404);
    assert.ok(!JSON.stringify(other.body).includes('private cue'));
    assert.equal((await call('GET', `/api/exercises/${id + 1000}`, null, ben)).status, 404);
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the media list for offline caching leaves out other members' exercises", () => {
  const src = readFileSync(new URL('../server/routes/exercises.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("router.get('/media-urls'"));
  assert.match(route.slice(0, route.indexOf('\n}));')), /AND \(is_global = 1 OR created_by = \?\)/);
});
