import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { coachesClient, notifyPrescriptionAnswer } from '../lib/coaching.js';

const router = Router();
router.use(requireAuth);

function parse(row) {
  if (!row) return null;
  return { ...row, exercises: row.exercises ? JSON.parse(row.exercises) : null };
}

// GET /api/prescriptions/my/:date — what did my coach prescribe for this date?
// Returns the most recent prescription targeted at that exact date (or null).
router.get('/my/:date', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json(null);
  const row = db.prepare(
    `SELECT cp.*, wt.name as template_name, wt.exercises as template_exercises,
            p.id as program_id, p.name as program_name,
            COALESCE(u.nickname, u.full_name, u.username) as trainer_name
     FROM coach_prescriptions cp
     LEFT JOIN workout_templates wt ON wt.id = cp.template_id
     LEFT JOIN programs p ON p.id = wt.program_id
     LEFT JOIN users u ON u.id = cp.trainer_id
     WHERE cp.member_id = ? AND cp.date = ? AND cp.status != 'declined'
     ORDER BY cp.created_at DESC, cp.id DESC LIMIT 1`
  ).get(userId, req.params.date);
  res.json(parse(row));
}));

// GET /api/prescriptions/my/upcoming — my upcoming + undated prescriptions
router.get('/my/upcoming/list', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const rows = db.prepare(
    `SELECT cp.*, wt.name as template_name, p.name as program_name,
            COALESCE(u.nickname, u.full_name, u.username) as trainer_name
     FROM coach_prescriptions cp
     LEFT JOIN workout_templates wt ON wt.id = cp.template_id
     LEFT JOIN programs p ON p.id = wt.program_id
     LEFT JOIN users u ON u.id = cp.trainer_id
     WHERE cp.member_id = ? AND cp.status != 'declined'
       -- From yesterday (UTC): the server can't know the client's day, and
       -- today's prescription must not drop out in a time zone behind UTC.
       -- The same window the waiting count (the dot) uses.
       AND (cp.date IS NULL OR cp.date >= date('now', '-1 day'))
     ORDER BY cp.date IS NULL, cp.date ASC`
  ).all(userId);
  res.json(rows.map(parse));
}));

// POST /api/prescriptions/:id/answer { answer: 'accept' | 'decline' }: the
// client's answer to a prescription from their coach (then Load, as
// before). The same answer again is fine (a retry after a lost reply);
// only while that coach still coaches them.
router.post('/:id/answer', wrap((req, res) => {
  const userId = uid(req);
  const id = parseInt(req.params.id);
  const want = req.body?.answer === 'accept' ? 'accepted' : req.body?.answer === 'decline' ? 'declined' : null;
  if (!want) return res.status(400).json({ error: 'Answer accept or decline.' });
  const row = Number.isFinite(id) ? db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(id) : null;
  if (!row || userId == null || row.member_id !== userId || !coachesClient(row.trainer_id, userId)) {
    return res.status(404).json({ error: 'Prescription not found' });
  }
  if (row.status === want) return res.json(parse(row));
  if (row.status !== 'pending') return res.status(409).json({ error: 'This prescription was already answered.', prescription: parse(row) });
  db.prepare(`UPDATE coach_prescriptions SET status = ?, responded_at = datetime('now') WHERE id = ? AND status = 'pending'`).run(want, id);
  notifyPrescriptionAnswer(row, want);
  res.json(parse(db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(id)));
}));

export default router;
