/**
 * trained-day.js: the one rule for whether a day was trained, and what an
 * excused day does to the weekly goal (issue #121).
 *
 * A day was trained when it has at least one completed working set (a
 * warm-up alone doesn't count, and neither does a workout opened, cleared or
 * never started), or a cardio session while Track Cardio is on. Several
 * workouts on one day are still one trained day.
 *
 * Every place that decides it uses this file: the server's statistics,
 * streaks, weekly summary, reminders and coaching view, and the app's Diary,
 * Statistics and the phone's own statistics (api-native.js). Before it, the
 * Diary counted cardio and the server didn't, the weekly ring counted
 * finished sessions rather than days, and the weekly summary left warm-ups
 * out while the streak didn't.
 *
 * Pure, with no imports, so the server can load it from here: it imports
 * ../../src/lib/trained-day.js, and the Dockerfile copies this file to that
 * place in the image, as it does the exercise-source fetchers.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A real calendar date written YYYY-MM-DD (not 2026-02-30). */
export function isCalendarDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** YYYY-MM-DD moved by whole days. Calendar days, so no time zone moves it. */
export function shiftDate(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of a date's week (weeks start on Monday everywhere in the app). */
export function weekStartOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = d.getUTCDay();
  return shiftDate(ymd, -(day === 0 ? 6 : day - 1));
}

/** A workout row's exercises, whether stored as JSON text or already read. */
export function exercisesOf(row) {
  const raw = row?.exercises;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** At least one completed set that isn't a warm-up. */
export function hasWorkingSet(exercises) {
  if (!Array.isArray(exercises)) return false;
  return exercises.some(ex => (ex?.sets || []).some(s => s && s.completed && !s.warmup));
}

/** Does this workout row make its day a trained day? */
export function workoutCounts(row) {
  return !!row && !row.deleted_at && hasWorkingSet(exercisesOf(row));
}

/**
 * The trained days among `workouts` (workout_log rows) and `cardio`
 * (cardio_log rows), as a Set of YYYY-MM-DD. Cardio counts only while it's
 * turned on (`cardioOn`): with it off the Diary doesn't show it, so it gives
 * no credit either.
 */
export function trainedDates({ workouts = [], cardio = [], cardioOn = false } = {}) {
  const out = new Set();
  for (const w of workouts || []) {
    if (w?.date && workoutCounts(w)) out.add(String(w.date).slice(0, 10));
  }
  if (cardioOn) {
    for (const c of cardio || []) {
      if (c?.date && !c.deleted_at) out.add(String(c.date).slice(0, 10));
    }
  }
  return out;
}

/**
 * Consecutive trained days ending today, or ending yesterday when today
 * isn't trained yet (so a streak doesn't read 0 every morning). An excused
 * day is not a trained day: it ends a streak like any day off.
 */
export function currentStreak(dates, today) {
  let start = today;
  if (!dates.has(start)) start = shiftDate(today, -1);
  let n = 0;
  for (let d = start; dates.has(d); d = shiftDate(d, -1)) n++;
  return n;
}

/** The longest run of consecutive trained days. */
export function longestStreak(dates) {
  let best = 0, run = 0, prev = null;
  for (const d of [...dates].sort()) {
    run = prev && shiftDate(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

const _inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

/** Trained days per Monday week in a range: [{ week, count }], oldest first. */
export function trainedDaysByWeek(dates, from, to) {
  const byWeek = {};
  for (const d of dates) {
    if (!_inRange(d, from, to)) continue;
    const w = weekStartOf(d);
    byWeek[w] = (byWeek[w] || 0) + 1;
  }
  return Object.keys(byWeek).sort().map(week => ({ week, count: byWeek[week] }));
}

/** Trained days per weekday in a range: [{ day: 0 (Sunday) .. 6, count }]. */
export function weekdayCounts(dates, from, to) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dates) {
    if (_inRange(d, from, to)) out[new Date(`${d}T00:00:00Z`).getUTCDay()]++;
  }
  return out.map((count, day) => ({ day, count }));
}

/**
 * Where a week stands against the weekly goal (days to train per week).
 * Each excused day in the week takes one day off the target, never below
 * zero: 4 planned with 1 excused and 3 trained is 3 of 3. A week with
 * every planned day excused is an excused week, not a goal met.
 *
 * `trained` and `excused` are Sets of dates; only those from `start` to
 * `end` count, and a day in both counts as trained.
 * Returns { goal, count, excused, target, left, pct, met, allExcused }.
 */
export function weeklyGoal({ goal, trained = new Set(), excused = new Set(), start, end }) {
  const g = Math.max(0, Math.floor(Number(goal) || 0));
  let count = 0, off = 0;
  for (const d of trained) if (_inRange(d, start, end)) count++;
  for (const d of excused) if (_inRange(d, start, end) && !trained.has(d)) off++;
  const target = Math.max(0, g - off);
  const allExcused = g > 0 && target === 0;
  return {
    goal: g,
    count,
    excused: off,
    target,
    left: Math.max(0, target - count),
    pct: target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0,
    met: target > 0 && count >= target,
    allExcused,
  };
}
