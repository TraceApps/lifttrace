/**
 * The pure half of the browser's offline mode: what gets queued, how the
 * queue collapses, and what a screen sees while work is waiting. No browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfflineError, isMirroredGet, writeOp, collapseOps, sentSeqs, answerWithOps,
  queuedWorkoutReply, newTempId, isTempId, createdId, remapIds, remapPath, mirrorKey, pathOf,
  describeOp, shouldRetryStatus, staleAnswerKeys, queuedReply,
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

// ── Cardio and picking a program, away from wifi ────────────────────

test('cardio is queued, and its id paths are not confused with its date paths', () => {
  assert.equal(writeOp('POST', '/api/cardio', { date: '2026-09-20' }).kind, 'cardio-create');
  assert.equal(writeOp('PUT', '/api/cardio/12', {}).kind, 'cardio-update');
  assert.equal(writeOp('DELETE', '/api/cardio/12').kind, 'cardio-delete');
  // A date is a read, never a write target.
  assert.equal(writeOp('PUT', '/api/cardio/2026-09-20', {}), null);
  assert.equal(isMirroredGet('/api/cardio/2026-09-20'), true);
  assert.equal(isMirroredGet('/api/cardio/templates'), true);
  assert.equal(isMirroredGet('/api/cardio/stats/weekly?start=a&end=b'), true);
});

test('a run logged offline shows on its day and in the list', () => {
  const tempId = newTempId();
  const ops = [{ seq: 1, kind: 'cardio-create', tempId, id: tempId, key: `cardio:${tempId}`,
    body: { date: '2026-09-20', activity: 'Run', duration_min: 34, distance: 5 } }];
  const day = answerWithOps('/api/cardio/2026-09-20', [{ id: 3, date: '2026-09-20', activity: 'Row' }], ops);
  assert.deepEqual(day.map(r => r.activity), ['Row', 'Run']);
  assert.equal(day[1].id, tempId);
  // A different day does not show it.
  assert.deepEqual(answerWithOps('/api/cardio/2026-09-19', [], ops), []);
  // The whole list does.
  assert.equal(answerWithOps('/api/cardio', [], ops).length, 1);
});

test('a run edited or deleted offline reads back that way', () => {
  const mirrored = [{ id: 3, activity: 'Row', duration_min: 20 }, { id: 4, activity: 'Bike' }];
  const edited = answerWithOps('/api/cardio', mirrored, [{ seq: 1, kind: 'cardio-update', id: 3, key: 'cardio:3', body: { duration_min: 45 } }]);
  assert.equal(edited.find(r => r.id === 3).duration_min, 45);
  const left = answerWithOps('/api/cardio', mirrored, [{ seq: 1, kind: 'cardio-delete', id: 4, key: 'cardio:4' }]);
  assert.deepEqual(left.map(r => r.id), [3]);
});

test('a run logged and then removed offline never goes up', () => {
  const tempId = newTempId();
  const ops = [
    { seq: 1, kind: 'cardio-create', tempId, id: tempId, key: `cardio:${tempId}`, body: { activity: 'Run' } },
    { ...op(2, 'DELETE', `/api/cardio/${tempId}`, null), key: `cardio:${tempId}` },
  ];
  assert.deepEqual(collapseOps(ops), []);
  assert.deepEqual(sentSeqs(ops, []).sort(), [1, 2]);
});

test('starting a program offline is one decision, not a pile of them', () => {
  assert.equal(writeOp('POST', '/api/programs/4/activate', {}).key, 'program:active');
  assert.equal(writeOp('POST', '/api/programs/deactivate', {}).key, 'program:active');
  assert.equal(writeOp('POST', '/api/programs/4/week-cursor', { week: 2 }).key, 'program:4:week');
  // Editing a program still needs the server.
  assert.equal(writeOp('PUT', '/api/programs/4', {}), null);
  assert.equal(writeOp('POST', '/api/programs', {}), null);
  // Switching programs twice sends only where you ended up.
  const ops = [op(1, 'POST', '/api/programs/4/activate', {}), op(2, 'POST', '/api/programs/7/activate', {})];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/programs/7/activate');
});

// ── Coaching, away from wifi ────────────────────────────────────────

test('a coach note, a reply, read state and prescriptions are queued', () => {
  assert.equal(writeOp('POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u1', note: 'chest up' }).key, 'note:8:u1');
  assert.equal(writeOp('PUT', '/api/coach-feedback/5/reply', { reply: 'got it' }).key, 'reply:5');
  assert.equal(writeOp('POST', '/api/coach-feedback/seen', {}).key, 'seen:notes');
  assert.equal(writeOp('POST', '/api/trainer/activity/seen', {}).key, 'seen:activity');
  assert.equal(writeOp('POST', '/api/trainer/members/3/prescriptions', {}).kind, 'prescription-create');
  assert.equal(writeOp('PUT', '/api/trainer/prescriptions/9', {}).kind, 'prescription-update');
  assert.equal(writeOp('DELETE', '/api/trainer/prescriptions/9').kind, 'prescription-delete');
  // Who can see whose data is not decided offline.
  assert.equal(writeOp('POST', '/api/trainer/members/3', {}), null);
  assert.equal(writeOp('DELETE', '/api/trainer/members/3'), null);
  assert.equal(writeOp('POST', '/api/programs/4/assign', {}), null);
});

test('a note rewritten before the connection returns goes up once', () => {
  const ops = [
    op(1, 'POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u1', note: 'first' }),
    op(2, 'POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u1', note: 'second' }),
    op(3, 'POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u2', note: 'other lift' }),
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 2);
  assert.equal(sent.find(o => o.key === 'note:8:u1').body.note, 'second');
});

test('a note written offline shows on the session at once, on its own lift', () => {
  const detail = { id: 8, date: '2026-09-20', exercises: [{ uuid: 'u1' }, { uuid: 'u2' }], feedback: [] };
  const ops = [op(1, 'POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u2', note: 'slow it down' })];
  const shown = answerWithOps('/api/trainer/members/3/workout/2026-09-20', detail, ops);
  assert.equal(shown.feedback.length, 1);
  assert.equal(shown.feedback[0].exercise_uuid, 'u2');
  assert.equal(shown.feedback[0]._pending, true);
});

test('clearing a note offline takes it off the session', () => {
  const detail = { id: 8, exercises: [{ uuid: 'u1' }], feedback: [{ id: 2, exercise_uuid: 'u1', note: 'old' }] };
  const ops = [op(1, 'POST', '/api/trainer/feedback', { workout_id: 8, exercise_uuid: 'u1', note: '' })];
  assert.deepEqual(answerWithOps('/api/trainer/members/3/workout/2026-09-20', detail, ops).feedback, []);
});

test('a refused coaching change is described in words its author would use', () => {
  assert.match(describeOp({ kind: 'coach-note' }), /note you left/);
  assert.match(describeOp({ kind: 'coach-reply' }), /reply to your coach/);
  assert.match(describeOp({ kind: 'prescription-create' }), /prescribed/);
  assert.match(describeOp({ kind: 'cardio-create', body: { activity: 'Run' } }), /Run/);
  assert.match(describeOp({ kind: 'workout', path: '/api/workout/2026-09-20' }), /workout on 2026-09-20/);
});

test('a hiccup is retried, a refusal is not, and an expired session never loses work', () => {
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(408), true);
  // Signing in again fixes these, so the work waits rather than being binned.
  assert.equal(shouldRetryStatus(401), true);
  assert.equal(shouldRetryStatus(403), true);
  // These are the server's considered answer; repeating them changes nothing.
  assert.equal(shouldRetryStatus(400), false);
  assert.equal(shouldRetryStatus(404), false);
  assert.equal(shouldRetryStatus(409), false);
});

test('a progress photo taken offline is queued, and the upload itself is not', () => {
  assert.equal(writeOp('POST', '/api/body-stats/photos', { date: '2026-09-20', url: 'data:image/png;base64,x' }).kind, 'photo-add');
  assert.equal(writeOp('DELETE', '/api/body-stats/photos/4').kind, 'photo-delete');
  // There is nothing to upload to with no connection: the file travels
  // inside the row instead, so the upload endpoint is never queued.
  assert.equal(writeOp('POST', '/api/upload/body-stats', {}), null);
  assert.match(describeOp({ kind: 'photo-add' }), /progress photo you took/);
});

test('your own profile, picture included, is queued like everything else', () => {
  assert.equal(writeOp('PUT', '/api/auth/profile', { nickname: 'Alex' }).key, 'profile');
  // Saving it twice offline goes up once, with what it ended up saying.
  const ops = [
    op(1, 'PUT', '/api/auth/profile', { nickname: 'Al' }),
    op(2, 'PUT', '/api/auth/profile', { nickname: 'Alex', avatar_url: 'data:image/jpeg;base64,x' }),
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.nickname, 'Alex');
  assert.match(describeOp({ kind: 'profile' }), /your profile/);
});

test('the copy this browser keeps has a ceiling, and lets go of the oldest first', () => {
  const rows = [
    { key: '/a', at: 300 }, { key: '/b', at: 100 }, { key: '/c', at: 200 }, { key: '/d', at: 400 },
  ];
  assert.deepEqual(staleAnswerKeys(rows, 2).sort(), ['/b', '/c']);
  assert.deepEqual(staleAnswerKeys(rows, 4), [], 'nothing goes while there is room');
  assert.deepEqual(staleAnswerKeys([], 10), []);
  assert.deepEqual(staleAnswerKeys([{ key: '/x' }, { key: '/y', at: 5 }], 1), ['/x']);
});

test('a queued answer is shaped like the route it stands in for', () => {
  // The screens read these. The progress photo helper refuses to carry on
  // unless it gets `{ photo }` back, and said "Could not save photo" for a
  // photo that was safely queued, because the shape was wrong.
  const photo = queuedReply({ kind: 'photo-add' }, { date: '2026-09-20', url: 'data:image/png;base64,x' }, -9);
  assert.equal(photo.ok, true);
  assert.equal(photo.photo.id, -9);
  assert.equal(photo.photo.date, '2026-09-20');
  assert.deepEqual(queuedReply({ kind: 'profile' }, { nickname: 'Alex' }, null).user, { nickname: 'Alex' });
  assert.deepEqual(queuedReply({ kind: 'body-stats', key: 'body:2026-09-20' }, { stats: { weight: 80 } }, null).stats.stats, { weight: 80 });
  const run = queuedReply({ kind: 'cardio-create' }, { activity: 'Run' }, -3);
  assert.equal(run.id, -3);
  assert.equal(run.activity, 'Run');
  assert.equal(queuedReply({ kind: 'program-activate' }, null, null).ok, true);
});
