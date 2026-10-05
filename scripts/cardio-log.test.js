/**
 * Cardio over the public API and MCP (issue #134).
 *
 * The first half drives server/lib/cardio-log.js against a scratch SQLite
 * file with the production driver, so the real SQL runs: validation, the
 * cardio opt-in, external_id dedupe and the range query. cardio-log.js takes
 * the db handle as an argument, so nothing here imports server/db.js or its
 * bootstrap. The schema below mirrors server/db.js, and a static check at the
 * end fails if the two drift apart.
 *
 * The second half checks the wiring statically, like public-api-wiring and
 * mcp-wiring: routes, scopes, tool registration and the settings sync.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  CARDIO_OFF_MESSAGE,
  MAX_EXTERNAL_ID_LENGTH,
  insertCardio,
  isCardioEnabled,
  listCardio,
  normalizeCardioInput,
  normalizeExternalId,
  publicCardioSession,
} from '../server/lib/cardio-log.js';

const serverRequire = createRequire(new URL('../server/', import.meta.url));
const Database = serverRequire('better-sqlite3');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function scratchDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cardio-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE user_settings (
      user_id INTEGER, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE cardio_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER,
      date          TEXT NOT NULL,
      activity      TEXT NOT NULL,
      duration_min  INTEGER NOT NULL,
      distance      REAL,
      distance_unit TEXT DEFAULT 'km',
      avg_hr        INTEGER,
      notes         TEXT,
      is_template   INTEGER DEFAULT 0,
      external_id   TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_cardio_log_user_date ON cardio_log(user_id, date);
    CREATE UNIQUE INDEX idx_cardio_log_user_external
      ON cardio_log(user_id, external_id)
      WHERE external_id IS NOT NULL;
  `);
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const setCardio = (db, userId, value) => db
  .prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
  .run(userId, 'cardioEnabled', JSON.stringify(value));

const run = { date: '2026-09-28', activity: 'Running', duration_min: 33, distance: 2.47, distance_unit: 'mi', avg_hr: 138 };

// ── Validation ─────────────────────────────────────────────────────────────

test('normalizeCardioInput keeps the rules POST /api/cardio always had', () => {
  assert.throws(() => normalizeCardioInput({ ...run, date: '' }), /date required/);
  assert.throws(() => normalizeCardioInput({ ...run, activity: '   ' }), /activity required/);
  assert.throws(() => normalizeCardioInput({ ...run, duration_min: 0 }), /duration_min must be a positive integer/);
  assert.throws(() => normalizeCardioInput({ ...run, duration_min: 'abc' }), /duration_min must be a positive integer/);

  const row = normalizeCardioInput({
    ...run, activity: '  Running ', duration_min: '33.9', avg_hr: '138.6', notes: '  easy  ',
  });
  assert.equal(row.activity, 'Running');
  assert.equal(row.duration_min, 33, 'minutes are floored to a whole number');
  assert.equal(row.avg_hr, 138, 'heart rate is floored');
  assert.equal(row.notes, 'easy');
  assert.equal(row.distance_unit, 'mi');
  assert.equal(row.is_template, 0);
});

test('normalizeCardioInput defaults the unit to km and drops blank or invalid optionals', () => {
  const row = normalizeCardioInput({ date: '2026-09-28', activity: 'Row', duration_min: 20, distance: '', distance_unit: 'miles', avg_hr: 'n/a' });
  assert.equal(row.distance, null);
  assert.equal(row.distance_unit, 'km');
  assert.equal(row.avg_hr, null);
  assert.equal(row.notes, null);
});

test('normalizeExternalId treats blank as none, trims, and caps the length', () => {
  assert.equal(normalizeExternalId(undefined), null);
  assert.equal(normalizeExternalId('   '), null);
  assert.equal(normalizeExternalId(' strava:20368911854 '), 'strava:20368911854');
  assert.equal(normalizeExternalId(20368911854), '20368911854');
  assert.throws(() => normalizeExternalId('x'.repeat(MAX_EXTERNAL_ID_LENGTH + 1)), /at most 200 characters/);
});

// ── The cardio opt-in ──────────────────────────────────────────────────────

test('isCardioEnabled is off unless the setting is stored as true', () => {
  const { db, cleanup } = scratchDb();
  try {
    assert.equal(isCardioEnabled(db, 1), false, 'off by default');
    setCardio(db, 1, true);
    assert.equal(isCardioEnabled(db, 1), true);
    setCardio(db, 1, false);
    assert.equal(isCardioEnabled(db, 1), false);
    db.prepare("INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (1, 'cardioEnabled', 'not json')").run();
    assert.equal(isCardioEnabled(db, 1), false, 'an unreadable value counts as off');
    setCardio(db, 2, true);
    assert.equal(isCardioEnabled(db, 1), false, 'per user');
    assert.equal(isCardioEnabled(db, null), false, 'no user, no cardio');
  } finally { cleanup(); }
});

test('the off message tells the user where to turn cardio on', () => {
  assert.match(CARDIO_OFF_MESSAGE, /Settings/);
});

// ── Writes and external_id ─────────────────────────────────────────────────

test('insertCardio stores a session and returns the row', () => {
  const { db, cleanup } = scratchDb();
  try {
    const { created, session } = insertCardio(db, 1, run);
    assert.equal(created, true);
    assert.equal(session.user_id, 1);
    assert.equal(session.activity, 'Running');
    assert.equal(session.duration_min, 33);
    assert.equal(session.external_id, null);
  } finally { cleanup(); }
});

test('the same external_id returns the existing session instead of a duplicate', () => {
  const { db, cleanup } = scratchDb();
  try {
    const first = insertCardio(db, 1, { ...run, external_id: 'strava:20368911854' });
    const again = insertCardio(db, 1, { ...run, duration_min: 40, external_id: 'strava:20368911854' });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.session.id, first.session.id);
    assert.equal(again.session.duration_min, 33, 'the stored session is returned unchanged');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cardio_log').get().n, 1);
  } finally { cleanup(); }
});

test('external_id is unique per user, and sessions without one never collide', () => {
  const { db, cleanup } = scratchDb();
  try {
    assert.equal(insertCardio(db, 1, { ...run, external_id: 'abc' }).created, true);
    assert.equal(insertCardio(db, 2, { ...run, external_id: 'abc' }).created, true, 'another user may use the same id');
    insertCardio(db, 1, run);
    insertCardio(db, 1, run);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cardio_log WHERE user_id = 1').get().n, 3);
  } finally { cleanup(); }
});

test('the unique index rejects a duplicate that slips past the lookup', () => {
  const { db, cleanup } = scratchDb();
  try {
    insertCardio(db, 1, { ...run, external_id: 'abc' });
    assert.throws(
      () => db.prepare("INSERT INTO cardio_log (user_id, date, activity, duration_min, external_id) VALUES (1, '2026-09-28', 'Running', 10, 'abc')").run(),
      (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE',
    );
  } finally { cleanup(); }
});

test('insertCardio validates before it writes anything', () => {
  const { db, cleanup } = scratchDb();
  try {
    assert.throws(() => insertCardio(db, 1, { ...run, duration_min: -5 }), /positive integer/);
    assert.throws(() => insertCardio(db, 1, { ...run, external_id: 'x'.repeat(201) }), /at most 200/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cardio_log').get().n, 0);
  } finally { cleanup(); }
});

// ── Reads ──────────────────────────────────────────────────────────────────

test('listCardio filters by inclusive date range and activity, oldest first, per user', () => {
  const { db, cleanup } = scratchDb();
  try {
    insertCardio(db, 1, { ...run, date: '2026-09-30', activity: 'Cycling' });
    insertCardio(db, 1, { ...run, date: '2026-09-28', activity: 'Running' });
    insertCardio(db, 1, { ...run, date: '2026-09-29', activity: 'Trail run' });
    insertCardio(db, 1, { ...run, date: '2026-10-05', activity: 'Running' });
    insertCardio(db, 2, { ...run, date: '2026-09-29', activity: 'Running' });

    const range = listCardio(db, 1, { start: '2026-09-28', end: '2026-09-30' });
    assert.deepEqual(range.map(r => r.date), ['2026-09-28', '2026-09-29', '2026-09-30']);

    const runs = listCardio(db, 1, { start: '2026-09-01', end: '2026-10-31', activity: 'RUN' });
    assert.deepEqual(runs.map(r => r.activity), ['Running', 'Trail run', 'Running'], 'case-insensitive substring');

    assert.equal(listCardio(db, 1, { start: '2026-10-01' }).length, 1, 'a single bound leaves the other open');
  } finally { cleanup(); }
});

test('listCardio treats LIKE wildcards in the activity filter literally', () => {
  const { db, cleanup } = scratchDb();
  try {
    insertCardio(db, 1, { ...run, activity: 'Running' });
    insertCardio(db, 1, { ...run, activity: '100% effort' });
    assert.deepEqual(listCardio(db, 1, { activity: '%' }).map(r => r.activity), ['100% effort']);
    assert.equal(listCardio(db, 1, { activity: '_' }).length, 0);
  } finally { cleanup(); }
});

test('publicCardioSession exposes the documented fields and a boolean is_template', () => {
  const { db, cleanup } = scratchDb();
  try {
    const { session } = insertCardio(db, 1, { ...run, external_id: 'abc', is_template: 1 });
    assert.deepEqual(Object.keys(publicCardioSession(session)).sort(), [
      'activity', 'avg_hr', 'created_at', 'date', 'distance', 'distance_unit',
      'duration_min', 'external_id', 'id', 'is_template', 'notes',
    ]);
    assert.equal(publicCardioSession(session).is_template, true);
    assert.equal(publicCardioSession(null), null);
  } finally { cleanup(); }
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test('server/db.js has the external_id column, its migration, and the unique index this test mirrors', () => {
  const dbJs = read('../server/db.js');
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS cardio_log \([\s\S]*?external_id\s+TEXT,[\s\S]*?\);/);
  assert.match(dbJs, /addColumnIfMissing\('cardio_log', 'external_id', 'external_id TEXT'\)/);
  assert.match(dbJs, /CREATE UNIQUE INDEX IF NOT EXISTS idx_cardio_log_user_external\s+ON cardio_log\(user_id, external_id\)\s+WHERE external_id IS NOT NULL/);
});

test('log_cardio refuses writes while cardio is off, before inserting', () => {
  const tool = read('../server/lib/mcp/tools/log-cardio.js');
  const core = tool.match(/export function logCardioCore[\s\S]*?\n}\n/)[0];
  const gate = core.indexOf('isCardioEnabled(db, userId)');
  const insert = core.indexOf('insertCardio(');
  assert.ok(gate !== -1 && insert !== -1 && gate < insert, 'the opt-in check comes before the insert');
  assert.match(core, /throw new Error\(CARDIO_OFF_MESSAGE\)/);
  assert.match(core, /is_template: 0/, 'API writes are never Diary presets');
});

test('the public API exposes GET and POST /cardio behind the right scopes and the write flag', () => {
  const route = read('../server/routes/public-api.js');
  assert.match(route, /router\.get\('\/cardio', requireScope\('mcp:read'\), core\(req =>\s*getCardioCore\(/);
  assert.match(route, /router\.post\('\/cardio', requireWriteEnabled, requireScope\('mcp:write'\), core\(req =>\s*logCardioCore\(/);
});

test('the MCP server registers get_cardio as a read tool and log_cardio as a write tool', () => {
  const tools = read('../server/lib/mcp/tools/index.js');
  const readBlock = tools.match(/export function registerReadTools[\s\S]*?\n}/)[0];
  const writeBlock = tools.match(/export function registerWriteTools[\s\S]*?\n}/)[0];
  assert.match(readBlock, /registerGetCardio\(server, ctx\)/);
  assert.match(writeBlock, /registerLogCardio\(server, ctx\)/);
  assert.doesNotMatch(readBlock, /registerLogCardio/, 'a write tool must never register on a read-only token');
});

test("the app's POST /api/cardio validates through the shared module, so there is one copy", () => {
  const route = read('../server/routes/cardio.js');
  assert.match(route, /import \{ insertCardio \} from '\.\.\/lib\/cardio-log\.js'/);
  const post = route.match(/router\.post\('\/', wrap\([\s\S]*?\n}\)\);/)[0];
  assert.match(post, /insertCardio\(db, uid\(req\), req\.body \|\| \{\}\)/);
  assert.doesNotMatch(post, /INSERT INTO cardio_log/);
});

test('cardioEnabled syncs to the server, and a value only on the device is uploaded once', () => {
  const store = read('../src/stores/settings.js');
  const serverSettings = store.match(/const SERVER_SETTINGS = new Set\(\[([\s\S]*?)\]\);/)[1];
  assert.match(serverSettings, /'cardioEnabled'/);
  assert.match(store, /if \(!\('cardioEnabled' in serverSettings\) && DB\.getSetting\('cardioEnabled', false\) === true\) \{\s*scheduleSave\('cardioEnabled', true\);/);
});
