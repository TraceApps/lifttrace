/**
 * The pure half of the browser's offline mode: what gets queued, how the
 * queue collapses, and what a screen sees while work is waiting. No browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfflineError, isMirroredGet, writeOp, collapseOps, sentSeqs, answerWithOps,
  queuedWorkoutReply, newTempId, isTempId, createdId, remapIds, remapPath, mirrorKey, pathOf,
  describeOp, shouldRetryStatus, staleAnswerKeys, queuedReply, orphanWorkoutSave, opsAsKnown,
  newClientKey, takesClientKey, isKeyedCreate, deleteOfSent, byKeyPath, deletePathWithId,
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

test('the recent list shows a day cleared, deleted or logged offline (PR #120)', () => {
  const done = [{ uuid: 'a', sets: [{ completed: true }] }];
  const mirrored = [
    { id: 9, date: '2026-09-27', session_seq: 0, exercises: done, completed: 1 },
    { id: 7, date: '2026-09-22', session_seq: 0, exercises: done, completed: 1 },
    { id: 8, date: '2026-09-22', session_seq: 1, exercises: done, completed: 1 },
  ];
  // Clear Workout: the day's own row, emptied, the rest untouched.
  let shown = answerWithOps('/api/workout/recent?limit=365', mirrored,
    [op(1, 'PUT', '/api/workout/2026-09-27', { id: 9, exercises: [], completed: false })]);
  assert.deepEqual(shown.map(r => r.id), [9, 7, 8]);
  assert.deepEqual(shown[0].exercises, []);
  assert.equal(shown[0].completed, false);
  assert.equal(shown[1], mirrored[1]);
  // Delete Workout on one of two sessions takes only that one.
  shown = answerWithOps('/api/workout/recent', mirrored, [op(1, 'DELETE', '/api/workout/2026-09-22?id=8')]);
  assert.deepEqual(shown.map(r => r.id), [9, 7]);
  // A save with no session named goes to the day's first session.
  shown = answerWithOps('/api/workout/recent', mirrored, [op(1, 'PUT', '/api/workout/2026-09-22', { exercises: [] })]);
  assert.deepEqual(shown.find(r => r.id === 7).exercises, []);
  assert.equal(shown.find(r => r.id === 8).exercises, done);
  // A day first logged offline joins the list, newest first.
  shown = answerWithOps('/api/workout/recent', mirrored, [op(4, 'PUT', '/api/workout/2026-09-28', { exercises: done })]);
  assert.deepEqual(shown.map(r => r.date), ['2026-09-28', '2026-09-27', '2026-09-22', '2026-09-22']);
  assert.equal(shown[0]._pending, true);
  // Nothing queued for workouts: the mirrored copy, as it was.
  assert.equal(answerWithOps('/api/workout/recent', mirrored, [op(1, 'PUT', '/api/settings', { key: 'theme', value: 'x' })]), mirrored);
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

test('a progress photo taken offline is on the timeline while it waits', () => {
  const kept = { count: 1, photos: [{ id: 5, date: '2026-09-19', url: '/uploads/body-stats/a.jpg' }] };
  const ops = [{ seq: 1, kind: 'photo-add', tempId: -3, at: 1, body: { date: '2026-09-20', url: 'data:image/jpeg;base64,x' } }];
  const shown = answerWithOps('/api/body-stats/photos?start=a&end=b', kept, ops);
  assert.equal(shown.photos.length, 2);
  assert.equal(shown.photos[1].id, -3);
  assert.equal(shown.photos[1]._pending, true);
  assert.equal(shown.count, 2);
  // Nothing queued: exactly what the server said.
  assert.equal(answerWithOps('/api/body-stats/photos', kept, []), kept);
});

test('two changes of the same thing queued offline go up as one, with what both changed and the later time', () => {
  const a = op(1, 'PUT', '/api/exercises/7', { name: 'A', category: 'legs' }, { editedAt: '2026-10-07T10:00:00.000Z', changed: ['name'] });
  const b = op(2, 'PUT', '/api/exercises/7', { name: 'A', category: 'arms' }, { editedAt: '2026-10-07T10:05:00.000Z', changed: ['category'] });
  const [sent] = collapseOps([a, b]);
  assert.deepEqual(sent.changed.sort(), ['category', 'name']);
  assert.equal(sent.editedAt, '2026-10-07T10:05:00.000Z');
  // Either one unable to say what it changed: the server takes all it sends.
  const [unknown] = collapseOps([a, { ...b, changed: null }]);
  assert.equal(unknown.changed, null);
});

test('the browser\'s queued changes carry when they were made, on the server\'s clock, and what they changed', async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /editedAt: _serverNow\(at\),[\s\S]{0,200}changed: newWorkout \|\| firstMadeHere \? null : \(_callerChanged\(init\) \?\? await _changedFields\(method, target, body\)\),/);
  assert.match(offline, /if \(op\.editedAt\) headers\['X-Edited-At'\] = op\.editedAt;/);
  assert.match(offline, /if \(Array\.isArray\(op\.changed\)\) headers\['X-Changed-Fields'\] = op\.changed\.join\(','\);/);
  assert.match(offline, /res\?\.headers\?\.get\?\.\('x-server-time'\)/);
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(server, /res\.set\('X-Server-Time', new Date\(\)\.toISOString\(\)\)/);
});

test('merging a change that can\'t say what it changed counts all fields, never only the later list', () => {
  const unknown = op(1, 'PUT', '/api/exercises/7', { name: 'A', category: 'legs' }, { editedAt: '2026-10-07T10:00:00.000Z', changed: null });
  const older = op(1, 'PUT', '/api/exercises/7', { name: 'A', category: 'legs' }, { editedAt: '2026-10-07T10:00:00.000Z' });
  delete older.changed;   // queued by an earlier version
  const later = op(2, 'PUT', '/api/exercises/7', { name: 'A', category: 'arms' }, { editedAt: '2026-10-07T10:05:00.000Z', changed: ['category'] });
  assert.equal(collapseOps([unknown, later])[0].changed, null);
  assert.equal(collapseOps([older, later])[0].changed, null);
});

// ── A day with more than one workout, in the browser ────────────────
// A new workout of the day saved while the queue waited answered with the
// day's first workout's id, so the Diary opened that one and the next save
// went into it; it was filed under the first workout too, so a change of
// that one queued beside it was merged away. Found while fixing #142.

const DAY2 = '2026-10-07';
// As offline-api.js queues a new workout: its own temporary id and key.
const made = (seq, tempId, body) => ({ ...op(seq, 'PUT', `/api/workout/${DAY2}`, { ...body, new_session: true, client_key: `web-workout${tempId}` }), tempId, key: `workout:${DAY2}#${tempId}` });

test('a new workout of the day answers as itself, not as the workout held here', () => {
  const reply = queuedWorkoutReply({ workout: { id: 4, name: 'Mobility', notes: 'stretch' } }, { name: 'Leg Day', new_session: true, exercises: [] }, -77);
  assert.equal(reply.workout.id, -77);
  assert.equal(reply.workout.name, 'Leg Day');
  assert.equal(reply.workout.notes, undefined, "nothing of the other workout's");
  // The Diary saves it back whole: with the flag still on, every save of it
  // started yet another workout.
  assert.equal(reply.workout.new_session, undefined);
  assert.equal(queuedWorkoutReply(null, { name: 'Leg Day', new_session: true, client_key: 'web-workout-77' }, -77).workout.client_key, undefined);
});

test('a new workout and the changes made to it go up as one new workout', () => {
  const ops = [
    op(1, 'PUT', `/api/workout/${DAY2}`, { id: 4, name: 'Mobility', exercises: [] }, { changed: ['exercises'] }),
    made(2, -77, { name: 'Leg Day', exercises: [{ uuid: 'sq' }] }),
    op(3, 'PUT', `/api/workout/${DAY2}`, { id: -77, name: 'Leg Day', exercises: [{ uuid: 'sq' }, { uuid: 'hip' }] }, { changed: ['exercises'] }),
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 2, "Mobility's change still goes up");
  assert.equal(sent[0].body.id, 4);
  const leg = sent[1];
  assert.equal(leg.body.new_session, true, 'still made as a new workout');
  assert.equal(leg.tempId, -77, 'the replay learns its id');
  assert.equal(leg.body.client_key, 'web-workout-77', 'sent twice, still one');
  assert.deepEqual(leg.body.exercises.map(e => e.uuid), ['sq', 'hip'], 'with the newest values');
  assert.equal(leg.changed, null, 'all of it is new');
});

test('two new workouts of the same day are two workouts', () => {
  const sent = collapseOps([made(1, -77, { name: 'Legs' }), made(2, -78, { name: 'Arms' })]);
  assert.deepEqual(sent.map(o => o.body.name), ['Legs', 'Arms']);
});

test('a new workout made and deleted before going up never goes up', () => {
  const sent = collapseOps([made(1, -77, { name: 'Legs' }), op(2, 'DELETE', `/api/workout/${DAY2}?id=-77`)]);
  assert.deepEqual(sent, []);
});

test("a day's first workout made here keeps its temporary id through later saves", () => {
  const sent = collapseOps([
    op(1, 'PUT', `/api/workout/${DAY2}`, { name: 'Push', exercises: [] }, { tempId: -60 }),
    op(2, 'PUT', `/api/workout/${DAY2}`, { name: 'Push', exercises: [{ uuid: 'b' }] }),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tempId, -60);
});

test('a workout read by id shows only what was queued for that workout', () => {
  const ops = [
    op(1, 'PUT', `/api/workout/${DAY2}`, { id: 4, name: 'Mobility', exercises: [{ uuid: 'm' }] }),
    made(2, -77, { name: 'Leg Day', exercises: [{ uuid: 'sq' }] }),
    op(3, 'PUT', `/api/workout/${DAY2}`, { id: 5, name: 'Push', exercises: [{ uuid: 'p' }, { uuid: 'p2' }] }),
  ];
  const push = answerWithOps(`/api/workout/${DAY2}?id=5`, { workout: { id: 5, name: 'Push', notes: 'n' } }, ops, 4);
  assert.equal(push.workout.name, 'Push');
  assert.equal(push.workout.exercises.length, 2);
  assert.equal(push.workout.notes, 'n');
  const leg = answerWithOps(`/api/workout/${DAY2}?id=-77`, undefined, ops, 4);
  assert.equal(leg.workout.id, -77, 'a new one, under its temporary id');
  assert.equal(leg.workout.name, 'Leg Day');
  // The plain day is its first workout, not the last one saved.
  const first = answerWithOps(`/api/workout/${DAY2}`, { workout: { id: 4, name: 'Mobility' } }, ops);
  assert.equal(first.workout.id, 4);
  assert.deepEqual(first.workout.exercises.map(e => e.uuid), ['m']);
});

test("a day's first workout made here reads back by its temporary id", () => {
  const ops = [
    op(1, 'PUT', `/api/workout/${DAY2}`, { name: 'Push', exercises: [{ uuid: 'a' }] }, { tempId: -60 }),
    op(2, 'PUT', `/api/workout/${DAY2}`, { id: -60, name: 'Push', exercises: [{ uuid: 'a' }, { uuid: 'b' }] }),
  ];
  assert.equal(answerWithOps(`/api/workout/${DAY2}?id=-60`, undefined, ops).workout.exercises.length, 2);
  assert.equal(answerWithOps(`/api/workout/${DAY2}`, { workout: null }, ops).workout.exercises.length, 2);
});

test("the day's tabs show a workout started here and drop one deleted here", () => {
  const held = { sessions: [{ id: 4, name: 'Mobility' }, { id: 5, name: 'Push' }] };
  const ops = [
    made(1, -77, { name: 'Leg Day', exercises: [] }),
    op(2, 'PUT', `/api/workout/${DAY2}`, { id: -77, name: 'Leg Day', exercises: [{ uuid: 'sq' }] }),
    op(3, 'PUT', `/api/workout/${DAY2}`, { id: 5, name: 'Push Day', exercises: [] }),
    op(4, 'DELETE', `/api/workout/${DAY2}?id=4`),
  ];
  const tabs = answerWithOps(`/api/workout/${DAY2}/sessions`, held, ops).sessions;
  assert.deepEqual(tabs.map(t => [t.id, t.name]), [[5, 'Push Day'], [-77, 'Leg Day']]);
  assert.equal(answerWithOps(`/api/workout/${DAY2}/sessions`, held, []), held, 'nothing queued: as held');
});

test('a workout read or deleted by a temporary id follows it to the real one', () => {
  assert.equal(remapPath(`/api/workout/${DAY2}?id=-77`, { [-77]: 31 }), `/api/workout/${DAY2}?id=31`);
  assert.equal(remapPath(`/api/workout/${DAY2}?id=-77`, {}), `/api/workout/${DAY2}?id=-77`);
  assert.equal(remapPath(`/api/workout/${DAY2}?id=-778`, { [-77]: 31 }), `/api/workout/${DAY2}?id=-778`, 'the whole id, not a prefix');
  assert.equal(remapPath('/api/exercises/-5', { [-5]: 9 }), '/api/exercises/9');
});

test('a new workout started on an empty day is the day, read by date', () => {
  const ops = [made(1, -77, { name: 'Legs', exercises: [{ uuid: 'sq' }] })];
  assert.equal(answerWithOps(`/api/workout/${DAY2}`, { workout: null }, ops).workout.id, -77);
  assert.equal(answerWithOps(`/api/workout/${DAY2}`, undefined, ops).workout.name, 'Legs');
  // A day that has a first workout is still that one.
  assert.equal(answerWithOps(`/api/workout/${DAY2}`, { workout: { id: 4, name: 'Mobility' } }, ops).workout.id, 4);
});

test('a save that names its workout is a change of it, never a new workout', async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /const newWorkout = !sentAsFirst && op\.kind === 'workout' && body\?\.id == null && \(!!body\?\.new_session \|\| !day\?\.workout\);/);
});

test('a workout started here reads back without the flag that made it, so saving it back is a change, not another workout', () => {
  const ops = [made(1, -77, { name: 'Legs', exercises: [] })];
  const read = answerWithOps(`/api/workout/${DAY2}?id=-77`, undefined, ops).workout;
  assert.equal(read.new_session, undefined);
  assert.equal(read.client_key, undefined);
  const tab = answerWithOps(`/api/workout/${DAY2}/sessions`, { sessions: [] }, ops).sessions[0];
  assert.equal(tab.new_session, undefined);
  // Saved back whole, with its id: still that workout.
  const again = queuedWorkoutReply({ workout: read }, { ...read, new_session: true, exercises: [{ uuid: 's' }] }, -99);
  assert.equal(again.workout.id, -77);
});

test("a save by a temporary id the server never learned goes up as a new workout, not into the day's first", () => {
  const save = op(2, 'PUT', `/api/workout/${DAY2}`, { id: -77, name: 'Legs', exercises: [{ uuid: 's' }] });
  const body = orphanWorkoutSave(save, {}, [save]);
  assert.equal(body.new_session, true);
  assert.equal(body.id, undefined);
  assert.equal(body.client_key, 'web-workout-77', 'sent twice, still one');
  assert.equal(body.name, 'Legs');
  assert.equal(orphanWorkoutSave(save, { [-77]: 31 }, [save]), null, 'learned: sent by its real id');
  assert.equal(orphanWorkoutSave(op(1, 'PUT', `/api/workout/${DAY2}`, { id: 4 }), {}, []), null, 'a server id');
  // Queued by an earlier version: the day's first, made with no temporary id.
  const legacy = op(1, 'PUT', `/api/workout/${DAY2}`, { name: 'Push', exercises: [] });
  assert.equal(orphanWorkoutSave(save, {}, [legacy, save]), null);
});

test('the replay sends such a save as a new workout and learns its id', async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /const orphan = orphanWorkoutSave\(op, map, ops\);\s*\n\s*const body = op\.body == null \? undefined : JSON\.stringify\(remapIds\(orphan \?\? op\.body, map\)\);/);
  assert.match(offline, /const madeAs = op\.tempId \?\? \(orphan \? op\.body\.id : null\);/);
});

test('online, a workout day and its tabs are read with the saves still waiting laid over them', async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /const _WORKOUT_READ = \/\^\\\/api\\\/workout\\\/\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\(\?:\\\/sessions\)\?\$\/;/);
  assert.match(offline, /const answer = answerWithOps\(url, fresh, ops, first\);\s*\n\s*if \(answer !== fresh\) return _json\(200, answer\);/);
  // The server's answer for one workout, with what is queued for it on top.
  const fresh = { workout: { id: 7, name: 'Push', exercises: [{ uuid: 'b', sets: [{ uuid: 's1' }] }] } };
  const ops = [op(1, 'PUT', `/api/workout/${DAY2}`, { id: 7, name: 'Push', exercises: [{ uuid: 'b', sets: [{ uuid: 's1' }, { uuid: 's2' }] }] })];
  assert.equal(answerWithOps(`/api/workout/${DAY2}?id=7`, fresh, ops, 4).workout.exercises[0].sets.length, 2);
  assert.equal(answerWithOps(`/api/workout/${DAY2}?id=8`, fresh, ops, 4), fresh, 'another workout: as the server has it');
});

test("deleting with no id named takes the day's first tab only, as the server does", () => {
  const held = { sessions: [{ id: 4, name: 'Mobility' }, { id: 5, name: 'Push' }] };
  const tabs = answerWithOps(`/api/workout/${DAY2}/sessions`, held, [op(1, 'DELETE', `/api/workout/${DAY2}`)]).sessions;
  assert.deepEqual(tabs.map(t => t.id), [5]);
});

test('what is still queued under a temporary id is found by the real id once known', () => {
  const ops = [op(2, 'PUT', `/api/workout/${DAY2}`, { id: -60, name: 'Push', exercises: [{ uuid: 'a' }, { uuid: 'b' }] })];
  const known = opsAsKnown(ops, { [-60]: 31 });
  assert.equal(known[0].key, `workout:${DAY2}#31`);
  assert.equal(known[0].body.id, 31);
  const read = answerWithOps(`/api/workout/${DAY2}?id=31`, { workout: { id: 31, name: 'Push', exercises: [{ uuid: 'a' }] } }, known, 31);
  assert.equal(read.workout.exercises.length, 2);
  const tabs = answerWithOps(`/api/workout/${DAY2}/sessions`, { sessions: [{ id: 31, name: 'Push' }] }, known).sessions;
  assert.deepEqual(tabs.map(t => t.id), [31], 'one tab, not a second under the old id');
  assert.equal(opsAsKnown(ops, {}), ops, 'nothing learned: as queued');
});

test("deleting with no id named takes the day's first off the recent list, not the whole day", () => {
  const held = [{ id: 4, date: DAY2, session_seq: 0 }, { id: 5, date: DAY2, session_seq: 1 }];
  const rows = answerWithOps('/api/workout/recent', held, [op(1, 'DELETE', `/api/workout/${DAY2}`)]);
  assert.deepEqual(rows.map(r => r.id), [5]);
});

test("a deletion made here leaves the day's other workouts readable", async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /_remember\(pathOf\(target\), \{ workout: null, deletedHere: true \}\)/);
  assert.match(offline, /\(!row \|\| row\.body\?\.deletedHere \|\| r\.at > row\.at\)/);
  assert.match(offline, /const doomed = gone \?\? first;/);
});

test("a day's first workout made in this browser, with none of the day held, goes up as a new workout, not into the server's first", async () => {
  const { readFileSync } = await import('node:fs');
  const offline = readFileSync(new URL('../src/lib/offline-api.js', import.meta.url), 'utf8');
  assert.match(offline, /if \(newWorkout\) body = \{ \.\.\.body, new_session: true, client_key: body\.client_key \|\| `web-workout\$\{tempId\}` \};/);
  assert.match(offline, /op\.kind === 'workout' \? \{ tempId, key: `workout:\$\{date\}#\$\{tempId\}` \}/);
});

test("a workout's queued saves go up saying everything any of them changed", () => {
  const save = (seq, changed) => op(seq, 'PUT', `/api/workout/${DAY2}`, { id: 5, exercises: [], ...(changed ? { changed_uuids: changed } : {}) });
  const [one] = collapseOps([save(1, { exercises: ['a'], sets: { a: ['s1'] } }), save(2, { exercises: [], sets: { a: ['s2'], b: ['t1'] } })]);
  assert.deepEqual(one.body.changed_uuids, { exercises: ['a'], sets: { a: ['s1', 's2'], b: ['t1'] } });
  // One queued by an earlier version says nothing, so the merged one says nothing.
  const [two] = collapseOps([save(1, null), save(2, { exercises: [], sets: { a: ['s2'] } })]);
  assert.equal(two.body.changed_uuids, undefined);
});

test('creates the server keeps a key for take one: cardio, an exercise, a new workout of the day (#134)', () => {
  const take = (method, url, body) => takesClientKey(writeOp(method, url, body), body);
  assert.equal(take('POST', '/api/cardio', { date: '2026-04-01', activity: 'Run' }), true);
  assert.equal(take('POST', '/api/exercises', { name: 'Curl' }), true);
  assert.equal(take('PUT', '/api/workout/2026-04-01', { new_session: true, exercises: [] }), true);
  // A save of a workout, even one still carrying new_session from an earlier answer.
  assert.equal(take('PUT', '/api/workout/2026-04-01', { exercises: [] }), false);
  assert.equal(take('PUT', '/api/workout/2026-04-01', { id: 4, new_session: true }), false);
  // Edits, and creates the server keeps no key for.
  assert.equal(take('PUT', '/api/cardio/5', { notes: 'x' }), false);
  assert.equal(take('POST', '/api/trainer/members/3/prescriptions', { name: 'Legs' }), false);
  assert.equal(take('PUT', '/api/settings', { key: 'units', value: 'kg' }), false);
  assert.equal(takesClientKey(null, {}), false);
});

test('a create key is fresh each time, and made by hand where randomUUID is missing (plain http)', () => {
  const a = newClientKey(), b = newClientKey();
  assert.notEqual(a, b);
  // The server takes 8 to 100 characters (server/lib/create-keys.js).
  for (const k of [a, b]) assert.ok(k.length >= 8 && k.length <= 100, k);
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try {
    const c = newClientKey(), d = newClientKey();
    assert.notEqual(c, d);
    for (const k of [c, d]) assert.ok(k.length >= 8 && k.length <= 100, k);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true, writable: true });
  }
});

test('a change to a create with a key rides with it and is kept apart to go after it (#134)', () => {
  const create = { seq: 1, method: 'POST', path: '/api/cardio', body: { date: '2026-04-08', activity: 'Run', duration_min: 30, client_key: 'k-0123456789' }, kind: 'cardio-create', key: 'cardio:-9', tempId: -9, id: -9, editedAt: 'a' };
  const edit1 = { seq: 2, method: 'PUT', path: '/api/cardio/-9', body: { notes: 'felt good' }, kind: 'cardio-update', key: 'cardio:-9', id: -9, editedAt: 'b', changed: ['notes'] };
  const edit2 = { seq: 3, method: 'PUT', path: '/api/cardio/-9', body: { duration_min: 35 }, kind: 'cardio-update', key: 'cardio:-9', id: -9, editedAt: 'c', changed: ['duration_min'] };
  const [one] = collapseOps([create, edit1, edit2]);
  assert.equal(one.kind, 'cardio-create');
  assert.deepEqual(one.body, { ...create.body, notes: 'felt good', duration_min: 35 });
  assert.deepEqual(one.edits, { notes: 'felt good', duration_min: 35 });
  assert.equal(one.editsAt, 'c');
  assert.deepEqual(one.editsChanged, ['notes', 'duration_min']);
  // Queued by an earlier version, with no key: as before, nothing apart.
  const [old] = collapseOps([{ ...create, body: { ...create.body, client_key: undefined } }, edit1]);
  assert.equal(old.edits, undefined);
});

test('deleted while a create that was tried still waits: the delete goes, by its key', () => {
  const create = { seq: 1, method: 'POST', path: '/api/cardio', body: { date: '2026-04-09', activity: 'Run', duration_min: 30, client_key: 'k-0123456789' }, kind: 'cardio-create', key: 'cardio:-9', tempId: -9, id: -9, editedAt: 'a', changed: null };
  const edit = { seq: 2, method: 'PUT', path: '/api/cardio/-9', body: { notes: 'x' }, kind: 'cardio-update', key: 'cardio:-9', id: -9, editedAt: 'b', changed: ['notes'] };
  const del = { seq: 3, method: 'DELETE', path: '/api/cardio/-9', body: null, kind: 'cardio-delete', key: 'cardio:-9', id: -9, editedAt: 'c' };
  // Never tried: neither goes, as before.
  assert.deepEqual(collapseOps([create, edit, del]), []);
  // Tried (straight away, or by a replay): the delete goes, by the key.
  for (const ops of [[{ ...create, sent: true }, edit, del], [create, { ...edit, sent: true }, del]]) {
    const out = collapseOps(ops);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'cardio-delete');
    assert.equal(out[0].seq, 3);
    assert.equal(out[0].byKey.key, 'k-0123456789');
    assert.equal(out[0].byKey.path, '/api/cardio');
    assert.equal(out[0].byKey.editedAt, 'a', 'a repeat of the create is dated as the create');
    assert.equal(byKeyPath(out[0]), '/api/cardio/by-key/k-0123456789');
    assert.equal(deletePathWithId(out[0], 41), '/api/cardio/41');
    // Once it has gone, every request of it is done with.
    assert.deepEqual(sentSeqs(ops, ['cardio:-9']).sort(), [1, 2, 3]);
  }
  // A create from before keys can't be found by one: as before.
  assert.deepEqual(collapseOps([{ ...create, sent: true, body: { ...create.body, client_key: undefined } }, del]), []);
  // Nor can a coach's prescription (no key).
  const rx = { seq: 1, method: 'POST', path: '/api/trainer/members/3/prescriptions', body: { note: 'x', client_key: 'k-0123456789' }, kind: 'prescription-create', key: 'prescription:-4', tempId: -4, id: -4, sent: true };
  assert.equal(isKeyedCreate(rx), false);
  assert.deepEqual(collapseOps([rx, { seq: 2, method: 'DELETE', path: '/api/trainer/prescriptions/-4', kind: 'prescription-delete', key: 'prescription:-4', id: -4 }]), []);
});

test('an exercise or a new workout deleted after its create was tried goes by its key too', () => {
  const ex = { seq: 1, method: 'POST', path: '/lt/api/exercises', body: { name: 'Curl', client_key: 'k-ex-0123456789' }, kind: 'exercise-create', key: 'exercise:-5', tempId: -5, id: -5, sent: true };
  const [exDel] = collapseOps([ex, { seq: 2, method: 'DELETE', path: '/lt/api/exercises/-5', kind: 'exercise-delete', key: 'exercise:-5', id: -5 }]);
  assert.equal(byKeyPath(exDel), '/lt/api/exercises/by-key/k-ex-0123456789', 'under the base path');
  const w = { ...made(1, -77, { name: 'Legs' }), sent: true };
  const later = op(2, 'PUT', `/api/workout/${DAY2}`, { id: -77, name: 'Legs', exercises: [{ uuid: 'sq' }] });
  const merged = collapseOps([w, later]);
  assert.equal(merged[0].sent, true, 'tried stays tried through later saves');
  const [wDel] = collapseOps([w, later, op(3, 'DELETE', `/api/workout/${DAY2}?id=-77`)]);
  assert.equal(wDel.kind, 'workout-delete');
  assert.equal(byKeyPath(wDel), '/api/workout/by-key/web-workout-77');
  assert.equal(deletePathWithId(wDel, 12), `/api/workout/${DAY2}?id=12`);
  assert.equal(wDel.byKey.body.new_session, true);
  // Never tried: as before.
  assert.deepEqual(collapseOps([made(1, -77, { name: 'Legs' }), op(2, 'DELETE', `/api/workout/${DAY2}?id=-77`)]), []);
});

test('a delete by key stands: a second delete or a late save of the row does not take its place', () => {
  const create = { seq: 1, method: 'POST', path: '/api/cardio', body: { activity: 'Run', client_key: 'k-0123456789' }, kind: 'cardio-create', key: 'cardio:-9', tempId: -9, id: -9, sent: true };
  const del = (seq) => ({ seq, method: 'DELETE', path: '/api/cardio/-9', body: null, kind: 'cardio-delete', key: 'cardio:-9', id: -9 });
  const twice = collapseOps([create, del(2), del(3)]);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].byKey.key, 'k-0123456789');
  const w = { ...made(1, -77, { name: 'Legs' }), sent: true };
  const late = collapseOps([w, op(2, 'DELETE', `/api/workout/${DAY2}?id=-77`), op(3, 'PUT', `/api/workout/${DAY2}`, { id: -77, name: 'Legs', exercises: [] })]);
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, 'workout-delete');
  assert.equal(late[0].byKey.key, 'web-workout-77');
  assert.deepEqual(sentSeqs([w, op(2, 'DELETE', `/api/workout/${DAY2}?id=-77`), op(3, 'PUT', `/api/workout/${DAY2}`, { id: -77 })], [`workout:${DAY2}#-77`]).sort(), [1, 2, 3]);
});
