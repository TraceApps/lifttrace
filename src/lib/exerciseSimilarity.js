/**
 * Rank a library of exercises by "similarity" to a source exercise.
 *
 * Score per candidate Y relative to source X:
 *   primary_overlap   * 3           ← direct-match muscles are the backbone
 *   secondary_overlap * 1           ← supporting muscles nudge the score up
 *   - (same equipment ? 0 : 1)      ← slight nudge to prefer same equipment,
 *                                     but NOT a hard filter — the whole point
 *                                     is to find alternatives when the equipment
 *                                     isn't available.
 *
 * We require at least ONE primary-muscle overlap; anything less isn't really a
 * similar exercise. Returns the top `limit` matches by score, excluding X itself.
 */
export function findSimilarExercises(source, library, limit = 8) {
  if (!source) return [];
  const sourcePrim = new Set((source.primary_muscles || []).map(m => String(m).toLowerCase()));
  const sourceSec  = new Set((source.secondary_muscles || []).map(m => String(m).toLowerCase()));
  const sourceEq   = new Set((source.equipment || []).map(e => String(e).toLowerCase()));
  if (sourcePrim.size === 0) return [];

  const scored = [];
  for (const y of library) {
    if (!y || y.id === source.id) continue;
    const yPrim = (y.primary_muscles   || []).map(m => String(m).toLowerCase());
    const ySec  = (y.secondary_muscles || []).map(m => String(m).toLowerCase());
    const yEq   = (y.equipment         || []).map(e => String(e).toLowerCase());

    let primaryOverlap = 0;
    for (const m of yPrim) if (sourcePrim.has(m)) primaryOverlap++;
    if (primaryOverlap === 0) continue;

    let secondaryOverlap = 0;
    for (const m of yPrim) if (sourceSec.has(m)) secondaryOverlap++;
    for (const m of ySec)  if (sourcePrim.has(m)) secondaryOverlap++;

    const equipmentShared = yEq.some(e => sourceEq.has(e));
    let score = primaryOverlap * 3 + secondaryOverlap;
    if (!equipmentShared && sourceEq.size > 0 && yEq.length > 0) score -= 1;

    scored.push({ exercise: y, score, primaryOverlap });
  }

  scored.sort((a, b) => b.score - a.score || b.primaryOverlap - a.primaryOverlap || a.exercise.name.localeCompare(b.exercise.name));
  return scored.slice(0, limit).map(s => s.exercise);
}
