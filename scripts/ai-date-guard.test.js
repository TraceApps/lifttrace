/**
 * Trace date guard (issue #92).
 *
 * Models invent dates, most often by guessing the wrong year. These run the
 * real tool executor against a stubbed fetch, starting with the exact call
 * from the report, rather than asserting on source text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { runTool, cleanRangeArgs, TOOLS } = await import('../src/lib/aiTools.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Local YYYY-MM-DD, offset in days from today; matches aiTools' own today. */
const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};

const workout = (id, date, name) => ({
  id, date, completed: true,
  exercises: [{ exercise_id: 1, exercise_name: name, sets: [{ weight: 135, reps: 5, completed: true }] }],
});

/** Install a fake API; returns the list of calls it saw. */
function stubApi(routes) {
  const calls = [];
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET' });
    for (const [match, handler] of routes) {
      if (path.startsWith(match)) {
        const body = typeof handler === 'function' ? handler(path, opts) : handler;
        return { ok: true, json: async () => body };
      }
    }
    return { ok: true, json: async () => ({}) };
  };
  return calls;
}

// ── Reads ────────────────────────────────────────────────────────────────

test('the reported call: an invented 2024 range no longer reports the lift missing', async () => {
  stubApi([['/api/workout/recent', [
    workout(3, day(0), 'Smith Bench Press'),
    workout(2, day(-7), 'Smith Bench Press'),
    workout(1, day(-9), 'Squat'),
  ]]]);
  const r = await runTool('get_workouts', {
    date_from: '2024-04-27', date_to: '2024-05-27', exercise_name: 'Smith Bench Press',
  });
  assert.ok(!Array.isArray(r), 'an empty invented range must not come back as a bare []');
  assert.equal(r.results.length, 2);
  assert.match(r.note, new RegExp(`Today is ${day(0)}`), 'the note tells the model the real date');
});

test('a plausible wrong year is handled the same, with no age heuristic', async () => {
  // A cutoff like "ignore dates over two years old" lets this one through.
  stubApi([['/api/workout/recent', [workout(1, day(-3), 'Deadlift')]]]);
  const lastYear = day(-365 - 10);
  const r = await runTool('get_workouts', { date_from: lastYear, date_to: day(-365), exercise_name: 'Deadlift' });
  assert.equal(r.results.length, 1);
});

test('a real range with data comes back unchanged, with no note', async () => {
  stubApi([['/api/workout/recent', [workout(1, day(-2), 'Bench Press')]]]);
  const r = await runTool('get_workouts', { date_from: day(-10), date_to: day(0) });
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 1);
});

test('genuinely no data stays empty, rather than a note inventing a fallback', async () => {
  stubApi([['/api/workout/recent', []]]);
  const r = await runTool('get_workouts', { date_from: '2024-04-27', date_to: '2024-05-27' });
  assert.deepEqual(r, []);
});

test('a lift last trained six weeks ago is found without any dates at all', async () => {
  // Same false "not in your log" through the 30-day default window.
  stubApi([['/api/workout/recent', [workout(1, day(-45), 'Overhead Press'), workout(2, day(-2), 'Squat')]]]);
  const r = await runTool('get_workouts', { exercise_name: 'Overhead Press' });
  assert.equal(r.length, 1);
  assert.equal(r[0].date, day(-45));
});

test('malformed, future and inverted ranges are tidied before use', () => {
  assert.deepEqual(cleanRangeArgs({ date_from: '2026-13-45', date_to: 'yesterday' }), {});
  assert.equal(cleanRangeArgs({ date_to: day(30) }).date_to, day(0), 'a future end is clamped to today');
  assert.equal(cleanRangeArgs({ date_from: day(5) }).date_from, undefined, 'a start in the future is dropped');
  const swapped = cleanRangeArgs({ date_from: day(-1), date_to: day(-20) });
  assert.deepEqual([swapped.date_from, swapped.date_to], [day(-20), day(-1)]);
});

test('the same fallback covers the other range tools', async () => {
  stubApi([['/api/cardio', (path) => (path.includes('start=2024') ? [] : [{ date: day(-1), activity: 'Run', duration_min: 30 }])]]);
  const r = await runTool('get_cardio', { date_from: '2024-01-01', date_to: '2024-02-01' });
  assert.equal(r.results.count, 1);
  assert.match(r.note, /Today is/);
});

// ── Writes ───────────────────────────────────────────────────────────────

const bodyStatApi = () => stubApi([['/api/body-stats/', (path, opts) =>
  (opts.method === 'PUT' ? { stats: { id: 1 } } : { stats: { stats: {} } })]]);

test('a write to an invented year is refused with the real date and a way forward', async () => {
  const calls = bodyStatApi();
  await assert.rejects(
    runTool('log_body_stat', { stat: 'weight', value: 80, date: '2024-04-27' }),
    (e) => e.message.includes(`today is ${day(0)}`) && e.message.includes('date_confirmed'),
  );
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0, 'nothing may be written');
});

test('ordinary backdating and near-future planning are not refused', async () => {
  const calls = bodyStatApi();
  await runTool('log_body_stat', { stat: 'weight', value: 80, date: day(-1) });
  await runTool('log_body_stat', { stat: 'weight', value: 80, date: day(-45) });
  assert.equal(calls.filter(c => c.method === 'PUT').length, 2);
});

test('a far date the user confirmed goes through', async () => {
  const calls = bodyStatApi();
  await runTool('log_body_stat', { stat: 'weight', value: 80, date: '2024-04-27', date_confirmed: true });
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('a coach prescription far in the future is guarded on target_date', async () => {
  stubApi([]);
  await assert.rejects(
    runTool('add_coach_prescription', { trainee_id: 1, template_id: 1, target_date: day(400) }),
    /date_confirmed/,
  );
});

// ── Prompt and schema ────────────────────────────────────────────────────

test('every write tool that takes a date offers date_confirmed, and reads do not', () => {
  const byName = Object.fromEntries(TOOLS.map(t => [t.name, t]));
  for (const name of ['log_workout', 'log_body_stat', 'log_cardio', 'add_exercise_to_diary',
    'start_workout_from_template', 'add_coach_prescription']) {
    assert.ok(byName[name].parameters.properties.date_confirmed, `${name} needs date_confirmed`);
  }
  assert.equal(byName.get_coach_prescription.parameters.properties.date_confirmed, undefined);
  assert.match(byName.get_workouts.parameters.properties.date_from.description, /Omit unless the user named/);
});

test('the prompt states the real date, not the day the diary is showing', () => {
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /Today is \$\{_realDow\}, \$\{_realToday\}\./);
  assert.doesNotMatch(trace, /Today is \$\{_dow\}, \$\{\$currentDate\}\./);
  assert.match(trace, /Never guess a year/);
});
