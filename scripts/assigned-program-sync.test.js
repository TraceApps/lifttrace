/**
 * Coaching: an assigned program never reached the athlete's device.
 *
 * Assigning writes a `program_assignments` row and leaves the program and
 * its workouts untouched, so a differential `/api/sync/pull` sent the
 * assignment without the plan it points at. On Android the Programs tab
 * reads the device's own copy, so the athlete saw nothing to pick sessions
 * from while prescribed workouts kept arriving normally.
 *
 * These run the real pull queries against a real database, reproducing the
 * failure first and then showing the fix against it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { attachAssignedPrograms } = await import('../server/lib/assigned-programs.js');

// better-sqlite3 is a server-only dep, reached the same way the other DB
// tests reach it. Where the native binding is not built (a checkout that
// has never run the server's install), node:sqlite stands in: both expose
// the exec() and prepare().all()/run() surface these tests use.
async function openDb() {
  try {
    const { createRequire } = await import('node:module');
    const serverRequire = createRequire(new URL('../server/', import.meta.url));
    const Database = serverRequire('better-sqlite3');
    return new Database(':memory:');
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  }
}

const SCHEMA = `
  CREATE TABLE programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
    goal TEXT DEFAULT 'general', created_by INTEGER, visibility TEXT DEFAULT 'private',
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE workout_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, program_id INTEGER NOT NULL, name TEXT NOT NULL,
    day_label TEXT, order_index INTEGER DEFAULT 0, exercises TEXT DEFAULT '[]',
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE program_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, program_id INTEGER NOT NULL, assigned_to INTEGER NOT NULL,
    assigned_by INTEGER, start_date TEXT, active INTEGER DEFAULT 1,
    assigned_at TEXT, updated_at TEXT, deleted_at TEXT
  );
`;

const OLD = '2026-01-05 10:00:00';   // when the coach built the program
const NOW = '2026-09-21 09:00:00';   // when they assigned it
const SINCE = '2026-09-20 00:00:00'; // athlete's last successful pull

const ATHLETE = 2;
const COACH = 1;

/** A coach's program, built long ago, assigned to the athlete just now. */
async function seed({ assignedAt = NOW, active = 1 } = {}) {
  const db = await openDb();
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO programs (id,name,created_by,created_at,updated_at) VALUES (7,'PPL',?,?,?)`)
    .run(COACH, OLD, OLD);
  for (const [id, name] of [[70, 'Push'], [71, 'Pull'], [72, 'Legs']]) {
    db.prepare(`INSERT INTO workout_templates (id,program_id,name,exercises,created_at,updated_at) VALUES (?,7,?,'[]',?,?)`)
      .run(id, name, OLD, OLD);
  }
  db.prepare(`INSERT INTO program_assignments (id,program_id,assigned_to,assigned_by,active,assigned_at,updated_at) VALUES (1,7,?,?,?,?,?)`)
    .run(ATHLETE, COACH, active, assignedAt, assignedAt);
  return db;
}

/** The differential queries the pull route runs, verbatim in shape. */
function differentialPull(db, u, sinceSql) {
  const programs = db.prepare(
    `SELECT DISTINCT p.* FROM programs p
     LEFT JOIN program_assignments a ON a.program_id = p.id AND a.assigned_to = ?
     WHERE p.updated_at >= ? AND (p.created_by = ? OR p.created_by IS NULL OR a.id IS NOT NULL)
     ORDER BY p.updated_at`
  ).all(u, sinceSql, u);
  const templates = db.prepare(
    `SELECT * FROM workout_templates WHERE updated_at >= ? ORDER BY updated_at`
  ).all(sinceSql);
  const assignments = db.prepare(
    `SELECT * FROM program_assignments WHERE updated_at >= ? AND assigned_to = ? ORDER BY updated_at`
  ).all(sinceSql, u);
  return { programs, templates, assignments };
}

test('the report, before the fix: the assignment arrives without its program', async () => {
  const db = await seed();
  const { programs, templates, assignments } = differentialPull(db, ATHLETE, SINCE);
  assert.equal(assignments.length, 1, 'the assignment itself does sync');
  assert.equal(programs.length, 0, 'reproduces it: no program for the athlete to open');
  assert.equal(templates.length, 0, 'and no sessions to pick');
});

test('the report, after the fix: the plan travels with the assignment', async () => {
  const db = await seed();
  const pull = differentialPull(db, ATHLETE, SINCE);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.deepEqual(pull.programs.map(p => p.id), [7]);
  assert.deepEqual(pull.templates.map(t => t.name).sort(), ['Legs', 'Pull', 'Push']);
});

test('nothing is sent twice when the program did change in the window', async () => {
  const db = await seed();
  db.prepare(`UPDATE programs SET updated_at = ? WHERE id = 7`).run(NOW);
  db.prepare(`UPDATE workout_templates SET updated_at = ? WHERE id = 70`).run(NOW);
  const pull = differentialPull(db, ATHLETE, SINCE);
  assert.equal(pull.programs.length, 1, 'the differential query already had it');
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.equal(pull.programs.length, 1, 'still one program, not a duplicate');
  assert.equal(pull.templates.length, 3);
  assert.equal(new Set(pull.templates.map(t => t.id)).size, 3, 'template ids are unique');
});

test('an assignment that did not change in this window pulls nothing extra', async () => {
  // The athlete synced after being assigned: no assignment row in this pull,
  // so the pull stays exactly as small as it was before.
  const db = await seed({ assignedAt: OLD });
  const pull = differentialPull(db, ATHLETE, SINCE);
  assert.equal(pull.assignments.length, 0);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.equal(pull.programs.length, 0, 'no extra rows on an ordinary pull');
  assert.equal(pull.templates.length, 0);
});

test('a deactivated assignment still brings its program, so history stays readable', async () => {
  const db = await seed({ active: 0 });
  const pull = differentialPull(db, ATHLETE, SINCE);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.deepEqual(pull.programs.map(p => p.id), [7]);
});

test('a soft-deleted program is passed through as deleted, not resurrected', async () => {
  const db = await seed();
  db.prepare(`UPDATE programs SET deleted_at = ? WHERE id = 7`).run(NOW);
  const pull = differentialPull(db, ATHLETE, SINCE);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.equal(pull.programs.length, 1);
  assert.ok(pull.programs[0].deleted_at, 'the client deletes its local row on seeing this');
});

test('assignments for several programs each bring their own workouts', async () => {
  const db = await seed();
  db.prepare(`INSERT INTO programs (id,name,created_by,created_at,updated_at) VALUES (8,'5x5',?,?,?)`)
    .run(COACH, OLD, OLD);
  db.prepare(`INSERT INTO workout_templates (id,program_id,name,exercises,created_at,updated_at) VALUES (80,8,'A','[]',?,?)`)
    .run(OLD, OLD);
  db.prepare(`INSERT INTO program_assignments (id,program_id,assigned_to,assigned_by,active,assigned_at,updated_at) VALUES (2,8,?,?,0,?,?)`)
    .run(ATHLETE, COACH, NOW, NOW);
  const pull = differentialPull(db, ATHLETE, SINCE);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.deepEqual(pull.programs.map(p => p.id).sort(), [7, 8]);
  assert.equal(pull.templates.length, 4);
});

test('another athlete\'s assignment cannot pull a program into this response', async () => {
  const db = await seed();
  db.prepare(`INSERT INTO programs (id,name,created_by,created_at,updated_at) VALUES (9,'Private',?,?,?)`)
    .run(COACH, OLD, OLD);
  db.prepare(`INSERT INTO program_assignments (id,program_id,assigned_to,assigned_by,active,assigned_at,updated_at) VALUES (3,9,99,?,1,?,?)`)
    .run(COACH, NOW, NOW);
  const pull = differentialPull(db, ATHLETE, SINCE);
  attachAssignedPrograms(db, {
    assignments: pull.assignments,
    programs: pull.programs,
    templates: pull.templates,
  });
  assert.deepEqual(pull.programs.map(p => p.id), [7], "only the caller's own assignment counts");
});

test('the route runs this only for a signed-in user, and the client heals old devices', () => {
  const route = readFileSync(new URL('../server/routes/sync.js', import.meta.url), 'utf8');
  assert.match(route, /if \(u != null\) \{\s*\n\s*attachAssignedPrograms\(db, \{/);
  const client = readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
  assert.match(client, /await _healAssignedPrograms\(result\);/);
  assert.match(client, /LEFT JOIN programs p ON p\.id = a\.program_id\s*\n\s*WHERE p\.id IS NULL/);
});
