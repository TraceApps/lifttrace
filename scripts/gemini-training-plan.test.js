/**
 * "Create a training plan" with a Gemini key (#147).
 *
 * The report: "Sorry, I couldn't respond: Invalid JSON payload received.
 * Unknown name "response" at 'contents[4].parts[2].function_response':
 * Proto field is not repeating, cannot start list." Several of Trace's read
 * tools answer with a list (get_exercises, get_programs, get_workouts,
 * get_prs), and Gemini takes only a JSON object there. This runs the real
 * tools (src/lib/aiTools.js, on a stubbed /api) in the real loop
 * (src/lib/aiChat.js) against a stand-in for Gemini that refuses what Gemini
 * refuses (scripts/gemini-tool-response.test.js has the rule).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { runTool, forgetToolReads, TOOLS } = await import('../src/lib/aiTools.js');
const { callAI } = await import('../src/lib/aiChat.js');

// What the app's /api answers: one program, three exercises, one workout, one record.
const today = new Date().toLocaleDateString('sv-SE');
const API = {
  '/api/programs': [{ id: 3, name: 'Push Pull Legs', goal: 'hypertrophy', template_count: 3, duration_weeks: 6, is_active: 0 }],
  '/api/exercises': [
    { id: 1, name: 'Bench Press', primary_muscles: ['chest'], equipment: ['barbell'], source: 'builtin' },
    { id: 2, name: 'Squat', primary_muscles: ['quadriceps'], equipment: ['barbell'], source: 'builtin' },
    { id: 3, name: 'Pull Up', primary_muscles: ['lats'], equipment: ['body only'], source: 'builtin' },
  ],
  '/api/workout/recent': [{ id: 9, date: today, session_seq: 0, completed: true, exercises: [{ exercise_id: 1, exercise_name: 'Bench Press', sets: [{ weight: 80, reps: 5, completed: true }] }] }],
  '/api/stats/records': [{ name: 'Bench Press', maxWeight: 80, maxReps: 5, e1rm: 93, date: today }],
  '/api/body-stats/range': [],
  '/api/stats/volume': [],
  '/api/stats/frequency': [],
};

// Gemini's rule for functionResponse.response: a JSON object.
function refusal(contents) {
  for (const [c, content] of contents.entries()) {
    for (const [p, part] of content.parts.entries()) {
      const r = part.functionResponse?.response;
      if (!part.functionResponse) continue;
      const at = `contents[${c}].parts[${p}].function_response`;
      if (Array.isArray(r)) return `Invalid JSON payload received. Unknown name "response" at '${at}': Proto field is not repeating, cannot start list.`;
      if (r === null || typeof r !== 'object') return `Invalid value at '${at}.response' (type.googleapis.com/google.protobuf.Struct)`;
    }
  }
  return null;
}
let plan = [];
const sent = [];
const gemini = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw);
    sent.push(b);
    const wrong = refusal(b.contents);
    if (wrong) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: wrong, status: 'INVALID_ARGUMENT' } }));
    const round = b.contents.filter((c) => c.parts.some((p) => p.functionResponse)).length;
    const parts = plan[round] ? plan[round].map(([name, args]) => ({ functionCall: { name, args } })) : [{ text: 'Here is your plan.' }];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }));
  });
});
await new Promise((r) => gemini.listen(0, '127.0.0.1', r));
test.after(() => gemini.close());
const GEMINI = `http://127.0.0.1:${gemini.address().port}`;
const _fetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://generativelanguage.googleapis.com/')) return _fetch(GEMINI, opts);
  const path = u.split('?')[0];
  if (path.startsWith('/api/')) {
    const body = API[path] ?? (path.startsWith('/api/stats/') ? {} : null);
    return { ok: body != null, status: body != null ? 200 : 404, headers: new Headers(), json: async () => body ?? { error: 'Not found' } };
  }
  return _fetch(url, opts);
};

const ask = () => {
  forgetToolReads();
  sent.length = 0;
  return callAI({
    provider: 'gemini', apiKey: 'k', messages: [{ role: 'user', content: 'Create a training plan for me.' }],
    systemPrompt: 'You are Trace.', tools: TOOLS, onToolCall: (name, args) => runTool(name, args),
  });
};
const responses = () => sent.at(-1).contents.flatMap((c) => c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse));

test('the reported request: a list as the third answer of a round reaches Gemini in an object', async () => {
  // contents: [0] the question, [1] one call, [2] its answer, [3] three calls, [4] their answers.
  plan = [[['get_active_program', {}]], [['get_stats_overview', {}], ['get_body_stats', {}], ['get_exercises', { muscle: 'chest' }]]];
  assert.equal(await ask(), 'Here is your plan.');
  const [active, overview, body, exercises] = responses();
  assert.deepEqual(active.response, { active: false });
  assert.ok(overview.response.streak_current === 0 && Array.isArray(overview.response.weekly_volume), 'an object goes as it is');
  assert.deepEqual(body.response, { series: [] });
  assert.equal(exercises.name, 'get_exercises');
  assert.deepEqual(exercises.response.result.map((e) => e.name), ['Bench Press'], 'the list, under "result"');
});

test('every read tool that answers with a list: Gemini gets it in an object', async () => {
  plan = [[['get_programs', {}], ['get_workouts', {}], ['get_prs', {}], ['get_exercises', {}]]];
  assert.equal(await ask(), 'Here is your plan.');
  const got = Object.fromEntries(responses().map((r) => [r.name, r.response]));
  assert.deepEqual(got.get_programs.result.map((p) => p.name), ['Push Pull Legs']);
  assert.deepEqual(got.get_workouts.result.map((w) => w.id), [9]);
  assert.deepEqual(got.get_prs.result.map((r) => r.exercise_name), ['Bench Press']);
  assert.equal(got.get_exercises.result.length, 3);
});
