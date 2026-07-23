/**
 * programWeek.js — client mirror of server/lib/programWeek.js (issue #13).
 *
 * The standalone (offline) Android build resolves an athlete's current plan
 * week locally, since there's no server to compute `current_week` for it.
 * Keep this in lock-step with server/lib/programWeek.js — same inputs, same
 * output — so a workout resolves to the same week whether the app is online
 * (server-computed) or offline (computed here).
 *
 * @param {object} program    - programs row (duration_weeks, advance_mode, on_complete)
 * @param {object} assignment - program_assignments row (start_date, assigned_at,
 *                               week_cursor, week_cursor_session_base,
 *                               week_cursor_pinned_at) — may be null
 * @param {object} opts
 * @param {number} opts.sessionsInProgram - completed program-attributed sessions
 * @param {number} opts.sessionsPerWeek   - workouts that make up one plan week
 * @returns {number} current plan week, 1-based
 */
export function currentPlanWeek(program, assignment, { sessionsInProgram = 0, sessionsPerWeek = 1 } = {}) {
  const duration = Math.max(1, program?.duration_weeks || 1);
  const perWeek = Math.max(1, sessionsPerWeek || 1);
  const mode = program?.advance_mode || 'sessions';

  let week;
  const cursor = assignment?.week_cursor;
  if (cursor != null) {
    // Manual pin: current week starts at the cursor and auto-advances past it
    // so repeating a week doesn't strand the athlete there forever. Advance by
    // the same clock the program uses.
    if (mode === 'calendar') {
      const pinnedAt = assignment?.week_cursor_pinned_at;
      const since = pinnedAt ? new Date(pinnedAt).getTime() : Date.now();
      const days = Math.max(0, Math.floor((Date.now() - since) / 86400000));
      week = cursor + Math.floor(days / 7);
    } else {
      const base = assignment?.week_cursor_session_base || 0;
      const since = Math.max(0, sessionsInProgram - base);
      week = cursor + Math.floor(since / perWeek);
    }
  } else if (mode === 'calendar') {
    const anchor = assignment?.start_date || assignment?.assigned_at;
    const since = anchor ? new Date(anchor).getTime() : Date.now();
    const days = Math.max(0, Math.floor((Date.now() - since) / 86400000));
    week = Math.floor(days / 7) + 1;
  } else {
    week = Math.floor(sessionsInProgram / perWeek) + 1;
  }

  if (program?.on_complete === 'repeat') {
    return ((week - 1) % duration + duration) % duration + 1;
  }
  return Math.min(duration, Math.max(1, week));
}
