/**
 * garmin-exercise-map.js — resolve Garmin's numeric (category, subtype)
 * pair into a human-readable exercise name suitable for LT's fuzzy
 * matcher.
 *
 * The FIT SET message carries:
 *   category:         string (already-decoded exerciseCategory enum, e.g. 'benchPress')
 *   categorySubtype:  uint16 (undecoded — subtype's meaning depends on category)
 *
 * Garmin stores the subtype enum per-category — every category has its
 * own subtype table:
 *   benchPress    → benchPressExerciseName    (27 entries: barbellBenchPress, etc.)
 *   deadlift      → deadliftExerciseName      (~20 entries)
 *   squat         → squatExerciseName         (~30 entries)
 *   ... (33+ categories × 10-30 subtypes each)
 *
 * The SDK's Profile.types object already contains every subtype table.
 * We just need to look up the right table by category name, decode the
 * numeric subtype, and title-case the resulting camelCase string for
 * display.
 *
 * Output format: "Barbell Bench Press", "Romanian Deadlift", etc. —
 * matches the naming convention in LT's exercise library, which lets
 * the existing fuzzy matcher (common.js#matchExercise) find local
 * exercises without a manual map table.
 */

import { Profile } from '@garmin/fitsdk';

/**
 * Convert a camelCase Garmin identifier into a Title Case display name.
 *   barbellBenchPress            → "Barbell Bench Press"
 *   alternatingDumbbellChestPressOnSwissBall
 *                                → "Alternating Dumbbell Chest Press On Swiss Ball"
 *   deadlift                     → "Deadlift"
 */
function camelToTitleCase(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

/**
 * Look up the subtype enum table for a given category. Table keys are
 * camelCase (`benchPress` → `benchPressExerciseName`).
 * Returns undefined if the category has no known subtype table.
 */
function subtypeTableFor(category) {
  if (!category) return undefined;
  return Profile.types[`${category}ExerciseName`];
}

/**
 * Given the raw (category, categorySubtype) values from a decoded FIT
 * SET message, return a display name for the exercise.
 *
 * category is already a string (SDK decodes the exerciseCategory enum
 * for us); categorySubtype is a uint16 that we resolve against the
 * per-category subtype enum.
 *
 * Fallback chain:
 *   1. subtype resolved via per-category table         → "Barbell Bench Press"
 *   2. subtype missing but category present            → "Bench Press" (from category)
 *   3. everything missing                              → "Unknown Exercise"
 */
export function garminSetToExerciseName(category, categorySubtype) {
  const table = subtypeTableFor(category);
  const subtypeName = table ? table[String(categorySubtype)] : undefined;

  if (subtypeName) return camelToTitleCase(subtypeName);
  if (category)    return camelToTitleCase(category);
  return 'Unknown Exercise';
}
