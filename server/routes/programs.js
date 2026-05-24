import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireTrainerOrAdmin, uid, userMgmtActive } from '../middleware/auth.js';

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
        `SELECT assigned_at FROM program_assignments
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
          WHERE wl.user_id = ? AND wl.completed = 1
            AND wl.template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
            ${sinceFilter}
      `).get(...args)?.c || 0;
    }
  }
  res.json(programs);
}));

// GET /api/programs/:id — detail with templates
router.get('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!program) return res.status(404).json({ error: 'Program not found' });
  const templates = db.prepare('SELECT * FROM workout_templates WHERE program_id = ? ORDER BY order_index ASC').all(id);
  for (const t of templates) t.exercises = JSON.parse(t.exercises || '[]');
  program.templates = templates;

  // Check if active
  const userId = uid(req);
  if (userId != null) {
    const pa = db.prepare('SELECT active FROM program_assignments WHERE program_id = ? AND assigned_to = ?').get(id, userId);
    program.is_active = pa?.active === 1;
  } else {
    const active = db.prepare("SELECT value FROM app_config WHERE key = 'active_program'").get();
    program.is_active = active && parseInt(active.value) === id;
  }
  res.json(program);
}));

// POST /api/programs
router.post('/', wrap((req, res) => {
  const { name, description, goal, visibility } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = db.prepare('INSERT INTO programs (name, description, goal, created_by, visibility) VALUES (?, ?, ?, ?, ?)')
    .run(name, description || null, goal || 'general', uid(req), visibility || 'private');
  res.json(db.prepare('SELECT * FROM programs WHERE id = ?').get(result.lastInsertRowid));
}));

// PUT /api/programs/:id
router.put('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { name, description, goal, visibility } = req.body;
  db.prepare('UPDATE programs SET name=COALESCE(?,name), description=COALESCE(?,description), goal=COALESCE(?,goal), visibility=COALESCE(?,visibility) WHERE id=?')
    .run(name || null, description, goal || null, visibility || null, id);
  res.json(db.prepare('SELECT * FROM programs WHERE id = ?').get(id));
}));

// DELETE /api/programs/:id
router.delete('/:id', wrap((req, res) => {
  db.prepare('DELETE FROM programs WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
}));

// POST /api/programs/deactivate — clear the active program for this user
router.post('/deactivate', wrap((req, res) => {
  const userId = uid(req);
  if (userId != null) {
    db.prepare('UPDATE program_assignments SET active = 0 WHERE assigned_to = ?').run(userId);
  } else {
    db.prepare("DELETE FROM app_config WHERE key = 'active_program'").run();
  }
  res.json({ ok: true });
}));

// POST /api/programs/:id/activate — set as active program
router.post('/:id/activate', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const userId = uid(req);
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
  }
  res.json({ ok: true });
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
  const stmt = db.prepare('UPDATE workout_templates SET order_index = ? WHERE id = ? AND program_id = ?');
  const programId = parseInt(req.params.id);
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id, programId));
  })();
  res.json({ ok: true });
}));


export default router;
