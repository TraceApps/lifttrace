/**
 * Static-analysis tests for the public REST API wiring (issue #77).
 *
 * These do not exercise real HTTP requests; they guard against
 * accidental unwiring of the route mount, the feature flags, or a
 * route calling something other than the shared xCore function during
 * future refactors. Pure text/regex checks over the source files, no
 * db.js import, so this runs without a compiled better-sqlite3 native
 * binding. Real verification requires a running dev server with
 * PUBLIC_API_ENABLED=1 and a curl/http client against it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const route   = readFileSync(new URL('../server/routes/public-api.js', import.meta.url), 'utf8');

test('public API route is mounted at /api/v1 on the main router', () => {
  assert.match(indexJs, /import publicApiRoutes[\s\S]*from '\.\/routes\/public-api\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/v1',\s*publicApiRoutes\)/);
});

test('public API is feature-flagged on PUBLIC_API_ENABLED and requires bearer auth', () => {
  assert.match(route, /PUBLIC_API_ENABLED/);
  assert.match(route, /bearerAuth/);
});

test('write routes require PUBLIC_API_WRITE_ENABLED independent of the base flag', () => {
  assert.match(route, /PUBLIC_API_WRITE_ENABLED/);
  assert.match(route, /requireWriteEnabled/);
});

test('every read route requires the mcp:read scope, reusing MCP\'s own scopes rather than new api:* ones', () => {
  const getRoutes = [...route.matchAll(/router\.get\(('[^']+'|"[^"]+")\s*,\s*([^,]+),/g)];
  assert.ok(getRoutes.length >= 8, 'expected at least 8 GET routes');
  for (const [, path, middleware] of getRoutes) {
    assert.match(middleware, /requireScope\('mcp:read'\)/, `${path} should require mcp:read`);
  }
});

test('every write route requires the mcp:write scope', () => {
  const writeRoutes = [...route.matchAll(/router\.(post|put)\(('[^']+'|"[^"]+")[\s\S]{0,120}?requireScope\('mcp:write'\)/g)];
  assert.ok(writeRoutes.length >= 2, 'expected at least 2 write routes gated on mcp:write');
});

test('no DELETE route exists yet (destroy parity deliberately deferred)', () => {
  assert.doesNotMatch(route, /router\.delete\(/);
});

test('each route calls the shared xCore function rather than a fresh db.prepare', () => {
  assert.doesNotMatch(route, /db\.prepare/, 'public-api.js should not query the DB directly, only via xCore imports');
  for (const coreFn of [
    'getWorkoutCore', 'listRecentWorkoutsCore', 'getRecordsCore',
    'getExerciseProgressCore', 'searchExercisesCore', 'listProgramsCore',
    'getActiveProgramCore', 'getBodyStatCore', 'logSetCore', 'logBodyStatCore',
  ]) {
    assert.match(route, new RegExp(coreFn), `public-api.js should import and call ${coreFn}`);
  }
});

test('SCOPE_DESCRIPTIONS mentions the REST API alongside MCP for mcp:read and mcp:write', () => {
  const apiTokens = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
  const desc = apiTokens.match(/SCOPE_DESCRIPTIONS = \{([\s\S]*?)\n\};/)[1];
  assert.match(desc, /REST API/i);
});
