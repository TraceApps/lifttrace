/**
 * The server's side of the trained-day rule (issue #121): the rows it rests
 * on, read for one account, through the rule itself in
 * src/lib/trained-day.js, which the app uses too.
 */
import db from '../db.js';
import { isCardioEnabled } from './cardio-log.js';
import { trainedDates } from '../../src/lib/trained-day.js';

const _who = (userId) => (userId == null ? 'user_id IS NULL' : 'user_id = ?');
const _args = (userId, ...rest) => (userId == null ? rest : [userId, ...rest]);

/**
 * Whether cardio counts for this account. `override` is what the app says
 * its Track Cardio switch is (`?cardio=1|0`): without accounts that switch
 * lives only in the browser, and the numbers on screen must follow the
 * switch on screen. Otherwise the account's saved setting.
 */
export function cardioCounts(userId, override) {
  if (override === '1' || override === 1 || override === true) return true;
  if (override === '0' || override === 0 || override === false) return false;
  return isCardioEnabled(db, userId);
}

/**
 * The account's trained days, optionally from `start` to `end` (inclusive),
 * as a Set of YYYY-MM-DD. `cardio`: see cardioCounts.
 */
export function trainedDateSet(userId, { start = null, end = null, cardio } = {}) {
  const range = [];
  const params = [];
  if (start) { range.push('date >= ?'); params.push(start); }
  if (end) { range.push('date <= ?'); params.push(end); }
  const and = range.length ? ` AND ${range.join(' AND ')}` : '';
  const workouts = db.prepare(
    `SELECT date, exercises FROM workout_log WHERE ${_who(userId)} AND deleted_at IS NULL${and}`
  ).all(..._args(userId, ...params));
  const on = cardioCounts(userId, cardio);
  const sessions = on
    ? db.prepare(`SELECT date FROM cardio_log WHERE ${_who(userId)}${and}`).all(..._args(userId, ...params))
    : [];
  return trainedDates({ workouts, cardio: sessions, cardioOn: on });
}
