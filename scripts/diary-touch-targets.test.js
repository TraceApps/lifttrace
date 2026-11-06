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
