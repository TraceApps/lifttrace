import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { onWorkoutCompleted } from '../lib/coach-activity.js';
import { mergeExercises, ensureExerciseUuids } from '../lib/workout-merge.js';

const router = Router();
router.use(requireAuth);

// Static routes MUST come before parameterized /:date routes

// GET /api/workout/recent — last N workout entries
router.get('/recent', wrap((req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND deleted_at IS NULL ORDER BY date DESC LIMIT ?').all(limit);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  res.json(rows);
}));

// GET /api/workout/history/:exerciseId — all entries containing this exercise
router.get('/history/:exerciseId', wrap((req, res) => {
  const exerciseId = parseInt(req.params.exerciseId);
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').all(userId)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND deleted_at IS NULL ORDER BY date DESC').all();

  const history = [];
  for (const row of rows) {
    const exercises = JSON.parse(row.exercises || '[]');
    const match = exercises.find(e => e.exercise_id === exerciseId);
    if (match) {
      history.push({ date: row.date, sets: match.sets || [], notes: match.notes });
    }
  }
  res.json(history);
}));

// Default-session lookup (issue #76): a date can now have multiple
// workout_log rows. Every route that doesn't take an explicit session
// selector picks the lowest session_seq (0 = the original/only session),
// falling back to the lowest id if session 0 was ever deleted — so a
// caller that never asks about sessions keeps hitting the one row that
// exists for anyone who's never created a second session. Mirrors PUT/
// DELETE's pre-#76 behavior of not filtering deleted_at, so a soft-deleted
// row can still be found/resurrected by an explicit save.
function _defaultWorkout(userId, date, { excludeDeleted = false } = {}) {
  const delClause = excludeDeleted ? 'AND deleted_at IS NULL' : '';
  return userId != null
    ? db.prepare(`SELECT * FROM workout_log WHERE date = ? AND user_id = ? ${delClause} ORDER BY session_seq ASC, id ASC LIMIT 1`).get(date, userId)
    : db.prepare(`SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL ${delClause} ORDER BY session_seq ASC, id ASC LIMIT 1`).get(date);
}

// Resolve which row a request targets: explicit ?id=/body.id wins (must
// still belong to this user + date, so a client can't cross-target
// another day's or another user's row), otherwise the default session.
function _resolveWorkout(userId, date, explicitId, opts) {
  if (explicitId != null) {
    return userId != null
      ? db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND date = ?').get(explicitId, userId, date)
      : db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id IS NULL AND date = ?').get(explicitId, date);
  }
  return _defaultWorkout(userId, date, opts);
}

function _enrichWorkout(workout) {
  if (!workout) return workout;
  workout.exercises = JSON.parse(workout.exercises || '[]');
  // Surface the program's plan length alongside the stamped program_week so
  // the diary can render "Week N of M" without a second request.
  if (workout.program_id) {
    workout.program_duration_weeks =
      db.prepare('SELECT duration_weeks FROM programs WHERE id = ?').get(workout.program_id)?.duration_weeks ?? null;
  }
  // Include any coach feedback left on this workout so the member's diary
  // can render it inline (workout-level banner + per-exercise notes).
  workout.feedback = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.note, cf.updated_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(workout.id);
  return workout;
}

// GET /api/workout/:date/feedback — coach notes attached to that day's
// workout. Returned separately from the workout GET because the diary
// workout GET is served local-first in native+server mode (cached in
// local SQLite which doesn't have the coach_feedback table), so feedback
// would be invisible until a cache miss. This path is NOT in the local-
// first pattern list, so the client always reaches the server when
// online and renders feedback fresh. Optional ?id= targets a specific
// session; default is the same session GET /:date would return.
router.get('/:date/feedback', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const explicitId = req.query.id != null ? parseInt(req.query.id) : null;
  const workout = _resolveWorkout(userId, req.params.date, explicitId, { excludeDeleted: true });
  if (!workout) return res.json([]);
  const rows = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.note, cf.updated_at,
           cf.seen_by_member_at, cf.member_reply, cf.member_replied_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name,
           u.avatar_url AS trainer_avatar_url
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(workout.id);
  // Intentionally NOT auto-marking seen here. The inbox badge needs to
  // persist until the member acts on it; auto-marking on every diary
  // load (which fires on every date switch + sync tick) cleared the
  // unread count before the user could ever see it.
  res.json(rows);
}));

// GET /api/workout/:date/sessions — every session logged that date
// (issue #76), each enriched exactly like the single-session GET below.
// Excludes soft-deleted rows — a deleted session isn't something a
// session-switcher UI should ever offer to switch to.
router.get('/:date/sessions', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC').all(date, userId)
    : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC').all(date);
  res.json({ sessions: rows.map(_enrichWorkout) });
}));

// GET /api/workout/:date — returns the default session only (issue #76:
// a date may have more than one; session-aware callers use the
// /:date/sessions list above). Zero response-shape change for every
// existing caller when there's exactly one session that date.
router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const workout = _defaultWorkout(userId, date, { excludeDeleted: true });
  res.json({ workout: _enrichWorkout(workout) || null });
}));

// ── Tombstone helpers (Option C) ─────────────────────────────────────────
// Loaded here rather than in a shared module to keep this route file
// self-contained; sync.js and _workout-write.js have their own copies for
// the same reason. Scoped by workout_id (issue #76) so a deletion
// tombstone applies to one session, not every session on that date — 0 is
// the sentinel for tombstone kinds with no specific row (matches the
// column's own NOT NULL DEFAULT 0 in db.js).
function _tsWhere(u) { return u == null ? 'user_id IS NULL' : 'user_id = ?'; }
function _loadExerciseTombstoneUuids(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'exercise'`);
  const rows = u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
  return rows.map(r => r.uuid);
}
function _loadSetTombstoneUuidsByExercise(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'set'`);
  const rows = u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
  const out = {};
  for (const r of rows) {
    (out[r.ex_uuid] = out[r.ex_uuid] || []).push(r.uuid);
  }
  return out;
}
function _loadTombstones(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT kind, ex_uuid, uuid, deleted_at FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ?`);
  return u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
}

// PUT /api/workout/:date — save/update
//
// Merge semantics (Option C, 2026-08-11 port from NutriTrace): the
// exercises array is now merged per-uuid rather than replaced wholesale,
// and each exercise's sets[] is merged per-uuid too. Prior behavior
// wiped a full workout session when a stale mobile client PUT an empty
// exercises array — that DELETE-on-empty shortcut is removed; day-level
// deletion now requires an explicit `DELETE /api/workout/:date`. See
// project_traceapps_diary_merge_port for the shared design.
router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { template_id, program_id, name, exercises, notes, duration_min, completed, program_week, id: bodyId, new_session } = req.body;

  // Parse per-uuid deletions in either shape (per-kind object or a flat
  // exercise-only list from an older client).
  const deletedRaw = req.body.deleted_uuids;
  const deletedExUuids = Array.isArray(deletedRaw?.exercises) ? deletedRaw.exercises
    : Array.isArray(deletedRaw) ? deletedRaw
    : [];
  const deletedSetsByEx = (deletedRaw && typeof deletedRaw.sets === 'object' && !Array.isArray(deletedRaw.sets))
    ? deletedRaw.sets
    : {};

  // Resolve the target row (issue #76). new_session:true always creates a
  // fresh row, bypassing the existing-row lookup entirely, so "start a
  // new session" can never accidentally land on one that already exists.
  // Otherwise an explicit id targets that specific session; absent both,
  // the default-session lookup reproduces pre-#76 single-row behavior
  // exactly (including resurrecting a soft-deleted row on save).
  const existing = new_session ? null : _resolveWorkout(userId, date, bodyId ?? null);
  const serverExercises = existing ? JSON.parse(existing.exercises || '[]') : [];

  const priorExTombstones  = existing ? _loadExerciseTombstoneUuids(userId, date, existing.id) : [];
  const priorSetTombstones = existing ? _loadSetTombstoneUuidsByExercise(userId, date, existing.id) : {};

  const {
    merged: mergedExercises,
    newTombstoneExerciseUuids: newExTombstones,
    newTombstoneSetUuidsByExercise: newSetTombstones,
  } = mergeExercises(
    serverExercises, ensureExerciseUuids(exercises || []),
    deletedExUuids, priorExTombstones,
    deletedSetsByEx, priorSetTombstones
  );

  // Insert-if-new; otherwise UPDATE. An empty merged list is still a
  // legitimate state (e.g. new day where the client only pushed
  // metadata); it no longer triggers row deletion. The explicit
  // `DELETE /api/workout/:date` route below handles day-level deletion.
  const wasCompleted = existing ? !!existing.completed : false;
  const exercisesJson = JSON.stringify(mergedExercises);

  const insertTombstone = db.prepare(
    `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );

  let targetId;
  db.transaction(() => {
    if (existing) {
      targetId = existing.id;
      // Clear deleted_at on save so an explicit UPDATE resurrects a
      // row that a client had previously soft-deleted (sync-push at
      // sync.js line 368). Without this, GETs would keep filtering it
      // out even after the user re-adds a workout on that date.
      db.prepare(
        `UPDATE workout_log SET template_id=?, program_id=?, name=?, exercises=?, notes=?, duration_min=?, completed=?, program_week=?, deleted_at=NULL
         WHERE id=?`
      ).run(template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null, existing.id);
    } else {
      // A brand-new row: either the very first session for this date
      // (default path, session_seq=0 — identical to pre-#76 behavior) or
      // an explicit additional session (new_session:true, next
      // session_seq for this date).
      const seqRow = new_session
        ? (userId != null
            ? db.prepare('SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
            : db.prepare('SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE date = ? AND user_id IS NULL').get(date))
        : null;
      const nextSeq = seqRow ? seqRow.n : 0;
      const info = db.prepare(
        `INSERT INTO workout_log (user_id, date, template_id, program_id, name, exercises, notes, duration_min, completed, program_week, session_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, date, template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null, nextSeq);
      targetId = info.lastInsertRowid;
    }
    for (const uuid of newExTombstones) insertTombstone.run(userId, date, targetId, 'exercise', '', uuid);
    for (const [exUuid, uuids] of Object.entries(newSetTombstones)) {
      for (const uuid of uuids) insertTombstone.run(userId, date, targetId, 'set', exUuid, uuid);
    }
  })();

  const workout = _enrichWorkout(db.prepare('SELECT * FROM workout_log WHERE id = ?').get(targetId));

  // Fire coach activity / push for prescribed workouts when the save flips
  // the row to completed. Idempotent on the DB side via UNIQUE(prescription_id,
  // kind), so a reopen + refinish still only fires once.
  if (workout && workout.completed && !wasCompleted) {
    try { onWorkoutCompleted(workout); }
    catch (e) { /* never let a notification failure block the save */ }
  }

  res.json({ workout, tombstones: _loadTombstones(userId, date, targetId) });
}));

// DELETE /api/workout/:date — explicit day-level deletion. Optional ?id=
// targets a specific session (issue #76); absent, deletes the same
// default session GET /:date would return — if an old client that has no
// concept of a second session fires this on a date that now has several,
// deleting only the default one (not all of them) is the conservative
// behavior; silently wiping sessions that client doesn't know exist would
// be far worse.
//
// Replaces the old "empty exercises array on PUT deletes the row"
// shortcut, which was the shape that let a stale mobile client wipe an
// entire workout session under the pre-merge behavior. Now day-level
// deletion is an explicit intent, not something the server can infer
// from an accidentally-empty payload.
router.delete('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const explicitId = req.query.id != null ? parseInt(req.query.id) : null;
  const existing = _resolveWorkout(userId, date, explicitId);
  if (!existing) return res.json({ ok: true, deleted: false });
  db.prepare('DELETE FROM workout_log WHERE id = ?').run(existing.id);
  res.json({ ok: true, deleted: true });
}));

export default router;
