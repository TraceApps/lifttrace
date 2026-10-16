/**
 * The stamp that settles the workout timer between the phone and the watch.
 *
 * Whichever device spoke last wins, so the phone has to be able to say when
 * it last spoke. A timer that was already running when the app updated keeps
 * its stamp inside the saved timer rather than in the key added for it, and
 * reading that as nought would hand the argument to the watch: the phone
 * would adopt whatever the watch last said, and finishing the workout would
 * write its length down as zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { timerStampedAt, adoptTimer } = await import('../src/stores/workoutTimer.js');

test('a timer carrying its own stamp still counts as having spoken', () => {
  store.clear();
  // What an install from before the separate key looks like.
  store.set('lt:workoutTimer', JSON.stringify({ date: '2026-09-21', startTime: 1, baseElapsed: 0, paused: false, at: 1700000000000 }));
  assert.equal(timerStampedAt(), 1700000000000);
});

test('the separate key wins once it exists', () => {
  store.clear();
  store.set('lt:workoutTimer', JSON.stringify({ at: 1700000000000 }));
  store.set('lt:workoutTimerAt', '1700000009999');
  assert.equal(timerStampedAt(), 1700000009999);
});

test('nothing saved means nothing said', () => {
  store.clear();
  assert.equal(timerStampedAt(), 0);
});

test('a stop is still dated, so it cannot look older than what it ended', () => {
  store.clear();
  adoptTimer(null, 1700000005000);
  assert.equal(store.get('lt:workoutTimer'), undefined);
  assert.equal(timerStampedAt(), 1700000005000);
});

test('adopting the watch keeps the watch stamp, not this moment', () => {
  store.clear();
  adoptTimer({ date: '2026-09-21', startTime: 5, baseElapsed: 0, paused: true, pausedElapsed: 90 }, 1700000004242);
  assert.equal(timerStampedAt(), 1700000004242);
});
