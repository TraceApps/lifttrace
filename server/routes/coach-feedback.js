/**
 * coach-feedback.js — Member-side routes for coach feedback.
 *
 * The trainer leaves notes via /api/trainer/feedback; this module lets
 * the member discover and acknowledge those notes. Three endpoints:
 *
 *   GET /api/coach-feedback/inbox — all feedback rows for the current user,
 *      newest first, joined with the workout date + trainer display name
 *      and exercise name (so the inbox can render without follow-up fetches).
 *
 *   POST /api/coach-feedback/seen — body { id } marks one row seen,
 *      empty body marks every unseen row seen at once.
 *
 *   GET /api/coach-feedback/unread-dates — minimal payload (just date
 *      strings) used by the diary's date strip to render an unread dot
 *      under any day that has fresh feedback.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { pushNotify } from '../lib/push-notify.js';

// Truncate a message to keep push-notification bodies readable on lock
// screens. Pro apps (Slack, iMessage) show the actual text with an
// ellipsis when it's long — strictly more useful than a generic "you
// got a message" since the recipient can triage at a glance.
function preview(text, max = 120) {
  if (!text) return '';
  const s = String(text).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const router = Router();
router.use(requireAuth);

router.get('/inbox', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const rows = db.prepare(`
    SELECT cf.id, cf.exercise_idx, cf.note, cf.updated_at, cf.seen_by_member_at,
           cf.member_reply, cf.member_replied_at,
           wl.date AS workout_date, wl.name AS workout_name, wl.exercises,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name
      FROM coach_feedback cf
      JOIN workout_log wl ON wl.id = cf.workout_id
      LEFT JOIN users u   ON u.id  = cf.trainer_id
     WHERE cf.member_id = ?
     ORDER BY cf.updated_at DESC
     LIMIT 100
  `).all(userId);

  for (const r of rows) {
    // Resolve the target exercise name when the note is per-exercise so
    // the inbox can render "Bench Press · 5/12" without the client doing
    // the JSON parse itself.
    if (r.exercise_idx != null) {
      try {
        const exs = JSON.parse(r.exercises || '[]');
        r.exercise_name = exs[r.exercise_idx]?.exercise_name || null;
      } catch { r.exercise_name = null; }
    } else {
      r.exercise_name = null;
    }
    delete r.exercises;
  }
  res.json(rows);
}));

router.post('/seen', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json({ ok: true });
  const { id } = req.body || {};
  if (id) {
    db.prepare(`UPDATE coach_feedback SET seen_by_member_at = datetime('now')
                 WHERE id = ? AND member_id = ? AND seen_by_member_at IS NULL`).run(id, userId);
  } else {
    db.prepare(`UPDATE coach_feedback SET seen_by_member_at = datetime('now')
                 WHERE member_id = ? AND seen_by_member_at IS NULL`).run(userId);
  }
  res.json({ ok: true });
}));

// PUT /api/coach-feedback/:id/reply — member's reply to a coach note.
// Empty/null reply clears the existing reply. Idempotent — multiple PUTs
// just overwrite. Notifies the trainer if the trainer has feedback-reply
// notifications enabled (default on).
router.put('/:id/reply', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const userId = uid(req);
  if (userId == null) return res.status(401).json({ error: 'Auth required' });
  const fb = db.prepare('SELECT id, member_id, trainer_id, workout_id FROM coach_feedback WHERE id = ?').get(id);
  if (!fb) return res.status(404).json({ error: 'Note not found' });
  if (fb.member_id !== userId) return res.status(403).json({ error: 'Not your note to reply to' });

  const reply = (req.body?.reply ?? '').toString().trim();
  if (!reply) {
    db.prepare(
      `UPDATE coach_feedback SET member_reply = NULL, member_replied_at = NULL WHERE id = ?`
    ).run(id);
    return res.json({ ok: true, deleted: true });
  }
  const wasEmpty = !db.prepare('SELECT member_reply FROM coach_feedback WHERE id = ?').get(id)?.member_reply;
  db.prepare(
    `UPDATE coach_feedback SET member_reply = ?, member_replied_at = datetime('now') WHERE id = ?`
  ).run(reply, id);

  // On first reply (not edits): record an activity row + push to the
  // trainer. INSERT into coach_activity so the trainer's /coaching feed
  // surfaces the reply alongside other events; coach taps to jump to
  // the workout. Idempotent via the wasEmpty guard.
  if (wasEmpty) {
    db.prepare(`
      INSERT INTO coach_activity
        (trainer_id, member_id, kind, feedback_id, workout_id)
      VALUES (?, ?, 'feedback_reply', ?, ?)
    `).run(fb.trainer_id, fb.member_id, fb.id, fb.workout_id);

    const optIn = (() => {
      const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(fb.trainer_id, 'notifMemberReply');
      if (!row) return true;
      try { return JSON.parse(row.value) !== false; } catch { return true; }
    })();
    if (optIn) {
      const memberName = db.prepare('SELECT COALESCE(nickname, full_name, username) AS n FROM users WHERE id = ?').get(userId)?.n || 'Your member';
      pushNotify(fb.trainer_id, `↩️ ${memberName} replied`, preview(reply), 4).catch(() => {});
    }
  }
  res.json({ ok: true });
}));

router.get('/unread-dates', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const rows = db.prepare(`
    SELECT DISTINCT wl.date
      FROM coach_feedback cf
      JOIN workout_log wl ON wl.id = cf.workout_id
     WHERE cf.member_id = ? AND cf.seen_by_member_at IS NULL
  `).all(userId);
  res.json(rows.map(r => r.date));
}));

export default router;
