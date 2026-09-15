import { parseCsv, convertWeight } from './common.js';

/**
 * Strong CSV export format (as of 2024+):
 *   Date;Workout Name;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE;Weight Unit
 *
 * Delimiter is SEMICOLON. One row per set. Date includes time.
 *
 * Older exports (pre-2023) used a slightly different column set — we read by
 * header name so both are tolerated. Distance is still ignored. Seconds is
 * read for timed sets (issue #89): a row with seconds and no reps is a
 * plank, hold or carry, and used to arrive as an empty 0 x 0 set.
 */
export function parseStrong(csvText, userUnit) {
  const rows = parseCsv(csvText, ';');
  if (rows.length === 0) return [];

  // Header normalization: Strong uses Title Case; parseCsv lowercases.
  const fieldMap = {
    date:        'date',
    workoutName: 'workout name',
    exercise:    'exercise name',
    setOrder:    'set order',
    weight:      'weight',
    reps:        'reps',
    notes:       'notes',
    workoutNotes:'workout notes',
    rpe:         'rpe',
    weightUnit:  'weight unit',
    seconds:     'seconds',
    distance:    'distance',
  };

  // Group: date -> workoutName -> exerciseName -> [sets]
  const byDate = new Map();
  for (const row of rows) {
    const rawDate = row[fieldMap.date] || '';
    if (!rawDate) continue;
    // Strong's format: "2024-08-01 18:23:30" — take the date portion only
    const date = rawDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const workoutName = row[fieldMap.workoutName] || 'Workout';
    const exerciseName = row[fieldMap.exercise] || '';
    if (!exerciseName) continue;

    const reps = parseInt(row[fieldMap.reps] || '0', 10) || 0;
    // Timed only when there are seconds and no reps. Strong can put a value
    // in both for some exercises; those stay rep sets rather than guessing.
    const seconds = parseInt(row[fieldMap.seconds] || '0', 10) || 0;
    const timed = seconds > 0 && reps === 0;
    // Weight can be empty for bodyweight exercises
    const rawWeight = row[fieldMap.weight] || '0';
    const rowUnit = (row[fieldMap.weightUnit] || userUnit || 'lbs').toLowerCase();
    const weight = convertWeight(rawWeight, rowUnit, userUnit);
    const rpe = parseFloat(row[fieldMap.rpe] || '') || null;
    const notes = row[fieldMap.notes] || '';
    const workoutNotes = row[fieldMap.workoutNotes] || '';

    if (!byDate.has(date)) byDate.set(date, new Map());
    const byWorkout = byDate.get(date);
    if (!byWorkout.has(workoutName)) byWorkout.set(workoutName, { notes: workoutNotes, exercises: new Map() });
    const workout = byWorkout.get(workoutName);
    if (!workout.exercises.has(exerciseName)) workout.exercises.set(exerciseName, []);
    workout.exercises.get(exerciseName).push({
      reps, weight, completed: true,
      ...(timed ? { duration_sec: seconds } : {}),
      notes: rpe ? `${notes ? notes + ' ' : ''}RPE ${rpe}`.trim() : notes,
      rpe,
    });
  }

  // Flatten to canonical array
  const out = [];
  for (const [date, byWorkout] of byDate) {
    for (const [workoutName, workout] of byWorkout) {
      const exercises = [];
      for (const [exName, sets] of workout.exercises) {
        exercises.push({
          sourceName: exName,
          exercise_id: null,
          exercise_name: exName,
          superset_id: null,
          superset_size: 1,
          sets,
          // Stamped when every set is timed, so the diary shows a time input.
          ...(sets.length && sets.every(s => s.duration_sec > 0) ? { set_type: 'time' } : {}),
        });
      }
      out.push({ date, name: workoutName, notes: workout.notes, duration_min: null, exercises });
    }
  }
  // Sort chronologically
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
