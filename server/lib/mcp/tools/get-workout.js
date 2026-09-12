/**
 * MCP tool: get_workout
 *
 * Read a single day's workout — every exercise and set. Mirrors
 * GET /api/workout/:date. Filters out soft-deleted rows the same way
 * that route does (deleted_at IS NULL, see LT v1.2.0 CHANGELOG).
 *
 * A date can have more than one session (issue #76); this tool doesn't
 * expose session selection yet (unchanged contract for phase 1), so it
 * returns the same default session GET /:date would — session 0, or the
 * lowest surviving session_seq/id.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

/**
 * Core lookup, shared by the MCP tool below and the public REST API
 * (issue #77) at GET /api/v1/workouts/:date. Throws a plain Error on bad
 * input so callers on either side can decide how to surface it: the MCP
 * wrapper maps it to toolError, the REST route maps it to a 400.
 */
export function getWorkoutCore(userId, { date } = {}) {
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const row = db.prepare(
    'SELECT * FROM workout_log WHERE date = ? AND user_id = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1'
  ).get(day, userId);
  if (!row) return { date: day, logged: false, exercises: [] };

  const exercises = JSON.parse(row.exercises || '[]');
  return {
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
  };
}

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
      try {
        return toolResult(getWorkoutCore(userId, { date }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
