/**
 * MCP tool: log_set (write)
 *
 * Append one completed set to an exercise on a given day. Finds the
 * exercise in the day's existing entries by exercise_id; if the
 * exercise hasn't been added to that day yet, creates the entry first
 * (resolving exercise_id → exercise_name from the catalog so the
 * exercise cards render correctly in the app). Does not create new
 * catalog exercises — search_exercises must find a match first, same
 * restraint NutriTrace's log_food applies to its own catalog lookup.
 *
 * Goes through mutateWorkoutDay (Option C merge), so a concurrent app
 * save landing in the same request window can't be silently clobbered.
 *
 * Planned sets (issue #140): a done set fills the exercise's next planned
 * set still to do in an unfinished workout (a program day started in the
 * app or with start_program_workout), as ticking it in the Diary would,
 * instead of adding a set after the planned ones. Which workout of the day
 * it goes to: see pickSession.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import db from '../../../db.js';
import { mutateWorkoutDay } from '../_workout-write.js';
import { recordsBeforeSave, sendNewRecords } from '../../log-webhooks.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';
import { logIntoSets } from '../../planned-workout.js';
import { sideHoldSec } from '../../volume.js';
import { toId } from '../../program-access.js';

/**
 * Core mutation, shared by the MCP tool below and the public REST API
 * (issue #77) at POST /api/v1/workouts/:date/sets. Sends pr.set for a set
 * that sets a record, as the app's PUT /api/workout/:date does.
 */
const _exercisesOf = (row) => { try { return JSON.parse(row.exercises || '[]') || []; } catch { return []; } };

/**
 * The workout of the day a set goes to, from the date's live workouts in
 * session order (issue #140; a date can have several, issue #76):
 *   1. the one named by workout_id;
 *   2. for a done set, the first unfinished one with a planned set of this
 *      exercise still to do, of the same kind (warm-up or working);
 *   3. the newest unfinished one started from a program's workout day (the
 *      app's Load Workout or start_program_workout), so a program day
 *      started after another workout that day gets the sets;
 *   4. the date's first, as before; with none, a new one.
 * A day with one workout, or with no program day under way, gets every set
 * where it always went.
 */
export function pickSession(live, { exerciseId, done, warmup, workoutId = null, day }) {
  if (workoutId != null) {
    const row = live.find(r => Number(r.id) === workoutId);
    if (!row) throw new Error(`No workout ${workoutId} on ${day}. start_program_workout returns the workout_id to use.`);
    return row;
  }
  const open = live.filter(r => !r.completed);
  if (done) {
    const planned = open.find(r => _exercisesOf(r).some(ex =>
      ex?.exercise_id === exerciseId && (ex.sets || []).some(st => st && !st.completed && !!st.warmup === warmup)));
    if (planned) return planned;
  }
  const programDays = open.filter(r => r.template_id != null);
  if (programDays.length) return programDays[programDays.length - 1];
  return live[0] || null;
}

// What each kind other than reps sends, its limits and its words (issues
// #89, #119). Seconds and calories are whole numbers; meters may have a
// fraction (a mile is 1609.344 m).
const AMOUNTS = [
  { kind: 'time', field: 'duration_sec', max: 86400, whole: true, word: 'time',
    bad: 'duration_sec must be a whole number of seconds between 1 and 86400.' },
  { kind: 'distance', field: 'distance_m', max: 1000000, whole: false, word: 'distance',
    bad: 'distance_m must be a distance in meters above 0 and up to 1000000.' },
  { kind: 'calories', field: 'calories', max: 100000, whole: true, word: 'calories',
    bad: 'calories must be a whole number between 1 and 100000.' },
];
const sentValue = (v) => v != null && v !== '';

export function logSetCore(userId, { exercise_id: exerciseIdSent, reps, weight, duration_sec, duration_l_sec, duration_r_sec, distance_m, calories, rpe, warmup, completed, date, workout_id } = {}) {
  // A number however it was sent: a Home Assistant template sends "12", and
  // a string id never matched the day's entry for that exercise.
  const exercise_id = toId(exerciseIdSent) ?? exerciseIdSent;
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);
  const workoutId = workout_id == null || workout_id === '' ? null : toId(workout_id);
  if (workout_id != null && workout_id !== '' && workoutId == null) {
    throw new Error('workout_id must be a workout id, as start_program_workout returns it.');
  }

  const catalogEx = db.prepare(
    'SELECT id, name, load_type, set_type FROM exercises WHERE id = ? AND deleted_at IS NULL AND (is_global = 1 OR created_by = ?)'
  ).get(exercise_id, userId);
  if (!catalogEx) throw new Error(`No exercise with id ${exercise_id} in the catalog. Use search_exercises to find a valid id.`);

  // Timed sets (issue #89) log a duration in whole seconds instead of reps,
  // distance sets (issue #119) meters, calorie sets calories. Validated
  // here rather than only in the MCP schema because the REST route hands
  // its body straight to this core.
  // A hold timed per side (issue #143) sends both sides; duration_sec is
  // the shorter one, worked out here when not sent, so records and every
  // reader that knows only duration_sec see the weaker side.
  let sides = null;
  if (sentValue(duration_l_sec) || sentValue(duration_r_sec)) {
    const l = Math.round(Number(duration_l_sec));
    const r = Math.round(Number(duration_r_sec));
    if (![l, r].every(v => Number.isFinite(v) && v > 0 && v <= 86400)) {
      throw new Error('duration_l_sec and duration_r_sec must both be whole numbers of seconds between 1 and 86400.');
    }
    const shorter = sideHoldSec(l, r);
    if (sentValue(duration_sec) && Math.round(Number(duration_sec)) !== shorter) {
      throw new Error(`duration_sec is the shorter side of a hold timed per side (${shorter}); send that or leave it out.`);
    }
    duration_sec = shorter;
    sides = { duration_l_sec: l, duration_r_sec: r };
  }
  const values = { duration_sec, distance_m, calories };
  const amounts = AMOUNTS.filter(a => sentValue(values[a.field]));
  if (amounts.length > 1) {
    throw new Error('Send only one of duration_sec, distance_m and calories.');
  }
  const amount = amounts[0] || null;
  const kind = amount ? amount.kind : 'reps';
  let value = null;
  if (amount) {
    const n = Number(values[amount.field]);
    value = amount.whole ? Math.round(n) : Math.round(n * 1000) / 1000;
    if (!Number.isFinite(value) || value <= 0 || value > amount.max) throw new Error(amount.bad);
  }
  if (!amount && reps == null) {
    throw new Error('Send reps for a rep set, duration_sec for a timed set (plank, hold), distance_m for a distance set (row, sled, carry, run), or calories for a calorie set (air bike).');
  }

  const newSet = amount
    ? {
        uuid: randomUUID(),
        reps: 0,
        weight: weight ?? 0,
        [amount.field]: value,
        ...(sides || {}),
        completed: completed ?? true,
        warmup: warmup ?? false,
        rpe: rpe ?? null,
      }
    : {
        uuid: randomUUID(),
        reps,
        // Optional since timed sets need no load; a bodyweight rep set stores
        // 0 rather than undefined so every reader sees a number.
        weight: weight ?? 0,
        completed: completed ?? true,
        warmup: warmup ?? false,
        rpe: rpe ?? null,
      };

  // Records before the save, when this set could move one (pr.set, issue #79).
  // A planned set it fills keeps its planned weight when the call sends
  // none, so a done set without a weight still takes the snapshot.
  const probe = weight == null ? { ...newSet, weight: 1 } : newSet;
  const recordsBefore = recordsBeforeSave(userId, [{ exercise_id, ...(amount ? { set_type: kind } : {}), sets: [probe] }]);

  // What the call sent, for filling a planned set: anything not sent keeps
  // the planned value (logIntoSets).
  const sent = {
    weight: weight ?? undefined,
    reps: amount ? undefined : reps,
    duration_sec: kind === 'time' ? value : undefined,
    duration_l_sec: sides ? sides.duration_l_sec : undefined,
    duration_r_sec: sides ? sides.duration_r_sec : undefined,
    distance_m: kind === 'distance' ? value : undefined,
    calories: kind === 'calories' ? value : undefined,
    rpe: rpe ?? undefined,
    warmup: !!warmup,
    completed: newSet.completed,
  };
  const done = newSet.completed !== false;
  let chosen = null;
  let logged = newSet;
  let filled = false;
  let loggedExercise = null;
  const result = mutateWorkoutDay(userId, day, (exercises) => {
    const next = exercises.map(ex => ({ ...ex, sets: [...(ex.sets || [])] }));
    let target = next.find(ex => ex.exercise_id === exercise_id);
    if (!target) {
      target = { uuid: randomUUID(), exercise_id, exercise_name: catalogEx.name, sets: [] };
      // Stamp the type onto a new entry so the app shows the right input
      // without needing to consult the library row.
      if (amount) target.set_type = kind;
      next.push(target);
    }
    // An entry whose type was chosen explicitly must not silently collect
    // sets of another kind; they would render and count wrongly. A type
    // this server doesn't know is left alone, as before.
    const own = AMOUNTS.find(a => a.kind === target.set_type) || (target.set_type === 'reps' ? { kind: 'reps' } : null);
    if (own && own.kind !== kind) {
      const want = own.kind === 'reps' ? 'reps' : own.field;
      const got = amount ? amount.field : 'reps';
      throw new Error(`${catalogEx.name} is tracked by ${own.word || 'reps'} on ${day}; send ${want} instead of ${got}.`);
    }
    if (chosen && !chosen.completed) {
      // An unfinished workout: the next planned set still to do, if any.
      const out = logIntoSets(target.sets, sent, newSet, { at: new Date().toISOString() });
      target.sets = out.sets;
      logged = out.sets[out.index];
      filled = out.filled;
    } else {
      target.sets.push(newSet);
    }
    loggedExercise = target;
    return next;
  }, {
    pick: (live) => {
      chosen = pickSession(live, { exerciseId: exercise_id, done, warmup: !!warmup, workoutId, day });
      return chosen;
    },
  });

  // Re-read the merged exercise back out (mutateWorkoutDay may have
  // reconciled concurrent server-side changes since the callback ran).
  const merged = result.exercises.find(ex => ex.exercise_id === exercise_id) || loggedExercise;
  sendNewRecords(userId, day, recordsBefore);
  return {
    ok: true,
    date: day,
    exercise_id,
    exercise_name: catalogEx.name,
    workout_id: result.id,
    logged_set: logged,
    filled_planned_set: filled,
    sets_on_exercise: merged?.sets?.length ?? 1,
  };
}

export function registerLogSet(server, { userId }) {
  server.registerTool(
    'log_set',
    {
      title: 'Log Set',
      description:
        'Log one completed set to an exercise on a given day. Pass the ' +
        'exercise by exercise_id from search_exercises. In an unfinished ' +
        "workout (such as a program day from start_program_workout) it fills " +
        "the exercise's next planned set still to do, keeping planned values " +
        'not sent (the weight, say); otherwise it adds the set, creating the ' +
        "exercise entry for that day if it isn't there yet. It goes to the " +
        'workout named by workout_id, else the unfinished workout with that ' +
        "set planned, else the day's unfinished program workout, else the " +
        "day's first. Date defaults to today in the server's timezone. For a " +
        'timed exercise (plank, wall sit, dead hang) send duration_sec ' +
        'instead of reps (an Alternating hold timed per side, such as a ' +
        'side plank, sends duration_l_sec and duration_r_sec, and ' +
        'duration_sec is then the shorter side); for a distance exercise (rower, SkiErg, sled, ' +
        'carry, run) send distance_m in meters; for a calorie exercise (air ' +
        'bike) send calories. Weight is optional with any of them and means ' +
        'the load (a weighted hold, a loaded sled). search_exercises reports set_type.',
      inputSchema: {
        exercise_id: z.number().int().positive(),
        reps: z.number().int().min(0).max(1000).optional(),
        weight: z.number().min(0).max(10000).optional(),
        duration_sec: z.number().int().min(1).max(86400).optional(),
        duration_l_sec: z.number().int().min(1).max(86400).optional(),
        duration_r_sec: z.number().int().min(1).max(86400).optional(),
        distance_m: z.number().positive().max(1000000).optional(),
        calories: z.number().int().min(1).max(100000).optional(),
        rpe: z.number().min(1).max(10).optional(),
        warmup: z.boolean().optional(),
        completed: z.boolean().optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        workout_id: z.number().int().positive().optional(),
      },
    },
    async ({ exercise_id, reps, weight, duration_sec, duration_l_sec, duration_r_sec, distance_m, calories, rpe, warmup, completed, date, workout_id }) => {
      try {
        return toolResult(logSetCore(userId, { exercise_id, reps, weight, duration_sec, duration_l_sec, duration_r_sec, distance_m, calories, rpe, warmup, completed, date, workout_id }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
