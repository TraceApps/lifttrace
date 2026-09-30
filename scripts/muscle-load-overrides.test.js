import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifttrace-muscle-load-'));
process.env.DB_PATH = path.join(dir, 'lifttrace.db');

const { default: db } = await import('../server/db.js');
const {
  getMuscleOverride, muscleOverrideMap, saveMuscleOverride, deleteMuscleOverride,
} = await import('../server/lib/exercise-muscle-overrides.js');

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same global exercise has independent profiles for two users and single-user mode', () => {
  const exerciseId = Number(db.prepare(`INSERT INTO exercises
    (name, category, primary_muscles, secondary_muscles, equipment, source, is_global)
    VALUES ('Test Lunge', 'upper legs', '["Quadriceps"]', '["Glutes"]', '[]', 'test', 1)`).run().lastInsertRowid);
  const addUser = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, 'test')`);
  const user1 = Number(addUser.run('muscle-user-1').lastInsertRowid);
  const user2 = Number(addUser.run('muscle-user-2').lastInsertRowid);

  assert.deepEqual(saveMuscleOverride(null, exerciseId, { quadriceps: 0.25, gluteal: 1 }),
    { quadriceps: 0.25, gluteal: 1 });
  saveMuscleOverride(user1, exerciseId, { hamstring: 0.5, gluteal: 0.8 });
  saveMuscleOverride(user2, exerciseId, { quadriceps: 1 });

  assert.deepEqual(getMuscleOverride(null, exerciseId), { quadriceps: 0.25, gluteal: 1 });
  assert.deepEqual(getMuscleOverride(user1, exerciseId), { hamstring: 0.5, gluteal: 0.8 });
  assert.deepEqual(getMuscleOverride(user2, exerciseId), { quadriceps: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exercise_muscle_overrides WHERE exercise_id = ?').get(exerciseId).n, 3);

  // Saving again updates the scoped row rather than creating a duplicate.
  saveMuscleOverride(user1, exerciseId, { hamstring: 0.75 });
  assert.deepEqual(muscleOverrideMap(user1).get(exerciseId), { hamstring: 0.75 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exercise_muscle_overrides WHERE user_id = ? AND exercise_id = ?').get(user1, exerciseId).n, 1);

  assert.equal(deleteMuscleOverride(user1, exerciseId), 1);
  assert.equal(getMuscleOverride(user1, exerciseId), null);
  assert.deepEqual(getMuscleOverride(user2, exerciseId), { quadriceps: 1 }, 'deleting one profile cannot touch another user');
});
