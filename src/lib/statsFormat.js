/**
 * Shared formatting helpers for the Statistics page and its extracted
 * chart components. Kept as plain functions so they're also usable
 * from Svelte reactive statements without subscribing to stores.
 */

/** Compact volume number: 12 → "12", 4800 → "4.8k", 1234567 → "1.2M". */
export function fmtVol(v) {
  if (!Number.isFinite(v)) return '0';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** Turn a "2026-W17" style ISO week into just "W17" for axis labels. */
export function fmtWeekLabel(w) {
  return w ? w.slice(5) : '';
}

/**
 * Does a records row hold a record? A bodyweight rep exercise has none: the
 * records only track weight, so its row came back with a weight of 0 and no
 * reps and read "0 kg × undefined". A hold, a distance or calories counts
 * without any weight (issues #89, #119).
 */
export function hasRecord(r) {
  return !!r && ((r.maxWeight || 0) > 0 || (r.maxDuration || 0) > 0
    || (r.maxDistance || 0) > 0 || (r.maxCalories || 0) > 0);
}

/** The date a records row's record was set: a hold, distance or calorie
 *  record keeps its own (rep records use `date`). */
export function recordDate(r) {
  return r?.date || r?.durationDate || r?.distanceDate || r?.caloriesDate || '';
}
