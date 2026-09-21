/**
 * The Trace button must not draw over an open sheet or dialog.
 *
 * It sat at z-index 400 while every sheet and dialog sits lower, so a
 * dragged button covered sheet titles and buttons (NutriTrace #233, where
 * it landed on top of the Copy sheet's title). It now sits between the
 * bottom bar and the lowest overlay: still above the page, never above a
 * layer that's open on top of the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const trace = readFileSync(join(SRC, 'components/ai/Trace.svelte'), 'utf8');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

const fabRule = trace.slice(trace.indexOf('  .lb-fab {'), trace.indexOf('}', trace.indexOf('  .lb-fab {')));
const fabZ = Number((fabRule.match(/z-index: (\d+);/) || [])[1]);

test('the Trace button sits above the page chrome but below every overlay', () => {
  assert.ok(Number.isFinite(fabZ), 'the button declares a z-index');
  assert.ok(fabZ > 50, `above the bottom bar (${fabZ})`);
  assert.ok(fabZ < 99, `below the lowest overlay, 99 (${fabZ})`);
});

const NOT_LAYERS = [
    // A dropdown's click-catcher in the workout editor, not a modal layer.
    'routes/WorkoutEditor.svelte .load-menu-backdrop',
];

test('no sheet or dialog backdrop sits below the Trace button', () => {
  const below = [];
  for (const f of walk(SRC).filter((x) => x.endsWith('.svelte'))) {
    const s = readFileSync(f, 'utf8');
    const style = s.slice(s.lastIndexOf('<style'));
    for (const m of style.matchAll(/\.([\w-]*(?:backdrop|overlay))[^{}]*\{([^}]*)\}/g)) {
      const z = Number((m[2].match(/z-index: (\d+);/) || [])[1]);
      // Only layers that cover the page: the ones with a fixed position.
      if (!Number.isFinite(z) || !/position: fixed/.test(m[2])) continue;
      const where = `${f.split('/src/')[1]} .${m[1]}`;
      if (NOT_LAYERS.includes(where)) continue;
      if (z <= fabZ) below.push(`${f.split('/src/')[1]} .${m[1]} z=${z}`);
    }
  }
  assert.deepEqual(below, []);
});
