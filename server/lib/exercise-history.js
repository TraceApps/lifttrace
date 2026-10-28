/**
 * An exercise's history: every live workout it's in, newest first, with that
 * workout's sets of it. GET /api/workout/history/:exerciseId answers with
 * this, and start_program_workout reads it for last session's weights, the
 * way the Diary's Load Workout reads that route (issue #140).
 */
import db from '../db.js';

export function exerciseHistory(userId, exerciseId) {
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').all(userId)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND deleted_at IS NULL ORDER BY date DESC').all();

  const history = [];
  for (const row of rows) {
    const exercises = JSON.parse(row.exercises || '[]');
    const match = exercises.find(e => e.exercise_id === exerciseId);
    if (match) {
      history.push({ date: row.date, sets: match.sets || [], notes: match.notes, ...(match.set_type ? { set_type: match.set_type } : {}) });
    }
  }
  return history;
}
