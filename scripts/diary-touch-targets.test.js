/**
 * Touch targets in the Diary. On a touch screen every control there takes
 * a tap of 44px where its neighbors leave room, without changing how it
 * looks: an invisible tap area (.tap, src/styles/buttons.css) around it.
 * The areas were measured in a real browser at phone and foldable widths
 * (every point around each control, which control a tap lands on); these
 * tests hold the rules that make them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the widget panel edge tab takes a 44px tap on a touch screen, over a strip the Diary keeps clear', () => {
  const diary = read('src/routes/Diary.svelte');
  // Only on a touch screen: a mouse keeps the tab as drawn.
  // Only while the panel is closed: open, the panel lies under that strip.
  assert.match(diary, /@media \(pointer: coarse\) \{\s*:global\(html\.wide-content\) \.rail-edge-tab\[aria-expanded='false'\]::before \{[^}]*position: absolute;[^}]*right: 0;[^}]*width: 44px;[^}]*\}\s*:global\(html\.wide-content\) \.diary-body\.edge-tab-room \{\s*padding-right: calc\(var\(--page-px\) \+ 24px\);/);
  assert.match(diary, /class="diary-body" class:edge-tab-room=\{\$wideContent && !_railPinnedShown\}/);
  // The exercise column's 720px check counts the strip.
  assert.match(diary, /_centerRoom = _bodyW >= HUD_COL \+ CENTER_MIN \+ 20 \+ 2 \* _pagePx\(\) \+ _edgeTabGutter;/);
  assert.match(diary, /_edgeTabGutter = _coarse && \$wideContent && !_railPinnedShown \? 24 : 0;/);
  // The tab shows under the same condition.
  assert.match(diary, /\{#if \$wideContent && !_railPinnedShown\}\s*<button\s+use:portal\s+type="button"\s+class="rail-edge-tab"/);
});

test('one tap-area rule: invisible, touch screens only, 44px unless a neighbor sits closer', () => {
  const css = read('src/styles/buttons.css');
  assert.match(css, /@media \(pointer: coarse\) \{\r?\n\s*\.tap \{ position: relative; \}\r?\n\s*\.tap::after \{[^}]*content: '';[^}]*position: absolute;[^}]*width: max\(100%, var\(--tap-w, 44px\)\);[^}]*height: max\(100%, var\(--tap-h, 44px\)\);[^}]*translate\(calc\(-50% \+ var\(--tap-dx, 0px\)\), calc\(-50% \+ var\(--tap-dy, 0px\)\)\)/);
  // Nothing drawn: no background, border or color on the area.
  const after = css.slice(css.indexOf('.tap::after'));
  assert.doesNotMatch(after.slice(0, after.indexOf('}')), /background|border|color|box-shadow/);
});

test('the Diary\'s small controls carry it', () => {
  const has = (file, re, n = 1) => {
    const found = (read(file).match(new RegExp(re, 'g')) || []).length;
    assert.equal(found, n, `${file}: ${re}`);
  };
  has('src/App.svelte', 'class="hamburger tap"');
  for (const a of ['showGymTools', 'showBodyStats', 'showWorkoutActions', 'showAddMenu']) has('src/routes/Diary.svelte', `class="btn-icon accent tap" on:click=\\{\\(\\) => ${a} = true\\}`);
  has('src/routes/Diary.svelte', 'class="btn-icon accent tap diary-topbar-coach"');
  has('src/routes/Diary.svelte', 'class="btn-icon accent tap" on:click=\\{(prevDay|nextDay)\\}', 2);
  for (const c of ['date-btn', 'wake-toggle', 'workout-title', 'notes-trigger']) has('src/routes/Diary.svelte', `class="${c} tap"`);
  has('src/components/diary/WorkoutTimer.svelte', 'class="timer-btn tap"');
  has('src/components/diary/ExerciseCard.svelte', 'class="btn-icon-sm tap"', 4);
  for (const c of ['load-chip', 'btn-icon', 'add-set-btn', 'add-warmup-btn']) has('src/components/diary/ExerciseCard.svelte', `class="${c} tap"`);
  has('src/components/diary/SupersetCard.svelte', 'class="ss-remove-btn tap"');
  has('src/components/diary/SetRow.svelte', 'class="step-btn tap"', 2);
  for (const c of ['set-num set-num-btn tap', 'check-btn tap', 'remove-btn tap', 'rpe-chip tap', 'split-btn hold-btn tap', 'split-btn tap active']) has('src/components/diary/SetRow.svelte', `class="${c}"`);
  has('src/components/diary/RestTimer.svelte', 'class="rest-btn( icon)? tap"', 3);
});

test('packed controls share the gap between them instead of overlapping', () => {
  const row = read('src/components/diary/SetRow.svelte');
  // Set row: check reaches 3px left and 5px right, remove 1px left (and
  // 11px into the card's edge), together the 6px gap between them.
  assert.match(row, /\.check-btn \{ --tap-w: 44px; --tap-dx: 1px; \}/);
  assert.match(row, /\.remove-btn \{ --tap-w: 44px; --tap-dx: 5px; \}/);
  // RPE on is a class on the row now (every row keeps the RPE column).
  assert.match(row, /\.set-row\.rpe \.check-btn \{ --tap-w: calc\(100% \+ 6px\); --tap-dx: 0px; \}/);
  // On a phone the gaps are 4px (3px on the narrowest): see set-row-layout.test.js.
  assert.match(row, /\.set-row \.remove-btn, \.set-row\.rpe \.remove-btn \{ --tap-dx: 8px; \}/);
  // + never reaches over the unit beside it: a tap on "lbs" must not change the weight.
  assert.match(row, /\.step-btn \+ \.set-input \+ \.step-btn \{ --tap-w: 100%; --tap-dx: 0px; \}/);
  const card = read('src/components/diary/ExerciseCard.svelte');
  assert.match(card, /\.btn-icon-sm, \.ex-actions \.btn-icon \{ --tap-w: calc\(100% \+ 4px\); \}/);
  // The load chip sits 3px above the clip chip: with a clip, it reaches up only.
  assert.match(card, /\.ex-info:has\(\.ex-clip\) \.load-chip \{ --tap-h: 34px; --tap-dy: -8px; \}/);
  // Header buttons: 4px apart on a touch screen, so 40 + 4 fits.
  const diary = read('src/routes/Diary.svelte');
  assert.match(diary, /@media \(pointer: coarse\) \{\s*:global\(\.diary-topbar-actions\) \{ gap: 4px; \}\s*:global\(\.diary-topbar-actions \.btn-icon\) \{ --tap-w: 44px; \}/);
});
