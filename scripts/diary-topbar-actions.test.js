/**
 * Where the Diary's tools live, at every width.
 *
 * On a phone, a member with a coach saw the Coach Feedback button sit under
 * Body Stats and More: it was at the right end of the page header, the
 * corner the fixed .diary-topbar-actions strip covers. A tap there opened
 * More. And with 720 to 1279px of content (tablets, phone landscape, an open
 * foldable) the strip was hidden while the pinned Overview rail, which
 * carries Load Workout, Body Stats, Gym Tools and Workout Actions, only
 * shows from 1280px, so none of those tools could be reached. And the rail
 * was gated on a 1280px viewport while its grid needs 1420px, so a 1280px
 * window, or one beside a pinned sidebar, put it over the exercise list.
 *
 * One condition now decides it: _railPinnedShown (the rail's grid has room
 * for it, measured, and the rail is pinned). Where it holds, the rail carries the tools and the
 * page header has Add and Coach Feedback. Everywhere else the strip carries
 * all of them, and the header has none. Checked in Chromium from 360px to
 * 1600px, a live resize included, rail pinned and hidden, sidebar pinned and
 * Use Mobile Layout; these keep the pieces tied together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, from);
  const j = src.indexOf(to, i);
  assert.ok(j > i, to);
  return src.slice(i, j);
};
const strip = between('{#if !_railPinnedShown}\n  <div use:portal class="diary-topbar-actions">', '</div>\n  {/if}');
const header = between('<header class="page-header"', '</header>');

test('one condition says whether the pinned rail is on screen, from the room the grid needs', () => {
  assert.match(src, /\$: _railPinnedShown = \$wideContent && _railRoom && _railMode === 'pinned';/);
  assert.match(src, /import \{ wideContent \} from '\.\.\/lib\/wide\.js';/);
  // The room is the grid's own columns, gaps and padding, measured from
  // .diary-body (a pinned sidebar and the scrollbar count), not a viewport
  // media query: a 1280px window had 1280px for a 1420px grid.
  assert.match(src, /grid-template-columns: 280px minmax\(720px, 1fr\) 340px;\s*gap: 24px;[\s\S]{0,40}padding: 0 var\(--page-px\);/);
  assert.match(src, /const HUD_COL = 280, CENTER_MIN = 720, RAIL_COL = 340, GRID_GAP = 24;/);
  assert.match(src, /\$: _railRoom = _bodyW >= HUD_COL \+ CENTER_MIN \+ RAIL_COL \+ 2 \* GRID_GAP \+ 2 \* _pagePx\(\);/);
  assert.match(src, /if \(Math\.round\(gridRect\.width\) !== _bodyW\) _bodyW = Math\.round\(gridRect\.width\);/);
  assert.doesNotMatch(src, /_wideViewport/);
  // Without room: two columns, no pinned rail, no edge tab or overlay.
  assert.match(src, /class:rail-room=\{_railRoom\}/);
  assert.match(src, /:global\(html\.wide-content\) \.diary-body:not\(\.rail-room\) \{\s*grid-template-columns: 280px minmax\(0, 1fr\);/);
  assert.match(src, /\{#if _railPinnedShown\}\s*<aside\s+use:portal\s+class="diary-right-rail"/);
  // The Overview widgets stay one tap away wherever the pinned rail is not
  // up: the edge tab opens them as an overlay, which closes when the rail
  // takes over, and offers Pin only where the rail has room.
  assert.match(src, /\{#if \$wideContent && !_railPinnedShown\}\s*<button\s+use:portal\s+type="button"\s+class="rail-edge-tab"/);
  assert.match(src, /\{#if _railOverlay && \$wideContent && !_railPinnedShown\}\s*<aside use:portal class="diary-right-rail diary-right-rail-overlay"/);
  assert.match(src, /function railToggleOverlay\(\) \{\s*if \(_railPinnedShown\) return;/);
  assert.match(src, /\$: if \(\(_railPinnedShown \|\| !\$wideContent\) && _railOverlay\) _railOverlay = false;/);
  // It is as tall as its cards and ends above the bottom nav and the rest
  // and hold timers.
  assert.match(src, /bottom: auto;[\s\S]{0,400}max-height: calc\(100dvh - var\(--page-top, var\(--safe-top\)\) - 60px - var\(--hamburger-row, 0px\)\s*- 12px - var\(--nav-bar-h, 0px\) - var\(--safe-bottom, 0px\) - var\(--bottom-overlays, 0px\)\);/);
  assert.match(src, /<div class="rail-title-actions">\s*\{#if _railPinnedShown\}/);
  assert.match(src, /\{#if _railRoom\}\s*<button[^>]*on:click=\{railPin\}/);
});

test('the pinned rail carries the tools the strip gives up there, and only the pinned rail', () => {
  // The overlay opens only where the strip is up, so it shows the Overview
  // without a second copy of every tool.
  const rail = between('{#if _railPinnedShown}\n    <button class="rail-action" on:click={openLoadWorkout}>', '{/snippet}');
  assert.match(rail, /<\/div>\n    \{\/if\}\n$/);
  assert.match(rail, /on:click=\{openLoadWorkout\}/, 'Load Workout');
  assert.match(rail, /<BodyStatsWidget onOpen=\{\(\) => showBodyStats = true\} \/>/, 'Body Stats');
  assert.match(rail, /<GymTools embed \/>/, 'Gym Tools');
  assert.match(rail, /\{#each workoutActions as a \(a\.value\)\}[\s\S]*_runWorkoutAction\(a\.value\)/, 'Workout Actions');
});

test('the strip shows exactly where the rail does not, and nothing else hides it', () => {
  assert.ok(src.includes('{#if !_railPinnedShown}\n  <div use:portal class="diary-topbar-actions">'));
  assert.doesNotMatch(src, /:global\(html\.wide-content\) :global\(\.diary-topbar-actions\)/);
  assert.doesNotMatch(src, /\.diary-header-action \{ display: none; \}/);
});

test('the strip carries every tool: Add, Coach Feedback, Gym Tools, Body Stats, More, in that order', () => {
  const at = (needle) => { const i = strip.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = [
    at('{#if $wideContent && exercises.length > 0}'),
    at('{#if showCoachInboxButton}'),
    at('on:click={() => showGymTools = true}'),
    at('on:click={() => showBodyStats = true}'),
    at('on:click={() => showWorkoutActions = true}'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Opens the menu itself: handleAddFabClick ignores clicks after a FAB drag.
  assert.match(strip, /\{#if \$wideContent && exercises\.length > 0\}\s*<button class="btn-icon accent" on:click=\{\(\) => showAddMenu = true\}/);
  assert.match(strip, /class="btn-icon accent diary-topbar-coach"[\s\S]*on:click=\{openCoachInbox\}/);
  assert.match(strip, /\{#if unreadFeedbackCount > 0\}\s*<span class="diary-topbar-badge">\{unreadFeedbackCount\}<\/span>/);
});

test('the page header has actions only where the rail shows, and each is a header action', () => {
  assert.match(header, /\{#if _railPinnedShown && exercises\.length > 0\}\s*<button class="diary-header-action diary-header-add"\s*on:click=\{\(\) => showAddMenu = true\}/);
  assert.match(header, /\{#if _railPinnedShown && showCoachInboxButton\}\s*<button class="diary-header-action"/);
  const buttons = [...header.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
  assert.equal(buttons.length, 2);
  for (const b of buttons) assert.match(b, /class="diary-header-action[ "]/, b);
  assert.match(src, /\$: showCoachInboxButton = !!\$currentUser\?\.trainer_id \|\| unreadFeedbackCount > 0 \|\| inboxRows\.length > 0;/);
});

test('one Add at every width: the FAB below wide-content, then the strip, then the header', () => {
  // FAB hides at html.wide-content; the strip's Add starts there; the
  // header's Add needs _railPinnedShown, which implies wide-content and
  // hides the strip.
  assert.match(src, /:global\(html\.wide-content\) \.fab-group \{\s*display: none;/);
});

test('header actions keep the row\'s 40px tap target', () => {
  const i = src.indexOf('  .diary-header-action {');
  assert.match(src.slice(i, src.indexOf('}', i)), /min-height: 40px;/);
});
