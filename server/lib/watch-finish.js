/**
 * watch-finish.js: a workout finished on the watch gets what a workout
 * finished on the phone gets.
 *
 * Finishing on the phone (Diary.svelte finishWorkout) also says so through
 * the account's push service and sends the workout's calories to NutriTrace,
 * both from the phone's own code. The watch can't do either: it has no push
 * settings and no NutriTrace link. So its save says it finished the workout
 * (`finished_on: 'watch'`, routes/workout.js), and when that save is what
 * marks the workout done, the server does both, whether or not the phone app
 * is open. The phone never does them for a finish it didn't make, so each
 * happens once.
 *
 * Without user accounts the server keeps no settings (the phone keeps them),
 * so there is nothing to go by and nothing is sent.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { pushNotifyDefaultOn } from './push-notify.js';
import { estimateWorkoutCalories, ageFromDob } from './workout-calories.js';
import { logWorkoutToNt } from '../routes/nt-federation.js';

function _setting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (row?.value == null) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

const _on = v => v === true || v === 'true' || v === 1;

// Said once a day per account, the way the phone says it once a day
// (celebrateWorkoutComplete), so a workout reopened and finished again
// doesn't say it twice.
const _said = new Map();

/** The finish's notification and calories, for a workout the watch just finished. */
export async function afterWatchFinish(userId, workout) {
  if (userId == null || !workout?.completed) return;
  const name = workout.name || '';

  if (_said.get(userId) !== workout.date) {
    _said.set(userId, workout.date);
    try {
      await pushNotifyDefaultOn(
        userId, 'notifWorkoutComplete', '💪 Workout Complete!',
        name ? `Great session. "${name}" is done!` : 'Great session. All sets complete!',
      );
    } catch (e) { logger.warn(`[watch-finish] push failed for user ${userId}: ${e.message}`); }
  }

  if (!_on(_setting(userId, 'ntFederationEnabled')) || !_on(_setting(userId, 'caloriesBurnedEnabled'))) return;
  const user = db.prepare('SELECT birthday, gender FROM users WHERE id = ?').get(userId);
  const duration = Number(workout.duration_min) || 0;
  const kcal = estimateWorkoutCalories(
    { ...workout, duration_min: duration },
    {
      weight_kg: Number(_setting(userId, 'currentWeightKg')) || null,
      height_cm: Number(_setting(userId, 'heightCm')) || null,
      age: ageFromDob(user?.birthday || null),
      sex: user?.gender || null,
    },
  );
  if (!Number.isFinite(kcal) || kcal <= 0) return;
  const { status, body } = await logWorkoutToNt(userId, {
    date: workout.date,
    name,
    duration_min: duration,
    calories_burned: kcal,
    // The phone's key, so a finish on either device updates one entry.
    external_id: `lt:workout:${workout.date}`,
  });
  if (status !== 200) logger.warn(`[watch-finish] NutriTrace refused for user ${userId}: ${body?.error || status}`);
}
