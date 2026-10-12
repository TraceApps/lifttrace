/**
 * The phone's watch plugin once dropped any number in milliseconds, so the
 * watch was told the workout timer started at 0 and both counted from 1970:
 * 497712 hours. A timer like that is no timer, wherever it is read from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { sane } = await import('../src/stores/workoutTimer.js');

test('a timer started at 0 is no timer', () => {
  assert.equal(sane({ date: '2026-10-11', startTime: 0, baseElapsed: 0, paused: false }), null);
  assert.equal(sane({ date: '2026-10-11', startTime: 1791700000000, baseElapsed: 0, paused: false }).startTime, 1791700000000);
});

test('one resumed after counting from 1970 is no timer either', () => {
  assert.equal(sane({ startTime: 1791700000000, baseElapsed: 1791700000, paused: false }), null);
  assert.ok(sane({ startTime: 1791700000000, baseElapsed: 1800, paused: false }));
});

test('a paused one keeps what it ran, unless it ran since 1970', () => {
  assert.ok(sane({ paused: true, pausedElapsed: 3600 }));
  assert.equal(sane({ paused: true, pausedElapsed: 1791700000 }), null);
  assert.equal(sane(null), null);
});

test("the watch plugin reads numbers of any size, and never through Capacitor's getDouble", () => {
  const plugin = readFileSync(new URL('../android/app/src/main/java/com/lifttrace/app/WearPairingPlugin.java', import.meta.url), 'utf8');
  assert.doesNotMatch(plugin, /call\.getDouble\(/);
  assert.match(plugin, /putLong\("startTime", whole\(call, "startTime"\)\)/);
  assert.match(plugin, /long stamp = whole\(call, "at"\);/);
  const wear = readFileSync(new URL('../src/lib/wear-pairing.js', import.meta.url), 'utf8');
  assert.match(wear, /const local = sane\(JSON\.parse\(localStorage\.getItem\('lt:workoutTimer'\) \|\| 'null'\)\);/);
});
