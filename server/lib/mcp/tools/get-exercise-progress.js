/**
 * MCP tool: get_exercise_progress
 *
 * Per-session progress for one exercise over a date range: max weight,
 * total volume, set count, and average RPE (when logged). Same
 * computation as GET /api/stats/progress/:exerciseId. Resolves the
 * exercise by NAME (case-insensitive substring match against the
 * catalog) since an agent thinks in names, not internal ids; ambiguous
 * matches are returned as a disambiguation list instead of guessing.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { setVolume } from '../../volume.js';
import { DATE_RE, daysAgoLocal, todayLocal, toolResult, toolError } from '../_util.js';

export function registerGetExerciseProgress(server, { userId }) {
  server.registerTool(
    'get_exercise_progress',
    {
      title: 'Get Exercise Progress',
      description:
        'Per-session progress for one exercise over a date range: max weight, ' +
        'total volume, working-set count, and average RPE when logged. Pass ' +
        'the exercise by name (case-insensitive substring match). Range ' +
        "defaults to the last 90 days ending today in the server's timezone.",
      inputSchema: {
        exercise_name: z.string().min(1).max(200),
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end:   z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ exercise_name, start, end }) => {
      const rangeEnd = end || todayLocal();
      const rangeStart = start || daysAgoLocal(90);
      if (!DATE_RE.test(rangeStart) || !DATE_RE.test(rangeEnd)) {
        return toolError('Invalid start/end date; expected YYYY-MM-DD.');
      }

      const matches = db.prepare(
        `SELECT id, name, load_type FROM exercises WHERE deleted_at IS NULL AND name LIKE ? AND (is_global = 1 OR created_by = ?) ORDER BY name ASC LIMIT 10`
      ).all(`%${exercise_name}%`, userId);
      if (matches.length === 0) {
        return toolError(`No exercise matching '${exercise_name}' found in the catalog.`);
      }
      if (matches.length > 1) {
        return toolResult({
          ambiguous: true,
          message: `Multiple exercises match '${exercise_name}'; call again with an exact name.`,
          candidates: matches.map(m => m.name),
        });
      }
      const exercise = matches[0];

      const rows = db.prepare(
        'SELECT * FROM workout_log WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date ASC'
      ).all(userId, rangeStart, rangeEnd);

      const progress = [];
      for (const row of rows) {
        const exercises = JSON.parse(row.exercises || '[]');
        const ex = exercises.find(e => e.exercise_id === exercise.id);
        if (!ex) continue;
        const completedSets = (ex.sets || []).filter(s => s.completed && !s.warmup && s.weight > 0);
        if (!completedSets.length) continue;
        const maxWeight = Math.max(...completedSets.map(s => s.weight));
        const loadType = ex.load_type || exercise.load_type || 'bilateral';
        const totalVolume = completedSets.reduce((sum, s) => sum + setVolume(s, loadType), 0);
        const rpeValues = completedSets
          .map(s => parseFloat(s.rpe))
          .filter(n => Number.isFinite(n) && n > 0);
        const avgRpe = rpeValues.length
          ? Math.round((rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) * 10) / 10
          : null;
        progress.push({ date: row.date, maxWeight, totalVolume: Math.round(totalVolume), sets: completedSets.length, avgRpe });
      }
      return toolResult({ exercise_name: exercise.name, start: rangeStart, end: rangeEnd, progress });
    }
  );
}
