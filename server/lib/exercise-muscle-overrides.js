import db from '../db.js';
import { validateMuscleLoads } from './muscle-load.js';

function scopedRows(userId, suffix = '') {
  return userId == null
    ? db.prepare(`SELECT * FROM exercise_muscle_overrides WHERE user_id IS NULL ${suffix}`).all()
    : db.prepare(`SELECT * FROM exercise_muscle_overrides WHERE user_id = ? ${suffix}`).all(userId);
}

export function muscleOverrideMap(userId, { includeDeleted = false } = {}) {
  const rows = scopedRows(userId, includeDeleted ? '' : 'AND deleted_at IS NULL');
  const out = new Map();
  for (const row of rows) {
    try { out.set(Number(row.exercise_id), validateMuscleLoads(JSON.parse(row.muscle_loads))); }
    catch { /* malformed legacy row: ignore and use catalog defaults */ }
  }
  return out;
}

export function getMuscleOverride(userId, exerciseId) {
  return muscleOverrideMap(userId).get(Number(exerciseId)) || null;
}

export function saveMuscleOverride(userId, exerciseId, value) {
  const muscleLoads = validateMuscleLoads(value);
  const existing = userId == null
    ? db.prepare('SELECT id FROM exercise_muscle_overrides WHERE user_id IS NULL AND exercise_id = ?').get(exerciseId)
    : db.prepare('SELECT id FROM exercise_muscle_overrides WHERE user_id = ? AND exercise_id = ?').get(userId, exerciseId);
  if (existing) {
    db.prepare(`UPDATE exercise_muscle_overrides
                   SET muscle_loads = ?, deleted_at = NULL, updated_at = datetime('now')
                 WHERE id = ?`).run(JSON.stringify(muscleLoads), existing.id);
  } else {
    db.prepare(`INSERT INTO exercise_muscle_overrides (user_id, exercise_id, muscle_loads)
                VALUES (?, ?, ?)`).run(userId, exerciseId, JSON.stringify(muscleLoads));
  }
  return muscleLoads;
}

export function deleteMuscleOverride(userId, exerciseId) {
  const stmt = userId == null
    ? db.prepare(`UPDATE exercise_muscle_overrides
                     SET deleted_at = datetime('now'), updated_at = datetime('now')
                   WHERE user_id IS NULL AND exercise_id = ? AND deleted_at IS NULL`)
    : db.prepare(`UPDATE exercise_muscle_overrides
                     SET deleted_at = datetime('now'), updated_at = datetime('now')
                   WHERE user_id = ? AND exercise_id = ? AND deleted_at IS NULL`);
  return userId == null ? stmt.run(exerciseId).changes : stmt.run(userId, exerciseId).changes;
}
