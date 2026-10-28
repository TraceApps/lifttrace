/**
 * An account's own time zone, as its app last said it (issue #121).
 *
 * The app sends its zone (`?tz=`) when it reads a program's week, and the
 * Android app with every sync pull. The last valid one is kept in the
 * account's `timezone` setting, the one the scheduler has always read for
 * its reminders and weekly summary (lib/scheduler.js), so nothing new is
 * stored. It is written only when it changes.
 *
 * Read where the server works out an account's "today" without the account
 * asking: the coach's view of a client, a client's missed prescriptions,
 * MCP get_active_program, /api/v1 and the program.advanced webhook (through
 * program-pause.js), and the streaks. With no zone known, the server's.
 */
import db from '../db.js';
import { dayOf } from './programWeek.js';
import { isValidTimeZone } from './zoned-time.js';

const KEY = 'timezone';

/** The zone kept for `userId`, or undefined (no account, none, or not a real one). */
export function userZone(userId) {
  if (userId == null) return undefined;
  const raw = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, KEY)?.value;
  if (raw == null) return undefined;
  let zone = raw;
  try { zone = JSON.parse(raw); } catch { /* stored bare */ }
  return isValidTimeZone(zone) ? zone : undefined;
}

/** Keep `zone` for `userId` when it's a real zone and differs from the one kept. */
export function rememberZone(userId, zone) {
  if (userId == null || !isValidTimeZone(zone) || userZone(userId) === zone) return;
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  ).run(userId, KEY, JSON.stringify(zone));
}

/** Today (YYYY-MM-DD) for `userId`: in their zone, else the server's. */
export function userToday(userId, now = Date.now()) {
  return dayOf(now, userZone(userId));
}
