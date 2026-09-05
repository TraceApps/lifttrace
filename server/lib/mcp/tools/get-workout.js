/**
 * MCP tool: get_workout
 *
 * Read a single day's workout — every exercise and set. Mirrors
 * GET /api/workout/:date. Filters out soft-deleted rows the same way
 * that route does (deleted_at IS NULL, see LT v1.2.0 CHANGELOG).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

export function registerGetWorkout(server, { userId }) {
  server.registerTool(
    'get_workout',
    {
      title: 'Get Workout',
      description:
        "Read a day's workout — every exercise and its sets (reps, weight, " +
        "completed, warmup, RPE). Date defaults to today in the server's " +
        'timezone; pass an explicit YYYY-MM-DD for calendar accuracy from a ' +
        'different TZ.',
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);

      const row = db.prepare(
        'SELECT * FROM workout_log WHERE date = ? AND user_id = ? AND deleted_at IS NULL'
      ).get(day, userId);
      if (!row) return toolResult({ date: day, logged: false, exercises: [] });

      const exercises = JSON.parse(row.exercises || '[]');
      return toolResult({
        date: day,
        logged: true,
        name: row.name || null,
        completed: !!row.completed,
        duration_min: row.duration_min ?? null,
        exercises: exercises.map(ex => ({
          exercise_id: ex.exercise_id,
          exercise_name: ex.exercise_name,
          superset_id: ex.superset_id ?? null,
          sets: (ex.sets || []).map(s => ({
            reps: s.reps ?? null,
            weight: s.weight ?? null,
            completed: !!s.completed,
            warmup: !!s.warmup,
            rpe: s.rpe ?? null,
          })),
        })),
      });
    }
  );
}
