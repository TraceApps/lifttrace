/**
 * Weekly summary (issue #98): enough to answer "did the week go as planned"
 * and "am I still moving" without opening the app.
 *
 * Pure: takes the user's workouts and exercise library, returns numbers.
 * The scheduler does the database reads, email.js does the layout, and
 * scripts/weekly-summary.test.js runs this directly.
 *
 * The week is the last seven local dates, today included, so a Sunday
 * evening summary counts Sunday's session. The comparison is the average
 * week over the 28 days before that: steadier than last week alone, so one
 * missed session doesn't read as a collapse.
 */
import { setVolume, resolveLoadType, isTimedSet, newRecord, accumulateRecord } from './volume.js';
import { normalizeMuscle } from './muscle-groups.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD shifted by whole days, without touching time zones. */
export function shiftDate(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function _exercisesOf(row) {
  if (Array.isArray(row.exercises)) return row.exercises;
  try { return JSON.parse(row.exercises || '[]'); } catch { return []; }
}

const _working = (s) => s && s.completed && !s.warmup;

/**
 * @param {object} p
 * @param {Array}  p.workouts  every live workout_log row for the user (any date order)
 * @param {Map}    p.library   exercise_id -> { muscles: string[], category, load_type }
 * @param {string} p.today     local YYYY-MM-DD for the user
 * @param {number} p.goal      sessions planned per week
 */
export function buildWeeklySummary({ workouts, library = new Map(), today, goal = 0 }) {
  const end = today;
  const start = shiftDate(today, -6);
  const prevStart = shiftDate(start, -28);

  const blank = () => ({ sessions: 0, sets: 0, volume: 0, minutes: 0 });
  const week = blank();
  const prior = blank();
  const muscles = {};
  const before = {};   // best per exercise from history before this week
  const after = {};    // best per exercise including this week

  const rows = workouts
    .map(r => ({ ...r, exercises: _exercisesOf(r) }))
    .filter(r => r.date && r.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const row of rows) {
    const inWeek = row.date >= start;
    const inPrior = !inWeek && row.date >= prevStart;
    const bucket = inWeek ? week : inPrior ? prior : null;
    let workingSets = 0;

    for (const ex of row.exercises) {
      const info = library.get(ex.exercise_id) || { muscles: [], category: 'other', load_type: null };
      const loadType = resolveLoadType(ex, info.load_type);
      const key = ex.exercise_id || ex.exercise_name;
      const groups = [...new Set((info.muscles.length ? info.muscles : [info.category]).map(normalizeMuscle))];

      for (const set of ex.sets || []) {
        if (!_working(set)) continue;
        workingSets++;
        if (!inWeek) {
          if (!before[key]) before[key] = newRecord(ex.exercise_name);
          accumulateRecord(before[key], ex, set, row.date);
        }
        if (!after[key]) after[key] = newRecord(ex.exercise_name);
        accumulateRecord(after[key], ex, set, row.date);
        if (!bucket) continue;
        bucket.sets++;
        if (!isTimedSet(ex, set)) bucket.volume += setVolume(set, loadType);
        if (inWeek) for (const g of groups) muscles[g] = (muscles[g] || 0) + 1;
      }
    }

    // A session is a workout with at least one completed working set; a day
    // opened and never logged is not training.
    if (bucket && workingSets > 0) {
      bucket.sessions++;
      bucket.minutes += Number(row.duration_min) > 0 ? Number(row.duration_min) : 0;
    }
  }

  // A PR is a new best set this week on a lift you had trained before, so a
  // first ever session doesn't count every exercise as a record.
  const prs = [];
  for (const [key, a] of Object.entries(after)) {
    const b = before[key];
    if (!b) continue;
    if (b.maxWeight > 0 && a.maxWeight > b.maxWeight && a.date >= start) {
      prs.push({ name: a.name, weight: a.maxWeight, reps: a.maxReps });
    } else if (b.maxDuration > 0 && a.maxDuration > b.maxDuration && a.durationDate >= start) {
      prs.push({ name: a.name, durationSec: a.maxDuration, weight: a.maxDurationWeight || 0 });
    }
  }
  prs.sort((x, y) => (x.name || '').localeCompare(y.name || ''));

  const avg = {
    sessions: prior.sessions / 4,
    sets: prior.sets / 4,
    volume: prior.volume / 4,
    minutes: prior.minutes / 4,
  };

  return {
    start, end,
    goal: Number(goal) > 0 ? Number(goal) : 0,
    week: { ...week, volume: Math.round(week.volume) },
    avg,
    hasBaseline: prior.sessions > 0,
    prs,
    muscles: Object.entries(muscles)
      .map(([muscle, sets]) => ({ muscle, sets }))
      .sort((x, y) => y.sets - x.sets || x.muscle.localeCompare(y.muscle)),
  };
}

/** Whole-percent change against the average week, or null when there's nothing to compare. */
export function changeVsAvg(current, average) {
  if (!(average > 0)) return null;
  return Math.round(((current - average) / average) * 100);
}

export function fmtMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function fmtHold(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One line for the push notification. */
export function summaryLine(summary, { unit = 'lbs', locale = 'en' } = {}) {
  const nf = new Intl.NumberFormat(locale);
  const { week, goal, prs } = summary;
  if (!week.sessions) return 'No workouts logged this week.';
  const parts = [goal ? `${week.sessions} of ${goal} sessions` : `${week.sessions} ${week.sessions === 1 ? 'session' : 'sessions'}`];
  parts.push(`${nf.format(week.sets)} sets`);
  if (prs.length) parts.push(`${prs.length} ${prs.length === 1 ? 'PR' : 'PRs'}`);
  if (week.volume > 0) {
    const pct = summary.hasBaseline ? changeVsAvg(week.volume, summary.avg.volume) : null;
    parts.push(`${nf.format(week.volume)} ${unit} volume${pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct}% vs your 4-week average)`}`);
  }
  return parts.join(', ') + '.';
}
