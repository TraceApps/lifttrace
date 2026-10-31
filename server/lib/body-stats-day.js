/**
 * body-stats-day.js: a day's measurements meeting an edit after the day was
 * deleted elsewhere (a third-party client's POST /api/sync/push with
 * deleted_at, or a backup restored with such a day in it). Nothing in the
 * app deletes a day, but the row stays (UNIQUE(user_id, date)), so an edit
 * either brings it back or finds it gone, as a workout does
 * (lib/newer-wins.js editBringsBack):
 *   - made before the delete (or in its second): the day stays deleted, and
 *     the edit is answered as gone (410, `gone: true`, which both the web
 *     outbox and the Android queue take as done);
 *   - made after it, or now: the day is back, with only what was measured
 *     after the delete. The measurements it was deleted with are gone with
 *     it: each counts from the time it was last changed, as every field
 *     does (lib/field-sync.js), and an edit queued before the delete loses
 *     to the delete, field by field.
 */
import { editAfterDelete, fieldTimes, toMs } from './newer-wins.js';
import { fieldTime, isoTime } from './field-sync.js';
import { BODY_STAT_KEYS } from './workout-merge.js';

/**
 * The deleted day `row` as a new edit finds it: { stats, times }, the
 * measurements changed after the delete, and field_times (an object) that
 * counts everything else from the delete, so a measurement edited before it
 * (an edit queued with its own time) loses.
 */
export function revivedDay(row) {
  const t = fieldTimes(row);
  const stamp = t.deleted_at;
  const del = Number.isFinite(toMs(stamp)) ? toMs(stamp) : toMs(row?.deleted_at);
  let stats = {};
  try { stats = JSON.parse(row?.stats || '{}') || {}; } catch { /* unreadable: none kept */ }
  const kept = {};
  const times = Number.isFinite(del) ? { _base: isoTime(del) } : {};
  for (const [k, v] of Object.entries(stats)) {
    const at = fieldTime(t, k);
    if (!Number.isFinite(at) || !editAfterDelete(at, stamp, row?.deleted_at)) continue;
    kept[k] = v;
    times[k] = isoTime(at);
  }
  return { stats: kept, times };
}

/** Whether a request's stats are measurements (an object) at all. */
export const isStatsObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** A request's measurements without what isn't one (mergeStatsObject drops
 *  those too): a key such as `deleted_at` or `_base` would be stamped into
 *  field_times as though it were a measurement, and mean something there. */
export const onlyMeasurements = v => (isStatsObject(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => BODY_STAT_KEYS.has(k))) : v);
