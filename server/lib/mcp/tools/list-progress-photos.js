/**
 * MCP tool: list_progress_photos
 *
 * Progress photos logged against body-stat dates, newest first. Reads
 * the same rows the app's own timeline at /progress shows.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, daysAgoLocal, todayLocal, toolResult, toolError } from '../_util.js';

const DEFAULT_DAYS = 365;

/**
 * Core lookup, shared by the MCP tool below, the app route at
 * GET /api/body-stats/photos, and the public REST API at
 * GET /api/v1/body-stats/photos. Throws a plain Error on bad input so
 * each caller can decide how to surface it: the MCP wrapper maps it to
 * toolError, the routes map it to a 400.
 *
 * Range defaults to the last year, matching how the Statistics range
 * controls think about body-stat history rather than returning a user's
 * entire archive on an unbounded call.
 */
export function listProgressPhotosCore(userId, { start, end } = {}) {
  const from = start || daysAgoLocal(DEFAULT_DAYS);
  const to = end || todayLocal();
  if (!DATE_RE.test(from)) throw new Error(`Invalid start '${from}'; expected YYYY-MM-DD.`);
  if (!DATE_RE.test(to)) throw new Error(`Invalid end '${to}'; expected YYYY-MM-DD.`);

  const rows = userId == null
    ? db.prepare(
        `SELECT id, date, url, created_at FROM body_stat_media
          WHERE user_id IS NULL AND kind = 'photo' AND deleted_at IS NULL
            AND date BETWEEN ? AND ?
          ORDER BY date DESC, created_at DESC, id DESC`
      ).all(from, to)
    : db.prepare(
        `SELECT id, date, url, created_at FROM body_stat_media
          WHERE user_id = ? AND kind = 'photo' AND deleted_at IS NULL
            AND date BETWEEN ? AND ?
          ORDER BY date DESC, created_at DESC, id DESC`
      ).all(userId, from, to);

  return { start: from, end: to, count: rows.length, photos: rows };
}

export function registerListProgressPhotos(server, { userId }) {
  server.registerTool(
    'list_progress_photos',
    {
      title: 'List Progress Photos',
      description:
        'List the progress photos logged against body-stat dates, newest ' +
        'first, each with its date and URL. Range defaults to the last ' +
        'year; pass explicit YYYY-MM-DD start/end to widen or narrow it.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end:   z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ start, end }) => {
      try {
        return toolResult(listProgressPhotosCore(userId, { start, end }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
