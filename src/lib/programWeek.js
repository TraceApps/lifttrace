/**
 * programWeek.js: client mirror of server/lib/programWeek.js (issues #13,
 * #121).
 *
 * The Android app resolves an athlete's current plan week locally (on its
 * own, and connected, where programs read from the phone's copy first), so
 * there's no server to compute `current_week` for it. Keep everything below
 * this comment identical to server/lib/programWeek.js (program-week.test.js
 * checks, and runs scripts/fixtures/program-week-cases.mjs through both), so
 * a workout resolves to the same week online and off.
 */

const DAY_MS = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * An anchor's instant in ms. A bare date is its UTC midnight (as before); a
 * SQLite `datetime('now')` stamp ("2026-10-27 14:05:00") is UTC, so it reads
 * the same on a server in any zone and on a phone; anything else is ISO.
 * NaN when it can't be read.
 */
export function anchorTime(value) {
  if (value == null || value === '') return NaN;
  const s = String(value);
  if (SQLITE_UTC.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
  return new Date(s).getTime();
}

/** The calendar day (YYYY-MM-DD) of an instant in `timeZone`, or this device's zone. */
export function dayOf(ms, timeZone) {
  if (!Number.isFinite(ms)) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  }
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const _dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

// What the calendar clock runs from: the week pin's time when the week was
// chosen, else the program's start date, else when it was assigned.
function _clock(assignment) {
  const pinned = assignment?.week_cursor != null;
  const value = pinned
    ? assignment?.week_cursor_pinned_at
    : (assignment?.start_date || assignment?.assigned_at);
  return { pinned, value: value || null };
}

/**
 * The days a calendar-mode program counts excused days in (issue #121):
 * from its anchor's day (the start date, the day it was assigned, or the
 * day a week was chosen) to today, both included. Null for a program that
 * doesn't pause: advanced by sessions, one week long, or with no anchor.
 * Callers read the excused and trained days in this range and pass them in.
 * @returns {{ from: string, to: string } | null}
 */
export function pauseWindow(program, assignment, { now = Date.now(), timeZone } = {}) {
  if ((program?.advance_mode || 'sessions') !== 'calendar') return null;
  if (Math.max(1, program?.duration_weeks || 1) <= 1) return null;
  const from = _anchorDay(assignment, timeZone);
  const to = dayOf(now, timeZone);
  if (!from || !to || from > to) return null;
  return { from, to };
}

// The calendar day the clock runs from: a start date as written, a time as
// the day it fell on in `timeZone`. Null with no anchor or one unreadable.
function _anchorDay(assignment, timeZone) {
  return _dayOfValue(_clock(assignment).value, timeZone);
}

// A date as written, or the day a time fell on in `timeZone`; null for none.
function _dayOfValue(value, timeZone) {
  if (!value) return null;
  return YMD.test(String(value)) ? String(value) : dayOf(anchorTime(value), timeZone);
}

/**
 * Whole calendar days (in `timeZone`) from the day `value` fell on (a
 * date, a SQLite UTC stamp or ISO) to today, counted at local midnight like
 * the calendar clock: the Programs card's "Week N" for a one-week program.
 * Below zero for a day ahead; null when there's none or it can't be read.
 */
export function calendarDaysSince(value, { now = Date.now(), timeZone } = {}) {
  const from = _dayOfValue(value, timeZone);
  const today = dayOf(now, timeZone);
  if (!from || !today) return null;
  return _dayNumber(today) - _dayNumber(from);
}

/**
 * Where an athlete is in a program: { week, pausedDays }.
 *
 * Calendar mode moves a week every 7 calendar days (in `timeZone`) from the
 * anchor's day: the start date, the day it was assigned, or the day a week
 * was chosen. Each excused day
 * (issue #121) in pauseWindow that wasn't trained pushes it back a day:
 * `excusedDays` are the account's excused dates (strings, or rows with a
 * `date`), `trainedDays` a Set of trained dates by the shared rule
 * (src/lib/trained-day.js). A day ahead of today doesn't count until it
 * comes; a day trained on, or no longer excused, gives its day back. With a
 * week chosen by hand only days from that one on count. A program set to
 * Hold stops counting once it is on its last week, where a day can't move
 * it any more; a day that keeps it out of the last week still counts.
 * Sessions mode never pauses.
 *
 * @param {object} program    - programs row (duration_weeks, advance_mode, on_complete)
 * @param {object} assignment - program_assignments row (start_date, assigned_at,
 *                               week_cursor, week_cursor_session_base,
 *                               week_cursor_pinned_at), may be null
 * @param {object} opts
 * @param {number} opts.sessionsInProgram - completed program-attributed sessions
 * @param {number} opts.sessionsPerWeek   - workouts that make up one plan week
 * @param {Iterable} [opts.excusedDays]   - excused dates
 * @param {Set<string>} [opts.trainedDays] - trained dates
 * @param {number} [opts.now]             - the time now, in ms
 * @param {string} [opts.timeZone]        - the athlete's IANA zone, for "today"
 */
export function planWeekState(program, assignment, {
  sessionsInProgram = 0, sessionsPerWeek = 1, excusedDays = [], trainedDays = new Set(), now = Date.now(), timeZone,
} = {}) {
  const duration = Math.max(1, program?.duration_weeks || 1);
  const perWeek = Math.max(1, sessionsPerWeek || 1);
  const mode = program?.advance_mode || 'sessions';
  const cursor = assignment?.week_cursor;

  let week;
  let pausedDays = 0;
  if (mode === 'calendar') {
    // Manual pin: the week starts at the cursor and moves on from the day
    // it was chosen, so repeating a week doesn't strand the athlete there.
    // Calendar days in the athlete's zone, the same days excused days are:
    // a start date is that day, whatever the zone, and the week moves on at
    // their midnight.
    const pinned = cursor != null;
    const anchor = _anchorDay(assignment, timeZone);
    const today = dayOf(now, timeZone);
    const days = anchor && today ? Math.max(0, _dayNumber(today) - _dayNumber(anchor)) : 0;
    const window = pauseWindow(program, assignment, { now, timeZone });
    if (window) {
      const trained = trainedDays instanceof Set ? trainedDays : new Set(trainedDays || []);
      const dates = new Set();
      for (const e of excusedDays || []) {
        const d = typeof e === 'string' ? e : e?.date;
        if (!d || (e && typeof e === 'object' && e.deleted_at)) continue;
        if (d >= window.from && d <= window.to && !trained.has(d)) dates.add(d);
      }
      // Hold: the last week starts once `lastWeekAt` days have counted. A
      // day on which more than that had counted already finds the program
      // held there, so it moves nothing; a day on or before it keeps the
      // last week off a day. Counting in date order, the days paused before
      // a day come off first, so an earlier pause still lets it count.
      const weeksLeft = pinned ? duration - cursor + 1 : duration;
      const lastWeekAt = (weeksLeft - 1) * 7;
      const start = _dayNumber(window.from);
      for (const d of [...dates].sort()) {
        if (program?.on_complete !== 'repeat' && (lastWeekAt <= 0 || _dayNumber(d) - start - pausedDays > lastWeekAt)) break;
        pausedDays++;
      }
    }
    const counted = Math.max(0, days - pausedDays);
    week = pinned ? cursor + Math.floor(counted / 7) : Math.floor(counted / 7) + 1;
  } else if (cursor != null) {
    const base = assignment?.week_cursor_session_base || 0;
    const since = Math.max(0, sessionsInProgram - base);
    week = cursor + Math.floor(since / perWeek);
  } else {
    // Default: advance by sessions completed.
    week = Math.floor(sessionsInProgram / perWeek) + 1;
  }

  if (program?.on_complete === 'repeat') {
    // Loop back to week 1 past the end. week is 1-based.
    week = ((week - 1) % duration + duration) % duration + 1;
  } else {
    // Hold on the final week (and never below week 1).
    week = Math.min(duration, Math.max(1, week));
  }
  return { week, pausedDays };
}

/** The current plan week, 1-based (planWeekState's `week`). */
export function currentPlanWeek(program, assignment, opts = {}) {
  return planWeekState(program, assignment, opts).week;
}
