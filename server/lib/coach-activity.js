/**
 * coach-activity.js — Records trainer-facing events (member completed a
 * prescribed workout, member missed a dated prescription) and dispatches
 * push notifications to the trainer's configured push service if their
 * `notifMemberCompletes` / `notifMemberMissed` setting is enabled.
 *
 * Called from:
 *   - server/routes/workout.js PUT /:date — after a workout is saved with
 *     completed=1, fires onWorkoutCompleted(...)
 *   - server/lib/scheduler.js — once per day, fires checkMissedPrescriptions()
 *     to flag dated prescriptions whose date has passed without completion
 *
 * UNIQUE(prescription_id, kind) at the DB level keeps repeat events idempotent.
 */

import db from '../db.js';
import { logger } from '../logger.js';
import { pushNotify } from './push-notify.js';

function _getSetting(userId, key, def) {
  if (userId == null) return def;
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _memberLabel(memberId) {
  const row = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(memberId);
  return row?.full_name || row?.username || `Member #${memberId}`;
}

function _templateLabel(prescription) {
  if (prescription.template_id) {
    const t = db.prepare('SELECT name FROM workout_templates WHERE id = ?').get(prescription.template_id);
    if (t?.name) return t.name;
  }
  return prescription.name || 'a workout';
}

/**
 * Fire when a member's workout_log row flips to completed=1. Looks up any
 * coach_prescriptions row matching (member_id, date, template_id) and, if
 * found, records an activity row + notifies the trainer (subject to their
 * setting).
 *
 * @param {object} workout - the saved workout_log row { id, user_id, date, template_id, completed }
 */
export function onWorkoutCompleted(workout) {
  if (!workout || !workout.completed || workout.user_id == null) return;

  // Find the matching prescription. A NULL template_id on the prescription
  // matches any workout on that date (coach said "do something today" without
  // pinning a specific template). A set template_id must match exactly.
  const prescription = db.prepare(`
    SELECT * FROM coach_prescriptions
     WHERE member_id = ? AND date = ?
       AND (template_id IS NULL OR template_id = ?)
     ORDER BY (template_id IS NOT NULL) DESC, created_at DESC
     LIMIT 1
  `).get(workout.user_id, workout.date, workout.template_id || null);

  if (!prescription) return;

  // INSERT OR IGNORE — repeated re-finishes of the same workout are silently
  // deduped by the UNIQUE(prescription_id, kind) index.
  const result = db.prepare(`
    INSERT OR IGNORE INTO coach_activity
      (trainer_id, member_id, kind, prescription_id, workout_id)
    VALUES (?, ?, 'prescription_completed', ?, ?)
  `).run(prescription.trainer_id, prescription.member_id, prescription.id, workout.id);

  if (result.changes === 0) return; // already recorded

  logger.debug?.(`[coach-activity] prescription #${prescription.id} completed by member ${prescription.member_id}`);

  // Notify the trainer if they've opted in. Default true for trainers so the
  // feature is discoverable; users who don't want it can flip it off.
  const optIn = _getSetting(prescription.trainer_id, 'notifMemberCompletes', true);
  if (!optIn) return;

  const memberName = _memberLabel(prescription.member_id);
  const templateName = _templateLabel(prescription);
  pushNotify(
    prescription.trainer_id,
    '✅ Member Completed Workout',
    `${memberName} finished ${templateName}.`,
    4,
  ).catch(() => {});
}

/**
 * Daily scan: any dated prescription whose date is yesterday or earlier and
 * whose member did NOT log a completed workout that day → fire 'missed'
 * activity + notify. Idempotent via the UNIQUE index.
 */
export function checkMissedPrescriptions() {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Pull prescriptions with date <= yesterday that don't have an activity row
  // of either kind yet. completed-kind would have fired on workout-save; if
  // it didn't, we now record 'missed'.
  const rows = db.prepare(`
    SELECT cp.* FROM coach_prescriptions cp
     WHERE cp.date IS NOT NULL
       AND cp.date <= ?
       AND NOT EXISTS (
         SELECT 1 FROM coach_activity ca
          WHERE ca.prescription_id = cp.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM workout_log wl
          WHERE wl.user_id = cp.member_id
            AND wl.date    = cp.date
            AND wl.completed = 1
            AND (cp.template_id IS NULL OR wl.template_id = cp.template_id)
       )
  `).all(yesterday);

  let fired = 0;
  for (const p of rows) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO coach_activity
        (trainer_id, member_id, kind, prescription_id)
      VALUES (?, ?, 'prescription_missed', ?)
    `).run(p.trainer_id, p.member_id, p.id);
    if (result.changes === 0) continue;
    fired++;

    const optIn = _getSetting(p.trainer_id, 'notifMemberMissed', true);
    if (!optIn) continue;

    const memberName = _memberLabel(p.member_id);
    const templateName = _templateLabel(p);
    pushNotify(
      p.trainer_id,
      '⚠️ Prescription Missed',
      `${memberName} didn't log ${templateName} on ${p.date}.`,
      5,
    ).catch(() => {});
  }
  if (fired > 0) logger.debug?.(`[coach-activity] flagged ${fired} missed prescription(s)`);
}
