import { Router } from 'express';
import { linkBase } from '../lib/public-url.js';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireTrainerOrAdmin, uid } from '../middleware/auth.js';
import { templateFor, toId } from '../lib/program-access.js';
import { pushNotify } from '../lib/push-notify.js';
import { setVolume } from '../lib/volume.js';
import { sendCoachFeedback, isEmailConfigured } from '../email.js';
import { guardClient, activePairing, requireCoachRole, requestClient, endPairing, person, notifyPrescription } from '../lib/coaching.js';
import { answerGone, createdBefore, rememberCreated, rowForKey } from '../lib/create-keys.js';
import { trainedDateSet } from '../lib/trained-days.js';
import { currentStreak, shiftDate } from '../../src/lib/trained-day.js';
import { getExcusedDay, listExcusedDays } from '../lib/excused-days.js';
import { getActiveProgramCore } from '../lib/mcp/tools/get-active-program.js';
import { userToday } from '../lib/user-zone.js';

const router = Router();
router.use(requireAuth);
router.use(requireTrainerOrAdmin);
// The role in the database decides, not the one in the sign-in token: a
// coach an admin made a Member stops at once.
router.use(requireCoachRole);

// What a coach is told about a client: who they are, not their account
// (no email, birthday, gender or sign-in details).
function clientOut(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, full_name: u.full_name, nickname: u.nickname, avatar_url: u.avatar_url, role: u.role };
}

// Every route about one client goes through guardClient (lib/coaching.js):
// an active pairing between this coach and this client, accepted by the
// client. Another coach's client, a request still waiting, coaching that
// ended, and an admin who isn't the coach all get the same 404. (A delete of
// another coach's prescription answers as one already gone, deleting
// nothing: _deletePrescription.)

// GET /api/trainer/members: this coach's clients, each one who accepted.
router.get('/members', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT u.*, cc.id AS pairing_id, cc.responded_at AS coached_since FROM users u
       JOIN coach_clients cc ON cc.client_id = u.id AND cc.coach_id = ? AND cc.status = 'active'
      ORDER BY COALESCE(u.nickname, u.full_name, u.username)`
  ).all(req.user.id);

  // Light-weight annotations per member: active program name, last workout date, 7-day workout count
  const out = rows.map(u => {
    const active = db.prepare(
      `SELECT p.name FROM program_assignments pa
       JOIN programs p ON p.id = pa.program_id
       WHERE pa.assigned_to = ? AND pa.active = 1 LIMIT 1`
    ).get(u.id);
    const last = db.prepare(
      `SELECT date FROM workout_log WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL ORDER BY date DESC LIMIT 1`
    ).get(u.id);
    const weekCount = db.prepare(
      `SELECT COUNT(*) as c FROM workout_log WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL AND date >= date('now', '-7 days')`
    ).get(u.id)?.c || 0;
    // Messages from this client the coach hasn't read (the conversation).
    const unread = db.prepare(
      `SELECT COUNT(*) AS c FROM coach_messages WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL`
    ).get(u.pairing_id, req.user.id).c;
    return { ...clientOut(u), pairing_id: u.pairing_id, coached_since: u.coached_since, active_program: active?.name || null, last_workout_date: last?.date || null, week_count: weekCount, unread };
  });
  res.json(out);
}));

// GET /api/trainer/members/:id — overview of a single member
router.get('/members/:id', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  const pairing = guardClient(req, res, memberId);
  if (!pairing) return;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const activeProgram = db.prepare(
    `SELECT p.id, p.name, p.goal FROM program_assignments pa
     JOIN programs p ON p.id = pa.program_id
     WHERE pa.assigned_to = ? AND pa.active = 1 LIMIT 1`
  ).get(memberId) || null;
  // Where the client is in it: the plan week, and the days their excused
  // days have paused a calendar program (#121). "Today" is the client's: in
  // the zone their app said last (lib/user-zone.js), else the server's. The
  // coach's own zone (?tz=, sent by apps before this) says nothing of it.
  if (activeProgram) {
    const where = getActiveProgramCore(memberId);
    if (where.active && where.program_id === activeProgram.id) {
      Object.assign(activeProgram, {
        duration_weeks: where.duration_weeks,
        advance_mode: where.advance_mode,
        current_week: where.current_week,
        paused_days: where.paused_days,
      });
    }
  }

  const assignedPrograms = db.prepare(
    `SELECT p.id, p.name, p.goal, pa.active, pa.assigned_at FROM program_assignments pa
     JOIN programs p ON p.id = pa.program_id
     WHERE pa.assigned_to = ? ORDER BY pa.assigned_at DESC`
  ).all(memberId);

  // Only completed workouts — drafts/empty attempts are noise on the coach
  // overview. Pull exercises too so the row can preview volume + set count
  // without a second round-trip, and we can compute the headline stats
  // (sets, volume) inline.
  // Inline counts of (a) any coach feedback on the workout and (b) feedback
  // that has a member reply, so the coach's recent-workouts list can show
  // an indicator without follow-up requests. trainer_id filters to the
  // current viewer so the "mine" count only reflects what this coach left.
  const recentWorkouts = db.prepare(
    `SELECT wl.id, wl.date, wl.name, wl.completed, wl.duration_min, wl.exercises,
            (SELECT COUNT(*) FROM coach_feedback cf
              WHERE cf.workout_id = wl.id) AS feedback_count,
            (SELECT COUNT(*) FROM coach_feedback cf
              WHERE cf.workout_id = wl.id AND cf.trainer_id = ?) AS my_feedback_count,
            (SELECT COUNT(*) FROM coach_feedback cf
              WHERE cf.workout_id = wl.id AND cf.trainer_id = ?
                AND cf.member_reply IS NOT NULL) AS my_reply_count
       FROM workout_log wl
      WHERE wl.user_id = ? AND wl.completed = 1 AND wl.deleted_at IS NULL
      ORDER BY wl.date DESC LIMIT 20`
  ).all(req.user.id, req.user.id, memberId).map(r => {
    const exs = (() => { try { return JSON.parse(r.exercises || '[]'); } catch { return []; } })();
    let volume = 0, setCount = 0, exerciseCount = 0;
    for (const ex of exs) {
      const completedSets = (ex.sets || []).filter(s => s.completed && !s.warmup);
      if (completedSets.length > 0) exerciseCount++;
      const lt = ex.load_type || 'bilateral';
      for (const s of completedSets) {
        setCount++;
        volume += setVolume(s, lt);
      }
    }
    return {
      ...r,
      exercises: exs,
      volume: Math.round(volume),
      set_count: setCount,
      exercise_count: exerciseCount,
    };
  });

  // The client's current streak, by the trained-day rule the client's own
  // app counts (src/lib/trained-day.js), so coach and client see one number,
  // from the client's today.
  const clientToday = userToday(memberId);
  const streak = currentStreak(trainedDateSet(memberId), clientToday);

  // Member's chosen weight unit so the coach UI labels volume + set weights
  // in whatever the member actually trains in (rather than always lbs).
  const weightUnitRow = db.prepare(
    "SELECT value FROM user_settings WHERE user_id = ? AND key = 'weightUnit'"
  ).get(memberId);
  let weight_unit = 'lbs';
  if (weightUnitRow?.value) {
    try { weight_unit = JSON.parse(weightUnitRow.value); } catch { weight_unit = weightUnitRow.value; }
  }

  res.json({
    user: clientOut(user),
    pairing_id: pairing.id,
    coached_since: pairing.responded_at || null,
    active_program: activeProgram,
    assigned_programs: assignedPrograms,
    recent_workouts: recentWorkouts,
    // Days the client excused (issue #121), the last eight weeks and what's
    // planned ahead, newest first, with the reason and note.
    excused_days: listExcusedDays(memberId, { start: shiftDate(clientToday, -56), end: shiftDate(clientToday, 56) }).reverse(),
    streak,
    weight_unit,
  });
}));

// GET /api/trainer/members/:id/workout/:date — trainer views a specific
// member workout (read-only) with any coach feedback they've left on it.
router.get('/members/:id/workout/:date', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!guardClient(req, res, memberId)) return;
  const row = db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1').get(memberId, req.params.date);
  if (!row) return res.json(null);
  row.exercises = JSON.parse(row.exercises || '[]');
  // Join in feedback rows for this workout from any trainer (so the
  // current trainer sees a previous coach's notes if there was a handoff).
  row.feedback = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.exercise_uuid, cf.note, cf.updated_at,
           cf.member_reply, cf.member_replied_at, cf.seen_by_member_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name,
           u.avatar_url AS trainer_avatar_url
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(row.id);
  // The day excused too (issue #121): trained anyway, it still shows why.
  row.excused = getExcusedDay(memberId, req.params.date);
  res.json(row);
}));

// POST /api/trainer/feedback — coach leaves (or updates) a note on a
// member's completed workout. Body: { workout_id, exercise_idx?, note }.
// exercise_idx is the 0-based POSITION within the workout's exercises
// array (not the library exercise_id; identical exercises in different
// slots are distinct surfaces). Null exercise_idx = workout-level note.
// Empty note deletes. Upserts on (workout_id, exercise_idx, trainer_id).
router.post('/feedback', wrap((req, res) => {
  const { workout_id, exercise_idx, exercise_uuid, note, media_id, media_time_sec } = req.body || {};
  if (!workout_id) return res.status(400).json({ error: 'workout_id required' });

  const workout = db.prepare('SELECT id, user_id, date, name FROM workout_log WHERE id = ? AND deleted_at IS NULL').get(workout_id);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });
  if (!activePairing(req.user.id, workout.user_id)) return res.status(404).json({ error: 'Workout not found' });

  const idx = exercise_idx ?? null;

  // A note can hang off one of the member's clips and name the moment it is
  // about (issue #57), so tapping the timestamp seeks the player. The clip
  // has to be on this very workout: a coach pointing a note at any other row
  // would hand themselves a readable id for footage from a different member.
  let clipId = null;
  let clipTime = null;
  if (media_id != null) {
    const clip = db.prepare(
      'SELECT id FROM set_media WHERE id = ? AND workout_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).get(media_id, workout.id, workout.user_id);
    if (!clip) return res.status(400).json({ error: 'That clip is not on this workout' });
    clipId = clip.id;
    clipTime = Number.isFinite(Number(media_time_sec)) && Number(media_time_sec) >= 0
      ? Number(media_time_sec)
      : null;
  }

  if (!note || !String(note).trim()) {
    if (exercise_uuid) {
      db.prepare(
        `DELETE FROM coach_feedback WHERE workout_id = ? AND exercise_uuid = ? AND trainer_id = ?`
      ).run(workout_id, exercise_uuid, req.user.id);
    } else {
      db.prepare(
        `DELETE FROM coach_feedback
          WHERE workout_id = ? AND COALESCE(exercise_idx, -1) = COALESCE(?, -1) AND trainer_id = ?`
      ).run(workout_id, idx, req.user.id);
    }
    return res.json({ ok: true, deleted: true });
  }

  // The uuid is the exercise itself; the index is only where it happened to
  // sit when the note was written. Match on the uuid when there is one, so a
  // reordered session keeps each note on its own lift.
  const uuid = exercise_uuid || null;
  const existing = (uuid && db.prepare(
    `SELECT id FROM coach_feedback WHERE workout_id = ? AND exercise_uuid = ? AND trainer_id = ?`
  ).get(workout_id, uuid, req.user.id))
    || db.prepare(
      `SELECT id FROM coach_feedback
        WHERE workout_id = ? AND COALESCE(exercise_idx, -1) = COALESCE(?, -1) AND trainer_id = ?
          AND exercise_uuid IS NULL`
    ).get(workout_id, idx, req.user.id);

  if (existing) {
    db.prepare(
      `UPDATE coach_feedback SET note = ?, exercise_uuid = COALESCE(?, exercise_uuid), exercise_idx = ?,
              media_id = ?, media_time_sec = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(String(note).trim(), uuid, idx, clipId, clipTime, existing.id);
  } else {
    db.prepare(
      `INSERT INTO coach_feedback (trainer_id, member_id, workout_id, exercise_idx, exercise_uuid, note, media_id, media_time_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.user.id, workout.user_id, workout_id, idx, uuid, String(note).trim(), clipId, clipTime);
  }

  if (!existing) {
    const optIn = (() => {
      const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(workout.user_id, 'notifCoachFeedback');
      if (!row) return true;
      try { return JSON.parse(row.value) !== false; } catch { return true; }
    })();
    if (optIn) {
      const trainerName = db.prepare('SELECT COALESCE(nickname, full_name, username) AS n FROM users WHERE id = ?').get(req.user.id)?.n || 'Your coach';
      // Body carries a preview of the actual note (truncated) instead of
      // a generic "you got feedback" line — strictly more useful at a
      // glance. Pro chat apps (Slack, iMessage) work this way; OS-level
      // lock-screen privacy still controls whether previews are shown.
      const max = 120;
      const noteText = String(note).trim();
      const body = noteText.length > max ? noteText.slice(0, max - 1) + '…' : noteText;
      pushNotify(workout.user_id, `💬 ${trainerName}`, body, 4).catch(() => {});

      // Best-effort email so trainees hear about coach feedback even
      // when the app is closed. Same opt-in as push (notifCoachFeedback);
      // skipped for self-feedback (trainer coaching themselves), when
      // SMTP isn't configured, or when the trainee has no email on file.
      if (isEmailConfigured() && workout.user_id !== req.user.id) {
        const trainee = db.prepare(
          'SELECT email, COALESCE(nickname, full_name, username) AS name FROM users WHERE id = ?'
        ).get(workout.user_id);
        if (trainee?.email) {
          const workoutLabel = workout.name
            ? `${workout.name} (${workout.date})`
            : `your workout on ${workout.date}`;
          const base = linkBase(req);
          if (base) {
            sendCoachFeedback(trainee.email, workoutLabel, trainerName, noteText, `${base}/#/`)
              .catch(() => {});
          }
        }
      }
    }
  }

  res.json({ ok: true });
}));

// ── Prescriptions ──────────────────────────────────────────────────────────
function parsePrescription(row) {
  if (!row) return null;
  return { ...row, exercises: row.exercises ? JSON.parse(row.exercises) : null };
}

// GET /api/trainer/members/:id/prescriptions — list prescriptions the trainer has given this member
router.get('/members/:id/prescriptions', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!guardClient(req, res, memberId)) return;
  const rows = db.prepare(
    `SELECT cp.*, wt.name as template_name, p.name as program_name,
            -- For dated prescriptions, check if the member logged a workout that day
            -- matching the template, marked as completed
            CASE
              WHEN cp.date IS NULL THEN NULL
              WHEN EXISTS (
                SELECT 1 FROM workout_log wl
                WHERE wl.user_id = cp.member_id AND wl.date = cp.date
                  AND wl.completed = 1
                  AND wl.deleted_at IS NULL
                  AND (cp.template_id IS NULL OR wl.template_id = cp.template_id)
              ) THEN 1
              ELSE 0
            END as completed,
            -- The day excused by the member (issue #121): why it wasn't done.
            ed.reason AS excused_reason, ed.note AS excused_note
     FROM coach_prescriptions cp
     LEFT JOIN workout_templates wt ON wt.id = cp.template_id
     LEFT JOIN programs p ON p.id = wt.program_id
     LEFT JOIN excused_days ed ON ed.user_id = cp.member_id AND ed.date = cp.date AND ed.deleted_at IS NULL
     WHERE cp.member_id = ?
     ORDER BY COALESCE(cp.date, cp.created_at) DESC`
  ).all(memberId);
  res.json(rows.map(parsePrescription));
}));

// POST /api/trainer/members/:id/prescriptions — create prescription
router.post('/members/:id/prescriptions', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!guardClient(req, res, memberId)) return;
  // Sent again after its answer was lost (the web app's queue): the one
  // made the first time, with no second notification (create-keys.js).
  // Deleted since: done, nothing to make.
  const before = createdBefore(req, req.user.id, 'coach_prescriptions');
  if (before?.gone) return answerGone(res);
  if (before && before.trainer_id === req.user.id && before.member_id === memberId) return res.json(parsePrescription(before));
  // The same key for another client: not a repeat of this create.
  if (before) return res.status(409).json({ error: 'client_key already used' });
  const { date, name, exercises, notes } = req.body || {};
  const template_id = req.body?.template_id == null || req.body.template_id === '' ? null : toId(req.body.template_id);
  if (req.body?.template_id != null && req.body.template_id !== '' && !template_id) {
    return res.status(400).json({ error: 'Invalid template_id' });
  }
  if (!template_id && (!name || !Array.isArray(exercises))) {
    return res.status(400).json({ error: 'Provide either template_id or name + exercises[]' });
  }
  // A day the coach can see; prescribing hands it to the athlete.
  if (template_id && !templateFor(template_id, uid(req)).canSee) {
    return res.status(404).json({ error: 'Template not found' });
  }
  // Waiting for the client's answer (Accept, then Load).
  const result = db.prepare(
    `INSERT INTO coach_prescriptions (trainer_id, member_id, date, template_id, name, exercises, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    req.user.id, memberId,
    date || null,
    template_id || null,
    name || null,
    exercises ? JSON.stringify(exercises) : null,
    notes || null
  );
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(result.lastInsertRowid);
  rememberCreated(req, req.user.id, 'coach_prescriptions', row.id);
  notifyPrescription(req.user.id, memberId);
  res.json(parsePrescription(row));
}));

// GET /api/trainer/unassigned-members: people with no coach, for the coach
// to ask. Id and name only, like any picker of people: the whole account
// record (email, birthday and the rest) went to every coach before.
// `full_name` carries the same name for the released apps, which read it.
router.get('/unassigned-members', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT id, full_name, nickname, username FROM users
      WHERE role = 'member' AND id != ?
        AND NOT EXISTS (SELECT 1 FROM coach_clients cc WHERE cc.client_id = users.id AND cc.status = 'active')
        AND id NOT IN (SELECT client_id FROM coach_clients WHERE coach_id = ? AND status = 'pending')
      ORDER BY COALESCE(nickname, full_name, username)`
  ).all(req.user.id, req.user.id);
  res.json(rows.map(u => { const p = person(u.id, u); return { ...p, full_name: p.name }; }));
}));

// POST /api/trainer/members/:id: ask someone to be your client. Body:
// { note? }. Nothing is shared until they accept (lib/coaching.js).
router.post('/members/:id', wrap((req, res) => {
  try {
    const { row } = requestClient(req.user.id, parseInt(req.params.id), req.body?.note);
    res.json({ ok: true, status: row.status, id: row.id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
  }
}));

// PUT /api/trainer/prescriptions/:id — edit an existing prescription
// (date, notes, or which template). Useful for promoting an undated
// "anytime" prescription into a scheduled one, or shifting a date.
router.put('/prescriptions/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(id);
  // The coach who prescribed it, while still coaching that client.
  if (!row || row.trainer_id !== req.user.id || !activePairing(req.user.id, row.member_id)) {
    return res.status(404).json({ error: 'Prescription not found' });
  }
  const body = req.body || {};
  // null vs undefined matters: undefined leaves the field alone, null
  // clears it (e.g. promote/demote the date).
  const next = {
    date:        body.date         === undefined ? row.date         : body.date,
    template_id: body.template_id  === undefined ? row.template_id
               : (body.template_id == null || body.template_id === '') ? null : toId(body.template_id),
    name:        body.name         === undefined ? row.name         : body.name,
    notes:       body.notes        === undefined ? row.notes        : body.notes,
  };
  if (body.template_id != null && body.template_id !== '' && !next.template_id) {
    return res.status(400).json({ error: 'Invalid template_id' });
  }
  if (next.template_id && next.template_id !== row.template_id && !templateFor(next.template_id, uid(req)).canSee) {
    return res.status(404).json({ error: 'Template not found' });
  }
  // Re-set or clear the prescription_completed activity flag if the date
  // changed — a missed-day flag that fires for the old date shouldn't
  // linger when the trainer reschedules. Cheap to just clear; the
  // scheduler will re-evaluate the new date on its next tick.
  if (next.date !== row.date) {
    db.prepare(`DELETE FROM coach_activity WHERE prescription_id = ?`).run(id);
  }
  // A different workout, or one the client declined given again: it asks
  // again (only a new date or notes keep an accepted one accepted).
  const reask = row.status === 'declined'
    || (next.template_id || null) !== (row.template_id || null) || (next.name || null) !== (row.name || null);
  db.prepare(
    `UPDATE coach_prescriptions SET date = ?, template_id = ?, name = ?, notes = ?${reask ? `, status = 'pending', responded_at = NULL` : ''} WHERE id = ?`
  ).run(next.date || null, next.template_id || null, next.name || null, next.notes || null, id);
  if (reask && row.status !== 'pending') notifyPrescription(req.user.id, row.member_id);
  res.json({ ok: true });
}));

// DELETE /api/trainer/members/:id: the coach ends coaching (End Coaching).
// The client no longer has a trainer, and the prescriptions and program
// assignments this coach gave them go (lib/coaching.js endPairing).
router.delete('/members/:id', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  const pairing = guardClient(req, res, memberId);
  if (!pairing) return;
  endPairing(pairing.id, req.user.id, { purge: true });
  res.json({ ok: true });
}));

// GET /api/trainer/activity: this coach's own feed (an admin's too: an
// admin used to see every coach's events), for clients still coached by
// this coach. Up to ?limit=50 rows newest-first with the client's display
// name and the prescription's template/program/date so the UI doesn't need
// follow-up requests to render the feed.
router.get('/activity', wrap((req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const params = [req.user.id, req.user.id, limit];
  const where = `WHERE ca.trainer_id = ?
       AND EXISTS (SELECT 1 FROM coach_clients cc WHERE cc.coach_id = ? AND cc.client_id = ca.member_id AND cc.status = 'active')`;
  const rows = db.prepare(`
    SELECT ca.id, ca.trainer_id, ca.member_id, ca.kind, ca.prescription_id,
           ca.workout_id, ca.feedback_id, ca.occurred_at, ca.seen_at,
           u.full_name AS member_full_name, u.username AS member_username,
           u.nickname  AS member_nickname,
           cp.date AS prescription_date, cp.template_id, cp.name AS prescription_name,
           wt.name AS template_name, p.name AS program_name,
           cf.note AS feedback_note, cf.member_reply AS feedback_reply_text,
           wl.date AS workout_date,
           ed.reason AS excused_reason, ed.note AS excused_note
      FROM coach_activity ca
      LEFT JOIN users u ON u.id = ca.member_id
      LEFT JOIN coach_prescriptions cp ON cp.id = ca.prescription_id
      LEFT JOIN workout_templates  wt ON wt.id = cp.template_id
      LEFT JOIN programs           p  ON p.id  = wt.program_id
      LEFT JOIN coach_feedback    cf ON cf.id = ca.feedback_id
      LEFT JOIN workout_log       wl ON wl.id = ca.workout_id
      LEFT JOIN excused_days      ed ON ca.kind = 'prescription_excused' AND ed.user_id = ca.member_id AND ed.date = cp.date AND ed.deleted_at IS NULL
      ${where}
     ORDER BY ca.occurred_at DESC
     LIMIT ?
  `).all(...params);
  res.json(rows);
}));

// POST /api/trainer/activity/seen — mark one or all activity rows as read.
// Body: { id: <number> } to mark a single row, or {} to mark everything.
router.post('/activity/seen', wrap((req, res) => {
  const { id } = req.body || {};
  if (id) {
    db.prepare(`UPDATE coach_activity SET seen_at = datetime('now')
                 WHERE id = ? AND trainer_id = ? AND seen_at IS NULL`).run(id, req.user.id);
  } else {
    db.prepare(`UPDATE coach_activity SET seen_at = datetime('now')
                 WHERE trainer_id = ? AND seen_at IS NULL`).run(req.user.id);
  }
  res.json({ ok: true });
}));

// DELETE /api/trainer/prescriptions/:id — retract
router.delete('/prescriptions/:id', wrap((req, res) => _deletePrescription(req, res, parseInt(req.params.id))));

// DELETE /api/trainer/prescriptions/by-key/:key  the prescription a create
// with this client_key made, deleted before its maker learned its id
// (create-keys.js rowForKey). Keys are this coach's own: another coach's
// or a client's key names nothing here. Made by no create yet: one
// arriving later makes nothing.
router.delete('/prescriptions/by-key/:key', wrap((req, res) => {
  const found = rowForKey(req.user.id, 'coach_prescriptions', req.params.key);
  if (!found) return res.status(400).json({ error: 'client_key required' });
  if (found.id == null) return res.json({ ok: true, by_key: true, deleted: false });
  return _deletePrescription(req, res, found.id, { by_key: true });
}));

function _deletePrescription(req, res, id, extra = {}) {
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ? AND trainer_id = ?').get(id, req.user.id);
  // Already gone is still a success, as for cardio: a delete sent again
  // (its answer lost, a second tab, a double tap) is done, not refused.
  // Another coach's answers the same, so nobody learns which ids are theirs.
  if (!row) return res.json({ ok: true, deleted: false, ...extra });
  // Only while still coaching that client.
  if (!activePairing(req.user.id, row.member_id)) {
    return res.status(404).json({ error: 'Prescription not found', ...extra });
  }
  db.prepare('DELETE FROM coach_prescriptions WHERE id = ?').run(id);
  res.json({ ok: true, deleted: true, ...extra });
}

export default router;
