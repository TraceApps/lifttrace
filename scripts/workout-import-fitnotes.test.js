/**
 * FitNotes import: the unit and the date.
 *
 * Both bugs here came from one r/selfhosted report and were reproduced from
 * the reporter's own rows before being fixed, so the numbers below are the
 * real ones rather than invented examples.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseFitnotes } from '../server/lib/workout-import/fitnotes.js';

const COLUMN_FORM = 'Date,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time';
const first = (out) => out[0].exercises[0].sets[0].weight;

test('a kg export using the Weight Unit column is not read as pounds', () => {
  // The reported symptom: a 74.6 kg bench arrived as 33.84, which is 74.6
  // divided by 2.20462. The unit lived in its own column and the parser only
  // ever looked at the header, where it found nothing and assumed pounds.
  const csv = [COLUMN_FORM, '2025-12-23,Bench Press,Chest,74.6,kgs,5,,,'].join('\n');
  assert.equal(first(parseFitnotes(csv, 'kg')), 74.6);
  assert.notEqual(first(parseFitnotes(csv, 'kg')), 33.84);
});

test('the Weight Unit column still converts when the units differ', () => {
  const csv = [COLUMN_FORM, '2025-12-23,Bench Press,Chest,80,kgs,5,,,'].join('\n');
  assert.equal(first(parseFitnotes(csv, 'lbs')), 176.37);
});

test('the unit is read per row, because one export can hold both', () => {
  // FitNotes stores the unit against the exercise, not the account, so a
  // file-wide guess would be wrong for half of a mixed log.
  const csv = [
    COLUMN_FORM,
    '2025-12-23,Bench Press,Chest,80,kgs,5,,,',
    '2025-12-23,Curl,Arms,30,lbs,10,,,',
  ].join('\n');
  const [bench, curl] = parseFitnotes(csv, 'kg')[0].exercises;
  assert.equal(bench.sets[0].weight, 80);
  assert.equal(curl.sets[0].weight, 13.61);
});

test('the older header form keeps working', () => {
  const kg = ['Date,Exercise,Category,Weight (kgs),Reps,Distance,Distance Unit,Time,Comment',
    '2025-12-23,Bench Press,Chest,80,5,,,,'].join('\n');
  assert.equal(first(parseFitnotes(kg, 'lbs')), 176.37);
  const lbs = ['Date,Exercise,Category,Weight (lbs),Reps,Distance,Distance Unit,Time,Comment',
    '2025-12-23,Bench Press,Chest,225,5,,,,'].join('\n');
  assert.equal(first(parseFitnotes(lbs, 'kg')), 102.06);
});

test('a localized export imports its workouts instead of nothing', () => {
  // FitNotes writes the date in the phone's locale. Requiring ISO meant a
  // Spanish or German export skipped every row and imported zero workouts,
  // with nothing on screen to say why.
  const csv = [
    COLUMN_FORM,
    '23/12/2025,Barbell Glute Bridge,Legs,80,kgs,4,,,',
    '05/01/2026,Squat,Legs,100,kgs,3,,,',
  ].join('\n');
  const out = parseFitnotes(csv, 'kg');
  assert.deepEqual(out.map(w => w.date), ['2025-12-23', '2026-01-05']);
});

test('a month-first export is read month-first', () => {
  // 12/31 can only be a month followed by a day, and that one row settles
  // the order for the whole file, including the rows that are ambiguous on
  // their own.
  const csv = [
    COLUMN_FORM,
    '12/31/2025,Bench Press,Chest,225,lbs,5,,,',
    '01/05/2026,Squat,Legs,315,lbs,3,,,',
  ].join('\n');
  assert.deepEqual(parseFitnotes(csv, 'lbs').map(w => w.date), ['2025-12-31', '2026-01-05']);
});

test('nothing that is not a date is turned into one', () => {
  const csv = [COLUMN_FORM, 'not a date,Bench Press,Chest,80,kgs,5,,,', '2025-13-45,Squat,Legs,100,kgs,3,,,'].join('\n');
  assert.deepEqual(parseFitnotes(csv, 'kg'), []);
});

test('timed holds survive both changes', () => {
  // Issue #89's behaviour, re-checked here because the row loop was rewritten.
  const out = parseFitnotes([COLUMN_FORM, '2025-12-23,Plank,Core,0,kgs,0,,,1:30'].join('\n'), 'kg');
  assert.equal(out[0].exercises[0].set_type, 'time');
  assert.equal(out[0].exercises[0].sets[0].duration_sec, 90);
});

test('the app and the server parse a file the same way', () => {
  // Standalone Android mode runs the import in the browser copy, so a fix
  // that lands in only one of them is a fix that half the users never get.
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../server/lib/workout-import/fitnotes.js'), read('../src/lib/workout-import/fitnotes.js'));
});
