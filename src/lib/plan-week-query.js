/**
 * What a read of a program's week sends with it (issue #121): this device's
 * time zone, so excused days count from the athlete's today rather than the
 * server's, and the Track Cardio switch, so a cardio day on an excused day
 * counts as trained as it does in Statistics. The server reads them in
 * routes/programs.js; the phone's own copy (api-native.js) reads `cardio`.
 */
import { DB } from './db.js';

/** `cardio: false` leaves the switch out (a coach's own says nothing of a client). */
export function planWeekQuery({ cardio: withCardio = true } = {}) {
  const q = new URLSearchParams();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) q.set('tz', tz);
  } catch { /* the server's today, then */ }
  if (withCardio) {
    let on = false;
    try { on = DB.getSetting('cardioEnabled', false) === true; } catch { /* off */ }
    q.set('cardio', on ? '1' : '0');
  }
  return `?${q}`;
}
