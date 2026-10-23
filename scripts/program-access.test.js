/**
 * Who may see a program (and its workout days), and who may change it.
 *
 * The routes used to check nothing: any signed-in member could rename or
 * delete someone else's program, add, rewrite and delete its days, and every
 * pull handed every account's days to every device. Verified end to end
 * against a running server (the maker, a coached athlete, a prescribed day,
 * and another account); these pin the rules on the real schema and keep the
 * routes wired to them.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// server/db.js opens DB_PATH when imported: a scratch database.
let access = null, db = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'lt-program-access-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  access = await import('../server/lib/program-access.js');
} catch { /* better-sqlite3 not built for this Node: the schema tests skip */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const user = n => Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(n + Math.random(), 'x', 'member').lastInsertRowid);
  const coach = user('coach'), athlete = user('athlete'), other = user('other');
  const plan = (name, by, vis = 'private') => Number(db.prepare('INSERT INTO programs (name, created_by, visibility) VALUES (?, ?, ?)').run(name, by, vis).lastInsertRowid);
  const day = (p, name) => Number(db.prepare('INSERT INTO workout_templates (program_id, name) VALUES (?, ?)').run(p, name).lastInsertRowid);
  const assigned = plan('Assigned', coach), priv = plan('Private', coach), starter = plan('Starter', null, 'shared'), orphan = plan('Orphan', null);
  const rxPlan = plan('Rx', coach);
  const days = { assigned: day(assigned, 'A1'), priv: day(priv, 'P1'), starter: day(starter, 'S1'), rx: day(rxPlan, 'R1') };
  db.prepare('INSERT INTO program_assignments (program_id, assigned_to, assigned_by) VALUES (?, ?, ?)').run(assigned, athlete, coach);
  db.prepare('INSERT INTO coach_prescriptions (trainer_id, member_id, template_id) VALUES (?, ?, ?)').run(coach, athlete, days.rx);
  return { coach, athlete, other, assigned, priv, starter, orphan, rxPlan, days };
}

test('the maker sees and changes their program; nobody else changes it', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  assert.deepEqual(pick(access.programFor(s.priv, s.coach)), [true, true]);
  assert.deepEqual(pick(access.programFor(s.priv, s.other)), [false, false]);
  assert.deepEqual(pick(access.programFor(s.priv, s.athlete)), [false, false]);
});

test('an assigned athlete sees the program but does not change it', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  assert.deepEqual(pick(access.programFor(s.assigned, s.athlete)), [true, false]);
});

test('starters are seen by everyone; a deleted maker\'s program stays private', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  assert.deepEqual(pick(access.programFor(s.starter, s.other)), [true, false]);
  assert.deepEqual(pick(access.programFor(s.orphan, s.other)), [false, false]);
});

test('a prescribed day is seen by its athlete without the program', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  assert.deepEqual(pick(access.templateFor(s.days.rx, s.athlete)), [true, false]);
  assert.deepEqual(pick(access.programFor(s.rxPlan, s.athlete)), [false, false]);
  assert.deepEqual(pick(access.templateFor(s.days.rx, s.other)), [false, false]);
});

test('with user management off, everything stays open', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  assert.deepEqual(pick(access.programFor(s.priv, null)), [true, true]);
  assert.equal(access.visibleProgramsSql(null).sql, '1 = 1');
});

test('the pull SQL returns the same programs and days as the rules', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  const s = seed();
  const v = access.visibleTemplatesSql(s.athlete);
  const names = db.prepare(`SELECT t.name FROM workout_templates t JOIN programs p ON p.id = t.program_id WHERE t.program_id IN (?, ?, ?, ?) AND ${v.sql} ORDER BY t.name`)
    .all(s.assigned, s.priv, s.starter, s.rxPlan, ...v.args).map(r => r.name);
  assert.deepEqual(names, ['A1', 'R1', 'S1']);
  const pv = access.visibleProgramsSql(s.other);
  const progs = db.prepare(`SELECT p.name FROM programs p WHERE p.id IN (?, ?, ?, ?) AND ${pv.sql}`).all(s.assigned, s.priv, s.starter, s.orphan, ...pv.args).map(r => r.name);
  assert.deepEqual(progs, ['Starter']);
});

const pick = a => [a.canSee, a.canChange];

test('every program and day route asks program-access', () => {
  const programs = read('../server/routes/programs.js');
  for (const route of ["router.get('/:id',", "router.put('/:id',", "router.delete('/:id',", "router.post('/:id/activate',", "router.post('/:id/week-cursor',", "router.post('/:id/assign',", "router.put('/:id/reorder',"]) {
    const body = programs.slice(programs.indexOf(route)).split('\n}));')[0];
    assert.match(body, /programFor\(/, `${route} checks access`);
  }
  const templates = read('../server/routes/templates.js');
  for (const route of ["router.get('/:id',", "router.post('/',", "router.put('/:id',", "router.delete('/:id',"]) {
    const body = templates.slice(templates.indexOf(route)).split('\n}));')[0];
    assert.match(body, /(programFor|templateFor)\(/, `${route} checks access`);
  }
  const trainer = read('../server/routes/trainer.js');
  assert.match(trainer, /if \(template_id && !templateFor\(template_id, uid\(req\)\)\.canSee\)/, 'prescribing a day needs the coach to see it');
  assert.match(trainer, /!templateFor\(next\.template_id, uid\(req\)\)\.canSee/, 'and so does changing it');
});

test('the sync pull and push go by the same rules', () => {
  const sync = read('../server/routes/sync.js');
  const pull = sync.slice(sync.indexOf("router.get('/pull'"));
  assert.match(pull, /visibleProgramsSql\(u\)/);
  assert.match(pull, /visibleTemplatesSql\(u\)/);
  assert.doesNotMatch(pull, /SELECT \* FROM workout_templates WHERE updated_at >= \? ORDER BY updated_at/, 'every account\'s days went to every device');
  const push = sync.slice(sync.indexOf("router.post('/push'"));
  assert.match(push, /canChangeProgram\(existing, u\) && wins/);
  assert.match(push, /canChangeDay\(existing\.program_id\) && wins/);
  assert.match(push, /SELECT \* FROM workout_log WHERE id = \? AND user_id/);
  assert.match(push, /UPDATE ai_chat_history SET deleted_at = datetime\('now'\), updated_at = datetime\('now'\) WHERE id = \? AND user_id/);
});

test('an id is checked and stored as the same number', (t) => {
  if (!access) return t.skip('better-sqlite3 is not built for this Node');
  // SQLite stores "4.0e1" as 40 where parseInt reads 4: a write could reach
  // a program the check never looked at.
  for (const bad of ['4.0e1', '12.34e2', '4abc', ' 4', '0', '-4', '', null, undefined, 4.5, '04']) {
    assert.equal(access.toId(bad), null, JSON.stringify(bad));
  }
  assert.equal(access.toId(40), 40);
  assert.equal(access.toId('40'), 40);
  const templates = read('../server/routes/templates.js');
  assert.match(templates, /const program_id = toId\(req\.body\.program_id\)/);
  const trainer = read('../server/routes/trainer.js');
  assert.equal((trainer.match(/toId\(/g) || []).length >= 2, true, 'both prescription routes parse the day id once');
  assert.match(read('../server/routes/sync.js'), /\.run\(toId\(t\.program_id\), t\.name/);
});

test("a coach can switch on a program their athlete already has", () => {
  const programs = read('../server/routes/programs.js');
  const assign = programs.slice(programs.indexOf("router.post('/:id/assign'")).split('\n}));')[0];
  assert.match(assign, /const alreadyTheirs = db\.prepare\('SELECT 1 FROM program_assignments WHERE program_id = \? AND assigned_to = \?'\)/);
  assert.match(assign, /if \(!alreadyTheirs && refuse\(/);
});

test("someone else's program opens without editing controls", () => {
  const detail = read('../src/routes/ProgramDetail.svelte');
  assert.match(detail, /\$: othersProgram = !!\(\$userMgmtActive && \$currentUser && program\?\.created_by != null && program\.created_by !== \$currentUser\.id\)/);
  assert.match(detail, /draggable=\{!othersProgram\}/);
  assert.ok((detail.match(/\{#if !othersProgram\}/g) || []).length >= 4, 'Add (both), drag handle and delete are hidden');
  const editor = read('../src/routes/WorkoutEditor.svelte');
  assert.match(editor, /readonly=\{othersProgram\}/);
  assert.match(editor, /\{#if !othersProgram\}\s*<button class="btn btn-primary save-btn"/);
});
