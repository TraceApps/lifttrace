import db from '../db.js';
import { deleteMediaForUser } from './body-stat-media.js';
import { deleteMediaForUser as deleteSetMediaForUser } from './set-media.js';
import { readSoloKeys, writeSoloKeys } from './solo-program.js';

// ── Claim anonymous (single-user mode) data for the first real account ────
// Single-user mode has no users row, so `uid()` writes NULL and the
// ownership filters are skipped entirely. Creating the first account has to
// re-point all of that data at it, or it stops being visible
// (TraceApps/docs#2).
//
// exercises and programs key ownership on created_by rather than user_id.
// exercises is filtered as `is_global = 1 OR created_by = ?`, so only custom
// rows (is_global = 0) are claimed — the shared global catalog legitimately
// has created_by NULL and must stay that way for every user.
//
// Deliberately NOT claimed:
//   oauth_state   — short-lived OIDC CSRF state, not user data.
//   user_settings, password_reset_tokens, user_oidc_links — user_id is
//   NOT NULL, so these are never anonymous and the UPDATE could not match.
//
// There are two ways to become the first account (password registration and
// OIDC first-login bootstrap), so this lives here rather than in either
// route and both call it.
export const CLAIM_NULL = [
  'workout_log', 'workout_tombstones', 'body_stats_log',
  'body_stat_media', 'set_media', 'cardio_log', 'ai_chat_history', 'excused_days',
];

const ORPHAN_EXTRA_COUNTS = [
  'SELECT COUNT(*) AS c FROM programs WHERE created_by IS NULL',
  'SELECT COUNT(*) AS c FROM exercises WHERE created_by IS NULL AND is_global = 0',
];

export const claimAnonymousData = db.transaction((userId, { soloProgram = true } = {}) => {
  // Read before the rows move: a start still to be chosen looks at the
  // workouts without an owner (solo-program.js).
  const solo = soloProgram ? readSoloKeys() : null;
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(userId);
  }
  db.prepare('UPDATE programs SET created_by = ? WHERE created_by IS NULL').run(userId);
  db.prepare('UPDATE exercises SET created_by = ? WHERE created_by IS NULL AND is_global = 0').run(userId);
  // The program being followed (app_config without accounts) goes on being
  // followed, from the same start and at the same chosen week (issue #121).
  // Only when the account is being made: the one-time repair below may find
  // keys an older build left behind long ago.
  if (solo) claimSoloProgram(userId, solo);
  // Re-enabling user management: clear the single_user_mode flag set by a
  // prior DELETE /management or POST /recover. Without this, /status keeps
  // reporting single_user_mode=true even though a real account now exists.
  db.prepare(`DELETE FROM app_config WHERE key = 'single_user_mode'`).run();
});

/**
 * The program followed without accounts becomes the first account's active
 * assignment (unless it follows one already), and the app_config keys go.
 * The start stays the calendar clock (`start_date`, as programWeek.js reads
 * it); `assigned_at` is the first day a workout from it was completed, if
 * that's earlier, so the same workouts count toward a program advanced by
 * sessions (all of them, without accounts) and a chosen week's base still
 * lines up.
 */
function claimSoloProgram(userId, { id, start, cursor }) {
  if (id != null && db.prepare('SELECT 1 FROM programs WHERE id = ?').get(id)
      && !db.prepare('SELECT 1 FROM program_assignments WHERE assigned_to = ? AND active = 1').get(userId)) {
    let c = {};
    try { c = JSON.parse(cursor || '{}') || {}; } catch { /* none */ }
    const first = db.prepare(
      `SELECT MIN(date) AS d FROM workout_log
        WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL
          AND template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)`
    ).get(userId, id)?.d;
    const assignedAt = first && first < start ? first : start;
    db.prepare(
      `INSERT INTO program_assignments (program_id, assigned_to, assigned_by, start_date, active, assigned_at, week_cursor, week_cursor_session_base, week_cursor_pinned_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(program_id, assigned_to) DO UPDATE SET
         active = 1, start_date = excluded.start_date, assigned_at = excluded.assigned_at,
         week_cursor = excluded.week_cursor, week_cursor_session_base = excluded.week_cursor_session_base,
         week_cursor_pinned_at = excluded.week_cursor_pinned_at`
    ).run(id, userId, userId, start, assignedAt, c.week ?? null, c.week != null ? c.base ?? 0 : null, c.week != null ? c.pinnedAt ?? null : null);
  }
  writeSoloKeys({ id: null });
}

// ── One-time repair for instances that upgraded past the old bug ──────────
// The claim above only runs while the first account is being created, so an
// instance that enabled user management on an older build already has its
// single-user data stranded and will never get it back on its own.
//
// This is safe to run automatically because a NULL owner can only mean
// "written while the instance had no accounts". Deleting a user never
// produces one: the FK-bearing tables cascade the rows away, and the tables
// without an FK keep the departed user's id rather than going NULL.
//
// Guarded on there being exactly one account, which is the only situation
// where the rightful owner is unambiguous. Zero accounts is normal
// single-user mode and must be left alone; two or more means the rows
// cannot be attributed without asking a human, so they are reported and
// left in place.
export function countOrphanedRows() {
  let n = 0;
  for (const t of CLAIM_NULL) n += db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL`).get().c;
  ORPHAN_EXTRA_COUNTS.forEach(sql => { n += db.prepare(sql).get().c; });
  return n;
}

export function repairOrphanedData() {
  const users = db.prepare('SELECT id FROM users').all();
  if (users.length === 0) return { repaired: 0, rows: 0 };   // single-user mode, nothing to do
  const rows = countOrphanedRows();
  if (rows === 0) return { repaired: 0, rows: 0 };
  if (users.length > 1) return { repaired: 0, rows, ambiguous: true };
  claimAnonymousData(users[0].id, { soloProgram: false });
  return { repaired: users[0].id, rows };
}

// ── Hand data back when user management is turned off ─────────────────────
// DELETE /management drops every account. None of LiftTrace's data tables
// carry an FK to users(id), so the rows survive the delete but keep the
// departed account's id — which single-user mode, reading `user_id IS NULL`,
// cannot see. The workout log simply vanished, and because users.id is
// AUTOINCREMENT a later re-enable issues a fresh id that never matches, so
// nothing reclaimed it either.
//
// The disable dialog only promises to remove accounts, so the data is meant
// to stay reachable. Anonymising the sole account's rows first restores that
// and makes disable/re-enable a lossless round trip. Only safe with exactly
// one account: merging several users into one unowned dataset would collide
// on UNIQUE(user_id, date) and silently interleave their histories.
export const anonymizeUserData = db.transaction((userId) => {
  // The program the account follows goes on being followed without
  // accounts (issue #121), replacing any keys an older build left behind.
  releaseSoloProgram(userId);
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = NULL WHERE user_id = ?`).run(userId);
  }
  db.prepare('UPDATE programs SET created_by = NULL WHERE created_by = ?').run(userId);
  db.prepare('UPDATE exercises SET created_by = NULL WHERE created_by = ? AND is_global = 0').run(userId);
});

/**
 * The account's active program as the keys without accounts: its calendar
 * clock (start date, else when assigned) and a chosen week, whose base is
 * moved so it lines up with every workout counting (as without accounts)
 * rather than those since it was assigned. None: no keys.
 */
function releaseSoloProgram(userId) {
  const a = db.prepare(
    `SELECT program_id, start_date, assigned_at, week_cursor, week_cursor_session_base, week_cursor_pinned_at
       FROM program_assignments WHERE assigned_to = ? AND active = 1 LIMIT 1`
  ).get(userId);
  if (!a) return writeSoloKeys({ id: null });
  let cursor = null;
  if (a.week_cursor != null) {
    const count = (since) => db.prepare(
      `SELECT COUNT(*) AS c FROM workout_log
        WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL
          AND template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
          ${since ? 'AND date >= date(?)' : ''}`
    ).get(userId, a.program_id, ...(since ? [since] : [])).c;
    const before = a.assigned_at ? count(null) - count(a.assigned_at) : 0;
    cursor = JSON.stringify({ week: a.week_cursor, base: (a.week_cursor_session_base || 0) + before, pinnedAt: a.week_cursor_pinned_at });
  }
  writeSoloKeys({ id: a.program_id, start: a.start_date || a.assigned_at, cursor });
}

/** Prepare the data before DELETE /management drops every account.
 *
 *  One account: anonymise it, so single-user mode reads it straight back and
 *  the disable/re-enable round trip is lossless.
 *
 *  Several accounts: there is no single rightful owner, and merging them into
 *  one unowned dataset would collide on UNIQUE(user_id, date) and interleave
 *  their histories. Purge instead, matching what NutriTrace and CookTrace do
 *  via their FK cascades. Leaving the rows would strand them at an id nothing
 *  can ever read again. */
export function releaseDataBeforeDisable() {
  const users = db.prepare('SELECT id FROM users').all();
  if (users.length === 1) {
    anonymizeUserData(users[0].id);
    return { anonymized: users[0].id, purged: 0 };
  }
  for (const u of users) purgeAllUserData(u.id);
  return { anonymized: 0, purged: users.length };
}

/** Every table LiftTrace scopes to a user. No FKs exist, so this is by hand. */
const purgeAllUserData = db.transaction((userId) => {
  // Runs before the generic loop below: body_stat_media owns files on
  // disk, and a plain row DELETE would strand them. The loop's own
  // DELETE for that table is then a harmless no-op.
  deleteMediaForUser(userId);
  deleteSetMediaForUser(userId);
  for (const t of CLAIM_NULL) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM programs WHERE created_by = ?').run(userId);
  db.prepare('DELETE FROM exercises WHERE created_by = ? AND is_global = 0').run(userId);
  purgeUserRows(userId);
});

// ── Tables the per-user delete handler used to miss ───────────────────────
// LiftTrace has no FK to users(id) anywhere, so routes/auth.js deletes each
// table by hand when an admin removes an account. cardio_log and
// workout_tombstones were never added to that list and survived the delete.
// body_stat_media is listed here as a safety net for its ROWS: the files
// on disk still need deleteMediaForUser (see lib/body-stat-media.js),
// which every deletion path calls first, so this entry is normally a
// no-op. It matters if a future path ever reaches purgeUserRows without
// the helper: rows would still go, rather than surviving a deleted
// account entirely.
const NO_CASCADE_TABLES = ['cardio_log', 'workout_tombstones', 'oauth_state', 'body_stat_media', 'set_media', 'excused_days', 'sync_deletions'];

export const purgeUserRows = db.transaction((userId) => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
});
