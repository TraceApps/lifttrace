import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/cardio?start=YYYY-MM-DD&end=YYYY-MM-DD
//   Batch fetch of cardio sessions in a range. Statistics uses this for
//   the weekly-minutes chart; a bare GET (no range) returns everything
//   for the current user, which the Diary uses to render today's list.
router.get('/', wrap((req, res) => {
  const { start, end } = req.query;
  const userId = uid(req);
  let rows;
  if (start && end) {
    rows = userId != null
      ? db.prepare('SELECT * FROM cardio_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(userId, start, end)
      : db.prepare('SELECT * FROM cardio_log WHERE user_id IS NULL AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(start, end);
  } else {
    rows = userId != null
      ? db.prepare('SELECT * FROM cardio_log WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 500').all(userId)
      : db.prepare('SELECT * FROM cardio_log WHERE user_id IS NULL ORDER BY date DESC, id DESC LIMIT 500').all();
  }
  res.json(rows);
}));

// GET /api/cardio/:date — sessions logged on a single date.
router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM cardio_log WHERE date = ? AND user_id = ? ORDER BY id ASC').all(date, userId)
    : db.prepare('SELECT * FROM cardio_log WHERE date = ? AND user_id IS NULL ORDER BY id ASC').all(date);
  res.json(rows);
}));

// GET /api/cardio/templates — pinned templates (is_template=1), unique by
// activity name (most-recently-updated wins on collisions). Ordered by
// most-recently-updated so frequently-tweaked entries stay near the top.
// Sits above /:date in the route table because Express matches path
// segments left-to-right; without this ordering `/templates` would fall
// through to the /:date handler and 404.
router.get('/templates', wrap((req, res) => {
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM cardio_log WHERE user_id = ? AND is_template = 1 ORDER BY updated_at DESC, id DESC').all(userId)
    : db.prepare('SELECT * FROM cardio_log WHERE user_id IS NULL AND is_template = 1 ORDER BY updated_at DESC, id DESC').all();
  res.json(rows);
}));

// POST /api/cardio  { date, activity, duration_min, distance?, distance_unit?, avg_hr?, notes?, is_template? }
router.post('/', wrap((req, res) => {
  const userId = uid(req);
  const { date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required' });
  if (!activity || !String(activity).trim()) return res.status(400).json({ error: 'activity required' });
  const dm = Math.floor(Number(duration_min));
  if (!Number.isFinite(dm) || dm <= 0) return res.status(400).json({ error: 'duration_min must be a positive integer' });
  const dist = distance == null || distance === '' ? null : Number(distance);
  const hr = avg_hr == null || avg_hr === '' ? null : Math.floor(Number(avg_hr));
  const isTpl = is_template ? 1 : 0;
  const stmt = db.prepare(
    `INSERT INTO cardio_log (user_id, date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    userId, date, String(activity).trim(), dm,
    Number.isFinite(dist) ? dist : null,
    (distance_unit === 'mi' || distance_unit === 'km') ? distance_unit : 'km',
    Number.isFinite(hr) ? hr : null,
    notes ? String(notes).trim() : null,
    isTpl,
  );
  const row = db.prepare('SELECT * FROM cardio_log WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
}));

// PUT /api/cardio/:id  same body shape as POST (all fields optional).
router.put('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const userId = uid(req);
  const existing = userId != null
    ? db.prepare('SELECT * FROM cardio_log WHERE id = ? AND user_id = ?').get(id, userId)
    : db.prepare('SELECT * FROM cardio_log WHERE id = ? AND user_id IS NULL').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template } = req.body || {};
  const next = {
    date:         date != null ? date : existing.date,
    activity:     activity != null ? String(activity).trim() : existing.activity,
    duration_min: duration_min != null ? Math.floor(Number(duration_min)) : existing.duration_min,
    distance:     distance === '' ? null : (distance != null ? Number(distance) : existing.distance),
    distance_unit: (distance_unit === 'mi' || distance_unit === 'km') ? distance_unit : existing.distance_unit,
    avg_hr:       avg_hr === '' ? null : (avg_hr != null ? Math.floor(Number(avg_hr)) : existing.avg_hr),
    notes:        notes === '' ? null : (notes != null ? String(notes).trim() : existing.notes),
    is_template:  is_template === undefined ? existing.is_template : (is_template ? 1 : 0),
  };
  if (!next.activity) return res.status(400).json({ error: 'activity required' });
  if (!Number.isFinite(next.duration_min) || next.duration_min <= 0) {
    return res.status(400).json({ error: 'duration_min must be a positive integer' });
  }
  db.prepare(
    `UPDATE cardio_log SET
       date = ?, activity = ?, duration_min = ?, distance = ?, distance_unit = ?,
       avg_hr = ?, notes = ?, is_template = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next.date, next.activity, next.duration_min, next.distance, next.distance_unit, next.avg_hr, next.notes, next.is_template, id);
  const row = db.prepare('SELECT * FROM cardio_log WHERE id = ?').get(id);
  res.json(row);
}));

router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const userId = uid(req);
  const stmt = userId != null
    ? db.prepare('DELETE FROM cardio_log WHERE id = ? AND user_id = ?')
    : db.prepare('DELETE FROM cardio_log WHERE id = ? AND user_id IS NULL');
  const info = userId != null ? stmt.run(id, userId) : stmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

// GET /api/cardio/stats/weekly?start=YYYY-MM-DD&end=YYYY-MM-DD
//   Weekly minutes total, ISO-week bucketed (Monday start), for the
//   Statistics Cardio metric.
router.get('/stats/weekly', wrap((req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT date, duration_min FROM cardio_log WHERE user_id = ? AND date BETWEEN ? AND ?').all(userId, start, end)
    : db.prepare('SELECT date, duration_min FROM cardio_log WHERE user_id IS NULL AND date BETWEEN ? AND ?').all(start, end);
  const byWeek = {};
  for (const row of rows) {
    const d = new Date(row.date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
    byWeek[weekStart] = (byWeek[weekStart] || 0) + row.duration_min;
  }
  res.json(Object.entries(byWeek).map(([week, minutes]) => ({ week, minutes })).sort((a, b) => a.week.localeCompare(b.week)));
}));

export default router;
