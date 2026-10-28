/**
 * Trace can go through more than a handful of lookups (TraceApps/notetrace#34).
 *
 * The report, from NoteTrace: "go through all my notes" ended in "Too many
 * tool call rounds". LiftTrace had the same 5 rounds, in the app and through
 * the server's /api/ai/chat. Now one answer has 12 rounds, and when they run
 * out a last request with the tools off answers from what was found and says
 * what's left, instead of an error.
 *
 * These run the real loops (src/lib/aiChat.js, and server/routes/ai.js on a
 * scratch database) against a stand-in for each provider.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── A stand-in provider ─────────────────────────────────────────────────
// Each provider asks for a tool until its request turns the tools off (or
// until `stopAfter` rounds), then answers. `rejectChoice`: an OpenAI-
// compatible server that refuses tool_choice with `rejectStatus`;
// `ignoreChoice`: one that ignores it and asks for a tool anyway, with no
// text; `perRound`: tool calls asked for in each round. Each call asks for
// another page, as a model going through a year does, unless a test plans
// the calls itself (`plan`, TraceApps/nutritrace#287).
let stopAfter = Infinity, rejectChoice = false, rejectStatus = 400, ignoreChoice = false, perRound = 1, argPad = '', plan = null;
const callOf = (n, i) => (plan ? plan(n, i) : { name: 'get_workouts', args: { page: n * perRound + i + 1, ...(argPad ? { pad: argPad } : {}) } });
const seen = [];
const toolRounds = (b, path) => (path.startsWith('/claude')
  ? (b.messages || []).filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')).length
  : path.startsWith('/gemini')
    ? (b.contents || []).filter((c) => c.parts?.some((p) => p.functionResponse)).length
    : new Set((b.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id).split('_')[0])).size);
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    seen.push({ path: req.url, body: b });
    // Gemini takes only a JSON object as a tool's answer (#147).
    const notObject = (r) => r === null || typeof r !== 'object' || Array.isArray(r);
    if (req.url.startsWith('/gemini') && (b.contents || []).some((c) => c.parts?.some((p) => p.functionResponse && notObject(p.functionResponse.response)))) {
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'functionResponse.response must be a JSON object.', status: 'INVALID_ARGUMENT' } }));
    }
    const n = toolRounds(b, req.url);
    const ids = Array.from({ length: perRound }, (_, i) => `r${n}_${i}`);
    let out;
    if (req.url.startsWith('/claude')) {
      out = b.tool_choice?.type === 'none' || n >= stopAfter
        ? { content: [{ type: 'text', text: `answer after ${n}` }], stop_reason: 'end_turn' }
        : { content: ids.map((id, i) => { const c = callOf(n, i); return { type: 'tool_use', id, name: c.name, input: c.args }; }), stop_reason: 'tool_use' };
    } else if (req.url.startsWith('/gemini')) {
      out = b.toolConfig?.functionCallingConfig?.mode === 'NONE' || n >= stopAfter
        ? { candidates: [{ content: { parts: [{ text: `answer after ${n}` }] }, finishReason: 'STOP' }] }
        : { candidates: [{ content: { parts: ids.map((_, i) => { const c = callOf(n, i); return { functionCall: { name: c.name, args: c.args } }; }) }, finishReason: 'STOP' }] };
    } else {
      if (rejectChoice && b.tool_choice) return res.writeHead(rejectStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "Unsupported value: 'tool_choice' none" } }));
      const answer = (b.tool_choice === 'none' && !ignoreChoice) || n >= stopAfter;
      out = { choices: [{ index: 0, finish_reason: answer ? 'stop' : 'tool_calls', message: answer
        ? { role: 'assistant', content: `answer after ${n}` }
        : { role: 'assistant', content: null, tool_calls: ids.map((id, i) => { const c = callOf(n, i); return { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }; }) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;

// The server half: the real /api/ai routes on a scratch database.
let db = null, dir = null, app = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'trace-scan-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  // An account, so the limit is per account (as on a server with users).
  db.prepare("INSERT INTO users (username, password_hash) VALUES ('scan', 'x')").run();
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use((r, _res, next) => { r.user = { id: Number(r.headers['x-user'] || 1), role: 'admin' }; next(); });
  a.use('/api/ai', aiRoutes);
  app = a.listen(0);
  base = `http://127.0.0.1:${app.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { endpoint.close(); app?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

let proxyUser = 1;
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com')) return _fetch(`${ENDPOINT}/claude`, opts);
  if (u.startsWith('https://generativelanguage.googleapis.com')) return _fetch(`${ENDPOINT}/gemini`, opts);
  if (u.startsWith('/api/ai/')) return _fetch(`${base}${u}`, { ...opts, headers: { ...(opts.headers || {}), 'x-user': String(proxyUser) } });
  return _fetch(url, opts);
};
const serverUses = (provider) => {
  db.prepare('DELETE FROM app_config WHERE key LIKE ?').run('ai_%');
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)');
  set.run('ai_provider', provider);
  set.run('ai_api_key', 'k');
  if (provider === 'oai-compat') { set.run('ai_base_url', ENDPOINT); set.run('ai_model', 'local'); }
  proxyUser++; // a fresh rate-limit bucket for each run
};

const client = await import('../src/lib/aiChat.js');
let calls = 0, toolResult = [];
const onToolCall = async () => { calls++; return toolResult; };
const TOOLS = [{ name: 'get_workouts', description: 'List workouts.', parameters: { type: 'object', properties: {} } }];
const fresh = (o = {}) => {
  seen.length = 0; calls = 0; stopAfter = o.stopAfter ?? Infinity; rejectChoice = !!o.rejectChoice;
  rejectStatus = o.rejectStatus ?? 400; ignoreChoice = !!o.ignoreChoice; perRound = o.perRound ?? 1; argPad = o.argPad ?? ''; toolResult = o.toolResult ?? []; plan = o.plan ?? null;
};
const question = (extra = {}) => [{ role: 'user', content: 'Go through every workout I logged this year.', ...extra }];
const ask = (provider, messages = question()) => client.callAI({
  provider, apiKey: 'k', model: provider === 'oai-compat' ? 'local' : undefined, baseUrl: provider === 'oai-compat' ? ENDPOINT : undefined,
  messages, systemPrompt: 'You are Trace.', tools: TOOLS, onToolCall,
});
const askProxy = (provider, messages = question()) => { serverUses(provider); return client.callAIProxy({ messages, systemPrompt: 'You are Trace.', tools: TOOLS, onToolCall }); };
const PROVIDERS = ['oai-compat', 'claude', 'gemini'];
const needsServer = (t) => { if (!db) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const systemOf = (s) => (s.path.startsWith('/claude') ? s.body.system : s.path.startsWith('/gemini') ? s.body.systemInstruction.parts[0].text : s.body.messages[0].content);
const toolsOff = (s) => (s.path.startsWith('/claude') ? s.body.tool_choice?.type === 'none'
  : s.path.startsWith('/gemini') ? s.body.toolConfig?.functionCallingConfig?.mode === 'NONE' : s.body.tool_choice === 'none');

test('12 rounds of tool calls: a question that needs 8 finishes, in the app and through the server', async (t) => {
  for (const provider of PROVIDERS) {
    fresh({ stopAfter: 8 });
    assert.equal(await ask(provider), 'answer after 8', provider);
    assert.equal(calls, 8);
  }
  assert.equal(client.TOOL_ROUNDS, 12);
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    fresh({ stopAfter: 8 });
    assert.equal(await askProxy(provider), 'answer after 8', `server ${provider}`);
    assert.equal(calls, 8);
  }
});

test('out of rounds, a last request with the tools off answers from what was found', async (t) => {
  const check = (label) => {
    assert.equal(calls, 12, `${label}: 12 rounds of tools`);
    assert.equal(seen.length, 13, label);
    const last = seen[12], before = seen[11];
    assert.ok(toolsOff(last), `${label}: the tools are off`);
    assert.ok(!toolsOff(before), `${label}: only on the last request`);
    assert.ok(last.body.tools?.length, `${label}: still declared, the history has tool calls in it`);
    assert.equal(systemOf(before), 'You are Trace.');
    assert.equal(systemOf(last), `You are Trace.\n\n${client.OUT_OF_ROUNDS}`, `${label}: told to answer in the system prompt`);
    // The conversation itself isn't changed: the last message is the tool results.
    if (last.path.startsWith('/claude')) assert.equal(last.body.messages.at(-1).content[0].type, 'tool_result');
    else if (last.path.startsWith('/gemini')) assert.ok(last.body.contents.at(-1).parts[0].functionResponse);
    else assert.equal(last.body.messages.at(-1).role, 'tool');
  };
  for (const provider of PROVIDERS) {
    fresh();
    assert.equal(await ask(provider), 'answer after 12', provider);
    check(provider);
  }
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    fresh();
    assert.equal(await askProxy(provider), 'answer after 12', `server ${provider}`);
    check(`server ${provider}`);
  }
});

test('a server that refuses tool_choice is asked once more without it; one that ignores it still gets an answer said', async (t) => {
  const run = async (go, failure) => {
    fresh({ rejectChoice: true, stopAfter: 99 });
    const r = await go('oai-compat');
    assert.equal(seen.length, 14);
    assert.equal(seen[12].body.tool_choice, 'none');
    assert.equal(seen[13].body.tool_choice, undefined);
    assert.ok(seen[13].body.messages[0].content.endsWith(client.OUT_OF_ROUNDS));
    // That server then asked for a tool again with no text: Trace says why there's no answer.
    assert.match(r, /more steps than one answer allows/);
    // 422 is a refusal too; any other failure is the error it always was.
    fresh({ rejectChoice: true, rejectStatus: 422, stopAfter: 99 });
    await go('oai-compat');
    assert.equal(seen.length, 14);
    fresh({ rejectChoice: true, rejectStatus: 503, stopAfter: 99 });
    await assert.rejects(go('oai-compat'), failure);
    assert.equal(seen.length, 13);
    fresh({ ignoreChoice: true });
    assert.match(await go('oai-compat'), /more steps than one answer allows/);
    assert.equal(calls, 12, 'and runs no 13th round of tools');
  };
  await run(ask, /Unsupported value/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.trace_reply.out_of_rounds, /more steps than one answer allows/);
  if (needsServer(t)) return;
  // The server answers a provider's failure with its own error, as it always has.
  await run(askProxy, /AI proxy error 500/);
});

test('a conversation that gets too big wraps up early the same way; a photo the user attached does not count', async (t) => {
  assert.equal(client.HISTORY_MAX_BYTES, 300000);
  const big = () => fresh({ toolResult: [{ notes: 'x'.repeat(200000) }] });
  for (const provider of PROVIDERS) {
    // Each tool answer is 200 kB: after two, the next request is the last.
    big();
    assert.equal(await ask(provider), 'answer after 2', provider);
    assert.equal(calls, 2, provider);
    assert.ok(toolsOff(seen[2]) && !toolsOff(seen[1]), provider);
  }
  // A photo is already in the question, and isn't what the tools added.
  const photo = question();
  photo[0].content = [{ type: 'text', text: 'Log the workout on this whiteboard.' }, { type: 'image', dataUrl: `data:image/jpeg;base64,${'A'.repeat(2_000_000)}` }];
  for (const provider of PROVIDERS) {
    fresh({ stopAfter: 4 });
    assert.equal(await ask(provider, photo), 'answer after 4', `${provider} with a photo`);
    assert.ok(Buffer.byteLength(JSON.stringify(seen[0].body)) > 2_000_000, 'the photo went with the question');
  }
  if (needsServer(t)) return;
  big();
  assert.equal(await askProxy('claude'), 'answer after 2', 'server');
  assert.equal(calls, 2);
});

test('through the server, a long answer stays within what the server takes', async (t) => {
  if (needsServer(t)) return;
  // 20 messages of history and 4 tool calls a round: 5 messages a round.
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `earlier ${i}` }));
  history.push(...question());
  fresh({ perRound: 4 });
  const r = await askProxy('oai-compat', history);
  assert.match(r, /^answer after \d+$/, 'an answer, not "Too many messages"');
  const most = Math.max(...seen.map((s) => s.body.messages.length - 1));
  assert.ok(most <= 60, `at most 60 messages to a server from before (${most})`);
  // 13 requests an answer: four long answers in a minute fit (30 a minute held two).
  fresh();
  serverUses('oai-compat');
  const opts = { messages: question(), systemPrompt: 'You are Trace.', tools: TOOLS, onToolCall };
  for (let i = 0; i < 4; i++) assert.equal(await client.callAIProxy(opts), 'answer after 12');
  assert.equal(seen.length, 52);
});

// Every tool call in a request has its answer, and the other way round.
const paired = (s) => {
  if (s.path.startsWith('/claude')) {
    const asked = s.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use').map((c) => c.id) : []));
    const answered = s.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id) : []));
    return JSON.stringify(asked.sort()) === JSON.stringify(answered.sort());
  }
  if (s.path.startsWith('/gemini')) {
    const asked = s.body.contents.flatMap((c) => c.parts.filter((p) => p.functionCall)).length;
    const answered = s.body.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse)).length;
    return asked === answered;
  }
  const asked = s.body.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id));
  const answered = s.body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  return JSON.stringify(asked.sort()) === JSON.stringify(answered.sort());
};

test('through the server, a round of many tool calls runs only as many as the server takes messages', async (t) => {
  if (needsServer(t)) return;
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `earlier ${i}` }));
  history.push(...question());
  // 21 messages, then 40 calls: 38 fit, and the last request names the 2 left out.
  // 13 or 3 a round all fit before Trace wraps up past 48: none are named.
  for (const perRound of [3, 13, 40]) {
    for (const provider of PROVIDERS) {
      fresh({ perRound });
      const r = await askProxy(provider, history);
      assert.match(r, /^answer after \d+$/, `${provider}, ${perRound} a round: an answer, not "Too many messages"`);
      for (const s of seen) {
        const count = s.path.startsWith('/gemini') ? s.body.contents.length : s.path.startsWith('/claude') ? null : s.body.messages.length - 1;
        if (count != null) assert.ok(count <= 60, `${provider}: ${count} messages`);
        assert.ok(paired(s), `${provider}, ${perRound} a round: every call has its answer`);
      }
      const said = systemOf(seen.at(-1));
      if (perRound === 40) assert.ok(said.endsWith(`\n\n${client.TOOLS_DROPPED} get_workouts, get_workouts.`), `${provider}: the last request names the calls left out: ${said.slice(-120)}`);
      else assert.ok(!said.includes(client.TOOLS_DROPPED), `${provider}, ${perRound} a round: nothing was left out`);
    }
  }
});

test('one round of calls that would pass the size limit runs until it does, and answers the rest "not run"', async (t) => {
  // Four calls a round, each answer 300 kB: the first runs, the rest are not run.
  const check = (label) => {
    assert.equal(calls, 1, `${label}: only the first call ran`);
    assert.equal(seen.length, 2, `${label}: the next request is the last`);
    const last = seen[1];
    assert.ok(toolsOff(last), `${label}: with the tools off`);
    assert.ok(paired(last), `${label}: every call has its answer`);
    assert.equal(JSON.stringify(last.body).split(client.TOOL_SKIPPED).length - 1, 3, `${label}: three answered "not run"`);
    assert.ok(Buffer.byteLength(JSON.stringify(last.body)) < 1_000_000, `${label}: under the server's 1 MB`);
  };
  for (const provider of PROVIDERS) {
    fresh({ perRound: 4, toolResult: [{ notes: 'x'.repeat(300000) }] });
    assert.equal(await ask(provider), 'answer after 1', provider);
    check(provider);
  }
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    fresh({ perRound: 4, toolResult: [{ notes: 'x'.repeat(300000) }] });
    assert.equal(await askProxy(provider), 'answer after 1', `server ${provider}`);
    check(`server ${provider}`);
  }
});

test('the size counted is the size sent: text full of quotes counts twice over', async (t) => {
  // 130,000 quotes: 260 kB as a result, about 520 kB as it goes in a request
  // (a JSON string inside the request). Counted as sent, one runs; counted
  // as a result, two would, and the request would pass the server's 1 MB.
  // (Gemini takes a result as an object, so its requests are the smaller size.)
  const quotes = () => fresh({ perRound: 4, toolResult: [{ notes: '"'.repeat(130000) }] });
  const check = (label) => {
    const skipped = (s) => JSON.stringify(s.body).split(client.TOOL_SKIPPED).length - 1;
    assert.equal(skipped(seen[1]), 3, `${label}: one of the first round's four ran`);
    for (const s of seen) assert.ok(Buffer.byteLength(JSON.stringify(s.body)) < 1_000_000, `${label}: every request under 1 MB`);
  };
  for (const provider of PROVIDERS) {
    quotes();
    assert.match(await ask(provider), /^answer after \d$/, provider);
    check(provider);
  }
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    quotes();
    assert.match(await askProxy(provider), /^answer after \d$/, `server ${provider}: an answer, not "AI proxy error 413"`);
    check(`server ${provider}`);
  }
});

test('calls whose own arguments are big all run: only what the tools answer counts', async (t) => {
  // Four calls of 100 kB of arguments each (a big workout to log), small answers.
  const check = (label) => {
    assert.equal(calls, 4, `${label}: all four ran`);
    for (const s of seen) assert.ok(!JSON.stringify(s.body).includes(client.TOOL_SKIPPED), `${label}: none skipped`);
  };
  for (const provider of PROVIDERS) {
    fresh({ perRound: 4, argPad: 'w'.repeat(100000), stopAfter: 1 });
    assert.equal(await ask(provider), 'answer after 1', provider);
    check(provider);
  }
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    fresh({ perRound: 4, argPad: 'w'.repeat(100000), stopAfter: 1 });
    assert.equal(await askProxy(provider), 'answer after 1', `server ${provider}`);
    check(`server ${provider}`);
  }
});

test('a tool that answers with a list reaches Gemini in an object, in the app and through the server (#147)', async (t) => {
  const list = [{ id: 1, name: 'Bench Press' }, { id: 2, name: 'Squat' }];
  const answers = () => seen.at(-1).body.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse)).map((p) => p.functionResponse.response);
  fresh({ perRound: 3, stopAfter: 1, toolResult: list });
  assert.equal(await ask('gemini'), 'answer after 1');
  assert.deepEqual(answers(), [{ result: list }, { result: list }, { result: list }]);
  if (needsServer(t)) return;
  fresh({ perRound: 3, stopAfter: 1, toolResult: list });
  assert.equal(await askProxy('gemini'), 'answer after 1', 'server gemini');
  assert.deepEqual(answers(), [{ result: list }, { result: list }, { result: list }]);
  // An object, a failed tool's { error } too, goes as it is.
  fresh({ perRound: 2, stopAfter: 1, toolResult: { error: 'Workout 9 not found' } });
  assert.equal(await askProxy('gemini'), 'answer after 1');
  assert.deepEqual(answers(), [{ error: 'Workout 9 not found' }, { error: 'Workout 9 not found' }]);
});

// ── The same tool call again (TraceApps/nutritrace#287) ─────────────────
// The report (NutriTrace): requests a second apart, the same tool call each
// time, then nothing. Now the same call a second time isn't run again, and a
// third time the next request is the last, saying which tool it got stuck on.
const reply = await import('../src/lib/trace-reply.js');
// The same call every time, its arguments' keys in another order every other round.
const sameCall = (name = 'get_workouts') => (n) => ({ name, args: n % 2 ? { exercise: 'Squat', date_from: '2026-01-01' } : { date_from: '2026-01-01', exercise: 'Squat' } });
const repeated = (s) => (reply.TOOL_REPEATED ? JSON.stringify(s.body).split(reply.TOOL_REPEATED).length - 1 : 0);

test('#287: the same call a second time isn\'t run again: the model hears it has that answer already', async () => {
  for (const provider of PROVIDERS) {
    fresh({ plan: sameCall(), stopAfter: 2 });
    assert.equal(await ask(provider), 'answer after 2', provider);
    assert.equal(calls, 1, `${provider}: the tool ran once`);
    assert.equal(seen.length, 3, provider);
    assert.equal(repeated(seen[2]), 1, `${provider}: the second call has its answer`);
    assert.ok(!toolsOff(seen[2]), provider);
  }
  assert.equal(reply.toolCallKey?.('get_prs', { a: 1, b: { d: 2, c: [3, { f: 4, e: 5 }] } }), reply.toolCallKey?.('get_prs', '{"b":{"c":[3,{"e":5,"f":4}],"d":2},"a":1}'));
  assert.notEqual(reply.toolCallKey?.('get_prs', { exercise: 'Squat' }), reply.toolCallKey?.('get_prs', { exercise: 'Bench' }));
});

test('#287: a third time, the next request is the last, with the tools off, and it names the tool', async () => {
  for (const provider of PROVIDERS) {
    fresh({ plan: sameCall() });
    assert.equal(await ask(provider), 'answer after 3', provider);
    assert.equal(calls, 1, provider);
    assert.equal(seen.length, 4, `${provider}: 4 requests, not 13`);
    assert.ok(toolsOff(seen[3]) && !toolsOff(seen[2]), provider);
    assert.ok(reply.toolStuckNote && systemOf(seen[3]) === `You are Trace.\n\n${client.OUT_OF_ROUNDS}\n\n${reply.toolStuckNote('get_workouts')}`, provider);
    assert.match(systemOf(seen[3]), /stuck repeating get_workouts/);
    // Three of the same in one round: each has an answer, and the next request is the last.
    fresh({ perRound: 3, plan: () => ({ name: 'get_workouts', args: {} }) });
    await ask(provider);
    assert.deepEqual([calls, seen.length, repeated(seen[1])], [1, 2, 2], provider);
    assert.ok(toolsOff(seen[1]), provider);
  }
  fresh({ plan: sameCall(), ignoreChoice: true });
  assert.match(await ask('oai-compat'), /kept asking for the same information/);
  assert.match(JSON.parse(read('../src/i18n/en.json')).trace_reply.stuck_on_tool ?? '', /^Trace kept asking for the same information/);
});

test('#287: different arguments, or another call in the same round, still run', async () => {
  for (const provider of PROVIDERS) {
    fresh({ perRound: 3, stopAfter: 1, plan: (n, i) => ({ name: 'get_prs', args: { exercise: i < 2 ? 'Squat' : 'Bench' } }) });
    assert.match(await ask(provider), /^answer after/);
    assert.equal(calls, 2, provider);
    assert.equal(repeated(seen[1]), 1, provider);
    fresh({ stopAfter: 10 });
    assert.equal(await ask(provider), 'answer after 10');
    assert.equal(calls, 10, provider);
    assert.ok(seen.every((s) => repeated(s) === 0), provider);
  }
});

test('#287: a tool that writes runs every time it is asked, and is never said to have run when it didn\'t', async () => {
  // Every tool that doesn't start with get_ logs or changes something
  // (aiTools.js runs them that way too): none of them is counted.
  const names = [...read('../src/lib/aiTools.js').matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((m) => m[1]);
  assert.ok(names.includes('log_set') && names.includes('get_prs'));
  assert.ok(client.READ_TOOLS instanceof Set, 'READ_TOOLS');
  for (const name of names) assert.equal(client.READ_TOOLS.has(name), name.startsWith('get_'), name);
  for (const name of client.READ_TOOLS) assert.ok(names.includes(name), `${name} is a tool`);
  // The writes are among the tools offered: a made-up name is counted (below).
  TOOLS.push({ name: 'log_set', description: 'Log a set.', parameters: { type: 'object', properties: {} } }, { name: 'get_workout', description: 'A workout.', parameters: { type: 'object', properties: {} } });
  const set = { name: 'log_set', args: { exercise: 'Squat', weight: 100, reps: 5 } };
  for (const provider of PROVIDERS) {
    // The same set three rounds running: logged three times, as asked.
    fresh({ stopAfter: 3, plan: () => set });
    assert.equal(await ask(provider), 'answer after 3');
    assert.equal(calls, 3, provider);
    fresh({ perRound: 2, stopAfter: 1, plan: () => set });
    await ask(provider);
    assert.equal(calls, 2, provider);
    // A workout read again after a write reads it again: it has changed.
    fresh({ stopAfter: 3, plan: (n) => (n === 1 ? set : { name: 'get_workout', args: { id: 7 } }) });
    await ask(provider);
    assert.equal(calls, 3, provider);
    assert.ok(seen.every((s) => repeated(s) === 0 && !systemOf(s).includes('stuck')), provider);
  }
});

test('#287 through the server: the same call is counted once, by the app, and the last request names the tool', async (t) => {
  if (needsServer(t)) return;
  for (const provider of PROVIDERS) {
    fresh({ plan: sameCall(), stopAfter: 2 });
    assert.equal(await askProxy(provider), 'answer after 2', provider);
    assert.deepEqual([calls, seen.length, repeated(seen[2])], [1, 3, 1], provider);
    fresh({ plan: sameCall() });
    assert.equal(await askProxy(provider), 'answer after 3', provider);
    assert.deepEqual([calls, seen.length], [1, 4], provider);
    assert.ok(toolsOff(seen[3]) && !toolsOff(seen[2]), provider);
    assert.match(systemOf(seen[3]), /stuck repeating get_workouts/, provider);
    fresh({ stopAfter: 3, plan: () => ({ name: 'log_set', args: { exercise: 'Squat', reps: 5 } }) });
    assert.equal(await askProxy(provider), 'answer after 3', provider);
    assert.equal(calls, 3, provider);
  }
  fresh({ plan: sameCall(), ignoreChoice: true });
  assert.match(await askProxy('oai-compat'), /kept asking for the same information/);
});

test('#287: a made-up tool asked for again is counted too, and a lookup that failed may be tried once more', async () => {
  for (const provider of PROVIDERS) {
    // A tool the app doesn't have: nothing ran, nothing changed.
    fresh({ plan: sameCall('get_workouts_entries') });
    assert.equal(await ask(provider), 'answer after 3', provider);
    assert.deepEqual([calls, seen.length], [1, 4], provider);
    assert.match(systemOf(seen[3]), /stuck repeating get_workouts_entries/, provider);
    // Offline the first time: asked again, it runs again; failing again, it counts.
    fresh({ plan: sameCall(), toolResult: { error: 'Offline' } });
    assert.equal(await ask(provider), 'answer after 4', provider);
    assert.deepEqual([calls, seen.length], [2, 5], provider);
    assert.equal(repeated(seen[3]), 1, provider);
  }
});
