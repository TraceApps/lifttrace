import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifttrace-recovery-adjustments-'));
process.env.DB_PATH = path.join(dir, 'lifttrace.db');

const { default: db } = await import('../server/db.js');
const {
  deleteRecoveryAdjustment,
  listRecoveryAdjustments,
  saveRecoveryAdjustment,
} = await import('../server/lib/muscle-recovery-adjustments.js');

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recovery adjustments are scoped, replaceable, and soft deletable', () => {
  const addUser = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, 'test')`);
  const user1 = Number(addUser.run('recovery-user-1').lastInsertRowid);
  const user2 = Number(addUser.run('recovery-user-2').lastInsertRowid);

  saveRecoveryAdjustment(null, 'chest', 'Fatigued', null, '2020-09-22T12:00:00.000Z');
  saveRecoveryAdjustment(user1, 'chest', 'Recovering', 'basis-1', '2020-09-22T12:00:00.000Z');
  saveRecoveryAdjustment(user2, 'chest', 'Fresh', 'basis-2', '2020-09-22T12:00:00.000Z');
  assert.equal(listRecoveryAdjustments(null)[0].effective_age_hours, 12);
  assert.equal(listRecoveryAdjustments(user1)[0].effective_age_hours, 36);
  assert.equal(listRecoveryAdjustments(user2)[0].effective_age_hours, 84);

  saveRecoveryAdjustment(user1, 'chest', 'Ready', 'basis-3', '2020-09-22T13:00:00.000Z');
  assert.equal(listRecoveryAdjustments(user1).length, 1);
  assert.equal(listRecoveryAdjustments(user1)[0].effective_age_hours, 60);
  assert.equal(listRecoveryAdjustments(user1)[0].basis_workout_timestamp, 'basis-3');

  assert.equal(deleteRecoveryAdjustment(user1, 'chest'), 1);
  assert.deepEqual(listRecoveryAdjustments(user1), []);
  assert.equal(listRecoveryAdjustments(user1, { includeDeleted: true }).length, 1);
});

test('recovery adjustment validation rejects unknown values', () => {
  assert.throws(() => saveRecoveryAdjustment(null, 'neck', 'Fresh'), /Unknown muscle/);
  assert.throws(() => saveRecoveryAdjustment(null, 'chest', 'Excellent'), /Invalid recovery state/);
});

test('recovery adjustments are wired through sync, Android, offline queues, and backups', () => {
  const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const serverSync = read('../server/routes/sync.js');
  const clientSync = read('../src/lib/sync.js');
  const nativeApi = read('../src/lib/api-native.js');
  const nativeDb = read('../src/lib/db-native.js');
  const fullBackup = read('../server/routes/full-backup.js');
  const localBackup = read('../src/lib/local-backup.js');

  assert.match(serverSync, /muscle_recovery_adjustments,/);
  assert.match(clientSync, /_applyMuscleRecoveryAdjustments\(pull\.muscle_recovery_adjustments/);
  assert.match(nativeDb, /CREATE TABLE IF NOT EXISTS muscle_recovery_adjustments/);
  assert.match(nativeApi, /id === 'muscle-recovery-adjustments'/);
  assert.match(fullBackup, /muscle_recovery_adjustments: safe/);
  assert.match(fullBackup, /INSERT OR IGNORE INTO muscle_recovery_adjustments/);
  assert.match(localBackup, /'muscle_recovery_adjustments'/);
});
