/**
 * DELETE /api/settings (an API client; the app's own Clear All Settings
 * sets defaults instead) is a reset the account's phones
 * learn of (db.js keeps it in sync_deletions, the pull carries it). A change
 * of a reset setting that reaches the server afterwards is judged against
 * it, as an edit of a deleted row is (lib/deleted-rows.js resetWins):
 *
 * - made before the reset, or in its second (X-Edited-At, a phone's queued
 *   change): it stays reset, and the reset is still what the pull says;
 * - pushed with no readable time (POST /api/sync/push, a third-party
 *   client): it stays reset;
 * - made after it, or now (the web, no X-Edited-At): set again.
 *
 * Before: any change after the reset wrote the old value back, and the
 * reset vanished from the pull. Against the real server on a scratch database.
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
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';

test('a change of a reset setting is judged against the reset', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-settings-reset-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'settings-reset-test-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  let tok = null;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text();
    assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 150)}`);
    return t ? JSON.parse(t) : null;
  };
  try {
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    await call('POST', '/api/auth/register', { username: 'sam', password: PW });
    tok = (await call('POST', '/api/auth/login', { username: 'sam', password: PW })).token;
    for (const key of ['restDuration', 'weightUnit', 'restAutoStart', 'barWeight']) await call('PUT', '/api/settings', { key, value: 1 });
    const since = new Date(Date.now() - 1000).toISOString();
    const before = new Date(Date.now() - 500).toISOString();
    await sleep(1100);
    await call('DELETE', '/api/settings');
    await sleep(1100);
    const after = new Date().toISOString();
    const resets = async () => (await call('GET', `/api/sync/pull?since=${encodeURIComponent(since)}`)).user_settings.filter((s) => s.deleted_at).map((s) => s.key).sort();
    assert.deepEqual(await resets(), ['barWeight', 'restAutoStart', 'restDuration', 'weightUnit'], 'the pull says each was reset');

    assert.deepEqual(await call('PUT', '/api/settings', { key: 'restDuration', value: 150 }, { 'X-Edited-At': before }), { ok: true, value: null, reset: true }, 'a queued change made before the reset');
    await call('POST', '/api/sync/push', { user_settings: [{ key: 'weightUnit', value: '"kg"' }] });
    await call('PUT', '/api/settings', { key: 'restAutoStart', value: false }, { 'X-Edited-At': after });
    await call('PUT', '/api/settings', { key: 'barWeight', value: 20 });

    assert.deepEqual(await call('GET', '/api/settings'), { restAutoStart: false, barWeight: 20 }, 'made before the reset, or with no time: reset; after it, or now: set');
    assert.deepEqual(await resets(), ['restDuration', 'weightUnit'], 'and the pull still says those two were reset');
    await call('POST', '/api/sync/push', { user_settings: [{ key: 'weightUnit', value: '"kg"', updated_at: after }] });
    assert.equal((await call('GET', '/api/settings')).weightUnit, 'kg', 'a push made after the reset sets it again');
  } finally {
    if (proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
    rmSync(dir, { recursive: true, force: true });
  }
});
