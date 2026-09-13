/**
 * Keeps Trace's tool surface honest.
 *
 * Trace is a fourth caller alongside the app routes, the MCP tools and the
 * REST API, but it keeps its own tool list rather than importing the xCore
 * functions, so a feature can ship to the other three and silently miss it.
 * That is exactly what happened with progress photos. These guard the two
 * ways that drift shows up: a tool defined but never dispatched, and a tool
 * dispatched but never named in the system prompt (weaker models rely on
 * the prompt enumeration, not just the schema).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const aiTools = read('../src/lib/aiTools.js');
const trace = read('../src/components/ai/Trace.svelte');

const defined = [...aiTools.matchAll(/^\s{4}name: '(\w+)',$/gm)].map((m) => m[1]);

test('every defined tool is dispatched by runTool', () => {
  assert.ok(defined.length > 10, `expected a real tool list, found ${defined.length}`);
  for (const name of defined) {
    assert.match(aiTools, new RegExp(`case '${name}':`), `${name} is defined but never dispatched`);
  }
});

test('every defined tool is named in the system prompt', () => {
  // The prompt lists tools explicitly because mini-class models skip
  // schema-only tools; a tool missing here is effectively invisible.
  const prompt = trace.slice(trace.indexOf('You are ${botName}'), trace.indexOf('const apiMessages'));
  for (const name of defined) {
    assert.ok(prompt.includes(name), `${name} is not listed in the system prompt`);
  }
});

test('Trace can read progress photo metadata', () => {
  assert.ok(defined.includes('get_progress_photos'));
  assert.match(aiTools, /\/api\/body-stats\/photos\?start=/);
});

test('Trace is never handed progress photo image content', () => {
  // The bytes sit behind an ownership-checked route on purpose. Sending a
  // user's body photos to whichever third-party model is configured is not
  // something a convenience tool should do as a side effect; attaching an
  // image to a message stays an explicit, per-message act by the user.
  const fn = aiTools.slice(aiTools.indexOf('async function _getProgressPhotos'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.doesNotMatch(body, /\/file/, 'must not fetch the image bytes');
  assert.doesNotMatch(body, /dataUrl|base64|blob/i, 'must not embed image content');
  assert.match(body, /note:/, 'should tell the model it cannot see the images');
});
