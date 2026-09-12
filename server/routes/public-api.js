/**
 * server/routes/public-api.js, versioned public REST API (issue #77).
 *
 * Mounted at /api/v1 when PUBLIC_API_ENABLED=1 in the server env. Off by
 * default, so no existing user sees any change. Companion to the MCP
 * server (issue #78): MCP serves MCP-protocol clients, this serves plain
 * scripts and automations (curl, a Home Assistant REST sensor, a Node
 * script) that just want a normal JSON HTTP endpoint.
 *
 * Every route calls the exact same xCore() function the matching MCP
 * tool calls (server/lib/mcp/tools/*.js), extracted in a prior commit
 * specifically so this file doesn't become a fourth copy of the same
 * queries. Responses are the bare data object as JSON, not MCP's
 * toolResult envelope, so this reads like a normal REST API rather than
 * an MCP-JSON-RPC shape wrapped in HTTP.
 *
 * Auth: bearer token via the same api_tokens table and mcp:read/mcp:write
 * scopes MCP already uses (see server/lib/api-tokens.js). One token then
 * works for both MCP and REST access; a scope describes what class of
 * access it grants, not which protocol carries it. Write routes
 * additionally require PUBLIC_API_WRITE_ENABLED=1 on the server, mirrors
 * MCP's own MCP_ENABLED/MCP_WRITE_ENABLED split so a self-hoster can
 * expose read-only external access without ever opening a write surface.
 *
 * No Origin/DNS-rebinding check here (unlike /api/mcp): that defense
 * exists specifically for browser-based MCP Inspector-style clients:
 * this API's target audience is server-to-server scripts, no
 * browser-Origin threat model to defend against, same posture as
 * api-tokens.js's own bearer-consuming surface.
 *
 * Deliberately deferred: no DELETE /api/v1/workouts/:date. delete_workout
 * is MCP's one triple-gated tool (MCP_DESTROY_ENABLED + mcp:destroy scope
 * + confirm:true) precisely because it's an irreversible hard delete, not
 * worth a PUBLIC_API_DESTROY_ENABLED flag for a capability nobody has
 * asked for on this surface yet.
 */
import { Router } from 'express';
import { bearerAuth, requireScope } from '../middleware/bearer-auth.js';
import { wrap } from '../logger.js';
import { getWorkoutCore } from '../lib/mcp/tools/get-workout.js';
import { listRecentWorkoutsCore } from '../lib/mcp/tools/list-recent-workouts.js';
import { getRecordsCore } from '../lib/mcp/tools/get-records.js';
import { getExerciseProgressCore } from '../lib/mcp/tools/get-exercise-progress.js';
import { searchExercisesCore } from '../lib/mcp/tools/search-exercises.js';
import { listProgramsCore } from '../lib/mcp/tools/list-programs.js';
import { getActiveProgramCore } from '../lib/mcp/tools/get-active-program.js';
import { getBodyStatCore } from '../lib/mcp/tools/get-body-stat.js';
import { logSetCore } from '../lib/mcp/tools/log-set.js';
import { logBodyStatCore } from '../lib/mcp/tools/log-body-stat.js';

const router = Router();

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const ENABLED       = _envFlag(process.env.PUBLIC_API_ENABLED);
const WRITE_ENABLED = _envFlag(process.env.PUBLIC_API_WRITE_ENABLED);

// Base gate BEFORE bearer auth, so a probe against a disabled endpoint
// can't burn a valid token's rate-limit budget. Same ordering as mcp.js.
router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).json({ error: 'Public API not enabled on this server' });
  next();
});
router.use(bearerAuth);

// A write route also needs the server-side flag on, independent of the
// token's own mcp:write scope (checked separately via requireScope
// below). Both must be true, same two-gate pattern MCP uses for its own
// write tools.
function requireWriteEnabled(req, res, next) {
  if (!WRITE_ENABLED) {
    return res.status(404).json({ error: 'Public API writes not enabled on this server' });
  }
  next();
}

// Wraps an xCore() call: runs it, sends the plain result as JSON. A
// thrown Error (invalid date, exercise not found, etc) maps to 400; any
// other exception falls through to wrap()'s normal 500 path via next(e).
function core(fn) {
  return wrap(async (req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

router.get('/workouts/recent', requireScope('mcp:read'), core(req =>
  listRecentWorkoutsCore(req.apiUser.id, { limit: req.query.limit ? Number(req.query.limit) : undefined })
));

router.get('/workouts/:date', requireScope('mcp:read'), core(req =>
  getWorkoutCore(req.apiUser.id, { date: req.params.date })
));

router.get('/records', requireScope('mcp:read'), core(req =>
  getRecordsCore(req.apiUser.id, { exercise_name: req.query.exercise_name })
));

router.get('/exercises', requireScope('mcp:read'), core(req =>
  searchExercisesCore(req.apiUser.id, {
    query: req.query.query,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  })
));

router.get('/exercises/:name/progress', requireScope('mcp:read'), core(req =>
  getExerciseProgressCore(req.apiUser.id, {
    exercise_name: req.params.name,
    start: req.query.start,
    end: req.query.end,
  })
));

router.get('/programs', requireScope('mcp:read'), core(req =>
  listProgramsCore(req.apiUser.id)
));

router.get('/programs/active', requireScope('mcp:read'), core(req =>
  getActiveProgramCore(req.apiUser.id)
));

router.get('/body-stats/:date', requireScope('mcp:read'), core(req =>
  getBodyStatCore(req.apiUser.id, { date: req.params.date })
));

router.post('/workouts/:date/sets', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logSetCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

router.put('/body-stats/:date', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logBodyStatCore(req.apiUser.id, { ...req.body, date: req.params.date })
));

export default router;
