import assert from 'node:assert/strict';
import test from 'node:test';

import { safeJson, todayLocal, daysAgoLocal, toolError, toolResult, validateDate, DATE_RE } from '../server/lib/mcp/_util.js';

test('safeJson parses valid JSON', () => {
  assert.deepEqual(safeJson('{"a":1}', {}), { a: 1 });
});

test('safeJson returns fallback on invalid JSON', () => {
  assert.deepEqual(safeJson('not json', { x: 1 }), { x: 1 });
});

test('safeJson returns fallback on JSON null (not bare null)', () => {
  assert.deepEqual(safeJson('null', { x: 1 }), { x: 1 });
});

test('safeJson passes through falsy-but-real values unchanged', () => {
  assert.equal(safeJson('false', 'fallback'), false);
  assert.equal(safeJson('0', 'fallback'), 0);
  assert.equal(safeJson('""', 'fallback'), '');
});

test('todayLocal returns YYYY-MM-DD matching DATE_RE', () => {
  assert.match(todayLocal(), DATE_RE);
});

test('daysAgoLocal(0) equals todayLocal()', () => {
  assert.equal(daysAgoLocal(0), todayLocal());
});

test('daysAgoLocal(N) returns a valid YYYY-MM-DD string', () => {
  assert.match(daysAgoLocal(90), DATE_RE);
});

test('toolError sets isError and carries the message as text content', () => {
  const r = toolError('bad input');
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'bad input');
});

test('toolResult carries both text and structuredContent', () => {
  const payload = { ok: true, n: 3 };
  const r = toolResult(payload);
  assert.deepEqual(r.structuredContent, payload);
  assert.deepEqual(JSON.parse(r.content[0].text), payload);
  assert.equal(r.isError, undefined);
});

test('validateDate accepts YYYY-MM-DD and rejects everything else', () => {
  assert.equal(validateDate('2026-09-04'), '2026-09-04');
  assert.equal(validateDate('09/04/2026'), null);
  assert.equal(validateDate('2026-9-4'), null);
  assert.equal(validateDate(''), null);
  assert.equal(validateDate(undefined), null);
});
