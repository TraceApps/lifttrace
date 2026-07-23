/**
 * programWeek.js — resolve an athlete's current plan week for a multi-week
 * progression program (issue #13).
 *
 * A program has `duration_weeks` (default 1 = non-progressed), an
 * `advance_mode` ('sessions' | 'calendar') and an `on_complete` policy
 * ('hold' | 'repeat'). The assignment may carry a manual `week_cursor`
 * (with `week_cursor_session_base`) so the athlete can repeat/regress a week.
 *
 * Used by routes/programs.js now; importable by AI/coaching context later.
 */

/**
 * @param {object} program    - programs row (duration_weeks, advance_mode, on_complete)
 * @param {object} assignment - program_assignments row (start_date, assigned_at,
 *                               week_cursor, week_cursor_session_base) — may be null
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
    // the same clock the program uses — calendar weeks since the pin, or
    // sessions logged after it.
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
    // Default: advance by sessions completed.
    week = Math.floor(sessionsInProgram / perWeek) + 1;
  }

  if (program?.on_complete === 'repeat') {
    // Loop back to week 1 past the end. week is 1-based.
    return ((week - 1) % duration + duration) % duration + 1;
  }
  // Hold on the final week (and never below week 1).
  return Math.min(duration, Math.max(1, week));
}
