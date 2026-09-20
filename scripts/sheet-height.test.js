/**
 * The Body Stats sheet had no height cap. With the keyboard open the screen
 * above it is short, so the sheet grew past the top edge and its title and
 * close button sat under the status bar (same as NutriTrace #228). The
 * hand-built bottom sheets now cap their height below the status bar and
 * scroll their own content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const rule = (css, sel) => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${sel} rule`);
  return css.slice(i, css.indexOf('}', i));
};
const CAP = /max-height: min\(90dvh, calc\(100dvh - var\(--safe-top\) - 8px\)\);/;

test('Body Stats stays below the status bar and scrolls its fields', () => {
  const css = read('../src/components/diary/BodyStats.svelte');
  const r = rule(css, '  .bs-sheet');
  assert.match(r, CAP);
  assert.match(r, /overflow-y: auto;/);
  assert.match(rule(css, '  .bs-sheet .sheet-header-row'), /position: sticky; top: 0;/, 'title and close button stay in reach');
});

test('Gym Tools is capped too; its content scrolls, the close button and tabs stay put', () => {
  const css = read('../src/components/diary/GymTools.svelte');
  const r = rule(css, '  .gt-sheet');
  assert.match(r, CAP);
  assert.match(r, /display: flex; flex-direction: column;/);
  assert.match(css, /\.gt-sheet > \.gt-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
});

test('the Diary date picker gets the same cap', () => {
  assert.match(rule(read('../src/routes/Diary.svelte'), '  .dp-sheet'), CAP);
});
