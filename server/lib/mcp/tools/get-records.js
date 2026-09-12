/**
 * MCP tool: get_records
 *
 * Personal records per exercise. Same computation as
 * GET /api/stats/records — max weight lifted, the rep count at that
 * weight, the date it happened, and estimated 1-rep max (Epley-derived,
 * same formula the Statistics page uses). Optionally filtered to one
 * exercise by name (case-insensitive substring match).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult } from '../_util.js';

export function hasCompletedSet(exercises) {
  return exercises.some(ex => (ex.sets || []).some(s => s.completed));
}

/**
 * True if any exercise in the given (already-parsed) list has at least
 * one completed, non-warmup set with real weight on it. Cheap early-exit
 * guard used by the pr.set webhook detection (issue #79) before paying
 * for two getRecordsCore scans on a save that couldn't possibly move a
 * record (e.g. one that only edits notes or duration).
 */
export function hasQualifyingSet(exercises) {
  return exercises.some(ex => (ex.sets || []).some(s => s.completed && !s.warmup && s.weight > 0));
}

/**
 * Core computation, shared by the MCP tool below, the public REST API
 * (issue #77) at GET /api/v1/records, and the pr.set webhook detection
 * (issue #79) in workout.js, which snapshots this before and after a
 * save to see what improved. Keeping one implementation means all three
 * agree on what "a record" means, matching what the Statistics page
 * already shows.
 */
export function getRecordsCore(userId, { exercise_name } = {}) {
  const rows = db.prepare('SELECT * FROM workout_log WHERE user_id = ? ORDER BY date ASC').all(userId);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  const withSets = rows.filter(r => hasCompletedSet(r.exercises));

  const records = {}; // exerciseId -> { name, maxWeight, maxReps, date, e1rm }
  for (const row of withSets) {
    for (const ex of row.exercises) {
      const id = ex.exercise_id || ex.exercise_name;
      if (!records[id]) records[id] = { name: ex.exercise_name, maxWeight: 0, date: '', e1rm: 0 };
      for (const set of ex.sets || []) {
        if (set.completed && !set.warmup && set.weight > 0) {
          const e1rm = set.reps === 1 ? set.weight : Math.round(set.weight * (1 + set.reps / 30));
          if (set.weight > records[id].maxWeight) {
            records[id].maxWeight = set.weight;
            records[id].maxReps  = set.reps;
            records[id].date     = row.date;
          }
          if (e1rm > records[id].e1rm) records[id].e1rm = e1rm;
        }
      }
    }
  }

  let list = Object.entries(records).map(([id, r]) => ({ exercise_id: id, ...r }));
  if (exercise_name) {
    const needle = exercise_name.toLowerCase();
    list = list.filter(r => (r.name || '').toLowerCase().includes(needle));
  }
  return { records: list, count: list.length };
}

export function registerGetRecords(server, { userId }) {
  server.registerTool(
    'get_records',
    {
      title: 'Get Personal Records',
      description:
        'Personal records per exercise: max weight ever lifted, the rep ' +
        'count at that weight, the date, and estimated 1-rep max. Optionally ' +
        'filter to one exercise by name (case-insensitive substring match).',
      inputSchema: {
        exercise_name: z.string().max(200).optional(),
      },
    },
    async ({ exercise_name }) => toolResult(getRecordsCore(userId, { exercise_name }))
  );
}
