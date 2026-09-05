/**
 * MCP tool: search_exercises
 *
 * Search the exercise catalog by name. Simplified subset of
 * GET /api/exercises: same deleted_at / is_global / created_by
 * filtering, but skips the disabled-catalog-source exclusion the
 * picker UI applies — a niche display preference, not a correctness
 * concern for an agent trying to find an exercise_id to log against.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult } from '../_util.js';

const MAX_LIMIT = 25;

export function registerSearchExercises(server, { userId }) {
  server.registerTool(
    'search_exercises',
    {
      title: 'Search Exercises',
      description:
        'Search the exercise catalog by name (case-insensitive substring ' +
        'match). Returns exercise_id, name, category, equipment, and ' +
        'load_type for each match — exercise_id is what log_set expects.',
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
      },
    },
    async ({ query, limit }) => {
      const n = Math.min(limit || 10, MAX_LIMIT);
      const rows = db.prepare(
        `SELECT id, name, category, equipment, load_type FROM exercises
          WHERE deleted_at IS NULL AND name LIKE ? AND (is_global = 1 OR created_by = ?)
          ORDER BY name ASC LIMIT ?`
      ).all(`%${query}%`, userId, n);
      const exercises = rows.map(r => ({
        exercise_id: r.id,
        name: r.name,
        category: r.category || null,
        equipment: r.equipment ? JSON.parse(r.equipment) : [],
        load_type: r.load_type || null,
      }));
      return toolResult({ exercises, count: exercises.length });
    }
  );
}
