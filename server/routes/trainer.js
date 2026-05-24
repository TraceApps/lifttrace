import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireTrainerOrAdmin, userMgmtActive } from '../middleware/auth.js';
import { pushNotify } from '../lib/push-notify.js';
import { setVolume } from '../lib/volume.js';

const router = Router();
router.use(requireAuth);
router.use(requireTrainerOrAdmin);

function safeUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

/** Trainer owns member iff user.trainer_id === trainerId. Admins always pass. */
function ownsMember(requester, memberId) {
  if (!userMgmtActive()) return true;
  if (requester?.role === 'admin') return true;
  const m = db.prepare('SELECT trainer_id FROM users WHERE id = ?').get(memberId);
  return m && m.trainer_id === requester.id;
}

// GET /api/trainer/members — list members where THIS user is the trainer.
// Previously admins saw every member regardless of trainer_id, but that meant
// releasing a coachee left them on the admin's coaching list ("My Members"
// implied coaches-me, not all-users). Admins can still see / manage every
// user from Settings → User Management; the /coaching tab is specifically
// for the coach role.
router.get('/members', wrap((req, res) => {
  const rows = db.prepare(
    "SELECT * FROM users WHERE role = 'member' AND trainer_id = ? ORDER BY COALESCE(nickname, full_name, username)"
  ).all(req.user.id);

  // Light-weight annotations per member: active program name, last workout date, 7-day workout count
  const out = rows.map(u => {
    const active = db.prepare(
      `SELECT p.name FROM program_assignments pa
       JOIN programs p ON p.id = pa.program_id
       WHERE pa.assigned_to = ? AND pa.active = 1 LIMIT 1`
    ).get(u.id);
    const last = db.prepare(
      `SELECT date FROM workout_log WHERE user_id = ? AND completed = 1 ORDER BY date DESC LIMIT 1`
    ).get(u.id);
    const weekCount = db.prepare(
      `SELECT COUNT(*) as c FROM workout_log WHERE user_id = ? AND completed = 1 AND date >= date('now', '-7 days')`
    ).get(u.id)?.c || 0;
    return { ...safeUser(u), active_program: active?.name || null, last_workout_date: last?.date || null, week_count: weekCount };
  });
  res.json(out);
}));

// GET /api/trainer/members/:id — overview of a single member
router.get('/members/:id', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!ownsMember(req.user, memberId)) return res.status(403).json({ error: 'Not your member' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(memberId);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const activeProgram = db.prepare(
    `SELECT p.id, p.name, p.goal FROM program_assignments pa
     JOIN programs p ON p.id = pa.program_id
     WHERE pa.assigned_to = ? AND pa.active = 1 LIMIT 1`
  ).get(memberId) || null;

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
      WHERE wl.user_id = ? AND wl.completed = 1
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

  const streak = (() => {
    // Current streak: consecutive days with a completed workout ending today or yesterday
    const rows = db.prepare(
      `SELECT DISTINCT date FROM workout_log WHERE user_id = ? AND completed = 1 ORDER BY date DESC LIMIT 365`
    ).all(memberId).map(r => r.date);
    if (!rows.length) return 0;
    const today = new Date(); today.setHours(0,0,0,0);
    const toDate = (s) => { const d = new Date(s + 'T12:00:00'); d.setHours(0,0,0,0); return d; };
    const first = toDate(rows[0]);
    const dayDiff = Math.round((today - first) / (1000 * 60 * 60 * 24));
    if (dayDiff > 1) return 0;
    let streakN = 1;
    for (let i = 1; i < rows.length; i++) {
      const prev = toDate(rows[i-1]);
      const cur = toDate(rows[i]);
      if (Math.round((prev - cur) / (1000 * 60 * 60 * 24)) === 1) streakN++;
      else break;
    }
    return streakN;
  })();

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
    user: safeUser(user),
    active_program: activeProgram,
    assigned_programs: assignedPrograms,
    recent_workouts: recentWorkouts,
    streak,
    weight_unit,
  });
}));

// GET /api/trainer/members/:id/workout/:date — trainer views a specific
// member workout (read-only) with any coach feedback they've left on it.
router.get('/members/:id/workout/:date', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!ownsMember(req.user, memberId)) return res.status(403).json({ error: 'Not your member' });
  const row = db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND date = ?').get(memberId, req.params.date);
  if (!row) return res.json(null);
  row.exercises = JSON.parse(row.exercises || '[]');
  // Join in feedback rows for this workout from any trainer (so the
  // current trainer sees a previous coach's notes if there was a handoff).
  row.feedback = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.note, cf.updated_at,
           cf.member_reply, cf.member_replied_at, cf.seen_by_member_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name,
           u.avatar_url AS trainer_avatar_url
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(row.id);
  res.json(row);
}));

// POST /api/trainer/feedback — coach leaves (or updates) a note on a
// member's completed workout. Body: { workout_id, exercise_idx?, note }.
// exercise_idx is the 0-based POSITION within the workout's exercises
// array (not the library exercise_id; identical exercises in different
// slots are distinct surfaces). Null exercise_idx = workout-level note.
// Empty note deletes. Upserts on (workout_id, exercise_idx, trainer_id).
router.post('/feedback', wrap((req, res) => {
  const { workout_id, exercise_idx, note } = req.body || {};
  if (!workout_id) return res.status(400).json({ error: 'workout_id required' });

  const workout = db.prepare('SELECT id, user_id, date FROM workout_log WHERE id = ?').get(workout_id);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });
  if (!ownsMember(req.user, workout.user_id)) return res.status(403).json({ error: 'Not your member' });

  const idx = exercise_idx ?? null;

  if (!note || !String(note).trim()) {
    db.prepare(
      `DELETE FROM coach_feedback
        WHERE workout_id = ? AND COALESCE(exercise_idx, -1) = COALESCE(?, -1) AND trainer_id = ?`
    ).run(workout_id, idx, req.user.id);
    return res.json({ ok: true, deleted: true });
  }

  const existing = db.prepare(
    `SELECT id FROM coach_feedback
      WHERE workout_id = ? AND COALESCE(exercise_idx, -1) = COALESCE(?, -1) AND trainer_id = ?`
  ).get(workout_id, idx, req.user.id);

  if (existing) {
    db.prepare(
      `UPDATE coach_feedback SET note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(String(note).trim(), existing.id);
  } else {
    db.prepare(
      `INSERT INTO coach_feedback (trainer_id, member_id, workout_id, exercise_idx, note)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req.user.id, workout.user_id, workout_id, idx, String(note).trim());
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
  if (!ownsMember(req.user, memberId)) return res.status(403).json({ error: 'Not your member' });
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
                  AND (cp.template_id IS NULL OR wl.template_id = cp.template_id)
              ) THEN 1
              ELSE 0
            END as completed
     FROM coach_prescriptions cp
     LEFT JOIN workout_templates wt ON wt.id = cp.template_id
     LEFT JOIN programs p ON p.id = wt.program_id
     WHERE cp.member_id = ?
     ORDER BY COALESCE(cp.date, cp.created_at) DESC`
  ).all(memberId);
  res.json(rows.map(parsePrescription));
}));

// POST /api/trainer/members/:id/prescriptions — create prescription
router.post('/members/:id/prescriptions', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!ownsMember(req.user, memberId)) return res.status(403).json({ error: 'Not your member' });
  const { date, template_id, name, exercises, notes } = req.body || {};
  if (!template_id && (!name || !Array.isArray(exercises))) {
    return res.status(400).json({ error: 'Provide either template_id or name + exercises[]' });
  }
  const result = db.prepare(
    `INSERT INTO coach_prescriptions (trainer_id, member_id, date, template_id, name, exercises, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.user.id, memberId,
    date || null,
    template_id || null,
    name || null,
    exercises ? JSON.stringify(exercises) : null,
    notes || null
  );
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(result.lastInsertRowid);
  res.json(parsePrescription(row));
}));

// GET /api/trainer/unassigned-members — members with no coach yet, so the
// trainer can pick them up directly from /coaching. Admin sees the same
// pool. Members already coached by someone else are excluded.
router.get('/unassigned-members', wrap((req, res) => {
  const rows = db.prepare(
    "SELECT * FROM users WHERE role = 'member' AND trainer_id IS NULL ORDER BY COALESCE(nickname, full_name, username)"
  ).all();
  res.json(rows.map(safeUser));
}));

// POST /api/trainer/members/:id — claim an unassigned member as a coachee.
// Trainer becomes the user's trainer_id. Idempotent if already claimed by
// this same trainer; refuses if claimed by someone else (admins can
// reassign via Settings → User Management).
router.post('/members/:id', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  const user = db.prepare("SELECT id, role, trainer_id FROM users WHERE id = ?").get(memberId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role !== 'member') return res.status(400).json({ error: 'Only members can be coached' });
  if (user.trainer_id && user.trainer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(409).json({ error: 'Member is already coached by someone else' });
  }
  db.prepare('UPDATE users SET trainer_id = ? WHERE id = ?').run(req.user.id, memberId);
  res.json({ ok: true });
}));

// PUT /api/trainer/prescriptions/:id — edit an existing prescription
// (date, notes, or which template). Useful for promoting an undated
// "anytime" prescription into a scheduled one, or shifting a date.
router.put('/prescriptions/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Prescription not found' });
  if (req.user?.role !== 'admin' && row.trainer_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your prescription' });
  }
  const body = req.body || {};
  // null vs undefined matters: undefined leaves the field alone, null
  // clears it (e.g. promote/demote the date).
  const next = {
    date:        body.date         === undefined ? row.date         : body.date,
    template_id: body.template_id  === undefined ? row.template_id  : body.template_id,
    name:        body.name         === undefined ? row.name         : body.name,
    notes:       body.notes        === undefined ? row.notes        : body.notes,
  };
  // Re-set or clear the prescription_completed activity flag if the date
  // changed — a missed-day flag that fires for the old date shouldn't
  // linger when the trainer reschedules. Cheap to just clear; the
  // scheduler will re-evaluate the new date on its next tick.
  if (next.date !== row.date) {
    db.prepare(`DELETE FROM coach_activity WHERE prescription_id = ?`).run(id);
  }
  db.prepare(
    `UPDATE coach_prescriptions SET date = ?, template_id = ?, name = ?, notes = ? WHERE id = ?`
  ).run(next.date || null, next.template_id || null, next.name || null, next.notes || null, id);
  res.json({ ok: true });
}));

// DELETE /api/trainer/members/:id — trainer releases a coachee (clears the
// user's trainer_id back to NULL). Also wipes any prescriptions and program
// assignments that came from this trainer so the now-detached member's view
// doesn't keep dangling references to a coach they no longer have.
// Trainer can only release their own members; admins can release anyone.
router.delete('/members/:id', wrap((req, res) => {
  const memberId = parseInt(req.params.id);
  if (!ownsMember(req.user, memberId)) return res.status(403).json({ error: 'Not your member' });
  const member = db.prepare('SELECT id, trainer_id FROM users WHERE id = ?').get(memberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const trainerId = member.trainer_id;
  db.transaction(() => {
    db.prepare('UPDATE users SET trainer_id = NULL WHERE id = ?').run(memberId);
    if (trainerId) {
      db.prepare('DELETE FROM coach_prescriptions WHERE trainer_id = ? AND member_id = ?').run(trainerId, memberId);
      db.prepare(`DELETE FROM program_assignments
                   WHERE assigned_to = ? AND assigned_by = ?`).run(memberId, trainerId);
    }
  })();
  res.json({ ok: true });
}));

// GET /api/trainer/activity — recent activity feed for the current trainer.
// Admins see activity across all trainers (so a single-coach admin still
// gets a useful feed). Returns up to ?limit=50 rows newest-first with the
// member's display name and the prescription's template/program/date so the
// UI doesn't need follow-up requests to render the feed.
router.get('/activity', wrap((req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const isAdmin = req.user?.role === 'admin';
  const params = isAdmin ? [limit] : [req.user.id, limit];
  const where = isAdmin ? '' : 'WHERE ca.trainer_id = ?';
  const rows = db.prepare(`
    SELECT ca.id, ca.trainer_id, ca.member_id, ca.kind, ca.prescription_id,
           ca.workout_id, ca.feedback_id, ca.occurred_at, ca.seen_at,
           u.full_name AS member_full_name, u.username AS member_username,
           u.nickname  AS member_nickname,
           cp.date AS prescription_date, cp.template_id, cp.name AS prescription_name,
           wt.name AS template_name, p.name AS program_name,
           cf.note AS feedback_note, cf.member_reply AS feedback_reply_text,
           wl.date AS workout_date
      FROM coach_activity ca
      LEFT JOIN users u ON u.id = ca.member_id
      LEFT JOIN coach_prescriptions cp ON cp.id = ca.prescription_id
      LEFT JOIN workout_templates  wt ON wt.id = cp.template_id
      LEFT JOIN programs           p  ON p.id  = wt.program_id
      LEFT JOIN coach_feedback    cf ON cf.id = ca.feedback_id
      LEFT JOIN workout_log       wl ON wl.id = ca.workout_id
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
router.delete('/prescriptions/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM coach_prescriptions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Prescription not found' });
  // Only the creating trainer or an admin can retract
  if (req.user?.role !== 'admin' && row.trainer_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your prescription' });
  }
  db.prepare('DELETE FROM coach_prescriptions WHERE id = ?').run(id);
  res.json({ ok: true });
}));

export default router;
