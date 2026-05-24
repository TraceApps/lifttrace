import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { setVolume, exerciseVolume } from '../lib/volume.js';

const router = Router();
router.use(requireAuth);

function hasCompletedSet(exercises) {
  return exercises.some(ex => (ex.sets || []).some(s => s.completed));
}

function getWorkouts(userId, start, end) {
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC').all(userId, start, end)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND date >= ? AND date <= ? ORDER BY date ASC').all(start, end);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  return rows.filter(r => hasCompletedSet(r.exercises));
}

function getAllWorkouts(userId) {
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? ORDER BY date ASC').all(userId)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL ORDER BY date ASC').all();
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  return rows.filter(r => hasCompletedSet(r.exercises));
}

// GET /api/stats/volume?start=&end=
router.get('/volume', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const byWeek = {};
  for (const row of rows) {
    const d = new Date(row.date);
    // ISO week start (Monday)
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
    if (!byWeek[weekStart]) byWeek[weekStart] = 0;
    for (const ex of row.exercises) {
      byWeek[weekStart] += exerciseVolume(ex);
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
    const d = new Date(row.date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
    byWeek[weekStart] = (byWeek[weekStart] || 0) + 1;
  }
  res.json(Object.entries(byWeek).map(([week, count]) => ({ week, count })));
}));

// GET /api/stats/records — personal records per exercise
router.get('/records', wrap((req, res) => {
  const rows = getAllWorkouts(uid(req));
  const records = {}; // exerciseId → { name, maxWeight, maxReps, date, e1rm }
  for (const row of rows) {
    for (const ex of row.exercises) {
      const id = ex.exercise_id || ex.exercise_name;
      if (!records[id]) records[id] = { name: ex.exercise_name, maxWeight: 0, date: '', e1rm: 0 };
      for (const set of ex.sets || []) {
        if (set.completed && !set.warmup && set.weight > 0) {
          const e1rm = set.reps === 1 ? set.weight : Math.round(set.weight * (1 + set.reps / 30));
          if (set.weight > records[id].maxWeight) {
            records[id].maxWeight = set.weight;
            records[id].maxReps  = set.reps;
            records[id].date     = row.date;
          }
          if (e1rm > records[id].e1rm) records[id].e1rm = e1rm;
        }
      }
    }
  }
  res.json(Object.entries(records).map(([id, r]) => ({ exerciseId: id, ...r })));
}));

// GET /api/stats/progress/:exerciseId?start=&end=
router.get('/progress/:exerciseId', wrap((req, res) => {
  const exerciseId = parseInt(req.params.exerciseId);
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const progress = [];
  for (const row of rows) {
    const ex = row.exercises.find(e => e.exercise_id === exerciseId);
    if (!ex) continue;
    const completedSets = (ex.sets || []).filter(s => s.completed && !s.warmup && s.weight > 0);
    if (!completedSets.length) continue;
    const maxWeight = Math.max(...completedSets.map(s => s.weight));
    const lt = ex.load_type || 'bilateral';
    const totalVolume = completedSets.reduce((sum, s) => sum + setVolume(s, lt), 0);
    // Average RPE across the session's working sets (when logged). Null
    // if the user hasn't opted into RPE or didn't log any values.
    const rpeValues = completedSets
      .map(s => parseFloat(s.rpe))
      .filter(n => Number.isFinite(n) && n > 0);
    const avgRpe = rpeValues.length
      ? Math.round((rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) * 10) / 10
      : null;
    progress.push({ date: row.date, maxWeight, totalVolume, sets: completedSets.length, avgRpe });
  }
  res.json(progress);
}));

// GET /api/stats/muscle-group-volume?start=&end=
//   Aggregates completed sets by primary muscle group of each exercise.
//   Returns [{ muscle: 'chest', sets: N, volume: W }, ...]
router.get('/muscle-group-volume', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  // Build exercise_id → primary muscles[] lookup once
  const exRows = db.prepare('SELECT id, primary_muscles, category FROM exercises').all();
  const exMap = {};
  for (const ex of exRows) {
    let muscles = [];
    try { muscles = JSON.parse(ex.primary_muscles || '[]'); } catch {}
    exMap[ex.id] = { muscles, category: ex.category || 'other' };
  }

  const out = {};
  for (const row of rows) {
    for (const ex of row.exercises) {
      const info = exMap[ex.exercise_id] || { muscles: [], category: 'other' };
      // Use category as fallback muscle group so every set counts somewhere
      const groups = info.muscles.length ? info.muscles : [info.category];
      const normalized = [...new Set(groups.map(g => _normalizeMuscle(g)))];
      const lt = ex.load_type || 'bilateral';
      for (const set of ex.sets || []) {
        if (!set.completed || set.warmup || set.weight <= 0) continue;
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

function _normalizeMuscle(m) {
  const s = (m || '').toLowerCase().trim();
  // Normalize variants
  if (s.includes('chest') || s.includes('pec')) return 'chest';
  if (s.includes('back') || s.includes('lat') || s.includes('trap') || s.includes('rhomboid')) return 'back';
  if (s.includes('shoulder') || s.includes('delt')) return 'shoulders';
  if (s.includes('bicep')) return 'biceps';
  if (s.includes('tricep')) return 'triceps';
  if (s.includes('forearm')) return 'forearms';
  if (s.includes('ab') || s.includes('core') || s.includes('oblique')) return 'core';
  if (s.includes('quad')) return 'quads';
  if (s.includes('hamstring')) return 'hamstrings';
  if (s.includes('glute')) return 'glutes';
  if (s.includes('calf') || s.includes('calve')) return 'calves';
  if (s.includes('leg')) return 'legs';
  if (s.includes('arm')) return 'arms';
  if (s.includes('cardio')) return 'cardio';
  return s || 'other';
}

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
    ? db.prepare('SELECT MIN(date) as date FROM workout_log WHERE user_id = ?').get(userId)
    : db.prepare('SELECT MIN(date) as date FROM workout_log').get();
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

  res.json({ currentStreak, longestStreak, totalWorkouts: dates.size });
}));

export default router;
