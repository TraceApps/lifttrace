/**
 * MCP tool: get_workouts
 *
 * Read every live workout session in an inclusive date range. This is the
 * range counterpart to get_workout, which intentionally keeps its existing
 * single-day/default-session contract.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  DATE_RE,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

function asWorkout(row) {
  const exercises = JSON.parse(row.exercises || '[]');
  return {
    date: row.date,
    session_seq: row.session_seq ?? 0,
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
        duration_sec: s.duration_sec ?? null,
      })),
    })),
  };
}

export function registerGetWorkouts(server, { userId }) {
  server.registerTool(
    'get_workouts',
    {
      title: 'Get Workouts',
      description:
        'Read every live workout session in an inclusive date range. Returns ' +
        'full exercise/set detail and session_seq; start and end are YYYY-MM-DD. ' +
        "When both are omitted, the range defaults to the last 90 days ending today " +
        "in the server's timezone; a supplied bound leaves the other side open. " +
        'There is no maximum range.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ start, end }) => {
      const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
      const rangeError = validateDateRange(rangeStart, rangeEnd);
      if (rangeError) return toolError(rangeError);

      const conditions = [];
      const params = [userId];
      if (rangeStart != null) {
        conditions.push('date >= ?');
        params.push(rangeStart);
      }
      if (rangeEnd != null) {
        conditions.push('date <= ?');
        params.push(rangeEnd);
      }
      const rows = db.prepare(
        `SELECT * FROM workout_log
           WHERE user_id = ? AND ${conditions.length ? `${conditions.join(' AND ')} AND ` : ''}deleted_at IS NULL
           ORDER BY date ASC, session_seq ASC, id ASC`
      ).all(...params);
      const workouts = rows.map(asWorkout);
      return toolResult({ start: rangeStart, end: rangeEnd, workouts, count: workouts.length });
    }
  );
}
