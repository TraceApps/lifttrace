/**
 * Tap a number field, type, and the typing replaces the old value without
 * selecting it first (issue #95: a selection brings up Android's text
 * toolbar over the set row). Runs the real action against a small stand-in
 * for an <input>; the full component flow was checked in Chromium by hand.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { replaceOnType } = await import('../src/lib/replaceOnType.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function fakeInput(value) {
  const doc = { activeElement: null };
  const node = new EventTarget();
  const classes = new Set();
  Object.assign(node, {
    value,
    ownerDocument: doc,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    focus() { doc.activeElement = node; node.dispatchEvent(new Event('focus')); },
    blur() { doc.activeElement = null; node.dispatchEvent(new Event('blur')); },
  });
  // What the browser does for a keystroke: insert at the end, then fire input.
  node.type = (ch, inputType = 'insertText') => {
    node.value += ch;
    const e = new Event('input', { bubbles: true });
    Object.assign(e, { inputType, data: ch });
    node.dispatchEvent(e);
  };
  node.key = (key) => { const e = new Event('keydown'); e.key = key; node.dispatchEvent(e); };
  return node;
}

test('the first digit after focusing replaces the whole value', () => {
  const el = fakeInput('86');
  replaceOnType(el);
  el.focus();
  assert.ok(el.classList.contains('replace-pending'));
  el.type('9');
  assert.equal(el.value, '9');
  el.type('0');
  assert.equal(el.value, '90', 'only the first keystroke replaces');
  assert.ok(!el.classList.contains('replace-pending'));
});

test('every new focus replaces again', () => {
  const el = fakeInput('10');
  replaceOnType(el);
  el.focus(); el.type('3'); el.blur();
  el.focus(); el.type('4');
  assert.equal(el.value, '4');
});

test('moving the caret or a second tap means editing, not replacing', () => {
  const a = fakeInput('86');
  replaceOnType(a);
  a.focus(); a.key('End'); a.type('5');
  assert.equal(a.value, '865');

  const b = fakeInput('86');
  replaceOnType(b);
  b.focus(); b.dispatchEvent(new Event('pointerdown')); b.type('5');
  assert.equal(b.value, '865');
});

test('backspace, paste and composition stay native', () => {
  for (const kind of ['deleteContentBackward', 'insertFromPaste', 'insertCompositionText']) {
    const el = fakeInput('86');
    replaceOnType(el);
    el.focus();
    el.type(kind === 'deleteContentBackward' ? '' : '1', kind);
    assert.equal(el.value, kind === 'deleteContentBackward' ? '86' : '861', kind);
    assert.ok(!el.classList.contains('replace-pending'), `${kind} disarms`);
  }
});

test('leaving without typing changes nothing', () => {
  const el = fakeInput('86');
  replaceOnType(el);
  el.focus(); el.blur();
  assert.equal(el.value, '86');
  assert.ok(!el.classList.contains('replace-pending'));
});

test('no number field selects its text on focus any more', () => {
  const row = read('../src/components/diary/SetRow.svelte');
  assert.doesNotMatch(row, /select\?\.\(\)|selectOnFocus/);
  assert.equal((row.match(/use:replaceOnType/g) || []).length, 5, 'weight, reps, L, R and time');
  const bs = read('../src/components/diary/BodyStatsWidget.svelte');
  assert.doesNotMatch(bs, /inputEl\?\.select\(\)/);
  assert.match(bs, /use:replaceOnType/);
});
