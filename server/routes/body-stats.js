import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/body-stats/range?start=YYYY-MM-DD&end=YYYY-MM-DD — batch fetch
// Returns every body_stats_log row in the window, already JSON-parsed.
// Used by Statistics to avoid N sequential requests per date.
router.get('/range', wrap((req, res) => {
  const { start, end } = req.query;
  const userId = uid(req);
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' });
  const rows = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC').all(userId, start, end)
    : db.prepare('SELECT * FROM body_stats_log WHERE user_id IS NULL AND date BETWEEN ? AND ? ORDER BY date ASC').all(start, end);
  for (const r of rows) r.stats = JSON.parse(r.stats || '{}');
  res.json(rows);
}));

router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const row = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  if (row) row.stats = JSON.parse(row.stats || '{}');
  res.json({ stats: row || null });
}));

router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { stats } = req.body;
  const statsJson = JSON.stringify(stats || {});

  const existing = userId != null
    ? db.prepare('SELECT id FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT id FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);

  if (existing) {
    db.prepare('UPDATE body_stats_log SET stats = ? WHERE id = ?').run(statsJson, existing.id);
  } else {
    db.prepare('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)').run(userId, date, statsJson);
  }

  const row = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  if (row) row.stats = JSON.parse(row.stats || '{}');
  res.json({ stats: row });
}));

export default router;
