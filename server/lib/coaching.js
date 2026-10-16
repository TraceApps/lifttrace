/**
 * Coaching: who coaches whom, and the one guard every coach endpoint uses.
 *
 * A coach (the Trainer role, or an admin) asks; the client accepts or
 * declines. Accepting is the consent: before it, the coach sees nothing.
 * Either side can end it, and an admin can end any pairing. The role is read
 * from the database on every request, not from the sign-in token, so a role
 * an admin takes away stops working at once.
 *
 * The pairing lives in coach_clients (the same table NutriTrace uses). The
 * active one is also kept in users.trainer_id, which everything from before
 * (set videos, program assignment, released Android apps) reads; the two
 * only ever change together, here.
 *
 * People are { id, name } here: no coaching answer returns a full user row.
 */
import db from '../db.js';
import { userMgmtActive } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { pushNotifyDefaultOn } from './push-notify.js';

/** What /api/auth/status reports, so an app can hide coaching on an older
 *  server: 1 consent, 2 the conversation. */
export const COACHING_VERSION = 2;
export const NOTE_MAX = 500;

export const canCoach = (role) => role === 'trainer' || role === 'admin';
/** Only the Member role is coached in LiftTrace (as before). */
export const canBeCoached = (role) => role === 'member';

export function roleOf(userId) {
  if (userId == null) return null;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role || null;
}

/** The name LiftTrace shows for a person: full name, nickname, username. */
export const personName = (u) => (u?.full_name || u?.nickname || u?.username || '');
export const person = (id, u) => ({ id, name: personName(u) });

function _name(id) {
  return personName(db.prepare('SELECT full_name, nickname, username FROM users WHERE id = ?').get(id)) || 'Someone';
}

/**
 * The one guard: an active pairing between this coach and this client,
 * with the coach still allowed to coach. Null otherwise.
 */
export function activePairing(coachId, clientId) {
  if (coachId == null || clientId == null) return null;
  // The client still a Member too: a role given outside Settings (an SSO
  // group mapping at sign-in) can't leave a coach reading an admin's data.
  return db.prepare(`
    SELECT cc.* FROM coach_clients cc
      JOIN users c ON c.id = cc.coach_id
      JOIN users k ON k.id = cc.client_id
     WHERE cc.coach_id = ? AND cc.client_id = ? AND cc.status = 'active'
       AND c.role IN ('trainer', 'admin') AND k.role = 'member'
  `).get(coachId, clientId) || null;
}

/** Signed in, with accounts on: coaching needs more than one person. */
function _signedIn(req, res) {
  if (!userMgmtActive() || !req.user?.id) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

/** Middleware: the signed-in account may coach (Trainer role or admin). */
export function requireCoachRole(req, res, next) {
  if (!_signedIn(req, res)) return;
  if (!canCoach(roleOf(req.user.id))) return res.status(403).json({ error: 'Only coaches can do this.' });
  next();
}

/** Middleware: signed in, with accounts on. */
export function requireAccount(req, res, next) {
  if (!_signedIn(req, res)) return;
  next();
}

/**
 * The guard for a route about one client. Answers the same 404 for another
 * coach's client, a pending request, an ended pairing and an account that
 * doesn't exist, so a coach learns nothing about other people. Returns the
 * pairing, or null once it has answered.
 */
export function guardClient(req, res, clientId) {
  if (!_signedIn(req, res)) return null;
  if (!canCoach(roleOf(req.user.id))) { res.status(403).json({ error: 'Only coaches can do this.' }); return null; }
  const id = Number(clientId);
  const pairing = Number.isInteger(id) ? activePairing(req.user.id, id) : null;
  if (!pairing) { res.status(404).json({ error: 'Client not found' }); return null; }
  return pairing;
}

/** The coach of this client, if any (for checks that only need a yes or no). */
export const coachesClient = (coachId, clientId) => !!activePairing(coachId, clientId);

// ── Where someone stands ────────────────────────────────────────────────────

/** Where this person stands in coaching, for their own screens. */
export function coachingState(userId) {
  const role = roleOf(userId);
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.note, cc.requested_at, cc.responded_at,
           u.id AS coach_id, u.full_name, u.nickname, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.coach_id
     WHERE cc.client_id = ? AND cc.status IN ('pending', 'active')
     ORDER BY cc.requested_at DESC, cc.id DESC
  `).all(userId);
  const row = rows.find(r => r.status === 'active');
  const counts = { pending: 0, active: 0, recent: 0 };
  for (const r of db.prepare(`
    SELECT status, COUNT(*) AS c FROM coach_clients
     WHERE coach_id = ? AND status IN ('pending', 'active') GROUP BY status
  `).all(userId)) counts[r.status] = r.c;
  // Answers from the last week the coach's list still shows (a declined
  // request, a client who left).
  counts.recent = db.prepare(`
    SELECT COUNT(*) AS c FROM coach_clients
     WHERE coach_id = ?
       AND ((status = 'declined' AND responded_at >= datetime('now', '-7 days'))
         OR (status = 'ended' AND ended_by IS NOT coach_id AND ended_at >= datetime('now', '-7 days')))
  `).get(userId).c;
  // Messages the other person sent that this one hasn't read: per pairing.
  const unreadStmt = db.prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL`);
  const unread = (pid) => unreadStmt.get(pid, userId).c;
  // Coaching that ended keeps its conversation for the client (not the coach).
  const past = db.prepare(`
    SELECT cc.id, cc.ended_at, u.id AS coach_id, u.full_name, u.nickname, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.coach_id
     WHERE cc.client_id = ? AND cc.status = 'ended'
       AND EXISTS (SELECT 1 FROM coach_messages m WHERE m.pairing_id = cc.id)
     ORDER BY cc.ended_at DESC
  `).all(userId).map(r => ({ id: r.id, coach: person(r.coach_id, r), ended_at: r.ended_at, unread: unread(r.id) }));
  const coachActive = canCoach(role)
    ? db.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND status = 'active' ORDER BY id`).all(userId).map(r => r.id)
    : [];
  counts.active_ids = coachActive;
  counts.unread = coachActive.reduce((n, id) => n + unread(id), 0);
  const asClientUnread = row ? unread(row.id) : 0;
  const requests = rows.filter(r => r.status === 'pending');
  // Prescriptions from the coach waiting for an answer (dated ones until
  // the day after their date, as the server can't know the client's day).
  const prescriptions = row ? db.prepare(`
    SELECT COUNT(*) AS c FROM coach_prescriptions
     WHERE member_id = ? AND trainer_id = ? AND status = 'pending'
       AND (date IS NULL OR date >= date('now', '-1 day'))
  `).get(userId, row.coach_id).c : 0;
  return {
    role,
    can_coach: canCoach(role),
    // The coach, once accepted.
    as_client: row ? {
      id: row.id,
      status: row.status,
      coach: person(row.coach_id, row),
      note: row.note || null,
      requested_at: row.requested_at,
      responded_at: row.responded_at || null,
      unread: asClientUnread,
    } : null,
    // Requests waiting for this person's answer, newest first.
    requests: requests.map(r => ({
      id: r.id,
      coach: person(r.coach_id, r),
      note: r.note || null,
      requested_at: r.requested_at,
    })),
    // Ended coaching whose conversation the client can still read.
    past,
    as_coach: counts,
    // For the dot on Programs: unread messages, and things waiting for this
    // person's answer.
    unread: asClientUnread + past.reduce((n, x) => n + x.unread, 0) + counts.unread,
    awaiting: requests.length + prescriptions,
  };
}

/**
 * A short fingerprint of coachingState, sent as a header on the settings
 * refresh the app already makes, so a new request or an ended pairing shows
 * up without an extra request or timer for people not in coaching.
 */
export function coachingSignature(userId) {
  const s = coachingState(userId);
  const c = s.as_client ? String(s.as_client.id) : '-';
  const r = s.requests.map(x => x.id).join(',') || '-';
  const p = s.past.map(x => x.id).join(',') || '-';
  return `${s.role || '-'};${c};${r};${s.as_coach.pending}.${s.as_coach.active};${p};${s.unread};${s.awaiting}`;
}

// ── Changing it ─────────────────────────────────────────────────────────────

/**
 * Accept a pending request: the pairing becomes active and the client's
 * trainer is the coach. Throws { status, code } when it can't.
 */
export function acceptPairing(pairingId, clientId) {
  const p = db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(pairingId);
  if (!p || p.client_id !== clientId) throw _err('Request not found', 404);
  if (p.status !== 'pending') throw _err('This request was already answered.', 409);
  if (!canCoach(roleOf(p.coach_id))) {
    endPairing(p.id, null, { onlyStatus: 'pending' });
    throw _err('This person no longer coaches.', 409);
  }
  if (!canBeCoached(roleOf(clientId))) throw _err('Only members can be coached.', 409);
  const LEAVE_FIRST = 'Leave your coach before you accept another.';
  if (db.prepare(`SELECT 1 FROM coach_clients WHERE client_id = ? AND status = 'active'`).get(clientId)) {
    throw _err(LEAVE_FIRST, 409, 'leave_first');
  }
  let changed = 0;
  try {
    db.transaction(() => {
      changed = db.prepare(`UPDATE coach_clients SET status = 'active', responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(p.id).changes;
      if (changed) db.prepare('UPDATE users SET trainer_id = ? WHERE id = ?').run(p.coach_id, clientId);
    })();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw _err(LEAVE_FIRST, 409, 'leave_first');
    throw e;
  }
  if (changed) notifyClientAnswer(p, 'accepted');
  return changed > 0;
}

/** Decline a pending request. */
export function declinePairing(pairingId, clientId) {
  const p = db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(pairingId);
  if (!p || p.client_id !== clientId) throw _err('Request not found', 404);
  if (p.status !== 'pending') throw _err('This request was already answered.', 409);
  const changed = db.prepare(`UPDATE coach_clients SET status = 'declined', responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(p.id).changes;
  if (changed) notifyClientAnswer(p, 'declined');
  return changed > 0;
}

/**
 * End a pairing (pending or active): the client has no trainer.
 *
 * `purge`: also remove the prescriptions and program assignments that coach
 * gave the client, which is what releasing a client always did. The coach's
 * End Coaching and the client's Leave Coach do it (both say so first); an
 * admin's No Trainer and a role change only ever cleared the trainer, and
 * still do.
 * `onlyStatus`: end it only while it is still in that state (taking back a
 * request must never end coaching the client accepted in the meantime).
 * Returns true when one ended.
 */
export function endPairing(pairingId, byUserId, { purge = false, onlyStatus = null } = {}) {
  const p = db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(pairingId);
  if (!p) return false;
  const statuses = onlyStatus ? [onlyStatus] : ['pending', 'active'];
  let changed = 0;
  db.transaction(() => {
    changed = db.prepare(`
      UPDATE coach_clients
         SET status = 'ended', ended_at = datetime('now'), ended_by = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN (${statuses.map(() => '?').join(',')})
    `).run(byUserId ?? null, pairingId, ...statuses).changes;
    if (changed && p.status === 'active') {
      db.prepare('UPDATE users SET trainer_id = NULL WHERE id = ? AND trainer_id = ?').run(p.client_id, p.coach_id);
      if (purge) {
        db.prepare('DELETE FROM coach_prescriptions WHERE trainer_id = ? AND member_id = ?').run(p.coach_id, p.client_id);
        db.prepare('DELETE FROM program_assignments WHERE assigned_to = ? AND assigned_by = ?').run(p.client_id, p.coach_id);
      }
    }
  })();
  return changed > 0;
}

/** End every open pairing where this person is the client (role changed away from Member). */
export function endAsClient(userId, byUserId) {
  const rows = db.prepare(`SELECT id FROM coach_clients WHERE client_id = ? AND status IN ('pending', 'active')`).all(userId);
  for (const r of rows) endPairing(r.id, byUserId);
  // A trainer set by hand before pairings were kept goes too.
  db.prepare('UPDATE users SET trainer_id = NULL WHERE id = ?').run(userId);
  return rows.length;
}

/**
 * Someone who can no longer coach (their role changed to Member) stops
 * coaching: their pending requests and active pairings end.
 */
export function endCoachingIfNotCoach(userId, byUserId) {
  if (canCoach(roleOf(userId))) return 0;
  const rows = db.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND status IN ('pending', 'active')`).all(userId);
  for (const r of rows) endPairing(r.id, byUserId);
  return rows.length;
}

/**
 * A coach asks someone to be their client. Only this coach's own pairings
 * decide the answer: whether the person has another coach or other
 * requests is never said. Returns the new pairing row.
 */
export function requestClient(coachId, clientId, note = null) {
  if (!Number.isInteger(clientId) || clientId === coachId) throw _err('Choose someone to coach.', 400);
  const client = db.prepare('SELECT id, role, full_name, nickname, username FROM users WHERE id = ?').get(clientId);
  if (!client) throw _err('Choose someone to coach.', 404);
  if (!canBeCoached(client.role)) throw _err('Only members can be coached.', 400);
  const name = personName(client);
  const own = db.prepare(`SELECT status FROM coach_clients WHERE coach_id = ? AND client_id = ? AND status IN ('pending', 'active')`).get(coachId, clientId);
  if (own?.status === 'active') throw _err(`${name} is already your client.`, 409, 'already_client');
  if (own?.status === 'pending') throw _err(`You already asked ${name}.`, 409, 'already_asked');
  let id;
  try {
    id = db.prepare(`INSERT INTO coach_clients (coach_id, client_id, status, note) VALUES (?, ?, 'pending', ?)`)
      .run(coachId, clientId, _note(note)).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw _err(`You already asked ${name}.`, 409, 'already_asked');
    throw e;
  }
  notifyRequest(coachId, clientId);
  return { row: db.prepare('SELECT * FROM coach_clients WHERE id = ?').get(id), client };
}

/** A pending request made for a new account (an invite, or an admin creating it). */
export function requestFromInvite(coachId, clientId) {
  if (coachId == null || coachId === clientId || !canCoach(roleOf(coachId)) || !canBeCoached(roleOf(clientId))) return null;
  try {
    return db.prepare(`INSERT INTO coach_clients (coach_id, client_id, status) VALUES (?, ?, 'pending')`)
      .run(coachId, clientId).lastInsertRowid;
  } catch { return null; }
}

/**
 * Pairings from before consent: a client whose trainer_id is set and who has
 * no active pairing gets one, active, with nothing to accept and nothing
 * sent. Runs at start-up and after a restore; does nothing once adopted.
 */
export function adoptExistingPairings() {
  // When it began isn't known, so no "since" date is shown for these.
  const r = db.prepare(`
    INSERT INTO coach_clients (coach_id, client_id, status, requested_at, responded_at)
    SELECT u.trainer_id, u.id, 'active', COALESCE(u.created_at, datetime('now')), NULL
      FROM users u JOIN users c ON c.id = u.trainer_id
     WHERE u.trainer_id IS NOT NULL AND u.trainer_id != u.id
       AND u.role = 'member' AND c.role IN ('trainer', 'admin')
       AND NOT EXISTS (SELECT 1 FROM coach_clients cc WHERE cc.client_id = u.id AND cc.status = 'active')
  `).run();
  if (r.changes) logger.info?.(`[coaching] kept ${r.changes} existing coach pairing(s) as accepted`);
  // A trainer that was never a working one (pointing at the account itself,
  // someone who can't coach, or set on a non-Member) gave nobody access
  // before either; cleared, so the person can be asked by a coach.
  const c = db.prepare(`
    UPDATE users SET trainer_id = NULL
     WHERE trainer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM coach_clients cc WHERE cc.client_id = users.id AND cc.coach_id = users.trainer_id AND cc.status = 'active')
  `).run();
  if (c.changes) logger.info?.(`[coaching] cleared ${c.changes} trainer setting(s) that pointed at no coach`);
  return r.changes;
}

/**
 * A role set outside Settings, Users (an SSO group mapping at sign-in):
 * the same coaching cleanup a role change there does.
 */
export function coachingAfterRoleChange(userId, byUserId = null) {
  const role = roleOf(userId);
  const asClient = role !== 'member' ? endAsClient(userId, byUserId) : 0;
  return asClient + endCoachingIfNotCoach(userId, byUserId);
}

const _note = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, NOTE_MAX) : null;
};

function _err(message, status, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

// ── Telling the other person ────────────────────────────────────────────────

/** A coach asked: the person hears who (never the note), under New
 *  Recommendation (on unless turned off). */
export async function notifyRequest(coachId, clientId) {
  try {
    await pushNotifyDefaultOn(clientId, 'notifCoachRecommendation', 'Coaching', `${_name(coachId)} wants to be your coach.`, 5);
  } catch (e) {
    logger.warn(`[coaching] request notification failed: ${e?.message || e}`);
  }
}

/** A coach prescribed a workout: the client hears who (never the note),
 *  under New Recommendation (on unless turned off). */
export async function notifyPrescription(coachId, clientId) {
  try {
    await pushNotifyDefaultOn(clientId, 'notifCoachRecommendation', 'Coaching', `${_name(coachId)} prescribed a workout.`, 5);
  } catch (e) {
    logger.warn(`[coaching] prescription notification failed: ${e?.message || e}`);
  }
}

/** The client accepted or declined a prescription (on unless turned off). */
export async function notifyPrescriptionAnswer(row, answer) {
  try {
    const text = `${_name(row.member_id)} ${answer === 'accepted' ? 'accepted' : 'declined'} the workout you prescribed.`;
    await pushNotifyDefaultOn(row.trainer_id, 'notifClientAnswer', 'Coaching', text, 5);
  } catch (e) {
    logger.warn(`[coaching] prescription answer notification failed: ${e?.message || e}`);
  }
}

/** The client answered or left: the coach hears about it (on unless turned off). */
export async function notifyClientAnswer(p, kind) {
  try {
    const name = _name(p.client_id);
    const text = kind === 'accepted' ? `${name} accepted your coaching request.`
      : kind === 'declined' ? `${name} declined your coaching request.`
      : `${name} left coaching with you.`;
    await pushNotifyDefaultOn(p.coach_id, 'notifClientAnswer', 'Coaching', text, 5);
  } catch (e) {
    logger.warn(`[coaching] answer notification failed: ${e?.message || e}`);
  }
}
