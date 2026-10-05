/**
 * MCP tool: get_cardio
 *
 * Every cardio session in an inclusive date range, oldest first, with an
 * optional activity filter. Lets a script check what's already logged
 * before it writes (issue #134). Reads aren't gated on the cardio opt-in;
 * the response's cardio_enabled says whether the app is showing them.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { isCardioEnabled, listCardio, publicCardioSession } from '../../cardio-log.js';
import {
  DATE_RE,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

/**
 * Core query, shared by the MCP tool below and the public REST API at
 * GET /api/v1/cardio. Throws a plain Error on bad input.
 */
export function getCardioCore(userId, { start, end, activity } = {}) {
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
  const rangeError = validateDateRange(rangeStart, rangeEnd);
  if (rangeError) throw new Error(rangeError);

  const sessions = listCardio(db, userId, { start: rangeStart, end: rangeEnd, activity })
    .map(publicCardioSession);
  return {
    start: rangeStart,
    end: rangeEnd,
    cardio_enabled: isCardioEnabled(db, userId),
    sessions,
    count: sessions.length,
  };
}

export function registerGetCardio(server, { userId }) {
  server.registerTool(
    'get_cardio',
    {
      title: 'Get Cardio',
      description:
        'Read cardio sessions (runs, rides, rows, walks, swims) in an inclusive ' +
        'YYYY-MM-DD range, oldest first. When both bounds are omitted the range is ' +
        "the last 90 days ending today in the server's timezone; a supplied bound " +
        'leaves the other side open. activity is an optional case-insensitive ' +
        'substring filter, e.g. "run". Each session carries its external_id when ' +
        'one was given at log time.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        activity: z.string().max(100).optional(),
      },
    },
    async ({ start, end, activity }) => {
      try {
        return toolResult(getCardioCore(userId, { start, end, activity }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
