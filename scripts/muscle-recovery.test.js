import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMuscleRecovery } from '../src/lib/muscle-recovery.js';

test('recovery uses snapshots first and weights personal and catalog muscle loads', () => {
  const realNow = Date.now;
  Date.now = () => new Date('2026-09-22T12:00:00').getTime();
  try {
    const library = [
      {
        id: 1,
        primary_muscles: ['Chest'],
        secondary_muscles: ['Triceps'],
        muscle_load: { chest: 0.6, triceps: 0.2 },
      },
      { id: 2, primary_muscles: ['Chest'], secondary_muscles: ['Triceps'] },
      { id: 3, primary_muscles: [], secondary_muscles: [], muscle_load: { abs: 0.7, obliques: 0.4 } },
    ];
    const set = { completed: true, warmup: false, weight: 10, reps: 10 };
    const workouts = [{
      date: '2026-09-21',
      exercises: [
        // A snapshot is authoritative even though the saved profile changed.
        { exercise_id: 1, muscle_load: { gluteal: 1 }, sets: [set] },
        // No snapshot: catalog primary 1.0 / secondary 0.4 remains unchanged.
        { exercise_id: 2, sets: [set] },
        // Abs + obliques share the broad recovery bucket; use max, not sum.
        { exercise_id: 3, sets: [set] },
      ],
    }];

    const result = computeMuscleRecovery(workouts, library);
    assert.equal(result.glutes.sets, 1);
    assert.equal(result.glutes.volume, 100);
    assert.equal(result.chest.sets, 1);
    assert.equal(result.triceps.sets, 0.4);
    assert.equal(result.triceps.volume, 40);
    assert.equal(result.core.sets, 0.7);
    assert.equal(result.core.volume, 70);
    assert.equal(result.biceps.sets, 0);
  } finally {
    Date.now = realNow;
  }
});

test('recovery uses a personal profile when an older workout has no snapshot', () => {
  const realNow = Date.now;
  Date.now = () => new Date('2026-09-22T12:00:00').getTime();
  try {
    const result = computeMuscleRecovery(
      [{ date: '2026-09-21', exercises: [{
        exercise_id: 1,
        sets: [{ completed: true, warmup: false, weight: 20, reps: 5 }],
      }] }],
      [{ id: 1, primary_muscles: ['Quadriceps'], muscle_load: { hamstring: 0.5, gluteal: 1 } }],
    );
    assert.equal(result.quads.sets, 0);
    assert.equal(result.hamstrings.sets, 0.5);
    assert.equal(result.glutes.sets, 1);
  } finally {
    Date.now = realNow;
  }
});
