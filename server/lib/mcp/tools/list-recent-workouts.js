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
import { toolResult } from '../_util.js';

const MAX_LIMIT = 50;

export function registerListRecentWorkouts(server, { userId }) {
  server.registerTool(
    'list_recent_workouts',
    {
      title: 'List Recent Workouts',
      description:
        'List the most recent logged workouts (most recent first), each with ' +
        'its date, name, exercise count, and total volume. Use get_workout ' +
        'for the full per-set detail of one specific day.',
      inputSchema: {
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
      },
    },
    async ({ limit }) => {
      const n = Math.min(limit || 10, MAX_LIMIT);
      const rows = db.prepare(
        'SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT ?'
      ).all(userId, n);

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
      return toolResult({ workouts, count: workouts.length });
    }
  );
}
