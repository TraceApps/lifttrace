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
