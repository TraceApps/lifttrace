import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './lifttrace.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT,
    nickname      TEXT,
    email         TEXT,
    birthday      TEXT,
    gender        TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL DEFAULT 'member',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT,
    role       TEXT NOT NULL DEFAULT 'member',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Exercise Library ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    category        TEXT,
    primary_muscles TEXT DEFAULT '[]',
    secondary_muscles TEXT DEFAULT '[]',
    equipment       TEXT DEFAULT '[]',
    instructions    TEXT,
    tips            TEXT,
    img_url         TEXT,
    gif_url         TEXT,
    video_url       TEXT,
    external_id     INTEGER,
    source          TEXT DEFAULT 'custom',
    is_global       INTEGER DEFAULT 0,
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    -- Library-wide load_type default. NULL = "unset" (the fallthrough is
    -- unambiguous — user's client-side $exerciseLoadTypes pref wins over
    -- NULL and only loses to an explicit non-NULL library value the
    -- exercise owner set). See feedback_traceapps_dev_workflow + issue
    -- #24: fixes volume math + CSV export + history display for
    -- imported unilateral/alternating exercises whose load_type never
    -- made it out of the live Diary session.
    load_type       TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exercises_category ON exercises(category);
  CREATE INDEX IF NOT EXISTS idx_exercises_source   ON exercises(source);
`);

// ── Programs & Templates ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS programs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    goal        TEXT DEFAULT 'general',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    visibility  TEXT DEFAULT 'private',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workout_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    day_label   TEXT,
    order_index INTEGER DEFAULT 0,
    exercises   TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_templates_program ON workout_templates(program_id);

  CREATE TABLE IF NOT EXISTS program_assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    assigned_to INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    start_date  TEXT,
    active      INTEGER DEFAULT 1,
    assigned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(program_id, assigned_to)
  );
`);

// ── Workout Log (diary) ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS workout_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    date        TEXT NOT NULL,
    template_id INTEGER REFERENCES workout_templates(id) ON DELETE SET NULL,
    program_id  INTEGER REFERENCES programs(id) ON DELETE SET NULL,
    name        TEXT,
    exercises   TEXT DEFAULT '[]',
    notes       TEXT,
    duration_min REAL,
    completed   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_workout_log_date ON workout_log(date);
`);

// ── Body Stats ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS body_stats_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date    TEXT NOT NULL,
    stats   TEXT DEFAULT '{}',
    UNIQUE(user_id, date)
  );
`);

// ── Cardio Log ───────────────────────────────────────────────────────────
// Manual cardio session entry. Deliberately separate from workout_log so
// nothing on the set-based lifting side (volume totals, PRs, rest-timer)
// has to filter for it — cardio just doesn't appear in those queries.
// See feedback_lifttrace_cardio_scope.md: device sync (Fitbit / Garmin /
// Health Connect / Apple Health) is explicitly out of scope for LT; those
// live in NutriTrace via federation.
db.exec(`
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
    -- Pinned template flag (mirrors NT activity_log.is_template). Rows
    -- flagged 1 double as one-tap re-log presets on the Diary CardioCard:
    -- their activity + duration + distance + hr + notes seed a new
    -- session for today when the chip is tapped, without erasing the
    -- original entry from history.
    is_template   INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cardio_log_user_date ON cardio_log(user_id, date);
`);

// ── OAuth/OIDC state + provider tables ───────────────────────────────────
db.exec(`
  -- OAuth/OIDC PKCE state store — persisted so server restarts during auth flow don't break it
  CREATE TABLE IF NOT EXISTS oauth_state (
    state       TEXT PRIMARY KEY,
    user_id     INTEGER,
    provider    TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    expires_at  TEXT NOT NULL
  );

  -- OIDC providers — admin-managed list; client_secret encrypted via
  -- server/lib/token-crypto.js so a leaked DB doesn't hand out IdP creds.
  CREATE TABLE IF NOT EXISTS oidc_providers (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer_url                    TEXT NOT NULL,
    client_id                     TEXT NOT NULL,
    client_secret                 TEXT,
    redirect_uris                 TEXT NOT NULL DEFAULT '[]',
    scope                         TEXT NOT NULL DEFAULT 'openid profile email',
    token_endpoint_auth_method    TEXT NOT NULL DEFAULT 'client_secret_post',
    response_types                TEXT NOT NULL DEFAULT '["code"]',
    id_token_signed_response_alg  TEXT NOT NULL DEFAULT 'RS256',
    userinfo_signed_response_alg  TEXT NOT NULL DEFAULT 'none',
    request_timeout_ms            INTEGER NOT NULL DEFAULT 30000,
    auto_register                 INTEGER NOT NULL DEFAULT 0,
    auto_link_verified_email      INTEGER NOT NULL DEFAULT 1,
    auto_register_new_users       INTEGER NOT NULL DEFAULT 0,
    admin_group_claim             TEXT,
    admin_group_value             TEXT,
    display_name                  TEXT,
    logo_url                      TEXT,
    is_active                     INTEGER NOT NULL DEFAULT 1,
    created_at                    TEXT DEFAULT (datetime('now')),
    updated_at                    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_oidc_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    oidc_provider_id  INTEGER NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    oidc_sub          TEXT NOT NULL,
    email_verified    INTEGER DEFAULT 0,
    last_login_at     TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE (oidc_provider_id, oidc_sub)
  );
  CREATE INDEX IF NOT EXISTS idx_user_oidc_links_user ON user_oidc_links(user_id);
`);

// Allow password_hash to be NULL for OIDC-only users (legacy schemas had NOT NULL).
// SQLite doesn't support ALTER COLUMN; we rebuild the table.
//
// CRITICAL: foreign_keys MUST be disabled around the rebuild. With FK
// enforcement ON, DROP TABLE on the parent will trigger cascade deletes on
// every child table that references users(id) ON DELETE CASCADE — wiping
// user-scoped data. Following SQLite's recommended safe-rebuild recipe.
{
  const colInfo = db.prepare(`PRAGMA table_info(users)`).all();
  const pwCol = colInfo.find(c => c.name === 'password_hash');
  if (pwCol && pwCol.notnull) {
    db.pragma('foreign_keys = OFF');
    try {
      // Build a column list dynamically so existing migration-added columns
      // (trainer_id, etc.) survive the rebuild without manual list-keeping.
      const baseCols = ['id', 'username', 'password_hash', 'full_name', 'nickname',
                        'email', 'birthday', 'gender', 'avatar_url', 'role', 'created_at'];
      const extraCols = colInfo.filter(c => !baseCols.includes(c.name));
      const extraDDL  = extraCols.map(c => {
        const notnull = c.notnull ? ' NOT NULL' : '';
        const dflt = c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : '';
        // Mirror the trainer_id self-FK so the new schema keeps the constraint.
        const fk = c.name === 'trainer_id' ? ' REFERENCES users(id) ON DELETE SET NULL' : '';
        return `, ${c.name} ${c.type || 'TEXT'}${notnull}${dflt}${fk}`;
      }).join('');
      const allCols = baseCols.concat(extraCols.map(c => c.name));
      const colList = allCols.join(', ');

      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE users_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            full_name     TEXT,
            nickname      TEXT,
            email         TEXT,
            birthday      TEXT,
            gender        TEXT,
            avatar_url    TEXT,
            role          TEXT NOT NULL DEFAULT 'member',
            created_at    TEXT DEFAULT (datetime('now'))${extraDDL}
          );
          INSERT INTO users_new (${colList}) SELECT ${colList} FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
      });
      rebuild();
      const violations = db.prepare(`PRAGMA foreign_key_check`).all();
      if (violations.length) {
        console.error('[db] FK violations after users rebuild:', violations);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

// ── Migrations (additive, idempotent) ─────────────────────────────────────
// Each try/catch guards a single ALTER — repeat-runs are no-ops.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Phase 1 — trainer-member relationship. Nullable FK on users.
addColumnIfMissing('users', 'trainer_id', 'trainer_id INTEGER REFERENCES users(id) ON DELETE SET NULL');

// Multi-week progression plans (issue #13). All additive — a program with
// duration_weeks = 1 (the default) reproduces the old flat-prescription
// behaviour, so existing programs and templates are untouched. The per-week
// matrix itself lives inside the templates' `exercises` JSON (optional
// `weeks[]` / `tempo` / `rest_sec` keys), which needs no schema change.
addColumnIfMissing('programs', 'duration_weeks', 'duration_weeks INTEGER DEFAULT 1');
// How the athlete's current plan week advances: 'sessions' (default —
// advance once the week's prescribed number of program sessions is logged)
// or 'calendar' (floor(days/7)+1 from start).
addColumnIfMissing('programs', 'advance_mode', "advance_mode TEXT DEFAULT 'sessions'");
// Behaviour past the final week: 'hold' (default — stay on the last week) or
// 'repeat' (loop back to week 1 for repeating blocks).
addColumnIfMissing('programs', 'on_complete', "on_complete TEXT DEFAULT 'hold'");
// Manual week override so an athlete can repeat/regress a week. NULL = auto.
// week_cursor_session_base captures sessions_in_program at the moment the
// cursor was pinned, so auto-advance resumes *relative to* the pin rather
// than freezing on it. week_cursor_pinned_at is the calendar-mode analogue:
// the timestamp the cursor was pinned, so calendar-mode programs advance by
// days-since-pin instead of freezing on the pinned week.
addColumnIfMissing('program_assignments', 'week_cursor', 'week_cursor INTEGER');
addColumnIfMissing('program_assignments', 'week_cursor_session_base', 'week_cursor_session_base INTEGER');
addColumnIfMissing('program_assignments', 'week_cursor_pinned_at', 'week_cursor_pinned_at TEXT');
// The plan week a logged session was performed in, stamped when the workout
// is loaded from a multi-week program. NULL for non-programmed workouts.
// Persisted (not derived) so a past session keeps its week after the athlete
// advances — a logged Week 2 always reads Week 2.
addColumnIfMissing('workout_log', 'program_week', 'program_week INTEGER');
// Library-level load_type default (issue #24). NULL = unset.
addColumnIfMissing('exercises', 'load_type', 'load_type TEXT DEFAULT NULL');
// Pinned cardio templates (NT activity_log parity).
addColumnIfMissing('cardio_log', 'is_template', 'is_template INTEGER DEFAULT 0');

// Phase 2 — trainer prescribes workouts to members (undated "try this" or
// dated "do this on YYYY-MM-DD"). Either template_id references a template,
// or name+exercises hold an inline ad-hoc workout. date NULL = undated.
db.exec(`
  CREATE TABLE IF NOT EXISTS coach_prescriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trainer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT,
    template_id INTEGER REFERENCES workout_templates(id) ON DELETE SET NULL,
    name        TEXT,
    exercises   TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_prescriptions_member_date ON coach_prescriptions(member_id, date);
  CREATE INDEX IF NOT EXISTS idx_prescriptions_trainer ON coach_prescriptions(trainer_id);
`);

// Coach feedback — annotations a trainer leaves on a member's completed
// workout. exercise_idx NULL = workout-level note; otherwise the 0-based
// POSITION of the target exercise within the workout's exercises array
// (NOT the library exercise_id, which collides when the same exercise
// appears twice in a workout). UNIQUE(workout_id, exercise_idx, trainer_id)
// keeps each surface to one note per trainer.
db.exec(`
  CREATE TABLE IF NOT EXISTS coach_feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    trainer_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workout_id   INTEGER NOT NULL REFERENCES workout_log(id) ON DELETE CASCADE,
    exercise_idx INTEGER,
    note         TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );
`);
// Migration: the first version of this table named the column exercise_id
// (treated as the library exercise id, which caused two slots referencing
// the same exercise to share a note). Rename in place if the older column
// is still around; new installs hit the CREATE above and skip this.
try {
  const cols = db.prepare("PRAGMA table_info(coach_feedback)").all().map(c => c.name);
  if (cols.includes('exercise_id') && !cols.includes('exercise_idx')) {
    db.exec(`ALTER TABLE coach_feedback RENAME COLUMN exercise_id TO exercise_idx`);
  }
} catch { /* older sqlite without rename — drop the index manually below if you hit this */ }
// Drop any pre-existing uniqueness index from the old name so the rebuild
// below uses exercise_idx (SQLite carries indexes through renames in
// modern versions, but be defensive in case an older index lingered).
try { db.exec(`DROP INDEX IF EXISTS idx_coach_feedback_unique`); } catch {}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_feedback_unique
    ON coach_feedback(workout_id, COALESCE(exercise_idx, -1), trainer_id);
  CREATE INDEX IF NOT EXISTS idx_coach_feedback_member
    ON coach_feedback(member_id);
`);
// Read-receipt for the member. NULL = unseen; set to a timestamp when the
// member opens the inbox / the diary day with that feedback. Powers the
// unread badge + date-strip dot.
addColumnIfMissing('coach_feedback', 'seen_by_member_at', 'seen_by_member_at TEXT');
// Member's reply to the coach's note — single back-and-forth per note,
// keeps the feedback loop bidirectional without dragging in a full chat
// thread model. NULL = no reply yet.
addColumnIfMissing('coach_feedback', 'member_reply', 'member_reply TEXT');
addColumnIfMissing('coach_feedback', 'member_replied_at', 'member_replied_at TEXT');

// Coach activity feed — fires when a member completes a prescribed workout
// (kind='prescription_completed') or when a dated prescription's date has
// passed without completion (kind='prescription_missed'). The UNIQUE index
// on (prescription_id, kind) keeps each prescription from firing the same
// kind twice (e.g. re-opening then re-finishing a workout). seen_at is
// nullable so the trainer's app can show unread counts and mark-as-read.
db.exec(`
  CREATE TABLE IF NOT EXISTS coach_activity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trainer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT    NOT NULL,
    prescription_id INTEGER REFERENCES coach_prescriptions(id) ON DELETE CASCADE,
    workout_id      INTEGER REFERENCES workout_log(id) ON DELETE SET NULL,
    occurred_at     TEXT    DEFAULT (datetime('now')),
    seen_at         TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_activity_unique ON coach_activity(prescription_id, kind);
  CREATE INDEX IF NOT EXISTS idx_coach_activity_trainer ON coach_activity(trainer_id, occurred_at DESC);
`);
// Activity feed extension: feedback_reply events reference the coach_feedback
// row that was replied to. Existing kinds (prescription_completed,
// prescription_missed) carry a prescription_id; this column lets the same
// table track per-feedback events without overloading prescription_id.
// MUST run AFTER the CREATE TABLE above — fresh DBs had no coach_activity
// row yet when this ALTER fired, which broke `docker compose up` on a clean
// volume in v1.0.0-rc.2 (issue #2).
addColumnIfMissing('coach_activity', 'feedback_id', 'feedback_id INTEGER REFERENCES coach_feedback(id) ON DELETE CASCADE');

// ── Phase 3 — Differential sync columns (updated_at + deleted_at) ─────────
// The Capacitor Android app's /api/sync/pull?since=<ISO> endpoint scans
// these columns to return only rows changed since the client's last
// successful pull. Soft-delete (deleted_at IS NOT NULL) lets a delete
// propagate to clients on the next pull instead of leaving stale rows.
// Triggers below auto-populate updated_at on every INSERT/UPDATE so route
// handlers don't have to remember.
const SYNCABLE = [
  { table: 'exercises',         hasCreated: 'created_at',  byUser: false }, // is_global filter, not user-scoped
  { table: 'programs',          hasCreated: 'created_at',  byUser: false },
  { table: 'workout_templates', hasCreated: 'created_at',  byUser: false },
  { table: 'program_assignments', hasCreated: 'assigned_at', byUser: 'assigned_to' },
  { table: 'workout_log',       hasCreated: 'created_at',  byUser: 'user_id' },
  { table: 'body_stats_log',    hasCreated: null,          byUser: 'user_id' },
  { table: 'ai_chat_history',   hasCreated: 'created_at',  byUser: 'user_id' },
];

for (const { table, hasCreated } of SYNCABLE) {
  addColumnIfMissing(table, 'updated_at', "updated_at TEXT");
  addColumnIfMissing(table, 'deleted_at', "deleted_at TEXT");
  // Backfill updated_at on existing rows so they show up in the first pull.
  // Prefer the table's existing creation timestamp; fall back to now() if
  // the table has no created_at column at all (body_stats_log).
  const fallback = hasCreated ? hasCreated : "datetime('now')";
  db.exec(`UPDATE ${table} SET updated_at = COALESCE(updated_at, ${fallback}, datetime('now')) WHERE updated_at IS NULL`);
  // INSERT trigger — set updated_at on new rows that don't specify it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_set_updated_at
    AFTER INSERT ON ${table}
    WHEN NEW.updated_at IS NULL
    BEGIN
      UPDATE ${table} SET updated_at = datetime('now') WHERE rowid = NEW.rowid;
    END;
  `);
  // UPDATE trigger — bump updated_at when route handlers don't pass a new
  // value. Comparing OLD.updated_at = NEW.updated_at lets routes that DO
  // explicitly bump it (sync push) override.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_touch_updated_at
    AFTER UPDATE ON ${table}
    WHEN (OLD.updated_at IS NEW.updated_at) OR (NEW.updated_at IS NULL)
    BEGIN
      UPDATE ${table} SET updated_at = datetime('now') WHERE rowid = NEW.rowid;
    END;
  `);
}

// user_settings is keyed by (user_id, key) and has no auto-id, so we track
// updated_at on it for sync purposes too. Its update path is INSERT … ON
// CONFLICT DO UPDATE in routes/settings.js, so the trigger fires on UPDATE.
addColumnIfMissing('user_settings', 'updated_at', "updated_at TEXT");
db.exec(`UPDATE user_settings SET updated_at = COALESCE(updated_at, datetime('now')) WHERE updated_at IS NULL`);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS user_settings_set_updated_at
  AFTER INSERT ON user_settings
  WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE user_settings SET updated_at = datetime('now') WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS user_settings_touch_updated_at
  AFTER UPDATE ON user_settings
  WHEN (OLD.updated_at IS NEW.updated_at) OR (NEW.updated_at IS NULL)
  BEGIN
    UPDATE user_settings SET updated_at = datetime('now') WHERE rowid = NEW.rowid;
  END;
`);

// ── Backfill orphan user_id rows ───────────────────────────────────────────
// When LiftTrace was first set up in single-user mode (before the user
// activated user-management), per-user rows were created with user_id=NULL.
// Once user-management was activated and the user became user_id=1, those
// NULL rows were stranded — the sync route filters by `AND user_id = ?`
// which excludes NULL. Result: the user's workouts, body stats, and chat
// history weren't being pulled to the Android client.
//
// One-time migration: assign orphan rows to the first admin user. Safe
// because pre-mgmt single-user data unambiguously belongs to whoever
// later became the (first) admin.
try {
  const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (firstAdmin?.id) {
    for (const table of ['workout_log', 'body_stats_log', 'ai_chat_history']) {
      const r = db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(firstAdmin.id);
      if (r.changes > 0) {
        // eslint-disable-next-line no-console
        console.log(`[db] backfilled ${r.changes} orphan rows in ${table} → user_id=${firstAdmin.id}`);
      }
    }
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[db] orphan user_id backfill skipped:', e?.message || e);
}

export default db;
