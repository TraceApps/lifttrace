import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStrong } from '../server/lib/workout-import/strong.js';
import { parseHevy } from '../server/lib/workout-import/hevy.js';

// Regression test for issue #76 (multiple workout sessions per day). Before
// the fix, server/routes/workout-import.js's commit route deduped by
// (user_id, date) alone, so a file with two distinctly-named same-day
// sessions silently dropped the second (skip mode) or deleted the first to
// make room for it (replace mode) — real, already-occurring data loss
// independent of anything the app itself does. The route fix scopes dedup
// to (user_id, date, name) instead; these tests confirm the PARSERS
// themselves already produce two separate same-date objects (the route-level
// fix has nothing to work with otherwise), which is the part of the root
// cause these parsers are responsible for. The route's own dedup/session_seq
// logic was verified by dry-running its SQL against a real SQLite engine
// (this sandbox has no compiled better-sqlite3 binding to import db.js
// directly) — see the commit message for that verification.

test('Strong: two differently-named workouts same day stay two separate entries', () => {
  const csv = [
    'Date;Workout Name;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE;Weight Unit',
    '2026-09-01 07:00:00;Morning Stretch;Standing Hamstring Stretch;1;0;1;0;60;;;;lbs',
    '2026-09-01 18:00:00;Push Day;Bench Press;1;135;5;0;0;;;;lbs',
  ].join('\n');

  const workouts = parseStrong(csv, 'lbs');
  assert.equal(workouts.length, 2, 'expected two separate sessions, not one merged/dropped');
  assert.deepEqual(workouts.map(w => w.date), ['2026-09-01', '2026-09-01']);
  const names = workouts.map(w => w.name).sort();
  assert.deepEqual(names, ['Morning Stretch', 'Push Day']);
});

test('Hevy: two differently-named workouts same day stay two separate entries', () => {
  const csv = [
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    'Morning Stretch,01 Sep 2026 07:00,01 Sep 2026 07:20,,Standing Hamstring Stretch,-1,,0,normal,0,1,0,0,',
    'Push Day,01 Sep 2026 18:00,01 Sep 2026 19:00,,Bench Press,-1,,0,normal,60,5,0,0,',
  ].join('\n');

  const workouts = parseHevy(csv, 'lbs');
  assert.equal(workouts.length, 2, 'expected two separate sessions, not one merged/dropped');
  assert.deepEqual(workouts.map(w => w.date), ['2026-09-01', '2026-09-01']);
  const names = workouts.map(w => w.name).sort();
  assert.deepEqual(names, ['Morning Stretch', 'Push Day']);
});

test('Strong: re-importing the same named workout on the same day is still one entry (not artificially split)', () => {
  // Two rows, same date + same workout name, different exercises — must
  // stay ONE workout object (this is a single real session with two
  // exercises), confirming the fix doesn't over-correct into splitting
  // everything by row.
  const csv = [
    'Date;Workout Name;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE;Weight Unit',
    '2026-09-01 18:00:00;Push Day;Bench Press;1;135;5;0;0;;;;lbs',
    '2026-09-01 18:00:00;Push Day;Overhead Press;1;65;8;0;0;;;;lbs',
  ].join('\n');

  const workouts = parseStrong(csv, 'lbs');
  assert.equal(workouts.length, 1);
  assert.equal(workouts[0].exercises.length, 2);
});
