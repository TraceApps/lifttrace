import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/templates/:id
router.get('/:id', wrap((req, res) => {
  // Join the parent program's duration_weeks so the editor knows how many
  // week tabs to render for the per-week progression matrix (issue #13)
  // without a second round-trip.
  const t = db.prepare(
    `SELECT wt.*, p.duration_weeks
       FROM workout_templates wt
       JOIN programs p ON p.id = wt.program_id
      WHERE wt.id = ?`
  ).get(parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Template not found' });
  t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// POST /api/templates
router.post('/', wrap((req, res) => {
  const { program_id, name, day_label, exercises } = req.body;
  if (!program_id || !name) return res.status(400).json({ error: 'program_id and name required' });
  const maxIdx = db.prepare('SELECT MAX(order_index) as m FROM workout_templates WHERE program_id = ?').get(program_id);
  const orderIndex = (maxIdx?.m ?? -1) + 1;
  const result = db.prepare(
    'INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises) VALUES (?, ?, ?, ?, ?)'
  ).run(program_id, name, day_label || null, orderIndex, JSON.stringify(exercises || []));
  const t = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(result.lastInsertRowid);
  t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// PUT /api/templates/:id
router.put('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { name, day_label, exercises } = req.body;
  db.prepare('UPDATE workout_templates SET name=COALESCE(?,name), day_label=COALESCE(?,day_label), exercises=COALESCE(?,exercises) WHERE id=?')
    .run(name || null, day_label, exercises ? JSON.stringify(exercises) : null, id);
  const t = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(id);
  if (t) t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// DELETE /api/templates/:id
router.delete('/:id', wrap((req, res) => {
  db.prepare('DELETE FROM workout_templates WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
}));

export default router;
