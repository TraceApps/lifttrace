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
