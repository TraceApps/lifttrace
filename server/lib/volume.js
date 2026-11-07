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
    if (!isRepSet(exercise, s)) continue;
    total += setVolume(s, loadType);
  }
  return total;
}

/**
 * Set kinds (issues #89, #119). Mirror of setKind / isTimedSet / isRepSet
 * in src/lib/workout.js; scripts/set-type.test.js runs identical cases
 * through both copies.
 *
 * An explicit choice on the exercise instance wins; without one, the set's
 * own data decides: a duration is timed, then a distance, then calories,
 * and anything else is a rep set.
 */
const SET_TYPES = ['reps', 'time', 'distance', 'calories'];
export function setKind(exercise, set) {
  const t = exercise?.set_type;
  if (SET_TYPES.includes(t)) return t;
  if (Number(set?.duration_sec) > 0) return 'time';
  if (Number(set?.distance_m) > 0) return 'distance';
  if (Number(set?.calories) > 0) return 'calories';
  return 'reps';
}
export function isTimedSet(exercise, set) {
  return setKind(exercise, set) === 'time';
}
export function isRepSet(exercise, set) {
  return setKind(exercise, set) === 'reps';
}

/**
 * An Alternating hold timed per side (issue #143): `duration_l_sec` and
 * `duration_r_sec`, with `duration_sec` holding the shorter side, so every
 * reader that knows only `duration_sec` (records, charts, an older app, the
 * watch, an older server) reads the weaker side's hold. Mirrored in
 * server/lib/volume.js and src/lib/workout.js, run through the same cases by
 * scripts/hold-sides.test.js.
 *
 * sideHoldSec: the `duration_sec` two sides give, the shorter one held (a
 * side left at 0 is not timed yet, so it does not count), 0 for none.
 */
export function sideHoldSec(l, r) {
  const held = [l, r].map(v => Math.round(Number(v))).filter(n => Number.isFinite(n) && n > 0);
  return held.length ? Math.min(...held) : 0;
}

/**
 * The sides of a hold timed per side, { l, r } in seconds, or null for a
 * single hold. A set whose `duration_sec` is no longer what its sides give
 * was changed by an app, watch or server that knows only `duration_sec`:
 * that newer single time is the one shown, and the sides it did not know
 * about stay on the set untouched.
 */
export function holdSides(set) {
  if (!set || (set.duration_l_sec == null && set.duration_r_sec == null)) return null;
  if ((Math.round(Number(set.duration_sec)) || 0) !== sideHoldSec(set.duration_l_sec, set.duration_r_sec)) return null;
  return { l: Math.round(Number(set.duration_l_sec)) || 0, r: Math.round(Number(set.duration_r_sec)) || 0 };
}

/**
 * Fold one set into a per-exercise record, the single definition of "a
 * record" used by GET /api/stats/records, get_records over MCP, the REST
 * /api/v1/records route, and the pr.set webhook.
 *
 * Rep sets move maxWeight / maxReps / e1rm exactly as before. Timed sets
 * move maxDuration (longest hold) and maxDurationWeight (the load it was
 * held at), and maxHoldWeight (the heaviest load held, at any length, the
 * Diary's second hold record) instead; distance sets move maxDistance
 * (longest, in meters), maxDistanceWeight and maxDistanceLoad (the heaviest
 * load at any distance); calorie sets move maxCalories (most in one set),
 * maxCaloriesWeight and maxCaloriesLoad. None of them touch the rep fields:
 * an estimated 1RM for a wall sit is meaningless, and a heavy sled push is
 * not a heavier bench. A tie on the amount is broken by the heavier load.
 */
export function newRecord(name) {
  return {
    name, maxWeight: 0, date: '', e1rm: 0,
    maxDuration: 0, maxDurationWeight: 0, maxHoldWeight: 0, durationDate: '',
    maxDistance: 0, maxDistanceWeight: 0, maxDistanceLoad: 0, distanceDate: '',
    maxCalories: 0, maxCaloriesWeight: 0, maxCaloriesLoad: 0, caloriesDate: '',
  };
}
const _AMOUNT = {
  time: ['duration_sec', 'maxDuration', 'maxDurationWeight', 'durationDate', 'maxHoldWeight'],
  distance: ['distance_m', 'maxDistance', 'maxDistanceWeight', 'distanceDate', 'maxDistanceLoad'],
  calories: ['calories', 'maxCalories', 'maxCaloriesWeight', 'caloriesDate', 'maxCaloriesLoad'],
};
export function accumulateRecord(record, exercise, set, date) {
  if (!set?.completed || set.warmup) return;
  const kind = setKind(exercise, set);
  if (kind !== 'reps') {
    const [field, max, maxW, when, load] = _AMOUNT[kind];
    const amount = Number(set[field]) || 0;
    if (amount <= 0) return;
    const w = Number(set.weight) || 0;
    if (w > (record[load] || 0)) record[load] = w;
    if (!(record[max] > 0) || amount > record[max] || (amount === record[max] && w > (record[maxW] || 0))) {
      record[max] = amount;
      record[maxW] = w;
      record[when] = date;
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
