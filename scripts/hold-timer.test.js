/**
 * Hold timer for timed sets (issue #89).
 *
 * The identity rule (which set a finished hold belongs to) is pure and runs
 * for real here. The store itself imports the rest timer, which pulls in
 * Capacitor, so its wiring is checked statically.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { holdMatches } = await import('../src/lib/holdMatch.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const plank = (over = {}) => ({
  uuid: 'ex-plank', exercise_id: 7, exercise_name: 'Plank',
  sets: [{ uuid: 's1', duration_sec: 60 }, { uuid: 's2', duration_sec: 60 }],
  ...over,
});
const hold = (over = {}) => ({
  date: '2026-09-14', exIdx: 2, setIdx: 1,
  exerciseId: 7, exerciseUuid: 'ex-plank', setUuid: 's2',
  ...over,
});

test('a hold lands on its set by uuid even after the exercise was reordered', () => {
  // Started at position 2, the exercise has since been moved to position 0.
  assert.equal(holdMatches(hold(), { date: '2026-09-14', exIdx: 0, exercise: plank(), setIdx: 1 }), true);
  assert.equal(holdMatches(hold(), { date: '2026-09-14', exIdx: 0, exercise: plank(), setIdx: 0 }), false,
    'the other set on the same exercise must not light up');
});

test('uuids keep a hold off a different exercise at the same position', () => {
  // Another session, or the plank was deleted and something else slid in.
  const other = plank({ uuid: 'ex-bench', exercise_id: 3, exercise_name: 'Bench Press' });
  assert.equal(holdMatches(hold(), { date: '2026-09-14', exIdx: 2, exercise: other, setIdx: 1 }), false);
});

test('an unsaved exercise with no uuid falls back to position and exercise id', () => {
  const fresh = plank({ uuid: undefined, sets: [{ duration_sec: 0 }, { duration_sec: 0 }] });
  const h = hold({ exerciseUuid: null, setUuid: null });
  assert.equal(holdMatches(h, { date: '2026-09-14', exIdx: 2, exercise: fresh, setIdx: 1 }), true);
  assert.equal(holdMatches(h, { date: '2026-09-14', exIdx: 3, exercise: fresh, setIdx: 1 }), false);
  assert.equal(holdMatches(h, { date: '2026-09-14', exIdx: 2, exercise: { ...fresh, exercise_id: 99 }, setIdx: 1 }), false);
});

test('a hold never matches another day', () => {
  assert.equal(holdMatches(hold(), { date: '2026-09-15', exIdx: 2, exercise: plank(), setIdx: 1 }), false);
});

test('asking without a set index matches the exercise as a whole', () => {
  assert.equal(holdMatches(hold(), { date: '2026-09-14', exIdx: 2, exercise: plank() }), true);
  assert.equal(holdMatches(null, { date: '2026-09-14', exIdx: 2, exercise: plank() }), false);
});

// ── Wiring ───────────────────────────────────────────────────────────────

const store = read('../src/stores/holdTimer.js');
const card = read('../src/components/diary/ExerciseCard.svelte');
const row = read('../src/components/diary/SetRow.svelte');
const overlay = read('../src/components/diary/HoldTimer.svelte');

test('elapsed time comes from timestamps, so a locked phone still reads true', () => {
  assert.match(store, /Math\.floor\(\(Date\.now\(\) - state\.goAt\) \/ 1000\)/);
  assert.match(store, /localStorage\.setItem\(LS_KEY/, 'a reload mid-hold must not lose it');
});

test('there is a lead-in, it can be skipped, and stopping inside it records nothing', () => {
  assert.match(store, /LEAD_IN_MS = 3000/);
  assert.match(store, /export function skipLeadIn/);
  assert.match(store, /if \(elapsedSec > 0\) holdResult\.set\(result\)/);
});

test('starting a hold stops the rest countdown, and cues honour the rest alert settings', () => {
  assert.match(store, /stopRest\(false\)/);
  const rest = read('../src/stores/restTimer.js');
  const cue = rest.slice(rest.indexOf('export function playTimerCue'));
  assert.match(cue.slice(0, 700), /get\(restAlertTone\)/);
  assert.match(cue.slice(0, 700), /get\(restAlertVibrate\)/);
});

test('the result is applied through the card\'s normal set update and completes the set', () => {
  // Same path as a tapped tick, so rest timer, PR detection and superset
  // rounds behave identically.
  assert.match(card, /consumeHoldResult\(\);\s*\n\s*updateSet\(target, \{ \.\.\.sets\[target\], duration_sec: r\.elapsedSec, completed: true \}\)/);
});

test('the row button lives inside the time field and only on unfinished or running sets', () => {
  const timeField = row.slice(row.indexOf('{:else if timed}'), row.indexOf('{:else}', row.indexOf('{:else if timed}')));
  assert.match(timeField, /class="split-btn hold-btn"/);
  assert.match(timeField, /\{#if !set\.completed \|\| holdRunning\}/);
});

test('the on-screen timer is mounted in the Diary and stacks with the workout pill', () => {
  assert.match(read('../src/routes/Diary.svelte'), /<HoldTimer \/>/);
  assert.match(read('../src/components/WorkoutModeBar.svelte'), /var\(--hold-h, 0px\)/);
  assert.match(overlay, /--hold-h/);
});

test('the screen is kept awake only for the hold, and a user\'s own setting is left alone', () => {
  assert.match(overlay, /!get\(wantScreenOn\)/);
  assert.match(overlay, /if \(!active && tookWakeLock\) \{ tookWakeLock = false; disableWakeLock\(\); \}/);
});

test('a hold whose set disappeared still tells you how long you held', () => {
  assert.match(overlay, /hold_timer\.set_not_found/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.hold_timer.set_not_found, /\{time\}/);
});
