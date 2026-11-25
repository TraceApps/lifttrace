/**
 * Name matching that compared lowercase text only (from nutritrace#346):
 * Smart Log matching a typed exercise to the library, and the exercise info
 * sheet picking the exact name out of its search. Both fold accents now, so
 * a name typed without them still finds the exercise, and English matches as
 * before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldText } from '../src/lib/search-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// smartLogWorkout.js pulls in the app's stores, so the scorer is lifted out
// of its source and run on its own.
const scoreMatch = (() => {
  const src = read('../src/lib/smartLogWorkout.js');
  const start = src.indexOf('function _scoreMatch');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 2);
  return new Function('foldText', `${body}\nreturn _scoreMatch;`)(foldText);
})();

test('Smart Log finds an accented exercise typed without accents', () => {
  assert.equal(scoreMatch('press frances', 'Press Francés'), 100);
  assert.equal(scoreMatch('sentadilla bulgara', 'Sentadilla búlgara con mancuernas'), 85);
  assert.equal(scoreMatch('Press Francés', 'press frances'), 100);
});

test('Smart Log scores English names as before', () => {
  assert.equal(scoreMatch('Bench Press', 'bench press'), 100);
  assert.equal(scoreMatch('bench', 'Bench Press'), 85);
  assert.equal(scoreMatch('press', 'Bench Press'), 70);
  assert.equal(scoreMatch('incline bench', 'Bench Press'), 25);
  assert.equal(scoreMatch('squat', 'Bench Press'), 0);
});

test('the exercise info sheet folds the exact-name check', () => {
  const sheet = read('../src/components/exercises/ExerciseInfoSheet.svelte');
  assert.match(sheet, /const lc = foldText\(exerciseName\)\.trim\(\);/);
  assert.match(sheet, /results\.find\(r => foldText\(r\.name\)\.trim\(\) === lc\)/);
});

test('Trace finds templates and programs by name, and the picker offers no near-duplicate', () => {
  const tools = read('../src/lib/aiTools.js');
  assert.match(tools, /if \(foldText\(t\.name\) === lower\) \{ tpl = t; break outer; \}/);
  assert.match(tools, /programs\.find\(p => foldText\(p\.name\) === lower\)/);
  assert.doesNotMatch(tools, /\.toLowerCase\(\) === lower/);
  const picker = read('../src/components/exercises/ExercisePicker.svelte');
  assert.match(picker, /!filtered\.some\(ex => foldText\(ex\.name\) === foldText\(search\)\.trim\(\)\)/);
});
