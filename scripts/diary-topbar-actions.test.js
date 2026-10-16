/**
 * On a phone, a member with a coach saw the Coach Feedback button drawn over
 * Body Stats and More: the button sat at the right end of the Diary's page
 * header, the same corner the fixed .diary-topbar-actions strip (Gym Tools,
 * Body Stats, More) covers wherever it shows. A tap there opened More.
 *
 * The strip shows everywhere except html.wide-content. There the header
 * carries no actions, and Coach Feedback is the strip's first button; at
 * wide widths the strip hides and the header button is back. Checked in
 * Chromium from 320px to 1440px, sidebar pinned and Use Mobile Layout
 * included; these keep the two rules each other's exact opposite.
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
const strip = between('<div use:portal class="diary-topbar-actions">', '</div>');
const header = between('<header class="page-header"', '</header>');

test('the strip hides only at wide-content widths, and the header actions only below them', () => {
  assert.match(src, /:global\(html\.wide-content\) :global\(\.diary-topbar-actions\) \{\s*display: none;/);
  assert.match(src, /:global\(html:not\(\.wide-content\)\) \.diary-header-action \{ display: none; \}/);
});

test('every button in the page header is a header action, so none can sit under the strip', () => {
  const buttons = [...header.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
  assert.ok(buttons.length >= 2, 'Add and Coach Feedback');
  for (const b of buttons) assert.match(b, /class="diary-header-action[ "]/, b);
});

test('Coach Feedback is in the strip, first, on the same condition as the header copy', () => {
  const first = strip.indexOf('{#if showCoachInboxButton}');
  assert.ok(first >= 0, 'strip has the Coach Feedback button');
  assert.ok(first < strip.indexOf('<button class="btn-icon accent" on:click={() => showGymTools = true}'), 'before Gym Tools');
  assert.match(strip, /class="btn-icon accent diary-topbar-coach"[\s\S]*on:click=\{openCoachInbox\}/);
  assert.match(strip, /aria-label=\{\$_\('coaching\.sheets\.coach_feedback'\)\}/);
  assert.match(strip, /\{#if unreadFeedbackCount > 0\}\s*<span class="diary-topbar-badge">\{unreadFeedbackCount\}<\/span>/);
  assert.match(header, /\{#if showCoachInboxButton\}\s*<button class="diary-header-action"/);
  assert.match(src, /\$: showCoachInboxButton = !!\$currentUser\?\.trainer_id \|\| unreadFeedbackCount > 0 \|\| inboxRows\.length > 0;/);
});

test('the header Add shows exactly where the FAB hides', () => {
  // The FAB hides at html.wide-content; a header Add gated on a 1280px media
  // query left no Add at all between 720px of content and 1280px.
  assert.match(src, /:global\(html\.wide-content\) \.fab-group \{\s*display: none;/);
  assert.match(src, /import \{ wideContent \} from '\.\.\/lib\/wide\.js';/);
  assert.match(header, /\{#if \$wideContent && exercises\.length > 0\}\s*<button class="diary-header-action diary-header-add"/);
});

test('header actions keep the row\'s 40px tap target', () => {
  const i = src.indexOf('  .diary-header-action {');
  assert.match(src.slice(i, src.indexOf('}', i)), /min-height: 40px;/);
});
