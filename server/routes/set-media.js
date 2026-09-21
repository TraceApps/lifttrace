/**
 * Set videos (issue #57): attach a clip to one set, read it back, delete it.
 *
 * Two-step attach, matching progress photos: the client uploads to
 * /api/upload/set-video first and posts the URL that returns. Keeps the
 * upload route unaware of workouts and reusable.
 *
 * The bytes are never served from /uploads (see lib/set-media.js); they come
 * from GET /:id/file, which checks the row's owner and that owner's trainer.
 */
import express from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import {
  VIDEO_DIR,
  isLocalVideoUrl,
  listMediaForDate,
  listMediaForWorkout,
  resolveVideoFileForViewer,
  unlinkMediaFile,
  mediaUsageForUser,
  deleteMediaOlderThan,
} from '../lib/set-media.js';

const router = express.Router();
router.use(requireAuth);

const uid = (req) => req.user?.id ?? null;

/** The workout a clip is being attached to, if the caller owns it. */
function ownWorkout(userId, workoutId) {
  const id = parseInt(workoutId, 10);
  if (!Number.isFinite(id)) return null;
  return userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId)
    : db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').get(id);
}

// GET /api/set-media?date=YYYY-MM-DD, a day's clips, so the Diary can mark
// which sets have footage without fetching any video.
// GET /api/set-media?workout_id=N, one session's clips, with coach notes.
router.get('/', wrap((req, res) => {
  const userId = uid(req);
  if (req.query.workout_id) {
    const id = parseInt(req.query.workout_id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid workout_id' });
    return res.json({ media: listMediaForWorkout(userId, id) });
  }
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  res.json({ media: listMediaForDate(userId, date) });
}));

// GET /api/set-media/usage, what clips cost this user in disk, for Settings.
router.get('/usage', wrap((req, res) => {
  res.json(mediaUsageForUser(uid(req)));
}));

// POST /api/set-media  { workout_id, exercise_uuid, set_uuid?, url, mime?, duration_sec?, size_bytes? }
router.post('/', wrap((req, res) => {
  const userId = uid(req);
  const { workout_id, exercise_uuid, set_uuid, url, mime, duration_sec, size_bytes } = req.body || {};

  const workout = ownWorkout(userId, workout_id);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });
  // A row may only ever point inside the set-video directory: the file route
  // streams what the row holds, so anything else turns it into a confused
  // deputy (see the note in lib/set-media.js).
  if (!isLocalVideoUrl(url)) {
    return res.status(400).json({ error: `Clip URL must be an uploaded file under ${VIDEO_DIR}` });
  }
  if (!exercise_uuid) return res.status(400).json({ error: 'exercise_uuid required' });

  const info = db.prepare(
    `INSERT INTO set_media (user_id, workout_id, date, exercise_uuid, set_uuid, url, mime, duration_sec, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    userId, workout.id, workout.date, String(exercise_uuid), set_uuid ? String(set_uuid) : null,
    url, mime || null, Number(duration_sec) || null, Number(size_bytes) || null
  );
  const row = db.prepare('SELECT * FROM set_media WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    id: row.id, workout_id: row.workout_id, date: row.date,
    exercise_uuid: row.exercise_uuid, set_uuid: row.set_uuid,
    duration_sec: row.duration_sec, size_bytes: row.size_bytes,
    file_url: `/api/set-media/${row.id}/file`,
  });
}));

// GET /api/set-media/:id/file, the video itself, for the owner or their
// trainer. Range requests matter here in a way they never did for photos: a
// <video> element seeks by asking for byte ranges, and res.sendFile answers
// those (Accept-Ranges plus 206), so scrubbing works.
router.get('/:id/file', wrap((req, res) => {
  const found = resolveVideoFileForViewer(uid(req), req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  res.type(found.mime);
  res.sendFile(found.path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
}));

// DELETE /api/set-media/:id, soft-deletes the row so the removal reaches
// other devices, and unlinks the file so it is not left as an orphan.
router.delete('/:id', wrap((req, res) => {
  const userId = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = userId != null
    ? db.prepare('SELECT * FROM set_media WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId)
    : db.prepare('SELECT * FROM set_media WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE set_media SET deleted_at = datetime('now') WHERE id = ?").run(id);
  // A note that pointed at this clip keeps its words and loses the pointer,
  // rather than being deleted along with footage the coach did not own.
  db.prepare('UPDATE coach_feedback SET media_id = NULL, media_time_sec = NULL WHERE media_id = ?').run(id);
  unlinkMediaFile(row.url);
  res.json({ ok: true });
}));

// POST /api/set-media/cleanup  { before: 'YYYY-MM-DD' }
// The manual half of retention: nothing expires on its own, but clearing out
// everything older than a date is one action.
router.post('/cleanup', wrap((req, res) => {
  try {
    res.json(deleteMediaOlderThan(uid(req), req.body?.before));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
