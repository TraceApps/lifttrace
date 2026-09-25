import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRecoveryAdjustments,
  computeMuscleRecovery,
  RECOVERY_ADJUSTMENT_HOURS,
} from '../src/lib/muscle-recovery.js';

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

test('manual recovery adjustments age naturally and keep the estimate metadata', () => {
  const estimate = {
    chest: {
      lastDate: '2026-09-21', hoursAgo: 24, sets: 3, volume: 300,
      basisWorkoutTimestamp: '2026-09-21 18:00:00',
    },
  };
  const now = new Date('2026-09-22T14:00:00Z').getTime();
  const adjusted = applyRecoveryAdjustments(estimate, [{
    muscle: 'chest',
    effective_age_hours: RECOVERY_ADJUSTMENT_HOURS.Recovering,
    adjusted_at: '2026-09-22T12:00:00.000Z',
    basis_workout_timestamp: '2026-09-21 18:00:00',
  }], now);

  assert.equal(adjusted.chest.hoursAgo, 38);
  assert.equal(adjusted.chest.sets, 3);
  assert.equal(adjusted.chest.adjusted, true);
});

test('newer training supersedes a subjective recovery adjustment', () => {
  const estimate = {
    chest: {
      lastDate: '2026-09-22', hoursAgo: 2, sets: 3, volume: 300,
      basisWorkoutTimestamp: '2026-09-22 12:00:00',
    },
  };
  const adjusted = applyRecoveryAdjustments(estimate, [{
    muscle: 'chest', effective_age_hours: 60,
    adjusted_at: '2026-09-22T12:00:00.000Z',
    basis_workout_timestamp: '2026-09-21 12:00:00',
  }], new Date('2026-09-22T14:00:00Z').getTime());

  assert.equal(adjusted.chest.hoursAgo, 2);
  assert.equal(adjusted.chest.adjusted, undefined);
});

test('an untrained muscle can be adjusted until its first relevant workout', () => {
  const estimate = {
    calves: { lastDate: null, hoursAgo: null, sets: 0, volume: 0, basisWorkoutTimestamp: null },
  };
  const adjusted = applyRecoveryAdjustments(estimate, [{
    muscle: 'calves', effective_age_hours: 12,
    adjusted_at: '2026-09-22T12:00:00.000Z', basis_workout_timestamp: null,
  }], new Date('2026-09-22T13:00:00Z').getTime());

  assert.equal(adjusted.calves.hoursAgo, 13);
  assert.equal(adjusted.calves.adjusted, true);
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
