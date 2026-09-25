/**
 * A day with only cardio on it is still a day you trained.
 *
 * The Diary's streak, "This Week" dots and calendar month view all derived
 * "done" from `workout_log` alone, so a run with no lifting behind it read
 * as an empty day. They now read `activeDateSet` — lifting days union cardio
 * days — with two conditions on that union:
 *
 *   1. Cardio is opt-in (`settings.cardioEnabled`, off by default). While it
 *      is off the Diary must not fetch cardio at all, and must not count it,
 *      or someone gets streak credit from sessions their Diary isn't showing.
 *   2. Saving a session has to move the dot now. `CardioCard` keeps its own
 *      list, so without an event the Diary's date sets stay stale until the
 *      page is left and re-entered.
 *
 * Reported by a self-hoster who logged a run and saw it count nowhere.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const diary = read('../src/routes/Diary.svelte');
const cardioCard = read('../src/components/diary/CardioCard.svelte');

/** Code only: the comments here discuss these names in prose. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .filter(l => !/^\s*\/\//.test(l))
  .join('\n');

test('the streak, week strip and calendar all read the union, not the lifting set', () => {
  assert.match(code(diary), /\$: activeDateSet = \$cardioEnabled/);
  const streak = code(diary).slice(code(diary).indexOf('$: streakCount'), code(diary).indexOf('$: streakCount') + 900);
  assert.doesNotMatch(streak, /workoutDateSet/, 'the streak counts any activity, not only lifting');
  assert.match(code(diary), /done: activeDateSet\.has\(key\)/, 'the week-strip dots');
  const cal = code(diary).slice(code(diary).indexOf('function calHasWorkout'));
  assert.match(cal.slice(0, 200), /return activeDateSet\.has\(key\)/, 'the calendar month view');
});

test('cardio is neither fetched nor counted while the setting is off', () => {
  const body = code(diary).slice(code(diary).indexOf('async function loadWorkoutDates('));
  const guard = body.indexOf('if (!$cardioEnabled)');
  const fetchAt = body.indexOf('LtApi.listCardio()');
  assert.ok(guard > -1, 'the load is gated on the setting');
  assert.ok(guard < fetchAt, 'the gate comes before the fetch');
  assert.match(body.slice(guard, fetchAt), /cardioDateSet = new Set\(\);/, 'and clears what an earlier load left');
  // The union is gated too, so it can never outlive the opt-in.
  assert.match(code(diary), /\$: activeDateSet = \$cardioEnabled\s*\n?\s*\?[\s\S]{0,80}:\s*workoutDateSet/);
});

test('saving or deleting a session tells the Diary, and the Diary reloads', () => {
  assert.match(cardioCard, /const dispatch = createEventDispatcher\(\)/);
  for (const fn of ['logFromTemplate', 'save', 'remove']) {
    const start = cardioCard.indexOf(`async function ${fn}(`);
    const body = cardioCard.slice(start, cardioCard.indexOf('\n  }', start));
    assert.match(body, /dispatch\('change'\)/, `${fn} announces the change`);
  }
  assert.match(diary, /<CardioCard on:change=\{loadWorkoutDates\} \/>/);
});
