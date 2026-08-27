import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { mergeStatsObject } from '../lib/workout-merge.js';

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

// PUT /api/body-stats/:date — save/update
//
// Per-key merge (Option C port, 2026-08-11). Prior behavior replaced
// the whole `stats` JSON object, so a stale client PUT with an empty
// or partial stats blob wiped every measurement the user had recorded
// that day. New behavior: incoming keys with defined values overwrite;
// incoming keys explicitly set to null are treated as user-initiated
// clears; keys the client didn't mention are preserved. This matches
// the intent of every UI flow — saveBodyStats always spreads over
// existing, so a missing key was never meant to signal "clear this".
router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { stats } = req.body;

  const existing = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  const serverStats = existing ? JSON.parse(existing.stats || '{}') : {};
  const merged = mergeStatsObject(serverStats, stats);
  const mergedJson = JSON.stringify(merged);

  if (existing) {
    db.prepare('UPDATE body_stats_log SET stats = ? WHERE id = ?').run(mergedJson, existing.id);
  } else {
    db.prepare('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)').run(userId, date, mergedJson);
  }

  const row = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  if (row) row.stats = JSON.parse(row.stats || '{}');
  res.json({ stats: row });
}));

export default router;
