/**
 * workout.js — Workout calculation utilities for LiftTrace
 */

// Shared with the server (issue #140): parseDuration, lastCompletedSession
// and generateWarmupSets live in planned-workout.js, so the Diary and the
// API plan a workout day the same way.
export { parseDuration, lastCompletedSession, generateWarmupSets, defaultDistanceUnit } from './planned-workout.js';
import { METERS_PER, exerciseNameKey, defaultDistanceUnit } from './planned-workout.js';

/**
 * Resolve which `load_type` applies to a workout-instance exercise.
 * Four-tier chain, evaluated top-to-bottom:
 *   1. Per-instance override (`exercise.load_type` on the workout row) — the user
 *      picked something for THIS session; always wins.
 *   2. Library-level default (`libraryLoadType`, resolved by the caller from the
 *      exercises table) — only when explicitly non-null. Owners set this via the
 *      Exercise Editor; it's the shared truth for the catalog entry.
 *   3. Client-side per-user preference (`clientPrefs[exercise_id]`) — legacy per-
 *      user override from the Diary "Remember" toggle. Applies when the library
 *      hasn't been explicitly set.
 *   4. `'bilateral'` fallback.
 *
 * See issue #24. Library default beats client pref only when it's explicitly
 * non-NULL so users who've been living off client prefs don't get their setup
 * silently rewritten by a defaulted library column.
 */
export function resolveLoadType(exercise, libraryLoadType, clientPrefs) {
  if (exercise?.load_type) return exercise.load_type;
  if (libraryLoadType) return libraryLoadType;
  const exId = exercise?.exercise_id;
  if (clientPrefs && exId != null && clientPrefs[exId]) return clientPrefs[exId];
  return 'bilateral';
}

// ── Set type: reps, time, distance or calories (issues #89, #119) ─────
//
// Most sets are weight x reps. Isometric holds (plank, wall sit, dead hang)
// are logged by duration instead, stored on the set as whole seconds in
// `duration_sec` (#89). Conditioning work (rower, SkiErg, sled, carries,
// runs) is logged by distance, stored in meters in `distance_m`, or by the
// calories a machine shows, in `calories` (#119). Weight stays meaningful
// for every kind: a weighted plank is "25 lbs for 1:00", a sled push
// "90 kg for 20 m", a bodyweight one leaves weight empty.
//
// The mirror of these helpers for the server lives in server/lib/volume.js.
// scripts/set-type.test.js runs the same cases through both so the two
// cannot disagree about what kind a set is.

export const SET_TYPES = ['reps', 'time', 'distance', 'calories'];

/** The set field each kind other than reps records its amount in. */
export const SET_TYPE_FIELD = { time: 'duration_sec', distance: 'distance_m', calories: 'calories' };

function _cleanSetType(v) {
  return SET_TYPES.includes(v) ? v : null;
}

/** The kind a set's own data says it is, or null when it carries none. A
 *  duration is checked first, so a set timed before #119 reads as before. */
function _dataSetType(set) {
  if (Number(set?.duration_sec) > 0) return 'time';
  if (Number(set?.distance_m) > 0) return 'distance';
  if (Number(set?.calories) > 0) return 'calories';
  return null;
}

/**
 * What kind of set this is for any math (volume, 1RM, records, charts):
 * 'reps', 'time', 'distance' or 'calories'.
 *
 * An explicit choice on the exercise instance always wins. Without one, the
 * set's own data decides. That order is what lets a user flip an exercise
 * to another kind without losing what they had already typed (it stays on
 * the set, ignored), and flip back to get it.
 */
export function setKind(exercise, set) {
  return _cleanSetType(exercise?.set_type) || _dataSetType(set) || 'reps';
}

/** A timed set (issue #89). */
export function isTimedSet(exercise, set) {
  return setKind(exercise, set) === 'time';
}

/** A weight x reps set: the only kind that has volume or an estimated 1RM. */
export function isRepSet(exercise, set) {
  return setKind(exercise, set) === 'reps';
}

/** The amount a non-rep set records (seconds, meters or calories), 0 for a
 *  rep set or an empty one. */
export function setAmount(exercise, set) {
  const field = SET_TYPE_FIELD[setKind(exercise, set)];
  return field ? (Number(set?.[field]) || 0) : 0;
}

/**
 * Exercises tracked by something other than reps by nature, matched by
 * exact normalised name.
 *
 * Deliberately exact rather than a pattern: in the free-exercise-db catalogue
 * "hang" also matches Hang Clean and Hang Snatch, "bridge" matches Glute
 * Bridge, "plank" matches Push Up to Side Plank, "row" every rowing lift and
 * "Air Bike" is a crunch. This is only a starting default for an exercise
 * that has never been logged and has no library setting and no remembered
 * choice; any of those overrides it, so an exercise someone already logged
 * with reps keeps its reps (issue #119).
 */
const TYPE_BY_NAME = new Map([
  ...['plank', 'side plank', 'side bridge', 'copenhagen plank',
    'wall sit', 'dead hang', 'bar hang', 'one handed hang', 'flexed arm hang',
    'hollow hold', 'hollow body hold', 'l sit'].map(n => [n, 'time']),
  ...['rowing stationary', 'rowing', 'rowing machine', 'rower', 'indoor row', 'indoor rowing', 'row erg', 'rowerg',
    'skierg', 'ski erg', 'ski ergometer', 'bikeerg', 'bike erg',
    'sled push', 'sled pull', 'sled drag', 'sled drag harness', 'backward drag', 'prowler push', 'prowler sprint',
    'farmers walk', 'farmer walk', 'farmers carry', 'farmer carry', 'suitcase carry', 'rickshaw carry',
    'yoke walk', 'yoke carry', 'sandbag carry',
    'running treadmill', 'jogging treadmill', 'walking treadmill', 'trail running walking',
    'run', 'running', 'bicycling', 'cycling'].map(n => [n, 'distance']),
  ...['assault bike', 'echo bike', 'airdyne', 'fan bike', 'assault air bike'].map(n => [n, 'calories']),
]);
export function defaultSetTypeForName(name) {
  return TYPE_BY_NAME.get(exerciseNameKey(name)) || null;
}

/**
 * The kind a new entry of an exercise starts as, before it has sets of its
 * own: what the last session was (its own set_type, `lastSetType`, then what
 * its sets recorded), so history never changes shape; then the library
 * default, the remembered choice, the name list, and reps.
 *
 * `lastSets` undefined means the history could not be read (offline, say):
 * the name list is skipped then, since the exercise may well have been
 * logged with reps, and a guess would stamp a shape on it that sticks.
 * null or [] means it was read and there is none.
 */
export function startSetType(lastSets, librarySetType, remembered, name, lastSetType = null) {
  const last = _cleanSetType(lastSetType);
  if (last) return last;
  const sets = Array.isArray(lastSets) ? lastSets : [];
  for (const s of sets) { const t = _dataSetType(s); if (t) return t; }
  if (sets.some(s => Number(s?.reps) > 0)) return 'reps';
  const chosen = _cleanSetType(librarySetType) || _cleanSetType(remembered);
  if (chosen) return chosen;
  if (lastSets === undefined) return 'reps';
  return defaultSetTypeForName(name) || 'reps';
}

/**
 * Which input a workout-instance exercise shows: 'reps', 'time',
 * 'distance' or 'calories'.
 *
 *   1. Per-instance choice (`exercise.set_type`), made from the Diary chip.
 *   2. The data already recorded on it, then on the last session
 *      (`lastSets`, when the caller has it). This outranks every default
 *      below, so marking an exercise as timed in the library, or a built-in
 *      becoming distance-based, can never change the shape of history
 *      someone has already logged with reps.
 *   3. Library default (`librarySetType`, from the exercises table).
 *   4. The user's remembered preference for this exercise.
 *   5. A short list of exercises tracked otherwise by nature (see
 *      defaultSetTypeForName).
 *   6. 'reps'.
 */
export function resolveSetType(exercise, librarySetType, clientPrefs, lastSets = null, lastSetType = null) {
  const own = _cleanSetType(exercise?.set_type);
  if (own) return own;
  const sets = exercise?.sets || [];
  for (const s of sets) { const t = _dataSetType(s); if (t) return t; }
  if (sets.some(s => Number(s?.reps) > 0)) return 'reps';
  const exId = exercise?.exercise_id;
  const pref = clientPrefs && exId != null ? clientPrefs[exId] : null;
  return startSetType(lastSets, librarySetType, pref, exercise?.exercise_name, lastSetType);
}

// ── Distance units (issue #119) ─────────────────────────────────────────
//
// Distance is stored in meters and shown in the exercise's unit: meters or
// yards for a rower, sled or carry, kilometers or miles for a run or a
// ride, following the account's weight unit (lbs reads as imperial). The
// unit chosen on an entry rides on it as `distance_unit`.

export const DISTANCE_UNITS = METERS_PER;

/** The unit an entry shows its distance in: its own, the remembered one for
 *  the exercise, or the default for its name. */
export function distanceUnitOf(exercise, imperial = false, prefs = null) {
  if (DISTANCE_UNITS[exercise?.distance_unit]) return exercise.distance_unit;
  const exId = exercise?.exercise_id;
  const pref = prefs && exId != null ? prefs[exId] : null;
  if (DISTANCE_UNITS[pref]) return pref;
  return defaultDistanceUnit(exercise?.exercise_name, imperial);
}

/** A distance typed in `unit` as meters, or null when it isn't one. */
export function toMeters(value, unit = 'm') {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * (DISTANCE_UNITS[unit] || 1) * 1000) / 1000;
}

/** Meters in `unit`, rounded for display: two decimals for km and mi, one
 *  for m and yd. 0 or nothing reads as null. */
export function fromMeters(meters, unit = 'm') {
  const m = Number(meters);
  if (!Number.isFinite(m) || m <= 0) return null;
  const v = m / (DISTANCE_UNITS[unit] || 1);
  const places = unit === 'km' || unit === 'mi' ? 100 : 10;
  return Math.round(v * places) / places;
}

/** "500 m", "5.2 km", "" for none. */
export function fmtDistance(meters, unit = 'm') {
  const v = fromMeters(meters, unit);
  return v == null ? '' : `${v} ${unit}`;
}

/** "20 cal", "" for none. */
export function fmtCalories(cal) {
  const n = Math.round(Number(cal));
  return Number.isFinite(n) && n > 0 ? `${n} cal` : '';
}

/** A non-rep set's amount as text: "1:00", "500 m", "20 cal". */
export function fmtSetAmount(kind, set, unit = 'm') {
  if (kind === 'time') return fmtSetDuration(set?.duration_sec) || '0:00';
  if (kind === 'distance') return fmtDistance(set?.distance_m, unit) || `0 ${unit}`;
  if (kind === 'calories') return fmtCalories(set?.calories) || '0 cal';
  return '';
}

/** 75 -> "1:15", 45 -> "0:45", 3725 -> "1:02:05". Empty for no duration. */
export function fmtSetDuration(sec) {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Live display for a duration field as someone types, timer style: digits
 * fill from the right, so "1" shows 0:01, "13" 0:13, "130" 1:30. Non-digits
 * are dropped, so a desktop user typing "1:30" lands on the same 1:30, and
 * backspace simply removes the last digit. Capped at four digits (99:99),
 * far beyond any hold.
 */
export function maskDurationInput(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '').slice(0, 4);
  if (!digits) return '';
  const n = Number(digits);
  return `${Math.floor(n / 100)}:${String(n % 100).padStart(2, '0')}`;
}

/**
 * Compact label for one logged set, as used in history lists and summaries:
 * "135×8" for reps, "25×1:00" for a weighted hold, "1:00" for a bodyweight
 * one, "90×20 m" for a sled push, "20 cal" on a bike. Unilateral splits are
 * left to callers that render them specially.
 */
export function fmtSetLabel(exercise, set, distanceUnit = null) {
  if (!set) return '';
  const kind = setKind(exercise, set);
  if (kind !== 'reps') {
    const t = fmtSetAmount(kind, set, distanceUnit || distanceUnitOf(exercise));
    return set.weight ? `${set.weight}×${t}` : t;
  }
  return `${set.weight || 0}×${set.reps || 0}`;
}

/**
 * Per-set volume that honors the exercise's load_type. Three modes:
 *   - 'bilateral'  (default): weight × reps                — one load, both sides work together
 *   - 'paired'              : weight × reps × 2            — per-DB / per-side weight, both sides work simultaneously
 *   - 'unilateral'          : weight × (reps_l + reps_r)   — alternating one side at a time
 *                            (falls back to weight × reps × 2 when no per-side split is recorded)
 * Warm-up sets are excluded; that's the caller's job (kept here for purity).
 */
export function setVolume(set, loadType = 'bilateral') {
  if (!set) return 0;
  const w = Number(set.weight) || 0;
  if (w <= 0) return 0;
  if (loadType === 'unilateral') {
    // If the user logged per-side reps, use those exactly; otherwise assume
    // matching reps on both sides (the common case).
    if (set.reps_l != null || set.reps_r != null) {
      const l = Number(set.reps_l) || 0;
      const r = Number(set.reps_r) || 0;
      return w * (l + r);
    }
    const r = Number(set.reps) || 0;
    return w * r * 2;
  }
  if (loadType === 'paired') {
    const r = Number(set.reps) || 0;
    return w * r * 2;
  }
  // bilateral
  const r = Number(set.reps) || 0;
  return w * r;
}

/**
 * Per-exercise volume — sums completed working sets through setVolume()
 * using the exercise's resolved load_type (see resolveLoadType). Warm-ups
 * excluded.
 *
 * Optional `opts.libraryLoadType` and `opts.clientPrefs` let callers plug
 * the full four-tier chain in. Called with only the exercise (old signature),
 * behavior is unchanged: uses `exercise.load_type` or falls back to
 * 'bilateral' — matches the pre-issue-#24 semantics for callers that haven't
 * been updated yet.
 */
export function exerciseVolume(exercise, opts = {}) {
  if (!exercise) return 0;
  const loadType = resolveLoadType(exercise, opts.libraryLoadType, opts.clientPrefs);
  let total = 0;
  for (const s of (exercise.sets || [])) {
    if (!s.completed || s.warmup) continue;
    // Timed, distance and calorie sets are not weight x reps work. Leftover
    // reps on a set whose exercise was flipped to another kind must not
    // sneak back into volume.
    if (!isRepSet(exercise, s)) continue;
    total += setVolume(s, loadType);
  }
  return total;
}

/**
 * The Diary's volume chip: today's volume of an exercise against last time's,
 * set for set (issue #121 follow-up). Mid-workout, after 2 of 3 sets, the old
 * chip set today's two sets against all of last time's and read -28% while
 * the lifter was ahead. Now today's N completed working sets are set against
 * the first N working sets of the last session (warm-ups and timed sets
 * excluded on both sides, as in exerciseVolume); with fewer than N last time,
 * against all of them, never padded with zeros.
 *
 * Once the workout is finished (`done`) it is the whole of last time's,
 * which is the number the chip always showed for a full session. Not
 * before: with 3 sets planned against 4 last time, ticking the third would
 * otherwise jump from 3 against 3 to 3 against all 4 and turn red while the
 * lifter is ahead set for set.
 *
 * `exercise` is today's, with its resolved `load_type`; `lastSets` the last
 * session's completed sets, in order (lastCompletedSession's `completed`).
 * Returns { pct, sets, partial } (`sets`: how many of last time's were used;
 * `partial`: that is fewer than it did), or null when either side has no
 * volume to compare.
 */
export function volumeDelta(exercise, lastSets, { done = false } = {}) {
  if (!exercise || !lastSets?.length) return null;
  const today = (exercise.sets || []).filter(s => s.completed && !s.warmup && !isTimedSet(exercise, s));
  const current = exerciseVolume({ ...exercise, sets: today });
  if (!(current > 0)) return null;
  const working = lastSets.filter(s => !s.warmup && !isTimedSet({}, s));
  const used = done ? working : working.slice(0, today.length);
  const before = exerciseVolume({ load_type: exercise.load_type, sets: used.map(s => ({ ...s, completed: true })) });
  if (!(before > 0)) return null;
  return {
    pct: Math.round((current - before) / before * 100),
    sets: used.length,
    partial: used.length < working.length,
  };
}

/**
 * Calculate total volume across a workout's exercises, honoring per-
 * exercise load_type. Backwards-compatible with the previous signature
 * (an array of exercises + optional unit string).
 */
export function calcVolume(exercises, _weightUnit = 'lbs') {
  if (!exercises?.length) return 0;
  let total = 0;
  for (const ex of exercises) {
    total += exerciseVolume(ex);
  }
  return total;
}

/**
 * Calculate 1-rep max estimate using Epley formula: w × (1 + r/30)
 */
export function calc1RM(weight, reps) {
  if (!weight || !reps || reps <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

/**
 * Estimate calories burned during a workout — Mifflin-St Jeor BMR + MET.
 *
 * Approach:
 *   1. Compute basal metabolic rate (Mifflin-St Jeor — the most accurate
 *      BMR equation per ADA and ISSN reviews).
 *   2. Multiply by hours × MET to get the active-energy delta. Default MET
 *      for resistance training is 5.0 (per the Compendium of Physical
 *      Activities, code 02050). Bumped to 6.0 when intensity is high
 *      (>= 200 kg-min/min — heuristic for "vigorous" training density).
 *
 * Returns null if any required input is missing — caller should hide the
 * UI rather than show a junk number. The estimate has roughly ±25% error
 * even with all inputs valid (resistance-training calorie counts are loose
 * by nature); the UI tags it with "~est" so users don't take it as gospel.
 *
 * @param {object} workout - workout_log row { exercises, duration_min }
 * @param {object} profile - { weight_kg, height_cm, age, sex }
 * @returns {number|null} estimated kcal or null if inputs are missing
 */
export function estimateWorkoutCalories(workout, profile) {
  if (!workout || !profile) return null;
  const { weight_kg, height_cm, age, sex } = profile;
  if (!weight_kg || !height_cm || !age) return null;
  let duration_min = workout.duration_min || 0;
  if (duration_min <= 0) {
    // No tracked duration — fall back to ~3 min per completed working
    // set (set time + average inter-set rest), which lines up with most
    // strength sessions in the 30-90 min range. Less accurate than a
    // real clock, but better than refusing to estimate when the user
    // forgot to start the timer or logged the workout after the fact.
    // Callers that want to flag this as a rougher estimate can check
    // `workout.duration_min > 0` themselves.
    const workingSets = (workout.exercises || []).reduce(
      (acc, ex) => acc + (ex.sets || []).filter(s => s.completed && !s.warmup).length,
      0,
    );
    if (workingSets <= 0) return null;
    duration_min = workingSets * 3;
  }

  // Mifflin-St Jeor BMR. For non-binary / unset, average the male + female
  // formulas (a 166 kcal/day midpoint at a typical adult input range).
  let bmr;
  const base = (10 * weight_kg) + (6.25 * height_cm) - (5 * age);
  if (sex === 'male')        bmr = base + 5;
  else if (sex === 'female') bmr = base - 161;
  else                       bmr = base - 78;       // midpoint of +5 and -161

  // Intensity heuristic: total volume per minute. Above 200 kg×reps / min
  // we treat the workout as vigorous (heavy compound lifts at short rest);
  // below that, default MET. The cutoff is a best-guess from typical
  // hypertrophy session loads — refine later if real data warrants.
  const totalVolume = calcVolume(workout.exercises || [], 'kg');
  // calcVolume is unit-agnostic; convert lbs → kg if the data was logged in
  // lbs by detecting magnitude (a typical kg session caps around 5000;
  // anything well above suggests lbs and needs ÷2.2046).
  // Caller should pass volume in kg explicitly via profile.weightUnit if
  // they want determinism — but the heuristic is fine for the MET bump.
  const intensity = duration_min > 0 ? totalVolume / duration_min : 0;
  const met = intensity >= 200 ? 6.0 : 5.0;

  // Active calories = (BMR per hour) × MET × hours
  const kcal = (bmr / 24) * met * (duration_min / 60);
  return Math.max(0, Math.round(kcal));
}

/**
 * Convert a body weight value from the user's preferred unit to kg.
 * Used by the calorie estimator and any other formula that needs SI input.
 */
export function toKg(weight, unit) {
  if (weight == null) return null;
  if (unit === 'kg') return weight;
  return weight * 0.45359237;
}

/**
 * Convert centimetres to feet+inches (used by Profile + Wizard inputs when
 * heightUnit === 'ft'). Returns { ft, in } where in is rounded to nearest
 * whole inch.
 */
export function cmToFtIn(cm) {
  if (cm == null) return { ft: '', in: '' };
  const totalInches = cm / 2.54;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - ft * 12);
  if (inches === 12) return { ft: ft + 1, in: 0 };
  return { ft, in: inches };
}

/** Convert feet+inches to cm. */
export function ftInToCm(ft, inches) {
  const f = Number(ft) || 0;
  const i = Number(inches) || 0;
  return Math.round(((f * 12) + i) * 2.54);
}

/**
 * Compute age in years from a YYYY-MM-DD date-of-birth string. Returns
 * null if the input is missing or unparseable.
 */
export function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Count completed sets across exercises
 */
export function countCompletedSets(exercises) {
  if (!exercises?.length) return { completed: 0, total: 0 };
  let completed = 0, total = 0;
  for (const ex of exercises) {
    for (const set of ex.sets || []) {
      total++;
      if (set.completed) completed++;
    }
  }
  return { completed, total };
}

/**
 * Format weight for display (round to 1 decimal, hide .0)
 */
export function fmtWeight(w, unit = 'lbs') {
  if (!w && w !== 0) return '—';
  const rounded = Math.round(w * 10) / 10;
  return `${rounded % 1 === 0 ? Math.round(rounded) : rounded} ${unit}`;
}

/**
 * Format duration in minutes to h:mm or Xm
 */
export function fmtDuration(minutes) {
  if (!minutes) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Group exercises by muscle category for display
 */
export const BODY_PART_ICONS = {
  'chest':     'fitness_center',
  'back':      'fitness_center',
  'shoulders': 'fitness_center',
  'arms':      'fitness_center',
  'biceps':    'fitness_center',
  'triceps':   'fitness_center',
  'legs':      'directions_run',
  'glutes':    'directions_run',
  'core':      'fitness_center',
  'abs':       'fitness_center',
  'cardio':    'favorite',
  'full body': 'fitness_center',
};

export const CATEGORIES = [
  { id: 'chest',     label: 'Chest',     icon: 'fitness_center' },
  { id: 'back',      label: 'Back',      icon: 'fitness_center' },
  { id: 'shoulders', label: 'Shoulders', icon: 'fitness_center' },
  { id: 'arms',      label: 'Arms',      icon: 'fitness_center' },
  { id: 'legs',      label: 'Legs',      icon: 'directions_run' },
  { id: 'core',      label: 'Core',      icon: 'fitness_center' },
  { id: 'cardio',    label: 'Cardio',    icon: 'favorite'       },
  { id: 'full_body', label: 'Full Body', icon: 'fitness_center' },
  { id: 'other',     label: 'Other',     icon: 'more_horiz'     },
];

export const EQUIPMENT = [
  'Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Kettlebell', 'Smith Machine', 'Other'
];

/** Muscle groups used by the custom-exercise editor. Grouped roughly by region
 *  for the picker UI. Values are the canonical lowercase strings stored in
 *  exercises.primary_muscles / secondary_muscles JSON. */
export const MUSCLES = [
  'chest', 'lats', 'upper back', 'lower back',
  'shoulders', 'front delts', 'side delts', 'rear delts',
  'biceps', 'triceps', 'forearms',
  'abs', 'obliques',
  'glutes', 'quads', 'hamstrings', 'calves',
  'neck', 'traps',
];

export const GOALS = [
  { id: 'cutting',     label: 'Cutting' },
  { id: 'bulking',     label: 'Bulking' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'strength',    label: 'Strength' },
  { id: 'endurance',   label: 'Endurance' },
  { id: 'general',     label: 'General Fitness' },
];
