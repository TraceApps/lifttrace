/**
 * MCP tool: get_workouts
 *
 * Every live session in an inclusive date range, with full exercise and set
 * detail. The range counterpart to get_workout, which keeps its existing
 * single-day, default-session contract.
 *
 * Full detail is expensive to read: a year of training is thousands of sets,
 * and an assistant asked for "my whole history" would spend its context on
 * it. So this answers the most recent sessions in the range and says when it
 * stopped short, rather than returning everything and hoping for the best.
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
import { formatWorkoutRow } from './get-workout.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Core query, shared by the MCP tool below and the public REST API at
 * GET /api/v1/workouts. Throws a plain Error on bad input so each caller
 * can surface it its own way: toolError here, a 400 there.
 */
export function getWorkoutsCore(userId, { start, end, limit } = {}) {
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
  const rangeError = validateDateRange(rangeStart, rangeEnd);
  if (rangeError) throw new Error(rangeError);

  const n = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (rangeStart != null) {
    conditions.push('date >= ?');
    params.push(rangeStart);
  }
  if (rangeEnd != null) {
    conditions.push('date <= ?');
    params.push(rangeEnd);
  }
  const where = conditions.join(' AND ');

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM workout_log WHERE deleted_at IS NULL AND ${where}`
  ).get(...params)?.c || 0;
  // Newest first for the cut, so a range wider than the limit keeps the
  // sessions a caller is most likely to be asking about, then back into
  // date order for the answer.
  const rows = db.prepare(
    `SELECT * FROM workout_log WHERE deleted_at IS NULL AND ${where}
       ORDER BY date DESC, session_seq DESC, id DESC LIMIT ?`
  ).all(...params, n).reverse();

  const workouts = rows.map(row => ({ ...formatWorkoutRow(row), session_seq: row.session_seq ?? 0 }));
  return {
    start: rangeStart,
    end: rangeEnd,
    workouts,
    count: workouts.length,
    total,
    truncated: total > workouts.length,
  };
}

export function registerGetWorkouts(server, { userId }) {
  server.registerTool(
    'get_workouts',
    {
      title: 'Get Workouts',
      description:
        'Read every live workout session in an inclusive date range, with full ' +
        'exercise and set detail (reps, weight, completed, warmup, RPE, and ' +
        'duration_sec for timed sets like planks) plus session_seq for days with ' +
        'more than one session. Start and end are YYYY-MM-DD; when both are ' +
        "omitted the range is the last 90 days ending today in the server's " +
        'timezone, and a supplied bound leaves the other side open. Returns the ' +
        `most recent ${DEFAULT_LIMIT} sessions in the range by default (max ` +
        `${MAX_LIMIT}); when more exist, truncated is true and total says how ` +
        'many matched, so narrow the range or raise limit rather than assuming ' +
        'the list is complete.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
      },
    },
    async ({ start, end, limit }) => {
      try {
        return toolResult(getWorkoutsCore(userId, { start, end, limit }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
