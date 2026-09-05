#!/usr/bin/env node
/**
 * scripts/mcp-smoke.mjs — end-to-end MCP smoke test.
 *
 * Usage:
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN>
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes --destroy
 *
 * Reads-only mode:  token must hold `mcp:read` (default).
 * Writes mode:      add `--writes`; token must ALSO hold `mcp:write`
 *                   and MCP_WRITE_ENABLED=1 on the server. Tests
 *                   log_set against a real exercise_id looked up from
 *                   this instance's own catalog via search_exercises,
 *                   and log_body_stat (both additive, both undoable in
 *                   the UI — log_set adds a set to today's workout,
 *                   log_body_stat merges into today's stats).
 * Destroy mode:     add `--destroy`; token must ALSO hold `mcp:destroy`
 *                   and MCP_DESTROY_ENABLED=1. Tests confirm=false
 *                   rejection only, so no real data is mutated by the
 *                   smoke script itself.
 *
 * Prints one line per check with PASS / FAIL. Exits non-zero if any
 * check failed. Negative-path checks (401 / 403) are required — if they
 * pass, auth or origin gating is broken.
 */

const argv = process.argv.slice(2);
const WRITE_MODE   = argv.includes('--writes');
const DESTROY_MODE = argv.includes('--destroy');
const positional = argv.filter(a => !a.startsWith('--'));
const [BASE, TOKEN] = positional;
if (!BASE || !TOKEN) {
  console.error('usage: node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> [--writes] [--destroy]');
  process.exit(2);
}

const URL_ = BASE.replace(/\/+$/, '') + '/api/mcp';
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let pass = 0;
let fail = 0;
let id = 0;

function line(status, label, detail = '') {
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
            : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
            : '\x1b[33mSKIP\x1b[0m';
  console.log(`  ${tag}  ${label}${detail ? '  ' + detail : ''}`);
  if (status === 'PASS') pass++;
  else if (status === 'FAIL') fail++;
}

async function mcp(method, params) {
  const body = { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) };
  const r = await fetch(URL_, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  // Streamable HTTP replies can be application/json OR text/event-stream.
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // Take the last `data:` frame; SDK typically emits one for stateless.
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    const last = lines[lines.length - 1] || '';
    try { json = JSON.parse(last.slice(5).trim()); } catch { /* keep null */ }
  } else {
    try { json = JSON.parse(text); } catch { /* keep null */ }
  }
  return { status: r.status, json, raw: text };
}

async function callTool(name, args = {}) {
  return mcp('tools/call', { name, arguments: args });
}

console.log(`\n\x1b[1mMCP smoke test\x1b[0m  ${URL_}\n`);

// --- Handshake ---
{
  const r = await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lt-smoke', version: '1' },
  });
  const info = r.json?.result?.serverInfo;
  if (r.status === 200 && info?.name === 'lifttrace') {
    line('PASS', `initialize`, `serverInfo=${info.name}@${info.version}`);
  } else {
    line('FAIL', `initialize`, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

// --- tools/list ---
const READ_TOOLS = [
  'get_workout',
  'list_recent_workouts',
  'get_records',
  'get_exercise_progress',
  'search_exercises',
  'list_programs',
  'get_active_program',
  'get_body_stat',
];
const WRITE_TOOLS = ['log_set', 'log_body_stat'];
const DESTROY_TOOLS = ['delete_workout'];
const expected = new Set([
  ...READ_TOOLS,
  ...(WRITE_MODE   ? WRITE_TOOLS   : []),
  ...(DESTROY_MODE ? DESTROY_TOOLS : []),
]);
{
  const r = await mcp('tools/list');
  const tools = r.json?.result?.tools || [];
  const names = new Set(tools.map(t => t.name));
  const missing = [...expected].filter(n => !names.has(n));
  const leaked = [];
  if (!WRITE_MODE)   leaked.push(...WRITE_TOOLS.filter(n => names.has(n)));
  if (!DESTROY_MODE) leaked.push(...DESTROY_TOOLS.filter(n => names.has(n)));
  if (r.status === 200 && missing.length === 0 && leaked.length === 0) {
    line('PASS', `tools/list`, `${tools.length} tools`);
  } else {
    const notes = [];
    if (missing.length) notes.push(`missing=[${missing.join(',')}]`);
    if (leaked.length)  notes.push(`gated tools leaked: [${leaked.join(',')}]`);
    line('FAIL', `tools/list`, `status=${r.status} ${notes.join(' ')}`);
  }
}

// --- Each read tool ---
// Zero-arg tools must return structuredContent cleanly. Tools whose
// output legitimately depends on this instance's own data (an exercise
// existing in the catalog, a workout logged today) accept either a
// clean structuredContent OR a clean isError — both mean "the tool ran
// correctly", since a fresh/empty install has no PRs, no active
// program, etc. yet.
async function checkTool(name, args, resultKey, note) {
  const r = await callTool(name, args);
  const sc = r.json?.result?.structuredContent;
  if (r.status === 200 && sc && (resultKey ? resultKey in sc : true)) {
    const preview = resultKey ? JSON.stringify(sc[resultKey]).slice(0, 80) : '';
    line('PASS', name, note ? `${note} ${preview}` : preview);
  } else if (r.status === 200 && r.json?.result?.isError) {
    line('FAIL', name, `tool returned isError: ${r.json.result.content?.[0]?.text}`);
  } else {
    line('FAIL', name, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}
// Same as checkTool but accepts a clean isError as a pass too — for
// tools whose success genuinely depends on data this instance may not
// have (a matching exercise name, an active program).
async function checkToolOrCleanError(name, args, resultKey, note) {
  const r = await callTool(name, args);
  const sc = r.json?.result?.structuredContent;
  const isErr = r.json?.result?.isError;
  if (r.status === 200 && sc && (resultKey ? resultKey in sc : true)) {
    const preview = resultKey ? JSON.stringify(sc[resultKey]).slice(0, 80) : '';
    line('PASS', name, note ? `${note} ${preview}` : preview);
  } else if (r.status === 200 && isErr) {
    line('PASS', name, `(no matching data on this instance — clean isError)`);
  } else {
    line('FAIL', name, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

await checkTool('get_workout',           {},                          'date',    '(today)');
await checkTool('list_recent_workouts',  { limit: 3 },                'workouts');
await checkTool('get_records',           {},                          'records');
await checkToolOrCleanError('get_exercise_progress', { exercise_name: 'Bench Press' }, 'progress', '(Bench Press)');
await checkTool('search_exercises',      { query: 'press', limit: 3 }, 'exercises', '(q=press)');
await checkTool('list_programs',         {},                          'programs');
await checkTool('get_active_program',    {},                          'active');
await checkTool('get_body_stat',         {},                          'date',    '(today)');

// --- Write tools (opt-in with --writes) ---
let _writeExerciseId = null;
if (WRITE_MODE) {
  // Bootstrap a real exercise_id from this instance's own catalog so
  // log_set exercises the real merge path, not a hardcoded guess.
  const search = await callTool('search_exercises', { query: 'press', limit: 1 });
  _writeExerciseId = search.json?.result?.structuredContent?.exercises?.[0]?.exercise_id;
  if (!_writeExerciseId) {
    const fallback = await callTool('search_exercises', { query: 'a', limit: 1 });
    _writeExerciseId = fallback.json?.result?.structuredContent?.exercises?.[0]?.exercise_id;
  }
  if (_writeExerciseId) {
    await checkTool('log_set', { exercise_id: _writeExerciseId, reps: 1, weight: 1 }, 'ok', `(exercise_id=${_writeExerciseId})`);
  } else {
    line('SKIP', 'log_set', 'no exercise found in this instance\'s catalog to log against');
  }
  await checkTool('log_body_stat', { weight: 75.0 }, 'ok', '(weight=75)');
}

// --- Destructive tools (opt-in with --destroy) ---
// Confirm-refusal path only — no real data is mutated by the smoke
// script itself, since the confirm check runs before any DB query.
if (DESTROY_MODE) {
  const r = await callTool('delete_workout', { date: '1999-01-01', confirm: false });
  const err = r.json?.result?.isError;
  const msg = r.json?.result?.content?.[0]?.text || '';
  if (err && /confirm/i.test(msg)) line('PASS', 'delete_workout (no confirm → refused)');
  else                             line('FAIL', 'delete_workout (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
}

// --- Negative: no bearer → 401 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
  });
  if (r.status === 401) line('PASS', 'no-bearer → 401');
  else                  line('FAIL', 'no-bearer → 401', `got ${r.status}`);
}

// --- Negative: disallowed origin → 403 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { ...HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 998, method: 'tools/list' }),
  });
  if (r.status === 403) line('PASS', 'bad-origin → 403');
  else                  line('FAIL', 'bad-origin → 403', `got ${r.status}`);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
