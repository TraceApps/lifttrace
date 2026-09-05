/**
 * MCP tool: get_body_stat
 *
 * Read body-stat measurements for a date. Same table + shape as
 * GET /api/body-stats/:date (row.stats holds the actual measurements —
 * see issue #80 for why that nesting matters).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

export function registerGetBodyStat(server, { userId }) {
  server.registerTool(
    'get_body_stat',
    {
      title: 'Get Body Stat',
      description:
        'Read body-stat measurements (weight, body fat, and tape measurements) ' +
        "for a date. Date defaults to today in the server's timezone.",
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      const row = db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(day, userId);
      if (!row) return toolResult({ date: day, logged: false, stats: {} });
      return toolResult({ date: day, logged: true, stats: JSON.parse(row.stats || '{}') });
    }
  );
}
