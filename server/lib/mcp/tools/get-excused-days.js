/**
 * MCP tool: get_excused_days (issue #121)
 *
 * Days the user marked as excused (couldn't train: an injury, an illness,
 * an appointment, or another reason) in an inclusive date range, oldest
 * first. An assistant reading a quiet week should see these before it calls
 * the week missed: an excused day comes off that week's goal.
 */
import { z } from 'zod';
import { listExcusedDays } from '../../excused-days.js';
import {
  DATE_RE,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

/**
 * Core query, shared by the MCP tool below and the public REST API at
 * GET /api/v1/excused-days. Throws a plain Error on bad input.
 */
export function getExcusedDaysCore(userId, { start, end } = {}) {
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
  const rangeError = validateDateRange(rangeStart, rangeEnd);
  if (rangeError) throw new Error(rangeError);
  const days = listExcusedDays(userId, { start: rangeStart, end: rangeEnd })
    .map(({ date, reason, note }) => ({ date, reason, note }));
  return { start: rangeStart, end: rangeEnd, excused_days: days, count: days.length };
}

export function registerGetExcusedDays(server, { userId }) {
  server.registerTool(
    'get_excused_days',
    {
      title: 'Get Excused Days',
      description:
        "Read the days the user couldn't train and marked as excused, with the " +
        'reason (injury, illness, appointment, other) and an optional note, in an ' +
        'inclusive YYYY-MM-DD range, oldest first. When both bounds are omitted ' +
        "the range is the last 90 days ending today in the server's timezone; a " +
        'supplied bound leaves the other side open (planned future days included). ' +
        "Each excused day comes off that week's workout goal, so a quiet week with " +
        'excused days is not a missed week. A day with a workout on it counts as ' +
        'trained even if it was excused.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ start, end }) => {
      try {
        return toolResult(getExcusedDaysCore(userId, { start, end }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
