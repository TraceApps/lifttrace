/**
 * No row keeps a picture as a data URL.
 *
 * The REST routes turn an embedded picture into a file (image-localizer.js),
 * but POST /api/sync/push stored exercise pictures and progress photos
 * exactly as they came, data URLs and all. The push now converts them the
 * same way, and every startup converts the ones already stored
 * (lib/img-url-migration.js).
 *
 * The repair runs in this process on its own database; the push runs against
 * a real server started from server/index.js, as is the startup wiring.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

// 1x1 PNG, a real image the magic-byte check accepts.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_B64}`;
// Says it's a PNG; isn't one.
const NOT_PNG = `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`;

let Database = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  Database = req('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies';

const work = mkdtempSync(join(tmpdir(), 'lt-inline-img-'));
const UPLOADS = join(work, 'uploads');
process.env.DB_PATH = join(work, 'repair.db');
process.env.UPLOADS_PATH = UPLOADS;
const db = Database ? (await import('../server/db.js')).default : null;
const { migrateDataUrlImages } = Database ? await import('../server/lib/img-url-migration.js') : {};
test.after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* still open */ } });

const fileOf = (url) => join(UPLOADS, url.slice('/uploads/'.length));
const isPng = (url) => typeof url === 'string' && /^\/uploads\//.test(url) && readFileSync(fileOf(url)).equals(Buffer.from(PNG_B64, 'base64'));

function exercise(fields = {}) {
  const f = { name: 'Press', img_url: null, gif_url: null, deleted_at: null, field_times: null, ...fields };
  return Number(db.prepare(`INSERT INTO exercises (name, img_url, gif_url, deleted_at, field_times, source, is_global, updated_at)
    VALUES (?, ?, ?, ?, ?, 'custom', 0, '2026-01-01 00:00:00')`).run(f.name, f.img_url, f.gif_url, f.deleted_at, f.field_times).lastInsertRowid);
}
const row = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

test('startup repair: inline exercise pictures, progress photos and avatars become files', { skip }, async () => {
  const times = JSON.stringify({ _base: '2026-01-01T00:00:00.000Z', img_url: '2026-01-02T00:00:00.000Z' });
  const ex = exercise({ img_url: PNG, gif_url: PNG, field_times: times });
  const u = Number(db.prepare("INSERT INTO users (username, password_hash, avatar_url) VALUES ('a1', 'x', ?)").run(PNG).lastInsertRowid);
  const ph = Number(db.prepare("INSERT INTO body_stat_media (user_id, date, kind, url) VALUES (?, '2026-01-01', 'photo', ?)").run(u, PNG).lastInsertRowid);
  const r = await migrateDataUrlImages();
  assert.ok(r.migrated >= 4, JSON.stringify(r));
  const e = row('exercises', ex);
  assert.ok(isPng(e.img_url) && isPng(e.gif_url), 'both pictures are files holding the same bytes');
  assert.equal(e.field_times, times, 'not an edit: field_times stays');
  assert.notEqual(e.updated_at, '2026-01-01 00:00:00', 'updated_at moves, so the next pull carries the new path');
  assert.ok(isPng(row('users', u).avatar_url));
  const photo = row('body_stat_media', ph).url;
  assert.match(photo, /^\/uploads\/body-stats\//, 'a progress photo goes where only its owner can read it');
  assert.ok(isPng(photo));
});

test('startup repair: deleted rows are skipped, and other addresses are never fetched again', { skip }, async () => {
  const gone = exercise({ img_url: PNG, deleted_at: '2026-01-03 00:00:00' });
  const remote = exercise({ img_url: 'https://example.com/a.png', gif_url: '/uploads/old.gif' });
  // A type the REST routes keep as it is: left alone, and no failure.
  const svg = exercise({ img_url: 'data:image/svg+xml;base64,PHN2Zy8+' });
  const r = await migrateDataUrlImages();
  assert.equal(r.failed, 0, JSON.stringify(r));
  assert.equal(row('exercises', svg).img_url, 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(row('exercises', svg).updated_at, '2026-01-01 00:00:00');
  assert.equal(row('exercises', gone).img_url, PNG);
  assert.equal(row('exercises', gone).updated_at, '2026-01-01 00:00:00', 'not sent to every phone again');
  assert.equal(row('exercises', remote).img_url, 'https://example.com/a.png');
  assert.equal(row('exercises', remote).gif_url, '/uploads/old.gif');
  assert.equal(row('exercises', remote).updated_at, '2026-01-01 00:00:00');
  db.prepare('DELETE FROM exercises WHERE id IN (?, ?)').run(gone, svg);
});

test('startup repair: an edit made while it runs is kept', { skip }, async () => {
  const ex = exercise({ img_url: PNG });
  const running = migrateDataUrlImages();
  // The rows are read; this edit lands before this one is converted.
  db.prepare("UPDATE exercises SET img_url = '/uploads/new.png' WHERE id = ?").run(ex);
  await running;
  assert.equal(row('exercises', ex).img_url, '/uploads/new.png');
});

test('startup repair: a picture that fails is counted, left as it is, and tried again next startup', { skip }, async () => {
  const bad = exercise({ img_url: NOT_PNG });
  const later = exercise({ img_url: PNG });
  // Uploads can't be written (a file where the directory should be).
  const blocked = join(work, 'blocked');
  writeFileSync(blocked, '');
  process.env.UPLOADS_PATH = join(blocked, 'uploads');
  let r;
  try { r = await migrateDataUrlImages(); } finally { process.env.UPLOADS_PATH = UPLOADS; }
  assert.equal(r.failed, 2, JSON.stringify(r));
  assert.equal(r.migrated, 0);
  assert.equal(row('exercises', later).img_url, PNG, 'left as it was');
  r = await migrateDataUrlImages();
  assert.ok(isPng(row('exercises', later).img_url), 'stored on the next startup');
  assert.equal(r.failed, 1, 'not an image: refused again, every time');
  assert.equal(row('exercises', bad).img_url, NOT_PNG);
  db.prepare('DELETE FROM exercises WHERE id = ?').run(bad);
});

// ── the push, on a real server ──────────────────────────────────────────

const SECRET = 'inline-images-test-secret-0123456789abcdef';
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});
const procs = new Set();
test.after(() => { for (const p of procs) try { p.kill('SIGKILL'); } catch { /* gone */ } });
process.on('exit', () => { for (const p of procs) try { p.kill('SIGKILL'); } catch { /* gone */ } });

async function startServer(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET: SECRET, INSECURE_COOKIES: '1', UPDATE_CHECK: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.add(proc);
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { await fetch(base + '/api/auth/me', { signal: AbortSignal.timeout(5000) }); break; } catch { /* not yet */ }
    if (proc.exitCode != null || Date.now() - t0 > 120000) throw new Error('server did not start: ' + errors.slice(-500));
    await new Promise(r => setTimeout(r, 100));
  }
  const call = async (token, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const stop = () => new Promise(res => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
  return { call, stop };
}

test('the sync push stores embedded pictures as files, only where it writes', { skip, timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(work, 'srv-'));
  const srv = await startServer(dir);
  const sdb = () => new Database(join(dir, 'app.db'), { readonly: true });
  const file = (url) => join(dir, 'uploads', url.slice('/uploads/'.length));
  const png = (url) => typeof url === 'string' && url.startsWith('/uploads/') && readFileSync(file(url)).equals(Buffer.from(PNG_B64, 'base64'));
  try {
    const admin = await srv.call(null, 'POST', '/api/auth/register', { username: 'alice', password: 'Str0ng-Pass-77!x' });
    await srv.call(admin.token, 'POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-88!y', role: 'member' });
    const bob = await srv.call(null, 'POST', '/api/auth/login', { username: 'bob', password: 'Str0ng-Pass-88!y' });

    // New rows: an exercise and a progress photo.
    let r = await srv.call(bob.token, 'POST', '/api/sync/push', {
      exercises: [{ client_id: -1, name: 'Inline Press', img_url: PNG, gif_url: PNG }],
      body_stat_media: [{ client_id: -2, date: '2026-10-09', url: PNG }],
    });
    const exId = r.exercises[0].server_id;
    let d = sdb();
    let e = d.prepare('SELECT * FROM exercises WHERE id = ?').get(exId);
    assert.ok(png(e.img_url) && png(e.gif_url), `exercise pictures are files: ${String(e.img_url).slice(0, 40)}`);
    const photo = d.prepare('SELECT url FROM body_stat_media WHERE id = ?').get(r.body_stat_media[0].server_id).url;
    assert.match(photo, /^\/uploads\/body-stats\//);
    assert.ok(png(photo));
    d.close();

    // An edit of an exercise this account owns.
    await srv.call(bob.token, 'POST', '/api/sync/push', {
      exercises: [{ client_id: exId, server_id: exId, name: 'Inline Press', img_url: PNG, gif_url: e.gif_url, updated_at: new Date(Date.now() + 2000).toISOString() }],
    });
    d = sdb();
    const edited = d.prepare('SELECT * FROM exercises WHERE id = ?').get(exId);
    assert.ok(png(edited.img_url));
    assert.notEqual(edited.img_url, e.img_url, 'the new picture');
    assert.equal(edited.gif_url, e.gif_url, 'a path comes back as it went');
    d.close();

    // Someone else's exercise: refused as before, and nothing is written.
    const theirs = await srv.call(admin.token, 'POST', '/api/exercises', { name: 'Alice Row' });
    const before = readdirSync(join(dir, 'uploads')).length;
    await srv.call(bob.token, 'POST', '/api/sync/push', {
      exercises: [{ client_id: theirs.id, server_id: theirs.id, name: 'Bob Was Here', img_url: PNG, updated_at: new Date(Date.now() + 2000).toISOString() }],
    });
    d = sdb();
    const t = d.prepare('SELECT name, img_url FROM exercises WHERE id = ?').get(theirs.id);
    assert.deepEqual({ ...t }, { name: 'Alice Row', img_url: null });
    d.close();
    assert.equal(readdirSync(join(dir, 'uploads')).length, before, 'no file for a refused row');

    // Not an image: the batch still goes through, without that picture.
    r = await srv.call(bob.token, 'POST', '/api/sync/push', {
      exercises: [
        { client_id: -3, name: 'Bad Picture', img_url: NOT_PNG },
        { client_id: exId, server_id: exId, name: 'Inline Press 2', img_url: NOT_PNG, gif_url: edited.gif_url, updated_at: new Date(Date.now() + 4000).toISOString() },
      ],
      body_stat_media: [{ client_id: -4, date: '2026-10-09', url: NOT_PNG }],
    });
    d = sdb();
    assert.equal(d.prepare('SELECT img_url FROM exercises WHERE id = ?').get(r.exercises[0].server_id).img_url, null);
    const kept = d.prepare('SELECT name, img_url FROM exercises WHERE id = ?').get(exId);
    assert.equal(kept.name, 'Inline Press 2', 'the rest of the edit goes in');
    assert.equal(kept.img_url, edited.img_url, 'the picture it had stays');
    assert.equal(r.body_stat_media.length, 0, 'a photo that is not one is not stored');
    assert.equal(d.prepare("SELECT COUNT(*) c FROM exercises WHERE img_url LIKE 'data:%' OR gif_url LIKE 'data:%'").get().c, 0);
    assert.equal(d.prepare("SELECT COUNT(*) c FROM body_stat_media WHERE url LIKE 'data:%'").get().c, 0);
    d.close();

    // Rows an older version left inline are repaired when the server starts.
    await srv.stop();
    const w = new Database(join(dir, 'app.db'));
    const legacy = Number(w.prepare("INSERT INTO exercises (name, img_url, source, is_global, created_by) VALUES ('Legacy', ?, 'custom', 0, 2)").run(PNG).lastInsertRowid);
    w.close();
    const again = await startServer(dir);
    try {
      let url;
      for (let i = 0; i < 100; i++) {
        d = sdb(); url = d.prepare('SELECT img_url FROM exercises WHERE id = ?').get(legacy).img_url; d.close();
        if (!url.startsWith('data:')) break;
        await new Promise(res => setTimeout(res, 100));
      }
      assert.ok(png(url), `repaired after startup: ${url.slice(0, 40)}`);
    } finally { await again.stop(); }
  } finally {
    await srv.stop();
  }
});
