/**
 * Only LiftTrace's own pages may frame it: every answer from the real server
 * (server/index.js on a scratch database) carries X-Frame-Options SAMEORIGIN
 * and CSP frame-ancestors 'self', so another site can't load the app in a
 * hidden frame to trick a click. Before, the server sent neither.
 * FRAME_ANCESTORS adds addresses that may (a dashboard that embeds it).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lifttrace-framing-'));
  const port = await freePort();
  // One public upload, to see the sandboxed upload route's own policy.
  mkdirSync(join(dir, 'uploads'), { recursive: true });
  writeFileSync(join(dir, 'uploads', 'frame-test.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]])), PORT: String(port), DB_PATH: join(dir, 'lifttrace.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'framing-test-0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', ...env },
    stdio: 'ignore',
  });
  servers.push({ proc, dir });
  const base = (env.BASE_URL || '').replace(/\/$/, '');
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${base}/api/health`)).ok) return `http://127.0.0.1:${port}${base}`; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
test.after(() => { for (const s of servers) { s.proc.kill(); rmSync(s.dir, { recursive: true, force: true }); } });

function framedOnlyBySelf(res, what) {
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', `${what}: X-Frame-Options`);
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/, `${what}: frame-ancestors`);
}

test('every answer says only LiftTrace may frame it: the page, the app\'s routes, the API', { skip: !ready && 'server packages missing' }, async () => {
  const base = await start();
  for (const path of ['/', '/reset-password', '/api/health', '/api/auth/status', '/api/auth/me']) {
    framedOnlyBySelf(await fetch(base + path), path);
  }
  // A request that fails still says it, a body refused before any route included.
  framedOnlyBySelf(await fetch(`${base}/api/workout/recent`), 'a refused API call');
  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  framedOnlyBySelf(bad, 'a malformed JSON body');
  // An upload keeps its own sandbox policy, with the framing rule in it.
  const up = await fetch(`${base}/uploads/frame-test.png`);
  assert.equal(up.status, 200);
  assert.equal(up.headers.get('content-security-policy'), "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'");
  assert.equal(up.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('the same under a subpath (BASE_URL)', { skip: !ready && 'server packages missing' }, async () => {
  const base = await start({ BASE_URL: '/lifttrace' });
  framedOnlyBySelf(await fetch(`${base}/`), 'the page under /lifttrace');
  framedOnlyBySelf(await fetch(`${base}/api/health`), 'the API under /lifttrace');
});

test('FRAME_ANCESTORS lets a dashboard frame it: the CSP names it, and X-Frame-Options (which can name no other site) is left off', { skip: !ready && 'server packages missing' }, async () => {
  const base = await start({ FRAME_ANCESTORS: 'https://home.example.com, *' });
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self' https://home.example.com");
  assert.equal(res.headers.get('x-frame-options'), null);
  const up = await fetch(`${base}/uploads/frame-test.png`);
  assert.match(up.headers.get('content-security-policy'), /; sandbox; frame-ancestors 'self' https:\/\/home\.example\.com$/);
});
