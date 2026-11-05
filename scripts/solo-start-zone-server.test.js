/**
 * Without accounts, a program followed from before starts were kept gets one
 * from the first workout from its days (server/lib/solo-program.js
 * _backfillStart), never one ahead of today. "Today" there was UTC's
 * (SQLite date('now')); it is now the server's own day, the zone the server
 * uses for anyone whose app hasn't said one (lib/user-zone.js zoneFor,
 * which without an account is always the server's).
 *
 * A server whose zone is ahead of UTC refused a workout logged on its own
 * today as "ahead of today"; one behind UTC took a workout dated its
 * tomorrow. Two servers 25 hours apart: at any hour at least one of them has
 * a day UTC doesn't, so the UTC rule fails one of the two checks.
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
const skip = !Database && 'server packages missing';
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));
const AHEAD = 'Pacific/Kiritimati', BEHIND = 'Pacific/Pago_Pago';
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const ALL = `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`;

// A server in `zone` without accounts, following a program with one workout
// from its days on `workoutDay`, and no start kept (as before #121).
async function startOf(zone, workoutDay) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-solo-zone-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: { ...cleanEnv(), TZ: zone, PORT: String(port), DB_PATH: join(dir, 'lt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'solo-zone-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
    }
    const j = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 150)}`);
      return t ? JSON.parse(t) : null;
    };
    const p = await j('POST', '/api/programs', { name: 'Solo Block' });
    const day = await j('POST', '/api/templates', { program_id: p.id, name: 'Day A', exercises: [] });
    await j('POST', `/api/programs/${p.id}/activate`);
    await j('PUT', `/api/workout/${workoutDay}`, { name: 'Day A', template_id: day.id, program_id: p.id, completed: true, exercises: [{ uuid: 'e1', exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: 's1', weight: 60, reps: 5, completed: true }] }] });
    // Followed from before starts were kept.
    const db = new Database(join(dir, 'lt.db'));
    try { db.prepare("DELETE FROM app_config WHERE key = 'active_program_start'").run(); } finally { db.close(); }
    return (await j('GET', ALL)).solo_active?.started_at ?? null;
  } finally {
    if (proc.exitCode == null && proc.signalCode == null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a server ahead of UTC: a workout on the server's today is a fair start", { skip }, async () => {
  const today = dayIn(AHEAD);
  assert.equal(await startOf(AHEAD, today), today);
});

test("a server behind UTC: a workout dated the server's tomorrow is not, the start is now", { skip }, async () => {
  const started = await startOf(BEHIND, shift(dayIn(BEHIND), 1));
  assert.match(String(started), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `a time now, not the day ahead: ${started}`);
});
