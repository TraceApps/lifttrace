// Display-side helpers for the body-map. The heavy lifting (aggregating
// completed sets by muscle in the 18-slug vocabulary) happens server-side
// in server/routes/stats.js muscle-effective-sets, so this file only
// carries what the SVG needs to render.
//
// The 18 slugs + spelling alias table were ported from openGym
// (github.com/DuarteSantos8/openGym, AGPL-3.0) as part of the LT muscle-
// map port. See NOTICE-style comment in bodyPaths.js for SVG geometry
// attribution.

// Head-to-toe order so any list built from this reads top-down like a body.
export const MUSCLES = [
  'trapezius', 'deltoids', 'chest', 'upper-back', 'serratus',
  'biceps', 'triceps', 'forearm',
  'abs', 'obliques', 'lower-back',
  'gluteal', 'quadriceps', 'hamstring', 'adductors', 'hip-flexors',
  'calves', 'tibialis',
];

// Drawn as silhouette, never shaded — they carry no training load.
export const INERT = ['head', 'hair', 'neck', 'hands', 'feet', 'knees', 'ankles'];

// Display names. English source strings; when i18n arrives in v1.1.0
// these become keys under stats.muscle.*.
export const MUSCLE_NAME = {
  trapezius: 'Traps', deltoids: 'Shoulders', chest: 'Chest', 'upper-back': 'Upper Back',
  serratus: 'Serratus', biceps: 'Biceps', triceps: 'Triceps', forearm: 'Forearms',
  abs: 'Abs', obliques: 'Obliques', 'lower-back': 'Lower Back', gluteal: 'Glutes',
  quadriceps: 'Quads', hamstring: 'Hamstrings', adductors: 'Adductors',
  'hip-flexors': 'Hip Flexors', calves: 'Calves', tibialis: 'Shins',
};

/**
 * Shade buckets 0…4 per muscle, relative to the hardest-worked muscle in
 * the same window. Relative not absolute on purpose: the map answers "is
 * my training balanced", which only means anything as a comparison within
 * one period.
 */
export function levelsOf(load) {
  const max = Math.max(0, ...MUSCLES.map(m => load[m] || 0));
  const lv = {};
  for (const m of MUSCLES) {
    const v = load[m] || 0;
    lv[m] = !v ? 0 : max <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((v / max) * 4)));
  }
  return lv;
}

/** Muscles sorted hardest-worked first; untrained ones last, in body order. */
export function rankOf(load) {
  const worked = MUSCLES.filter(m => (load[m] || 0) > 0).sort((a, b) => (load[b] || 0) - (load[a] || 0));
  const missed = MUSCLES.filter(m => !((load[m] || 0) > 0));
  return { worked, missed };
}
