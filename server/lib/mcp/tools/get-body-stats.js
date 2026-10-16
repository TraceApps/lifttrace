/**
 * MCP tool: get_body_stats
 *
 * Every logged body-stat measurement in an inclusive date range. The
 * existing get_body_stat stays the single-day, default-today tool.
 *
 * Unlike get_workouts this needs no limit: a body-stat row is one small
 * object per date, so even years of daily weigh-ins stay small.
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

/**
 * Core query, shared by the MCP tool below and the public REST API at
 * GET /api/v1/body-stats. Throws a plain Error on bad input.
 */
export function getBodyStatsCore(userId, { start, end } = {}) {
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
  const rangeError = validateDateRange(rangeStart, rangeEnd);
  if (rangeError) throw new Error(rangeError);

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
  const rows = db.prepare(
    `SELECT date, stats FROM body_stats_log WHERE ${conditions.join(' AND ')} ORDER BY date ASC`
  ).all(...params);

  const stats = rows.map(row => ({
    date: row.date,
    logged: true,
    stats: JSON.parse(row.stats || '{}'),
  }));
  return { start: rangeStart, end: rangeEnd, stats, count: stats.length };
}

export function registerGetBodyStats(server, { userId }) {
  server.registerTool(
    'get_body_stats',
    {
      title: 'Get Body Stats',
      description:
        'Read body-stat measurements (weight, body fat, and tape measurements) ' +
        'for every logged date in an inclusive YYYY-MM-DD range. When both bounds ' +
        "are omitted the range is the last 90 days ending today in the server's " +
        'timezone; a supplied bound leaves the other side open. Dates with nothing ' +
        'logged are simply absent.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ start, end }) => {
      try {
        return toolResult(getBodyStatsCore(userId, { start, end }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
