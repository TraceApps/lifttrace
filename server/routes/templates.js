import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { mergeExercises, ensureExerciseUuids } from '../lib/workout-merge.js';

const router = Router();
router.use(requireAuth);

// GET /api/templates/:id
router.get('/:id', wrap((req, res) => {
  // Join the parent program's duration_weeks so the editor knows how many
  // week tabs to render for the per-week progression matrix (issue #13)
  // without a second round-trip.
  const t = db.prepare(
    `SELECT wt.*, p.duration_weeks
       FROM workout_templates wt
       JOIN programs p ON p.id = wt.program_id
      WHERE wt.id = ?`
  ).get(parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Template not found' });
  t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// POST /api/templates
router.post('/', wrap((req, res) => {
  const { program_id, name, day_label, exercises } = req.body;
  if (!program_id || !name) return res.status(400).json({ error: 'program_id and name required' });
  const maxIdx = db.prepare('SELECT MAX(order_index) as m FROM workout_templates WHERE program_id = ?').get(program_id);
  const orderIndex = (maxIdx?.m ?? -1) + 1;
  const result = db.prepare(
    'INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises) VALUES (?, ?, ?, ?, ?)'
  ).run(program_id, name, day_label || null, orderIndex, JSON.stringify(exercises || []));
  const t = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(result.lastInsertRowid);
  t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// PUT /api/templates/:id
//
// Merge semantics for the exercises array (Option C port, 2026-08-11).
// The tombstone key uses `date = 'template:<id>'` so a template's
// per-item tombstones share the workout_tombstones table with workout
// day tombstones without collision. Callers pass deleted_uuids in the
// same shape as the workout PUT: { exercises: [uuid...], sets: {
// [exUuid]: [setUuid...] } }.
router.put('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { name, day_label, exercises } = req.body;
  const deletedRaw = req.body.deleted_uuids;
  const deletedExUuids = Array.isArray(deletedRaw?.exercises) ? deletedRaw.exercises
    : Array.isArray(deletedRaw) ? deletedRaw
    : [];
  const deletedSetsByEx = (deletedRaw && typeof deletedRaw.sets === 'object' && !Array.isArray(deletedRaw.sets))
    ? deletedRaw.sets
    : {};

  const existing = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: `Template ${id} not found` });

  const tsKey = `template:${id}`;
  const priorExTs = db.prepare(
    `SELECT uuid FROM workout_tombstones WHERE user_id IS NULL AND date = ? AND kind = 'template_exercise'`
  ).all(tsKey).map(r => r.uuid);
  const priorSetTsRows = db.prepare(
    `SELECT ex_uuid, uuid FROM workout_tombstones WHERE user_id IS NULL AND date = ? AND kind = 'template_set'`
  ).all(tsKey);
  const priorSetTsByEx = {};
  for (const r of priorSetTsRows) (priorSetTsByEx[r.ex_uuid] = priorSetTsByEx[r.ex_uuid] || []).push(r.uuid);

  let mergedExercisesJson = null;
  let newExTombstones = [];
  let newSetTombstonesByEx = {};
  if (Array.isArray(exercises)) {
    const serverExs = JSON.parse(existing.exercises || '[]');
    const r = mergeExercises(
      serverExs, ensureExerciseUuids(exercises),
      deletedExUuids, priorExTs,
      deletedSetsByEx, priorSetTsByEx
    );
    mergedExercisesJson = JSON.stringify(r.merged);
    newExTombstones = r.newTombstoneExerciseUuids;
    newSetTombstonesByEx = r.newTombstoneSetUuidsByExercise;
  }

  const insertTombstone = db.prepare(
    `INSERT OR IGNORE INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at)
     VALUES (NULL, ?, ?, ?, ?, datetime('now'))`
  );
  db.transaction(() => {
    db.prepare('UPDATE workout_templates SET name=COALESCE(?,name), day_label=COALESCE(?,day_label), exercises=COALESCE(?,exercises) WHERE id=?')
      .run(name || null, day_label, mergedExercisesJson, id);
    for (const uuid of newExTombstones) insertTombstone.run(tsKey, 'template_exercise', '', uuid);
    for (const [exUuid, uuids] of Object.entries(newSetTombstonesByEx)) {
      for (const uuid of uuids) insertTombstone.run(tsKey, 'template_set', exUuid, uuid);
    }
  })();

  const t = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(id);
  if (t) t.exercises = JSON.parse(t.exercises || '[]');
  res.json(t);
}));

// DELETE /api/templates/:id
router.delete('/:id', wrap((req, res) => {
  db.prepare('DELETE FROM workout_templates WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
}));

export default router;
