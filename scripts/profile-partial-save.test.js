/**
 * Saving a profile keeps the fields the request leaves out
 * (TraceApps/nutritrace#269). The first-run setup sends only gender and
 * birthday, right after registering with a name and email; those were wiped.
 * Real route over a scratch database; skipped where better-sqlite3 isn't
 * built for this Node.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test, { mock } from 'node:test';

// The sign-in limiter's cleanup timer would keep this run open.
mock.timers.enable({ apis: ['setInterval'] });

let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'profile-partial-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: authRoutes } = await import('../server/routes/auth.js');
  const app = express();
  app.use(express.json());
  // what requireAuth leaves behind: the signed-in account, picked per request here
  app.use((r, _res, next) => { r.user = { id: Number(r.headers['x-user']), role: 'admin' }; next(); });
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const user = () => Number(db.prepare('INSERT INTO users (username, password_hash, full_name, email, nickname) VALUES (?, ?, ?, ?, ?)')
  .run('u' + Math.random(), 'x', 'Alex Doe', 'alex@example.com', 'Lex').lastInsertRowid);
const row = (u) => db.prepare('SELECT full_name, nickname, email, birthday, gender FROM users WHERE id = ?').get(u);
const put = (u, body) => fetch(`${base}/api/auth/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user': String(u) }, body: JSON.stringify(body) }).then(r => r.json());

test('a save naming only some fields keeps the others', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user();
  // What the first-run setup sends.
  await put(me, { gender: 'female', birthday: '1990-04-02' });
  assert.deepEqual(row(me), { full_name: 'Alex Doe', nickname: 'Lex', email: 'alex@example.com', birthday: '1990-04-02', gender: 'female' });
});

test('Profile sends every field, and an empty one still clears it', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user();
  await put(me, { full_name: 'Alex Doe', nickname: '', email: '', birthday: '', gender: '', avatar_url: '' });
  assert.deepEqual(row(me), { full_name: 'Alex Doe', nickname: null, email: null, birthday: null, gender: null });
});
