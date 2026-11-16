/**
 * reminder-plan.js: which days the phone's own reminders fire on.
 *
 * The phone can't check anything when a reminder goes off (the app may not
 * be running), so each reminder is set for the days it applies to, from what
 * the phone knows now, and set again whenever that changes (notifications.js).
 * The days follow the server's reminders (server/lib/scheduler.js) and the
 * shared trained-day rule (trained-day.js):
 *
 * - Workout Reminder: a day not trained yet and not excused.
 * - Streak at Risk: a day not trained, not excused, whose day before was
 *   trained (a streak to lose). Once a day is missed there is no streak, so
 *   no alert until you train again.
 * - Rest Day: a day not trained whose day before was.
 *
 * Streak at Risk and Rest Day can only be known for today and tomorrow: for
 * any later day, the day before hasn't happened yet, and training on it sets
 * them again from here.
 *
 * Pure, with no imports but trained-day.js, so node tests run it.
 */
import { shiftDate } from './trained-day.js';

/**
 * How many days ahead the Workout Reminder is set, today included.
 * shortcut: it stops after this many days without opening the app (each open
 * sets it again); a native check at fire time would remove the limit.
 */
export const WORKOUT_DAYS = 60;

/**
 * `today`: YYYY-MM-DD on this phone. `trained`, `excused`: Sets of dates.
 * `workout`, `streak`, `rest`: which reminders are on.
 * Returns [{ kind: 'workout' | 'streak' | 'rest', offset, day }], `offset`
 * being days from today (0 = today).
 */
export function planReminders({ today, trained = new Set(), excused = new Set(), workout = false, streak = false, rest = false }) {
  const out = [];
  if (workout) {
    for (let offset = 0; offset < WORKOUT_DAYS; offset++) {
      const day = shiftDate(today, offset);
      if (!trained.has(day) && !excused.has(day)) out.push({ kind: 'workout', offset, day });
    }
  }
  for (const offset of [0, 1]) {
    const day = shiftDate(today, offset);
    if (trained.has(day) || !trained.has(shiftDate(day, -1))) continue;
    if (streak && !excused.has(day)) out.push({ kind: 'streak', offset, day });
    if (rest) out.push({ kind: 'rest', offset, day });
  }
  return out;
}

/** The moment a reminder set for `day` at `hhmm` fires, in this phone's time zone. */
export function fireTime(day, hhmm, fallbackHour) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = String(hhmm || '').split(':').map(Number);
  return new Date(y, m - 1, d, Number.isFinite(h) ? h : fallbackHour, Number.isFinite(min) ? min : 0, 0, 0);
}
