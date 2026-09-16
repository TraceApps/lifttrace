/**
 * A soft-deleted workout keeps its row (deleted_at set), so every query that
 * builds stats or records from workout_log has to skip it, or a deleted
 * session can still hold a PR. Checked statically: no native sqlite here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

for (const file of ['../server/routes/stats.js', '../server/lib/mcp/tools/get-records.js']) {
  test(`${file.split('/').pop()} leaves deleted workouts out`, () => {
    const queries = read(file).match(/['`][^'`]*FROM workout_log[^'`]*['`]/g) || [];
    assert.ok(queries.length > 0);
    for (const q of queries) assert.match(q, /deleted_at IS NULL/, q);
  });
}

test('get_workout returns hold times for timed sets', () => {
  const src = read('../server/lib/mcp/tools/get-workout.js');
  assert.match(src, /duration_sec: s\.duration_sec \?\? null/);
  assert.match(src, /set_type: ex\.set_type \?\? null/);
});
