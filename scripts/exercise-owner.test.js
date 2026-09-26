/**
 * Only the owner can change an exercise.
 *
 * Every write path used to trust the id it was given: the edit route, the
 * delete route, the phone's sync push, and the catalog routes, which matched
 * by name across every user. Any signed-in member could rename a library
 * exercise for everyone, or rewrite or delete someone else's private one.
 * Verified end to end against a running server; these keep the wiring from
 * drifting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canChangeExercise } from '../server/lib/exercise-owner.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('your own custom exercise is yours to change', () => {
  assert.equal(canChangeExercise({ is_global: 0, created_by: 7 }, 7), true);
});

test("somebody else's is not", () => {
  assert.equal(canChangeExercise({ is_global: 0, created_by: 7 }, 8), false);
});

test("a library exercise is nobody's to change, admins included", () => {
  assert.equal(canChangeExercise({ is_global: 1, created_by: null }, 7), false);
  assert.equal(canChangeExercise({ is_global: 1, created_by: 7 }, 7), false);
});

test('with user management off, the one operator owns what they made', () => {
  // No users exist, so uid() is null and so is created_by on their rows.
  assert.equal(canChangeExercise({ is_global: 0, created_by: null }, null), true);
});

test("an ownerless row is nobody's once there are accounts", () => {
  assert.equal(canChangeExercise({ is_global: 0, created_by: null }, 7), false);
});

test('a missing row, and a string id from a token, behave', () => {
  assert.equal(canChangeExercise(undefined, 7), false);
  assert.equal(canChangeExercise({ is_global: '0', created_by: '7' }, 7), true);
});

test('the edit and delete routes check ownership', () => {
  const src = read('../server/routes/exercises.js');
  const put = src.slice(src.indexOf("router.put('/:id'"), src.indexOf("router.delete('/custom/all'"));
  assert.match(put, /Library exercises are shared, so they cannot be edited/);
  assert.match(put, /if \(!canChangeExercise\(existing, uid\(req\)\)\) return res\.status\(404\)/);
  const del = src.slice(src.indexOf("router.delete('/:id'"), src.indexOf('// ── Catalog source'));
  assert.match(del, /if \(!row\) return res\.json\(\{ ok: true \}\)/, 'already gone is still a success');
  assert.match(del, /if \(!canChangeExercise\(row, uid\(req\)\)\) return res\.status\(404\)/);
});

test('the sync push only writes rows the pushing user owns', () => {
  const src = read('../server/routes/sync.js');
  assert.match(src, /SELECT updated_at, is_global, created_by FROM exercises WHERE id = \?/);
  assert.match(src, /if \(canChangeExercise\(existing, u\) && wins\(e\.updated_at, existing\.updated_at\)\)/);
});

test('catalogs are listed and deleted per user, not by name across everyone', () => {
  const src = read('../server/routes/exercise-import.js');
  const list = src.slice(src.indexOf("router.get('/catalogs'"), src.indexOf("router.post('/catalogs/toggle'"));
  assert.match(list, /AND is_global = 0 AND created_by IS \?/);
  const del = src.slice(src.indexOf("router.post('/catalogs/delete'"));
  assert.match(del, /AND is_global = 0 AND created_by IS \?/);
  assert.match(del, /DELETE FROM user_settings WHERE key = \? AND user_id IS \?/);
});
