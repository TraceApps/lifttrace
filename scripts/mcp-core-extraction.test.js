/**
 * Static-analysis test guarding the MCP core-extraction refactor (issue
 * #77 Part 0). Each MCP read/write tool's query logic was pulled into a
 * standalone exported `xCore` function so the public REST API can call
 * the exact same implementation instead of a fourth copy of the query.
 * This only checks the export exists in source text, no db.js import,
 * so it runs without a compiled better-sqlite3 native binding. It does
 * not verify behavior; the manual `node scripts/mcp-smoke.mjs` run
 * against a live MCP_ENABLED=1 server is what confirms the refactor is
 * byte-identical to the pre-refactor tool output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const TOOLS_DIR = new URL('../server/lib/mcp/tools/', import.meta.url);

const EXPECTED_CORE_EXPORTS = {
  'get-workout.js':           'getWorkoutCore',
  'list-recent-workouts.js':  'listRecentWorkoutsCore',
  'get-records.js':           'getRecordsCore',
  'get-exercise-progress.js': 'getExerciseProgressCore',
  'search-exercises.js':      'searchExercisesCore',
  'list-programs.js':         'listProgramsCore',
  'get-active-program.js':    'getActiveProgramCore',
  'get-body-stat.js':         'getBodyStatCore',
  'log-set.js':                'logSetCore',
  'log-body-stat.js':          'logBodyStatCore',
};

for (const [file, exportName] of Object.entries(EXPECTED_CORE_EXPORTS)) {
  test(`${file} exports ${exportName}`, () => {
    const src = readFileSync(new URL(file, TOOLS_DIR), 'utf8');
    assert.match(src, new RegExp(`export function ${exportName}\\(`));
    // The register function must still call it, not duplicate the logic.
    assert.match(src, new RegExp(exportName + '\\('), `register wrapper in ${file} should call ${exportName}`);
  });
}

test('delete-workout.js is intentionally NOT extracted (no REST parity yet, issue #77)', () => {
  const src = readFileSync(new URL('delete-workout.js', TOOLS_DIR), 'utf8');
  assert.doesNotMatch(src, /export function deleteWorkoutCore/);
});

test('get-records.js also exports hasQualifyingSet, used by the pr.set webhook early-exit guard', () => {
  const src = readFileSync(new URL('get-records.js', TOOLS_DIR), 'utf8');
  assert.match(src, /export function hasQualifyingSet\(/);
});
