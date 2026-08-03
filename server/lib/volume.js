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
    total += setVolume(s, loadType);
  }
  return total;
}
