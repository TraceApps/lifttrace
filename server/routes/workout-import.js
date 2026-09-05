import { Router } from 'express';
import multer from 'multer';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { parseStrong }    from '../lib/workout-import/strong.js';
import { parseHevy }      from '../lib/workout-import/hevy.js';
import { parseFitnotes }  from '../lib/workout-import/fitnotes.js';
import { parseJefit }     from '../lib/workout-import/jefit.js';
import { parseGarminFit } from '../lib/workout-import/garmin-fit.js';
import { matchExercise }  from '../lib/workout-import/common.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — generous for multi-year exports
});

const SUPPORTED_SOURCES = ['strong', 'hevy', 'fitnotes', 'jefit', 'garmin-fit'];
// Sources whose payload is binary (not UTF-8 text). Route sends the
// raw Buffer to the parser instead of decoding to string.
const BINARY_SOURCES = new Set(['garmin-fit']);

function _parse(source, buf, userUnit) {
  if (source === 'strong')     return parseStrong(buf.toString('utf8'),   userUnit);
  if (source === 'hevy')       return parseHevy(buf.toString('utf8'),     userUnit);
  if (source === 'fitnotes')   return parseFitnotes(buf.toString('utf8'), userUnit);
  if (source === 'jefit')      return parseJefit(buf.toString('utf8'),    userUnit);
  if (source === 'garmin-fit') return parseGarminFit(buf,                 userUnit);
  throw new Error(`Unsupported source: ${source}`);
}

// ── POST /api/workout-import/preview ────────────────────────────────────────
// Parses the file, fuzzy-matches exercise names, and returns counts without
// writing anything. Lets the user see what they're about to import before
// committing (especially useful for multi-year files).
router.post('/preview', upload.single('file'), wrap((req, res) => {
  const { source } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!SUPPORTED_SOURCES.includes(source)) return res.status(400).json({ error: 'Unsupported source' });

  const userId = uid(req);
  const userUnit = _getUserWeightUnit(userId);

  let workouts;
  try { workouts = _parse(source, req.file.buffer, userUnit); }
  catch(e) { return res.status(400).json({ error: `Parse failed: ${e.message}` }); }

  if (workouts.length === 0) return res.status(400).json({ error: 'No workouts found in file' });

  const library = _loadLibraryForUser(userId);
  let totalSets = 0;
  const unmatchedNames = new Map(); // name -> count
  const matchedNames   = new Set();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      totalSets += (ex.sets || []).length;
      const m = matchExercise(ex.sourceName, library);
      if (m) matchedNames.add(ex.sourceName);
      else unmatchedNames.set(ex.sourceName, (unmatchedNames.get(ex.sourceName) || 0) + 1);
    }
  }

  // Count workouts that already have a matching workout_log entry —
  // scoped to (user_id, date, name), not date alone (issue #76): a date
  // can now legitimately hold more than one distinctly-named session, so
  // "duplicate" means "would replace/skip the same-named session on
  // commit" rather than "this date already has anything logged." Matches
  // commit's own dedup scope below exactly.
  const dupeCheckStmt = db.prepare('SELECT 1 FROM workout_log WHERE user_id = ? AND date = ? AND name = ? LIMIT 1');
  const duplicateCount = workouts.filter(w => dupeCheckStmt.get(userId, w.date, w.name || 'Imported')).length;

  res.json({
    workouts: workouts.length,
    sets: totalSets,
    uniqueExercises: matchedNames.size + unmatchedNames.size,
    matchedExercises: matchedNames.size,
    unmatchedExercises: [...unmatchedNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name, count]) => ({ name, count })),
    duplicateDates: duplicateCount,
    dateRange: { from: workouts[0].date, to: workouts[workouts.length - 1].date },
  });
}));

// ── POST /api/workout-import/commit ─────────────────────────────────────────
// Re-parses the file and writes every non-duplicate workout to workout_log.
// We don't trust client-side state so we parse from scratch.
router.post('/commit', upload.single('file'), wrap((req, res) => {
  const { source, onDuplicate } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!SUPPORTED_SOURCES.includes(source)) return res.status(400).json({ error: 'Unsupported source' });
  // 'skip' (safe default) or 'replace'
  const dupeMode = onDuplicate === 'replace' ? 'replace' : 'skip';

  const userId = uid(req);
  const userUnit = _getUserWeightUnit(userId);

  let workouts;
  try { workouts = _parse(source, req.file.buffer, userUnit); }
  catch(e) { return res.status(400).json({ error: `Parse failed: ${e.message}` }); }

  const library = _loadLibraryForUser(userId);
  // Dedup scoped to (user_id, date, name) — not date alone (issue #76): a
  // Strong/Hevy export with two distinctly-named same-day sessions ("AM"/
  // "PM") now imports both instead of the second one silently skipping
  // or replacing the first. A re-import of the SAME file still matches
  // and skips/replaces as before, since it produces the same names.
  const existingStmt = db.prepare('SELECT id, session_seq FROM workout_log WHERE user_id = ? AND date = ? AND name = ?');
  const deleteStmt   = db.prepare('DELETE FROM workout_log WHERE id = ?');
  const nextSeqStmt  = db.prepare('SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE user_id = ? AND date = ?');
  const insertStmt   = db.prepare(
    `INSERT INTO workout_log (user_id, date, name, notes, duration_min, exercises, completed, session_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`
  );

  let imported = 0, skipped = 0, replaced = 0;
  const tx = db.transaction(() => {
    for (const w of workouts) {
      const importName = w.name || 'Imported';
      const existing = existingStmt.get(userId, w.date, importName);
      let sessionSeq;
      if (existing) {
        if (dupeMode === 'skip') { skipped++; continue; }
        // Reuse the replaced row's own session_seq so its position among
        // any OTHER same-date sessions doesn't shuffle.
        sessionSeq = existing.session_seq;
        deleteStmt.run(existing.id);
        replaced++;
      } else {
        sessionSeq = nextSeqStmt.get(userId, w.date).n;
      }
      const exerciseRows = w.exercises.map(ex => {
        const match = matchExercise(ex.sourceName, library);
        return {
          exercise_id:   match ? match.id : null,
          exercise_name: match ? match.name : ex.sourceName,
          sets:          ex.sets,
          superset_id:   ex.superset_id,
          superset_size: ex.superset_size || 1,
        };
      });
      insertStmt.run(
        userId, w.date, importName, w.notes || null,
        w.duration_min || null, JSON.stringify(exerciseRows), sessionSeq,
      );
      imported++;
    }
  });
  try { tx(); }
  catch(e) {
    logger.error('[workout-import] commit failed:', e.message);
    return res.status(500).json({ error: `Import failed: ${e.message}` });
  }

  res.json({ imported, skipped, replaced });
}));

// ── helpers ────────────────────────────────────────────────────────────────
function _getUserWeightUnit(userId) {
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'weightUnit'").get(userId);
  if (!row) return 'lbs';
  try { return JSON.parse(row.value); } catch { return row.value || 'lbs'; }
}

function _loadLibraryForUser(userId) {
  return db.prepare(
    // Live rows only — matching an imported workout against a soft-deleted
    // exercise would immediately orphan the reference again (#49).
    `SELECT id, name FROM exercises WHERE deleted_at IS NULL AND (is_global = 1 OR created_by = ?)`
  ).all(userId);
}

export default router;
