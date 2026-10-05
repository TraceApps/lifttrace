/**
 * MCP tool: log_cardio (write)
 *
 * Log one cardio session (a run, ride, row, walk or swim). Cardio lives in
 * cardio_log, separate from the set-based workout_log, so it never touches
 * volume totals or PRs. Same validation as the app's POST /api/cardio, via
 * server/lib/cardio-log.js (issue #134).
 *
 * Respects the cardio opt-in: when the user hasn't turned cardio on, the
 * write is refused rather than stored somewhere the app doesn't show it.
 *
 * external_id is optional. A script that sends its own id for a session can
 * re-send the same write safely: the session already logged under that id
 * comes back with created: false instead of a duplicate.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  CARDIO_OFF_MESSAGE,
  MAX_EXTERNAL_ID_LENGTH,
  insertCardio,
  isCardioEnabled,
  publicCardioSession,
} from '../../cardio-log.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

/**
 * Core mutation, shared by the MCP tool below and the public REST API at
 * POST /api/v1/cardio. Throws a plain Error on bad input.
 */
export function logCardioCore(userId, args = {}) {
  if (!isCardioEnabled(db, userId)) throw new Error(CARDIO_OFF_MESSAGE);
  const day = args.date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);
  // Presets are pinned from the Diary; a session logged through the API is
  // always an ordinary entry.
  const { created, session } = insertCardio(db, userId, { ...args, date: day, is_template: 0 });
  return { ok: true, created, session: publicCardioSession(session) };
}

export function registerLogCardio(server, { userId }) {
  server.registerTool(
    'log_cardio',
    {
      title: 'Log Cardio',
      description:
        'Log one cardio session: a run, ride, row, walk, swim or similar. Not for ' +
        'resistance training; use log_set for that. duration_min is whole minutes. ' +
        'distance is optional, in km by default (distance_unit: "mi" for miles). ' +
        'Pass external_id (your own id for the session, up to ' +
        `${MAX_EXTERNAL_ID_LENGTH} characters) to make the call safe to repeat: a ` +
        'session already logged with that id is returned with created: false. ' +
        "Date defaults to today in the server's timezone. Refused while the user " +
        'has cardio turned off in Settings.',
      inputSchema: {
        activity: z.string().min(1).max(100),
        duration_min: z.number().positive(),
        distance: z.number().nonnegative().optional(),
        distance_unit: z.enum(['km', 'mi']).optional(),
        avg_hr: z.number().int().positive().max(300).optional(),
        notes: z.string().max(2000).optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        external_id: z.string().min(1).max(MAX_EXTERNAL_ID_LENGTH).optional(),
      },
    },
    async (args) => {
      try {
        return toolResult(logCardioCore(userId, args));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
