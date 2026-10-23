/**
 * Trace's read tools can go through a whole training history
 * (TraceApps/notetrace#34).
 *
 * get_workouts read only the newest 200 workouts, so a range reaching
 * further back came back short with nothing said, and gave every workout
 * in the range in one answer with no way to a next page; get_workout and
 * log_set found a workout only among the newest 500; get_prs gave 20
 * records with no word of the rest. These run the real tool executor
 * against a stubbed list endpoint that, like the server, gives the newest
 * workouts, as many as asked for.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { runTool, TOOLS, forgetToolReads } = await import('../src/lib/aiTools.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Local YYYY-MM-DD, offset in days from today; matches aiTools' own today. */
const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};
const workout = (id, date, name = 'Bench Press', session_seq = 0) => ({
  id, date, session_seq, completed: true,
  exercises: [{ exercise_id: 1, exercise_name: name, sets: [{ weight: 100 + (id % 50), reps: 5, completed: true }] }],
});

/** The list endpoint: newest first, `limit` of them; `shuffleTies` mixes up same-day sessions each call. */
function stubApi({ workouts = [], records = [], shuffleTies = false } = {}) {
  forgetToolReads(); // each test is a new answer
  const calls = [];
  globalThis.fetch = async (path, opts = {}) => {
    calls.push(path);
    let body = {};
    if ((opts.method || 'GET') === 'PUT' && /^\/api\/workout\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      // A save: the server keeps it, and answers with the workout.
      const sent = JSON.parse(opts.body);
      const at = workouts.findIndex((w) => w.id === sent.id);
      workouts[at] = { ...workouts[at], ...sent };
      body = { workout: workouts[at] };
    } else if (path.startsWith('/api/workout/recent')) {
      const limit = Number(new URL(path, 'http://x').searchParams.get('limit')) || 30;
      const sorted = [...workouts].sort((a, b) => b.date.localeCompare(a.date) || (shuffleTies ? Math.random() - 0.5 : 0));
      body = sorted.slice(0, limit).map((w) => JSON.parse(JSON.stringify(w)));
    } else if (path.startsWith('/api/stats/records')) {
      body = records;
    } else if (path.startsWith('/api/workout/')) {
      const id = Number(new URL(path, 'http://x').searchParams.get('id'));
      body = { workout: workouts.find((w) => w.id === id) || null };
    }
    return { ok: true, json: async () => body };
  };
  return calls;
}

// Four years of three workouts a week: 624 workouts.
const years = Array.from({ length: 624 }, (_, i) => workout(i + 1, day(-Math.floor(i * 7 / 3) - 1)));

test('a range reaching years back is read in full, page by page', async () => {
  const calls = stubApi({ workouts: years });
  const from = day(-3 * 365);
  const want = years.filter((w) => w.date >= from).map((w) => w.id);
  assert.ok(want.length > 400, `${want.length} workouts in three years`);
  const seen = [];
  let page = await runTool('get_workouts', { date_from: from, date_to: day(0) });
  assert.equal(page.count, want.length, 'count is every workout in the range');
  assert.deepEqual([page.offset, page.returned, page.next_offset, page.complete], [0, 25, 25, false]);
  assert.equal(page.more, `This is workouts 1 to 25 of ${want.length}: call get_workouts again with offset 25 for the rest.`);
  seen.push(...page.workouts.map((w) => w.id));
  while (!page.complete) {
    page = await runTool('get_workouts', { date_from: from, date_to: day(0), offset: page.next_offset, limit: 50 });
    assert.ok(page.returned <= 50);
    seen.push(...page.workouts.map((w) => w.id));
  }
  assert.deepEqual(seen.sort((a, b) => a - b), want.sort((a, b) => a - b), 'every workout in the range, once');
  assert.equal(page.more, undefined, 'the last page says nothing more');
  assert.ok(calls.some((c) => c.includes('limit=2000')), 'asked for a longer list only because 200 stopped short');
  // Past the end: an empty last page.
  const past = await runTool('get_workouts', { date_from: from, date_to: day(0), offset: 9999 });
  assert.deepEqual([past.returned, past.complete, past.workouts], [0, true, []]);
});

test('a recent range costs what it did: one list of 200, and the same answer when it fits', async () => {
  const calls = stubApi({ workouts: years });
  const r = await runTool('get_workouts', { date_from: day(-14), date_to: day(0) });
  assert.ok(Array.isArray(r), 'a range that fits one page comes back as the list it always was');
  assert.equal(r.length, years.filter((w) => w.date >= day(-14)).length);
  assert.deepEqual(calls, ['/api/workout/recent?limit=200']);
  // A short history is read once, whatever the range.
  const few = stubApi({ workouts: years.slice(0, 50) });
  await runTool('get_workouts', { date_from: day(-3000), date_to: day(0) });
  assert.deepEqual(few, ['/api/workout/recent?limit=200']);
});

test('two sessions on one day come in the same order every call, so pages never skip or repeat one', async () => {
  const doubled = years.slice(0, 60).flatMap((w) => [w, { ...workout(w.id + 10000, w.date, 'Squat', 1) }]);
  stubApi({ workouts: doubled, shuffleTies: true });
  const seen = [];
  for (let offset = 0; offset != null;) {
    forgetToolReads(); // each page reads the list afresh, in a new order of ties
    const page = await runTool('get_workouts', { date_from: day(-3000), date_to: day(0), offset, limit: 7 });
    seen.push(...page.workouts.map((w) => w.id));
    offset = page.next_offset;
  }
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120, 'each once');
});

test('a workout older than the newest 500 is found by its id', async () => {
  stubApi({ workouts: years });
  const oldest = years.at(-1);
  const w = await runTool('get_workout', { id: oldest.id });
  assert.equal(w.error, undefined, JSON.stringify(w));
  assert.equal(w.date, oldest.date);
  // log_set finds its workout the same way.
  assert.match(read('../src/lib/aiTools.js'), /async function _logSet[\s\S]{0,400}_recentWorkouts\(\{ id: workout_id \}\)/);
});

test('offline, where only the usual list is kept, a long range says what it could not read', async () => {
  stubApi({ workouts: years });
  const online = globalThis.fetch;
  globalThis.fetch = async (path, opts) => {
    if (/limit=(2000|20000)/.test(path)) throw new Error('This needs a connection');
    return online(path, opts);
  };
  const r = await runTool('get_workouts', { date_from: day(-3 * 365), date_to: day(0) });
  assert.equal(r.count, 200, 'the newest 200, all of them');
  assert.match(r.note, /earlier ones in this range are missing/);
  assert.match(r.note, new RegExp(`from ${years[199].date} on`));
  // A range the usual list covers says nothing.
  assert.ok(Array.isArray(await runTool('get_workouts', { date_from: day(-14), date_to: day(0) })));
});

test('a set Trace logs is in the list it reads next', async () => {
  const mine = years.map((w) => structuredClone(w));
  stubApi({ workouts: mine });
  const recent = mine[0];
  await runTool('get_workouts', { date_from: day(-14), date_to: day(0) });
  const r = await runTool('log_set', { workout_id: recent.id, exercise_name: 'Bench Press', weight: 150, reps: 3 });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const after = await runTool('get_workouts', { date_from: day(-14), date_to: day(0) });
  const it = after.find((w) => w.id === recent.id);
  assert.ok(JSON.stringify(it).includes('150'), `the new set is there: ${JSON.stringify(it)}`);
});

test('get_prs says how many records there are and pages through them', async () => {
  const records = Array.from({ length: 45 }, (_, i) => ({ name: `Lift ${String(i).padStart(2, '0')}`, maxWeight: 100, maxReps: 5, e1rm: i < 10 ? 116 : 200 - i, date: day(-i) }));
  stubApi({ records });
  const first = await runTool('get_prs', {});
  assert.deepEqual([first.count, first.returned, first.next_offset, first.complete], [45, 20, 20, false]);
  assert.match(first.more, /call get_prs again with offset 20/);
  const seen = [...first.records.map((r) => r.exercise_name)];
  for (let offset = first.next_offset; offset != null;) {
    const page = await runTool('get_prs', { offset });
    seen.push(...page.records.map((r) => r.exercise_name));
    offset = page.next_offset;
  }
  assert.equal(new Set(seen).size, 45, 'every record, once (ties go by name)');
  // A short list is the list it always was.
  stubApi({ records: records.slice(0, 5) });
  assert.ok(Array.isArray(await runTool('get_prs', {})));
  stubApi({ records: Array.from({ length: 150 }, (_, i) => ({ name: `L${i}`, maxWeight: 100, maxReps: 5, e1rm: 100 + i, date: day(-1) })) });
  assert.equal((await runTool('get_prs', { limit: 500 })).returned, 100, 'up to 100 at once');
});

test('the tools tell the model how to page', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const name of ['get_workouts', 'get_prs']) {
    assert.equal(byName[name].parameters.properties.offset.type, 'integer', name);
    assert.match(byName[name].description, /next_offset/, name);
  }
});
