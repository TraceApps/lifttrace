import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireTrainerOrAdmin, uid, userMgmtActive } from '../middleware/auth.js';
import { currentPlanWeek } from '../lib/programWeek.js';
import { programFor } from '../lib/program-access.js';
import { answerGone, createdBefore, rememberCreated } from '../lib/create-keys.js';
import { applyToBody, deleteLoses, refuseDelete, createdTimes } from '../lib/newer-wins.js';

// 404 for a program this account can't see (no hint that it exists), 403
// for one it can see but not change (program-access.js). Returns true when
// the response was sent.
function refuse(res, access, needChange) {
  if (!access.canSee) { res.status(404).json({ error: 'Program not found' }); return true; }
  if (needChange && !access.canChange) { res.status(403).json({ error: 'Forbidden' }); return true; }
  return false;
}

const router = Router();
router.use(requireAuth);

// GET /api/programs — list the user's own programs + any assignments (active
// or inactive). Inactive assignments still belong in the library because a
// coach may assign a program without making it active (the "available in
// your library, switch to it when you're ready" case); the coachee toggles
// active via Set Active on the program detail. visibility='shared' is
// excluded — the seeded starter templates use that flag, but every user
// seeing every shared program made the library leak between accounts
// (renaming one shared program changed the name for everyone). Shared
// seeds will live behind a future Templates/Discover tab.
router.get('/', wrap((req, res) => {
  const userId = uid(req);
  let programs;
  if (userId != null) {
    programs = db.prepare(
      `SELECT p.*,
              CASE WHEN pa.active = 1 THEN 1 ELSE 0 END as is_active,
              CASE WHEN pa.id IS NOT NULL AND p.created_by != ? THEN 1 ELSE 0 END as is_assigned,
              COALESCE(assigner.nickname, assigner.full_name, assigner.username) as assigned_by_name
       FROM programs p
       LEFT JOIN program_assignments pa ON pa.program_id = p.id AND pa.assigned_to = ?
       LEFT JOIN users assigner ON assigner.id = pa.assigned_by
       WHERE p.created_by = ? OR pa.id IS NOT NULL
       ORDER BY p.created_at DESC`
    ).all(userId, userId, userId);
  } else {
    programs = db.prepare('SELECT *, 0 as is_active FROM programs ORDER BY created_at DESC').all();
    // Check single-user active
    const active = db.prepare("SELECT value FROM app_config WHERE key = 'active_program'").get();
    if (active) {
      const activeId = parseInt(active.value);
      programs = programs.map(p => ({ ...p, is_active: p.id === activeId ? 1 : 0 }));
    }
  }

  // Attach template count + first 3 template names (for inline preview on
  // the program card). For active programs, also include weeks-since +
  // session count so the active program can show "Week 3 · 12 sessions".
  for (const p of programs) {
    const tpls = db.prepare(
      'SELECT name FROM workout_templates WHERE program_id = ? ORDER BY order_index ASC LIMIT 10'
    ).all(p.id);
    p.template_count = tpls.length;
    p.template_names = tpls.slice(0, 3).map(t => t.name);

    if (p.is_active && userId != null) {
      const assigned = db.prepare(
        `SELECT assigned_at, start_date, week_cursor, week_cursor_session_base, week_cursor_pinned_at
           FROM program_assignments
          WHERE program_id = ? AND assigned_to = ? AND active = 1`
      ).get(p.id, userId);
      if (assigned?.assigned_at) {
        const since = new Date(assigned.assigned_at).getTime();
        const days = Math.max(0, Math.floor((Date.now() - since) / 86400000));
        p.weeks_active = Math.floor(days / 7) + 1;
        p.days_active  = days;
      }
      // Count completed workouts that used this program's templates since
      // assignment. Cheap subquery; the joined template_id lets us
      // attribute a workout to its program without storing program_id on
      // workout_log directly.
      const sinceFilter = assigned?.assigned_at ? "AND date >= date(?)" : "";
      const args = [userId, p.id];
      if (assigned?.assigned_at) args.push(assigned.assigned_at);
      p.sessions_in_program = db.prepare(`
        SELECT COUNT(*) as c FROM workout_log wl
          WHERE wl.user_id = ? AND wl.completed = 1 AND wl.deleted_at IS NULL
            AND wl.template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
            ${sinceFilter}
      `).get(...args)?.c || 0;
      // Multi-week progression: resolve which plan week the athlete is on.
      p.current_week = currentPlanWeek(p, assigned, {
        sessionsInProgram: p.sessions_in_program,
        sessionsPerWeek: p.template_count,
      });
    } else if (p.is_active && userId == null) {
      // Single-user mode has no program_assignments row — the active flag and
      // the manual week cursor both live in app_config. Resolve current_week
      // here too so the list card matches the detail view + Load-Workout sheet.
      const cursor = readSoloCursor();
      p.sessions_in_program = sessionsInProgram(null, p.id, null);
      p.current_week = currentPlanWeek(p, cursor, {
        sessionsInProgram: p.sessions_in_program,
        sessionsPerWeek: p.template_count,
      });
    }
  }
  res.json(programs);
}));

// GET /api/programs/:id — detail with templates
router.get('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!program || refuse(res, programFor(id, uid(req)), false)) {
    if (!res.headersSent) res.status(404).json({ error: 'Program not found' });
    return;
  }
  const templates = db.prepare('SELECT * FROM workout_templates WHERE program_id = ? ORDER BY order_index ASC').all(id);
  for (const t of templates) t.exercises = JSON.parse(t.exercises || '[]');
  program.templates = templates;

  // Check if active + resolve the current plan week for the caller.
  const userId = uid(req);
  let assignment = null;
  if (userId != null) {
    assignment = db.prepare(
      `SELECT active, assigned_at, start_date, week_cursor, week_cursor_session_base, week_cursor_pinned_at
         FROM program_assignments WHERE program_id = ? AND assigned_to = ?`
    ).get(id, userId);
    program.is_active = assignment?.active === 1;
  } else {
    const active = db.prepare("SELECT value FROM app_config WHERE key = 'active_program'").get();
    program.is_active = active && parseInt(active.value) === id;
    if (program.is_active) assignment = readSoloCursor();
  }

  if (program.is_active) {
    const sessions = sessionsInProgram(userId, id, assignment?.assigned_at);
    program.sessions_in_program = sessions;
    program.current_week = currentPlanWeek(program, assignment, {
      sessionsInProgram: sessions,
      sessionsPerWeek: templates.length,
    });
  }
  res.json(program);
}));

// Completed program-attributed sessions since assignment. userId null =
// single-user mode (no user_id filter needed).
function sessionsInProgram(userId, programId, assignedAt) {
  const sinceFilter = assignedAt ? "AND date >= date(?)" : "";
  const userFilter = userId != null ? "wl.user_id = ? AND" : "";
  const args = [];
  if (userId != null) args.push(userId);
  args.push(programId);
  if (assignedAt) args.push(assignedAt);
  return db.prepare(`
    SELECT COUNT(*) as c FROM workout_log wl
      WHERE ${userFilter} wl.completed = 1 AND wl.deleted_at IS NULL
        AND wl.template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
        ${sinceFilter}
  `).get(...args)?.c || 0;
}

// Single-user (no-auth) mode has no program_assignments row, so the manual
// week cursor lives in app_config as JSON alongside the active_program key.
function readSoloCursor() {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'active_program_cursor'").get();
  if (!row?.value) return {};
  try {
    const { week, base, pinnedAt } = JSON.parse(row.value);
    return {
      week_cursor: week ?? null,
      week_cursor_session_base: base ?? 0,
      week_cursor_pinned_at: pinnedAt ?? null,
    };
  } catch { return {}; }
}

// POST /api/programs
router.post('/', wrap((req, res) => {
  const { name, description, goal, visibility, duration_weeks, advance_mode, on_complete } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  // Sent again after its answer was lost: the program it made (create-keys.js).
  const before = createdBefore(req, uid(req), 'programs');
  if (before?.gone) return answerGone(res);
  if (before) return res.json(before);
  const result = db.prepare(
    `INSERT INTO programs (name, description, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, field_times)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, description || null, goal || 'general', uid(req), visibility || 'private',
    clampDuration(duration_weeks), advanceMode(advance_mode), onComplete(on_complete), createdTimes(req)
  );
  rememberCreated(req, uid(req), 'programs', result.lastInsertRowid);
  res.json(db.prepare('SELECT * FROM programs WHERE id = ?').get(result.lastInsertRowid));
}));

// PUT /api/programs/:id
router.put('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (refuse(res, programFor(id, uid(req)), true)) return;
  // The newer edit of each field stays (lib/newer-wins.js); the length and
  // how a plan moves on go together.
  const existingRow = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  const body = { ...req.body };
  const times = applyToBody(req, existingRow, body, {
    fields: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete'],
    groups: [['duration_weeks', 'advance_mode', 'on_complete']],
    current: f => existingRow[f],
  });
  const { name, description, goal, visibility, duration_weeks, advance_mode, on_complete } = body;
  db.prepare(
    `UPDATE programs SET name=COALESCE(?,name), description=COALESCE(?,description),
            goal=COALESCE(?,goal), visibility=COALESCE(?,visibility),
            duration_weeks=COALESCE(?,duration_weeks), advance_mode=COALESCE(?,advance_mode),
            on_complete=COALESCE(?,on_complete), field_times=? WHERE id=?`
  ).run(
    name || null, description, goal || null, visibility || null,
    duration_weeks != null ? clampDuration(duration_weeks) : null,
    advance_mode != null ? advanceMode(advance_mode) : null,
    on_complete != null ? onComplete(on_complete) : null,
    times,
    id
  );
  res.json(db.prepare('SELECT * FROM programs WHERE id = ?').get(id));
}));

// Sanitise the progression fields so bad input can't corrupt week resolution.
function clampDuration(v) {
  const n = parseInt(v);
  return Number.isFinite(n) ? Math.min(52, Math.max(1, n)) : 1;
}
function advanceMode(v) { return v === 'calendar' ? 'calendar' : 'sessions'; }
function onComplete(v) { return v === 'repeat' ? 'repeat' : 'hold'; }

// DELETE /api/programs/:id
router.delete('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (refuse(res, programFor(id, uid(req)), true)) return;
  // Deleted offline before an edit made elsewhere: the edit is newer, the
  // program stays (lib/newer-wins.js).
  const row = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  // Already deleted: done.
  if (!row || row.deleted_at) return res.json({ ok: true });
  // Its workouts go with it, so an edit made to one of them after the
  // delete counts too: the delete loses as a whole and all of it stays.
  // Only their own edit stamps count (newer-wins.js); one already deleted
  // doesn't.
  const days = db.prepare('SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL').all(id);
  const later = [row, ...days].map(r => deleteLoses(req, r)).filter(Boolean).sort().pop();
  if (later) return refuseDelete(res, row, later);
  db.prepare('DELETE FROM programs WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// POST /api/programs/deactivate — clear the active program for this user
router.post('/deactivate', wrap((req, res) => {
  const userId = uid(req);
  if (userId != null) {
    db.prepare('UPDATE program_assignments SET active = 0 WHERE assigned_to = ?').run(userId);
  } else {
    db.prepare("DELETE FROM app_config WHERE key = 'active_program'").run();
    db.prepare("DELETE FROM app_config WHERE key = 'active_program_cursor'").run();
  }
  res.json({ ok: true });
}));

// POST /api/programs/:id/activate — set as active program
router.post('/:id/activate', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const userId = uid(req);
  // Following a program means seeing it; activating someone else's
  // private one would also have handed this account a copy.
  if (refuse(res, programFor(id, userId), false)) return;
  if (userId != null) {
    // Deactivate all, then activate this one
    db.prepare('UPDATE program_assignments SET active = 0 WHERE assigned_to = ?').run(userId);
    const existing = db.prepare('SELECT id FROM program_assignments WHERE program_id = ? AND assigned_to = ?').get(id, userId);
    if (existing) {
      db.prepare('UPDATE program_assignments SET active = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare('INSERT INTO program_assignments (program_id, assigned_to, assigned_by, active) VALUES (?, ?, ?, 1)')
        .run(id, userId, userId);
    }
  } else {
    db.prepare("INSERT INTO app_config (key, value) VALUES ('active_program', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(id));
    // Switching the solo active program invalidates any pinned week cursor.
    db.prepare("DELETE FROM app_config WHERE key = 'active_program_cursor'").run();
  }
  res.json({ ok: true });
}));

// POST /api/programs/:id/week-cursor — manually pin the current plan week so
// the athlete can repeat or regress a week. { week: null } clears the pin and
// returns to auto-advance. Captures the current session count as the baseline
// so auto-advance resumes relative to the pin (see lib/programWeek.js).
router.post('/:id/week-cursor', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const userId = uid(req);
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!program || refuse(res, programFor(id, userId), false)) {
    if (!res.headersSent) res.status(404).json({ error: 'Program not found' });
    return;
  }

  let week = req.body?.week;
  if (week != null) {
    week = parseInt(week);
    if (!Number.isFinite(week)) return res.status(400).json({ error: 'week must be a number or null' });
    week = Math.min(Math.max(1, program.duration_weeks || 1), Math.max(1, week));
  }

  if (userId != null) {
    const assigned = db.prepare(
      'SELECT assigned_at FROM program_assignments WHERE program_id = ? AND assigned_to = ? AND active = 1'
    ).get(id, userId);
    if (!assigned) return res.status(400).json({ error: 'Program is not active for this user' });
    const base = week != null ? sessionsInProgram(userId, id, assigned.assigned_at) : null;
    const pinnedAt = week != null ? new Date().toISOString() : null;
    db.prepare(
      `UPDATE program_assignments SET week_cursor = ?, week_cursor_session_base = ?, week_cursor_pinned_at = ?
        WHERE program_id = ? AND assigned_to = ?`
    ).run(week ?? null, base, pinnedAt, id, userId);
  } else {
    if (week == null) {
      db.prepare("DELETE FROM app_config WHERE key = 'active_program_cursor'").run();
    } else {
      const base = sessionsInProgram(null, id, null);
      db.prepare(
        "INSERT INTO app_config (key, value) VALUES ('active_program_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify({ week, base, pinnedAt: new Date().toISOString() }));
    }
  }
  res.json({ ok: true, week: week ?? null });
}));

// POST /api/programs/:id/assign — trainer/admin assigns program to user.
// Single-active-program model: deactivate any other assignments for this
// member first, then activate (or insert) the requested one. Without this,
// every assign just appended another active row and the member's overview
// listed all of them as "Active" — making it look like one assign affected
// every program.
router.post('/:id/assign', requireTrainerOrAdmin, wrap((req, res) => {
  const programId = parseInt(req.params.id);
  const { user_id, start_date, make_active } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  // A coach hands out a program they can see (their own, or a starter),
  // not another account's private one. One the athlete already has (one
  // they started themselves, say) can be switched on for them too: the
  // coach's member overview offers Make Active for every one of them.
  const alreadyTheirs = db.prepare('SELECT 1 FROM program_assignments WHERE program_id = ? AND assigned_to = ?').get(programId, parseInt(user_id));
  if (!alreadyTheirs && refuse(res, programFor(programId, uid(req)), false)) return;
  // make_active defaults to true (assignment usually means "follow this");
  // pass make_active: false to add the program to the member's library
  // without disrupting whatever they're currently following.
  const active = make_active === false ? 0 : 1;
  // Trainers can only assign to their own members; admins can assign to anyone
  if (userMgmtActive() && req.user?.role === 'trainer') {
    const target = db.prepare('SELECT trainer_id FROM users WHERE id = ?').get(user_id);
    if (!target || target.trainer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your member' });
    }
  }
  db.transaction(() => {
    // Only deactivate other assignments when this one is becoming active —
    // adding a program to the library without activating shouldn't yank
    // whatever's currently being followed.
    if (active === 1) {
      db.prepare(
        `UPDATE program_assignments SET active = 0 WHERE assigned_to = ? AND program_id <> ?`
      ).run(user_id, programId);
    }
    db.prepare(
      `INSERT INTO program_assignments (program_id, assigned_to, assigned_by, start_date, active)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(program_id, assigned_to) DO UPDATE SET active = excluded.active, start_date = excluded.start_date`
    ).run(programId, user_id, req.user?.id || null, start_date || null, active);
  })();
  res.json({ ok: true });
}));

// DELETE /api/programs/:id/assign/:userId — trainer/admin removes the
// program assignment from a member entirely (vs. just deactivating it).
// Used by the member overview's "remove program" action.
router.delete('/:id/assign/:userId', requireTrainerOrAdmin, wrap((req, res) => {
  const programId = parseInt(req.params.id);
  const memberId  = parseInt(req.params.userId);
  if (userMgmtActive() && req.user?.role === 'trainer') {
    const target = db.prepare('SELECT trainer_id FROM users WHERE id = ?').get(memberId);
    if (!target || target.trainer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your member' });
    }
  }
  db.prepare(
    `DELETE FROM program_assignments WHERE program_id = ? AND assigned_to = ?`
  ).run(programId, memberId);
  res.json({ ok: true });
}));

// PUT /api/programs/:id/reorder — reorder templates
router.put('/:id/reorder', wrap((req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  if (refuse(res, programFor(parseInt(req.params.id), uid(req)), true)) return;
  const stmt = db.prepare('UPDATE workout_templates SET order_index = ? WHERE id = ? AND program_id = ?');
  const programId = parseInt(req.params.id);
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id, programId));
  })();
  res.json({ ok: true });
}));


export default router;
