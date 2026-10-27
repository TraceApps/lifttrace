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
  MAX_ACTIVITY_LENGTH,
  MAX_AVG_HR,
  MAX_DISTANCE,
  MAX_DURATION_MIN,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_NOTES_LENGTH,
  checkApiCardioInput,
  insertCardio,
  isCardioEnabled,
  publicCardioSession,
} from '../../cardio-log.js';
import { DATE_RE, todayLocal, toolResult, toolError, validateDateRange } from '../_util.js';
import { dispatchWebhookEvent } from '../../webhooks.js';

/**
 * Store one session and send the cardio.logged webhook for it. Every way a
 * session reaches the server comes through here: the app's POST
 * /api/cardio (the Diary, Trace, the Android app's queued saves), this MCP
 * tool and POST /api/v1/cardio. A repeated external_id returns the session
 * already logged and sends nothing.
 */
export function saveCardioSession(userId, input) {
  const result = insertCardio(db, userId, input);
  if (result.created) {
    try { dispatchWebhookEvent(userId, 'cardio.logged', publicCardioSession(result.session)); }
    catch { /* never let a webhook failure block the save */ }
  }
  return result;
}

/**
 * Core mutation, shared by the MCP tool below and the public REST API at
 * POST /api/v1/cardio. Throws a plain Error on bad input.
 */
export function logCardioCore(userId, args = {}) {
  if (!isCardioEnabled(db, userId)) throw new Error(CARDIO_OFF_MESSAGE);
  const day = args.date || todayLocal();
  if (typeof day !== 'string' || validateDateRange(day, null)) {
    throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);
  }
  checkApiCardioInput(args);
  // Presets are pinned from the Diary; a session logged through the API is
  // always an ordinary entry.
  const { created, session } = saveCardioSession(userId, { ...args, date: day, is_template: 0 });
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
        activity: z.string().min(1).max(MAX_ACTIVITY_LENGTH),
        duration_min: z.number().min(1).max(MAX_DURATION_MIN),
        distance: z.number().nonnegative().max(MAX_DISTANCE).optional(),
        distance_unit: z.enum(['km', 'mi']).optional(),
        avg_hr: z.number().min(1).max(MAX_AVG_HR).optional(),
        notes: z.string().max(MAX_NOTES_LENGTH).optional(),
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
