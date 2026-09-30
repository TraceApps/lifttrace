import db from '../db.js';

export const RECOVERY_MUSCLES = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms',
  'core', 'quads', 'hamstrings', 'glutes', 'calves',
];

export const RECOVERY_STATE_HOURS = {
  Fatigued: 12,
  Recovering: 36,
  Ready: 60,
  Fresh: 84,
};

function validateMuscle(muscle) {
  const value = String(muscle || '').toLowerCase();
  if (!RECOVERY_MUSCLES.includes(value)) throw new Error('Unknown muscle group');
  return value;
}

function validateState(state) {
  if (!Object.hasOwn(RECOVERY_STATE_HOURS, state)) throw new Error('Invalid recovery state');
  return state;
}

function scopedRow(userId, muscle) {
  return userId == null
    ? db.prepare('SELECT * FROM muscle_recovery_adjustments WHERE user_id IS NULL AND muscle = ?').get(muscle)
    : db.prepare('SELECT * FROM muscle_recovery_adjustments WHERE user_id = ? AND muscle = ?').get(userId, muscle);
}

export function listRecoveryAdjustments(userId, { includeDeleted = false } = {}) {
  const deleted = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return userId == null
    ? db.prepare(`SELECT * FROM muscle_recovery_adjustments WHERE user_id IS NULL ${deleted} ORDER BY muscle`).all()
    : db.prepare(`SELECT * FROM muscle_recovery_adjustments WHERE user_id = ? ${deleted} ORDER BY muscle`).all(userId);
}

export function saveRecoveryAdjustment(userId, muscle, state, basisWorkoutTimestamp = null, adjustedAt = new Date().toISOString()) {
  const cleanMuscle = validateMuscle(muscle);
  const cleanState = validateState(state);
  if (basisWorkoutTimestamp != null && typeof basisWorkoutTimestamp !== 'string') {
    throw new Error('Invalid workout basis');
  }
  const adjustedMs = Date.parse(adjustedAt);
  if (!Number.isFinite(adjustedMs) || adjustedMs > Date.now() + 5 * 60 * 1000) {
    throw new Error('Invalid adjustment time');
  }
  const existing = scopedRow(userId, cleanMuscle);
  const values = [RECOVERY_STATE_HOURS[cleanState], adjustedAt, basisWorkoutTimestamp];
  if (existing) {
    db.prepare(`UPDATE muscle_recovery_adjustments
                   SET effective_age_hours = ?, adjusted_at = ?, basis_workout_timestamp = ?,
                       deleted_at = NULL, updated_at = datetime('now')
                 WHERE id = ?`).run(...values, existing.id);
  } else {
    db.prepare(`INSERT INTO muscle_recovery_adjustments
                  (user_id, muscle, effective_age_hours, adjusted_at, basis_workout_timestamp)
                VALUES (?, ?, ?, ?, ?)`)
      .run(userId, cleanMuscle, ...values);
  }
  return { ...scopedRow(userId, cleanMuscle), state: cleanState };
}

export function deleteRecoveryAdjustment(userId, muscle) {
  const cleanMuscle = validateMuscle(muscle);
  const existing = scopedRow(userId, cleanMuscle);
  if (!existing || existing.deleted_at) return 0;
  return db.prepare(`UPDATE muscle_recovery_adjustments
                       SET deleted_at = datetime('now'), updated_at = datetime('now')
                     WHERE id = ?`).run(existing.id).changes;
}
