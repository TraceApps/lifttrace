import { parseCsv, convertWeight } from './common.js';

/**
 * FitNotes CSV export (popular free Android app).
 *
 * Typical header:
 *   Date,Exercise,Category,Weight (kgs),Reps,Distance,Distance Unit,Time,Comment
 *
 * Notes:
 *   - Unit lives IN the header column name — either "Weight (kgs)" or
 *     "Weight (lbs)". We detect it from the header.
 *   - No workout-name column. FitNotes organizes purely by date, so every
 *     imported workout for a given day lands as one workout_log row named
 *     by the trained muscle categories (e.g. "Chest / Back").
 *   - One row per set. Comma-delimited.
 */
export function parseFitnotes(csvText, userUnit) {
  const rows = parseCsv(csvText, ',');
  if (rows.length === 0) return [];

  // Detect weight unit from whichever "weight (...)" header exists
  const headerKeys = Object.keys(rows[0]);
  const weightKey = headerKeys.find(k => /^weight\b/i.test(k)) || 'weight';
  const unitMatch = weightKey.match(/\(([^)]+)\)/);
  const sourceUnit = unitMatch ? (unitMatch[1].toLowerCase().startsWith('kg') ? 'kg' : 'lbs') : 'lbs';

  const byDate = new Map();
  for (const row of rows) {
    const date = (row['date'] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const exName = (row['exercise'] || '').trim();
    if (!exName) continue;
    const category = (row['category'] || '').trim();
    const reps = parseInt(row['reps'] || '0', 10) || 0;
    const weight = convertWeight(row[weightKey] || '0', sourceUnit, userUnit);
    const comment = (row['comment'] || '').trim();

    if (!byDate.has(date)) byDate.set(date, { categories: new Set(), exercises: new Map() });
    const day = byDate.get(date);
    if (category) day.categories.add(category);
    if (!day.exercises.has(exName)) day.exercises.set(exName, []);
    day.exercises.get(exName).push({ reps, weight, completed: true, notes: comment, rpe: null });
  }

  const out = [];
  for (const [date, day] of byDate) {
    const cats = [...day.categories].slice(0, 3);
    const name = cats.length ? cats.join(' / ') : 'Workout';
    const exercises = [...day.exercises.entries()].map(([exName, sets]) => ({
      sourceName: exName,
      exercise_id: null,
      exercise_name: exName,
      superset_id: null,
      superset_size: 1,
      sets,
    }));
    out.push({ date, name, notes: '', duration_min: null, exercises });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
