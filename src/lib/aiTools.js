/**
 * Trace tool catalog + executor.
 *
 * These 18 tools give the assistant real read/write access to the user's
 * LiftTrace data. All executors go through `fetch('/api/...')` with
 * `credentials: 'include'` so the apiFetch.js interceptor can handle
 * PWA cookies vs native Bearer-token auth vs local SQLite fallback
 * uniformly (mirrors the pattern LtApi already uses).
 *
 * Wire format: each executor returns a plain JSON object shaped for the
 * model — internal ids the model can use for follow-ups are preserved,
 * server-side noise is trimmed. On failure the executor throws; the
 * chat loop catches and relays a `{ error: ... }` payload to the model.
 */

// ── Small helpers ──────────────────────────────────────────────────────────

const _opts = { credentials: 'include' };
const _jsonOpts = { ..._opts, headers: { 'Content-Type': 'application/json' } };

async function _get(path) {
  const res = await fetch(path, _opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function _post(path, body) {
  const res = await fetch(path, { ..._jsonOpts, method: 'POST', body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function _put(path, body) {
  const res = await fetch(path, { ..._jsonOpts, method: 'PUT', body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function _today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function _daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Bilateral-safe volume calculator (matches server/lib/volume.js).
function _setVolume(set, loadType = 'bilateral') {
  if (!set) return 0;
  const w = Number(set.weight) || 0;
  if (w <= 0) return 0;
  if (loadType === 'unilateral') {
    if (set.reps_l != null || set.reps_r != null) {
      return w * ((Number(set.reps_l) || 0) + (Number(set.reps_r) || 0));
    }
    return w * (Number(set.reps) || 0) * 2;
  }
  if (loadType === 'paired') return w * (Number(set.reps) || 0) * 2;
  return w * (Number(set.reps) || 0);
}
function _exerciseVolume(ex) {
  const lt = ex.load_type || 'bilateral';
  let total = 0;
  for (const s of (ex.sets || [])) {
    if (!s.completed || s.warmup) continue;
    total += _setVolume(s, lt);
  }
  return total;
}
function _e1rm(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30));
}

/** Shape a workout row for the model — trim internal fields, expose totals. */
function _shapeWorkout(w) {
  if (!w) return null;
  const exercises = (w.exercises || []).map(ex => {
    const sets = (ex.sets || []).map(s => ({
      weight: s.weight ?? null,
      reps: s.reps ?? null,
      ...(s.rpe != null ? { rpe: s.rpe } : {}),
      ...(s.warmup ? { warmup: true } : {}),
      completed: !!s.completed,
    }));
    const workingSets = sets.filter(s => s.completed && !s.warmup && s.weight > 0);
    const topSet = workingSets.reduce(
      (best, s) => (!best || s.weight > best.weight ? s : best), null,
    );
    return {
      name: ex.exercise_name,
      ...(ex.exercise_id ? { exercise_id: ex.exercise_id } : {}),
      sets,
      total_volume: Math.round(_exerciseVolume(ex)),
      ...(topSet ? { top_set: { weight: topSet.weight, reps: topSet.reps } } : {}),
      ...(ex.notes ? { notes: ex.notes } : {}),
    };
  });
  const total_volume = Math.round(exercises.reduce((a, e) => a + (e.total_volume || 0), 0));
  const top_set_by_exercise = {};
  for (const ex of exercises) if (ex.top_set) top_set_by_exercise[ex.name] = ex.top_set;
  return {
    id: w.id,
    date: w.date,
    ...(w.name ? { name: w.name } : {}),
    ...(w.duration_min != null ? { duration_min: w.duration_min } : {}),
    completed: !!w.completed,
    ...(w.template_id ? { template_id: w.template_id } : {}),
    ...(w.program_id ? { program_id: w.program_id } : {}),
    ...(w.notes ? { notes: w.notes } : {}),
    exercises,
    total_volume,
    top_set_by_exercise,
  };
}

// ── Tool schemas ───────────────────────────────────────────────────────────

export const TOOLS = [
  // ── READ ──
  {
    name: 'get_workouts',
    description:
      "List the user's recent workouts with completed sets, per-exercise volume, and top set. Use whenever they ask about past sessions, recent training, or how a lift has been going. Defaults to the last 30 days. Filter by exercise_name to narrow to one lift.",
    parameters: {
      type: 'object',
      properties: {
        date_from:     { type: 'string', description: 'Inclusive YYYY-MM-DD. Defaults to 30 days ago.' },
        date_to:       { type: 'string', description: 'Inclusive YYYY-MM-DD. Defaults to today.' },
        exercise_name: { type: 'string', description: 'Case-insensitive substring match; only workouts containing this exercise are returned.' },
      },
    },
  },
  {
    name: 'get_workout',
    description:
      "Get one workout in full detail by id, every set, notes, coach feedback (if any), and program context. Use after get_workouts to pull specifics.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'workout_log id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_exercises',
    description:
      "Search the exercise catalog (wger, free-exercise-db, exercisedb variants, custom). Returns compact rows with id, name, muscles, equipment, and source. Use to look up an exercise by name or filter by muscle/equipment before calling get_exercise for full detail.",
    parameters: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Case-insensitive name substring.' },
        muscle:    { type: 'string', description: 'Primary-muscle filter (e.g. "chest", "quads").' },
        equipment: { type: 'string', description: 'Equipment filter (e.g. "barbell", "dumbbell").' },
        source:    { type: 'string', description: "One of 'wger' | 'free-exercise-db' | 'exercisedb' | 'exercisedb-oss' | 'custom'." },
        limit:     { type: 'integer', description: 'Max rows to return. Default 20, cap 100.' },
      },
    },
  },
  {
    name: 'get_exercise',
    description:
      "Get a single exercise's full detail, description, instructions, muscles, equipment, and a small list of similar exercises. Pass either id or name (id wins if both are given).",
    parameters: {
      type: 'object',
      properties: {
        id:   { type: 'integer', description: 'exercises.id' },
        name: { type: 'string',  description: 'Exact-ish name, first case-insensitive match is used.' },
      },
    },
  },
  {
    name: 'get_programs',
    description:
      "List all programs in the user's library with goal, template count, weeks, and which one is currently active. Use before switching programs or referencing a program by name.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_program',
    description:
      "Get one program with every template (day) laid out, target sets/reps/load/RPE/tempo/rest per exercise, plus per-week overrides if the program is multi-week. Use to explain what the program is or preview an upcoming day.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'programs.id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_active_program',
    description:
      "Get the user's currently active program in full (same shape as get_program). Returns { active: false } if none is active. Prefer this over get_programs+get_program when the user says 'my program' / 'today's plan'.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_prs',
    description:
      "List personal records, top weight, top reps at that weight, and estimated 1RM per exercise. Filter by exercise_name and/or date range. Use for 'what's my bench PR?' / 'recent PRs' / 'top lifts this month'.",
    parameters: {
      type: 'object',
      properties: {
        exercise_name: { type: 'string', description: 'Case-insensitive substring filter on exercise name.' },
        date_from:     { type: 'string', description: 'Inclusive YYYY-MM-DD; only PRs set on/after this date.' },
        date_to:       { type: 'string', description: 'Inclusive YYYY-MM-DD; only PRs set on/before this date.' },
        limit:         { type: 'integer', description: 'Max rows to return. Default 20.' },
      },
    },
  },
  {
    name: 'get_body_stats',
    description:
      "Get body stats over time, weight, body_fat, or any tracked measurement. Returns time series + summary (first, last, min, max, absolute + percent change) when a single stat is queried.",
    parameters: {
      type: 'object',
      properties: {
        stat:      { type: 'string', description: "Optional single-stat filter (e.g. 'weight', 'body_fat', 'chest')." },
        date_from: { type: 'string', description: 'Inclusive YYYY-MM-DD. Defaults to 90 days ago.' },
        date_to:   { type: 'string', description: 'Inclusive YYYY-MM-DD. Defaults to today.' },
      },
    },
  },
  {
    name: 'get_stats_overview',
    description:
      "Snapshot the user's training over a window: workouts done, current + best streak, weekly averages, weekly volume + frequency series, muscle-group balance (with imbalance %), and top PRs set in range. Use for 'how am I doing?' / 'weekly summary'.",
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: "One of '7d' | '30d' | '90d' | '1y' | 'all'. Default '30d'." },
      },
    },
  },
  {
    name: 'get_coach_prescription',
    description:
      "Get the coach-prescribed workout for a given date (default today) if the user has a trainer. Returns { prescribed: false } if none was set. Use before generating a workout so any coach direction is honored.",
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
    },
  },

  // ── WRITE ──
  {
    name: 'log_workout',
    description:
      "Commit a full workout to the diary for a specific date. Each exercise carries its sets [{weight, reps, rpe?, warmup?, completed?}]. Exercise names are resolved case-insensitively against the library; unknown names error out so the user can confirm before a custom row is created. Use when they say 'log today' / 'I did X, Y, Z'.",
    parameters: {
      type: 'object',
      properties: {
        date:         { type: 'string',  description: 'YYYY-MM-DD.' },
        name:         { type: 'string',  description: 'Optional session name.' },
        duration_min: { type: 'number',  description: 'Optional session duration in minutes.' },
        exercises: {
          type: 'array',
          description: 'Ordered list of exercises with their sets.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exercise name; matched case-insensitively against the library.' },
              sets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    weight:    { type: 'number',  description: 'Load in the user\'s unit (kg or lbs).' },
                    reps:      { type: 'integer', description: 'Reps performed.' },
                    rpe:       { type: 'number',  description: 'Optional RPE 1-10.' },
                    warmup:    { type: 'boolean', description: 'Warm-up set (excluded from volume/PRs). Default false.' },
                    completed: { type: 'boolean', description: 'Whether the set was completed. Default true.' },
                  },
                  required: ['weight', 'reps'],
                },
              },
            },
            required: ['name', 'sets'],
          },
        },
      },
      required: ['date', 'exercises'],
    },
  },
  {
    name: 'add_exercise_to_diary',
    description:
      "Quick-add one exercise to a diary day (default today) with no sets yet, the user will fill sets in the diary. Creates the workout for that date if one doesn't exist. Use for 'add bench to today' / 'put squat on my log'.",
    parameters: {
      type: 'object',
      properties: {
        exercise_name: { type: 'string', description: 'Exercise name; matched case-insensitively against the library.' },
        date:          { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
      required: ['exercise_name'],
    },
  },
  {
    name: 'log_set',
    description:
      "Append a single set to an exercise already in a workout. Identify the exercise by exercise_id (its id within the workout's exercises array, 0-based) or by exercise_name. Use for 'add another set of 5 at 225' / 'I hit one more'.",
    parameters: {
      type: 'object',
      properties: {
        workout_id:    { type: 'integer', description: 'workout_log id.' },
        exercise_id:   { type: 'integer', description: 'Position of the exercise within the workout (0-based).' },
        exercise_name: { type: 'string',  description: 'Alternative to exercise_id, resolved by case-insensitive name match.' },
        weight:        { type: 'number',  description: 'Load.' },
        reps:          { type: 'integer', description: 'Reps.' },
        rpe:           { type: 'number',  description: 'Optional RPE 1-10.' },
        warmup:        { type: 'boolean', description: 'Warm-up set. Default false.' },
        completed:     { type: 'boolean', description: 'Completed. Default true.' },
      },
      required: ['workout_id', 'weight', 'reps'],
    },
  },
  {
    name: 'log_body_stat',
    description:
      "Record a body-stat measurement (weight, body_fat, chest, waist, etc.) for a given date. Merges with any existing stats for that date. Use for 'weighed in at 182 today' / 'body-fat is 15%'.",
    parameters: {
      type: 'object',
      properties: {
        stat:  { type: 'string',  description: "Stat name, 'weight', 'body_fat', or any custom measurement." },
        value: { type: 'number',  description: 'Numeric value.' },
        unit:  { type: 'string',  description: "Optional unit override. Defaults: 'kg' for weight, '%' for body_fat." },
        date:  { type: 'string',  description: 'YYYY-MM-DD. Defaults to today.' },
        note:  { type: 'string',  description: 'Optional free-text note attached to the entry.' },
      },
      required: ['stat', 'value'],
    },
  },
  {
    name: 'start_workout_from_template',
    description:
      "Load a workout template into a diary day (default today) so the user can execute it. Pass template_id or template_name (resolved against the user's programs' templates). Use for 'load push day' / 'start Day A'.",
    parameters: {
      type: 'object',
      properties: {
        template_id:   { type: 'integer', description: 'workout_templates.id' },
        template_name: { type: 'string',  description: 'Case-insensitive template name match across the user\'s programs.' },
        date:          { type: 'string',  description: 'YYYY-MM-DD. Defaults to today.' },
      },
    },
  },
  {
    name: 'set_active_program',
    description:
      "Switch the user's active program. Pass program_id or program_name. Deactivates the previously active program. Use for 'switch me to 5/3/1' / 'start the Push-Pull-Legs program'.",
    parameters: {
      type: 'object',
      properties: {
        program_id:   { type: 'integer', description: 'programs.id' },
        program_name: { type: 'string',  description: 'Case-insensitive program name match.' },
      },
    },
  },
  {
    name: 'add_coach_prescription',
    description:
      "COACH ONLY. Prescribe a workout template to a trainee on a target date. Fails with a clear error if the caller is not a trainer/admin or does not coach the trainee. Use when the coach says 'prescribe Push Day to Alex for Friday'.",
    parameters: {
      type: 'object',
      properties: {
        trainee_id:  { type: 'integer', description: 'The member (users.id) to prescribe to.' },
        template_id: { type: 'integer', description: 'workout_templates.id to prescribe.' },
        target_date: { type: 'string',  description: 'YYYY-MM-DD the trainee should perform the workout.' },
        notes:       { type: 'string',  description: 'Optional coach notes for the trainee.' },
      },
      required: ['trainee_id', 'template_id', 'target_date'],
    },
  },
];

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function runTool(name, args) {
  args = args || {};
  switch (name) {
    // ── READ ────────────────────────────────────────────────────────────
    case 'get_workouts':   return _getWorkouts(args);
    case 'get_workout':    return _getWorkout(args);
    case 'get_exercises':  return _getExercises(args);
    case 'get_exercise':   return _getExercise(args);
    case 'get_programs':   return _getPrograms();
    case 'get_program':    return _getProgram(args);
    case 'get_active_program':     return _getActiveProgram();
    case 'get_prs':                return _getPrs(args);
    case 'get_body_stats':         return _getBodyStats(args);
    case 'get_stats_overview':     return _getStatsOverview(args);
    case 'get_coach_prescription': return _getCoachPrescription(args);

    // ── WRITE ───────────────────────────────────────────────────────────
    case 'log_workout':                 return _logWorkout(args);
    case 'add_exercise_to_diary':       return _addExerciseToDiary(args);
    case 'log_set':                     return _logSet(args);
    case 'log_body_stat':               return _logBodyStat(args);
    case 'start_workout_from_template': return _startWorkoutFromTemplate(args);
    case 'set_active_program':          return _setActiveProgram(args);
    case 'add_coach_prescription':      return _addCoachPrescription(args);
  }
  throw new Error('Unknown tool: ' + name);
}

// ── Executors: READ ───────────────────────────────────────────────────────

async function _getWorkouts({ date_from, date_to, exercise_name } = {}) {
  const from = date_from || _daysAgo(30);
  const to   = date_to   || _today();
  // The list endpoint is `/api/workout/recent` (no date-range filter),
  // so we pull a generous window then filter client-side. Callers care
  // about the last month or two; 200 rows is more than a year for most
  // lifters.
  const rows = await _get('/api/workout/recent?limit=200');
  const filtered = rows.filter(r => r.date >= from && r.date <= to);
  const needle = (exercise_name || '').toLowerCase().trim();
  const matched = needle
    ? filtered.filter(r => (r.exercises || []).some(ex => (ex.exercise_name || '').toLowerCase().includes(needle)))
    : filtered;
  return matched.map(_shapeWorkout);
}

async function _getWorkout({ id }) {
  if (id == null) throw new Error('id is required');
  // No direct GET /api/workout/id/:id — the diary is date-keyed. Find
  // the row inside a bounded recent window (covers ~2 years for a
  // 3x/week lifter) and reshape.
  const rows = await _get('/api/workout/recent?limit=500');
  const w = rows.find(r => r.id === Number(id));
  if (!w) throw new Error(`Workout ${id} not found`);
  // Pull the same date via the by-date GET so feedback + program_duration
  // context land too.
  try {
    const detail = await _get(`/api/workout/${w.date}`);
    const shaped = _shapeWorkout(detail?.workout || w);
    if (detail?.workout?.feedback?.length) {
      shaped.coach_feedback = detail.workout.feedback.map(f => ({
        trainer_name: f.trainer_name,
        exercise_idx: f.exercise_idx,
        note: f.note,
        updated_at: f.updated_at,
      }));
    }
    return shaped;
  } catch {
    return _shapeWorkout(w);
  }
}

async function _getExercises({ query, muscle, equipment, source, limit } = {}) {
  const params = new URLSearchParams();
  if (query)     params.set('search', query);
  if (equipment) params.set('equipment', equipment);
  const cap = Math.min(Number(limit) || 20, 100);
  params.set('limit', String(cap * 3));                     // slack for post-filters
  const rows = await _get(`/api/exercises?${params.toString()}`);
  // Post-filters (server accepts search + equipment but not muscle/source).
  const needleMuscle = (muscle || '').toLowerCase().trim();
  const wantSource   = (source || '').toLowerCase().trim();
  const filtered = rows.filter(r => {
    if (needleMuscle) {
      const p = (r.primary_muscles || []).map(m => String(m).toLowerCase());
      const s = (r.secondary_muscles || []).map(m => String(m).toLowerCase());
      if (![...p, ...s].some(m => m.includes(needleMuscle))) return false;
    }
    if (wantSource && (r.source || '').toLowerCase() !== wantSource) return false;
    return true;
  }).slice(0, cap);
  return filtered.map(r => ({
    id: r.id,
    name: r.name,
    primary_muscles: r.primary_muscles || [],
    secondary_muscles: r.secondary_muscles || [],
    equipment: r.equipment || [],
    source: r.source || null,
    has_media: !!(r.gif_url || r.img_url || r.video_url),
  }));
}

async function _getExercise({ id, name } = {}) {
  let row;
  if (id != null) {
    row = await _get(`/api/exercises/${Number(id)}`);
  } else if (name) {
    const matches = await _get(`/api/exercises?search=${encodeURIComponent(name)}&limit=1`);
    row = matches?.[0];
    if (!row) throw new Error(`No exercise found matching "${name}"`);
    row = await _get(`/api/exercises/${row.id}`);
  } else {
    throw new Error('Provide id or name');
  }
  // Similar-exercises: cheap muscle-overlap lookup (up to 5).
  let similar = [];
  const primary = (row.primary_muscles || [])[0];
  if (primary) {
    try {
      const pool = await _get(`/api/exercises?limit=40`);
      const primaryLower = String(primary).toLowerCase();
      similar = pool
        .filter(x => x.id !== row.id)
        .filter(x => (x.primary_muscles || []).some(m => String(m).toLowerCase() === primaryLower))
        .slice(0, 5)
        .map(x => ({ id: x.id, name: x.name }));
    } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    primary_muscles: row.primary_muscles || [],
    secondary_muscles: row.secondary_muscles || [],
    equipment: row.equipment || [],
    source: row.source || null,
    instructions: row.instructions || null,
    tips: row.tips || null,
    similar_exercises: similar,
  };
}

async function _getPrograms() {
  const rows = await _get('/api/programs');
  return rows.map(p => ({
    id: p.id,
    name: p.name,
    goal: p.goal,
    template_count: p.template_count ?? 0,
    weeks: p.duration_weeks ?? 1,
    is_active: !!p.is_active,
    ...(p.current_week ? { current_week: p.current_week } : {}),
  }));
}

async function _getProgram({ id }) {
  if (id == null) throw new Error('id is required');
  const p = await _get(`/api/programs/${Number(id)}`);
  return _shapeProgram(p);
}

function _shapeProgram(p) {
  if (!p) return null;
  const templates = (p.templates || []).map(t => {
    const exs = (t.exercises || []).map(ex => ({
      name: ex.exercise_name || ex.name,
      ...(ex.exercise_id ? { exercise_id: ex.exercise_id } : {}),
      ...(ex.target_sets != null ? { target_sets: ex.target_sets } : {}),
      ...(ex.target_reps != null ? { target_reps: ex.target_reps } : {}),
      ...(ex.target_weight != null ? { target_load: ex.target_weight } : {}),
      ...(ex.target_rpe != null ? { target_rpe: ex.target_rpe } : {}),
      ...(ex.tempo ? { tempo: ex.tempo } : {}),
      ...(ex.rest_seconds != null ? { rest_seconds: ex.rest_seconds } : {}),
      ...(ex.week_overrides ? { week_overrides: ex.week_overrides } : {}),
    }));
    return {
      id: t.id,
      name: t.name,
      ...(t.day_label ? { day_label: t.day_label } : {}),
      exercises: exs,
    };
  });
  return {
    id: p.id,
    name: p.name,
    goal: p.goal,
    weeks: p.duration_weeks ?? 1,
    is_active: !!p.is_active,
    ...(p.current_week ? { current_week: p.current_week } : {}),
    templates,
  };
}

async function _getActiveProgram() {
  const rows = await _get('/api/programs');
  const active = rows.find(p => p.is_active);
  if (!active) return { active: false };
  const full = await _get(`/api/programs/${active.id}`);
  return _shapeProgram(full);
}

async function _getPrs({ exercise_name, date_from, date_to, limit } = {}) {
  const cap = Number(limit) || 20;
  const records = await _get('/api/stats/records');
  const needle = (exercise_name || '').toLowerCase().trim();
  const filtered = records
    .filter(r => (r.maxWeight || 0) > 0)
    .filter(r => (!needle || (r.name || '').toLowerCase().includes(needle)))
    .filter(r => (!date_from || (r.date && r.date >= date_from)))
    .filter(r => (!date_to   || (r.date && r.date <= date_to)))
    .sort((a, b) => (b.e1rm || 0) - (a.e1rm || 0))
    .slice(0, cap);
  return filtered.map(r => ({
    exercise_name: r.name,
    weight: r.maxWeight,
    reps: r.maxReps,
    one_rep_max_estimate: r.e1rm,
    date: r.date || null,
  }));
}

async function _getBodyStats({ stat, date_from, date_to } = {}) {
  const from = date_from || _daysAgo(90);
  const to   = date_to   || _today();
  const rows = await _get(`/api/body-stats/range?start=${from}&end=${to}`);
  // rows[i].stats is an object like { weight: 82, body_fat: 15 }. Flatten
  // to { date, stat, value } tuples.
  const series = [];
  for (const row of rows) {
    const stats = row.stats || {};
    for (const key of Object.keys(stats)) {
      if (stat && key !== stat) continue;
      const v = stats[key];
      if (v == null || v === '') continue;
      const value = typeof v === 'object' ? v.value : v;
      const unit  = typeof v === 'object' ? v.unit  : _defaultUnit(key);
      series.push({ date: row.date, stat: key, value: Number(value), unit });
    }
  }
  series.sort((a, b) => a.date.localeCompare(b.date));
  if (stat) {
    const numericValues = series.map(s => s.value).filter(n => Number.isFinite(n));
    if (numericValues.length) {
      const first = series[0].value;
      const last  = series[series.length - 1].value;
      const min   = Math.min(...numericValues);
      const max   = Math.max(...numericValues);
      const change_absolute = Math.round((last - first) * 100) / 100;
      const change_pct = first ? Math.round(((last - first) / first) * 1000) / 10 : null;
      return { series, summary: { first, last, min, max, change_absolute, change_pct } };
    }
  }
  return { series };
}

function _defaultUnit(stat) {
  if (stat === 'weight') return 'kg';
  if (stat === 'body_fat' || stat === 'bodyfat') return '%';
  return null;
}

async function _getStatsOverview({ range } = {}) {
  const r = (range || '30d').toLowerCase();
  let days = 30;
  if      (r === '7d') days = 7;
  else if (r === '90d') days = 90;
  else if (r === '1y')  days = 365;
  else if (r === 'all') days = null;

  let from;
  if (days == null) {
    try { const e = await _get('/api/stats/earliest-workout-date'); from = e?.date || _daysAgo(3650); }
    catch { from = _daysAgo(3650); }
  } else {
    from = _daysAgo(days);
  }
  const to = _today();

  const [streaks, volume, frequency, muscleSets, records] = await Promise.all([
    _get('/api/stats/streaks').catch(() => ({})),
    _get(`/api/stats/volume?start=${from}&end=${to}`).catch(() => []),
    _get(`/api/stats/frequency?start=${from}&end=${to}`).catch(() => []),
    _get(`/api/stats/muscle-effective-sets?start=${from}&end=${to}`).catch(() => ({})),
    _get('/api/stats/records').catch(() => []),
  ]);

  const workouts_in_range = frequency.reduce((a, w) => a + (w.count || 0), 0);
  const weeks = Math.max(1, frequency.length || Math.ceil(days ? days / 7 : 1));
  const weekly_avg = Math.round((workouts_in_range / weeks) * 10) / 10;

  // Muscle balance — normalize to percentages + imbalance vs mean.
  const totalSets = Object.values(muscleSets).reduce((a, v) => a + (v || 0), 0);
  const meanSets  = totalSets && Object.keys(muscleSets).length ? totalSets / Object.keys(muscleSets).length : 0;
  const muscle_group_balance = Object.entries(muscleSets)
    .map(([group, sets]) => ({
      group,
      sets_pct: totalSets ? Math.round((sets / totalSets) * 1000) / 10 : 0,
      imbalance_pct: meanSets ? Math.round(((sets - meanSets) / meanSets) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sets_pct - a.sets_pct);

  const top_prs_in_range = records
    .filter(r => r.date && r.date >= from && r.date <= to)
    .sort((a, b) => (b.e1rm || 0) - (a.e1rm || 0))
    .slice(0, 5)
    .map(r => ({ exercise_name: r.name, weight: r.maxWeight, reps: r.maxReps, one_rep_max_estimate: r.e1rm, date: r.date }));

  return {
    range: r,
    date_from: from,
    date_to: to,
    workouts_in_range,
    streak_current: streaks.currentStreak ?? 0,
    streak_best:    streaks.longestStreak ?? 0,
    weekly_avg,
    weekly_volume:    volume.map(v => ({ week: v.week, volume: Math.round(v.volume) })),
    weekly_frequency: frequency,
    muscle_group_balance,
    top_prs_in_range,
  };
}

async function _getCoachPrescription({ date } = {}) {
  const d = date || _today();
  const row = await _get(`/api/prescriptions/my/${d}`).catch(() => null);
  if (!row) return { prescribed: false };
  return {
    prescribed: true,
    prescription: {
      trainer_name: row.trainer_name || null,
      workout_template_ref: row.template_id ? { id: row.template_id, name: row.template_name } : null,
      program_name: row.program_name || null,
      inline_name: row.name || null,
      notes: row.notes || null,
      target_date: row.date || d,
    },
  };
}

// ── Executors: WRITE ──────────────────────────────────────────────────────

/** Find an exercise in the library by case-insensitive name. */
async function _resolveExerciseByName(name) {
  const hits = await _get(`/api/exercises?search=${encodeURIComponent(name)}&limit=5`);
  const lower = name.toLowerCase().trim();
  // Prefer exact match, else first substring hit.
  return hits.find(h => (h.name || '').toLowerCase() === lower) || hits[0] || null;
}

async function _logWorkout({ date, name, duration_min, exercises }) {
  if (!date || !Array.isArray(exercises) || !exercises.length) {
    throw new Error('date and non-empty exercises[] are required');
  }
  // Resolve every exercise name up front. Any miss aborts with a clear
  // message so the user can confirm before creating a custom row.
  const resolved = [];
  const unknown = [];
  for (const ex of exercises) {
    if (!ex.name) throw new Error('Each exercise needs a name');
    const lib = await _resolveExerciseByName(ex.name).catch(() => null);
    if (!lib) { unknown.push(ex.name); continue; }
    resolved.push({ lib, input: ex });
  }
  if (unknown.length) {
    throw new Error(`Unknown exercise(s): ${unknown.join(', ')}. Please confirm and I'll add as custom, or pick from get_exercises.`);
  }

  const existing = await _get(`/api/workout/${date}`).catch(() => ({ workout: null }));
  const existingExs = existing?.workout?.exercises || [];
  const newExs = resolved.map(({ lib, input }) => ({
    exercise_id: lib.id,
    exercise_name: lib.name,
    sets: (input.sets || []).map(s => ({
      weight: Number(s.weight) || 0,
      reps:   Number(s.reps)   || 0,
      completed: s.completed !== false,
      ...(s.warmup ? { warmup: true } : {}),
      ...(s.rpe != null ? { rpe: Number(s.rpe) } : {}),
    })),
  }));
  const merged = existingExs.concat(newExs);

  const saved = await _put(`/api/workout/${date}`, {
    name: name ?? existing?.workout?.name ?? null,
    duration_min: duration_min ?? existing?.workout?.duration_min ?? null,
    exercises: merged,
    completed: 1,
  });
  const w = saved?.workout;
  let sets_logged = 0;
  for (const ex of newExs) sets_logged += ex.sets.length;
  return {
    id: w?.id,
    date: w?.date,
    exercises_logged: newExs.length,
    sets_logged,
    total_volume: w ? Math.round(w.exercises?.reduce((a, e) => a + _exerciseVolume(e), 0) || 0) : 0,
  };
}

async function _addExerciseToDiary({ exercise_name, date }) {
  if (!exercise_name) throw new Error('exercise_name is required');
  const d = date || _today();
  const lib = await _resolveExerciseByName(exercise_name);
  if (!lib) throw new Error(`Unknown exercise: ${exercise_name}`);
  const existing = await _get(`/api/workout/${d}`).catch(() => ({ workout: null }));
  const exs = (existing?.workout?.exercises || []).slice();
  const position = exs.length;
  exs.push({
    exercise_id: lib.id,
    exercise_name: lib.name,
    sets: [{ weight: 0, reps: 0, completed: false }],
  });
  const saved = await _put(`/api/workout/${d}`, {
    name: existing?.workout?.name ?? null,
    duration_min: existing?.workout?.duration_min ?? null,
    exercises: exs,
  });
  return {
    workout_id: saved?.workout?.id,
    exercise_added_id: lib.id,
    position,
  };
}

async function _logSet({ workout_id, exercise_id, exercise_name, weight, reps, rpe, warmup, completed }) {
  if (workout_id == null) throw new Error('workout_id is required');
  // Find the workout by scanning recent rows.
  const rows = await _get('/api/workout/recent?limit=500');
  const wRow = rows.find(r => r.id === Number(workout_id));
  if (!wRow) throw new Error(`Workout ${workout_id} not found`);
  const exs = (wRow.exercises || []).slice();
  let idx = null;
  if (exercise_id != null && exs[exercise_id]) {
    idx = Number(exercise_id);
  } else if (exercise_name) {
    const lower = String(exercise_name).toLowerCase();
    idx = exs.findIndex(e => (e.exercise_name || '').toLowerCase().includes(lower));
    if (idx < 0) idx = null;
  }
  if (idx == null) throw new Error('exercise_id (position) or exercise_name is required and must match a slot in the workout');
  const newSet = {
    weight: Number(weight) || 0,
    reps:   Number(reps)   || 0,
    completed: completed !== false,
    ...(warmup ? { warmup: true } : {}),
    ...(rpe != null ? { rpe: Number(rpe) } : {}),
  };
  const sets = (exs[idx].sets || []).slice();
  sets.push(newSet);
  exs[idx] = { ...exs[idx], sets };
  const saved = await _put(`/api/workout/${wRow.date}`, {
    name: wRow.name ?? null,
    duration_min: wRow.duration_min ?? null,
    exercises: exs,
  });
  const total_volume = Math.round((saved?.workout?.exercises || []).reduce((a, e) => a + _exerciseVolume(e), 0));
  return {
    set_id: sets.length - 1,
    position: idx,
    workout_total_volume: total_volume,
  };
}

async function _logBodyStat({ stat, value, unit, date, note }) {
  if (!stat) throw new Error('stat is required');
  if (value == null || Number.isNaN(Number(value))) throw new Error('value must be a number');
  const d = date || _today();
  const cur = await _get(`/api/body-stats/${d}`).catch(() => ({ stats: null }));
  const stats = { ...(cur?.stats?.stats || {}) };
  const useUnit = unit || _defaultUnit(stat) || null;
  stats[stat] = note != null
    ? { value: Number(value), unit: useUnit, note }
    : (useUnit ? { value: Number(value), unit: useUnit } : Number(value));
  const saved = await _put(`/api/body-stats/${d}`, { stats });
  return {
    id: saved?.stats?.id,
    stat,
    value: Number(value),
    unit: useUnit,
    date: d,
  };
}

async function _startWorkoutFromTemplate({ template_id, template_name, date }) {
  if (template_id == null && !template_name) throw new Error('template_id or template_name is required');
  const d = date || _today();
  let tpl = null;
  if (template_id != null) {
    tpl = await _get(`/api/templates/${Number(template_id)}`);
  } else {
    // Scan the user's programs to find a template by name.
    const programs = await _get('/api/programs');
    const lower = String(template_name).toLowerCase();
    outer: for (const p of programs) {
      const full = await _get(`/api/programs/${p.id}`);
      for (const t of (full.templates || [])) {
        if ((t.name || '').toLowerCase() === lower) { tpl = t; break outer; }
      }
      for (const t of (full.templates || [])) {
        if ((t.name || '').toLowerCase().includes(lower)) { tpl = t; break outer; }
      }
    }
    if (!tpl) throw new Error(`No template matching "${template_name}"`);
  }

  const existing = await _get(`/api/workout/${d}`).catch(() => ({ workout: null }));
  const existingExs = existing?.workout?.exercises || [];
  const tplExs = (tpl.exercises || []).map(ex => ({
    exercise_id: ex.exercise_id || null,
    exercise_name: ex.exercise_name || ex.name || '',
    sets: Array.from({ length: ex.target_sets || 1 }, () => ({
      weight: ex.target_weight || 0,
      reps:   ex.target_reps   || 0,
      completed: false,
    })),
    ...(ex.target_sets   != null ? { target_sets:   ex.target_sets   } : {}),
    ...(ex.target_reps   != null ? { target_reps:   ex.target_reps   } : {}),
    ...(ex.target_weight != null ? { target_weight: ex.target_weight } : {}),
    ...(ex.rest_seconds  != null ? { rest_seconds:  ex.rest_seconds  } : {}),
  }));
  const saved = await _put(`/api/workout/${d}`, {
    template_id: tpl.id,
    program_id: tpl.program_id ?? null,
    name: tpl.name,
    duration_min: existing?.workout?.duration_min ?? null,
    exercises: existingExs.concat(tplExs),
  });
  return {
    workout_id: saved?.workout?.id,
    exercises_loaded: tplExs.length,
    from_template: { id: tpl.id, name: tpl.name },
  };
}

async function _setActiveProgram({ program_id, program_name }) {
  if (program_id == null && !program_name) throw new Error('program_id or program_name is required');
  const programs = await _get('/api/programs');
  let target = null;
  if (program_id != null) {
    target = programs.find(p => p.id === Number(program_id)) || null;
  } else {
    const lower = String(program_name).toLowerCase();
    target = programs.find(p => (p.name || '').toLowerCase() === lower)
          || programs.find(p => (p.name || '').toLowerCase().includes(lower))
          || null;
  }
  if (!target) throw new Error(`No program matching ${program_id ?? program_name}`);
  const previous = programs.find(p => p.is_active);
  await _post(`/api/programs/${target.id}/activate`);
  return {
    active_program_id: target.id,
    previous_active_program_id: previous && previous.id !== target.id ? previous.id : null,
    name: target.name,
  };
}

async function _addCoachPrescription({ trainee_id, template_id, target_date, notes }) {
  if (trainee_id == null || template_id == null || !target_date) {
    throw new Error('trainee_id, template_id, and target_date are required');
  }
  try {
    const row = await _post(`/api/trainer/members/${Number(trainee_id)}/prescriptions`, {
      template_id: Number(template_id),
      date: target_date,
      notes: notes || null,
    });
    return {
      prescription_id: row?.id,
      trainee_id: Number(trainee_id),
      template_id: Number(template_id),
      target_date,
    };
  } catch (e) {
    // Requires coach/admin + ownership of the trainee. Surface a
    // human-legible error so the model can relay it.
    const msg = e?.message || 'Failed to create prescription';
    if (/not your member|forbidden|403/i.test(msg)) {
      throw new Error('Only a coach or admin can prescribe workouts to their own members.');
    }
    throw e;
  }
}
