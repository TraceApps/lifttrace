/**
 * garmin-fit.js — parse a Garmin `.fit` binary file and emit the same
 * canonical workout shape that the CSV importers (strong/hevy/fitnotes/
 * jefit) produce, so the shared /api/workout-import/preview + /commit
 * routes can consume it without any special-casing.
 *
 * The FIT format is Garmin's proprietary binary layout for activities.
 * We use @garmin/fitsdk (official, zero-dependency, actively
 * maintained) rather than the third-party fit-file-parser package —
 * the latter has a switch-case gap that silently drops SET messages
 * (only the last of a workout survives parsing), which would make
 * strength imports lose 90%+ of a user's sets.
 *
 * Strength-training-only. Cardio activities (running / cycling /
 * generic workouts with no SET messages) are rejected at parse time
 * with a clear error the route surfaces to the user.
 *
 * Canonical output shape (per common workout-import contract):
 *
 *   [{
 *     date:          'YYYY-MM-DD',
 *     name:          'Workout',
 *     notes:         null,
 *     duration_min:  number | null,
 *     exercises: [{
 *       sourceName:    'Barbell Bench Press',
 *       exercise_id:   null,  (route fuzzy-matches later)
 *       exercise_name: 'Barbell Bench Press',
 *       superset_id:   null,
 *       superset_size: 1,
 *       sets: [{
 *         reps:     number,
 *         weight:   number,   (in userUnit)
 *         completed: true,
 *         notes:    ''
 *       }, ...]
 *     }, ...]
 *   }, ...]
 */

import { Decoder, Stream } from '@garmin/fitsdk';
import { garminSetToExerciseName } from './garmin-exercise-map.js';
import { convertWeight } from './common.js';

/**
 * Parse a .fit binary buffer. Returns an array of canonical workouts
 * (usually 1 per file — Garmin writes one activity per FIT).
 *
 * Throws if the file isn't a valid FIT, doesn't contain any SET
 * messages (i.e. isn't a strength workout), or fails integrity check.
 */
export function parseGarminFit(buffer, userUnit) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty file');
  }

  const stream = Stream.fromBuffer(buffer);
  const decoder = new Decoder(stream);

  if (!decoder.isFIT()) {
    throw new Error('Not a FIT file');
  }
  if (!decoder.checkIntegrity()) {
    // Not fatal — Garmin Connect exports sometimes fail strict integrity
    // even when the payload is fine. Log-worthy but keep going.
  }

  const { messages, errors } = decoder.read();
  if (errors && errors.length) {
    // Surface parse errors as a warning but proceed if messages
    // still came back; a broken tail record shouldn't discard the
    // rest of the workout.
  }

  const setMesgs     = messages.setMesgs     || [];
  const sessionMesgs = messages.sessionMesgs || [];
  const fileIdMesgs  = messages.fileIdMesgs  || [];

  if (setMesgs.length === 0) {
    const sport = sessionMesgs[0]?.sport;
    const hint  = sport && sport !== 'training'
      ? `This looks like a ${sport} activity; LiftTrace only imports strength training.`
      : 'No strength-training sets found in the file. Try NutriTrace federation for cardio + wellness data.';
    throw new Error(hint);
  }

  // Date + workout name come from the session (or fall back to the
  // file_id message's created-at timestamp for orphaned files).
  const session = sessionMesgs[0] || {};
  const rawDate =
    session.startTime ||
    fileIdMesgs[0]?.timeCreated ||
    setMesgs[0]?.startTime ||
    new Date();
  const date = _toIsoDate(rawDate);

  const durationSec =
    session.totalTimerTime ||
    session.totalElapsedTime ||
    _durationFromSets(setMesgs);
  const durationMin = durationSec ? Math.round(durationSec / 60) : null;

  // Group consecutive same-name active sets into a single exercise
  // entry, matching how LT's own SetRow accumulates sets per exercise.
  // 'rest_time' SET messages are between-set rests; we drop them but
  // could later surface them as programmed rest overrides.
  const workingSets = setMesgs
    .filter(s => s.setType === 'active')
    .map(s => ({
      exerciseName: garminSetToExerciseName(s.category?.[0], s.categorySubtype?.[0]),
      reps:   Number(s.repetitions) || 0,
      // Garmin stores weight in kg × 16 (scale factor 16). @garmin/fitsdk
      // decodes the scale for us — s.weight is already in kg as a float.
      weightKg: s.weight != null ? Number(s.weight) : 0,
      duration: s.duration || null,
    }));

  if (workingSets.length === 0) {
    throw new Error('The FIT file has no active sets (only rests). Nothing to import.');
  }

  const exercises = [];
  for (const ws of workingSets) {
    const weight = convertWeight(String(ws.weightKg), 'kg', userUnit);
    const setRow = {
      reps:      ws.reps,
      weight,
      completed: true,
      notes:     '',
    };
    // Append to the last exercise if same name, else start a new one.
    // This preserves the original set ordering from the FIT stream.
    const last = exercises[exercises.length - 1];
    if (last && last.sourceName === ws.exerciseName) {
      last.sets.push(setRow);
    } else {
      exercises.push({
        sourceName:    ws.exerciseName,
        exercise_id:   null,
        exercise_name: ws.exerciseName,
        superset_id:   null,
        superset_size: 1,
        sets:          [setRow],
      });
    }
  }

  return [{
    date,
    name:         session.workoutName || 'Garmin Workout',
    notes:        null,
    duration_min: durationMin,
    exercises,
  }];
}

/** Extract a YYYY-MM-DD date string from a Date, epoch-ms number, or
 *  Garmin timestamp (seconds since 1989-12-31). SDK usually gives us
 *  a Date already; the fallbacks are defensive. */
function _toIsoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    return v.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/** When no session totalTimerTime, sum the SET durations as a proxy. */
function _durationFromSets(setMesgs) {
  let sec = 0;
  for (const s of setMesgs) sec += Number(s.duration) || 0;
  return sec;
}
