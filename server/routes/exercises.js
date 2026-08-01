import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { SOURCES } from '../exercise-sources/index.js';

const router = Router();
router.use(requireAuth);

// GET /api/exercises — list with optional filters
router.get('/', wrap((req, res) => {
  const { category, equipment, search, limit, offset } = req.query;
  let sql = 'SELECT * FROM exercises WHERE 1=1';
  const params = [];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (equipment) { sql += " AND equipment LIKE ?"; params.push(`%${equipment}%`); }
  if (search) { sql += ' AND name LIKE ?'; params.push(`%${search}%`); }

  // Show global + user's own exercises, excluding disabled catalogs
  const userId = uid(req);
  if (userId != null) {
    sql += ' AND (is_global = 1 OR created_by = ?)';
    params.push(userId);
  }
  // Get disabled sources/catalogs for this user
  const disabledRows = userId
    ? db.prepare("SELECT key FROM user_settings WHERE user_id = ? AND key LIKE 'catalog_disabled_%' AND value = 'true'").all(userId)
    : [];
  if (disabledRows.length > 0) {
    const sourceIds = new Set(SOURCES.map(s => s.id));
    const disabledSources = disabledRows.map(r => {
      const name = r.key.replace('catalog_disabled_', '');
      // Online sources use their id directly (wger, free-db, exercisedb,
      // exercisedb-oss); anything else is a custom XLSX import using
      // 'import:<name>' for the source column.
      return sourceIds.has(name) ? name : 'import:' + name;
    });
    sql += ` AND source NOT IN (${disabledSources.map(() => '?').join(',')})`;
    params.push(...disabledSources);
  }

  sql += ' ORDER BY name ASC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
  if (offset) { sql += ' OFFSET ?'; params.push(parseInt(offset)); }

  const rows = db.prepare(sql).all(...params);
  // Parse JSON fields
  const exercises = rows.map(r => ({
    ...r,
    primary_muscles:   JSON.parse(r.primary_muscles || '[]'),
    secondary_muscles: JSON.parse(r.secondary_muscles || '[]'),
    equipment:         JSON.parse(r.equipment || '[]'),
  }));
  res.json(exercises);
}));

// GET /api/exercises/usage — per-exercise usage stats for the current user.
// Returns { [exercise_id]: { count, last_date } } where count is the number
// of distinct days the user has logged a completed set of that exercise.
// Powers the "Most used" sort + "last 3d ago" recency tag on the exercise
// list without slowing down the main list query.
router.get('/usage', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json({});
  // Scan all completed workouts once, walk the exercises JSON, accumulate
  // count + last-date per exercise id. Bounded by the user's workout log
  // size (typically a few hundred at most), fast enough to run on every
  // exercise list load without a cache.
  const rows = db.prepare(
    `SELECT date, exercises FROM workout_log
      WHERE user_id = ? AND completed = 1
      ORDER BY date DESC`
  ).all(userId);
  const out = {};
  for (const row of rows) {
    let exs;
    try { exs = JSON.parse(row.exercises || '[]'); } catch { continue; }
    const seenInDay = new Set();
    for (const ex of exs) {
      if (!ex.exercise_id) continue;
      // Only count exercises with at least one completed working set.
      const hasCompletedSet = (ex.sets || []).some(s => s.completed && !s.warmup);
      if (!hasCompletedSet) continue;
      // Distinct-day count: each exercise increments at most once per day.
      const key = `${ex.exercise_id}`;
      if (seenInDay.has(key)) continue;
      seenInDay.add(key);
      if (!out[key]) out[key] = { count: 0, last_date: row.date };
      out[key].count++;
      // Latest-date wins (rows ordered DESC, so the first hit is freshest).
      if (row.date > out[key].last_date) out[key].last_date = row.date;
    }
  }
  res.json(out);
}));

// GET /api/exercises/:id
router.get('/:id', wrap((req, res) => {
  const row = db.prepare('SELECT * FROM exercises WHERE id = ?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Exercise not found' });
  row.primary_muscles   = JSON.parse(row.primary_muscles || '[]');
  row.secondary_muscles = JSON.parse(row.secondary_muscles || '[]');
  row.equipment         = JSON.parse(row.equipment || '[]');
  res.json(row);
}));

// One of the three known load types, or null if the caller sent
// something else (unknown values become "unset" at the library level
// rather than corrupting the column).
const _LOAD_TYPES = new Set(['bilateral', 'paired', 'unilateral']);
function _cleanLoadType(v) {
  if (v == null || v === '') return null;
  return _LOAD_TYPES.has(v) ? v : null;
}

// POST /api/exercises — create custom exercise
router.post('/', wrap((req, res) => {
  const { name, category, primary_muscles, secondary_muscles, equipment, instructions, tips, img_url, gif_url, video_url, load_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = db.prepare(
    `INSERT INTO exercises (name, category, primary_muscles, secondary_muscles, equipment, instructions, tips, img_url, gif_url, video_url, load_type, source, is_global, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', 0, ?)`
  ).run(
    name, category || null,
    JSON.stringify(primary_muscles || []),
    JSON.stringify(secondary_muscles || []),
    JSON.stringify(equipment || []),
    instructions || null, tips || null,
    img_url || null, gif_url || null, video_url || null,
    _cleanLoadType(load_type),
    uid(req)
  );
  const exercise = db.prepare('SELECT * FROM exercises WHERE id = ?').get(result.lastInsertRowid);
  exercise.primary_muscles   = JSON.parse(exercise.primary_muscles || '[]');
  exercise.secondary_muscles = JSON.parse(exercise.secondary_muscles || '[]');
  exercise.equipment         = JSON.parse(exercise.equipment || '[]');
  res.json(exercise);
}));

// PUT /api/exercises/:id
router.put('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Exercise not found' });
  const { name, category, primary_muscles, secondary_muscles, equipment, instructions, tips, img_url, gif_url, video_url, load_type } = req.body;
  // load_type: an explicit null clears the library-level default (back
  // to unset), an omitted key leaves the existing value, and 'bilateral' /
  // 'paired' / 'unilateral' set it explicitly.
  const nextLoadType = load_type === undefined
    ? existing.load_type
    : (load_type === null ? null : _cleanLoadType(load_type));
  db.prepare(
    `UPDATE exercises SET name=?, category=?, primary_muscles=?, secondary_muscles=?, equipment=?,
     instructions=?, tips=?, img_url=?, gif_url=?, video_url=?, load_type=? WHERE id=?`
  ).run(
    name || existing.name, category ?? existing.category,
    JSON.stringify(primary_muscles || JSON.parse(existing.primary_muscles || '[]')),
    JSON.stringify(secondary_muscles || JSON.parse(existing.secondary_muscles || '[]')),
    JSON.stringify(equipment || JSON.parse(existing.equipment || '[]')),
    instructions ?? existing.instructions, tips ?? existing.tips,
    img_url ?? existing.img_url, gif_url ?? existing.gif_url, video_url ?? existing.video_url,
    nextLoadType,
    id
  );
  const updated = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  updated.primary_muscles   = JSON.parse(updated.primary_muscles || '[]');
  updated.secondary_muscles = JSON.parse(updated.secondary_muscles || '[]');
  updated.equipment         = JSON.parse(updated.equipment || '[]');
  res.json(updated);
}));

// DELETE /api/exercises/custom/all — bulk-delete every custom exercise the
// user created. Must be declared BEFORE the generic /:id route so Express
// doesn't route '/custom' through the id handler.
router.delete('/custom/all', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.status(401).json({ error: 'auth required' });
  const r = db.prepare(
    "DELETE FROM exercises WHERE is_global = 0 AND source = 'custom' AND created_by = ?"
  ).run(userId);
  res.json({ ok: true, removed: r.changes });
}));

// DELETE /api/exercises/:id
router.delete('/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM exercises WHERE id = ? AND is_global = 0').run(id);
  res.json({ ok: true });
}));

// ── Catalog source management ────────────────────────────────────────────────

// GET /api/exercises/sources — list every source + how many rows it has + enabled status
router.get('/sources/list', wrap(async (req, res) => {
  const { listSourceStatus } = await import('../exercise-sources/index.js');
  const sources = listSourceStatus();
  const userId = uid(req);
  // Add enabled/disabled status per source
  for (const src of sources) {
    if (src.count > 0) {
      const disabled = userId
        ? db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, `catalog_disabled_${src.id}`)
        : null;
      src.enabled = !disabled?.value || disabled.value === 'false';
    } else {
      src.enabled = true;
    }
  }
  // Sort alphabetically by name
  sources.sort((a, b) => a.name.localeCompare(b.name));
  res.json(sources);
}));

// POST /api/exercises/sources/toggle — enable/disable a source
router.post('/sources/toggle', wrap((req, res) => {
  const { source, enabled } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  const userId = uid(req);
  const key = `catalog_disabled_${source}`;
  if (userId) {
    if (enabled) {
      db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
    } else {
      db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, 'true');
    }
  }
  res.json({ ok: true });
}));

// POST /api/exercises/sources/import — import a single source
// body: { source: 'wger' | 'free-db' | 'exercisedb', apiKey?: string }
router.post('/sources/import', wrap(async (req, res) => {
  const { importSource } = await import('../exercise-sources/index.js');
  const { source, apiKey } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  try {
    const count = await importSource(source, { apiKey });
    res.json({ ok: true, count });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
}));

// POST /api/exercises/sources/clear — remove every globally-seeded row from a source
// body: { source: 'wger' }
router.post('/sources/clear', wrap(async (req, res) => {
  const { clearSource } = await import('../exercise-sources/index.js');
  const { source } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  const removed = clearSource(source);
  res.json({ ok: true, removed });
}));

// GET /api/exercises/media-urls — flat list of every gif/img/video URL in the
// library, used by the PWA to pre-cache media for offline use.
router.get('/media-urls', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT gif_url, img_url, video_url FROM exercises
     WHERE gif_url IS NOT NULL OR img_url IS NOT NULL OR video_url IS NOT NULL`
  ).all();
  const set = new Set();
  for (const r of rows) {
    if (r.gif_url)   set.add(r.gif_url);
    if (r.img_url)   set.add(r.img_url);
    if (r.video_url) set.add(r.video_url);
  }
  res.json({ urls: [...set] });
}));

// Legacy endpoint kept for back-compat with the existing Settings sync button
router.post('/sync-wger', wrap(async (req, res) => {
  const { importSource } = await import('../exercise-sources/index.js');
  const count = await importSource('wger');
  res.json({ ok: true, count });
}));

export default router;
