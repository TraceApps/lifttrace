import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { setVolume, exerciseVolume, isTimedSet, newRecord, accumulateRecord } from '../lib/volume.js';
import { normalizeMuscle as _normalizeMuscle } from '../lib/muscle-groups.js';
import { musclesOf } from '../lib/muscle-load.js';
import { muscleOverrideMap } from '../lib/exercise-muscle-overrides.js';

const router = Router();
router.use(requireAuth);

function hasCompletedSet(exercises) {
  return exercises.some(ex => (ex.sets || []).some(s => s.completed));
}

function getWorkouts(userId, start, end) {
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date ASC').all(userId, start, end)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date ASC').all(start, end);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  return rows.filter(r => hasCompletedSet(r.exercises));
}

function getAllWorkouts(userId) {
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date ASC').all(userId)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND deleted_at IS NULL ORDER BY date ASC').all();
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  return rows.filter(r => hasCompletedSet(r.exercises));
}

// Library-level load_type lookup for volume calculators. Kept as a
// {exercise_id → load_type} map so stat handlers can resolve per exercise
// without an N+1 database hit inside the loop. NULL library values mean
// "unset" — the resolver falls through to 'bilateral' server-side (client
// still applies its per-user pref before rendering). See issue #24.
function loadLibraryLoadTypes() {
  const rows = db.prepare('SELECT id, load_type FROM exercises WHERE load_type IS NOT NULL').all();
  const map = new Map();
  for (const r of rows) map.set(r.id, r.load_type);
  return map;
}

// Monday of a workout's week. Workout dates are calendar days, so the maths
// runs in UTC on the bare date: parsing them in the server's local time moved
// every week to a Tuesday and shifted workouts into the wrong week on any
// server whose TZ is west of UTC (issue #101). api-native's Stats does the same.
function _weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

// GET /api/stats/volume?start=&end=
router.get('/volume', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const libMap = loadLibraryLoadTypes();
  const byWeek = {};
  for (const row of rows) {
    const weekStart = _weekStart(row.date);
    if (!byWeek[weekStart]) byWeek[weekStart] = 0;
    for (const ex of row.exercises) {
      byWeek[weekStart] += exerciseVolume(ex, libMap.get(ex.exercise_id));
    }
  }
  res.json(Object.entries(byWeek).map(([week, volume]) => ({ week, volume })));
}));

// GET /api/stats/frequency?start=&end=
router.get('/frequency', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const byWeek = {};
  for (const row of rows) {
    const weekStart = _weekStart(row.date);
    byWeek[weekStart] = (byWeek[weekStart] || 0) + 1;
  }
  res.json(Object.entries(byWeek).map(([week, count]) => ({ week, count })));
}));

// GET /api/stats/records — personal records per exercise
router.get('/records', wrap((req, res) => {
  const rows = getAllWorkouts(uid(req));
  const records = {}; // exerciseId → newRecord() shape, see lib/volume.js
  for (const row of rows) {
    for (const ex of row.exercises) {
      const id = ex.exercise_id || ex.exercise_name;
      if (!records[id]) records[id] = newRecord(ex.exercise_name);
      for (const set of ex.sets || []) accumulateRecord(records[id], ex, set, row.date);
    }
  }
  res.json(Object.entries(records).map(([id, r]) => ({ exerciseId: id, ...r })));
}));

// GET /api/stats/progress/:exerciseId?start=&end=
router.get('/progress/:exerciseId', wrap((req, res) => {
  const exerciseId = parseInt(req.params.exerciseId);
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const libRow = db.prepare('SELECT load_type FROM exercises WHERE id = ?').get(exerciseId);
  const libLoadType = libRow?.load_type || null;
  const progress = [];
  for (const row of rows) {
    const ex = row.exercises.find(e => e.exercise_id === exerciseId);
    if (!ex) continue;
    const working = (ex.sets || []).filter(s => s.completed && !s.warmup);
    // Timed sets (issue #89) chart by longest hold and count whatever the
    // load, since most holds are bodyweight. Rep sets keep the existing
    // rule of needing real weight.
    const timedSets = working.filter(s => isTimedSet(ex, s) && Number(s.duration_sec) > 0);
    const repSets = working.filter(s => !isTimedSet(ex, s) && s.weight > 0);
    const completedSets = [...repSets, ...timedSets];
    if (!completedSets.length) continue;
    const maxWeight = repSets.length ? Math.max(...repSets.map(s => s.weight)) : 0;
    const maxDuration = timedSets.length ? Math.max(...timedSets.map(s => Number(s.duration_sec))) : 0;
    const lt = ex.load_type || libLoadType || 'bilateral';
    const totalVolume = repSets.reduce((sum, s) => sum + setVolume(s, lt), 0);
    // Average RPE across the session's working sets (when logged). Null
    // if the user hasn't opted into RPE or didn't log any values.
    const rpeValues = completedSets
      .map(s => parseFloat(s.rpe))
      .filter(n => Number.isFinite(n) && n > 0);
    const avgRpe = rpeValues.length
      ? Math.round((rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) * 10) / 10
      : null;
    // workout_id lets a chart distinguish two same-date points once a
    // date can have multiple sessions (issue #76) — additive, existing
    // chart code that only reads `date` is unaffected.
    progress.push({ date: row.date, workout_id: row.id, maxWeight, maxDuration, totalVolume, sets: completedSets.length, avgRpe });
  }
  res.json(progress);
}));

// GET /api/stats/muscle-group-volume?start=&end=
//   Aggregates completed sets by primary muscle group of each exercise.
//   Returns [{ muscle: 'chest', sets: N, volume: W }, ...]
router.get('/muscle-group-volume', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  // Build exercise_id → primary muscles[] lookup once. Includes soft-
  // deleted rows on purpose (#49): sets logged against an exercise the
  // user later cleared from their library still need their muscle group
  // to resolve, otherwise every affected set would fall through to the
  // 'other' bucket and skew Muscle Balance. Cleared rows still hold
  // their `primary_muscles` / `category` — soft delete only hides them
  // from the picker, not from stats resolvers.
  const exRows = db.prepare('SELECT id, primary_muscles, category, load_type FROM exercises').all();
  const exMap = {};
  for (const ex of exRows) {
    let muscles = [];
    try { muscles = JSON.parse(ex.primary_muscles || '[]'); } catch {}
    exMap[ex.id] = { muscles, category: ex.category || 'other', load_type: ex.load_type || null };
  }

  const out = {};
  for (const row of rows) {
    for (const ex of row.exercises) {
      const info = exMap[ex.exercise_id] || { muscles: [], category: 'other', load_type: null };
      // Use category as fallback muscle group so every set counts somewhere
      const groups = info.muscles.length ? info.muscles : [info.category];
      const normalized = [...new Set(groups.map(g => _normalizeMuscle(g)))];
      const lt = ex.load_type || info.load_type || 'bilateral';
      for (const set of ex.sets || []) {
        if (!set.completed || set.warmup || set.weight <= 0) continue;
        if (isTimedSet(ex, set)) continue;   // issue #89: a hold has no volume
        const w = setVolume(set, lt);
        if (w <= 0) continue;
        for (const g of normalized) {
          if (!out[g]) out[g] = { muscle: g, sets: 0, volume: 0 };
          out[g].sets++;
          out[g].volume += w;
        }
      }
    }
  }
  // Sort by volume descending
  res.json(Object.values(out).sort((a, b) => b.volume - a.volume));
}));


// GET /api/stats/muscle-effective-sets?start=&end=
//   Effective sets per muscle in the 18-slug body-map vocabulary. Primary
//   muscles count 1.0 per completed working set; secondary muscles count 0.4.
//   Volume in kg is deliberately NOT used — 100 kg of leg press vs 12 kg of
//   lateral raise says nothing about which muscle worked harder. Answer is
//   "which muscles am I actually loading", not "which muscles are moving
//   the heaviest bars".
//   Returns { [slug]: effectiveSets } for the 18 drawable muscles.
router.get('/muscle-effective-sets', wrap((req, res) => {
  const { start, end } = req.query;
  const userId = uid(req);
  const rows = getWorkouts(userId, start, end);
  const overrides = muscleOverrideMap(userId);
  const exRows = db.prepare('SELECT id, primary_muscles, secondary_muscles, category FROM exercises').all();
  const exMap = {};
  for (const ex of exRows) {
    let primary = [], secondary = [];
    try { primary = JSON.parse(ex.primary_muscles || '[]'); } catch {}
    try { secondary = JSON.parse(ex.secondary_muscles || '[]'); } catch {}
    exMap[ex.id] = { primary, secondary, category: (ex.category || '').toLowerCase() };
  }

  const load = {};
  for (const row of rows) {
    for (const ex of row.exercises) {
      const info = exMap[ex.exercise_id] || { primary: [], secondary: [], category: '' };
      const setCount = (ex.sets || []).filter(s => s.completed && !s.warmup).length;
      if (!setCount) continue;
      const loads = ex.muscle_load ?? overrides.get(Number(ex.exercise_id)) ?? null;
      const perMuscle = musclesOf({ ...info, loads });
      for (const slug in perMuscle) {
        load[slug] = (load[slug] || 0) + perMuscle[slug] * setCount;
      }
    }
  }
  res.json(load);
}));

// GET /api/stats/weekday-distribution?start=&end=
//   Returns workout counts per day of week: [{ day: 0-6, count: N }]
//   0=Sunday, 6=Saturday
router.get('/weekday-distribution', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const counts = Array.from({ length: 7 }, (_, i) => ({ day: i, count: 0 }));
  for (const row of rows) {
    const d = new Date(row.date + 'T12:00:00');
    counts[d.getDay()].count++;
  }
  res.json(counts);
}));

// GET /api/stats/earliest-workout-date — used by Statistics "All" range to
// resolve a true start-of-data date (the previous 3650-day ceiling silently
// chopped older imported history).
router.get('/earliest-workout-date', wrap((req, res) => {
  const userId = uid(req);
  const row = userId != null
    ? db.prepare('SELECT MIN(date) as date FROM workout_log WHERE user_id = ? AND deleted_at IS NULL').get(userId)
    : db.prepare('SELECT MIN(date) as date FROM workout_log WHERE deleted_at IS NULL').get();
  res.json({ date: row?.date || null });
}));

// GET /api/stats/streaks
router.get('/streaks', wrap((req, res) => {
  const rows = getAllWorkouts(uid(req));
  const dates = new Set(rows.map(r => r.date));
  const sortedDates = [...dates].sort();

  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;

  // Check from today backward for current streak
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    if (dates.has(dateStr)) {
      currentStreak++;
    } else if (i > 0) {
      break;
    }
  }

  // Longest streak
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) { tempStreak = 1; continue; }
    const prev = new Date(sortedDates[i - 1]);
    const curr = new Date(sortedDates[i]);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      tempStreak++;
    } else {
      longestStreak = Math.max(longestStreak, tempStreak);
      tempStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, tempStreak);

  // totalWorkouts stays "distinct days with a completed workout" (a day
  // counts as done if ANY session that day is completed — the right call
  // once a date can have multiple sessions, issue #76, so a still-open
  // daily-stretch session doesn't cost the lifting streak). totalSessions
  // is the true per-session count, additive so existing consumers of
  // totalWorkouts see no change in meaning.
  res.json({ currentStreak, longestStreak, totalWorkouts: dates.size, totalSessions: rows.length });
}));

export default router;
