import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { onWorkoutCompleted } from '../lib/coach-activity.js';

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

// PUT /api/workout/:date — save/update
router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { template_id, program_id, name, exercises, notes, duration_min, completed } = req.body;

  const existing = userId != null
    ? db.prepare('SELECT id FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT id FROM workout_log WHERE date = ? AND user_id IS NULL').get(date);

  // If exercises array is empty, delete the entry instead of keeping an empty record
  if ((!exercises || exercises.length === 0) && existing) {
    db.prepare('DELETE FROM workout_log WHERE id = ?').run(existing.id);
    return res.json({ workout: null });
  }

  const exercisesJson = JSON.stringify(exercises || []);

  // Snapshot the prior completion state — used to decide whether the save
  // represents a fresh completion (and should fire the coach activity / push).
  const wasCompleted = existing
    ? !!db.prepare('SELECT completed FROM workout_log WHERE id = ?').get(existing.id)?.completed
    : false;

  if (existing) {
    db.prepare(
      `UPDATE workout_log SET template_id=?, program_id=?, name=?, exercises=?, notes=?, duration_min=?, completed=?
       WHERE id=?`
    ).run(template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, existing.id);
  } else if (exercises && exercises.length > 0) {
    db.prepare(
      `INSERT INTO workout_log (user_id, date, template_id, program_id, name, exercises, notes, duration_min, completed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, date, template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0);
  } else {
    return res.json({ workout: null });
  }

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

  res.json({ workout });
}));

export default router;
