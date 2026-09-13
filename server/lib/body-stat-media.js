/**
 * server/lib/body-stat-media.js
 *
 * File-aware cleanup for progress photos. Every other per-user table in
 * this app is cleared by a plain `DELETE ... WHERE user_id = ?`, either
 * hardcoded in routes/auth.js or via NO_CASCADE_TABLES in
 * claim-anonymous-data.js. Neither knows about files on disk, so reusing
 * one of them alone would delete the rows and leave the JPEGs behind,
 * which is exactly the orphan-upload debt ROADMAP.md already flags for
 * custom-exercise media. This table owns files, so it gets a helper that
 * removes both.
 *
 * The path resolution and unlink live in lib/upload-paths.js, which has
 * no db.js import, so the traversal guard is unit-testable without the
 * native binding. Re-exported here so callers have one obvious import.
 *
 * Not a general fix for the pre-existing avatar / exercise-media orphan
 * gap, deliberately scoped to the rows this feature creates.
 */
import db from '../db.js';
import { resolveUploadPath, unlinkMediaFile } from './upload-paths.js';

export { resolveUploadPath, unlinkMediaFile };

/**
 * Remove every progress-photo row for a user AND its file on disk.
 * Called from the account-deletion and clear-my-data paths before their
 * generic row deletion runs, so the generic one is then a no-op.
 */
export function deleteMediaForUser(userId) {
  const rows = userId == null
    ? db.prepare('SELECT url FROM body_stat_media WHERE user_id IS NULL').all()
    : db.prepare('SELECT url FROM body_stat_media WHERE user_id = ?').all(userId);
  for (const r of rows) unlinkMediaFile(r.url);
  if (userId == null) {
    db.prepare('DELETE FROM body_stat_media WHERE user_id IS NULL').run();
  } else {
    db.prepare('DELETE FROM body_stat_media WHERE user_id = ?').run(userId);
  }
  return rows.length;
}

/**
 * Local progress-photo URLs must sit in this one directory.
 *
 * The file route streams whatever path a row holds, and a row's url comes
 * from the caller (POST /api/body-stats/photos, add_progress_photo over
 * MCP, or the REST write route). Accepting any /uploads/... path made the
 * route a confused deputy: attach a row pointing at
 * /uploads/backups/<timestamp>.zip or another user's photo, then GET your
 * own row's bytes and the ownership check passes, because you do own the
 * row. Constrain what a row may point at instead.
 */
export const PHOTO_DIR = '/uploads/body-stats/';

/** True for a local upload path that is actually a progress photo. */
export function isLocalPhotoUrl(url) {
  return typeof url === 'string' && url.startsWith(PHOTO_DIR);
}

/**
 * Resolve one photo's bytes for a given user, or explain why not.
 *
 * Shared by the session route and the /api/v1 route, so the ownership rule
 * and the two refusals below have exactly one implementation. The same
 * reason every other domain here is built around an xCore function: two
 * copies of an access check drift, and the copy that drifts is the one
 * nobody is looking at.
 *
 * Returns { path } on success, or { status, error }.
 */
export function resolvePhotoFileForUser(userId, rawId) {
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id)) return { status: 400, error: 'Invalid id' };

  // In single-user mode rows carry a NULL user_id and uid() returns null,
  // so the IS NULL branch matches. Admins get no special case on purpose.
  const row = userId != null
    ? db.prepare('SELECT * FROM body_stat_media WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId)
    : db.prepare('SELECT * FROM body_stat_media WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').get(id);
  if (!row) return { status: 404, error: 'Not found' };

  // Two reasons there may be nothing to stream:
  //
  // 1. The row points at an externally hosted image. MCP and the REST API
  //    both accept an http(s) URL, since neither can take raw bytes.
  //    Proxying an arbitrary remote URL from here would be an SSRF hole.
  // 2. The row points somewhere under /uploads that is not the progress
  //    photo directory. addProgressPhotoCore refuses to write such a row,
  //    but this must not depend on that: a url is caller supplied, so
  //    without the check, attaching a row that points at
  //    /uploads/backups/<timestamp>.zip and then reading your own row
  //    would stream it back, ownership check and all, because the row
  //    genuinely is yours.
  if (!isLocalPhotoUrl(row.url)) return { status: 409, error: 'Photo is not stored locally' };
  const abs = resolveUploadPath(row.url);
  if (!abs) return { status: 409, error: 'Photo is not stored locally' };
  return { path: abs };
}
