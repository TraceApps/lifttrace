/**
 * Moving the Diary to another date has to FETCH that date, not just point
 * the header at it.
 *
 * `currentDate.set()` on its own updates the store, so the date label and
 * the week-strip selection move, while the session panel keeps rendering
 * whatever `todayLog` last held. Only `loadWorkout()` fetches, and it sets
 * `currentDate` itself on the way, so every navigation path should go
 * through it.
 *
 * Found in the This Week strip and the Recent list (#111, by @benniemosher),
 * and again in the hold timer's "open this hold's date" button.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const diary = read('../src/routes/Diary.svelte');
const holdTimer = read('../src/components/diary/HoldTimer.svelte');

/** Code only: the comments here discuss `currentDate.set()` by name. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .filter(l => !/^\s*\/\//.test(l))
  .join('\n');

test('the Diary has one helper that fetches, updates notes and coach feedback', () => {
  assert.match(
    diary,
    /function goToDiaryDate\(ds\) \{\s*\n\s*loadWorkout\(ds\)\.then\(\(\) => \{ notes = \$todayLog\?\.notes \|\| ''; loadCoachFeedback\(ds\); \}\);/,
  );
});

test('the day arrows and Today use that same sequence', () => {
  for (const fn of ['prevDay', 'nextDay', 'goToday']) {
    const body = diary.slice(diary.indexOf(`function ${fn}(`), diary.indexOf('}', diary.indexOf(`function ${fn}(`)) + 1);
    assert.match(body, /loadWorkout\(ds\)\.then\(/, `${fn} fetches the day it moves to`);
  }
});

test('This Week and Recent go through the helper, not a bare store write', () => {
  assert.match(diary, /class="rail-week-day"[\s\S]{0,200}on:click=\{\(\) => goToDiaryDate\(day\.key\)\}/);
  assert.match(diary, /class="rail-recent-row" on:click=\{\(\) => goToDiaryDate\(w\.date\)\}/);
});

test("the hold timer asks the Diary to move rather than moving the date itself", () => {
  assert.doesNotMatch(code(holdTimer), /currentDate\.set\(/, 'a component setting the date cannot fetch it');
  assert.match(holdTimer, /on:click=\{\(\) => dispatch\('goToDate', state\.date\)\}/);
  assert.match(diary, /<HoldTimer on:goToDate=\{\(e\) => goToDiaryDate\(e\.detail\)\} \/>/);
});

test('no click handler anywhere in the Diary moves the date without fetching it', () => {
  const handlers = [...code(diary).matchAll(/on:click=\{[^}]*currentDate\.set\([^}]*\}/g)].map(m => m[0]);
  assert.deepEqual(handlers, [], `these move the header without loading the day: ${handlers.join(' | ')}`);
});

test('the one bare currentDate.set left in the Diary is the deliberate mount path', () => {
  const bare = [...code(diary).matchAll(/currentDate\.set\(([^)]*)\)/g)].map(m => m[1]);
  assert.deepEqual(bare, ['targetDate'], 'onMount skips the refetch when the store is already on today');
});
