// Strong's iOS export is comma-separated and its Android export semicolon-
// separated (#151); either can start with a UTF-8 BOM. Both import the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStrong } from '../server/lib/workout-import/strong.js';
import { parseCsv } from '../server/lib/workout-import/common.js';
import { parseStrong as parseStrongApp } from '../src/lib/workout-import/strong.js';
import { parseCsv as parseCsvApp } from '../src/lib/workout-import/common.js';

const IOS = [
  'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
  '2024-08-01 18:23:30,"Push, Heavy",1h 5m,Bench Press (Barbell),1,100,5,0,0,"felt good, fast",,8',
  '2024-08-01 18:23:30,"Push, Heavy",1h 5m,Bench Press (Barbell),2,100,5,0,0,,,',
  '2024-08-01 18:23:30,"Push, Heavy",1h 5m,Plank,1,0,0,0,60,,,',
].join('\r\n');
const ANDROID = [
  'Date;Workout Name;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE;Weight Unit',
  '2024-08-01 18:23:30;Push, Heavy;Bench Press (Barbell);1;100;5;0;0;felt good, fast;;8;kg',
  '2024-08-01 18:23:30;Push, Heavy;Bench Press (Barbell);2;100;5;0;0;;;;kg',
  '2024-08-01 18:23:30;Push, Heavy;Plank;1;0;0;0;60;;;;kg',
].join('\n');

const shape = (ws) => ws.map(w => ({ date: w.date, name: w.name,
  ex: w.exercises.map(e => [e.sourceName, e.sets.map(s => [s.reps, s.weight, s.duration_sec || 0, s.rpe])]) }));
const WANT = [{ date: '2024-08-01', name: 'Push, Heavy',
  ex: [['Bench Press (Barbell)', [[5, 100, 0, 8], [5, 100, 0, null]]], ['Plank', [[0, 0, 60, null]]]] }];

for (const [label, parse] of [['server', parseStrong], ['app', parseStrongApp]]) {
  test(`${label}: a comma-separated (iOS) Strong export imports`, () => {
    assert.deepEqual(shape(parse(IOS, 'kg')), WANT);
  });
  test(`${label}: a semicolon-separated (Android) Strong export still imports`, () => {
    assert.deepEqual(shape(parse(ANDROID, 'kg')), WANT);
  });
  test(`${label}: a leading BOM still reads`, () => {
    assert.deepEqual(shape(parse('\uFEFF' + IOS, 'kg')), WANT);
    assert.deepEqual(shape(parse('\uFEFF' + ANDROID, 'kg')), WANT);
  });
}

test('CSV headers read past a BOM (the server decodes with it kept)', () => {
  for (const p of [parseCsv, parseCsvApp]) {
    assert.deepEqual(p('\uFEFFdate,reps\n2024-01-01,5', ','), [{ date: '2024-01-01', reps: '5' }]);
  }
});

test('the Strong adapter copies stay identical', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../server/lib/workout-import/strong.js'), read('../src/lib/workout-import/strong.js'));
});

test('the import screen no longer says Strong files are semicolon CSV', () => {
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(en.settings_workout_import.sources.strong, /semicolon/i);
});
