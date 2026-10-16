/**
 * The rest between sets, shared with the watch.
 *
 * The rules that matter: nothing is sent to a watch that has not been opened
 * lately, an adopted rest is not echoed back, and the phone's own notice only
 * stops mirroring to the wrist when the wrist has the rest itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('nothing is sent to a watch that has not been opened lately', () => {
  const src = read('../src/lib/wear-pairing.js');
  assert.match(src, /export async function watchInUse\(\)/);
  assert.match(src, /publishRest[\s\S]*?if \(!\(await watchInUse\(\)\)\) return false;/);
});

test('a rest adopted from the watch is not echoed back to it', () => {
  const src = read('../src/stores/restTimer.js');
  // The echo would carry a newer stamp and beat whatever either device does
  // next, which is how a skipped rest restarts itself.
  assert.match(src, /stopRest\(false, \{ fromWatch: true \}\)/);
  assert.match(src, /if \(!fromWatch\) _tellWatch\(null\)/);
});

test('both devices are told when a rest starts, is extended or is skipped', () => {
  const src = read('../src/stores/restTimer.js');
  const calls = src.match(/_tellWatch\(/g) || [];
  // start, extend, stop, plus the definition itself.
  assert.ok(calls.length >= 4, `expected the watch to be told at every turn, saw ${calls.length}`);
});

test('the phone keeps its notice to itself only when the watch has the rest', () => {
  const store = read('../src/stores/restTimer.js');
  assert.match(store, /localOnly: _onWatch/);
  const receiver = read('../android/app/src/main/java/com/lifttrace/app/RestTimerCueReceiver.java');
  // Honoured, not hard-coded: with no watch in the picture the mirror is the
  // only thing that reaches a wrist.
  assert.match(receiver, /\.setLocalOnly\(localOnly\)/);
  assert.doesNotMatch(receiver, /\.setLocalOnly\(true\)/);
});

test('the watch says what rang rather than buzzing about nothing', () => {
  const ongoing = read('../android/wear/src/main/java/com/lifttrace/app/wear/RestOngoing.kt');
  assert.match(ongoing, /fun rang\(ctx: Context, label: String\)/);
  const alarm = read('../android/wear/src/main/java/com/lifttrace/app/wear/RestAlarm.kt');
  assert.match(alarm, /RestOngoing\.rang\(context, label\)/);
});
