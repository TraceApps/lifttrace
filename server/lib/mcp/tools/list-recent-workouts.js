/**
 * MCP tool: list_recent_workouts
 *
 * Summaries of the most recent logged workouts. Mirrors
 * GET /api/workout/recent — same table, same deleted_at filter,
 * condensed to what an agent needs for a quick overview rather than
 * the full exercises/sets payload get_workout returns.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { exerciseVolume } from '../../volume.js';
import { DATE_RE, toolResult, toolError, validateDateRange } from '../_util.js';

const MAX_LIMIT = 50;

/**
 * Core lookup, shared by the MCP tool below and the public REST API
 * (issue #77) at GET /api/v1/workouts/recent. `limit` is clamped here (not left
 * to zod's schema validation, which only runs on the MCP path) so both
 * callers get identical behavior for an out-of-range value.
 */
export function listRecentWorkoutsCore(userId, { limit, start, end } = {}) {
  const n = Math.min(Math.max(1, limit || 10), MAX_LIMIT);
  const rangeError = validateDateRange(start, end);
  if (rangeError) throw new Error(rangeError);
  const conditions = ['user_id = ?', 'deleted_at IS NULL'];
  const params = [userId];
  if (start != null) {
    conditions.push('date >= ?');
    params.push(start);
  }
  if (end != null) {
    conditions.push('date <= ?');
    params.push(end);
  }
  const rows = db.prepare(
    `SELECT * FROM workout_log WHERE ${conditions.join(' AND ')} ORDER BY date DESC LIMIT ?`
  ).all(...params, n);

  const workouts = rows.map(r => {
    const exercises = JSON.parse(r.exercises || '[]');
    const totalVolume = exercises.reduce((sum, ex) => sum + exerciseVolume(ex), 0);
    return {
      date: r.date,
      name: r.name || null,
      completed: !!r.completed,
      exercise_count: exercises.length,
      total_volume: Math.round(totalVolume),
    };
  });
  return { workouts, count: workouts.length };
}

export function registerListRecentWorkouts(server, { userId }) {
  server.registerTool(
    'list_recent_workouts',
    {
      title: 'List Recent Workouts',
      description:
        'List the most recent logged workouts (most recent first), each with ' +
        'its date, name, exercise count, and total volume. Use get_workout ' +
        'for the full per-set detail of one specific day. Optional inclusive ' +
        'start/end YYYY-MM-DD bounds filter the history; omitted bounds are open.',
      inputSchema: {
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ limit, start, end }) => {
      try {
        return toolResult(listRecentWorkoutsCore(userId, { limit, start, end }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
