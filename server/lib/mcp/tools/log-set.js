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

export function registerLogSet(server, { userId }) {
  server.registerTool(
    'log_set',
    {
      title: 'Log Set',
      description:
        'Append one completed set to an exercise on a given day. Pass the ' +
        'exercise by exercise_id from search_exercises. Creates the exercise ' +
        "entry for that day if it isn't there yet. Date defaults to today in " +
        "the server's timezone.",
      inputSchema: {
        exercise_id: z.number().int().positive(),
        reps: z.number().int().min(0).max(1000),
        weight: z.number().min(0).max(10000),
        rpe: z.number().min(1).max(10).optional(),
        warmup: z.boolean().optional(),
        completed: z.boolean().optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ exercise_id, reps, weight, rpe, warmup, completed, date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);

      const catalogEx = db.prepare(
        'SELECT id, name, load_type FROM exercises WHERE id = ? AND deleted_at IS NULL AND (is_global = 1 OR created_by = ?)'
      ).get(exercise_id, userId);
      if (!catalogEx) return toolError(`No exercise with id ${exercise_id} in the catalog. Use search_exercises to find a valid id.`);

      const newSet = {
        uuid: randomUUID(),
        reps,
        weight,
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
          next.push(target);
        }
        target.sets.push(newSet);
        loggedExercise = target;
        return next;
      });

      // Re-read the merged exercise back out (mutateWorkoutDay may have
      // reconciled concurrent server-side changes since the callback ran).
      const merged = result.exercises.find(ex => ex.exercise_id === exercise_id) || loggedExercise;
      return toolResult({
        ok: true,
        date: day,
        exercise_id,
        exercise_name: catalogEx.name,
        logged_set: newSet,
        sets_on_exercise: merged?.sets?.length ?? 1,
      });
    }
  );
}
