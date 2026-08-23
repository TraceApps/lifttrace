import db from '../db.js';

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
  'cardio_log', 'ai_chat_history',
];

const ORPHAN_EXTRA_COUNTS = [
  'SELECT COUNT(*) AS c FROM programs WHERE created_by IS NULL',
  'SELECT COUNT(*) AS c FROM exercises WHERE created_by IS NULL AND is_global = 0',
];

export const claimAnonymousData = db.transaction((userId) => {
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(userId);
  }
  db.prepare('UPDATE programs SET created_by = ? WHERE created_by IS NULL').run(userId);
  db.prepare('UPDATE exercises SET created_by = ? WHERE created_by IS NULL AND is_global = 0').run(userId);
  // Re-enabling user management: clear the single_user_mode flag set by a
  // prior DELETE /management or POST /recover. Without this, /status keeps
  // reporting single_user_mode=true even though a real account now exists.
  db.prepare(`DELETE FROM app_config WHERE key = 'single_user_mode'`).run();
});

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
  claimAnonymousData(users[0].id);
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
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = NULL WHERE user_id = ?`).run(userId);
  }
  db.prepare('UPDATE programs SET created_by = NULL WHERE created_by = ?').run(userId);
  db.prepare('UPDATE exercises SET created_by = NULL WHERE created_by = ? AND is_global = 0').run(userId);
});

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
const NO_CASCADE_TABLES = ['cardio_log', 'workout_tombstones', 'oauth_state'];

export const purgeUserRows = db.transaction((userId) => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
});
