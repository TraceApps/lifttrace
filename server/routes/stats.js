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

// GET /api/stats/volume?start=&end=
router.get('/volume', wrap((req, res) => {
  const { start, end } = req.query;
  const rows = getWorkouts(uid(req), start, end);
  const libMap = loadLibraryLoadTypes();
  const byWeek = {};
  for (const row of rows) {
    const d = new Date(row.date);
    // ISO week start (Monday)
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
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
  const libRow = db.prepare('SELECT load_type FROM exercises WHERE id = ?').get(exerciseId);
  const libLoadType = libRow?.load_type || null;
  const progress = [];
  for (const row of rows) {
    const ex = row.exercises.find(e => e.exercise_id === exerciseId);
    if (!ex) continue;
    const completedSets = (ex.sets || []).filter(s => s.completed && !s.warmup && s.weight > 0);
    if (!completedSets.length) continue;
    const maxWeight = Math.max(...completedSets.map(s => s.weight));
    const lt = ex.load_type || libLoadType || 'bilateral';
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
  const rows = getWorkouts(uid(req), start, end);
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
      const perMuscle = musclesOf(info);
      for (const slug in perMuscle) {
        load[slug] = (load[slug] || 0) + perMuscle[slug] * setCount;
      }
    }
  }
  res.json(load);
}));

// Primary muscle weight = 1.0, secondary = 0.4 (both are per-set, so a 4×8
// bench weighs four times a single set). Same constant openGym uses.
const _MUSCLE_SECONDARY = 0.4;

// The 18 muscles the body map can shade. Order matches head-to-toe so any
// list built off this reads top-down. Kept in sync with client-side muscles.js.
const _MUSCLES = [
  'trapezius','deltoids','chest','upper-back','serratus',
  'biceps','triceps','forearm',
  'abs','obliques','lower-back',
  'gluteal','quadriceps','hamstring','adductors','hip-flexors',
  'calves','tibialis',
];

// Every spelling that shows up in wger/exerciseDB/free-db + custom imports,
// folded onto the 18 drawable muscles. null = deliberately not drawable
// (hands, ankles, cardio) rather than guessed at.
const _ALIAS = {
  abs: 'abs', pectorals: 'chest', chest: 'chest', 'upper chest': 'chest',
  biceps: 'biceps', brachialis: 'biceps',
  triceps: 'triceps',
  glutes: 'gluteal', gluteal: 'gluteal', abductors: 'gluteal',
  delts: 'deltoids', deltoids: 'deltoids', shoulders: 'deltoids',
  'rear deltoids': 'deltoids', 'rotator cuff': 'deltoids',
  'upper back': 'upper-back', lats: 'upper-back', 'latissimus dorsi': 'upper-back',
  back: 'upper-back', rhomboids: 'upper-back',
  calves: 'calves', soleus: 'calves',
  quads: 'quadriceps', quadriceps: 'quadriceps',
  forearms: 'forearm', forearm: 'forearm', wrists: 'forearm',
  'wrist flexors': 'forearm', 'wrist extensors': 'forearm', 'grip muscles': 'forearm',
  hamstrings: 'hamstring', hamstring: 'hamstring',
  spine: 'lower-back', 'lower back': 'lower-back',
  traps: 'trapezius', trapezius: 'trapezius', 'levator scapulae': 'trapezius',
  adductors: 'adductors', groin: 'adductors', 'inner thighs': 'adductors',
  'serratus anterior': 'serratus', serratus: 'serratus',
  core: 'abs', abdominals: 'abs', 'lower abs': 'abs',
  obliques: 'obliques',
  'hip flexors': 'hip-flexors',
  shins: 'tibialis', tibialis: 'tibialis',
  'cardiovascular system': null, cardio: null,
  ankles: null, feet: null, hands: null,
  'ankle stabilizers': null, sternocleidomastoid: null,
};

// Fallback when an exercise has no recognised primary muscles — custom
// exercises often only carry a body-part category. Weights within a group
// sum to ~1 so "upper legs" spreads across three muscles rather than
// counting triple.
const _BY_CATEGORY = {
  chest: { chest: 1 },
  back: { 'upper-back': 0.75, 'lower-back': 0.25 },
  shoulders: { deltoids: 1 },
  'upper arms': { biceps: 0.5, triceps: 0.5 },
  arms: { biceps: 0.4, triceps: 0.4, forearm: 0.2 },
  'lower arms': { forearm: 1 },
  waist: { abs: 0.7, obliques: 0.3 },
  core: { abs: 0.7, obliques: 0.3 },
  'upper legs': { quadriceps: 0.4, hamstring: 0.35, gluteal: 0.25 },
  legs: { quadriceps: 0.35, hamstring: 0.3, gluteal: 0.2, calves: 0.15 },
  'lower legs': { calves: 0.8, tibialis: 0.2 },
  neck: { trapezius: 1 },
};

// Reduce one exercise's primary + secondary muscles + category fallback to
// a { slug: 0…1 } map. Takes the max weight per slug (a muscle listed as
// both primary and secondary counts as primary, not 1.4).
function musclesOf(info) {
  const out = {};
  const add = (name, w) => {
    const slug = _ALIAS[String(name || '').toLowerCase().trim()];
    if (slug) out[slug] = Math.max(out[slug] || 0, w);
  };
  (info.primary || []).forEach(m => add(m, 1));
  (info.secondary || []).forEach(m => add(m, _MUSCLE_SECONDARY));
  if (!Object.keys(out).length && info.category) {
    const fallback = _BY_CATEGORY[info.category];
    if (fallback) Object.assign(out, fallback);
  }
  return out;
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
