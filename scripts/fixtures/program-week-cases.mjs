// The cases excused days pausing a calendar-mode program (issue #121) is
// held to: fed to both copies of the plan-week rule (server/lib/programWeek.js
// and src/lib/programWeek.js, program-week.test.js), and the dated ones
// below to the real server (program-pause-server.test.js) and to the
// phone's own copy, standalone (android-sync.test.js). One set of answers
// for all of them.

/** Thursday 2026-10-15, noon UTC. */
export const NOW = Date.parse('2026-10-15T12:00:00Z');
const cal = (extra = {}) => ({ advance_mode: 'calendar', duration_weeks: 4, on_complete: 'hold', ...extra });
const from1 = { start_date: '2026-10-01' }; // 14 days before NOW: week 3

export const CASES = [
  { why: 'no excused days: 14 days in is week 3', program: cal(), assignment: from1, expect: { week: 3, pausedDays: 0 } },
  { why: 'an excused day before the start pauses nothing', program: cal(), assignment: from1, excused: ['2026-09-30', '2026-09-01'], expect: { week: 3, pausedDays: 0 } },
  { why: 'one on the start day pauses a day', program: cal(), assignment: from1, excused: ['2026-10-01'], expect: { week: 2, pausedDays: 1 } },
  { why: 'one today pauses a day', program: cal(), assignment: from1, excused: ['2026-10-15'], expect: { week: 2, pausedDays: 1 } },
  { why: 'days ahead wait until they come', program: cal(), assignment: from1, excused: ['2026-10-16', '2026-10-20'], expect: { week: 3, pausedDays: 0 } },
  { why: 'a day trained on gives its day back', program: cal(), assignment: from1, excused: ['2026-10-05', '2026-10-06'], trained: ['2026-10-06'], expect: { week: 2, pausedDays: 1 } },
  { why: 'a removed excuse pauses nothing', program: cal(), assignment: from1, excused: [{ date: '2026-10-05', deleted_at: '2026-10-06 10:00:00' }], expect: { week: 3, pausedDays: 0 } },
  { why: 'rows with a date read like dates, once each', program: cal(), assignment: from1, excused: [{ date: '2026-10-05' }, '2026-10-05', { date: '2026-10-07' }], expect: { week: 2, pausedDays: 2 } },
  { why: 'eight days paused: back to week 1', program: cal(), assignment: from1, excused: ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], expect: { week: 1, pausedDays: 8 } },
  { why: 'with no start date, from the day it was assigned (a SQLite stamp, UTC)', program: cal(), assignment: { assigned_at: '2026-10-01 08:00:00' }, excused: ['2026-09-30', '2026-10-01'], expect: { week: 2, pausedDays: 1 } },
  {
    why: 'a chosen week: only days from the pin on count',
    program: cal(), assignment: { start_date: '2026-09-01', week_cursor: 2, week_cursor_pinned_at: '2026-10-08T09:00:00.000Z' },
    excused: ['2026-10-03', '2026-10-07', '2026-10-08', '2026-10-10'], expect: { week: 2, pausedDays: 2 },
  },
  { why: 'a chosen week with nothing excused moves on after 7 days', program: cal(), assignment: { start_date: '2026-09-01', week_cursor: 2, week_cursor_pinned_at: '2026-10-08T09:00:00.000Z' }, excused: ['2026-10-03'], expect: { week: 3, pausedDays: 0 } },
  {
    why: 'hold: a day after the last week is over pauses nothing',
    program: cal({ duration_weeks: 2 }), assignment: { start_date: '2026-09-20' },
    excused: ['2026-09-22', '2026-10-10'], expect: { week: 2, pausedDays: 1 },
  },
  {
    why: 'repeat: every day counts, and the week loops',
    program: cal({ duration_weeks: 2, on_complete: 'repeat' }), assignment: { start_date: '2026-09-29' },
    excused: ['2026-09-30', '2026-10-02', '2026-10-12'], expect: { week: 2, pausedDays: 3 },
  },
  { why: 'repeat with nothing excused loops to week 1', program: cal({ duration_weeks: 2, on_complete: 'repeat' }), assignment: { start_date: '2026-09-29' }, expect: { week: 1, pausedDays: 0 } },
  { why: 'advanced by sessions: never paused', program: { advance_mode: 'sessions', duration_weeks: 4 }, assignment: from1, sessions: 4, perWeek: 3, excused: ['2026-10-05'], expect: { week: 2, pausedDays: 0 } },
  { why: 'a one-week program: never paused', program: cal({ duration_weeks: 1 }), assignment: from1, excused: ['2026-10-05'], expect: { week: 1, pausedDays: 0 } },
  { why: 'a start date ahead: week 1, nothing paused', program: cal(), assignment: { start_date: '2026-10-20' }, excused: ['2026-10-14', '2026-10-21'], expect: { week: 1, pausedDays: 0 } },
  // Day boundaries: excused days are calendar dates in the athlete's zone;
  // at NOW it's already the 16th in Auckland and still the 15th in New York.
  { why: "Auckland: the 16th is today there, so it counts (day 14 from the 2nd)", program: cal(), assignment: { start_date: '2026-10-02' }, excused: ['2026-10-16'], timeZone: 'Pacific/Auckland', expect: { week: 2, pausedDays: 1 } },
  { why: 'New York: the 16th is tomorrow there, so it waits', program: cal(), assignment: from1, excused: ['2026-10-16'], timeZone: 'America/New_York', expect: { week: 3, pausedDays: 0 } },
  {
    why: "Auckland: an assignment stamped late on the 1st UTC began on the 2nd there",
    program: cal(), assignment: { assigned_at: '2026-10-01 23:30:00' }, excused: ['2026-10-01', '2026-10-02'], timeZone: 'Pacific/Auckland',
    expect: { week: 2, pausedDays: 1 },
  },
  // 10 pm on the 15th in New York is 2 am on the 16th UTC: still day 14
  // there, so one excused day puts it back in week 2 (counting 24-hour
  // blocks from UTC midnight said day 15, week 3, paused or not).
  { why: 'New York, late evening: the clock runs on New York days too', program: cal(), assignment: from1, excused: ['2026-10-10'], timeZone: 'America/New_York', now: Date.parse('2026-10-16T02:00:00Z'), expect: { week: 2, pausedDays: 1 } },
  { why: 'the week moves at midnight in the zone, not at the hour it was assigned', program: cal(), assignment: { assigned_at: '2026-10-08 20:00:00' }, timeZone: 'UTC', now: Date.parse('2026-10-15T00:30:00Z'), expect: { week: 2, pausedDays: 0 } },
];

/** The options planWeekState takes for a case. */
export function optsFor(c) {
  return {
    sessionsInProgram: c.sessions || 0,
    sessionsPerWeek: c.perWeek || 1,
    excusedDays: c.excused || [],
    trainedDays: new Set(c.trained || []),
    now: c.now || NOW,
    timeZone: c.timeZone || 'UTC',
  };
}

/**
 * Dated from a real today (YYYY-MM-DD, UTC) for a live server or phone: a
 * 4-week calendar program that started 14 days ago (week 3), with an excuse
 * before the start, on the start day, 4 days ago, 3 days ago (trained on)
 * and tomorrow. Two count, so it's week 2 with 2 days paused.
 */
export function datedCase(today) {
  const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  return {
    start: day(-14),
    excused: { before: day(-16), start: day(-14), counted: day(-4), trained: day(-3), ahead: day(1) },
    expect: { week: 2, pausedDays: 2 },
    // Removing the start day's excuse and training on the counted one.
    afterUndo: { week: 3, pausedDays: 0 },
  };
}
