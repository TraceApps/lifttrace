/**
 * MCP tool registrar (issue #78). Called once per request when the
 * McpServer is built. Each tool is registered against the user
 * identified by ctx.userId — the token that hit the MCP endpoint owns
 * the scope of every query. No cross-user access is possible from an
 * MCP handler; every DB query in each tool includes `WHERE user_id = ?`.
 *
 * Write tools are registered ONLY when the request context reports
 * writes: true — that requires BOTH the server-side MCP_WRITE_ENABLED
 * flag AND the caller's token holding the `mcp:write` scope. Destroy
 * tools require BOTH MCP_DESTROY_ENABLED AND `mcp:destroy`. If either
 * half of a gate is absent the corresponding tools don't appear in
 * tools/list at all, so an agent has no way to attempt them.
 */
import { registerGetWorkout } from './get-workout.js';
import { registerListRecentWorkouts } from './list-recent-workouts.js';
import { registerGetRecords } from './get-records.js';
import { registerGetExerciseProgress } from './get-exercise-progress.js';
import { registerSearchExercises } from './search-exercises.js';
import { registerListPrograms } from './list-programs.js';
import { registerGetActiveProgram } from './get-active-program.js';
import { registerGetBodyStat } from './get-body-stat.js';
import { registerLogSet } from './log-set.js';
import { registerLogBodyStat } from './log-body-stat.js';
import { registerDeleteWorkout } from './delete-workout.js';

export function registerReadTools(server, ctx) {
  registerGetWorkout(server, ctx);
  registerListRecentWorkouts(server, ctx);
  registerGetRecords(server, ctx);
  registerGetExerciseProgress(server, ctx);
  registerSearchExercises(server, ctx);
  registerListPrograms(server, ctx);
  registerGetActiveProgram(server, ctx);
  registerGetBodyStat(server, ctx);
}

export function registerWriteTools(server, ctx) {
  registerLogSet(server, ctx);
  registerLogBodyStat(server, ctx);
}

export function registerDestroyTools(server, ctx) {
  registerDeleteWorkout(server, ctx);
}
