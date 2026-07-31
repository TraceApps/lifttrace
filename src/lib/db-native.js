/**
 * db-native.js — Local SQLite database for LiftTrace's Capacitor build.
 *
 * Mirrors the LiftTrace server schema 1:1 so the same SQL queries / data
 * shapes work in either standalone (single-user) or server-connected mode.
 *
 * Local user_id is always 1 in standalone mode; in server mode rows carry
 * the real user id from the JWT.
 *
 * Each mutable table carries `updated_at` and `deleted_at` columns the
 * server schema doesn't have. The sync engine uses them to compute deltas
 * without requiring server-side schema changes (the server returns full
 * snapshots; we diff client-side and replicate locally).
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { isNative } from './platform.js';

// Verbose logs are gated on dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('lt:verboseLogging') === '1') console.log(...a); } catch {} };

const DB_NAME = 'lifttrace';
const DB_VERSION = 1;

const sqlite = isNative ? new SQLiteConnection(CapacitorSQLite) : null;

let _db = null;
let _initPromise = null;

/**
 * Open (or return cached) SQLite connection. Creates schema on first run.
 *
 * Robust against the common pitfalls of @capacitor-community/sqlite:
 *   - Stale connections registered native-side after JS context refresh.
 *   - `isConnection()` returning false when a native-side handle still exists.
 *   - Concurrent first-call races setting up the DB twice.
 *
 * The fix: always `_closeAny()` before `createConnection()`, plus a retry
 * path that wipes the file if the first open fails (corrupt DB recovery).
 */
export async function getDb() {
  if (!isNative) throw new Error('db-native is for Capacitor only');
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  _initPromise = _open()
    .then(db => { _db = db; return db; })
    .catch(err => { _initPromise = null; throw err; }); // allow retry
  return _initPromise;
}

async function _closeAny() {
  if (!sqlite) return;
  try { await sqlite.checkConnectionsConsistency(); } catch {}
  try { await sqlite.closeConnection(DB_NAME, true);  } catch {}
  try { await sqlite.closeConnection(DB_NAME, false); } catch {}
}

async function _openOnce() {
  await _closeAny();
  const db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
  await db.open();
  await _createSchema(db);
  await _seedSingleUser(db);
  return db;
}

async function _open() {
  console.log('[db-native] Opening SQLite database…');
  try {
    const db = await _openOnce();
    console.log('[db-native] SQLite ready');
    return db;
  } catch (firstErr) {
    console.warn('[db-native] First open failed — wiping and retrying:', firstErr?.message);
    await _closeAny();
    try { await sqlite.deleteDatabase(DB_NAME); } catch {}
    // Belt-and-suspenders: hard-delete the file via Filesystem in case the
    // plugin's deleteDatabase silently no-op'd (happens after partial inits).
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({
        path: `databases/${DB_NAME}SQLite.db`,
        directory: Directory.Data,
      });
    } catch {}
    const db = await _openOnce();
    console.log('[db-native] SQLite ready (after wipe)');
    return db;
  }
}

async function _createSchema(db) {
  await db.execute(`
    -- ── Auth / users ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT,
      full_name       TEXT,
      nickname        TEXT,
      email           TEXT,
      birthday        TEXT,
      gender          TEXT,
      avatar_url      TEXT,
      role            TEXT NOT NULL DEFAULT 'admin',
      trainer_id      INTEGER,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      deleted_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      sync_state TEXT DEFAULT 'clean',  -- 'clean' | 'pending'
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_chat_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    -- ── Exercise Library ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS exercises (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      category          TEXT,
      primary_muscles   TEXT DEFAULT '[]',
      secondary_muscles TEXT DEFAULT '[]',
      equipment         TEXT DEFAULT '[]',
      instructions      TEXT,
      tips              TEXT,
      img_url           TEXT,
      gif_url           TEXT,
      video_url         TEXT,
      external_id       INTEGER,
      source            TEXT DEFAULT 'custom',
      is_global         INTEGER DEFAULT 0,
      created_by        INTEGER,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now')),
      deleted_at        TEXT,
      sync_state        TEXT DEFAULT 'clean'
    );
    CREATE INDEX IF NOT EXISTS idx_exercises_category ON exercises(category);
    CREATE INDEX IF NOT EXISTS idx_exercises_source   ON exercises(source);

    -- ── Programs & Templates ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS programs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      goal        TEXT DEFAULT 'general',
      created_by  INTEGER,
      visibility  TEXT DEFAULT 'private',
      duration_weeks INTEGER DEFAULT 1,
      advance_mode   TEXT DEFAULT 'sessions',
      on_complete    TEXT DEFAULT 'hold',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      deleted_at  TEXT,
      sync_state  TEXT DEFAULT 'clean'
    );

    CREATE TABLE IF NOT EXISTS workout_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      day_label   TEXT,
      order_index INTEGER DEFAULT 0,
      exercises   TEXT DEFAULT '[]',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      deleted_at  TEXT,
      sync_state  TEXT DEFAULT 'clean'
    );
    CREATE INDEX IF NOT EXISTS idx_templates_program ON workout_templates(program_id);

    CREATE TABLE IF NOT EXISTS program_assignments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id  INTEGER NOT NULL,
      assigned_to INTEGER NOT NULL,
      assigned_by INTEGER,
      start_date  TEXT,
      active      INTEGER DEFAULT 1,
      week_cursor              INTEGER,
      week_cursor_session_base INTEGER,
      week_cursor_pinned_at    TEXT,
      assigned_at TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      deleted_at  TEXT,
      UNIQUE(program_id, assigned_to)
    );

    -- ── Diary / workout log ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workout_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER,
      date         TEXT NOT NULL,
      template_id  INTEGER,
      program_id   INTEGER,
      name         TEXT,
      exercises    TEXT DEFAULT '[]',
      notes        TEXT,
      duration_min REAL,
      completed    INTEGER DEFAULT 0,
      program_week INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now')),
      deleted_at   TEXT,
      sync_state   TEXT DEFAULT 'clean',
      UNIQUE(user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_workout_log_date ON workout_log(date);

    -- ── Body Stats ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS body_stats_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      date       TEXT NOT NULL,
      stats      TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT,
      sync_state TEXT DEFAULT 'clean',
      UNIQUE(user_id, date)
    );

    -- ── Cardio Log ─────────────────────────────────────────────────────
    -- Standalone mirror of the server cardio_log table. Manual entry
    -- only per feedback_lifttrace_cardio_scope.md — no device sync.
    CREATE TABLE IF NOT EXISTS cardio_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER,
      date          TEXT NOT NULL,
      activity      TEXT NOT NULL,
      duration_min  INTEGER NOT NULL,
      distance      REAL,
      distance_unit TEXT DEFAULT 'km',
      avg_hr        INTEGER,
      notes         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cardio_log_user_date ON cardio_log(user_id, date);

    -- ── Trainer prescriptions ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS coach_prescriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      trainer_id  INTEGER NOT NULL,
      member_id   INTEGER NOT NULL,
      date        TEXT,
      template_id INTEGER,
      name        TEXT,
      exercises   TEXT,
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      deleted_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prescriptions_member_date ON coach_prescriptions(member_id, date);

    -- ── Sync metadata + queue ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name  TEXT NOT NULL,
      row_id      INTEGER,
      operation   TEXT NOT NULL,           -- 'upsert' | 'delete'
      payload     TEXT,                    -- JSON snapshot for upsert ops
      created_at  TEXT DEFAULT (datetime('now')),
      attempts    INTEGER DEFAULT 0,
      last_error  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_table ON sync_queue(table_name, row_id);
  `);

  // ── Schema migrations for existing installs ────────────────────────────
  // CREATE TABLE IF NOT EXISTS doesn't touch tables that already exist on
  // the device. Columns added to the schema definitions above after a
  // user's first launch never get applied unless we ALTER TABLE here.
  // Each ALTER is wrapped in try/catch: "duplicate column" on a fresh
  // install is harmless (the column was just created by CREATE TABLE).
  //
  // Why this matters: sync.js _applyAssignments writes `updated_at` +
  // `deleted_at`; _applyChat writes `updated_at`. Without these columns,
  // those INSERTs throw `no such column`, the throw bubbles up through
  // pullSnapshot, and the rest of the apply chain (workouts, body stats,
  // settings, chat) never runs AND sync_meta never gets the watermark
  // written — so every subsequent pull re-fetches the whole world but
  // hits the same throw again. Symptom: programs / exercises / templates
  // populated, workout_log + body_stats_log empty, sync_meta empty.
  const _alters = [
    `ALTER TABLE program_assignments ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`,
    `ALTER TABLE program_assignments ADD COLUMN deleted_at TEXT`,
    `ALTER TABLE ai_chat_history     ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`,
    // Multi-week progression (issue #13). Additive columns that existing
    // local databases won't have from their original CREATE TABLE.
    `ALTER TABLE programs            ADD COLUMN duration_weeks INTEGER DEFAULT 1`,
    `ALTER TABLE programs            ADD COLUMN advance_mode TEXT DEFAULT 'sessions'`,
    `ALTER TABLE programs            ADD COLUMN on_complete TEXT DEFAULT 'hold'`,
    `ALTER TABLE program_assignments ADD COLUMN week_cursor INTEGER`,
    `ALTER TABLE program_assignments ADD COLUMN week_cursor_session_base INTEGER`,
    `ALTER TABLE program_assignments ADD COLUMN week_cursor_pinned_at TEXT`,
    `ALTER TABLE workout_log         ADD COLUMN program_week INTEGER`,
  ];
  for (const stmt of _alters) {
    try { await db.execute(stmt); } catch { /* duplicate column / table missing — fine */ }
  }

  // ── One-shot cleanup: drop garbage user_settings rows ───────────────────
  // A bug in api-native.js Settings.put (now fixed) was treating the
  // single-setting PUT body {key, value} as a bulk-update object and
  // iterating Object.entries — producing rows like
  //   (user_id=1, key='key',   value='appearance')
  //   (user_id=1, key='value', value='system')
  // Those rows are not real settings; delete them on every boot so
  // any pre-fix install gets cleaned up. Safe: no actual setting is
  // named 'key' or 'value' anywhere in the app.
  try {
    await db.run(`DELETE FROM user_settings WHERE key IN ('key', 'value')`, []);
  } catch {}
}

/**
 * In standalone mode there's exactly one user (id=1). Seed it on first run.
 * In server mode this user gets overwritten by the first sync pull.
 */
async function _seedSingleUser(db) {
  const r = await db.query(`SELECT COUNT(*) AS c FROM users`, []);
  const count = r?.values?.[0]?.c ?? 0;
  if (count === 0) {
    await db.run(
      `INSERT INTO users (id, username, role, full_name)
       VALUES (1, 'me', 'admin', 'Me')`,
      []
    );
  }
}

// ── Convenience helpers ────────────────────────────────────────────────────

/** Run a query that returns rows. */
export async function dbQuery(sql, params = []) {
  const db = await getDb();
  const r = await db.query(sql, params);
  return r?.values || [];
}

/** Run a write statement. Returns { changes, lastId }. */
export async function dbRun(sql, params = []) {
  const db = await getDb();
  const r = await db.run(sql, params);
  return {
    changes: r?.changes?.changes ?? 0,
    lastId: r?.changes?.lastId ?? null,
  };
}

/** Run multiple statements as a single transaction. */
export async function dbExec(statements) {
  const db = await getDb();
  await db.executeSet(statements);
}

/** Look up a single sync_meta value. */
export async function getSyncMeta(key) {
  const rows = await dbQuery(`SELECT value FROM sync_meta WHERE key = ?`, [key]);
  return rows[0]?.value ?? null;
}

/** Set a single sync_meta value. */
export async function setSyncMeta(key, value) {
  await dbRun(
    `INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`,
    [key, value]
  );
}

/** Push a write into the sync queue. Used in server-connected mode. */
export async function enqueueSync(table, rowId, operation, payload) {
  await dbRun(
    `INSERT INTO sync_queue (table_name, row_id, operation, payload)
     VALUES (?, ?, ?, ?)`,
    [table, rowId, operation, payload ? JSON.stringify(payload) : null]
  );
}

/** Drop the local DB entirely (used by Settings → Clear Local Data). */
export async function destroyLocalDb() {
  if (!isNative) return;
  await _closeAny();
  try { await sqlite.deleteDatabase(DB_NAME); } catch {}
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({
      path: `databases/${DB_NAME}SQLite.db`,
      directory: Directory.Data,
    });
  } catch {}
  _db = null;
  _initPromise = null;
}
