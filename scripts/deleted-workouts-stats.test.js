/**
 * A soft-deleted workout keeps its row (deleted_at set), so every query that
 * builds stats or records from workout_log has to skip it, or a deleted
 * session can still hold a PR. Checked statically: no native sqlite here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

for (const file of [
  '../server/routes/stats.js', '../server/lib/mcp/tools/get-records.js',
  '../server/lib/scheduler.js', '../server/routes/trainer.js',
]) {
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

// Multi-line queries: the filter must sit within the same statement.
for (const file of [
  '../server/routes/programs.js', '../server/lib/mcp/tools/get-active-program.js',
  '../server/lib/coach-activity.js', '../src/lib/api-native.js',
]) {
  test(`${file.split('/').pop()} program and prescription counts skip deleted workouts`, () => {
    const src = read(file);
    const idx = [...src.matchAll(/FROM workout_log wl/g)].map(m => m.index);
    assert.ok(idx.length > 0);
    for (const i of idx) assert.match(src.slice(i, i + 400), /wl\.deleted_at IS NULL/, file);
  });
}

test('an MCP write never brings a deleted workout back', () => {
  const src = read('../server/lib/mcp/_workout-write.js');
  assert.doesNotMatch(src, /deleted_at=NULL/);
  assert.match(src, /date = \? AND user_id = \? AND deleted_at IS NULL ORDER BY session_seq/);
});

test('MCP delete_workout soft-deletes a live workout so sync sees it', () => {
  const src = read('../server/lib/mcp/tools/delete-workout.js');
  assert.doesNotMatch(src, /DELETE FROM workout_log/);
  assert.match(src, /AND deleted_at IS NULL ORDER BY/);
  assert.match(src, /SET deleted_at = datetime\('now'\), updated_at = datetime\('now'\)/);
});

test('import duplicate checks ignore deleted workouts', () => {
  const src = read('../server/routes/workout-import.js');
  for (const q of src.match(/'SELECT[^']*FROM workout_log WHERE user_id = \? AND date = \? AND name = \?[^']*'/g)) {
    assert.match(q, /deleted_at IS NULL/, q);
  }
});
