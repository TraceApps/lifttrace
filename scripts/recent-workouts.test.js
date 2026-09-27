/**
 * Two readers of /api/workout/recent (issue #124, reported by @Scorch-Light).
 *
 * Statistics lit a day on the heatmap, and in the streak dots, for a
 * workout with nothing in it: removing the last exercise from a day leaves
 * that empty workout behind, and the Diary showed the day as empty.
 *
 * The Diary's Last Workout card and the desktop sidebar's Recent Workouts
 * read the same list with JSON.parse, but the server (and the phone) hand
 * the exercises over as a list already. JSON.parse threw on every row, a
 * catch swallowed it, and both cards stayed empty for everyone. Verified in
 * a browser against a running server, online and offline.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stats = read('../src/routes/Statistics.svelte');
const diary = read('../src/routes/Diary.svelte');

test('Statistics leaves out a workout with no exercises before counting days', () => {
  const at = stats.indexOf("fetch('/api/workout/recent?limit=365'");
  const block = stats.slice(at, stats.indexOf('workoutDates = new Set', at) + 60);
  assert.match(block, /\.filter\(l =>\s*\n?\s*\(typeof l\.exercises === 'string' \? JSON\.parse\(l\.exercises \|\| '\[\]'\) : \(l\.exercises \|\| \[\]\)\)\.length > 0\)/);
  assert.ok(block.indexOf('.filter(') < block.indexOf('workoutDates = new Set'), 'filtered before the heatmap and streak dots read it');
});

test('the Diary reads a recent workout as the list it arrives as', () => {
  const m = diary.match(/const exercisesOf = \(w\) => (\(typeof w\?\.exercises === 'string'[^\n]+\));/);
  assert.ok(m, 'one helper for every read');
  const exercisesOf = new Function('w', `return ${m[1]};`);
  assert.deepEqual(exercisesOf({ exercises: [{ a: 1 }] }), [{ a: 1 }], 'a list, as the server and the phone send it');
  assert.deepEqual(exercisesOf({ exercises: '[{"a":1}]' }), [{ a: 1 }], 'text still works');
  assert.deepEqual(exercisesOf({}), []);
  // No read of a recent row parses it raw any more.
  // (The helper itself parses w.exercises, guarded by the typeof test.)
  assert.doesNotMatch(diary, /JSON\.parse\((rw|recent)\.exercises/, 'no raw parse of a recent row');
  assert.match(diary, /recentWorkouts = \(await res\.json\(\)\)\.filter\(w => exercisesOf\(w\)\.length > 0\)/);
  assert.match(diary, /const exs = exercisesOf\(recent\);/, 'quickLoad');
  assert.match(diary, /\{@const exs = exercisesOf\(rw\)\}/, 'the Last Workout card');
});

test('the sidebar list is keyed by id and shows the real name', () => {
  // Two sessions on one day share a date, and a duplicate key throws.
  assert.match(diary, /\{#each recentWorkouts as w \(w\.id\)\}/);
  assert.doesNotMatch(diary, /w\.workout_name/, 'there is no such field; every row read as untitled');
  assert.match(diary, /\{w\.name \|\| \$_\('diary_extra\.untitled_workout'\)\}/);
});

test('what the two cards say is translatable', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.diary_extra.untitled_workout, 'Untitled Workout');
  assert.match(en.diary_extra.exercise_count, /\{count, plural, one \{# exercise\} other \{# exercises\}\}/);
  assert.doesNotMatch(diary, /exs\.length === 1 \? 'exercise' : 'exercises'/);
});
