/**
 * Dragging something draggable (the Trace button, a reorder handle) down
 * while the page was at the top was read as pull-to-refresh and synced.
 * Same bug and fix as NutriTrace #225.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPullSyncExempt, PULL_SYNC_EXEMPT } from '../src/lib/pull-sync.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function el(classes = [], attrs = {}, parent = null) {
  return {
    classes: new Set(classes), attrs, parentElement: parent,
    matches(sel) {
      return sel.split(',').map((x) => x.trim()).some((s) => {
        if (s.startsWith('.')) return this.classes.has(s.slice(1));
        const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (m) return m[2] === undefined ? m[1] in this.attrs : this.attrs[m[1]] === m[2];
        return false;
      });
    },
    closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; },
  };
}

test('the Trace button and anything marked draggable never start a pull', () => {
  const fab = el(['fab'], { 'data-no-pull-sync': '' });
  assert.equal(isPullSyncExempt(el(['fab-face'], {}, fab)), true, 'a touch on the face inside it');
  assert.equal(isPullSyncExempt(el(['drag-handle'])), true);
});

test('everything that was already left out still is', () => {
  assert.equal(isPullSyncExempt(el([], { role: 'dialog' })), true);
  for (const c of ['sheet-backdrop', 'sidebar-panel', 'sidebar-backdrop', 'bottom-nav']) assert.equal(isPullSyncExempt(el([c])), true, c);
});

test('ordinary page content still starts a pull', () => {
  assert.equal(isPullSyncExempt(el(['exercise-card'], {}, el(['page-transition']))), false);
  assert.equal(isPullSyncExempt(null), false);
});

test('each draggable in the app is marked', () => {
  assert.match(read('../src/components/ai/Trace.svelte'), /on:pointerdown=\{startDrag\}\n\s*data-no-pull-sync/);
  assert.match(read('../src/routes/Diary.svelte'), /on:pointerdown=\{startAddFabDrag\}\n\s*data-no-pull-sync/);
  assert.match(read('../src/components/progress-photos/PhotoCompareSlider.svelte'), /bind:this=\{frameEl\}\n\s*data-no-pull-sync/);
  assert.match(read('../src/components/progress-photos/PhotoScrubber.svelte'), /bind:this=\{trackEl\}\n\s*data-no-pull-sync/);
});

test('App.svelte uses the shared check when a touch starts', () => {
  const app = read('../src/App.svelte');
  const start = app.slice(app.indexOf('function _startPullSync'), app.indexOf('function _movePullSync'));
  assert.match(start, /if \(isPullSyncExempt\(event\.target\)\) return;/);
  assert.doesNotMatch(start, /closest\?\.\('\[role="dialog"\]/);
});
