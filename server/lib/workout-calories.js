/**
 * workout-calories.js: the calories a workout burned, as the app works them
 * out, for a workout finished somewhere that can't work them out itself (the
 * watch, see watch-finish.js).
 *
 * The server's copy of estimateWorkoutCalories and ageFromDob in
 * src/lib/workout.js: the server can't import src/ (the Docker image only
 * carries src/lib/exercise-sources), so it keeps its own, and
 * scripts/watch-finish.test.js runs the same cases through both so they
 * can't drift apart. Volume comes from volume.js, itself kept in step with
 * the app's by scripts/set-type.test.js.
 */
import { exerciseVolume } from './volume.js';

/**
 * Mifflin-St Jeor BMR times a MET of 5.0, or 6.0 above 200 volume a minute,
 * over the workout's length (or about 3 minutes a completed working set
 * when no length was recorded). Null when the profile is missing a weight,
 * a height or an age.
 */
export function estimateWorkoutCalories(workout, profile) {
  if (!workout || !profile) return null;
  const { weight_kg, height_cm, age, sex } = profile;
  if (!weight_kg || !height_cm || !age) return null;
  let duration_min = workout.duration_min || 0;
  if (duration_min <= 0) {
    const workingSets = (workout.exercises || []).reduce(
      (acc, ex) => acc + (ex.sets || []).filter(s => s.completed && !s.warmup).length,
      0,
    );
    if (workingSets <= 0) return null;
    duration_min = workingSets * 3;
  }
  let bmr;
  const base = (10 * weight_kg) + (6.25 * height_cm) - (5 * age);
  if (sex === 'male')        bmr = base + 5;
  else if (sex === 'female') bmr = base - 161;
  else                       bmr = base - 78;
  let totalVolume = 0;
  for (const ex of workout.exercises || []) totalVolume += exerciseVolume(ex);
  const intensity = duration_min > 0 ? totalVolume / duration_min : 0;
  const met = intensity >= 200 ? 6.0 : 5.0;
  const kcal = (bmr / 24) * met * (duration_min / 60);
  return Math.max(0, Math.round(kcal));
}

/** Age in whole years from a YYYY-MM-DD date of birth, or null. */
export function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  const d = new Date(dob + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}
