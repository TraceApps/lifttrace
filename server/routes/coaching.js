/**
 * /api/coaching: consent and leaving, the parts of coaching that are new
 * with it. The coach's own view of a client stays under /api/trainer (same
 * paths as before), behind the same guard (lib/coaching.js).
 *
 * No route here returns a full user row: people are { id, name }.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  person, roleOf, coachingState, acceptPairing, declinePairing, endPairing,
  notifyClientAnswer, requireAccount, requireCoachRole,
} from '../lib/coaching.js';

const router = Router();

const _pairingRow = (id) => db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(id);
const _fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });

// ── Your own place in coaching ──────────────────────────────────────────────
router.get('/state', requireAccount, wrap((req, res) => {
  res.json(coachingState(req.user.id));
}));

// ── The coach's side ────────────────────────────────────────────────────────
// Requests this coach sent that wait for an answer, and answers from the
// last week (a declined request, a client who left), so the answer is seen.
// Active clients are /api/trainer/members, as before.
router.get('/requests', requireCoachRole, wrap((req, res) => {
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.note, cc.requested_at, cc.responded_at, cc.ended_at, cc.ended_by,
           u.id AS client_id, u.full_name, u.nickname, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.client_id
     WHERE cc.coach_id = ?
       AND (cc.status = 'pending'
         OR (cc.status = 'declined' AND cc.responded_at >= datetime('now', '-7 days'))
         OR (cc.status = 'ended' AND cc.ended_by IS NOT cc.coach_id AND cc.ended_at >= datetime('now', '-7 days')))
     ORDER BY CASE cc.status WHEN 'pending' THEN 0 ELSE 1 END,
              COALESCE(cc.ended_at, cc.responded_at, cc.requested_at) DESC
  `).all(req.user.id);
  // One row per person: the open request, else the latest answer. Someone
  // who is a client again since is on the clients list instead.
  const seen = new Set(db.prepare(`SELECT client_id FROM coach_clients WHERE coach_id = ? AND status = 'active'`).all(req.user.id).map(r => r.client_id));
  const out = [];
  for (const r of rows) {
    if (seen.has(r.client_id)) continue;
    seen.add(r.client_id);
    out.push({
      id: r.id, status: r.status, client: person(r.client_id, r), note: r.note || null,
      requested_at: r.requested_at, responded_at: r.responded_at || null, ended_at: r.ended_at || null,
    });
  }
  res.json(out);
}));

// ── The client's answer ─────────────────────────────────────────────────────
router.post('/pairings/:id/accept', requireAccount, wrap((req, res) => {
  try { acceptPairing(Number(req.params.id), req.user.id); }
  catch (e) { return _fail(res, e); }
  res.json(coachingState(req.user.id));
}));
router.post('/pairings/:id/decline', requireAccount, wrap((req, res) => {
  try { declinePairing(Number(req.params.id), req.user.id); }
  catch (e) { return _fail(res, e); }
  res.json(coachingState(req.user.id));
}));

// Ending: the client (Leave Coach), the coach (End Coaching, or taking back a
// request) or an admin (from Users).
router.post('/pairings/:id/end', requireAccount, wrap((req, res) => {
  const row = _pairingRow(Number(req.params.id));
  const me = req.user.id;
  const mine = row && (row.coach_id === me || row.client_id === me);
  if (!row || (!mine && roleOf(me) !== 'admin')) return res.status(404).json({ error: 'Pairing not found' });
  // { expect: 'pending' } takes back a request only while it is one: one
  // accepted in the meantime is coaching now, and stays.
  const expect = ['pending', 'active'].includes(req.body?.expect) ? req.body.expect : null;
  if (expect && row.status !== expect) return res.status(409).json({ error: row.status === 'active' ? 'This request was accepted.' : 'This coaching has already ended.', code: 'status_changed' });
  // Leaving removes that coach's prescriptions and programs, as the coach
  // ending it does (both say so first); an admin ending it only clears it.
  const purge = mine && row.status === 'active';
  if (!endPairing(row.id, me, { purge, onlyStatus: expect })) return res.status(409).json({ error: 'This coaching has already ended.' });
  if (row.status === 'active' && me === row.client_id) notifyClientAnswer(row, 'left');
  res.json(coachingState(me));
}));

// ── Admin: see pairings (the controls are in Users) ─────────────────────────
router.get('/admin/pairings', requireAccount, requireAdmin, wrap((req, res) => {
  // The token's role can be older than an admin's change; ask the database.
  if (roleOf(req.user.id) !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.requested_at, cc.responded_at,
           c.id AS coach_id, c.full_name AS c_full, c.nickname AS c_nick, c.username AS c_user,
           k.id AS client_id, k.full_name AS k_full, k.nickname AS k_nick, k.username AS k_user
      FROM coach_clients cc
      JOIN users c ON c.id = cc.coach_id
      JOIN users k ON k.id = cc.client_id
     WHERE cc.status IN ('pending', 'active')
     ORDER BY cc.status, cc.requested_at
  `).all();
  res.json(rows.map(r => ({
    id: r.id, status: r.status, requested_at: r.requested_at, responded_at: r.responded_at || null,
    coach: person(r.coach_id, { full_name: r.c_full, nickname: r.c_nick, username: r.c_user }),
    client: person(r.client_id, { full_name: r.k_full, nickname: r.k_nick, username: r.k_user }),
  })));
}));

export default router;
