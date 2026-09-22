/**
 * muscle-recovery.js — Hours-since-last-trained per muscle group.
 *
 * Walks a list of recent workouts, attributes each completed non-warmup
 * set through its workout snapshot, personal muscle-load profile, or
 * catalog primary/secondary defaults, and returns a
 * { muscleKey: { lastDate, hoursAgo, sets, volume } } map.
 *
 * Buckets mirror server/routes/stats.js#_normalizeMuscle so the recovery
 * view and the muscle-volume chart speak the same language.
 *
 * Pure helper — no DB / fetch. Caller passes in workouts + exercises.
 */
import { isTimedSet } from './workout.js';
import { musclesOf } from './muscle-load.js';

export const MUSCLE_BUCKETS = [
  'chest', 'back', 'shoulders',
  'biceps', 'triceps', 'forearms',
  'core',
  'quads', 'hamstrings', 'glutes', 'calves',
];

// Visual freshness thresholds (hours since last worked).
// Mirrors common training-science heuristics: ≤24h = peak fatigue,
// 24–48h = recovering, 48–72h = ready, 72h+ = fresh.
export const FRESHNESS = [
  { maxHours: 24,  label: 'Fatigued',  color: '#ef4444' },  // red
  { maxHours: 48,  label: 'Recovering', color: '#f97316' }, // orange
  { maxHours: 72,  label: 'Ready',      color: '#f59e0b' }, // amber
  { maxHours: Infinity, label: 'Fresh', color: '#10b981' }, // green
];

export function freshnessFor(hoursAgo) {
  // Distinct from the body fill on purpose: an untrained muscle should still
  // show as a region. Matching the silhouette hid the whole map for anyone
  // with no completed sets in the window, which is what a new user sees.
  if (hoursAgo == null) {
    return { label: 'Untrained', color: 'color-mix(in srgb, var(--text-3) 34%, transparent)' };
  }
  for (const t of FRESHNESS) if (hoursAgo < t.maxHours) return t;
  return FRESHNESS[FRESHNESS.length - 1];
}

const _RECOVERY_BUCKET = {
  trapezius: 'back', deltoids: 'shoulders', chest: 'chest', 'upper-back': 'back', serratus: 'back',
  biceps: 'biceps', triceps: 'triceps', forearm: 'forearms',
  abs: 'core', obliques: 'core', 'lower-back': 'back',
  gluteal: 'glutes', quadriceps: 'quads', hamstring: 'hamstrings',
  adductors: 'quads', 'hip-flexors': 'quads', calves: 'calves', tibialis: 'calves',
};

/**
 * Compute per-muscle recovery state from recent workouts.
 *
 * @param {Array} workouts - rows from /api/workout/recent (need `date`,
 *   `exercises[].exercise_id`, `exercises[].sets`).
 * @param {Array} exerciseLibrary - rows from /api/exercises (need `id`,
 *   `primary_muscles` (array or JSON string), `category`).
 * @param {number} [windowDays=7] - how far back to look. Anything older
 *   counts as "fresh / untrained recently".
 * @returns {Object<string, { lastDate:string, hoursAgo:number, sets:number, volume:number }>}
 */
export function computeMuscleRecovery(workouts, exerciseLibrary, windowDays = 7) {
  // Build id → muscles[] lookup. Tolerate primary_muscles being either a
  // parsed array (typical client) or a JSON string (raw DB row).
  const exMap = {};
  for (const ex of exerciseLibrary || []) {
    let primary = ex.primary_muscles;
    let secondary = ex.secondary_muscles;
    if (typeof primary === 'string') { try { primary = JSON.parse(primary); } catch { primary = []; } }
    if (typeof secondary === 'string') { try { secondary = JSON.parse(secondary); } catch { secondary = []; } }
    exMap[ex.id] = {
      primary: Array.isArray(primary) ? primary : [],
      secondary: Array.isArray(secondary) ? secondary : [],
      category: ex.category || '',
      loads: ex.muscle_load || null,
    };
  }

  const out = {};
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  for (const w of workouts || []) {
    // Workout date is a 'YYYY-MM-DD' string — treat the workout as having
    // occurred at noon local time so single-digit-hour math doesn't trip
    // on DST boundaries.
    const ts = new Date(`${w.date}T12:00:00`).getTime();
    if (isNaN(ts) || ts < cutoff) continue;

    for (const ex of w.exercises || []) {
      const info = exMap[ex.exercise_id] || { primary: [], secondary: [], category: '', loads: null };
      const perMuscle = musclesOf({
        primary: info.primary,
        secondary: info.secondary,
        category: String(info.category || '').toLowerCase(),
        loads: ex.muscle_load ?? info.loads,
      });
      // Recovery currently draws 11 broad regions while Muscle Balance uses
      // 18. Collapse the detailed profile by taking the highest contribution
      // within a region, so one set never counts twice merely because both
      // abs and obliques were selected.
      const groupLoads = {};
      for (const [slug, load] of Object.entries(perMuscle)) {
        const group = _RECOVERY_BUCKET[slug];
        if (group) groupLoads[group] = Math.max(groupLoads[group] || 0, load);
      }
      const groups = Object.entries(groupLoads);
      if (!groups.length) continue;

      for (const set of ex.sets || []) {
        if (!set.completed || set.warmup) continue;
        const weight = +set.weight || 0;
        const reps = +set.reps || 0;
        // A timed set (issue #89) is real training for recovery purposes, a
        // plank works the core, but it carries no weight x reps volume.
        const timed = isTimedSet(ex, set) && (+set.duration_sec || 0) > 0;
        if (!timed && (weight <= 0 || reps <= 0)) continue;
        const vol = timed ? 0 : weight * reps;

        for (const [g, load] of groups) {
          if (!out[g]) out[g] = { lastDate: w.date, lastTs: ts, sets: 0, volume: 0 };
          out[g].sets += load;
          out[g].volume += vol * load;
          if (ts > out[g].lastTs) {
            out[g].lastTs = ts;
            out[g].lastDate = w.date;
          }
        }
      }
    }
  }

  // Compute hoursAgo at read time.
  const now = Date.now();
  const result = {};
  for (const key of MUSCLE_BUCKETS) {
    const e = out[key];
    if (!e) { result[key] = { lastDate: null, hoursAgo: null, sets: 0, volume: 0 }; continue; }
    result[key] = {
      lastDate: e.lastDate,
      hoursAgo: Math.max(0, Math.round((now - e.lastTs) / 36e5)),
      sets: e.sets,
      volume: e.volume,
    };
  }
  return result;
}
