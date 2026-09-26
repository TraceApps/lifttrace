/**
 * Body-map muscle load: which of the 18 drawable muscles an exercise works,
 * and how much, from its primary and secondary muscles (or its category when
 * it has none). Used by GET /api/stats/muscle-effective-sets.
 *
 * An identical copy lives in src/lib/muscle-load.js so the Android app's offline Statistics
 * give the same body map as the server (issue #101);
 * scripts/native-stats-parity.test.js fails if the two ever differ.
 */
// Primary muscle weight = 1.0, secondary = 0.4 (both are per-set, so a 4×8
// bench weighs four times a single set). Same constant openGym uses.
const _MUSCLE_SECONDARY = 0.4;

// The 18 muscles the body map can shade. Order matches head-to-toe so any
// list built off this reads top-down. Kept in sync with client-side muscles.js.
export const MUSCLES_18 = [
  'trapezius','deltoids','chest','upper-back','serratus',
  'biceps','triceps','forearm',
  'abs','obliques','lower-back',
  'gluteal','quadriceps','hamstring','adductors','hip-flexors',
  'calves','tibialis',
];

// Every spelling that shows up in wger/exerciseDB/free-db + custom imports,
// folded onto the 18 drawable muscles. null = deliberately not drawable
// (hands, ankles, cardio) rather than guessed at.
const _ALIAS = {
  abs: 'abs', pectorals: 'chest', chest: 'chest', 'upper chest': 'chest',
  biceps: 'biceps', brachialis: 'biceps',
  triceps: 'triceps',
  glutes: 'gluteal', gluteal: 'gluteal', abductors: 'gluteal',
  delts: 'deltoids', deltoids: 'deltoids', shoulders: 'deltoids',
  'rear deltoids': 'deltoids', 'rotator cuff': 'deltoids',
  'upper back': 'upper-back', lats: 'upper-back', 'latissimus dorsi': 'upper-back',
  back: 'upper-back', rhomboids: 'upper-back',
  calves: 'calves', soleus: 'calves',
  quads: 'quadriceps', quadriceps: 'quadriceps',
  forearms: 'forearm', forearm: 'forearm', wrists: 'forearm',
  'wrist flexors': 'forearm', 'wrist extensors': 'forearm', 'grip muscles': 'forearm',
  hamstrings: 'hamstring', hamstring: 'hamstring',
  spine: 'lower-back', 'lower back': 'lower-back',
  traps: 'trapezius', trapezius: 'trapezius', 'levator scapulae': 'trapezius',
  adductors: 'adductors', groin: 'adductors', 'inner thighs': 'adductors',
  'serratus anterior': 'serratus', serratus: 'serratus',
  core: 'abs', abdominals: 'abs', 'lower abs': 'abs',
  obliques: 'obliques',
  'hip flexors': 'hip-flexors',
  shins: 'tibialis', tibialis: 'tibialis',
  // wger names its muscles in Latin (see MUSCLE_MAP in
  // src/lib/exercise-sources/wger.js), and nine of its fifteen were missing
  // here. Every wger exercise using them lost those muscles, and when none
  // were left fell back to a guess from its category: a set of lunges read
  // as a generic leg day, a curl credited the triceps (issue #110).
  'biceps brachii': 'biceps', 'triceps brachii': 'triceps',
  'anterior deltoid': 'deltoids', 'pectoralis major': 'chest',
  'rectus abdominis': 'abs',
  'obliquus externus': 'obliques', 'obliquus externus abdominis': 'obliques',
  'quadriceps femoris': 'quadriceps', 'gluteus maximus': 'gluteal',
  gastrocnemius: 'calves',
  // Free Exercise DB's name for the rhomboids and mid traps.
  'middle back': 'upper-back',
  neck: null,
  'cardiovascular system': null, cardio: null,
  ankles: null, feet: null, hands: null,
  'ankle stabilizers': null, sternocleidomastoid: null,
};

// Fallback when an exercise has no recognised primary muscles — custom
// exercises often only carry a body-part category. Weights within a group
// sum to ~1 so "upper legs" spreads across three muscles rather than
// counting triple.
const _BY_CATEGORY = {
  chest: { chest: 1 },
  back: { 'upper-back': 0.75, 'lower-back': 0.25 },
  shoulders: { deltoids: 1 },
  'upper arms': { biceps: 0.5, triceps: 0.5 },
  arms: { biceps: 0.4, triceps: 0.4, forearm: 0.2 },
  'lower arms': { forearm: 1 },
  waist: { abs: 0.7, obliques: 0.3 },
  core: { abs: 0.7, obliques: 0.3 },
  'upper legs': { quadriceps: 0.4, hamstring: 0.35, gluteal: 0.25 },
  legs: { quadriceps: 0.35, hamstring: 0.3, gluteal: 0.2, calves: 0.15 },
  'lower legs': { calves: 0.8, tibialis: 0.2 },
  neck: { trapezius: 1 },
};

// Reduce one exercise's primary + secondary muscles + category fallback to
// a { slug: 0…1 } map. Takes the max weight per slug (a muscle listed as
// both primary and secondary counts as primary, not 1.4).
export function musclesOf(info) {
  const out = {};
  const add = (name, w) => {
    const slug = _ALIAS[String(name || '').toLowerCase().trim()];
    if (slug) out[slug] = Math.max(out[slug] || 0, w);
  };
  (info.primary || []).forEach(m => add(m, 1));
  (info.secondary || []).forEach(m => add(m, _MUSCLE_SECONDARY));
  if (!Object.keys(out).length && info.category) {
    const fallback = _BY_CATEGORY[info.category];
    if (fallback) Object.assign(out, fallback);
  }
  return out;
}
