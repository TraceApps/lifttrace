import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

const sync = fs.readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
const nativeDb = fs.readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
const apiFetch = fs.readFileSync(new URL('../src/lib/apiFetch.js', import.meta.url), 'utf8');

function declaration(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

for (const [name, queuedName, row] of [
  ['_applyExerciseMuscleOverrides', '_queuedMuscleOverrideIds', { exercise_id: 7, muscle_loads: { pectorals: 1 }, updated_at: '2026-10-23 12:00:00' }],
  ['_applyMuscleRecoveryAdjustments', '_queuedRecoveryMuscles', { muscle: 'chest', effective_age_hours: 12, adjusted_at: '2026-10-23T12:00:00Z', updated_at: '2026-10-23 12:00:00' }],
]) {
  function load(queued, alive, write) {
    return new Function(queuedName, '_assertAlive', 'dbRun', '_NO_GUARD',
      `return ${declaration(sync, name)}`)(queued, alive, write, { skip() {} });
  }

  test(`${name}: an account change while reading the queue prevents writes`, async () => {
    let active = true;
    const writes = [];
    const apply = load(async () => { active = false; return new Set(); },
      () => { if (!active) throw new Error('account changed'); },
      async (...args) => writes.push(args));
    await assert.rejects(apply([row], { tables: {} }), /account changed/);
    assert.equal(writes.length, 0);
  });

  test(`${name}: a queued edit preserves the pull cursor for a later retry`, async () => {
    const writes = [], skipped = [];
    const apply = load(async () => new Set([row.exercise_id ?? row.muscle]),
      () => {}, async (...args) => writes.push(args));
    await apply([row], { tables: {} }, { skip: timestamp => skipped.push(timestamp) });
    assert.equal(writes.length, 0);
    assert.deepEqual(skipped, [row.updated_at]);
  });
}

test('queued personal profiles recognize upstream negative offline exercise IDs', async () => {
  const read = new Function('dbQuery', `return ${declaration(sync, '_queuedMuscleOverrideIds')}`)(
    async () => [{ table_name: '/api/exercises/-123/muscle-load' }, { table_name: '/api/exercises/7/muscle-load' }]);
  assert.deepEqual([...await read()], [-123, 7]);
});

test('changing accounts clears both personal muscle tables from the device copy', async () => {
  const tables = nativeDb.match(/const CLEARED_TABLES = [\s\S]*?;/)[0];
  const writes = [];
  const clear = new Function('dbRun', 'setSyncMeta', 'dbQuery',
    `${tables}\nreturn ${declaration(nativeDb, 'dbClearUserData')}`)(
    async sql => writes.push(sql), async () => {}, async () => [{ n: 0 }]);
  await clear();
  assert.ok(writes.includes('DELETE FROM exercise_muscle_overrides'));
  assert.ok(writes.includes('DELETE FROM muscle_recovery_adjustments'));
});

test('online muscle writes mirror only into the account that made the request', async () => {
  const calls = [];
  const mirror = new Function('accountGen', 'copyMoving', '_stripBase', 'LtApiNative',
    `return ${declaration(apiFetch, '_mirrorSuccessfulWrite')}`)(
    () => 2, () => false, url => url,
    { handle: async (...args) => calls.push(args) });
  const init = { body: JSON.stringify({ muscle_load: { pectorals: 1 } }) };
  await mirror('/api/exercises/-123/muscle-load', 'PUT', init, {}, 1);
  assert.equal(calls.length, 0);
  await mirror('/api/exercises/-123/muscle-load', 'PUT', init, {}, 2);
  assert.deepEqual(calls, [['PUT', '/api/exercises/-123/muscle-load', { muscle_load: { pectorals: 1 } }, {}]]);
});
