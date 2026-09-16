/**
 * MCP tool: get_body_stats
 *
 * Read all body-stat measurements in an inclusive date range. The existing
 * get_body_stat tool remains the single-day/default-today compatibility API.
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

export function registerGetBodyStats(server, { userId }) {
  server.registerTool(
    'get_body_stats',
    {
      title: 'Get Body Stats',
      description:
        'Read body-stat measurements (weight, body fat, and tape measurements) ' +
        'for every logged date in an inclusive YYYY-MM-DD range. Start and end ' +
        "default to the last 90 days ending today in the server's timezone when " +
        'both are omitted; a supplied bound leaves the other side open. There is no maximum range.',
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
        `SELECT date, stats FROM body_stats_log
           WHERE user_id = ?${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}
           ORDER BY date ASC`
      ).all(...params);
      const stats = rows.map(row => ({
        date: row.date,
        logged: true,
        stats: JSON.parse(row.stats || '{}'),
      }));
      return toolResult({ start: rangeStart, end: rangeEnd, stats, count: stats.length });
    }
  );
}
