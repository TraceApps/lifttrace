/**
 * muscle-recovery.js — Hours-since-last-trained per muscle group.
 *
 * Walks a list of recent workouts, attributes each completed non-warmup
 * set to the exercise's primary muscles (or the exercise's category as a
 * fallback when the primary_muscles array is empty), and returns a
 * { muscleKey: { lastDate, hoursAgo, sets, volume } } map.
 *
 * Buckets mirror server/routes/stats.js#_normalizeMuscle so the recovery
 * view and the muscle-volume chart speak the same language.
 *
 * Pure helper — no DB / fetch. Caller passes in workouts + exercises.
 */

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
  if (hoursAgo == null) return { label: 'Untrained', color: 'var(--surface-2)' };
  for (const t of FRESHNESS) if (hoursAgo < t.maxHours) return t;
  return FRESHNESS[FRESHNESS.length - 1];
}

function _normalizeMuscle(m) {
  const s = (m || '').toLowerCase().trim();
  if (s.includes('chest') || s.includes('pec')) return 'chest';
  if (s.includes('back') || s.includes('lat') || s.includes('trap') || s.includes('rhomboid')) return 'back';
  if (s.includes('shoulder') || s.includes('delt')) return 'shoulders';
  if (s.includes('bicep')) return 'biceps';
  if (s.includes('tricep')) return 'triceps';
  if (s.includes('forearm')) return 'forearms';
  if (s.includes('ab') || s.includes('core') || s.includes('oblique')) return 'core';
  if (s.includes('quad')) return 'quads';
  if (s.includes('hamstring')) return 'hamstrings';
  if (s.includes('glute')) return 'glutes';
  if (s.includes('calf') || s.includes('calve')) return 'calves';
  if (s.includes('leg')) return null;  // ambiguous fallback — skip
  if (s.includes('arm')) return null;  // ambiguous fallback — skip
  return null;
}

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
    let muscles = ex.primary_muscles;
    if (typeof muscles === 'string') {
      try { muscles = JSON.parse(muscles); } catch { muscles = []; }
    }
    exMap[ex.id] = {
      muscles: Array.isArray(muscles) ? muscles : [],
      category: ex.category || '',
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
      const info = exMap[ex.exercise_id] || { muscles: [], category: '' };
      const rawGroups = info.muscles.length ? info.muscles : [info.category];
      const groups = [...new Set(rawGroups.map(_normalizeMuscle).filter(Boolean))];
      if (!groups.length) continue;

      for (const set of ex.sets || []) {
        if (!set.completed || set.warmup) continue;
        const weight = +set.weight || 0;
        const reps = +set.reps || 0;
        if (weight <= 0 || reps <= 0) continue;
        const vol = weight * reps;

        for (const g of groups) {
          if (!out[g]) out[g] = { lastDate: w.date, lastTs: ts, sets: 0, volume: 0 };
          out[g].sets++;
          out[g].volume += vol;
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
