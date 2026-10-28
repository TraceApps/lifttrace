/**
 * Trace's workout tools read and write the workout they mean (found while
 * fixing #142).
 *
 * On a day with two workouts, log_set into the second one saved without its
 * id, so the server wrote it into the day's first: the first workout took
 * the second one's name and exercises, and the set never reached the
 * workout it was for. get_workout showed the first workout's details for
 * the second; log_workout, add_exercise_to_diary and
 * start_workout_from_template always wrote into the first, even with the
 * second open in the Diary. Reproduced against a real server.
 *
 * These run the real tools (src/lib/aiTools.js) against an in-memory API
 * that answers like the server, and record each request.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// The store's own reads go through the same in-memory server.
const STORE_API = `export const LtApi = {
  getWorkout: (date, id = null) => fetch('/api/workout/' + date + (id != null ? '?id=' + id : '')).then(r => r.json()),
  getWorkoutSessions: async (date) => ({ sessions: globalThis.__rows().filter(r => r.date === date && !r.deleted_at) }),
  getMyPrescriptionForDate: async () => null,
  saveWorkout: (date, data) => fetch('/api/workout/' + date, { method: 'PUT', body: JSON.stringify(data) }).then(r => r.json()),
};`;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '../lib/api.js' && context.parentURL?.endsWith('/src/stores/workout.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STORE_API)}), shortCircuit: true };
    }
    return next(specifier, context);
  }`), import.meta.url);

const { ensureExerciseUuids } = await import('../src/lib/workout-uuid.js');
const { mergeExercises, changedUuidsOf } = await import('../server/lib/workout-merge.js');
const DAY = '2026-10-07';
let rows = [];
// The program the user follows, in its third week.
let program = { id: 1, is_active: true, current_week: 3, duration_weeks: 6 };
const requests = [];
const live = (date) => rows.filter(r => r.date === date && !r.deleted_at);
globalThis.__rows = () => rows;
globalThis.fetch = async (path, init = {}) => {
  const method = init.method || 'GET';
  const url = new URL(path, 'http://x');
  const body = init.body ? JSON.parse(init.body) : null;
  const hdr = init.headers?.['X-Changed-Fields'];
  requests.push({ method, path: url.pathname + url.search, id: body?.id, changed: hdr == null ? null : hdr.split(','), body });
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname.startsWith('/api/exercises')) {
    const q = (url.searchParams.get('search') || '').toLowerCase();
    return json([{ id: 9, name: 'Dips' }, { id: 8, name: 'Bench Press' }].filter(e => e.name.toLowerCase().includes(q)));
  }
  if (url.pathname === '/api/workout/recent') return json(rows.filter(r => !r.deleted_at));
  if (url.pathname === '/api/templates/3') return json({ id: 3, program_id: 1, name: 'Leg Day', exercises: [{ exercise_id: 7, exercise_name: 'Squat', target_sets: 2 }] });
  if (url.pathname === '/api/programs/1') return json(program);
  const m = url.pathname.match(/^\/api\/workout\/(\d{4}-\d{2}-\d{2})$/);
  if (m && method === 'GET') {
    const id = url.searchParams.get('id');
    // As the server: by id, that row (deleted too); by date, the first live one.
    const w = id != null ? rows.find(r => r.date === m[1] && r.id === Number(id)) : live(m[1])[0];
    return json({ workout: w ? structuredClone(w) : null });
  }
  if (m && method === 'PUT' && globalThis.__duringPut) { const f = globalThis.__duringPut; globalThis.__duringPut = null; f(body); }
  if (m && method === 'PUT') {
    // As the server: every field is written from the request (a field left
    // out is cleared), new_session always makes a row.
    const target = body.new_session ? null : body.id != null ? rows.find(r => r.id === body.id && r.date === m[1]) : live(m[1])[0];
    // As the server: every exercise and set gets a uuid.
    const fields = (b) => ({ name: b.name ?? null, exercises: ensureExerciseUuids(b.exercises), notes: b.notes || null, completed: b.completed ? 1 : 0, program_id: b.program_id || null, template_id: b.template_id || null, program_week: b.program_week ?? null });
    if (target && globalThis.__queueReply) {
      // As a phone with no connection answers: its own copy, queued.
      return json({ workout: { ...target, ...body, exercises: ensureExerciseUuids(body.exercises || []) }, queued: true });
    }
    if (target) {
      // Exercises as the server merges them, saying-what-changed included.
      const exercises = mergeExercises(target.exercises || [], ensureExerciseUuids(body.exercises || []), [], [], {}, {}, changedUuidsOf(body.changed_uuids)).merged;
      Object.assign(target, fields(body), { exercises });
      return json({ workout: target });
    }
    const made = { id: 100 + rows.length, date: m[1], ...fields(body) };
    rows.push(made);
    return json({ workout: made });
  }
  throw new Error(`unexpected ${method} ${path}`);
};

// The store tells the Diary when a workout opens from outside it.
globalThis.window = new EventTarget();
const opened = [];
window.addEventListener('lt:workout-opened', (e) => opened.push(e.detail));
const { get } = await import('svelte/store');
const store = await import('../src/stores/workout.js');
const { runTool } = await import('../src/lib/aiTools.js');

function day() {
  rows = [
    { id: 1, date: DAY, name: 'Mobility', exercises: [{ exercise_id: 5, exercise_name: 'Hip Opener', sets: [{ reps: 10, weight: 0, completed: true }] }] },
    { id: 2, date: DAY, name: 'Push', exercises: [{ exercise_id: 8, exercise_name: 'Bench Press', sets: [{ reps: 8, weight: 60, completed: false }] }] },
  ];
  // Stored rows carry uuids, as the server's do.
  for (const r of rows) r.exercises = ensureExerciseUuids(r.exercises);
  requests.length = 0;
}
const open = (date, id) => { store.currentDate.set(date); store.currentSessionId.set(id); };
const names = (id) => rows.find(r => r.id === id).exercises.map(e => e.exercise_name);

test('log_set writes the set into the workout it was given, not the day\'s first', async () => {
  day();
  open(DAY, 1); // whatever is open, log_set names its workout
  await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 8 });
  // Push's planned set still to do takes it (issue #140).
  assert.deepEqual(rows[1].exercises[0].sets.map(x => [x.weight, x.reps, x.completed]), [[62.5, 8, true]], 'the set is in Push');
  assert.equal(rows[0].name, 'Mobility', 'Mobility keeps its name');
  assert.deepEqual(names(1), ['Hip Opener'], 'and its exercises');
  assert.equal(requests.find(r => r.method === 'PUT').id, 2);
});

test('log_set fills the next planned set still to do, then adds after them (issue #140)', async () => {
  day();
  const push = rows[1];
  const planned = (n) => ({ uuid: `p${n}`, weight: 60, reps: 8, completed: false, notes: '' });
  push.exercises[0].sets = [{ uuid: 'w1', weight: 20, reps: 10, completed: false, warmup: true }, planned(1), planned(2)];
  open(DAY, 2);
  const a = await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 7 });
  assert.equal(a.set_id, 1, 'the first working set, not the warm-up');
  const b = await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 20, reps: 10, warmup: true });
  assert.equal(b.set_id, 0, 'a warm-up fills the planned warm-up');
  await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 6 });
  const c = await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 5 });
  assert.equal(c.set_id, 3, 'none left: added after them');
  const sets = push.exercises[0].sets;
  assert.deepEqual(sets.map(x => [x.uuid?.length > 0, x.weight, x.reps, !!x.completed, !!x.warmup]),
    [[true, 20, 10, true, true], [true, 62.5, 7, true, false], [true, 62.5, 6, true, false], [true, 62.5, 5, true, false]]);
  assert.deepEqual(sets.slice(0, 3).map(x => x.uuid), ['w1', 'p1', 'p2'], 'the planned sets keep their ids');
  // A set sent as not done is added, as before.
  const d = await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 70, reps: 3, completed: false });
  assert.equal(d.set_id, 4);
  // In a finished workout, unticked sets were skipped: a set is added, as the server does.
  push.completed = 1;
  const e = await runTool('log_set', { workout_id: 2, exercise_name: 'Bench', weight: 70, reps: 2 });
  assert.equal(e.set_id, 5);
  assert.equal(push.exercises[0].sets[4].completed, false, 'the unticked set stays as it was');
  assert.equal(push.exercises[0].sets.length, 6);
});

test('get_workout shows the workout asked for', async () => {
  day();
  const w = await runTool('get_workout', { id: 2 });
  assert.equal(w.name, 'Push');
  assert.ok(requests.some(r => r.path === `/api/workout/${DAY}?id=2`));
});

test('the by-date tools write into the workout open in the Diary', async () => {
  for (const [tool, args] of [
    ['add_exercise_to_diary', { exercise_name: 'Dips', date: DAY }],
    ['log_workout', { date: DAY, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }],
  ]) {
    day();
    open(DAY, 2);
    await runTool(tool, args);
    assert.deepEqual(names(1), ['Hip Opener'], `${tool}: Mobility untouched`);
    assert.ok(names(2).length > 1, `${tool}: written into Push`);
    assert.equal(requests.find(r => r.method === 'PUT').id, 2, tool);
  }
});

test("with the Diary on another date, or nothing open, a date's first workout is used as before", async () => {
  day();
  open('2026-10-06', 2);
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.deepEqual(names(1), ['Hip Opener', 'Dips']);
  assert.ok(!requests.some(r => r.path.includes('?id=')), 'no workout named');
  day();
  open(DAY, null);
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.deepEqual(names(1), ['Hip Opener', 'Dips']);
});

test('the open workout deleted elsewhere: the date\'s first, and the deleted one stays deleted', async () => {
  day();
  rows[1].deleted_at = '2026-10-07 19:00:00';
  open(DAY, 2);
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.deepEqual(names(1), ['Hip Opener', 'Dips']);
  assert.deepEqual(names(2), ['Bench Press']);
  assert.equal(rows[1].deleted_at, '2026-10-07 19:00:00');
});

test('a day with no workout yet gets a new one', async () => {
  day();
  open('2026-10-09', null);
  const out = await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: '2026-10-09' });
  assert.equal(requests.find(r => r.method === 'PUT').id, undefined);
  assert.ok(rows.some(r => r.id === out.workout_id && r.date === '2026-10-09'));
  assert.equal(get(store.currentDate), '2026-10-09', 'the tools never move the Diary');
});

test('a template loaded while the open workout is under way becomes a new workout of the day', async () => {
  day();
  open(DAY, 2);
  const out = await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  assert.deepEqual(names(1), ['Hip Opener']);
  assert.deepEqual(names(2), ['Bench Press'], 'Push keeps its own exercises and name');
  assert.equal(rows.find(r => r.id === 2).name, 'Push');
  const made = rows.find(r => r.id === out.workout_id);
  assert.equal(made.name, 'Leg Day');
  assert.deepEqual(made.exercises.map(e => e.exercise_name), ['Squat']);
});

test('a template loaded into an empty open workout fills it', async () => {
  day();
  rows.push({ id: 3, date: DAY, name: null, notes: 'warm up first', exercises: [] });
  open(DAY, 3);
  await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  const w = rows.find(r => r.id === 3);
  assert.equal(w.name, 'Leg Day');
  assert.deepEqual(w.exercises.map(e => e.exercise_name), ['Squat']);
  assert.equal(w.notes, 'warm up first');
  assert.equal(rows.length, 3, 'no new workout');
});

test("a tool's write keeps the workout's notes, finished mark, program and week", async () => {
  for (const [tool, args] of [
    ['log_set', { workout_id: 1, exercise_name: 'Hip', weight: 0, reps: 12 }],
    ['add_exercise_to_diary', { exercise_name: 'Dips', date: DAY }],
    ['log_workout', { date: DAY, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }],
  ]) {
    day();
    Object.assign(rows[0], { notes: 'felt strong', completed: 1, program_id: 1, template_id: 4, program_week: 2 });
    open(DAY, 1);
    await runTool(tool, args);
    const w = rows[0];
    assert.deepEqual({ notes: w.notes, completed: w.completed, program_id: w.program_id, template_id: w.template_id, program_week: w.program_week },
      { notes: 'felt strong', completed: 1, program_id: 1, template_id: 4, program_week: 2 }, tool);
  }
});

test('a failed read of the open workout stops the tool instead of writing into another one', async () => {
  day();
  open(DAY, 2);
  const real = globalThis.fetch;
  globalThis.fetch = async (path, init) => (String(path).includes('?id=2') ? new Response('{"error":"down"}', { status: 503 }) : real(path, init));
  try {
    await assert.rejects(runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY }));
  } finally { globalThis.fetch = real; }
  assert.deepEqual(names(1), ['Hip Opener']);
  assert.deepEqual(names(2), ['Bench Press']);
});

test('each write names only the fields it sets, so the server keeps its own for the rest', async () => {
  const cases = [
    ['log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 8 }, ['exercises']],
    ['add_exercise_to_diary', { exercise_name: 'Dips', date: DAY }, ['exercises']],
    ['log_workout', { date: DAY, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }, ['exercises', 'completed']],
    ['log_workout', { date: DAY, name: 'Arms', duration_min: 30, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }, ['exercises', 'completed', 'name', 'duration_min']],
  ];
  for (const [tool, args, changed] of cases) {
    day();
    open(DAY, 2);
    await runTool(tool, args);
    assert.deepEqual(requests.find(r => r.method === 'PUT').changed, changed, tool);
  }
});

test('a template that starts a new workout opens it, and what Trace logs next goes into it', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const out = await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  assert.equal(out.new_workout, true);
  assert.equal(get(store.currentSessionId), out.workout_id, 'the Diary shows the new workout');
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.deepEqual(rows.find(r => r.id === out.workout_id).exercises.map(e => e.exercise_name), ['Squat', 'Dips']);
  assert.deepEqual(names(2), ['Bench Press'], 'Push untouched');
});

test('a template filling an empty workout keeps its finished mark and records the plan week, as the Diary does', async () => {
  day();
  rows.push({ id: 3, date: DAY, name: null, notes: 'warm up first', completed: 1, exercises: [] });
  open(DAY, 3);
  await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  const w = rows.find(r => r.id === 3);
  assert.equal(w.completed, 1);
  assert.equal(w.program_week, 3, 'the week of the program being followed');
  assert.equal(w.template_id, 3);
  const made = await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  assert.equal(rows.find(r => r.id === made.workout_id).program_week, 3, 'a new workout too');
});

test('a template from a program not being followed records no week', async () => {
  day();
  program = { id: 1, is_active: false, current_week: null, duration_weeks: 6 };
  try {
    const out = await runTool('start_workout_from_template', { template_id: 3, date: DAY });
    assert.equal(rows.find(r => r.id === out.workout_id).program_week, null);
  } finally { program = { id: 1, is_active: true, current_week: 3, duration_weeks: 6 }; }
});

test('the Diary is told when Trace opens the new workout, so its notes box shows that one', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  opened.length = 0;
  const out = await runTool('start_workout_from_template', { template_id: 3, date: DAY });
  assert.deepEqual(opened, [{ date: DAY, id: out.workout_id }]);
  const { readFileSync } = await import('node:fs');
  const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.match(diary, /window\.addEventListener\('lt:workout-opened', _onWorkoutOpened\);/);
  assert.match(diary, /window\.removeEventListener\('lt:workout-opened', _onWorkoutOpened\);/);
  assert.match(diary, /function _onWorkoutOpened\(\) \{\s*\n\s*notes = \$todayLog\?\.notes \|\| '';/);
});

test("what Trace saves into the open workout shows in the Diary at once, as saved", async () => {
  for (const [tool, args] of [
    ['log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 8 }],
    ['add_exercise_to_diary', { exercise_name: 'Dips', date: DAY }],
    ['log_workout', { date: DAY, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }],
  ]) {
    day();
    await store.loadWorkout(DAY);
    await store.switchSession(DAY, 2);
    // Read back, the server would not have it yet with changes waiting.
    const reads = requests.length;
    await runTool(tool, args);
    const shown = get(store.todayLog);
    assert.equal(shown.id, 2, tool);
    assert.deepEqual(shown.exercises, rows.find(r => r.id === 2).exercises, `${tool}: the Diary has what was saved, sets too`);
    assert.ok(!requests.slice(reads).some(r => r.method === 'GET' && r.path === `/api/workout/${DAY}?id=2` && requests.indexOf(r) > requests.findIndex(q => q.method === 'PUT')), `${tool}: not read back`);
  }
});

test('a save into another workout leaves the one open in the Diary alone', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  await runTool('log_set', { workout_id: 1, exercise_name: 'Hip', weight: 0, reps: 12 });
  assert.equal(get(store.currentSessionId), 2);
  assert.deepEqual(get(store.todayLog).exercises.map(e => e.exercise_name), ['Bench Press']);
});

test('a Diary change still waiting to save goes up before Trace reads the workout, and Trace saves on top of it', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const w = get(store.todayLog);
  // An edit still in its debounce.
  store.saveWorkout(DAY, { ...w, exercises: [...w.exercises, { exercise_name: 'Fly', sets: [{ reps: 12 }] }] }).catch(() => {});
  opened.length = 0;
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.deepEqual(names(2), ['Bench Press', 'Fly', 'Dips'], 'both saved');
  assert.deepEqual(get(store.todayLog).exercises.map(e => e.exercise_name), ['Bench Press', 'Fly', 'Dips'], 'and both shown');
  assert.deepEqual(opened, [], 'the same workout: the notes box is left alone');
  await new Promise(r => setTimeout(r, 450));
  assert.deepEqual(names(2), ['Bench Press', 'Fly', 'Dips'], 'nothing goes up after to undo it');
});

test("a Diary save sent ahead of Trace still answers whoever was waiting on it", async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const w = get(store.todayLog);
  const pending = store.saveWorkout(DAY, { ...w, name: 'Push A' });
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  const answered = await Promise.race([pending, new Promise(r => setTimeout(() => r('never'), 1000))]);
  assert.notEqual(answered, 'never');
  assert.equal(rows.find(r => r.id === 2).name, 'Push A');
});

test('a Diary save already on its way is waited for, not sent again', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const w = get(store.todayLog);
  store.saveWorkout(DAY, { ...w, name: 'Push B' }).catch(() => {});
  await new Promise(r => setTimeout(r, 360)); // the timer has fired
  const before = requests.filter(r => r.method === 'PUT').length;
  await runTool('add_exercise_to_diary', { exercise_name: 'Dips', date: DAY });
  assert.equal(requests.filter(r => r.method === 'PUT').length - before, 1, "only Trace's");
});

test("a Diary edit made while Trace marks the workout finished keeps Trace's finished mark and name", async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const stale = get(store.todayLog);
  // The user adds a set while Trace's save is on its way.
  globalThis.__duringPut = () => {
    const ex = stale.exercises.map((e, i) => (i ? e : { ...e, sets: [...e.sets, { reps: 6, weight: 70, completed: true }] }));
    store.saveWorkout(DAY, { ...stale, exercises: ex }).catch(() => {});
  };
  await runTool('log_workout', { date: DAY, name: 'Push Heavy', exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] });
  await new Promise(r => setTimeout(r, 450));
  const w = rows.find(r => r.id === 2);
  assert.equal(w.completed, 1, 'still finished');
  assert.equal(w.name, 'Push Heavy', "Trace's name kept");
  assert.equal(w.exercises[0].sets.length, 2, "and the user's set saved");
});

test('what the Diary did change still goes up', () => {
  const known = { name: 'Push', notes: null, duration_min: null, completed: 0, template_id: null, program_id: null, program_week: null };
  const current = { ...known, name: 'Push Heavy', completed: 1 };
  const out = store.detailsToSave({ ...known, notes: 'felt strong' }, current, new Set(['notes']));
  assert.equal(out.notes, 'felt strong');
  assert.equal(out.name, 'Push Heavy');
  assert.equal(out.completed, 1);
  // A template loaded in the Diary takes the program, its workout and the week together.
  const t = store.detailsToSave({ ...known, template_id: 3, program_id: 1, program_week: null }, { ...known, program_week: 4 }, new Set(['template_id', 'program_id']));
  assert.deepEqual([t.template_id, t.program_id, t.program_week], [3, 1, null]);
  // Nothing to compare against: as before, the Diary's value unless it has none.
  assert.equal(store.detailsToSave({ name: null, notes: 'x' }, { name: 'Push', notes: 'y' }, null).name, 'Push');
});

test("what Trace saves carries its exercises' and sets' ids, so the Diary's next save of it can't make a second copy", async () => {
  for (const [tool, args] of [
    ['add_exercise_to_diary', { exercise_name: 'Dips', date: '2026-10-09' }],
    ['log_set', { workout_id: 2, exercise_name: 'Bench', weight: 62.5, reps: 8 }],
    ['log_workout', { date: DAY, exercises: [{ name: 'Dips', sets: [{ weight: 0, reps: 10 }] }] }],
    ['start_workout_from_template', { template_id: 3, date: '2026-10-09' }],
  ]) {
    day();
    open(DAY, 2);
    await runTool(tool, args);
    const sent = requests.find(r => r.method === 'PUT').body;
    assert.ok(sent.exercises.every(e => e.uuid && (e.sets || []).every(x => x.uuid)), tool);
  }
});

test('two Diary saves in a row still keep a name changed elsewhere since the Diary loaded the workout', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  rows.find(r => r.id === 2).name = 'Chest'; // renamed on another device
  const shown = get(store.todayLog);         // still says Push
  const withSet = (w, reps) => ({ ...w, exercises: w.exercises.map((e, i) => (i ? e : { ...e, sets: [...e.sets, { reps, weight: 60 }] })) });
  // The second edit comes in while the first save is on its way.
  globalThis.__duringPut = () => { store.saveWorkout(DAY, withSet(get(store.todayLog), 6)).catch(() => {}); };
  store.saveWorkout(DAY, withSet(shown, 7)).catch(() => {});
  await new Promise(r => setTimeout(r, 900));
  const w = rows.find(r => r.id === 2);
  assert.equal(w.name, 'Chest');
  assert.equal(w.exercises[0].sets.length, 3, 'both sets saved');
});

test('the Diary says which exercises and sets it changed since what it showed', () => {
  const shown = [
    { uuid: 'b', exercise_name: 'Bench', sets: [{ uuid: 's1', reps: 8, completed: false }, { uuid: 's2', reps: 8, completed: false }] },
    { uuid: 'd', exercise_name: 'Dips', notes: null, sets: [{ uuid: 'd1', reps: 10 }] },
  ];
  const next = [
    { uuid: 'b', exercise_name: 'Bench', sets: [{ uuid: 's1', reps: 8, completed: false }, { uuid: 's2', reps: 6, completed: true }, { uuid: 's3', reps: 5 }] },
    { uuid: 'd', exercise_name: 'Dips', notes: 'slow', sets: [{ uuid: 'd1', reps: 10, _open: true }] },
    { uuid: 'f', exercise_name: 'Fly', sets: [{ uuid: 'f1', reps: 12 }] },
  ];
  assert.deepEqual(store.changedUuids(shown, next), { exercises: ['d', 'f'], sets: { b: ['s2', 's3'], f: ['f1'] } });
});

test("the Diary's save carries what it changed, so a set done elsewhere stays done", async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const shown = get(store.todayLog);
  let sent = null;
  globalThis.__duringPut = (body) => { sent = body; };
  store.saveWorkout(DAY, { ...shown, exercises: shown.exercises.map(e => ({ ...e, sets: [...e.sets, { reps: 6, weight: 60 }] })) }).catch(() => {});
  await new Promise(r => setTimeout(r, 450));
  assert.ok(sent?.changed_uuids, 'sent');
  assert.deepEqual(sent.changed_uuids.exercises, []);
  const ex = shown.exercises[0].uuid;
  assert.equal(sent.changed_uuids.sets[ex].length, 1, 'only the new set');
});

test('a set edited in place on screen still counts as changed', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const shown = get(store.todayLog);
  let sent = null;
  globalThis.__duringPut = (body) => { sent = body; };
  shown.exercises[0].sets[0].completed = true; // mutated, as a bound input would
  store.saveWorkout(DAY, { ...shown }).catch(() => {});
  await new Promise(r => setTimeout(r, 450));
  const ex = shown.exercises[0];
  assert.deepEqual(sent.changed_uuids.sets[ex.uuid], [ex.sets[0].uuid]);
  assert.equal(rows.find(r => r.id === 2).exercises[0].sets[0].completed, true);
});

test('a set unticked while the save that ticked it is still on its way stays unticked', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const shown = get(store.todayLog);
  const tick = (w, done) => ({ ...w, exercises: w.exercises.map((e, i) => (i ? e : { ...e, sets: e.sets.map((x, j) => (j ? x : { ...x, completed: done })) })) });
  // Unticked while the tick's save is in the air.
  globalThis.__duringPut = () => { store.saveWorkout(DAY, tick(get(store.todayLog), false)).catch(() => {}); };
  store.saveWorkout(DAY, tick(shown, true)).catch(() => {});
  await new Promise(r => setTimeout(r, 900));
  assert.equal(rows.find(r => r.id === 2).exercises[0].sets[0].completed, false);
});

test("a refresh bringing the watch's tick while a Diary edit waits keeps both", async () => {
  day();
  rows[1].exercises[0].sets.push({ uuid: 'y1', reps: 8, weight: 60, completed: false });
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const shown = get(store.todayLog);
  // The Diary ticks set 1; its save waits out the debounce.
  store.saveWorkout(DAY, { ...shown, exercises: shown.exercises.map((e, i) => (i ? e : { ...e, sets: e.sets.map((x, j) => (j ? x : { ...x, completed: true })) })) }).catch(() => {});
  // Meanwhile the watch ticks y1, and a refresh shows it here.
  rows[1].exercises[0].sets.find(x => x.uuid === 'y1').completed = true;
  rows[1].updated_at = '2099-01-01 00:00:00';
  await store.loadWorkout(DAY, { preferFresher: true });
  await new Promise(r => setTimeout(r, 450));
  const sets = rows.find(r => r.id === 2).exercises[0].sets;
  assert.equal(sets[0].completed, true, "the Diary's tick");
  assert.equal(sets.find(x => x.uuid === 'y1').completed, true, "and the watch's");
});

test('a change queued with no connection is still listed by the next save, until one reaches the server', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const tick = (w) => ({ ...w, exercises: w.exercises.map((e, i) => (i ? e : { ...e, sets: e.sets.map((x, j) => (j ? x : { ...x, completed: true })) })) });
  globalThis.__queueReply = true;
  store.saveWorkout(DAY, tick(get(store.todayLog))).catch(() => {});
  await new Promise(r => setTimeout(r, 450));
  globalThis.__queueReply = false;
  let sent = null;
  globalThis.__duringPut = (body) => { sent = body; };
  const w = get(store.todayLog);
  store.saveWorkout(DAY, { ...w, name: 'Push A' }).catch(() => {});
  await new Promise(r => setTimeout(r, 450));
  const ex = w.exercises[0];
  assert.deepEqual(sent.changed_uuids.sets[ex.uuid], [ex.sets[0].uuid], 'the queued tick still said');
  assert.equal(rows.find(r => r.id === 2).exercises[0].sets[0].completed, true);
});

test('a refresh waits while a change made here is still waiting to save', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const w = get(store.todayLog);
  store.saveWorkout(DAY, { ...w, name: 'Mine' }).catch(() => {});
  rows[1].name = 'Theirs';
  rows[1].updated_at = '2099-01-01 00:00:00';
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.equal(get(store.todayLog).name, 'Mine', 'not shown over the waiting change');
  await new Promise(r => setTimeout(r, 450));
});

test('the Diary saves notes only when typed, and a set before checking it for a record', async () => {
  const { readFileSync } = await import('node:fs');
  const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.equal((diary.match(/on:focus=\{notesFocused\}\s*\n\s*on:blur=\{saveNotes\}/g) || []).length, 2);
  assert.match(diary, /const typed = _notesAtFocus == null \|\| notes !== _notesAtFocus;/);
  assert.match(diary, /const saving = saveWorkout\(\$currentDate, \{ \.\.\.\(\$todayLog \|\| \{\}\), exercises: updated \}\);\s*\n\s*if \(prCheck\) await prCheck\(\);/);
});

test('a save the server refused does not shut out the refreshes after it', async () => {
  day();
  await store.loadWorkout(DAY);
  await store.switchSession(DAY, 2);
  const real = globalThis.fetch;
  globalThis.fetch = async (path, init) => (init?.method === 'PUT' ? new Response('{"error":"no"}', { status: 400 }) : real(path, init));
  try {
    store.saveWorkout(DAY, { ...get(store.todayLog), name: 'Refused' }).catch(() => {});
    await new Promise(r => setTimeout(r, 450));
  } finally { globalThis.fetch = real; }
  rows[1].name = 'From the watch';
  rows[1].updated_at = '2099-01-01 00:00:00';
  await store.loadWorkout(DAY, { preferFresher: true });
  assert.equal(get(store.todayLog).name, 'From the watch');
});
