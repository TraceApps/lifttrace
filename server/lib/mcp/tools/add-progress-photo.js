/**
 * MCP tool: add_progress_photo (write)
 *
 * Attach an already-hosted image URL to a body-stat date as a progress
 * photo. Deliberately takes a URL rather than raw bytes: neither MCP nor
 * the bearer-token REST layer handles multipart upload anywhere in this
 * app, so an agent or script points at an image it already hosts, the
 * same paste-a-URL affordance exercise media already supports. The app's
 * own UI uploads first (POST /api/upload/body-stats) and then calls this
 * with the URL that route returns.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';
import { dispatchWebhookEvent } from '../../webhooks.js';
import { isLocalPhotoUrl, PHOTO_DIR } from '../../body-stat-media.js';

/**
 * Core write, shared by the MCP tool below, the app route at
 * POST /api/body-stats/photos, and the public REST API at
 * POST /api/v1/body-stats/photos. Throws a plain Error on bad input.
 *
 * The progress_photo.logged webhook fires from HERE, not from any of the
 * routes above. Wiring it into a route would mean a photo attached
 * through MCP or the REST API silently fires nothing, which is exactly
 * the bug that shipped in the NutriTrace and CookTrace webhook ports
 * before review caught it. One dispatch, inside the shared function, so
 * every caller gets it.
 */
export function addProgressPhotoCore(userId, { date, url } = {}) {
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const clean = String(url || '').trim();
  if (!clean) throw new Error('url required');
  // Accept a local upload path or an absolute http(s) URL, nothing else:
  // a javascript:/data: value would end up in an <img src> on the
  // timeline, and a bare relative path outside /uploads has no meaning
  // to any client.
  //
  // A local path must be inside the progress-photo directory specifically,
  // not merely under /uploads. The file route streams whatever path the row
  // holds, so a row pointing at /uploads/backups/<timestamp>.zip or another
  // user's photo would read back through your own ownership check, since
  // the row really is yours. Narrow what a row may point at.
  const isLocal = isLocalPhotoUrl(clean);
  const isRemote = /^https?:\/\//i.test(clean);
  if (!isLocal && !isRemote) {
    if (clean.startsWith('/uploads/')) {
      throw new Error(`Local url must be under ${PHOTO_DIR} (upload via /api/upload/body-stats).`);
    }
    throw new Error(`url must be a ${PHOTO_DIR}... path or an http(s) URL`);
  }

  const r = db.prepare(
    `INSERT INTO body_stat_media (user_id, date, kind, url, created_at)
     VALUES (?, ?, 'photo', ?, datetime('now'))`
  ).run(userId, day, clean);

  const photo = db.prepare(
    'SELECT id, date, url, created_at FROM body_stat_media WHERE id = ?'
  ).get(r.lastInsertRowid);

  try {
    dispatchWebhookEvent(userId, 'progress_photo.logged', { date: day, url: clean });
  } catch (e) { /* never let a webhook failure block the save */ }

  return { ok: true, photo };
}

export function registerAddProgressPhoto(server, { userId }) {
  server.registerTool(
    'add_progress_photo',
    {
      title: 'Add Progress Photo',
      description:
        'Attach an image URL to a body-stat date as a progress photo. The ' +
        'URL must already be hosted (an http(s) link, or an /uploads/ path ' +
        "this server returned from its own upload route); this tool does not " +
        'accept raw image data. Date defaults to today in the server timezone.',
      inputSchema: {
        url:  z.string().min(1),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ url, date }) => {
      try {
        return toolResult(addProgressPhotoCore(userId, { url, date }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
