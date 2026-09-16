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
import { DATE_RE, toolError, toolResult, validateDateRange } from '../_util.js';
import { isTimedSet, newRecord, accumulateRecord } from '../../volume.js';

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
  // A timed set qualifies on duration alone: a bodyweight plank has no
  // weight, and without this a plank-only save could never raise pr.set.
  return exercises.some(ex => (ex.sets || []).some(s =>
    s.completed && !s.warmup && (s.weight > 0 || (isTimedSet(ex, s) && Number(s.duration_sec) > 0))));
}

/**
 * Core computation, shared by the MCP tool below, the public REST API
 * (issue #77) at GET /api/v1/records, and the pr.set webhook detection
 * (issue #79) in workout.js, which snapshots this before and after a
 * save to see what improved. Keeping one implementation means all three
 * agree on what "a record" means, matching what the Statistics page
 * already shows.
 */
export function getRecordsCore(userId, { exercise_name, start, end } = {}) {
  const rangeError = validateDateRange(start, end);
  if (rangeError) throw new Error(rangeError);
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (start != null) {
    conditions.push('date >= ?');
    params.push(start);
  }
  if (end != null) {
    conditions.push('date <= ?');
    params.push(end);
  }
  const rows = db.prepare(`SELECT * FROM workout_log WHERE ${conditions.join(' AND ')} ORDER BY date ASC`).all(...params);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  const withSets = rows.filter(r => hasCompletedSet(r.exercises));

  const records = {}; // exerciseId -> newRecord() shape, see lib/volume.js
  for (const row of withSets) {
    for (const ex of row.exercises) {
      const id = ex.exercise_id || ex.exercise_name;
      if (!records[id]) records[id] = newRecord(ex.exercise_name);
      for (const set of ex.sets || []) accumulateRecord(records[id], ex, set, row.date);
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
        'count at that weight, the date, and estimated 1-rep max. For timed ' +
        'exercises (planks, holds, carries) maxDuration is the longest hold in ' +
        'seconds and maxDurationWeight the load it was held at. Optionally ' +
        'filter to one exercise by name (case-insensitive substring match). ' +
        'Optional inclusive start/end YYYY-MM-DD bounds limit the source history.',
      inputSchema: {
        exercise_name: z.string().max(200).optional(),
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ exercise_name, start, end }) => {
      try {
        return toolResult(getRecordsCore(userId, { exercise_name, start, end }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
