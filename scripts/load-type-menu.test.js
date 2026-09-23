/**
 * The Load Type chooser (issue #116, found by @kgenerozov).
 *
 * The menu used to be written out three times, and two of those copies
 * positioned themselves with `position: absolute` from an element that was
 * a sibling of the exercise header rather than a child of it. Nothing near
 * the exercise established a containing block, so the menu resolved against
 * the page: the first exercise looked right, and every one below it opened
 * the menu further away, often above the top of the screen.
 *
 * These pin the two things that would bring it back: one implementation,
 * and positioning taken from the trigger rather than from a CSS offset.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const menu = read('../src/components/ui/LoadTypeMenu.svelte');
const editor = read('../src/routes/WorkoutEditor.svelte');
const card = read('../src/components/diary/ExerciseCard.svelte');

test('the menu is positioned from the trigger, not from a CSS offset', () => {
  assert.match(menu, /export let anchor/, 'it is handed the trigger rect');
  const style = menu.slice(menu.indexOf('<style>'));
  assert.match(style, /position: fixed/, 'and positions in viewport coordinates');
  assert.doesNotMatch(style, /position:\s*absolute/, 'never against whatever ancestor happens to be positioned');
  assert.match(menu, /use:portal/, 'portaled out, so an ancestor overflow cannot clip it');
});

test('it opens below the chip, flips above, and scrolls when neither side fits', () => {
  const place = menu.slice(menu.indexOf('async function place'), menu.indexOf('const close ='));
  assert.match(place, /rect\.bottom \+ GAP/, 'below by default');
  assert.match(place, /rect\.top - GAP - height/, 'above when below does not fit');
  assert.match(place, /maxHeight: below/, 'and constrained rather than off-screen when neither does');
  assert.match(menu, /overflow-y:auto/, 'with its own scroll once constrained');
  // innerWidth counts the scrollbar; against a 420px page it reported 438
  // and put the menu 4px past the right edge.
  assert.match(place, /document\.documentElement\.clientWidth/);
  assert.match(place, /document\.documentElement\.clientHeight/);
});

test('the chooser exists once, and every caller uses it', () => {
  for (const [name, src] of [['WorkoutEditor', editor], ['ExerciseCard', card]]) {
    assert.match(src, /import LoadTypeMenu from/, `${name} imports the shared menu`);
    assert.doesNotMatch(src, /class="load-menu"/, `${name} has no copy of the markup`);
    assert.doesNotMatch(src, /\.load-menu\s*\{/, `${name} has no copy of the styles`);
  }
});

test('the editor keeps one menu for every row, and tells it which chip was clicked', () => {
  // One instance for the whole list: a menu per row is what made this two
  // copies in the first place, and a single `bind:this` trigger cannot work
  // when one component owns every chip on the page.
  assert.equal(editor.match(/<LoadTypeMenu/g)?.length, 1);
  assert.match(editor, /loadMenuAnchor = e\.currentTarget\.getBoundingClientRect\(\)/);
  assert.equal(editor.match(/\{\(e\) => toggleLoadMenu\(e, idx\)\}/g)?.length, 2, 'both the standalone and the superset chip');
});

test('picking still writes to the exercise that was clicked', () => {
  assert.match(editor, /on:pickLoad=\{\(e\) => pickLoadType\(loadMenuIdx, e\.detail\)\}/);
  assert.match(editor, /on:pickSetType=\{\(e\) => pickSetType\(loadMenuIdx, e\.detail\)\}/);
  assert.match(card, /on:pickLoad=\{\(e\) => pickLoadType\(e\.detail\)\}/);
  assert.match(card, /on:pickSetType=\{\(e\) => pickSetType\(e\.detail\)\}/);
});

test('a choice made in the editor reaches the save, not just the chip', () => {
  // `exercises` is derived from template.exercises, and save() sends
  // template.exercises. These two functions assigned the derived array, so
  // the chip changed, the payload did not, and the choice was gone on the
  // next visit. Every other edit in the file already went through commit().
  for (const fn of ['pickSetType', 'pickLoadType']) {
    const body = editor.slice(editor.indexOf(`function ${fn}(idx, next)`));
    const end = body.indexOf('\n  }');
    assert.match(body.slice(0, end), /commit\(updated\)/, `${fn} commits to template.exercises`);
    assert.doesNotMatch(body.slice(0, end), /\n\s*exercises = updated;/, `${fn} does not assign the derived array`);
  }
});

test('the backdrop and the back button still close it', () => {
  assert.match(menu, /class="ltm-backdrop" on:click\|stopPropagation=\{close\}/);
  assert.match(menu, /use:closeOnBack=\{close\}/);
  for (const [name, src] of [['WorkoutEditor', editor], ['ExerciseCard', card]]) {
    assert.match(src, /on:close=\{\(\) => (loadMenuIdx = null|loadMenuOpen = false)\}/, `${name} handles close`);
  }
});

test('the Diary stops carrying English-only labels', () => {
  // The card had its option labels and hints hardcoded in English while the
  // editor had the same strings as keys, which is the other thing three
  // copies cost.
  assert.doesNotMatch(card, /'Per side'|'Alternating'/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['load_bilateral', 'load_paired', 'load_unilateral',
                   'load_hint_bilateral', 'load_hint_paired', 'load_hint_unilateral', 'remember_ex']) {
    assert.ok(en.workout_editor[k], `workout_editor.${k} exists`);
  }
});
