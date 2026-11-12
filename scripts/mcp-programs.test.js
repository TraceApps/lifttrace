/**
 * Integration checks for the MCP tools that read and change programs and
 * their workout days (issue #154): get_program, create_program,
 * update_program, create_template, update_template, delete_program and
 * delete_template. Uses a temporary SQLite database and calls the registered
 * handlers directly, as scripts/mcp-range-integration.test.js does.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(os.tmpdir(), `mcp-programs-lt-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, tools;
try {
  ({ default: db } = await import('../server/db.js'));
  tools = await import('../server/lib/mcp/tools/index.js');
} catch (e) {
  test('MCP program tools skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-programs] skipping: ${(e?.message || e).split('\n')[0]}`);
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

function serverFor(userId) {
  const s = new MockServer();
  tools.registerReadTools(s, { userId });
  tools.registerWriteTools(s, { userId });
  tools.registerDestroyTools(s, { userId });
  return s;
}

const ok = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return result.structuredContent;
};
const refused = (result) => {
  assert.equal(result.isError, true, 'expected the tool to refuse');
  return result.content[0].text;
};

let me, other, mine, theirs, press, row, privateLift;

before(() => {
  const user = (name) => db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'member')"
  ).run(name).lastInsertRowid;
  me = user('mcp-programs-me');
  other = user('mcp-programs-other');
  mine = serverFor(me);
  theirs = serverFor(other);
  const exercise = (name, owner) => db.prepare(
    'INSERT INTO exercises (name, is_global, created_by) VALUES (?, ?, ?)'
  ).run(name, owner == null ? 1 : 0, owner).lastInsertRowid;
  press = exercise('Programs Test Press', null);
  row = exercise('Programs Test Row', null);
  privateLift = exercise('Programs Test Private Lift', other);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('the read, write and destroy tools register behind their own gates', () => {
  const names = (register) => { const s = new MockServer(); register(s, { userId: me }); return [...s.tools.keys()]; };
  const read = names(tools.registerReadTools);
  const write = names(tools.registerWriteTools);
  const destroy = names(tools.registerDestroyTools);
  assert.ok(read.includes('get_program'));
  for (const t of ['create_program', 'update_program', 'create_template', 'update_template']) {
    assert.ok(write.includes(t), `${t} is a write tool`);
    assert.ok(!read.includes(t), `${t} must not register on a read-only token`);
  }
  for (const t of ['delete_program', 'delete_template']) {
    assert.ok(destroy.includes(t), `${t} is a destroy tool`);
    assert.ok(!read.includes(t) && !write.includes(t), `${t} must need the destroy gate`);
  }
});

test('create_program makes an empty private program the caller owns', async () => {
  const { program } = ok(await mine.call('create_program', { name: '  Push Pull Legs  ', goal: 'strength' }));
  assert.equal(program.name, 'Push Pull Legs');
  assert.equal(program.goal, 'strength');
  assert.equal(program.duration_weeks, 1);
  assert.equal(program.advance_mode, 'sessions');
  assert.equal(program.on_complete, 'hold');

  const stored = db.prepare('SELECT * FROM programs WHERE id = ?').get(program.program_id);
  assert.equal(stored.created_by, me);
  assert.equal(stored.visibility, 'private');

  const read = ok(await mine.call('get_program', { program_id: program.program_id }));
  assert.equal(read.can_edit, true);
  assert.equal(read.is_active, false);
  assert.deepEqual(read.templates, []);

  const listed = ok(await mine.call('list_programs'));
  assert.ok(listed.programs.some(p => p.program_id === program.program_id));
});

test('create_template stores exercises the way the app\'s editor does', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Template shapes' }));
  const { template } = ok(await mine.call('create_template', {
    program_id: program.program_id,
    name: 'Push',
    day_label: 'Monday',
    exercises: [
      { exercise_id: press, sets: 4, reps: '6-8', weight: 80, rest_sec: 120, notes: 'Pause on the chest' },
      { exercise_name: 'programs test ROW' },
      { exercise_name: 'Sled drag in the car park', sets: 2, reps: 1 },
    ],
  }));
  assert.equal(template.name, 'Push');
  assert.equal(template.day_label, 'Monday');
  assert.equal(template.exercises.length, 3);

  const [a, b, c] = template.exercises;
  assert.deepEqual(
    { id: a.exercise_id, name: a.exercise_name, sets: a.sets, reps: a.reps, weight: a.weight, rest: a.rest_sec, notes: a.notes },
    { id: press, name: 'Programs Test Press', sets: 4, reps: '6-8', weight: '80', rest: 120, notes: 'Pause on the chest' }
  );
  // A name that is a library exercise's: that exercise, so its history follows.
  assert.equal(b.exercise_id, row);
  assert.equal(b.exercise_name, 'Programs Test Row');
  assert.equal(b.sets, 3, 'three sets by default, as the editor adds an exercise');
  // A name that isn't: a free-text exercise.
  assert.equal(c.exercise_id, null);
  assert.equal(c.exercise_name, 'Sled drag in the car park');
  assert.equal(c.reps, '1');
  for (const e of template.exercises) assert.match(e.uuid, /^[0-9a-f-]{36}$/);

  const stored = JSON.parse(db.prepare('SELECT exercises FROM workout_templates WHERE id = ?').get(template.template_id).exercises);
  assert.deepEqual(
    { sets: stored[0].target_sets, reps: stored[0].target_reps, weight: stored[0].target_weight, list: stored[0].sets },
    { sets: 4, reps: '6-8', weight: '80', list: [] }
  );

  // A second day goes after the first.
  const second = ok(await mine.call('create_template', { program_id: program.program_id, name: 'Pull' }));
  const read = ok(await mine.call('get_program', { program_id: program.program_id }));
  assert.deepEqual(read.templates.map(t => t.name), ['Push', 'Pull']);
  assert.deepEqual(second.template.exercises, []);
});

test('update_template changes, adds and removes exercises, and keeps what it wasn\'t sent', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Template edits' }));
  const { template } = ok(await mine.call('create_template', {
    program_id: program.program_id,
    name: 'Day A',
    exercises: [
      { exercise_id: press, sets: 3, reps: 10, weight: 60, notes: 'Keep me' },
      { exercise_id: row, sets: 3, reps: 12 },
    ],
  }));
  const [pressEx, rowEx] = template.exercises;

  // What the app's editor adds and these tools don't expose: it must survive an edit.
  const stored = JSON.parse(db.prepare('SELECT exercises FROM workout_templates WHERE id = ?').get(template.template_id).exercises);
  stored[0].weeks = [null, { sets: 5, reps: '5' }];
  stored[0].superset_id = 7;
  db.prepare('UPDATE workout_templates SET exercises = ? WHERE id = ?').run(JSON.stringify(stored), template.template_id);

  const updated = ok(await mine.call('update_template', {
    template_id: template.template_id,
    name: 'Day A (heavy)',
    exercises: [
      { exercise_name: 'Farmer walk', sets: 2 },
      { uuid: pressEx.uuid, sets: 5, weight: '82.5' },
    ],
  })).template;

  assert.equal(updated.name, 'Day A (heavy)');
  assert.deepEqual(updated.exercises.map(e => e.exercise_name), ['Farmer walk', 'Programs Test Press'], 'the order sent, the row left out removed');
  const kept = updated.exercises[1];
  assert.equal(kept.uuid, pressEx.uuid);
  assert.deepEqual(
    { sets: kept.sets, reps: kept.reps, weight: kept.weight, notes: kept.notes, superset: kept.superset_id, weekly: kept.has_weekly_plan },
    { sets: 5, reps: '10', weight: '82.5', notes: 'Keep me', superset: 7, weekly: true }
  );

  // The removed exercise has a tombstone, so a device that still has it doesn't bring it back.
  const tombstones = db.prepare(
    "SELECT uuid FROM workout_tombstones WHERE date = ? AND kind = 'template_exercise'"
  ).all(`template:${template.template_id}`).map(r => r.uuid);
  assert.deepEqual(tombstones, [rowEx.uuid]);

  // Name alone: the exercises are left as they are.
  const renamed = ok(await mine.call('update_template', { template_id: template.template_id, day_label: 'Friday' })).template;
  assert.equal(renamed.day_label, 'Friday');
  assert.equal(renamed.name, 'Day A (heavy)');
  assert.equal(renamed.exercises.length, 2);

  // An empty list clears the day.
  const cleared = ok(await mine.call('update_template', { template_id: template.template_id, exercises: [] })).template;
  assert.deepEqual(cleared.exercises, []);
});

test('update_template replaces a day whose exercises have no uuid yet', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Old shape' }));
  const { template } = ok(await mine.call('create_template', { program_id: program.program_id, name: 'Legacy' }));
  db.prepare('UPDATE workout_templates SET exercises = ? WHERE id = ?').run(JSON.stringify([
    { exercise_name: 'Old One', target_sets: 3, target_reps: '10', sets: [] },
    { exercise_name: 'Old Two', target_sets: 3, target_reps: '10', sets: [] },
  ]), template.template_id);

  const read = ok(await mine.call('get_program', { program_id: program.program_id }));
  assert.deepEqual(read.templates[0].exercises.map(e => e.uuid), [null, null]);

  const updated = ok(await mine.call('update_template', {
    template_id: template.template_id,
    exercises: [{ exercise_id: press }],
  })).template;
  assert.deepEqual(updated.exercises.map(e => e.exercise_name), ['Programs Test Press']);
});

test('update_program changes only the fields sent', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Before', description: 'Kept', goal: 'cutting' }));
  const updated = ok(await mine.call('update_program', {
    program_id: program.program_id, name: 'After', duration_weeks: 8, advance_mode: 'calendar', on_complete: 'repeat',
  })).program;
  assert.deepEqual(updated, {
    program_id: program.program_id, name: 'After', description: 'Kept', goal: 'cutting',
    duration_weeks: 8, advance_mode: 'calendar', on_complete: 'repeat',
  });
  assert.match(refused(await mine.call('update_program', { program_id: program.program_id })), /Nothing to change/);
});

test('bad input is refused with a message that says what to do', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Refusals' }));
  const { template } = ok(await mine.call('create_template', { program_id: program.program_id, name: 'Day' }));

  assert.match(refused(await mine.call('create_template', {
    program_id: program.program_id, name: 'Bad', exercises: [{ exercise_id: 987654 }],
  })), /Exercise 987654 not found/);
  // Another account's private exercise is not there to use.
  assert.match(refused(await mine.call('create_template', {
    program_id: program.program_id, name: 'Bad', exercises: [{ exercise_id: privateLift }],
  })), /not found/);
  assert.match(refused(await mine.call('create_template', {
    program_id: program.program_id, name: 'Bad', exercises: [{ sets: 3 }],
  })), /exercise_id or an exercise_name/);
  assert.match(refused(await mine.call('update_template', {
    template_id: template.template_id, exercises: [{ uuid: 'not-a-real-uuid', sets: 3 }],
  })), /No exercise with uuid/);
  assert.match(refused(await mine.call('update_template', { template_id: template.template_id })), /Nothing to change/);

  // A refused create leaves nothing behind.
  const read = ok(await mine.call('get_program', { program_id: program.program_id }));
  assert.deepEqual(read.templates.map(t => t.name), ['Day']);
});

test('another account\'s program is not found, and a starter program is read-only', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'Mine only' }));
  const { template } = ok(await mine.call('create_template', { program_id: program.program_id, name: 'Day' }));

  assert.match(refused(await theirs.call('get_program', { program_id: program.program_id })), /not found/);
  assert.match(refused(await theirs.call('update_program', { program_id: program.program_id, name: 'Taken' })), /not found/);
  assert.match(refused(await theirs.call('create_template', { program_id: program.program_id, name: 'Sneaky' })), /not found/);
  assert.match(refused(await theirs.call('update_template', { template_id: template.template_id, name: 'Sneaky' })), /not found/);
  assert.match(refused(await theirs.call('delete_template', { template_id: template.template_id, confirm: true })), /not found/);
  assert.match(refused(await theirs.call('delete_program', { program_id: program.program_id, confirm: true })), /not found/);
  assert.equal(db.prepare('SELECT name FROM programs WHERE id = ?').get(program.program_id).name, 'Mine only');

  // A starter program: no maker, shared. Everyone reads it, nobody changes it.
  const starter = db.prepare(
    "INSERT INTO programs (name, created_by, visibility) VALUES ('Starter Plan', NULL, 'shared')"
  ).run().lastInsertRowid;
  const day = db.prepare(
    "INSERT INTO workout_templates (program_id, name, order_index, exercises) VALUES (?, 'Starter Day', 0, '[]')"
  ).run(starter).lastInsertRowid;
  const read = ok(await mine.call('get_program', { program_id: starter }));
  assert.equal(read.can_edit, false);
  assert.match(refused(await mine.call('update_program', { program_id: starter, name: 'Mine now' })), /can't be changed/);
  assert.match(refused(await mine.call('update_template', { template_id: day, name: 'Mine now' })), /can't be changed/);
  assert.match(refused(await mine.call('delete_program', { program_id: starter, confirm: true })), /can't be changed/);
});

test('delete_template and delete_program need confirm: true and then remove it', async () => {
  const { program } = ok(await mine.call('create_program', { name: 'To delete' }));
  const a = ok(await mine.call('create_template', { program_id: program.program_id, name: 'A' })).template;
  ok(await mine.call('create_template', { program_id: program.program_id, name: 'B' }));

  assert.match(refused(await mine.call('delete_template', { template_id: a.template_id, confirm: false })), /confirm: true/);
  assert.match(refused(await mine.call('delete_program', { program_id: program.program_id, confirm: false })), /confirm: true/);
  assert.equal(ok(await mine.call('get_program', { program_id: program.program_id })).templates.length, 2);

  const gone = ok(await mine.call('delete_template', { template_id: a.template_id, confirm: true }));
  assert.deepEqual({ deleted: gone.deleted, name: gone.name }, { deleted: true, name: 'A' });
  assert.deepEqual(ok(await mine.call('get_program', { program_id: program.program_id })).templates.map(t => t.name), ['B']);
  assert.match(refused(await mine.call('delete_template', { template_id: a.template_id, confirm: true })), /not found/);

  ok(await mine.call('delete_program', { program_id: program.program_id, confirm: true }));
  assert.match(refused(await mine.call('get_program', { program_id: program.program_id })), /not found/);
  assert.ok(!ok(await mine.call('list_programs')).programs.some(p => p.program_id === program.program_id));
});
