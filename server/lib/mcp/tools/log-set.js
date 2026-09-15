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
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import db from '../../../db.js';
import { mutateWorkoutDay } from '../_workout-write.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

/**
 * Core mutation, shared by the MCP tool below and the public REST API
 * (issue #77) at POST /api/v1/workouts/:date/sets.
 */
export function logSetCore(userId, { exercise_id, reps, weight, duration_sec, rpe, warmup, completed, date } = {}) {
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const catalogEx = db.prepare(
    'SELECT id, name, load_type, set_type FROM exercises WHERE id = ? AND deleted_at IS NULL AND (is_global = 1 OR created_by = ?)'
  ).get(exercise_id, userId);
  if (!catalogEx) throw new Error(`No exercise with id ${exercise_id} in the catalog. Use search_exercises to find a valid id.`);

  // Timed sets (issue #89): planks, holds and carries log a duration in
  // whole seconds instead of reps. Validated here rather than only in the
  // MCP schema because the REST route hands its body straight to this core.
  const timed = duration_sec != null && duration_sec !== '';
  const dur = timed ? Math.round(Number(duration_sec)) : null;
  if (timed && (!Number.isFinite(dur) || dur <= 0 || dur > 86400)) {
    throw new Error('duration_sec must be a whole number of seconds between 1 and 86400.');
  }
  if (!timed && reps == null) {
    throw new Error('Send reps for a rep set, or duration_sec for a timed set (plank, hold, carry).');
  }

  const newSet = timed
    ? {
        uuid: randomUUID(),
        reps: 0,
        weight: weight ?? 0,
        duration_sec: dur,
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

  let loggedExercise = null;
  const result = mutateWorkoutDay(userId, day, (exercises) => {
    const next = exercises.map(ex => ({ ...ex, sets: [...(ex.sets || [])] }));
    let target = next.find(ex => ex.exercise_id === exercise_id);
    if (!target) {
      target = { uuid: randomUUID(), exercise_id, exercise_name: catalogEx.name, sets: [] };
      // Stamp the type onto a new entry so the app shows the right input
      // without needing to consult the library row.
      if (timed) target.set_type = 'time';
      next.push(target);
    }
    // An entry whose type was chosen explicitly must not silently collect
    // sets of the other kind; they would render and count wrongly.
    if (timed && target.set_type === 'reps') {
      throw new Error(`${catalogEx.name} is tracked by reps on ${day}; send reps instead of duration_sec.`);
    }
    if (!timed && target.set_type === 'time') {
      throw new Error(`${catalogEx.name} is tracked by time on ${day}; send duration_sec instead of reps.`);
    }
    target.sets.push(newSet);
    loggedExercise = target;
    return next;
  });

  // Re-read the merged exercise back out (mutateWorkoutDay may have
  // reconciled concurrent server-side changes since the callback ran).
  const merged = result.exercises.find(ex => ex.exercise_id === exercise_id) || loggedExercise;
  return {
    ok: true,
    date: day,
    exercise_id,
    exercise_name: catalogEx.name,
    logged_set: newSet,
    sets_on_exercise: merged?.sets?.length ?? 1,
  };
}

export function registerLogSet(server, { userId }) {
  server.registerTool(
    'log_set',
    {
      title: 'Log Set',
      description:
        'Append one completed set to an exercise on a given day. Pass the ' +
        'exercise by exercise_id from search_exercises. Creates the exercise ' +
        "entry for that day if it isn't there yet. Date defaults to today in " +
        "the server's timezone. For a timed exercise (plank, wall sit, dead " +
        'hang, carry) send duration_sec instead of reps; weight is optional ' +
        'and means a weighted hold. search_exercises reports set_type.',
      inputSchema: {
        exercise_id: z.number().int().positive(),
        reps: z.number().int().min(0).max(1000).optional(),
        weight: z.number().min(0).max(10000).optional(),
        duration_sec: z.number().int().min(1).max(86400).optional(),
        rpe: z.number().min(1).max(10).optional(),
        warmup: z.boolean().optional(),
        completed: z.boolean().optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ exercise_id, reps, weight, duration_sec, rpe, warmup, completed, date }) => {
      try {
        return toolResult(logSetCore(userId, { exercise_id, reps, weight, duration_sec, rpe, warmup, completed, date }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
