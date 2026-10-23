/**
 * Trace with an OpenAI-compatible provider (found with TraceApps/notetrace#18;
 * NoteTrace, CookTrace and NutriTrace have the same tests).
 *
 * - A Base URL given with /v1 (as OpenAI's own SDKs take it), or as the whole
 *   /v1/chat/completions endpoint, was used as given and /v1 was added again.
 * - OpenAI Compatible with no key (Ollama, LM Studio): chat worked, but
 *   Settings never tested it, so its status stayed blank.
 * - Test lived only in the status banner, blank until everything was in.
 * - A provider the browser couldn't read said only "Failed to fetch".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openAIBase as clientBase, getOpenAIChatParams } from '../src/lib/openai-chat-params.js';
import { openAIBase as serverBase } from '../server/lib/openai-chat-params.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

for (const [name, base] of [['client', clientBase], ['server', serverBase]]) {
  test(`${name}: the Base URL works with or without /v1`, () => {
    const cases = {
      'https://ai.example.com': 'https://ai.example.com',
      'https://ai.example.com/': 'https://ai.example.com',
      'https://ai.example.com/v1': 'https://ai.example.com',
      'https://ai.example.com/v1/': 'https://ai.example.com',
      'https://ai.example.com/V1': 'https://ai.example.com',
      'https://ai.example.com/v1/chat/completions': 'https://ai.example.com',
      '  https://ai.example.com/v1  ': 'https://ai.example.com',
      'http://localhost:11434': 'http://localhost:11434',
      'https://api.groq.com/openai/v1': 'https://api.groq.com/openai',
      'https://openrouter.ai/api/v1': 'https://openrouter.ai/api',
      'https://ai.example.com/v10': 'https://ai.example.com/v10',
      'https://ai.example.com/apiv1': 'https://ai.example.com/apiv1',
      '': '',
    };
    for (const [given, want] of Object.entries(cases)) assert.equal(base(given), want, given);
    assert.equal(base(undefined), '');
  });
}

test('OpenAI given as https://api.openai.com/v1 gets OpenAI\'s own parameters', () => {
  assert.deepEqual(
    getOpenAIChatParams({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', hasTools: false }),
    { stream: false, max_completion_tokens: 4096 },
  );
});

test('every place that adds /v1 to a Base URL takes it through openAIBase', () => {
  const chat = read('../src/lib/aiChat.js');
  assert.match(chat, /const base = openAIBase\(baseUrl\);/);
  assert.doesNotMatch(chat, /baseUrl\.replace\(\/\\\/\+\$\/, ''\)/);
  const server = read('../server/routes/ai.js');
  assert.match(server, /const baseUrl {2}= openAIBase\(cfg\.ai_base_url\);/);
  assert.doesNotMatch(server, /cfg\.ai_base_url[,;]/);
});

test('a provider the browser can\'t read says what to check, not "Failed to fetch"', async () => {
  const { addMessages, init, waitLocale } = await import('svelte-i18n');
  addMessages('en', JSON.parse(read('../src/i18n/en.json')));
  init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale('en');
  const { fetchProvider } = await import('../src/lib/aiChat.js');
  const real = globalThis.fetch;
  const hadLocation = 'location' in globalThis;
  const fail = (msg) => async () => { throw new TypeError(msg); };
  const message = async (url) => {
    try { await fetchProvider(url, {}); } catch (e) { return e; }
    throw new Error('did not throw');
  };
  try {
    globalThis.location = { protocol: 'https:', origin: 'https://lift.example.com' };
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      globalThis.fetch = fail(m);
      const e = await message('https://ai.example.com/v1/chat/completions');
      assert.match(e.message, /ai\.example\.com/, m);
      assert.match(e.message, /https:\/\/lift\.example\.com/);
      assert.match(e.message, /always/);
      assert.doesNotMatch(e.message, /Failed to fetch|NetworkError|Load failed/);
      assert.equal(e.cause?.message, m);
      assert.equal(e.offline, false);
    }
    globalThis.fetch = fail('Failed to fetch');
    assert.match((await message('http://ollama.lan:11434/v1/chat/completions')).message, /HTTPS[\s\S]*https:\/\//);
    assert.doesNotMatch((await message('http://localhost:11434/v1/chat/completions')).message, /plain HTTP/);
    globalThis.Capacitor = { isNativePlatform: () => true };
    try { assert.doesNotMatch((await message('http://ollama.lan:11434/v1/chat/completions')).message, /plain HTTP/); }
    finally { delete globalThis.Capacitor; }
    assert.match((await message('https://api.openai.com/v1/chat/completions')).message, /connection/);
    assert.match((await message('localhost:11434/v1/chat/completions')).message, /localhost:11434/);
    const header = new TypeError("Failed to execute 'fetch' on 'Window': Invalid value");
    globalThis.fetch = async () => { throw header; };
    assert.equal(await message('https://ai.example.com/x'), header);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = async () => { throw abort; };
    assert.equal(await message('https://ai.example.com/x'), abort);
    const res = { ok: false, status: 404 };
    globalThis.fetch = async () => res;
    assert.equal(await fetchProvider('https://ai.example.com/x', {}), res);
  } finally {
    globalThis.fetch = real;
    if (!hadLocation) delete globalThis.location;
  }
});

test('direct provider requests go through fetchProvider', () => {
  const chat = read('../src/lib/aiChat.js');
  for (const call of ["fetchProvider('https://api.anthropic.com/v1/messages'", 'fetchProvider(`${baseUrl}/v1/chat/completions`', 'const res = await fetchProvider(url, {']) {
    assert.ok(chat.includes(call), call);
  }
  const rest = chat.replace(/export async function fetchProvider[\s\S]*?\n\}\n/, '');
  for (const m of rest.matchAll(/await fetch\(([^,]+),/g)) assert.match(m[1], /^apiUrl\(/, m[0]);
});

test('Settings: no key needed for OpenAI Compatible, the last field tests, Test is always there', () => {
  const s = read('../src/components/settings/SettingsTrace.svelte');
  assert.doesNotMatch(s, /\$: canTest/);
  assert.match(s, /\$aiProvider === 'oai-compat'\s*\? !!aiBaseUrlVal\?\.trim\(\) && !!\$aiModel\?\.trim\(\)\s*: !!aiKeyVal\?\.trim\(\)\)/);
  assert.match(s, /\(\$aiProvider === 'oai-compat' \? !!\$aiBaseUrl\?\.trim\(\) : !!\$aiApiKey\?\.trim\(\)\)/, 'the status line too');
  assert.match(s, /async function _autoTest\(\) \{\s*if \(!_canTest\(\)\) return;[\s\S]{0,200}await testConnection\(\{ quietFail: keyMayFollow \}\)/);
  assert.equal((s.match(/if \(stale\(\)\) return;/g) || []).length, 2);
  // A stale result just goes: no test of its own (a provider switch would
  // send the old key to the new provider; a model being typed would test
  // half a name).
  const staleFn = s.match(/const stale = \(\) => \{[\s\S]*?\n {4}\};/)[0];
  assert.doesNotMatch(staleFn, /_testAgain/);
  assert.match(s, /if \(!quietFail\) showError/);
  assert.match(s, /settings_trace\.labels\.test_connection'\)[\s\S]{0,400}on:click=\{\(\) => testConnection\(\)\} disabled=\{testing\}/);
  assert.doesNotMatch(s, /onRetest=/);
  for (const m of s.matchAll(/on:input=\{[^}]*\}/g)) assert.doesNotMatch(m[0], /_autoTest|testConnection/);
  const providerChange = s.slice(s.indexOf('function _onProviderChange'), s.indexOf('function', s.indexOf('function _onProviderChange') + 10));
  assert.doesNotMatch(providerChange, /_autoTest|testConnection\(/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['test_connection', 'test_connection_desc', 'test_connection_desc_locked', 'test', 'testing']) assert.ok(en.settings_trace.labels[k], k);
  for (const k of ['fill_required', 'fill_required_custom']) assert.ok(en.settings_trace.toast[k], k);
  for (const k of ['unreachable', 'unreachable_insecure', 'unreachable_official']) assert.match(en.trace_ai[k], /\{host\}/, k);
});
