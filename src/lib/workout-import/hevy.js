import { parseCsv, convertWeight } from './common.js';

/**
 * Hevy CSV export format:
 *   title,start_time,end_time,description,exercise_title,superset_id,
 *   exercise_notes,set_index,set_type,weight_kg,reps,distance_km,
 *   duration_seconds,rpe
 *
 * Comma-delimited. One row per set. Start/end times give us workout duration.
 * Weight is ALWAYS kg. Has superset_id which we preserve.
 */
export function parseHevy(csvText, userUnit) {
  const rows = parseCsv(csvText, ',');
  if (rows.length === 0) return [];

  const f = {
    title:         'title',
    startTime:     'start_time',
    endTime:       'end_time',
    description:   'description',
    exercise:      'exercise_title',
    supersetId:    'superset_id',
    exerciseNotes: 'exercise_notes',
    setIndex:      'set_index',
    setType:       'set_type',
    weightKg:      'weight_kg',
    reps:          'reps',
    distanceKm:    'distance_km',
    durationSec:   'duration_seconds',
    rpe:           'rpe',
  };

  // Group by (title + start_time) since Hevy workouts can share a title
  // across multiple days (e.g. "Push Day" logged every Monday).
  const byKey = new Map();
  for (const row of rows) {
    const title = row[f.title] || 'Workout';
    const startRaw = row[f.startTime] || '';
    if (!startRaw) continue;

    // Hevy start_time format: "01 Aug 2024, 18:23"
    const date = _parseHevyDate(startRaw);
    if (!date) continue;

    const exName = row[f.exercise] || '';
    if (!exName) continue;

    const weight = convertWeight(row[f.weightKg] || '0', 'kg', userUnit);
    const reps = parseInt(row[f.reps] || '0', 10) || 0;
    const rpe = parseFloat(row[f.rpe] || '') || null;
    const setType = (row[f.setType] || 'normal').toLowerCase();
    const exerciseNotes = row[f.exerciseNotes] || '';
    const ssIdRaw = row[f.supersetId] || '';
    const supersetId = ssIdRaw && ssIdRaw !== '-1' ? ssIdRaw : null;

    const key = `${date}|${title}|${startRaw}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        date,
        name: title,
        startRaw,
        endRaw: row[f.endTime] || '',
        description: row[f.description] || '',
        exerciseOrder: [],            // preserves CSV order
        byExercise: new Map(),
        supersetIdMap: new Map(),     // hevy-ss-id -> our numeric id
      });
    }
    const workout = byKey.get(key);
    if (!workout.byExercise.has(exName)) {
      workout.byExercise.set(exName, { supersetIdRaw: supersetId, notes: exerciseNotes, sets: [] });
      workout.exerciseOrder.push(exName);
    }
    workout.byExercise.get(exName).sets.push({
      reps, weight, completed: true,
      notes: rpe ? `${setType !== 'normal' ? setType + ' ' : ''}RPE ${rpe}`.trim()
                 : (setType !== 'normal' ? setType : ''),
      rpe,
    });
  }

  // Flatten + assign numeric superset_ids (Hevy exports ss ids per-workout as
  // arbitrary strings/numbers; we remap to our own integer ids per workout).
  const out = [];
  for (const workout of byKey.values()) {
    let nextSsId = 1;
    const ssMap = new Map(); // rawSsId -> numeric
    const exercises = [];
    for (const exName of workout.exerciseOrder) {
      const ex = workout.byExercise.get(exName);
      let mySsId = null;
      if (ex.supersetIdRaw) {
        if (!ssMap.has(ex.supersetIdRaw)) ssMap.set(ex.supersetIdRaw, nextSsId++);
        mySsId = ssMap.get(ex.supersetIdRaw);
      }
      exercises.push({
        sourceName: exName,
        exercise_id: null,
        exercise_name: exName,
        superset_id: mySsId,
        superset_size: 1,     // back-fill below
        sets: ex.sets,
      });
    }
    // Back-fill superset_size
    const ssCounts = new Map();
    for (const ex of exercises) if (ex.superset_id != null) ssCounts.set(ex.superset_id, (ssCounts.get(ex.superset_id) || 0) + 1);
    for (const ex of exercises) if (ex.superset_id != null) ex.superset_size = ssCounts.get(ex.superset_id);

    out.push({
      date: workout.date,
      name: workout.name,
      notes: workout.description,
      duration_min: _hevyDurationMin(workout.startRaw, workout.endRaw),
      exercises,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// "01 Aug 2024, 18:23" -> "2024-08-01"
function _parseHevyDate(raw) {
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) {
    // Fallback: ISO-like format
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : null;
  }
  const mon = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
}

function _hevyDurationMin(start, end) {
  if (!start || !end) return null;
  const s = _parseHevyDateTime(start);
  const e = _parseHevyDateTime(end);
  if (!s || !e) return null;
  const mins = Math.round((e - s) / 60000);
  return mins > 0 && mins < 600 ? mins : null;
}

function _parseHevyDateTime(raw) {
  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = months[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  if (mon == null) return null;
  return new Date(parseInt(m[3]), mon, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).getTime();
}
