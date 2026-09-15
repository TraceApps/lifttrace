/**
 * volume.js — shared volume calculator that honors per-exercise load_type.
 *
 * Modes:
 *   - 'bilateral'  (default): weight × reps                — single load
 *   - 'paired'              : weight × reps × 2            — per-DB / per-side weight
 *   - 'unilateral'          : weight × (reps_l + reps_r)   — alternating one side at a time
 *                            (falls back to weight × reps × 2 when no per-side split is recorded)
 *
 * Used by stats.js, trainer.js, scheduler.js so the server reports the
 * same volume the client renders.
 */
export function setVolume(set, loadType = 'bilateral') {
  if (!set) return 0;
  const w = Number(set.weight) || 0;
  if (w <= 0) return 0;
  if (loadType === 'unilateral') {
    if (set.reps_l != null || set.reps_r != null) {
      const l = Number(set.reps_l) || 0;
      const r = Number(set.reps_r) || 0;
      return w * (l + r);
    }
    return w * (Number(set.reps) || 0) * 2;
  }
  if (loadType === 'paired') return w * (Number(set.reps) || 0) * 2;
  return w * (Number(set.reps) || 0);
}

/**
 * Server-side resolver — server never sees the client's `$exerciseLoadTypes`
 * localStorage per-user pref, so the resolver is a two-tier chain:
 *   per-instance override → library default (if non-null) → 'bilateral'.
 * See src/lib/workout.js resolveLoadType for the full four-tier chain
 * the client uses.
 */
export function resolveLoadType(exercise, libraryLoadType) {
  if (exercise?.load_type) return exercise.load_type;
  if (libraryLoadType) return libraryLoadType;
  return 'bilateral';
}

export function exerciseVolume(exercise, libraryLoadType) {
  if (!exercise) return 0;
  const loadType = resolveLoadType(exercise, libraryLoadType);
  let total = 0;
  for (const s of (exercise.sets || [])) {
    if (!s.completed || s.warmup) continue;
    if (isTimedSet(exercise, s)) continue;
    total += setVolume(s, loadType);
  }
  return total;
}

/**
 * Timed sets (issue #89). Mirror of isTimedSet in src/lib/workout.js;
 * scripts/set-type.test.js runs identical cases through both copies.
 *
 * An explicit choice on the exercise instance wins; without one, a set
 * carrying a duration is timed.
 */
export function isTimedSet(exercise, set) {
  const t = exercise?.set_type;
  if (t === 'time') return true;
  if (t === 'reps') return false;
  return Number(set?.duration_sec) > 0;
}

/**
 * Fold one set into a per-exercise record, the single definition of "a
 * record" used by GET /api/stats/records, get_records over MCP, the REST
 * /api/v1/records route, and the pr.set webhook.
 *
 * Rep sets move maxWeight / maxReps / e1rm exactly as before. Timed sets
 * move maxDuration (longest hold) and maxDurationWeight (the load it was
 * held at) instead, and never touch the rep fields: an estimated 1RM for a
 * wall sit is meaningless, and a heavy weighted carry is not a heavier
 * bench.
 */
export function newRecord(name) {
  return { name, maxWeight: 0, date: '', e1rm: 0, maxDuration: 0, maxDurationWeight: 0, durationDate: '' };
}
export function accumulateRecord(record, exercise, set, date) {
  if (!set?.completed || set.warmup) return;
  if (isTimedSet(exercise, set)) {
    const sec = Number(set.duration_sec) || 0;
    if (sec <= 0) return;
    const w = Number(set.weight) || 0;
    if (sec > record.maxDuration || (sec === record.maxDuration && w > record.maxDurationWeight)) {
      record.maxDuration = sec;
      record.maxDurationWeight = w;
      record.durationDate = date;
    }
    return;
  }
  if (!(set.weight > 0)) return;
  const e1rm = set.reps === 1 ? set.weight : Math.round(set.weight * (1 + set.reps / 30));
  if (set.weight > record.maxWeight) {
    record.maxWeight = set.weight;
    record.maxReps = set.reps;
    record.date = date;
  }
  if (e1rm > record.e1rm) record.e1rm = e1rm;
}
