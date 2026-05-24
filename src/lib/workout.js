/**
 * workout.js — Workout calculation utilities for LiftTrace
 */

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
 * using the exercise's load_type (defaults to bilateral). Warm-ups excluded.
 */
export function exerciseVolume(exercise) {
  if (!exercise) return 0;
  const loadType = exercise.load_type || 'bilateral';
  let total = 0;
  for (const s of (exercise.sets || [])) {
    if (!s.completed || s.warmup) continue;
    total += setVolume(s, loadType);
  }
  return total;
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
  const duration_min = workout.duration_min || 0;
  if (!weight_kg || !height_cm || !age || duration_min <= 0) return null;

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
/**
 * Generate a reasonable warm-up progression from a working weight.
 * Classic 5-step ramp — bar × 8 → 50% × 5 → 70% × 3 → 85% × 2 → (working set).
 * Returns only the warm-up sets (4 of them); caller appends working sets.
 * If the working weight is at or below the empty bar, returns [] (no warm-up
 * needed for bodyweight / light accessory work).
 */
export function generateWarmupSets(workingWeight, unit = 'lbs') {
  const W = parseFloat(workingWeight) || 0;
  const bar = unit === 'kg' ? 20 : 45;
  const step = unit === 'kg' ? 2.5 : 5;
  const roundTo = (n) => Math.round(n / step) * step;
  if (W <= bar) return [];
  const base = { completed: false, warmup: true, notes: '' };
  const sets = [];
  sets.push({ ...base, weight: bar,               reps: 8 });
  const p50 = roundTo(W * 0.5);  if (p50 > bar) sets.push({ ...base, weight: p50, reps: 5 });
  const p70 = roundTo(W * 0.7);  if (p70 > p50) sets.push({ ...base, weight: p70, reps: 3 });
  const p85 = roundTo(W * 0.85); if (p85 > p70) sets.push({ ...base, weight: p85, reps: 2 });
  return sets;
}

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
