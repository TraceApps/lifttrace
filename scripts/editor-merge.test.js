/**
 * A program workout open in the editor when a sync brings a newer copy
 * (src/lib/editor-merge.js): what you changed stays, the rest is the newer
 * copy's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTemplate } from '../src/lib/editor-merge.js';

const ex = (uuid, extra = {}) => ({ uuid, exercise_id: 1, exercise_name: uuid, target_sets: 3, target_reps: '10', notes: '', ...extra });
const tpl = (exercises, extra = {}) => ({ id: 7, name: 'Push', exercises, ...extra });

test('a field you changed keeps yours, one you did not takes the newer copy', () => {
  const base = tpl([ex('a'), ex('b')]);
  const mine = tpl([ex('a', { target_reps: '8' }), ex('b')], { name: 'Push Day' });
  const fresh = tpl([ex('a', { target_reps: '12', notes: 'slow' }), ex('b', { target_sets: 5 })], { name: 'Push (web)', day_label: 'Mon' });
  const { template, listFrom } = mergeTemplate(base, mine, fresh);
  assert.equal(listFrom, 'fresh');
  assert.equal(template.name, 'Push Day', 'the name you typed');
  assert.equal(template.day_label, 'Mon');
  assert.equal(template.exercises[0].target_reps, '8', 'the reps you typed');
  assert.equal(template.exercises[0].notes, 'slow', 'a note added on the web');
  assert.equal(template.exercises[1].target_sets, 5);
});

test('nothing changed here: the newer copy as it is, its list too', () => {
  const base = tpl([ex('a'), ex('b')]);
  const fresh = tpl([ex('b'), ex('c'), ex('a', { target_sets: 4 })]);
  const { template, listFrom } = mergeTemplate(base, structuredClone(base), fresh);
  assert.equal(listFrom, 'fresh');
  assert.deepEqual(template, fresh);
});

test('an exercise removed on the web goes, unless you changed it here', () => {
  const base = tpl([ex('a'), ex('b')]);
  const fresh = tpl([ex('a')]);
  assert.deepEqual(mergeTemplate(base, structuredClone(base), fresh).template.exercises.map(e => e.uuid), ['a']);
  const mine = tpl([ex('a'), ex('b', { notes: 'mine' })]);
  const { template, listFrom } = mergeTemplate(base, mine, fresh);
  assert.equal(listFrom, 'mine');
  assert.deepEqual(template.exercises.map(e => [e.uuid, e.notes]), [['a', ''], ['b', 'mine']]);
});

test('a list you changed (added, removed, moved, a superset) stays yours, its fields still update', () => {
  const base = tpl([ex('a'), ex('b')]);
  const fresh = tpl([ex('a', { target_sets: 6 }), ex('b'), ex('c')]);
  const moved = mergeTemplate(base, tpl([ex('b'), ex('a')]), fresh);
  assert.equal(moved.listFrom, 'mine');
  assert.deepEqual(moved.template.exercises.map(e => [e.uuid, e.target_sets]), [['b', 3], ['a', 6], ['c', 3]], 'one added on the web comes in at the end');
  const added = mergeTemplate(base, tpl([ex('a'), ex('b'), { exercise_id: 9, exercise_name: 'New', target_sets: 3 }]), fresh);
  assert.equal(added.listFrom, 'mine');
  assert.deepEqual(added.template.exercises.map(e => e.exercise_name), ['a', 'b', 'New', 'c']);
  const removed = mergeTemplate(base, tpl([ex('a')]), fresh);
  assert.deepEqual(removed.template.exercises.map(e => e.uuid), ['a', 'c'], 'what you removed stays removed');
  const ss = mergeTemplate(base, tpl([ex('a', { superset_id: 's1', superset_size: 2 }), ex('b', { superset_id: 's1', superset_size: 2 })]), fresh);
  assert.equal(ss.listFrom, 'mine');
  assert.equal(ss.template.exercises[0].superset_id, 's1');
});

test('a field you cleared stays cleared; week targets count as yours once changed', () => {
  const base = tpl([ex('a', { tempo: '3-1-1', weeks: [null, { reps: '8' }] })]);
  const mine = tpl([ex('a', { weeks: [null, { reps: '6' }] })]);
  delete mine.exercises[0].tempo;
  const fresh = tpl([ex('a', { tempo: '2-0-2', weeks: [null, { reps: '9' }], target_sets: 5 })]);
  const got = mergeTemplate(base, mine, fresh).template.exercises[0];
  assert.equal('tempo' in got, false);
  assert.deepEqual(got.weeks, [null, { reps: '6' }]);
  assert.equal(got.target_sets, 5);
});

test('exercises with no uuid: yours stay as they are', () => {
  const base = tpl([{ exercise_id: 1, target_sets: 3 }]);
  const mine = tpl([{ exercise_id: 1, target_sets: 4 }]);
  const fresh = tpl([{ exercise_id: 2, target_sets: 5 }], { name: 'Web' });
  const { template, listFrom } = mergeTemplate(base, mine, fresh);
  assert.equal(listFrom, 'mine');
  assert.deepEqual(template.exercises, mine.exercises);
  assert.equal(template.name, 'Web');
});

test('your list wins: one removed on the web that you did not change goes', () => {
  const base = tpl([ex('a'), ex('b'), ex('c')]);
  const mine = tpl([ex('b'), ex('a'), ex('c')]);
  const fresh = tpl([ex('a'), ex('b'), ex('d')]);
  const { template, listFrom } = mergeTemplate(base, mine, fresh);
  assert.equal(listFrom, 'mine');
  assert.deepEqual(template.exercises.map(e => e.uuid), ['b', 'a', 'd']);
});

test('your list wins: supersets are yours, and one left alone is no superset', () => {
  const s2 = (id, pos) => ({ superset_id: id, superset_size: 2, superset_position: pos });
  const base = tpl([ex('a'), ex('b'), ex('c', s2('s1', 0)), ex('e', s2('s1', 1))]);
  const mine = tpl([ex('b'), ex('a'), ex('c', s2('s1', 0)), ex('e', s2('s1', 1))]);
  // The web grouped a with a new d, and removed e (c's partner).
  const fresh = tpl([ex('a', s2('w', 0)), ex('d', s2('w', 1)), ex('b'), ex('c', s2('s1', 0))]);
  const got = mergeTemplate(base, mine, fresh).template.exercises;
  assert.deepEqual(got.map(e => [e.uuid, e.superset_id ?? null]), [['b', null], ['a', null], ['c', null], ['d', null]]);
  assert.ok(got.every(e => !('superset_size' in e) && !('superset_position' in e)));
  // A group of yours that is whole stays, counted again.
  const kept = mergeTemplate(base, tpl([ex('a'), ex('c', s2('s1', 0)), ex('e', s2('s1', 1)), ex('b')]), tpl([ex('a'), ex('b'), ex('c', s2('s1', 0)), ex('e', s2('s1', 1))])).template.exercises;
  assert.deepEqual(kept.map(e => [e.uuid, e.superset_id ?? null, e.superset_position ?? null]), [['a', null, null], ['c', 's1', 0], ['e', 's1', 1], ['b', null, null]]);
});
