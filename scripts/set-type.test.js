/**
 * Timed sets (issue #89): planks, holds and carries logged by duration.
 *
 * Most of these run the real code rather than asserting on source text,
 * because every module involved (src/lib/workout.js, server/lib/volume.js,
 * the importers, the CSV exporter) is pure and loads without a native
 * better-sqlite3 binding. The wiring checks at the end cover the pieces that
 * do need a database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const client = await import('../src/lib/workout.js');
const server = await import('../server/lib/volume.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── One definition of "timed", shared by client and server ──────────────

test('client and server agree on which sets are timed', () => {
  // Two copies exist on purpose (the server cannot import src/ without a
  // Dockerfile change that only fails at runtime). This is what keeps them
  // from drifting.
  const cases = [
    [{}, { reps: 5, weight: 100 }],
    [{}, { duration_sec: 60 }],
    [{}, { duration_sec: 0, reps: 10 }],
    [{ set_type: 'time' }, { reps: 30 }],              // flipped to time, reps left over
    [{ set_type: 'reps' }, { duration_sec: 45 }],      // flipped back, duration left over
    [{ set_type: 'bogus' }, { duration_sec: 45 }],
    [null, { duration_sec: 20 }],
    [{}, null],
  ];
  for (const [ex, set] of cases) {
    assert.equal(client.isTimedSet(ex, set), server.isTimedSet(ex, set),
      `disagree on ${JSON.stringify(ex)} / ${JSON.stringify(set)}`);
  }
  assert.equal(client.isTimedSet({ set_type: 'time' }, { reps: 30 }), true);
  assert.equal(client.isTimedSet({ set_type: 'reps' }, { duration_sec: 45 }), false);
});

test('volume ignores timed sets on both sides, including leftover reps after a flip', () => {
  const ex = {
    set_type: 'time',
    sets: [
      { completed: true, weight: 25, reps: 30, duration_sec: 60 },   // reps typed before switching
      { completed: true, weight: 25, reps: 0, duration_sec: 45 },
    ],
  };
  assert.equal(client.exerciseVolume(ex), 0);
  assert.equal(server.exerciseVolume(ex), 0);

  const bench = { sets: [{ completed: true, weight: 100, reps: 5 }, { completed: true, weight: 100, reps: 5 }] };
  assert.equal(client.exerciseVolume(bench), 1000, 'rep volume must be unchanged');
  assert.equal(server.exerciseVolume(bench), 1000, 'rep volume must be unchanged');
});

// ── Which input an exercise shows ────────────────────────────────────────

test('resolveSetType: recorded data outranks every default', () => {
  const R = client.resolveSetType;
  // The guarantee that matters most: history logged as reps never changes
  // shape because a default was added later.
  assert.equal(R({ exercise_name: 'Plank', sets: [{ reps: 30 }] }, 'time', { 1: 'time' }), 'reps');
  assert.equal(R({ exercise_name: 'Bench Press', sets: [{ duration_sec: 40 }] }, 'reps'), 'time');
});

test('resolveSetType: the full precedence chain', () => {
  const R = client.resolveSetType;
  assert.equal(R({ set_type: 'time', sets: [{ reps: 5 }] }), 'time', 'instance choice beats data');
  assert.equal(R({ exercise_name: 'Squat', sets: [] }, 'time'), 'time', 'library default');
  assert.equal(R({ exercise_name: 'Plank', sets: [] }, 'reps'), 'reps', 'library beats name list');
  assert.equal(R({ exercise_id: 9, exercise_name: 'Squat', sets: [] }, null, { 9: 'time' }), 'time', 'remembered choice');
  assert.equal(R({ exercise_id: 9, exercise_name: 'Plank', sets: [] }, null, { 9: 'reps' }), 'reps', 'remembered beats name list');
  assert.equal(R({ exercise_name: 'Plank', sets: [] }), 'time', 'name list');
  assert.equal(R({ exercise_name: 'Squat', sets: [] }), 'reps', 'fallback');
});

test('timed-by-name list is exact, so real rep exercises are not caught', () => {
  // These all come from the free-exercise-db catalogue and would match a
  // naive /hang|bridge|plank/ pattern.
  for (const name of ['Hang Clean', 'Hang Snatch', 'Hanging Leg Raise', 'Barbell Glute Bridge',
    'Push Up to Side Plank', 'Dead Bug', 'Bench Press']) {
    assert.equal(client.defaultSetTypeForName(name), null, `${name} must stay reps`);
  }
  for (const name of ['Plank', 'Side Bridge', "Farmer's Walk", 'Farmers Walk', 'L-Sit', 'Wall Sit', 'Dead Hang']) {
    assert.equal(client.defaultSetTypeForName(name), 'time', `${name} should default to time`);
  }
});

// ── Typing and showing durations ─────────────────────────────────────────

test('parseDuration reads the ways people actually type a hold', () => {
  const P = client.parseDuration;
  // Timer style: digits fill from the right, last two are seconds, so nobody
  // has to turn "2 minutes" into 120 on a number pad with no colon key.
  assert.equal(P('45'), 45);
  assert.equal(P('130'), 90, '130 is 1:30');
  assert.equal(P('200'), 120, '200 is 2:00');
  assert.equal(P('90'), 90, 'overflowing seconds carry, as on a microwave');
  assert.equal(P('0:90'), 90, 'what the mask shows mid-typing must read the same');
  assert.equal(P('1:30'), 90);
  assert.equal(P('1:02:05'), 3725);
  assert.equal(P('45s'), 45);
  assert.equal(P('2m'), 120);
  assert.equal(P('2 min'), 120);
  assert.equal(P('1m30s'), 90);
  assert.equal(P(' 0:45 '), 45);
  for (const bad of ['', '0', 'abc', '1:', '1:75:00', null, undefined]) {
    assert.equal(P(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the live mask shows m:ss as digits are typed, and agrees with the parser', () => {
  const M = client.maskDurationInput;
  assert.deepEqual(['1', '13', '130'].map(M), ['0:01', '0:13', '1:30']);
  assert.equal(M('1:30'), '1:30', 'a typed colon lands in the same place');
  assert.equal(M('1:3'), '0:13', 'backspace removes the last digit');
  assert.equal(M('00045'), '0:45');
  assert.equal(M(''), '');
  assert.equal(M('abc'), '');
  // Whatever the mask displays, the parser must read as the typed digits.
  for (const typed of ['7', '45', '90', '130', '959', '1000']) {
    assert.equal(client.parseDuration(M(typed)), client.parseDuration(typed), `mismatch for ${typed}`);
  }
});

test('every duration field uses the timer-style mask', () => {
  assert.match(read('../src/components/diary/SetRow.svelte'), /durationStr = maskDurationInput\(durationStr\)/);
  assert.match(read('../src/components/programs/TemplateSpecRow.svelte'), /maskDurationInput\(e\.target\.value\)/);
  const editor = read('../src/routes/WorkoutEditor.svelte');
  assert.equal((editor.match(/maskDurationInput\(e\.target\.value\)/g) || []).length, 2,
    'both the superset and standalone uniform duration fields');
});

test('fmtSetDuration and fmtSetLabel render holds as time, lifts unchanged', () => {
  assert.equal(client.fmtSetDuration(45), '0:45');
  assert.equal(client.fmtSetDuration(75), '1:15');
  assert.equal(client.fmtSetDuration(3725), '1:02:05');
  assert.equal(client.fmtSetDuration(0), '');
  assert.equal(client.fmtSetLabel({ set_type: 'time' }, { duration_sec: 60 }), '1:00');
  assert.equal(client.fmtSetLabel({}, { duration_sec: 60, weight: 25 }), '25×1:00');
  assert.equal(client.fmtSetLabel({}, { reps: 8, weight: 135 }), '135×8');
});

// ── Records ──────────────────────────────────────────────────────────────

test('a timed set moves the longest-hold record and never the rep record', () => {
  const r = server.newRecord('Plank');
  server.accumulateRecord(r, { set_type: 'time' }, { completed: true, duration_sec: 60, reps: 30, weight: 0 }, '2026-09-01');
  server.accumulateRecord(r, { set_type: 'time' }, { completed: true, duration_sec: 60, weight: 25 }, '2026-09-02');
  server.accumulateRecord(r, { set_type: 'time' }, { completed: true, duration_sec: 45, weight: 50 }, '2026-09-03');
  server.accumulateRecord(r, { set_type: 'time' }, { completed: true, duration_sec: 90, warmup: true }, '2026-09-04');
  assert.equal(r.maxDuration, 60);
  assert.equal(r.maxDurationWeight, 25, 'a tie on time is broken by the heavier hold');
  assert.equal(r.durationDate, '2026-09-02');
  assert.equal(r.maxWeight, 0, 'no 1RM or max weight for a hold');
  assert.equal(r.e1rm, 0);
});

test('rep records are computed exactly as before', () => {
  const r = server.newRecord('Bench');
  server.accumulateRecord(r, {}, { completed: true, weight: 100, reps: 5 }, '2026-09-01');
  server.accumulateRecord(r, {}, { completed: true, weight: 110, reps: 1 }, '2026-09-02');
  assert.equal(r.maxWeight, 110);
  assert.equal(r.maxReps, 1);
  assert.equal(r.e1rm, 117, 'Epley on 100x5');
  assert.equal(r.maxDuration, 0);
});

// ── CSV export ───────────────────────────────────────────────────────────

test('CSV export appends duration_sec last and fills the exercise column', async () => {
  const { workoutToCsv } = await import('../src/lib/workoutCsv.js');
  const { csv } = workoutToCsv({
    date: '2026-09-14', name: 'Test',
    exercises: [
      { exercise_id: 1, exercise_name: 'Bench Press', sets: [{ reps: 5, weight: 135, completed: true }] },
      { exercise_id: 2, exercise_name: 'Plank', set_type: 'time', sets: [{ reps: 0, weight: 0, duration_sec: 60, completed: true }] },
    ],
  });
  const [header, bench, plank] = csv.trim().split('\r\n').map(l => l.split(','));
  // Positional consumers must keep working: everything before the new
  // column is exactly the old header.
  assert.deepEqual(header.slice(0, 17), ['date', 'workout', 'exercise', 'exercise_index', 'superset',
    'set_index', 'warmup', 'reps', 'weight', 'weight_unit', 'side', 'rpe', 'completed', 'set_notes',
    'exercise_notes', 'workout_notes', 'workout_duration_min']);
  assert.equal(header[17], 'duration_sec');
  // This column read ex.name, which workout exercises never have.
  assert.equal(bench[2], 'Bench Press');
  assert.equal(plank[2], 'Plank');
  assert.equal(plank[7], '', 'a hold has no reps, so seconds can never be summed as reps');
  assert.equal(plank[17], '60');
  assert.equal(bench[17], '');
});

// ── Importers ────────────────────────────────────────────────────────────

test('Strong import keeps hold durations instead of empty 0x0 sets', async () => {
  const { parseStrong } = await import('../server/lib/workout-import/strong.js');
  const csv = [
    'Date;Workout Name;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE;Weight Unit',
    '2024-08-01 18:23:30;Core;Plank;1;;0;;60;;;;lbs',
    '2024-08-01 18:23:30;Core;Plank;2;25;0;;45;;;;lbs',
    '2024-08-01 18:23:30;Core;Bench Press;1;135;5;;;;;;lbs',
    '2024-08-01 18:23:30;Core;Odd Row;1;50;8;;30;;;;lbs',
  ].join('\n') + '\n';
  const [w] = parseStrong(csv, 'lbs');
  const byName = Object.fromEntries(w.exercises.map(e => [e.exercise_name, e]));
  assert.equal(byName.Plank.set_type, 'time');
  assert.deepEqual(byName.Plank.sets.map(s => s.duration_sec), [60, 45]);
  assert.equal(byName['Bench Press'].set_type, undefined);
  // Both reps and seconds: kept as a rep set rather than guessed.
  assert.equal(byName['Odd Row'].sets[0].duration_sec, undefined);
  assert.equal(byName['Odd Row'].sets[0].reps, 8);
});

test('Hevy import keeps duration_seconds', async () => {
  const { parseHevy } = await import('../server/lib/workout-import/hevy.js');
  const csv = [
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    'Core,"01 Aug 2024, 18:23","01 Aug 2024, 19:00",,Dead Hang,,,0,normal,,,,40,',
    'Core,"01 Aug 2024, 18:23","01 Aug 2024, 19:00",,Squat,,,0,normal,100,5,,,',
  ].join('\n') + '\n';
  const [w] = parseHevy(csv, 'kg');
  const byName = Object.fromEntries(w.exercises.map(e => [e.exercise_name, e]));
  assert.equal(byName['Dead Hang'].set_type, 'time');
  assert.equal(byName['Dead Hang'].sets[0].duration_sec, 40);
  assert.equal(byName.Squat.sets[0].reps, 5);
  assert.equal(byName.Squat.set_type, undefined);
});

test('server and Android importer copies stay identical', () => {
  for (const f of ['strong.js', 'hevy.js']) {
    assert.equal(read(`../server/lib/workout-import/${f}`), read(`../src/lib/workout-import/${f}`),
      `${f} differs between server and Android; a fix to one must reach both`);
  }
});

// ── Wiring that needs a database, checked statically ─────────────────────

test('set_type is a real library column everywhere an exercise is stored', () => {
  assert.match(read('../server/db.js'), /addColumnIfMissing\('exercises', 'set_type'/);
  assert.match(read('../src/lib/db-native.js'), /ADD COLUMN set_type TEXT DEFAULT NULL/);
  const route = read('../server/routes/exercises.js');
  assert.match(route, /_cleanSetType\(set_type\)/, 'create must whitelist set_type');
  assert.match(route, /nextSetType/, 'update must honour omitted / null / explicit');
  assert.match(read('../server/routes/full-backup.js'), /@load_type,@set_type\)/, 'backup restore must carry set_type');
  assert.match(read('../src/lib/exerciseShare.js'), /'set_type'/);
});

test('Android sync pull no longer resets load_type or set_type', () => {
  // INSERT OR REPLACE rewrites the whole row; any column missing from it is
  // reset on every pull. load_type was missing before this change.
  const sync = read('../src/lib/sync.js');
  const stmt = sync.slice(sync.indexOf('INSERT OR REPLACE INTO exercises'), sync.indexOf("'clean')`", sync.indexOf('INSERT OR REPLACE INTO exercises')));
  assert.match(stmt, /load_type, set_type, sync_state/);
  assert.match(sync, /e\.load_type \?\? null,\s*\n\s*e\.set_type \?\? null,/);
});

test('log_set over MCP and REST accepts duration_sec and refuses to mix kinds', () => {
  const core = read('../server/lib/mcp/tools/log-set.js');
  assert.match(core, /duration_sec: z\.number\(\)\.int\(\)\.min\(1\)\.max\(86400\)\.optional\(\)/);
  assert.match(core, /reps: z\.number\(\)\.int\(\)\.min\(0\)\.max\(1000\)\.optional\(\)/);
  // Validated in the core, since the REST route passes its body straight in.
  assert.match(core, /duration_sec must be a whole number of seconds/);
  assert.match(core, /is tracked by reps on/);
  assert.match(core, /is tracked by time on/);
  assert.match(core, /if \(timed\) target\.set_type = 'time'/);
  assert.match(read('../server/lib/mcp/tools/search-exercises.js'), /set_type: r\.set_type \|\| null/);
});

test('imports carry set_type through the whitelisted exercise row', () => {
  assert.match(read('../server/routes/workout-import.js'), /ex\.set_type \? \{ set_type: ex\.set_type \}/);
  assert.match(read('../src/lib/api-native.js'), /ex\.set_type \? \{ set_type: ex\.set_type \}/);
});

test('the pr.set webhook reports hold records', () => {
  const route = read('../server/routes/workout.js');
  assert.match(route, /improvedDuration/);
  assert.match(route, /new_max_duration_sec:/);
  assert.match(read('../server/lib/mcp/tools/get-records.js'), /isTimedSet\(ex, s\) && Number\(s\.duration_sec\) > 0/,
    'a plank-only save must be able to raise pr.set');
});

test('templates prescribe a real duration field through the weeks matrix', () => {
  const editor = read('../src/routes/WorkoutEditor.svelte');
  assert.match(editor, /duration: 'target_duration'/);
  assert.match(editor, /'weight', 'duration', 'tempo'/);
  // The prescription counts as data, so an existing "Plank 60 reps" template
  // is not flipped to Time by the name default.
  assert.match(editor, /const prescribed = ex\.set_specs\?\.length/);
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /duration: w\.duration \?\? base\.duration/);
});

test('Trace can log and read timed sets', () => {
  const tools = read('../src/lib/aiTools.js');
  assert.match(tools, /duration_sec:\s+\{ type: 'integer'/);
  assert.match(tools, /if \(isTimedSet\(ex, s\)\) continue;/, 'Trace volume must skip holds');
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /Never report a hold's seconds as reps/);
});

// ── Gaps found on a second pass ──────────────────────────────────────────

test('FitNotes import keeps hold times from its Time column', async () => {
  const mod = await import('../server/lib/workout-import/fitnotes.js');
  const parse = Object.values(mod).find(f => typeof f === 'function');
  const csv = [
    'Date,Exercise,Category,Weight (lbs),Reps,Distance,Distance Unit,Time,Comment',
    '2024-08-01,Plank,Abs,,,,,0:01:00,',
    '2024-08-01,Plank,Abs,,,,,45,',
    '2024-08-01,Bench Press,Chest,135,5,,,,',
  ].join('\n') + '\n';
  const [w] = parse(csv, 'lbs');
  const byName = Object.fromEntries(w.exercises.map(e => [e.exercise_name, e]));
  assert.equal(byName.Plank.set_type, 'time');
  assert.deepEqual(byName.Plank.sets.map(x => x.duration_sec), [60, 45]);
  assert.equal(byName['Bench Press'].set_type, undefined);
  assert.equal(read('../server/lib/workout-import/fitnotes.js'), read('../src/lib/workout-import/fitnotes.js'));
});

test('Garmin FIT import keeps the per-set duration instead of dropping it', () => {
  const g = read('../server/lib/workout-import/garmin-fit.js');
  assert.match(g, /if \(ws\.reps === 0 && holdSec > 0\) setRow\.duration_sec = holdSec/);
  assert.match(g, /ex\.set_type = 'time'/);
});

test('auto warm-ups never ramp a timed exercise', () => {
  const diary = read('../src/routes/Diary.svelte');
  const block = diary.slice(diary.indexOf('const withWarmups = $autoGenerateWarmups'));
  assert.match(block.slice(0, 600), /ex\.set_type === 'time'/);
});

test('muscle balance volume skips holds on server and Android', () => {
  // Bounded by the handler itself rather than a character count, so the
  // assertion cannot pass by reading into a neighbouring route.
  const stats = read('../server/routes/stats.js');
  const start = stats.indexOf("router.get('/muscle-group-volume'");
  const mgv = stats.slice(start, stats.indexOf('\nrouter.', start + 1));
  assert.match(mgv, /if \(isTimedSet\(ex, set\)\) continue;/);
  const native = read('../src/lib/api-native.js');
  const nStart = native.indexOf('async muscleGroupVolume');
  const nm = native.slice(nStart, native.indexOf('async weekdayDistribution', nStart));
  assert.match(nm, /if \(isTimedSet\(ex, s\)\) continue;/);
});

test('Trace get_prs reports hold records instead of filtering them out', () => {
  const tools = read('../src/lib/aiTools.js');
  const fn = tools.slice(tools.indexOf('async function _getPrs'));
  assert.match(fn.slice(0, 1600), /\(r\.maxDuration \|\| 0\) > 0/);
  assert.match(fn.slice(0, 1600), /longest_hold_sec: r\.maxDuration/);
});

test('program detail shows a timed exercise\'s target time', () => {
  const pd = read('../src/routes/ProgramDetail.svelte');
  assert.match(pd, /ex\.set_type === 'time'\}\{fmtSetDuration\(parseDuration\(ex\.target_duration\)\)/);
});
