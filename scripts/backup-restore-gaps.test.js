/**
 * What a full backup restore brings back, and what devices learn of it,
 * against the real server on a scratch database:
 *
 * - The order of a day's workouts (session_seq, issue #76).
 * - A coach note's set video, the moment in it, and the exercise it is on
 *   (coach_feedback media_id, media_time_sec, exercise_uuid).
 * - Coach messages, progress photos and set videos reach devices as
 *   restored: a row changed after the backup is sent again as it was, and
 *   one made after the backup is sent as deleted, so no device keeps it.
 *   The same for every table the pull lists rows of.
 * - API tokens, webhooks and pending invites survive the restore.
 * - A backup from before these columns restores.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'restore-gaps-test-0123456789abcdef01234567';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'lt-restore-gaps-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'lt.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_API_ENABLED: '1' });
  s.boot = async () => {
    const port = await freePort();
    s.base = `http://127.0.0.1:${port}`;
    s.proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...s.env(), PORT: String(port) }, stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'] });
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(s.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not start');
  };
  s.stop = async () => { const p = s.proc; s.proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'lt.db'));
  s.sql = (fn) => { const d = s.db(); try { return fn(d); } finally { d.close(); } };
  s.sign = (id, username, role) => serverRequire('jsonwebtoken').sign({ id, username, role }, JWT_SECRET, { expiresIn: '1h' });
  s.setup = async () => {
    await s.boot();
    await s.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
    s.tok.admin = (await s.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    const lifter = (await s.ok('admin', 'POST', '/api/auth/register', { username: 'lifter', password: PW, full_name: 'Lee Lifter', role: 'member' })).user;
    const coach = (await s.ok('admin', 'POST', '/api/auth/register', { username: 'coach', password: PW, full_name: 'Cory Coach', role: 'trainer' })).user;
    s.ids.lifter = lifter.id; s.ids.coach = coach.id;
    s.tok.lifter = s.sign(lifter.id, 'lifter', lifter.role);
    s.tok.coach = s.sign(coach.id, 'coach', coach.role);
  };
  s.backup = async () => (await s.ok('admin', 'POST', '/api/full-backup')).filename;
  s.restore = async (filename) => s.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  // A backup file, its database.json changed by `edit`, restored by upload.
  s.uploadRestore = async (zipPath, edit = () => {}) => {
    const AdmZip = serverRequire('adm-zip');
    const zip = new AdmZip(zipPath);
    const data = JSON.parse(zip.readAsText('database.json'));
    edit(data);
    zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
    const form = new FormData();
    form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(s.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${s.tok.admin}` }, body: form });
    assert.ok(r.ok, await r.text());
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}

const ex = (uuid, sets) => ({ uuid, exercise_id: null, name: 'Bench Press', sets: sets.map((u, i) => ({ uuid: u, reps: 5 + i, weight: 100 })) });

let S;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.setup();
});
test.after(async () => { await S?.close(); });

test("a day's workouts keep their order (session_seq)", { skip }, async () => {
  const u = S.ids.lifter, date = '2026-04-01';
  // Three sessions, their order not the order they were made in (a phone
  // that sends session_seq with a session made offline).
  const ids = S.sql((d) => [2, 0, 1].map((seq, i) => d.prepare(
    `INSERT INTO workout_log (user_id, date, name, exercises, session_seq) VALUES (?, ?, ?, '[]', ?)`,
  ).run(u, date, `Session ${i}`, seq).lastInsertRowid));
  const order = async () => (await S.ok('lifter', 'GET', `/api/workout/${date}/sessions`)).sessions.map((w) => w.name);
  const before = await order();
  assert.deepEqual(before, ['Session 1', 'Session 2', 'Session 0']);
  const filename = await S.backup();
  await S.restore(filename);
  assert.deepEqual(S.sql((d) => ids.map((id) => d.prepare('SELECT session_seq FROM workout_log WHERE id = ?').get(id).session_seq)), [2, 0, 1]);
  assert.deepEqual(await order(), before, 'the same order after the restore');
});

test("a coach note keeps its set video, the moment in it, and its exercise", { skip }, async () => {
  const { lifter, coach } = S.ids;
  const row = S.sql((d) => {
    const w = d.prepare(`INSERT INTO workout_log (user_id, date, name, exercises) VALUES (?, '2026-04-02', 'Video Day', ?)`).run(lifter, JSON.stringify([ex('fe1', ['fs1'])])).lastInsertRowid;
    const m = d.prepare(`INSERT INTO set_media (user_id, workout_id, date, exercise_uuid, set_uuid, url, mime) VALUES (?, ?, '2026-04-02', 'fe1', 'fs1', 'set-media/x.mp4', 'video/mp4')`).run(lifter, w).lastInsertRowid;
    const f = d.prepare(`INSERT INTO coach_feedback (trainer_id, member_id, workout_id, exercise_idx, note, media_id, media_time_sec, exercise_uuid) VALUES (?, ?, ?, 0, 'Knees out at 0:04', ?, 4.5, 'fe1')`).run(coach, lifter, w, m).lastInsertRowid;
    return d.prepare('SELECT id, media_id, media_time_sec, exercise_uuid FROM coach_feedback WHERE id = ?').get(f);
  });
  const filename = await S.backup();
  await S.restore(filename);
  assert.deepEqual(S.sql((d) => d.prepare('SELECT id, media_id, media_time_sec, exercise_uuid FROM coach_feedback WHERE id = ?').get(row.id)), row);
});

// A pairing and its conversation, as the coaching routes keep them.
function pairUp() {
  const { lifter, coach } = S.ids;
  return S.sql((d) => {
    const existing = d.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND client_id = ? AND status = 'active'`).get(coach, lifter);
    if (existing) return existing.id;
    const id = d.prepare(`INSERT INTO coach_clients (coach_id, client_id, status, responded_at) VALUES (?, ?, 'active', datetime('now'))`).run(coach, lifter).lastInsertRowid;
    d.prepare('UPDATE users SET trainer_id = ? WHERE id = ?').run(coach, lifter);
    return id;
  });
}
const say = (pairing, sender, uuid, body) => S.sql((d) => d.prepare(
  `INSERT INTO coach_messages (uuid, pairing_id, sender_id, body) VALUES (?, ?, ?, ?)`,
).run(uuid, pairing, sender, body).lastInsertRowid);

test('coach messages: a phone and the web get the restored conversation', { skip }, async () => {
  const { lifter, coach } = S.ids;
  const pairing = pairUp();
  say(pairing, coach, 'm-kept', 'Good week');
  say(pairing, lifter, 'm-edited', 'Thanks coach');
  await sleep(1100); // a phone's cursor is later than the backup's rows
  const filename = await S.backup();
  // After the backup: one message deleted, one sent.
  await S.ok('lifter', 'DELETE', '/api/coaching/messages/m-edited');
  say(pairing, coach, 'm-after', 'Sent after the backup');
  const pull = async (since) => S.ok('lifter', 'GET', `/api/sync/pull?coaching=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);
  const cursor = (await pull()).server_time;
  const webCursor = (await S.ok('lifter', 'GET', `/api/coaching/pairings/${pairing}/messages`)).server_time;
  await sleep(1100);
  await S.restore(filename);

  const live = S.sql((d) => d.prepare('SELECT uuid, body, deleted_at FROM coach_messages WHERE pairing_id = ? ORDER BY id').all(pairing));
  assert.deepEqual(live.filter((m) => !m.deleted_at).map((m) => m.uuid), ['m-kept', 'm-edited'], 'the server holds the backup');
  for (const got of [(await pull(cursor)).coach_messages, (await S.ok('lifter', 'GET', `/api/coaching/pairings/${pairing}/messages?since=${encodeURIComponent(webCursor)}`)).messages]) {
    const byUuid = Object.fromEntries(got.map((m) => [m.uuid, m]));
    assert.equal(byUuid['m-edited']?.body, 'Thanks coach', 'the message deleted after the backup comes back to the device');
    assert.ok(!byUuid['m-edited'].deleted_at);
    assert.ok(byUuid['m-after'], 'the message sent after the backup reaches the device');
    assert.ok(byUuid['m-after'].deleted_at, 'as deleted');
    assert.equal(byUuid['m-after'].body, null);
  }
  // Read, unread and the conversation itself are as backed up.
  assert.equal((await S.ok('lifter', 'GET', `/api/coaching/pairings/${pairing}/messages`)).messages.filter((m) => !m.deleted_at).length, 2);
});

test('progress photos and set videos: devices get the restored rows', { skip }, async () => {
  const u = S.ids.lifter;
  const [photoKept, clipKept] = S.sql((d) => [
    d.prepare(`INSERT INTO body_stat_media (user_id, date, url, created_at) VALUES (?, '2026-04-03', 'progress/a.jpg', datetime('now'))`).run(u).lastInsertRowid,
    d.prepare(`INSERT INTO set_media (user_id, date, url, created_at) VALUES (?, '2026-04-03', 'set-media/a.mp4', datetime('now'))`).run(u).lastInsertRowid,
  ]);
  await sleep(1100); // a phone's cursor is later than the backup's rows
  const filename = await S.backup();
  // After the backup: the kept ones deleted, new ones added.
  const [photoNew, clipNew] = S.sql((d) => {
    d.prepare(`UPDATE body_stat_media SET deleted_at = datetime('now') WHERE id = ?`).run(photoKept);
    d.prepare(`UPDATE set_media SET deleted_at = datetime('now') WHERE id = ?`).run(clipKept);
    return [
      d.prepare(`INSERT INTO body_stat_media (user_id, date, url, created_at) VALUES (?, '2026-04-04', 'progress/b.jpg', datetime('now'))`).run(u).lastInsertRowid,
      d.prepare(`INSERT INTO set_media (user_id, date, url, created_at) VALUES (?, '2026-04-04', 'set-media/b.mp4', datetime('now'))`).run(u).lastInsertRowid,
    ];
  });
  const cursor = (await S.ok('lifter', 'GET', '/api/sync/pull')).server_time;
  await sleep(1100);
  await S.restore(filename);
  const p = await S.ok('lifter', 'GET', `/api/sync/pull?since=${encodeURIComponent(cursor)}`);
  const find = (list, id) => list.find((r) => r.id === id);
  assert.ok(find(p.body_stat_media, photoKept) && !find(p.body_stat_media, photoKept).deleted_at, 'the photo deleted after the backup comes back to devices');
  assert.ok(find(p.set_media, clipKept) && !find(p.set_media, clipKept).deleted_at, 'the video deleted after the backup comes back to devices');
  assert.ok(find(p.body_stat_media, photoNew)?.deleted_at, 'the photo added after the backup is sent as deleted');
  assert.ok(find(p.set_media, clipNew)?.deleted_at, 'the video added after the backup is sent as deleted');
  // And on the server they are as backed up.
  assert.deepEqual(S.sql((d) => d.prepare('SELECT id FROM body_stat_media WHERE deleted_at IS NULL ORDER BY id').all().map((r) => r.id)), [photoKept]);
  assert.deepEqual(S.sql((d) => d.prepare('SELECT id FROM set_media WHERE deleted_at IS NULL AND date >= ? ORDER BY id').all('2026-04-03').map((r) => r.id)), [clipKept]);
});

test('every row a device pulls that the restore took away is sent as gone', { skip }, async () => {
  const u = S.ids.lifter;
  const filename = await S.backup();
  // Made after the backup, one of each.
  await S.ok('lifter', 'PUT', '/api/workout/2026-04-10', { name: 'After Day', exercises: [ex('ga', ['gs'])] });
  const made = S.sql((d) => {
    const ins = (sql, ...a) => d.prepare(sql).run(...a).lastInsertRowid;
    const prog = ins('INSERT INTO programs (name, created_by) VALUES (?, ?)', 'After Program', u);
    return {
      workout_log: d.prepare(`SELECT id FROM workout_log WHERE date = '2026-04-10'`).get().id,
      exercises: ins('INSERT INTO exercises (name, is_global, created_by) VALUES (?, 0, ?)', 'After Curl', u),
      programs: prog,
      workout_templates: ins('INSERT INTO workout_templates (program_id, name, exercises) VALUES (?, ?, ?)', prog, 'After Day', '[]'),
      program_assignments: ins('INSERT INTO program_assignments (program_id, assigned_to, assigned_by) VALUES (?, ?, ?)', prog, u, u),
      body_stats_log: ins('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)', u, '2026-04-10', '{"weight":81}'),
      ai_chat_history: ins('INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)', u, 'user', 'after'),
      excused_days: ins(`INSERT INTO excused_days (user_id, date, reason) VALUES (?, '2026-04-11', 'sick')`, u),
      body_stat_media: ins(`INSERT INTO body_stat_media (user_id, date, url) VALUES (?, '2026-04-10', 'progress/c.jpg')`, u),
      set_media: ins(`INSERT INTO set_media (user_id, date, url) VALUES (?, '2026-04-10', 'set-media/c.mp4')`, u),
    };
  });
  const cursor = (await S.ok('lifter', 'GET', '/api/sync/pull')).server_time;
  await sleep(1100);
  await S.restore(filename);
  const p = await S.ok('lifter', 'GET', `/api/sync/pull?since=${encodeURIComponent(cursor)}`);
  for (const [t, id] of Object.entries(made)) {
    const rows = (p[t] || []).filter((r) => r.id === id);
    assert.ok(rows.length && rows.every((r) => r.deleted_at), `${t}: the row made after the backup is sent as gone`);
  }
  for (const [t, id] of Object.entries(made)) {
    assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id = ? AND deleted_at IS NULL`).get(id).n), 0, `${t}: not alive on the server`);
  }
});

test('API tokens, webhooks and pending invites survive a restore', { skip }, async () => {
  const u = S.ids.lifter;
  const made = await S.ok('admin', 'POST', '/api/admin/api-tokens', { name: 'Home Assistant', scopes: ['mcp:read'], password: PW });
  assert.ok(made.raw);
  S.sql((d) => {
    d.prepare(`INSERT INTO webhooks (user_id, url, secret_encrypted, events, enabled) VALUES (?, 'https://example.com/hook', 'x', '["workout.logged"]', 1)`).run(u);
    d.prepare(`INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES ('inv-1', 'new@example.com', 'member', ?, datetime('now', '+7 days'))`).run(S.ids.lifter);
  });
  const before = S.sql((d) => ({
    tokens: d.prepare('SELECT id, user_id, name, token_hash, scopes FROM api_tokens ORDER BY id').all(),
    hooks: d.prepare('SELECT id, user_id, url, secret_encrypted, events, enabled FROM webhooks ORDER BY id').all(),
    invites: d.prepare('SELECT token, email, role, created_by, expires_at, used FROM invite_tokens ORDER BY token').all(),
  }));
  const filename = await S.backup();
  await S.restore(filename);
  const after = S.sql((d) => ({
    tokens: d.prepare('SELECT id, user_id, name, token_hash, scopes FROM api_tokens ORDER BY id').all(),
    hooks: d.prepare('SELECT id, user_id, url, secret_encrypted, events, enabled FROM webhooks ORDER BY id').all(),
    invites: d.prepare('SELECT token, email, role, created_by, expires_at, used FROM invite_tokens ORDER BY token').all(),
  }));
  assert.deepEqual(after, before);
  // The token still signs in.
  const r = await fetch(S.base + '/api/v1/workouts/recent', { headers: { Authorization: `Bearer ${made.raw}` } });
  assert.equal(r.status, 200);
});

test('a backup from before these columns restores', { skip }, async () => {
  const filename = await S.backup();
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => {
    for (const w of data.workout_log) delete w.session_seq;
    for (const f of data.coach_feedback) { delete f.media_id; delete f.media_time_sec; delete f.exercise_uuid; }
    delete data.api_tokens; delete data.webhooks;
  });
  assert.equal(S.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM workout_log WHERE session_seq != 0').get().n), 0);
  assert.ok(S.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM coach_feedback').get().n) >= 1);
});

// Every table is in the backup and every column comes back, so a column or
// table added later can't go missing from a restore without this failing.
// Left out on purpose: updated_at where the restore leaves it to the
// trigger (now), so devices pull the rows again; users.trainer_id, set by
// a second pass, and users.session_version, kept by keepSessionVersions
// (lib/session-version.js); and short-lived or server-kept tables.
// Minutes-to-days state: sign-in hand-offs, email-change and link
// grants (lib/link-grant.js), replay keys of creates (lib/create-keys.js),
// and the server's own deletion records.
const NOT_BACKED_UP = new Set(['oauth_state', 'sync_deletions', 'create_keys', 'user_email_changes', 'oidc_link_grants']);
const NOT_RESTORED = new Set([...NOT_BACKED_UP, 'password_reset_tokens']);
const LEFT_TO_TRIGGER = {
  updated_at: ['ai_chat_history', 'body_stats_log', 'excused_days', 'exercises', 'program_assignments', 'programs', 'user_settings', 'workout_log', 'workout_templates', 'body_stat_media', 'set_media'],
  trainer_id: ['users'],
  session_version: ['users'],
};
test('every table is backed up and every column restored', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  const dump = src.slice(src.indexOf('function dumpDatabase'));
  const restore = src.slice(src.indexOf('function restoreFromZip'), src.indexOf('function dumpDatabase'));
  const written = {};
  for (const m of restore.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
    for (const c of m[2].split(',').map((x) => x.trim()).filter(Boolean)) (written[m[1]] ||= new Set()).add(c);
  }
  const tables = S.sql((d) => d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name));
  for (const t of tables) {
    if (NOT_BACKED_UP.has(t)) continue;
    assert.match(dump, new RegExp(`\\b${t}:`), `${t} is in the backup`);
    if (NOT_RESTORED.has(t)) continue;
    assert.ok(written[t], `${t} is restored`);
    for (const { name } of S.sql((d) => d.prepare(`PRAGMA table_info(${t})`).all())) {
      if (LEFT_TO_TRIGGER[name]?.includes(t)) continue;
      assert.ok(written[t].has(name), `${t}.${name} is restored`);
    }
  }
});

test('a backup with accounts restored on a server without them keeps nothing of that server', { skip }, async () => {
  const S1 = server();
  try {
    await S1.boot();
    // Without accounts: a progress photo and a set video of the one user.
    S1.sql((d) => {
      d.prepare(`INSERT INTO body_stat_media (id, user_id, date, url) VALUES (9001, NULL, '2026-04-20', 'progress/solo.jpg')`).run();
      d.prepare(`INSERT INTO set_media (id, user_id, date, url) VALUES (9001, NULL, '2026-04-20', 'set-media/solo.mp4')`).run();
    });
    await S1.uploadRestore(join(S.dir, 'backups', await S.backup()));
    // Not put back as deleted rows with no account, which a start-up would
    // hand to one of the restored accounts.
    assert.equal(S1.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM body_stat_media WHERE url = 'progress/solo.jpg'`).get().n), 0);
    assert.equal(S1.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM set_media WHERE url = 'set-media/solo.mp4'`).get().n), 0);
  } finally { await S1.close(); }
});
