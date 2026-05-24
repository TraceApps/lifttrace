import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';

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
     WHERE cp.member_id = ? AND cp.date = ?
     ORDER BY cp.created_at DESC LIMIT 1`
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
     WHERE cp.member_id = ?
       AND (cp.date IS NULL OR cp.date >= date('now'))
     ORDER BY cp.date IS NULL, cp.date ASC`
  ).all(userId);
  res.json(rows.map(parse));
}));

export default router;
