/**
 * planned-workout.js: one rule for the sets a program's workout day plans,
 * and for logging a done set into them (issue #140).
 *
 * Two copies, kept byte for byte the same: src/lib/planned-workout.js (the
 * Diary's Load Workout and Trace's start_workout_from_template and log_set,
 * in the browser and the Android app, standalone and connected) and
 * server/lib/planned-workout.js (start_program_workout and log_set over MCP
 * and /api/v1). Change both; scripts/planned-workout.test.js checks they
 * are the same file and runs them through the same cases. No imports, so it
 * runs unchanged in the browser, the Android WebView and Node.
 */

/** What a lifter who never changed these settings has, on every device and
 *  on the server: Auto-Fill Last Weights on, Auto Warm-Ups off, pounds. */
export const PLAN_SETTING_DEFAULTS = Object.freeze({
  autoFillLastWeights: true,
  autoGenerateWarmups: false,
  weightUnit: 'lbs',
});

/**
 * Parse a typed duration to whole seconds. Returns null for anything that
 * isn't one.
 *
 * Bare digits fill from the right like a microwave or a phone timer: the last
 * two digits are seconds and anything before them is minutes. That is what
 * the set row's number pad produces, and it avoids making anyone convert
 * "2 minutes" into 120.
 *
 *   "45"   -> 45      "130" -> 90 (1:30)     "200" -> 120 (2:00)
 *   "90"   -> 90      overflowing seconds carry, as on a microwave
 *   "1:30" -> 90      "0:90" -> 90           "1:02:05" -> 3725
 *   "45s"  -> 45      "2m" / "2min" -> 120   "1m30s" -> 90
 */
export function parseDuration(input) {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;
  // m:ss. Seconds may overflow ("0:90"), because that is exactly what the
  // digit mask shows mid-typing and the two must read the same.
  if (/^\d+:\d{1,2}$/.test(str)) {
    const [m, sec] = str.split(':').map(Number);
    const total = m * 60 + sec;
    return total > 0 ? total : null;
  }
  if (/^\d+:\d{1,2}:\d{1,2}$/.test(str)) {
    const parts = str.split(':').map(Number);
    if (parts.slice(1).some(p => p >= 60)) return null;
    const total = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return total > 0 ? total : null;
  }
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    const total = Math.floor(n / 100) * 60 + (n % 100);
    return total > 0 ? total : null;
  }
  const m = str.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const sec = Math.round((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
  return sec > 0 ? sec : null;
}

/**
 * The most recent session in an exercise's history (newest first, as
 * GET /api/workout/history/:id returns it) with at least one completed
 * working set. History also lists sessions where the exercise was added but
 * nothing was ticked, such as today's unfinished workout, so the first entry
 * isn't necessarily the last completed session (issue #103).
 *
 * Returns { ...entry, completed, working }: every completed set (the Last
 * Time row shows these, warm-ups included) and the completed working sets
 * (what auto-fill copies, since a warm-up weight is not a working weight).
 * Null when there is no such session.
 *
 * `before` is the diary's date. History includes that day, so the session
 * being logged came back as its own "last time" once a set was ticked, and a
 * day viewed in the past compared itself with later ones. Only days before it
 * count, as on the watch's "Last time"; the PR badges and celebrations leave
 * the day out too, so a second session the same day is not "last time" either.
 */
export function lastCompletedSession(history, { before } = {}) {
  for (const entry of history || []) {
    if (before && !(typeof entry?.date === 'string' && entry.date < before)) continue;
    const completed = (entry?.sets || []).filter(s => s?.completed);
    const working = completed.filter(s => !s.warmup);
    if (working.length) return { ...entry, completed, working };
  }
  return null;
}

/**
 * Generate a reasonable warm-up progression from a working weight.
 * Classic 5-step ramp: bar x 8, 50% x 5, 70% x 3, 85% x 2, then the working set.
 * Returns only the warm-up sets (up to 4); caller appends working sets.
 * If the working weight is at or below the empty bar, returns [] (no warm-up
 * needed for bodyweight / light accessory work).
 *
 * Each step is rounded to the plate step (2.5 kg / 5 lbs) and kept only when
 * it is heavier than the set before it and lighter than the working weight,
 * so the ramp only ever climbs, never repeats a weight and never drops below
 * the bar. A light load gets fewer steps (25 kg: bar x 8, 22.5 x 2), not a
 * ramp that goes down.
 */
export function generateWarmupSets(workingWeight, unit = 'lbs') {
  const W = parseFloat(workingWeight) || 0;
  const bar = unit === 'kg' ? 20 : 45;
  const step = unit === 'kg' ? 2.5 : 5;
  const roundTo = (n) => Math.round(n / step) * step;
  if (W <= bar) return [];
  const base = { completed: false, warmup: true, notes: '' };
  const sets = [{ ...base, weight: bar, reps: 8 }];
  let last = bar;
  for (const [pct, reps] of [[0.5, 5], [0.7, 3], [0.85, 2]]) {
    const weight = roundTo(W * pct);
    if (weight > last && weight < W) {
      sets.push({ ...base, weight, reps });
      last = weight;
    }
  }
  return sets;
}

// Distances (issue #119) are kept in meters and shown in a unit: meters or
// yards for a rower, sled or carry, kilometers or miles for a run or a ride,
// following the account's weight unit (lbs reads as imperial). Here rather
// than in workout.js so the server plans with the same default.
export const METERS_PER = { m: 1, km: 1000, yd: 0.9144, mi: 1609.344 };
const LONG_DISTANCE_BY_NAME = new Set([
  'running treadmill', 'jogging treadmill', 'walking treadmill', 'trail running walking',
  'run', 'running', 'bicycling', 'cycling',
]);
export const exerciseNameKey = (name) => String(name || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function defaultDistanceUnit(name, imperial = false) {
  const long = LONG_DISTANCE_BY_NAME.has(exerciseNameKey(name));
  if (imperial) return long ? 'mi' : 'yd';
  return long ? 'km' : 'm';
}

// A prescribed distance is kept as typed, in the exercise's distance_unit;
// sets hold meters. A prescribed calorie count is a whole number. Both read
// as null when empty or not a number.
function _plannedMeters(typed, ex, weightUnit) {
  const n = parseFloat(String(typed ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = METERS_PER[ex?.distance_unit] ? ex.distance_unit : defaultDistanceUnit(ex?.exercise_name, weightUnit === 'lbs');
  return Math.round(n * METERS_PER[unit] * 1000) / 1000;
}
// A set's reps with reps split left/right counted at the weaker side, as
// setReps in src/lib/workout.js and server/lib/volume.js counts them (this
// file takes no imports), so a set an older app left with `reps` above its
// weaker side plans from the weaker side.
function _setReps(s) {
  const sides = [s?.reps_l, s?.reps_r].filter(v => v != null && v !== '').map(Number).filter(Number.isFinite);
  return sides.length ? Math.min(...sides) : s?.reps;
}

function _plannedCalories(typed) {
  const n = Math.round(parseFloat(String(typed ?? '')));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Effective prescription for a given 1-based plan week (issue #13).
 * Merges the exercise's weeks[wk-1] entry over its exercise-level defaults;
 * absent weeks[] / week / a missing weeks[wk-1] slot falls back to the flat
 * target_* base, matching WorkoutEditor's fieldFor so the same template
 * resolves to identical targets in both views.
 */
export function resolveWeek(ex, wk) {
  const base = {
    sets: ex.target_sets, reps: ex.target_reps, weight: ex.target_weight,
    duration: ex.target_duration,
    distance: ex.target_distance, calories: ex.target_calories,
    tempo: ex.tempo, rest_sec: ex.rest_sec,
  };
  if (!wk || !ex.weeks?.length) return base;
  const w = ex.weeks[wk - 1];
  if (!w) return base;
  return {
    sets: w.sets ?? base.sets,
    reps: w.reps ?? base.reps,
    weight: w.weight ?? base.weight,
    duration: w.duration ?? base.duration,
    distance: w.distance ?? base.distance,
    calories: w.calories ?? base.calories,
    tempo: w.tempo ?? base.tempo,
    rest_sec: w.rest_sec ?? base.rest_sec,
  };
}

/**
 * A workout day's exercises with the sets to do, nothing ticked yet: what
 * Load Workout puts in the Diary, and what start_program_workout saves.
 *
 *   templateExercises  the day's exercises as the program stores them
 *   planWeek           the plan week it's done in (the active program's
 *                      current week), or null for any other program
 *   lastSets(ex, i)    every completed set of the last session of that
 *                      exercise before the day, warm-ups included, or null
 *                      (none, or Auto-Fill Last Weights off)
 *   autoWarmups        Auto Warm-Ups on
 *   weightUnit         'kg' or 'lbs', for the bar the warm-ups start from
 *
 * Ids are left as the template has them: the caller gives every exercise
 * and set new ones (withFreshIds, issue #99).
 */
export function buildPlannedExercises(templateExercises, { planWeek = null, lastSets = () => null, autoWarmups = false, weightUnit = 'lbs' } = {}) {
  const list = Array.isArray(templateExercises) ? templateExercises : [];
  const exercises = list.map((ex, i) => {
    // Last session split into warm-ups and working sets: a template's
    // warm-up rows fill from last time's warm-ups and its working rows from
    // last time's working sets, so the two never trade weights (issue #103).
    const lastAll = lastSets(ex, i) || null;
    const lastWorking = lastAll ? lastAll.filter(s => !s.warmup) : null;
    const lastWarmups = lastAll ? lastAll.filter(s => s.warmup) : [];
    // This week's prescription. When the exercise carries a weeks[] matrix
    // and it's the active program, the plan value wins over last-session
    // progressive-overload memory for the current week.
    const eff = resolveWeek(ex, planWeek);
    const planWins = !!(planWeek && ex.weeks?.length);
    let sets;
    if (ex.set_specs && ex.set_specs.length > 0) {
      // Per-set targets defined in the template: used as the target
      // weight/reps.
      let workIdx = 0, warmIdx = 0;
      sets = ex.set_specs.map((spec) => {
        const past = spec.warmup ? lastWarmups[warmIdx++] : lastWorking?.[workIdx++];
        const parsedWeight = parseFloat(spec.weight);
        const parsedReps = parseInt(spec.reps);
        const parsedRepsL = parseInt(spec.reps_l);
        const parsedRepsR = parseInt(spec.reps_r);
        const set = {
          weight: Number.isFinite(parsedWeight) ? parsedWeight : (past?.weight ?? 0),
          reps: Number.isFinite(parsedReps) ? parsedReps : (_setReps(past) ?? 0),
          completed: false,
          notes: '',
        };
        if (ex.set_type === 'time') {
          const dur = parseDuration(spec.duration) ?? past?.duration_sec ?? 0;
          if (dur) set.duration_sec = dur;
        } else if (ex.set_type === 'distance') {
          const m = _plannedMeters(spec.distance, ex, weightUnit) ?? past?.distance_m ?? 0;
          if (m) set.distance_m = m;
        } else if (ex.set_type === 'calories') {
          const cal = _plannedCalories(spec.calories) ?? past?.calories ?? 0;
          if (cal) set.calories = cal;
        }
        // Asymmetric supersets: the template can pin a set to a specific
        // round via spec.number. Falls back to position when unset, matching
        // the diary's display convention.
        if (spec.number != null) set.number = spec.number;
        // Warm-up from the template: SetRow leaves warm-ups out of volume,
        // PRs and superset-round gating.
        if (spec.warmup) set.warmup = true;
        // RPE target from the template, shown in the RPE chip when Track RPE
        // is on, and editable.
        if (spec.rpe != null) set.rpe = spec.rpe;
        // Unilateral L/R split target: SetRow shows L/R inputs when the set
        // has reps_l/reps_r.
        if (Number.isFinite(parsedRepsL)) set.reps_l = parsedRepsL;
        if (Number.isFinite(parsedRepsR)) set.reps_r = parsedRepsR;
        // ...and `reps` is the weaker side, as the Diary row keeps it.
        if (set.reps_l != null || set.reps_r != null) set.reps = _setReps(set);
        return set;
      });
    } else {
      const numSets = eff.sets || 1;
      // This week's uniform target weight/reps: the fallback when there's
      // no last-session history to pull from.
      const tplWeight = parseFloat(eff.weight);
      const tplReps = parseInt(eff.reps);
      const baseWeight = Number.isFinite(tplWeight) ? tplWeight : 0;
      const baseReps = Number.isFinite(tplReps) ? tplReps : 0;
      if (lastWorking && !planWins) {
        // Prior session wins (progressive-overload memory); template values
        // fill any gaps beyond what the last session had. Inside a
        // periodized block (planWins) this is skipped so the plan's week
        // isn't overwritten by last week's logged load.
        sets = Array.from({ length: numSets }, (_, i) => ({
          weight: lastWorking[i]?.weight ?? lastWorking[lastWorking.length - 1]?.weight ?? baseWeight,
          reps: _setReps(lastWorking[i]) ?? _setReps(lastWorking[lastWorking.length - 1]) ?? baseReps,
          completed: false,
          notes: '',
        }));
      } else {
        // No history, or the plan wins: this week's planned weight/reps.
        sets = Array.from({ length: numSets }, () => ({
          weight: baseWeight, reps: baseReps, completed: false, notes: '',
        }));
      }
      // Timed exercise (issue #89): the prescribed duration, or the last
      // session's when history wins, fills each set.
      // Distance and calorie exercises (issue #119) fill the same way.
      const amount = ex.set_type === 'time' ? ['duration_sec', parseDuration(eff.duration) || 0]
        : ex.set_type === 'distance' ? ['distance_m', _plannedMeters(eff.distance, ex, weightUnit) || 0]
        : ex.set_type === 'calories' ? ['calories', _plannedCalories(eff.calories) || 0]
        : null;
      if (amount) {
        const [field, planned] = amount;
        sets = sets.map((set, i) => {
          const fromLast = (lastWorking && !planWins)
            ? (lastWorking[i]?.[field] ?? lastWorking[lastWorking.length - 1]?.[field])
            : null;
          const value = fromLast || planned;
          return value ? { ...set, [field]: value } : set;
        });
      }
    }
    // The week's tempo/rest on the logged exercise, so the rest timer (and
    // any display) uses the plan's per-exercise values.
    return { ...ex, tempo: eff.tempo, rest_sec: eff.rest_sec, sets };
  });

  if (!autoWarmups) return exercises;
  // A warm-up ramp before the working sets, for an exercise with a usable
  // working weight.
  return exercises.map(ex => {
    // A warm-up ramp is weight x reps sets; it means nothing for a hold, a
    // carry or a row (issues #89, #119), whatever load it is done with.
    if (['time', 'distance', 'calories'].includes(ex.set_type)
      || (ex.sets || []).some(s => Number(s.duration_sec) > 0 || Number(s.distance_m) > 0 || Number(s.calories) > 0)) return ex;
    const firstWorking = (ex.sets || []).find(s => !s.warmup);
    const w = parseFloat(firstWorking?.weight || ex.target_weight || 0) || 0;
    const warmups = generateWarmupSets(w, weightUnit);
    if (warmups.length === 0) return ex;
    return { ...ex, sets: [...warmups, ...(ex.sets || [])] };
  });
}

/**
 * Log one set into an exercise's sets. A done set goes into the first set
 * still to do of the same kind (a warm-up into a planned warm-up, a working
 * set into a planned working set), as ticking it in the Diary would: what
 * was sent replaces what was planned, and anything not sent (the weight,
 * say) stays as planned. With no such set, or a set sent as not done,
 * `added` goes after the others, as before.
 *
 *   sent   { reps, weight, duration_sec, duration_l_sec, duration_r_sec,
 *          distance_m, calories, rpe, warmup, completed }, each
 *          undefined (or null) when not sent; a hold per side (issue #143)
 *          sends both sides and duration_sec, the shorter one
 *   added  the whole set to add when there's nothing to fill
 *   at     when it was done (ISO), kept on a filled set as completedAt: the
 *          merge (server/lib/workout-merge.js) then keeps it over a copy
 *          saved from before it that doesn't say what it changed (an older
 *          app, a phone's queued edit), which would otherwise untick it.
 *          A copy that has it carries it along, so later edits still win.
 *
 * Returns { sets (a new array), index, filled }.
 */
export function logIntoSets(sets, sent, added, { at = null } = {}) {
  const list = Array.isArray(sets) ? sets.slice() : [];
  const given = (v) => v !== undefined && v !== null;
  const index = sent.completed !== false
    ? list.findIndex(s => s && typeof s === 'object' && !s.completed && !!s.warmup === !!sent.warmup)
    : -1;
  if (index < 0) {
    list.push(added);
    return { sets: list, index: list.length - 1, filled: false };
  }
  const set = { ...list[index], completed: true };
  if (given(sent.weight)) set.weight = sent.weight;
  if (given(sent.duration_sec)) {
    set.duration_sec = sent.duration_sec;
    // One time says nothing about each side's, as with reps below.
    delete set.duration_l_sec;
    delete set.duration_r_sec;
  }
  if (given(sent.duration_l_sec) && given(sent.duration_r_sec)) {
    set.duration_l_sec = sent.duration_l_sec;
    set.duration_r_sec = sent.duration_r_sec;
  }
  if (given(sent.distance_m)) set.distance_m = sent.distance_m;
  if (given(sent.calories)) set.calories = sent.calories;
  if (given(sent.reps)) {
    set.reps = sent.reps;
    // A left/right target says nothing about the reps done.
    delete set.reps_l;
    delete set.reps_r;
  }
  if (given(sent.rpe)) set.rpe = sent.rpe;
  if (at) set.completedAt = at;
  if (set.weight == null) set.weight = 0;
  if (set.reps == null) set.reps = 0;
  list[index] = set;
  return { sets: list, index, filled: true };
}
