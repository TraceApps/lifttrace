/**
 * /api/excused-days: days you couldn't train, with a reason (issue #121).
 *
 *   GET    /api/excused-days[?start=&end=]  the account's excused days, oldest first
 *   PUT    /api/excused-days/:date          { reason, note? } excuse a day, or change it
 *   DELETE /api/excused-days/:date          remove it (already gone is still a success)
 *
 * Keyed by date, so a write sent twice (an answer lost, a queue replayed)
 * is the same write, and an offline device needs no id from the server.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { refuseDelete } from '../lib/newer-wins.js';
import { listExcusedDays, saveExcusedDay, removeExcusedDay, checkDate } from '../lib/excused-days.js';

const router = Router();
router.use(requireAuth);

router.get('/', wrap((req, res) => {
  const { start, end } = req.query;
  try {
    if (start) checkDate(start);
    if (end) checkDate(end);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(listExcusedDays(uid(req), { start, end }));
}));

router.put('/:date', wrap((req, res) => {
  let result;
  try {
    result = saveExcusedDay(uid(req), req.params.date, req.body, req);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ excused: result.excused });
}));

router.delete('/:date', wrap((req, res) => {
  let result;
  try {
    result = removeExcusedDay(uid(req), req.params.date, req);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (result.refused) return refuseDelete(res, result.excused, result.changedAt);
  res.json({ ok: true, removed: result.removed });
}));

export default router;
