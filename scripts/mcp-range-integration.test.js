/**
 * Contract/integration checks for the additive MCP read-range overlay.
 * Uses a temporary SQLite database and invokes registered handlers directly.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(os.tmpdir(), `mcp-range-lt-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools } = await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP range integration skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-range] skipping: ${(e?.message || e).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, definition, handler) { this.tools.set(name, { definition, handler }); }
  async call(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.handler(args);
  }
}

let userId;
let server;
const json = result => result.structuredContent;

before(() => {
  userId = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('mcp-range-lt', 'x', 'member')"
  ).run().lastInsertRowid;
  const exerciseId = db.prepare(
    "INSERT INTO exercises (name, is_global, load_type) VALUES ('Range Press', 1, 'bilateral')"
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO workout_log (user_id, date, name, exercises, completed, session_seq)
     VALUES (?, '2020-01-02', 'Old workout', ?, 1, 0)`
  ).run(userId, JSON.stringify([{
    exercise_id: exerciseId,
    exercise_name: 'Range Press',
    sets: [
      { reps: 5, weight: 100, completed: true, warmup: false, rpe: 8 },
      { duration_sec: 60, weight: 0, completed: true, warmup: false, rpe: null },
    ],
  }]));
  db.prepare(
    `INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, '2020-01-02', '{"weight": 69.3}')`
  ).run(userId);

  // A planned session in the future: an open-ended range should include it,
  // and the default window should not.
  db.prepare(
    `INSERT INTO workout_log (user_id, date, name, exercises, completed, session_seq)
     VALUES (?, '2099-01-01', 'Planned', ?, 0, 0)`
  ).run(userId, JSON.stringify([{
    exercise_id: exerciseId, exercise_name: 'Range Press',
    sets: [{ reps: 3, weight: 500, completed: true, warmup: false, rpe: null }],
  }]));
  // A deleted session on a date inside the range: it must not appear
  // anywhere, and must not hold a record.
  db.prepare(
    `INSERT INTO workout_log (user_id, date, name, exercises, completed, session_seq, deleted_at)
     VALUES (?, '2020-01-03', 'Deleted', ?, 1, 0, '2020-01-04 00:00:00')`
  ).run(userId, JSON.stringify([{
    exercise_id: exerciseId, exercise_name: 'Range Press',
    sets: [{ reps: 1, weight: 999, completed: true, warmup: false, rpe: null }],
  }]));
  // Several sessions in one week, to exercise the limit.
  for (const day of ['2021-02-01', '2021-02-02', '2021-02-03', '2021-02-04']) {
    db.prepare(
      `INSERT INTO workout_log (user_id, date, name, exercises, completed, session_seq)
       VALUES (?, ?, 'Bulk', ?, 1, 0)`
    ).run(userId, day, JSON.stringify([{
      exercise_id: exerciseId, exercise_name: 'Range Press', set_type: null,
      sets: [{ reps: 5, weight: 60, completed: true, warmup: false, rpe: null }],
    }]));
  }

  server = new MockServer();
  registerReadTools(server, { userId });
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

test('tools/list registration includes range reads and advertises start/end', () => {
  for (const name of ['get_workouts', 'get_body_stats']) assert.ok(server.tools.has(name), name);
  for (const name of ['get_workouts', 'get_body_stats', 'list_recent_workouts', 'get_records', 'get_exercise_progress']) {
    const shape = server.tools.get(name).definition.inputSchema;
    assert.ok(shape.start, `${name}.start`);
    assert.ok(shape.end, `${name}.end`);
  }
});

test('explicit range reaches records older than the default 90-day window', async () => {
  const workouts = json(await server.call('get_workouts', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(workouts.count, 1);
  assert.equal(workouts.workouts[0].date, '2020-01-02');
  assert.equal(workouts.workouts[0].exercises[0].sets[1].duration_sec, 60);

  const body = json(await server.call('get_body_stats', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(body.count, 1);
  assert.equal(body.stats[0].stats.weight, 69.3);

  const recent = json(await server.call('list_recent_workouts', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(recent.count, 1);

  const records = json(await server.call('get_records', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(records.count, 1);
  assert.equal(records.records[0].date, '2020-01-02');

  const progress = json(await server.call('get_exercise_progress', {
    exercise_name: 'Range Press', start: '2020-01-01', end: '2020-01-03',
  }));
  assert.equal(progress.progress.length, 1);
  assert.equal(progress.progress[0].maxWeight, 100);
});

test('range boundaries are inclusive and omitted bounds remain open', async () => {
  const exact = json(await server.call('get_body_stats', { start: '2020-01-02', end: '2020-01-02' }));
  assert.equal(exact.count, 1);

  const fromStart = json(await server.call('get_body_stats', { start: '2020-01-02' }));
  assert.equal(fromStart.count, 1);

  const throughEnd = json(await server.call('get_body_stats', { end: '2020-01-02' }));
  assert.equal(throughEnd.count, 1);

  const defaultRange = json(await server.call('get_workouts'));
  assert.equal(defaultRange.count, 0);
});

test('range validation rejects a reversed range', async () => {
  const result = await server.call('get_body_stats', { start: '2020-01-03', end: '2020-01-01' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /start must be on or before end/i);
});

test('range validation rejects impossible calendar dates', async () => {
  const result = await server.call('get_body_stats', { start: '2026-02-31', end: '2026-03-01' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /YYYY-MM-DD/i);
});

test('a start with no end stays open, so planned sessions are included', async () => {
  const open = json(await server.call('get_workouts', { start: '2099-01-01' }));
  assert.equal(open.count, 1, 'reads forward from the given date');
  assert.equal(open.workouts[0].date, '2099-01-01');
  assert.equal(open.end, null, 'the other side is left open, not pinned to today');

  // The default window (both bounds omitted) still ends today, so the same
  // planned session is out of it.
  const windowed = json(await server.call('get_workouts'));
  assert.ok(!windowed.workouts.some(w => w.date === '2099-01-01'));
  assert.ok(windowed.start && windowed.end, 'both bounds filled in when neither is given');
});

test('an end with no start reads everything up to it', async () => {
  const upTo = json(await server.call('get_workouts', { end: '2020-01-02' }));
  assert.equal(upTo.start, null);
  assert.deepEqual(upTo.workouts.map(w => w.date), ['2020-01-02']);
});

test('a deleted session is invisible, and never holds a record', async () => {
  const around = json(await server.call('get_workouts', { start: '2020-01-01', end: '2020-01-31' }));
  assert.deepEqual(around.workouts.map(w => w.name), ['Old workout'], 'the deleted one is not returned');

  const records = json(await server.call('get_records', { start: '2020-01-01', end: '2020-01-31' }));
  assert.equal(records.records[0].maxWeight, 100, "the deleted session's 999 lb set is ignored");
});

test('full-detail reads are capped, and say when they stopped short', async () => {
  const capped = json(await server.call('get_workouts', { start: '2021-02-01', end: '2021-02-28', limit: 2 }));
  assert.equal(capped.count, 2);
  assert.equal(capped.total, 4, 'total counts everything that matched');
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.workouts.map(w => w.date), ['2021-02-03', '2021-02-04'],
    'the most recent sessions are kept, returned oldest first');

  const whole = json(await server.call('get_workouts', { start: '2021-02-01', end: '2021-02-28' }));
  assert.equal(whole.truncated, false);
  assert.equal(whole.count, 4);
});

test('a ranged session carries the same fields a single-day read gives', async () => {
  const ranged = json(await server.call('get_workouts', { start: '2020-01-02', end: '2020-01-02' }));
  const single = json(await server.call('get_workout', { date: '2020-01-02' }));
  const strip = (w) => ({ ...w, session_seq: undefined });
  assert.deepEqual(strip(ranged.workouts[0]), strip({ ...single, session_seq: undefined }),
    'one formatter, so set_type and duration_sec cannot go missing from one of them');
  assert.equal(ranged.workouts[0].session_seq, 0, 'plus session_seq, which the single-day read has no need for');
});

test('the records tool warns that a ranged best is not an all-time PR', () => {
  const description = server.tools.get('get_records').definition.description;
  assert.match(description, /not the user's all-time personal records/i);
});
