/**
 * The pure half of the browser's offline mode: what gets queued, how the
 * queue collapses, and what a screen sees while work is waiting. No browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfflineError, isMirroredGet, writeOp, collapseOps, sentSeqs, answerWithOps,
  queuedWorkoutReply, newTempId, isTempId, createdId, remapIds, remapPath, mirrorKey, pathOf,
} from '../src/lib/offline-edits.js';

const op = (seq, method, path, body, extra = {}) => {
  const w = writeOp(method, path, body);
  return { seq, method, path, body, at: seq, ...w, ...extra };
};

test('a server being unreachable is told apart from a real answer', () => {
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(Object.assign(new Error('x'), { offline: true })), true);
  assert.equal(isOfflineError(new Error('HTTP 400')), false);
  assert.equal(isOfflineError(null), false);
});

test('a mirrored read is matched on its path, and filed with its query', () => {
  assert.equal(isMirroredGet('/api/workout/2026-09-20'), true);
  assert.equal(isMirroredGet('/api/workout/2026-09-20?id=4'), true);
  assert.equal(isMirroredGet('/api/workout/recent?limit=30'), true);
  assert.equal(isMirroredGet('/api/exercises?category=legs'), true);
  assert.equal(isMirroredGet('/api/settings'), true);
  // Not mirrored: these need the server and say so.
  assert.equal(isMirroredGet('/api/ai/chat'), false);
  assert.equal(isMirroredGet('/api/upload/exercise-media'), false);
  // Coach notes on a day ARE kept, so the diary has no hole in it offline.
  assert.equal(isMirroredGet('/api/workout/2026-09-20/feedback'), true);
  // The query is part of the key, so ?limit=30 and ?limit=7 don't collide.
  assert.equal(mirrorKey('/api/workout/recent?limit=30'), '/api/workout/recent?limit=30');
  assert.equal(pathOf('http://x/api/workout/recent?limit=30'), '/api/workout/recent');
});

test('the writes this layer takes on are recognised, and nothing else is', () => {
  assert.equal(writeOp('PUT', '/api/workout/2026-09-20', {}).kind, 'workout');
  assert.equal(writeOp('DELETE', '/api/workout/2026-09-20').kind, 'workout-delete');
  assert.equal(writeOp('PUT', '/api/body-stats/2026-09-20', {}).kind, 'body-stats');
  assert.equal(writeOp('POST', '/api/exercises', {}).kind, 'exercise-create');
  assert.equal(writeOp('PUT', '/api/exercises/12', {}).kind, 'exercise-update');
  assert.equal(writeOp('DELETE', '/api/exercises/12').kind, 'exercise-delete');
  assert.equal(writeOp('PUT', '/api/settings', { key: 'unit' }).key, 'setting:unit');
  // Uploads, imports, Trace and admin are not queued.
  assert.equal(writeOp('POST', '/api/upload/exercise-media', {}), null);
  assert.equal(writeOp('POST', '/api/ai/chat', {}), null);
  assert.equal(writeOp('POST', '/api/exercises/sync-wger', {}), null);
});

test('two sessions on one date are queued apart', () => {
  assert.equal(writeOp('PUT', '/api/workout/2026-09-20', { id: 4 }).key, 'workout:2026-09-20#4');
  assert.equal(writeOp('PUT', '/api/workout/2026-09-20', {}).key, 'workout:2026-09-20#default');
  assert.equal(writeOp('DELETE', '/api/workout/2026-09-20?id=7').key, 'workout:2026-09-20#7');
});

test('only the last save of a session is replayed', () => {
  const ops = [
    op(1, 'PUT', '/api/workout/2026-09-20', { exercises: [{ uuid: 'a' }] }),
    op(2, 'PUT', '/api/workout/2026-09-20', { exercises: [{ uuid: 'a' }, { uuid: 'b' }] }),
    op(3, 'PUT', '/api/workout/2026-09-21', { exercises: [] }),
  ];
  const collapsed = collapseOps(ops);
  assert.deepEqual(collapsed.map(o => o.seq), [2, 3]);
  assert.equal(collapsed[0].body.exercises.length, 2);
  // Both saves of that day are cleared once the replay lands, not just the last.
  assert.deepEqual(sentSeqs(ops, ['workout:2026-09-20#default', 'workout:2026-09-21#default']).sort(), [1, 2, 3]);
});

test('a set deleted offline survives a later edit of the same day', () => {
  // The app diffs against what it last saw saved, and a queued save counts as
  // saved, so the second save carries no tombstones of its own.
  const ops = [
    op(1, 'PUT', '/api/workout/2026-09-20', {
      exercises: [{ uuid: 'keep' }],
      deleted_uuids: { exercises: ['gone'], sets: { keep: ['s1'] } },
    }),
    op(2, 'PUT', '/api/workout/2026-09-20', { exercises: [{ uuid: 'keep' }, { uuid: 'new' }] }),
  ];
  const sent = collapseOps(ops)[0];
  assert.equal(sent.body.exercises.length, 2, 'the newest day content goes up');
  assert.deepEqual(sent.body.deleted_uuids.exercises, ['gone']);
  assert.deepEqual(sent.body.deleted_uuids.sets, { keep: ['s1'] });
});

test('tombstones from different days and sessions do not mix', () => {
  const ops = [
    op(1, 'PUT', '/api/workout/2026-09-20', { deleted_uuids: { exercises: ['a'] } }),
    op(2, 'PUT', '/api/workout/2026-09-21', { deleted_uuids: { exercises: ['b'] } }),
    op(3, 'PUT', '/api/workout/2026-09-21', { id: 9, deleted_uuids: { exercises: ['c'] } }),
  ];
  const sent = collapseOps(ops);
  assert.deepEqual(sent.find(o => o.key === 'workout:2026-09-20#default').body.deleted_uuids.exercises, ['a']);
  assert.deepEqual(sent.find(o => o.key === 'workout:2026-09-21#default').body.deleted_uuids.exercises, ['b']);
  assert.deepEqual(sent.find(o => o.key === 'workout:2026-09-21#9').body.deleted_uuids.exercises, ['c']);
});

test('a setting changed twice offline goes up once, with the last value', () => {
  const ops = [
    op(1, 'PUT', '/api/settings', { key: 'weightUnit', value: 'kg' }),
    op(2, 'PUT', '/api/settings', { key: 'weightUnit', value: 'lb' }),
    op(3, 'PUT', '/api/settings', { key: 'restTimer', value: 90 }),
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 2);
  assert.equal(sent.find(o => o.body.key === 'weightUnit').body.value, 'lb');
});

test('an exercise made and then removed again offline never goes up', () => {
  const tempId = newTempId();
  const ops = [
    { seq: 1, method: 'POST', path: '/api/exercises', body: { name: 'Oops' }, kind: 'exercise-create', key: `exercise:${tempId}`, id: tempId, tempId },
    op(2, 'DELETE', `/api/exercises/${tempId}`, null),
  ];
  assert.deepEqual(collapseOps(ops), []);
  // Both requests are still cleared from the queue, though neither was sent.
  assert.deepEqual(sentSeqs(ops, []).sort(), [1, 2]);
});

test('an exercise made and then edited offline goes up as one exercise', () => {
  const tempId = newTempId();
  const ops = [
    { seq: 1, method: 'POST', path: '/api/exercises', body: { name: 'Sled Push', category: 'legs' }, kind: 'exercise-create', key: `exercise:${tempId}`, id: tempId, tempId },
    { ...op(2, 'PUT', `/api/exercises/${tempId}`, { name: 'Sled Drag' }), key: `exercise:${tempId}` },
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'exercise-create');
  assert.equal(sent[0].body.name, 'Sled Drag');
  assert.equal(sent[0].body.category, 'legs', 'what the edit did not mention is kept');
});

test('a temporary id cannot be mistaken for a server one', () => {
  const a = newTempId(), b = newTempId();
  assert.ok(isTempId(a) && isTempId(b) && a !== b);
  assert.equal(isTempId(42), false);
  assert.equal(createdId({ exercise: { id: 88 } }), 88);
  assert.equal(createdId({ id: 5 }), 5);
  assert.equal(createdId({ id: -3 }), null);
});

test('a workout follows an exercise that only existed offline to its real id', () => {
  const body = { exercises: [{ uuid: 'x', exercise_id: -7, sets: [{ id: -7 }] }, { uuid: 'y', exercise_id: 3 }] };
  const fixed = remapIds(body, { '-7': 91 });
  assert.equal(fixed.exercises[0].exercise_id, 91);
  assert.equal(fixed.exercises[0].sets[0].id, 91);
  assert.equal(fixed.exercises[1].exercise_id, 3, 'server ids are left alone');
  assert.equal(remapPath('/api/exercises/-7', { '-7': 91 }), '/api/exercises/91');
  assert.equal(remapPath('/api/exercises/12', { '-7': 91 }), '/api/exercises/12');
});

test('remapping does nothing when nothing was created', () => {
  const body = { exercises: [{ exercise_id: -7 }] };
  assert.equal(remapIds(body, {}), body);
});

// ── What a screen sees while work is waiting ────────────────────────

test('a day edited offline shows what you typed, not what the server knew', () => {
  const mirrored = { workout: { id: 4, date: '2026-09-20', exercises: [{ uuid: 'a' }] } };
  const ops = [op(1, 'PUT', '/api/workout/2026-09-20', { id: 4, exercises: [{ uuid: 'a' }, { uuid: 'b' }] })];
  const shown = answerWithOps('/api/workout/2026-09-20', mirrored, ops);
  assert.equal(shown.workout.exercises.length, 2);
  assert.equal(shown.workout._pending, true);
  assert.equal(shown.workout.date, '2026-09-20', 'what the save did not mention is kept');
});

test('a day deleted offline reads as empty', () => {
  const mirrored = { workout: { id: 4, exercises: [{ uuid: 'a' }] } };
  const ops = [op(1, 'DELETE', '/api/workout/2026-09-20?id=4')];
  assert.deepEqual(answerWithOps('/api/workout/2026-09-20', mirrored, ops), { workout: null });
});

test('a day with nothing queued is served exactly as it was mirrored', () => {
  const mirrored = { workout: { id: 4 } };
  assert.equal(answerWithOps('/api/workout/2026-09-20', mirrored, []), mirrored);
});

test('settings changed offline read back changed', () => {
  const shown = answerWithOps('/api/settings', { weightUnit: 'kg', theme: 'dark' },
    [op(1, 'PUT', '/api/settings', { key: 'weightUnit', value: 'lb' })]);
  assert.equal(shown.weightUnit, 'lb');
  assert.equal(shown.theme, 'dark');
});

test('an exercise made offline is in the list at once, and a deleted one is gone', () => {
  const tempId = newTempId();
  const ops = [
    { seq: 1, kind: 'exercise-create', body: { name: 'Sled Push' }, tempId, id: tempId },
    { seq: 2, kind: 'exercise-delete', key: 'exercise:5', id: 5 },
  ];
  const shown = answerWithOps('/api/exercises', [{ id: 5, name: 'Old' }, { id: 6, name: 'Keep' }], ops);
  assert.deepEqual(shown.map(e => e.name), ['Keep', 'Sled Push']);
  assert.equal(shown.find(e => e.name === 'Sled Push').id, tempId);
});

test('the reply to a queued save looks like the route\'s own', () => {
  const reply = queuedWorkoutReply({ workout: { id: 4, name: 'Push' } }, { exercises: [{ uuid: 'a' }] }, -99);
  assert.equal(reply.workout.id, 4);
  assert.equal(reply.workout.name, 'Push', 'metadata the save did not mention is kept');
  assert.equal(reply.queued, true);
  assert.deepEqual(reply.tombstones, []);
  // A day that never existed on the server gets a temporary id to hold on to.
  assert.equal(queuedWorkoutReply(null, { exercises: [] }, -99).workout.id, -99);
});
