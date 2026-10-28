/**
 * Excused days pause a calendar-mode program (issue #121): what
 * programWeek.js needs to say so for one account, gathered here so every
 * place that reports a plan week (routes/programs.js, the coach's view of a
 * client in routes/trainer.js, MCP get_active_program, /api/v1, the
 * program.advanced webhook) counts the same days.
 */
import { listExcusedDays } from './excused-days.js';
import { trainedDateSet } from './trained-days.js';
import { pauseWindow, planWeekState } from './programWeek.js';
import { isValidTimeZone } from './zoned-time.js';

/**
 * The athlete's zone as the app says it (`?tz=`), when it's a real one;
 * otherwise undefined, and "today" is the server's.
 */
export function zoneFrom(value) {
  return isValidTimeZone(value) ? value : undefined;
}

/**
 * planWeekState for `userId`'s `assignment` of `program`, with the
 * account's excused and trained days read for its pause window.
 * `cardio`: the app's Track Cardio switch, as statistics take it
 * (trained-days.js cardioCounts); `timeZone`: see zoneFrom.
 */
export function planWeekFor(userId, program, assignment, { sessionsInProgram = 0, sessionsPerWeek = 1, timeZone, cardio } = {}) {
  const now = Date.now();
  const window = pauseWindow(program, assignment, { now, timeZone });
  const excusedDays = window ? listExcusedDays(userId, { start: window.from, end: window.to }).map(r => r.date) : [];
  // Only the excused days' own dates need the trained-day rule: nothing
  // excused, no workouts read.
  const trainedDays = excusedDays.length
    ? trainedDateSet(userId, { start: excusedDays[0], end: excusedDays[excusedDays.length - 1], cardio })
    : new Set();
  return planWeekState(program, assignment, { sessionsInProgram, sessionsPerWeek, now, timeZone, excusedDays, trainedDays });
}
