/**
 * server/lib/set-media.js
 *
 * Set videos (issue #57): a short clip attached to one set, for reviewing
 * technique. Modelled on body-stat-media.js, which worked out what a table
 * that owns files on disk has to do in this app, and carries the same two
 * lessons:
 *
 *   1. A clip is not served from the static /uploads tree. That tree is
 *      mounted ahead of requireAuth so an Android WebView <img> can load it
 *      without a header, so anything in it is readable by anyone holding the
 *      URL. Fine for a shared exercise GIF, wrong for footage of someone in
 *      their gym. Clips are read through a route that checks the row's owner.
 *
 *   2. A row may only point inside this one directory. The file route streams
 *      whatever path a row holds, so accepting any /uploads/... path would
 *      make it a confused deputy: attach a row pointing at a backup archive
 *      or another user's clip, then read your own row's bytes, and the
 *      ownership check passes because you do own the row.
 *
 * Unlike a progress photo, a clip has a second legitimate reader: the
 * member's trainer, which is the entire point of the feature. That is the
 * only widening, and it is checked against users.trainer_id rather than
 * inferred from anything the caller sends.
 */
import db from '../db.js';
import { resolveUploadPath, unlinkMediaFile } from './upload-paths.js';

export { resolveUploadPath, unlinkMediaFile };

/** Local set-video URLs must sit in this one directory. */
export const VIDEO_DIR = '/uploads/set-videos/';

/** True for a local upload path that is actually a set video. */
export function isLocalVideoUrl(url) {
  return typeof url === 'string' && url.startsWith(VIDEO_DIR);
}

/**
 * Who may read a clip: its owner, or the trainer that owner is assigned to.
 * Admins get no special case, matching the progress-photo rule.
 */
export function canReadMedia(viewerId, row) {
  if (!row) return false;
  if (viewerId == null) return row.user_id == null;      // single-user mode
  if (row.user_id === viewerId) return true;
  const owner = db.prepare('SELECT trainer_id FROM users WHERE id = ?').get(row.user_id);
  return !!owner && owner.trainer_id === viewerId;
}

/**
 * Resolve a clip id to a file on disk for a given viewer, or an error to
 * surface. Mirrors resolvePhotoFileForUser, with the trainer case added.
 */
export function resolveVideoFileForViewer(viewerId, rawId) {
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id)) return { status: 400, error: 'Invalid id' };

  const row = db.prepare('SELECT * FROM set_media WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { status: 404, error: 'Not found' };
  if (!canReadMedia(viewerId, row)) return { status: 404, error: 'Not found' };
  if (!isLocalVideoUrl(row.url)) return { status: 409, error: 'Clip has no local file' };

  const abs = resolveUploadPath(row.url);
  if (!abs) return { status: 404, error: 'Not found' };
  return { path: abs, mime: row.mime || 'video/mp4', row };
}

/**
 * Clips with the coach note attached to each, if there is one. One query so
 * the player can show the note and its timestamp without a second round
 * trip, and so a clip opened from the diary carries the same note a clip
 * opened from the session view does.
 */
function _query(where, params) {
  return db.prepare(
    `SELECT m.*, f.id AS note_id, f.note, f.media_time_sec AS note_time_sec,
            f.member_reply, f.seen_by_member_at,
            COALESCE(t.nickname, t.full_name, t.username) AS note_author
       FROM set_media m
       LEFT JOIN coach_feedback f ON f.media_id = m.id
       LEFT JOIN users t ON t.id = f.trainer_id
      WHERE ${where} AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC`
  ).all(...params);
}

/** Every clip on one workout, for the session view and the coach. */
export function listMediaForWorkout(userId, workoutId) {
  return _query('m.workout_id = ?', [workoutId]).filter(r => canReadMedia(userId, r)).map(_shape);
}

/** Clips for one day, for the Diary to mark which sets have footage. */
export function listMediaForDate(userId, date) {
  const rows = userId != null
    ? _query('m.user_id = ? AND m.date = ?', [userId, date])
    : _query('m.user_id IS NULL AND m.date = ?', [date]);
  return rows.map(_shape);
}

function _shape(r) {
  return {
    id: r.id,
    workout_id: r.workout_id,
    date: r.date,
    exercise_uuid: r.exercise_uuid || null,
    set_uuid: r.set_uuid || null,
    duration_sec: r.duration_sec ?? null,
    size_bytes: r.size_bytes ?? null,
    mime: r.mime || null,
    created_at: r.created_at || null,
    // The bytes are fetched separately, with auth. Never a /uploads path.
    file_url: `/api/set-media/${r.id}/file`,
    ...(r.note ? {
      note: {
        id: r.note_id,
        body: r.note,
        author: r.note_author || null,
        time_sec: r.note_time_sec ?? null,
        member_reply: r.member_reply || null,
        seen_by_member_at: r.seen_by_member_at || null,
      },
    } : {}),
  };
}

/**
 * Remove every clip a user owns, rows and files both. Called from account
 * deletion and clear-my-data before their generic row deletion runs, for the
 * same reason progress photos need it: neither generic mechanism is
 * file-aware, so rows alone would leave the video files behind.
 */
export function deleteMediaForUser(userId) {
  const rows = userId == null
    ? db.prepare('SELECT url FROM set_media WHERE user_id IS NULL').all()
    : db.prepare('SELECT url FROM set_media WHERE user_id = ?').all(userId);
  for (const r of rows) unlinkMediaFile(r.url);
  if (userId == null) {
    db.prepare('DELETE FROM set_media WHERE user_id IS NULL').run();
  } else {
    db.prepare('DELETE FROM set_media WHERE user_id = ?').run(userId);
  }
  return rows.length;
}

/**
 * What a user's clips are costing them in disk, for Settings. Self-hosting
 * means nobody is billing for this, but it is still someone's NAS, so the
 * number is worth showing rather than letting it grow unseen.
 */
export function mediaUsageForUser(userId) {
  const row = userId == null
    ? db.prepare(
        `SELECT COUNT(*) AS clips, COALESCE(SUM(size_bytes), 0) AS bytes, MIN(date) AS oldest
           FROM set_media WHERE user_id IS NULL AND deleted_at IS NULL`
      ).get()
    : db.prepare(
        `SELECT COUNT(*) AS clips, COALESCE(SUM(size_bytes), 0) AS bytes, MIN(date) AS oldest
           FROM set_media WHERE user_id = ? AND deleted_at IS NULL`
      ).get(userId);
  return { clips: row?.clips || 0, bytes: row?.bytes || 0, oldest: row?.oldest || null };
}

/**
 * Delete a user's clips older than a cutoff date, rows and files. The manual
 * half of the retention story: nothing expires on its own, because deleting
 * someone's training footage on a schedule they did not choose is worse than
 * the disk it costs, but the clear-out is one action when they want it.
 */
export function deleteMediaOlderThan(userId, cutoffDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoffDate || ''))) {
    throw new Error('Invalid cutoff date; expected YYYY-MM-DD.');
  }
  const rows = userId == null
    ? db.prepare('SELECT id, url FROM set_media WHERE user_id IS NULL AND date < ? AND deleted_at IS NULL').all(cutoffDate)
    : db.prepare('SELECT id, url FROM set_media WHERE user_id = ? AND date < ? AND deleted_at IS NULL').all(userId, cutoffDate);
  for (const r of rows) {
    // Soft-delete so the removal reaches other devices, unlink so the file
    // does not linger as an orphan.
    db.prepare("UPDATE set_media SET deleted_at = datetime('now') WHERE id = ?").run(r.id);
    unlinkMediaFile(r.url);
  }
  return { deleted: rows.length };
}
