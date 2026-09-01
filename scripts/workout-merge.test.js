import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeEntries, mergeExercises, mergeStatsObject, ensureExerciseUuids, ensureUuids } from '../server/lib/workout-merge.js';

// Port of NutriTrace's scripts/diary-merge.test.js — same class of bug,
// same fix. LT's twist: exercises are two-level (exercise → sets), and
// body_stats is a flat object rather than an array. See
// project_traceapps_diary_merge_port memory.

const _ex  = (uuid, extras = {}) => ({ uuid, name: `ex-${uuid}`, sets: [], ...extras });
const _set = (uuid, extras = {}) => ({ uuid, reps: 5, weight: 100, completed: 1, ...extras });

test('server preserves exercises when client sends empty list without tombstones', () => {
  // The bug we're fixing: stale mobile client PUTs empty exercises
  // (its local was wiped somehow), server used to blow away or DELETE
  // the row. Now: everything preserved.
  const server = [_ex('a'), _ex('b'), _ex('c')];
  const { merged, newTombstoneExerciseUuids } = mergeExercises(server, [], [], [], {}, {});
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map(e => e.uuid).sort(), ['a', 'b', 'c']);
  assert.deepEqual(newTombstoneExerciseUuids, []);
});

test('client add: new exercise uuid added, existing preserved', () => {
  const server = [_ex('a'), _ex('b')];
  const client = [_ex('a'), _ex('b'), _ex('c')];
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.equal(merged.length, 3);
});

test('explicit exercise delete via deleted_uuids removes it + records tombstone', () => {
  const server = [_ex('a'), _ex('b'), _ex('c')];
  const client = [_ex('a'), _ex('c')];
  const { merged, newTombstoneExerciseUuids } = mergeExercises(server, client, ['b'], [], {}, {});
  assert.deepEqual(merged.map(e => e.uuid).sort(), ['a', 'c']);
  assert.deepEqual(newTombstoneExerciseUuids, ['b']);
});

test('tombstoned exercise stays gone even if stale client re-sends it', () => {
  const server = [_ex('a')];
  const client = [_ex('a'), _ex('b')];
  const { merged } = mergeExercises(server, client, [], ['b'], {}, {});
  assert.deepEqual(merged.map(e => e.uuid), ['a']);
});

test('sets merge within an exercise both sides carry', () => {
  const server = [_ex('a', { sets: [_set('s1'), _set('s2')] })];
  const client = [_ex('a', { sets: [_set('s1'), _set('s3')] })];
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sets.map(s => s.uuid).sort(), ['s1', 's2', 's3']);
});

test('explicit set delete via deletedSetsByEx removes it + records tombstone', () => {
  const server = [_ex('a', { sets: [_set('s1'), _set('s2'), _set('s3')] })];
  const client = [_ex('a', { sets: [_set('s1'), _set('s3')] })];
  const { merged, newTombstoneSetUuidsByExercise } = mergeExercises(
    server, client, [], [], { a: ['s2'] }, {}
  );
  assert.deepEqual(merged[0].sets.map(s => s.uuid).sort(), ['s1', 's3']);
  assert.deepEqual(newTombstoneSetUuidsByExercise, { a: ['s2'] });
});

test('server-only exercise passes through with its sets intact', () => {
  const server = [_ex('a', { sets: [_set('s1'), _set('s2')] }), _ex('b', { sets: [_set('s3')] })];
  const client = [_ex('a', { sets: [_set('s1'), _set('s2')] })]; // client doesn't have 'b'
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  const bEx = merged.find(e => e.uuid === 'b');
  assert.ok(bEx, 'server-only exercise must survive');
  assert.equal(bEx.sets.length, 1);
});

test('client-only exercise added with its sets intact', () => {
  const server = [];
  const client = [_ex('a', { sets: [_set('s1'), _set('s2')] })];
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sets.length, 2);
});

test('set edit: later updatedAt wins', () => {
  const server = [_ex('a', { sets: [_set('s1', { reps: 5, updatedAt: '2026-08-10T10:00Z' })] })];
  const client = [_ex('a', { sets: [_set('s1', { reps: 8, updatedAt: '2026-08-10T11:00Z' })] })];
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.equal(merged[0].sets[0].reps, 8);
});

test('regression: LT 2026-08-11 shape — stale client with empty exercises must not wipe workout', () => {
  // Analogue of the NT regression test. If mobile's local workout got
  // wiped for any reason and the client PUTs empty exercises, the
  // server-side merge must preserve every exercise + set the row holds.
  const serverExercises = Array.from({ length: 8 }, (_, i) => _ex(`ex-${i}`, {
    name: `Exercise ${i}`,
    sets: Array.from({ length: 4 }, (__, j) => _set(`ex-${i}-set-${j}`, { reps: 8, weight: 100 + i * 20 })),
  }));
  const { merged } = mergeExercises(serverExercises, [], [], [], {}, {});
  assert.equal(merged.length, 8);
  assert.equal(merged.reduce((sum, e) => sum + e.sets.length, 0), 32);
});

test('mergeStatsObject preserves keys not mentioned by client', () => {
  const server = { weight_kg: 92.5, body_fat_pct: 15.0, waist_cm: 88 };
  const client = { weight_kg: 92.0 }; // only updating weight
  const merged = mergeStatsObject(server, client);
  assert.deepEqual(merged, { weight_kg: 92.0, body_fat_pct: 15.0, waist_cm: 88 });
});

test('mergeStatsObject treats explicit null as clear', () => {
  const server = { weight_kg: 92, body_fat_pct: 15, waist_cm: 88 };
  const client = { body_fat_pct: null }; // user cleared body fat
  const merged = mergeStatsObject(server, client);
  assert.deepEqual(merged, { weight_kg: 92, waist_cm: 88 });
});

test('mergeStatsObject with empty client preserves everything (the primary safety property)', () => {
  const server = { weight_kg: 92, body_fat_pct: 15, waist_cm: 88 };
  const merged = mergeStatsObject(server, {});
  assert.deepEqual(merged, server);
});

test('mergeStatsObject with undefined client returns server unchanged', () => {
  const server = { weight_kg: 92 };
  assert.deepEqual(mergeStatsObject(server, undefined), server);
  assert.deepEqual(mergeStatsObject(server, null), server);
});

test('ensureExerciseUuids assigns uuids at exercise AND set level', () => {
  const input = [
    { name: 'squat', sets: [{ reps: 5 }, { reps: 5, uuid: 'existing' }] },
    { name: 'bench', uuid: 'ex-b', sets: [] },
  ];
  const out = ensureExerciseUuids(input);
  assert.equal(out.length, 2);
  assert.ok(out[0].uuid, 'squat gets a uuid');
  assert.equal(out[1].uuid, 'ex-b', 'bench keeps its uuid');
  assert.ok(out[0].sets[0].uuid, 'first set gets a uuid');
  assert.equal(out[0].sets[1].uuid, 'existing', 'second set keeps its uuid');
});

test('ensureExerciseUuids returns original array when nothing to change', () => {
  const input = [{ uuid: 'a', sets: [{ uuid: 's1' }] }];
  const out = ensureExerciseUuids(input);
  assert.equal(out, input);
});

test('mergeEntries (the flat helper) preserves server on empty client push', () => {
  const server = [{ uuid: 'a' }, { uuid: 'b' }];
  const { merged } = mergeEntries(server, [], [], []);
  assert.equal(merged.length, 2);
});

test('ensureUuids assigns uuids only to entries missing one', () => {
  const input = [{ uuid: 'a' }, { name: 'no-uuid' }];
  const out = ensureUuids(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].uuid, 'a');
  assert.ok(out[1].uuid);
});

// Regression for the "reorder visibly applies then snaps back" bug
// (#71-class, diagnosed 2026-08-31): a JS Map does not move an existing
// key on re-.set(), so seeding the merge from server order and only
// overwriting values silently discarded every client-side reorder.
// Order must follow the CLIENT's array — it's the authoritative full
// list on every save, not an incremental diff.
test('mergeExercises follows client order when the client reorders two existing exercises', () => {
  const server = [_ex('a'), _ex('b'), _ex('c')];
  const client = [_ex('c'), _ex('a'), _ex('b')]; // c moved to the front
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.deepEqual(merged.map(e => e.uuid), ['c', 'a', 'b']);
});

test('mergeEntries (the flat helper) follows client order on a plain swap', () => {
  const server = [{ uuid: 'a' }, { uuid: 'b' }];
  const client = [{ uuid: 'b' }, { uuid: 'a' }];
  const { merged } = mergeEntries(server, client, [], []);
  assert.deepEqual(merged.map(e => e.uuid), ['b', 'a']);
});

test('mergeExercises: joining a superset moves the exercise adjacent to its new siblings', () => {
  // Mirrors joinSuperset() in Diary.svelte: the exercise's array
  // position moves next to the target group, and its superset_id is
  // set to match. Both the content change AND the position change
  // must survive the merge for the client's consecutive-run superset
  // grouping (Diary.svelte's supersetGroups) to render it correctly.
  const server = [
    _ex('x', { superset_id: 'ss1', superset_size: 2 }),
    _ex('y', { superset_id: 'ss1', superset_size: 2 }),
    _ex('a'), // the exercise being joined into the superset
  ];
  const client = [
    _ex('x', { superset_id: 'ss1', superset_size: 3 }),
    _ex('y', { superset_id: 'ss1', superset_size: 3 }),
    _ex('a', { superset_id: 'ss1', superset_size: 3 }), // moved + relabeled
  ];
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.deepEqual(merged.map(e => e.uuid), ['x', 'y', 'a']);
  assert.equal(merged[2].superset_id, 'ss1');
});

test('mergeExercises: server-only concurrent addition is appended after client order, not interleaved', () => {
  const server = [_ex('a'), _ex('b'), _ex('c')]; // 'c' was added by another device
  const client = [_ex('b'), _ex('a')]; // this client only knows about a/b, and reordered them
  const { merged } = mergeExercises(server, client, [], [], {}, {});
  assert.deepEqual(merged.map(e => e.uuid), ['b', 'a', 'c']);
});
