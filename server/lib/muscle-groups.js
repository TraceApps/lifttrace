/**
 * Collapse the many ways exercise libraries name a muscle ("Pectoralis",
 * "front delts", "Quadriceps") into the groups Muscle Balance shows.
 * Shared by the Statistics route and the weekly summary so both agree.
 * An identical copy lives in src/lib/muscle-groups.js for the Android
 * app's offline Statistics; scripts/native-stats-parity.test.js compares them.
 */
export function normalizeMuscle(m) {
  const s = (m || '').toLowerCase().trim();
  // Normalize variants
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
  if (s.includes('leg')) return 'legs';
  if (s.includes('arm')) return 'arms';
  if (s.includes('cardio')) return 'cardio';
  return s || 'other';
}
