/**
 * Static-analysis tests for the MCP endpoint wiring (issue #78).
 *
 * These do not exercise the wire protocol; they only guard against
 * accidental unwiring of the route mount, the scope registration, or
 * the tool registrations during future refactors. Pure text/regex
 * checks over the source files — no db.js import, so this runs
 * without a compiled better-sqlite3 native binding. End-to-end
 * protocol verification requires running the server with
 * MCP_ENABLED=1 and pointing a real MCP client at it.
 *
 * Ported from NutriTrace's scripts/mcp-wiring.test.js (issue #103) —
 * same checks, LT's actual tool list.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const mcpRoute  = readFileSync(new URL('../server/routes/mcp.js', import.meta.url), 'utf8');
const mcpServer = readFileSync(new URL('../server/lib/mcp/server.js', import.meta.url), 'utf8');
const mcpTools  = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiTokens = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const pkgJson   = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

test('MCP route is mounted at /api/mcp on the main router', () => {
  assert.match(indexJs, /import mcpRoutes[\s\S]*from '\.\/routes\/mcp\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/mcp',\s*mcpRoutes\)/);
});

test('api-tokens route is mounted at /api/admin/api-tokens', () => {
  assert.match(indexJs, /import apiTokensRoutes[\s\S]*from '\.\/routes\/api-tokens\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/api-tokens',\s*apiTokensRoutes\)/);
});

test('MCP route is feature-flagged on MCP_ENABLED and requires bearer + at-least-one mcp:* scope', () => {
  assert.match(mcpRoute, /MCP_ENABLED/);
  assert.match(mcpRoute, /bearerAuth/);
  assert.match(mcpRoute, /requireAnyMcpScope/);
  assert.match(mcpRoute, /'mcp:read'/);
  assert.match(mcpRoute, /'mcp:write'/);
  assert.match(mcpRoute, /'mcp:destroy'/);
});

test('MCP route validates Origin as a DNS-rebinding defense', () => {
  assert.match(mcpRoute, /_isOriginAllowed|Origin not allowed|origin_rejected/);
});

test('mcp:read scope is registered in KNOWN_SCOPES so tokens can hold it', () => {
  assert.match(apiTokens, /'mcp:read'/);
});

test('mcp:write scope is registered', () => {
  assert.match(apiTokens, /'mcp:write'/);
});

test('mcp:destroy scope is registered', () => {
  assert.match(apiTokens, /'mcp:destroy'/);
});

test('every KNOWN_SCOPES entry has a matching SCOPE_DESCRIPTIONS entry and vice versa', () => {
  const known = apiTokens.match(/KNOWN_SCOPES = new Set\(\[([\s\S]*?)\]\)/)[1];
  const knownScopes = [...known.matchAll(/'([\w:]+)'/g)].map(m => m[1]);
  const desc = apiTokens.match(/SCOPE_DESCRIPTIONS = \{([\s\S]*?)\n\};/)[1];
  const descScopes = [...desc.matchAll(/'([\w:]+)':/g)].map(m => m[1]);
  assert.deepEqual([...knownScopes].sort(), [...descScopes].sort());
});

test('MCP route computes write eligibility from MCP_WRITE_ENABLED + mcp:write scope', () => {
  assert.match(mcpRoute, /MCP_WRITE_ENABLED/);
  assert.match(mcpRoute, /mcp:write/);
  assert.match(mcpRoute, /req\.mcpWrites/);
});

test('MCP route computes destroy eligibility from MCP_DESTROY_ENABLED + mcp:destroy scope', () => {
  assert.match(mcpRoute, /MCP_DESTROY_ENABLED/);
  assert.match(mcpRoute, /mcp:destroy/);
  assert.match(mcpRoute, /req\.mcpDestroy/);
});

test('MCP server registers write tools only when req.mcpWrites is true', () => {
  assert.match(mcpServer, /registerWriteTools/);
  assert.match(mcpServer, /req\.mcpWrites/);
});

test('MCP server registers destroy tools only when req.mcpDestroy is true', () => {
  assert.match(mcpServer, /registerDestroyTools/);
  assert.match(mcpServer, /req\.mcpDestroy/);
});

test('MCP transport is stateless (no session id generator)', () => {
  assert.match(mcpServer, /sessionIdGenerator:\s*undefined/);
});

test('All read tools are registered in registerReadTools', () => {
  const expected = [
    'registerGetWorkout',
    'registerListRecentWorkouts',
    'registerGetRecords',
    'registerGetExerciseProgress',
    'registerSearchExercises',
    'registerListPrograms',
    'registerGetActiveProgram',
    'registerGetBodyStat',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All write tools are registered in registerWriteTools', () => {
  const expected = ['registerLogSet', 'registerLogBodyStat'];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All destructive tools are registered in registerDestroyTools', () => {
  const expected = ['registerDeleteWorkout'];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('Every destructive tool requires confirm=true', () => {
  const destroyFiles = ['delete-workout.js'];
  for (const f of destroyFiles) {
    const src = readFileSync(new URL(`../server/lib/mcp/tools/${f}`, import.meta.url), 'utf8');
    assert.match(
      src,
      /confirm\)\s*return toolError|!confirm/,
      `${f} does not appear to require confirm=true — check its input handling`
    );
    assert.match(
      src,
      /confirm:\s*z\.boolean\(\)/,
      `${f} does not declare confirm as a boolean in inputSchema`
    );
  }
});

test('@modelcontextprotocol/sdk and zod are declared as runtime dependencies', () => {
  const deps = pkgJson.dependencies || {};
  assert.ok(deps['@modelcontextprotocol/sdk'], 'missing @modelcontextprotocol/sdk in dependencies');
  assert.ok(deps['zod'], 'missing zod (SDK peer + used for tool inputSchema) in dependencies');
});

test('MCP tool DB queries scope on user_id — no cross-user access', () => {
  // Every tool that queries the DB directly must filter by user_id.
  // If a future tool forgets, this test surfaces it before merge.
  const toolFiles = [
    'get-workout.js',
    'list-recent-workouts.js',
    'get-records.js',
    'get-exercise-progress.js',
    'search-exercises.js',
    'list-programs.js',
    'get-active-program.js',
    'get-body-stat.js',
    'log-set.js',
    'log-body-stat.js',
    'delete-workout.js',
  ];
  for (const f of toolFiles) {
    const src = readFileSync(new URL(`../server/lib/mcp/tools/${f}`, import.meta.url), 'utf8');
    if (/db\.prepare|\.get\(|\.all\(/.test(src)) {
      // Ownership column varies by table: workout_log/body_stats_log use
      // user_id, program_assignments uses assigned_to, exercises/programs
      // use created_by (with is_global=1 rows intentionally shared across
      // every user — not a leak, that's the point of a global exercise).
      assert.match(
        src,
        /user_id\s*=\s*\?|assigned_to\s*=\s*\?|created_by\s*=\s*\?/i,
        `${f} queries the DB but does not appear to scope on an ownership column`
      );
    }
  }
});

test('_workout-write.js mutator goes through mergeExercises (Option C), not a wholesale replace', () => {
  const src = readFileSync(new URL('../server/lib/mcp/_workout-write.js', import.meta.url), 'utf8');
  assert.match(src, /mergeExercises/);
  assert.match(src, /ensureExerciseUuids/);
});

test('log-body-stat.js MCP tool merges via mergeStatsObject, not a wholesale replace', () => {
  const src = readFileSync(new URL('../server/lib/mcp/tools/log-body-stat.js', import.meta.url), 'utf8');
  assert.match(src, /mergeStatsObject/);
});
