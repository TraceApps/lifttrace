/**
 * holdMatch.js: does a hold-timer record belong to a given set? (issue #89)
 *
 * Kept apart from stores/holdTimer.js, which pulls in Capacitor through the
 * rest timer, so this identity rule can be unit tested for real.
 *
 * Exercise and set uuids win when present, since positions shift when
 * exercises are reordered or a different session of the day is open; the
 * index match is the fallback for a brand-new exercise that has not been
 * saved yet and so has no uuid.
 *
 * @param {object|null} hold  running hold or published result
 * @param {object} where      { date, exIdx, exercise, setIdx? }; omit setIdx
 *                            to ask only whether the exercise matches
 */
export function holdMatches(hold, { date, exIdx, exercise, setIdx } = {}) {
  if (!hold || hold.date !== date || !exercise) return false;
  const sameExercise = hold.exerciseUuid && exercise.uuid
    ? hold.exerciseUuid === exercise.uuid
    : hold.exIdx === exIdx && hold.exerciseId === (exercise.exercise_id ?? null);
  if (!sameExercise) return false;
  if (setIdx == null) return true;
  const set = exercise.sets?.[setIdx];
  if (hold.setUuid && set?.uuid) return hold.setUuid === set.uuid;
  return hold.setIdx === setIdx;
}
