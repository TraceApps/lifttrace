import assert from 'node:assert/strict';
import test from 'node:test';
import i18nCheck from '../scripts/i18n-check.cjs';

const { findDuplicateKeys } = i18nCheck;

test('findDuplicateKeys: sibling repeated blocks (the PR #33 bug)', () => {
  assert.deepEqual(
    findDuplicateKeys('{"login":{"a":1},"other":2,"login":{"b":3}}'),
    ['login'],
  );
});

test('findDuplicateKeys: nested duplicate reports a dotted path', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"x":1,"x":2}}'), ['a.x']);
});

test('findDuplicateKeys: same name at different depths is not a duplicate', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"t":1},"b":{"t":2}}'), []);
});

test('findDuplicateKeys: braces and colons inside values do not confuse it', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"use {count}: now","b":2}'), []);
});

test('findDuplicateKeys: escaped quotes in a value', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"said \\"hi\\"","a":2}'), ['a']);
});

test('findDuplicateKeys: escaped quotes in a key', () => {
  assert.deepEqual(findDuplicateKeys('{"a\\"b":1,"a\\"b":2}'), ['a"b']);
});

test('findDuplicateKeys: arrays of objects', () => {
  assert.deepEqual(findDuplicateKeys('{"a":[{"x":1},{"x":2}],"b":[1,2]}'), []);
});

test('findDuplicateKeys: duplicate inside an array element', () => {
  assert.deepEqual(findDuplicateKeys('{"a":[{"x":1,"x":2}]}'), ['a[0].x']);
});

test('findDuplicateKeys: depth three', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"b":{"c":1,"c":2}}}'), ['a.b.c']);
});

test('findDuplicateKeys: escaped unicode in a value', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"\\u00e1rbol","b":1}'), []);
});

test('findDuplicateKeys: empty object and empty array', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{},"b":[],"c":1}'), []);
});

test('findDuplicateKeys: a triple duplicate reports twice', () => {
  assert.deepEqual(findDuplicateKeys('{"k":1,"k":2,"k":3}'), ['k', 'k']);
});
