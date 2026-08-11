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
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? ORDER BY date DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL ORDER BY date DESC LIMIT ?').all(limit);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  res.json(rows);
}));

// GET /api/workout/history/:exerciseId — all entries containing this exercise
router.get('/history/:exerciseId', wrap((req, res) => {
  const exerciseId = parseInt(req.params.exerciseId);
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? ORDER BY date DESC').all(userId)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL ORDER BY date DESC').all();

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

// GET /api/workout/:date/feedback — coach notes attached to that day's
// workout. Returned separately from the workout GET because the diary
// workout GET is served local-first in native+server mode (cached in
// local SQLite which doesn't have the coach_feedback table), so feedback
// would be invisible until a cache miss. This path is NOT in the local-
// first pattern list, so the client always reaches the server when
// online and renders feedback fresh.
router.get('/:date/feedback', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const workout = db.prepare(
    'SELECT id FROM workout_log WHERE date = ? AND user_id = ?'
  ).get(req.params.date, userId);
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

// GET /api/workout/:date
router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const workout = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL').get(date);

  if (workout) {
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
  }
  res.json({ workout: workout || null });
}));

// ── Tombstone helpers (Option C) ─────────────────────────────────────────
// Loaded here rather than in a shared module to keep this route file
// self-contained; sync.js has its own copies for the same reason.
function _tsWhere(u) { return u == null ? 'user_id IS NULL' : 'user_id = ?'; }
function _loadExerciseTombstoneUuids(u, date) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT uuid FROM workout_tombstones WHERE ${where} AND date = ? AND kind = 'exercise'`);
  const rows = u == null ? stmt.all(date) : stmt.all(u, date);
  return rows.map(r => r.uuid);
}
function _loadSetTombstoneUuidsByExercise(u, date) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE ${where} AND date = ? AND kind = 'set'`);
  const rows = u == null ? stmt.all(date) : stmt.all(u, date);
  const out = {};
  for (const r of rows) {
    (out[r.ex_uuid] = out[r.ex_uuid] || []).push(r.uuid);
  }
  return out;
}
function _loadTombstones(u, date) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT kind, ex_uuid, uuid, deleted_at FROM workout_tombstones WHERE ${where} AND date = ?`);
  return u == null ? stmt.all(date) : stmt.all(u, date);
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
  const { template_id, program_id, name, exercises, notes, duration_min, completed, program_week } = req.body;

  // Parse per-uuid deletions in either shape (per-kind object or a flat
  // exercise-only list from an older client).
  const deletedRaw = req.body.deleted_uuids;
  const deletedExUuids = Array.isArray(deletedRaw?.exercises) ? deletedRaw.exercises
    : Array.isArray(deletedRaw) ? deletedRaw
    : [];
  const deletedSetsByEx = (deletedRaw && typeof deletedRaw.sets === 'object' && !Array.isArray(deletedRaw.sets))
    ? deletedRaw.sets
    : {};

  const existing = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL').get(date);
  const serverExercises = existing ? JSON.parse(existing.exercises || '[]') : [];

  const priorExTombstones  = _loadExerciseTombstoneUuids(userId, date);
  const priorSetTombstones = _loadSetTombstoneUuidsByExercise(userId, date);

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
    `INSERT OR IGNORE INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );

  db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE workout_log SET template_id=?, program_id=?, name=?, exercises=?, notes=?, duration_min=?, completed=?, program_week=?
         WHERE id=?`
      ).run(template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO workout_log (user_id, date, template_id, program_id, name, exercises, notes, duration_min, completed, program_week)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, date, template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null);
    }
    for (const uuid of newExTombstones) insertTombstone.run(userId, date, 'exercise', '', uuid);
    for (const [exUuid, uuids] of Object.entries(newSetTombstones)) {
      for (const uuid of uuids) insertTombstone.run(userId, date, 'set', exUuid, uuid);
    }
  })();

  const workout = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL').get(date);
  if (workout) workout.exercises = JSON.parse(workout.exercises || '[]');

  // Fire coach activity / push for prescribed workouts when the save flips
  // the row to completed. Idempotent on the DB side via UNIQUE(prescription_id,
  // kind), so a reopen + refinish still only fires once.
  if (workout && workout.completed && !wasCompleted) {
    try { onWorkoutCompleted(workout); }
    catch (e) { /* never let a notification failure block the save */ }
  }

  res.json({ workout, tombstones: _loadTombstones(userId, date) });
}));

// DELETE /api/workout/:date — explicit day-level deletion.
//
// Replaces the old "empty exercises array on PUT deletes the row"
// shortcut, which was the shape that let a stale mobile client wipe an
// entire workout session under the pre-merge behavior. Now day-level
// deletion is an explicit intent, not something the server can infer
// from an accidentally-empty payload.
router.delete('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const existing = userId != null
    ? db.prepare('SELECT id FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT id FROM workout_log WHERE date = ? AND user_id IS NULL').get(date);
  if (!existing) return res.json({ ok: true, deleted: false });
  db.prepare('DELETE FROM workout_log WHERE id = ?').run(existing.id);
  res.json({ ok: true, deleted: true });
}));

export default router;
