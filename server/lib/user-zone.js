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
 * program-pause.js), and the streaks. With none kept, the order is:
 *   1. the zone the account's own app said last (kept, above);
 *   2. the zone the coach's browser or app is saying right now (`?tz=` on
 *      the coach's request), when a coach is viewing a client: used for that
 *      one request, never kept as the client's;
 *   3. the server's own zone (what the scheduler and the webhooks, which
 *      have no request, always get when none is kept).
 */
import db from '../db.js';
import { anchorTime, dayOf } from './programWeek.js';
import { isValidTimeZone } from './zoned-time.js';

const KEY = 'timezone';

/** The zone kept for `userId`, or undefined (no account, none, or not a real one). */
export function userZone(userId) {
  if (userId == null) return undefined;
  const raw = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, KEY)?.value;
  if (raw == null) return undefined;
  const zone = _parse(raw);
  return isValidTimeZone(zone) ? zone : undefined;
}

function _parse(raw) {
  try { return JSON.parse(raw); } catch { return raw; /* stored bare */ }
}

/**
 * The zone to work out `userId`'s days in for someone else: the one their
 * app said last, else `fallbackZone` (the coach's, from their request) when
 * it's a real one, else undefined (the server's). Never stores anything.
 */
export function zoneFor(userId, fallbackZone) {
  return userZone(userId) ?? (isValidTimeZone(fallbackZone) ? fallbackZone : undefined);
}

// Two devices of one account in different zones (a laptop on another clock,
// say) would each overwrite the other's zone on every read. A zone that
// differs is taken only when the one kept was written longer ago than this,
// so the kept zone changes at most about twice a day, and a reminder isn't
// worked out in one zone and then the other all day. A first zone, one
// replacing a zone that isn't one, or the same one again, is never held up.
export const ZONE_SETTLE_MS = 12 * 3600 * 1000;

/**
 * Keep `zone` for `userId` when it's a real zone and differs from the one
 * kept, unless the one kept was written under ZONE_SETTLE_MS ago.
 */
export function rememberZone(userId, zone, now = Date.now()) {
  if (userId == null || !isValidTimeZone(zone)) return;
  const row = db.prepare('SELECT value, updated_at FROM user_settings WHERE user_id = ? AND key = ?').get(userId, KEY);
  if (row) {
    const kept = _parse(row.value);
    if (kept === zone) return;
    if (isValidTimeZone(kept)) {
      const age = now - anchorTime(row.updated_at);
      // A stamp that can't be read, or is in the future (a clock set back,
      // a restored backup), holds nothing up.
      if (age >= 0 && age < ZONE_SETTLE_MS) return;
    }
  }
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  ).run(userId, KEY, JSON.stringify(zone));
}

/** Today (YYYY-MM-DD) for `userId`: see zoneFor; the server's when neither is known. */
export function userToday(userId, { fallbackZone, now = Date.now() } = {}) {
  return dayOf(now, zoneFor(userId, fallbackZone));
}
