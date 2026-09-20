/**
 * Issue #104: with Radio playing, the bottom of the Diary's side column
 * (Delete Workout) sat behind the mini player and couldn't be scrolled to.
 *
 * Side columns that size themselves to the window must leave room for
 * everything covering the bottom of the screen, not just the nav bar. The
 * layout was checked in Chromium with the player, the rest timer and both;
 * these keep the pieces in place.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the covered height counts the mini player and both timer bars', () => {
  const tokens = read('../src/styles/tokens.css');
  assert.match(tokens, /--bottom-overlays: calc\(var\(--mini-player-h, 0px\) \+ var\(--rest-h, 0px\) \+ var\(--hold-h, 0px\)\);/);
});

test('every side column sized to the window leaves room for them', () => {
  const dir = new URL('../src/routes/', import.meta.url);
  let rails = 0;
  for (const f of readdirSync(dir).filter(n => n.endsWith('.svelte'))) {
    const src = read(`../src/routes/${f}`);
    for (const m of src.matchAll(/max-height: calc\(100vh[^;]*;/g)) {
      if (!/var\(--nav-h/.test(m[0])) continue;
      rails++;
      assert.match(m[0], /- var\(--bottom-overlays, 0px\)/, `${f}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.ok(rails >= 9, `found ${rails} side columns`);
});

test('each overlay sets its height back to 0px when it goes away', () => {
  assert.match(read('../src/App.svelte'), /'--mini-player-h', \$miniPlayerVisible \? '56px' : '0px'/);
  assert.match(read('../src/components/diary/RestTimer.svelte'), /'--rest-h', on \? '68px' : '0px'/);
  const hold = read('../src/components/diary/HoldTimer.svelte');
  assert.match(hold, /'--hold-h', active \? `\$\{barHeight\}px` : '0px'/);
  assert.match(hold, /onDestroy\(\(\) => \{\s*\n\s*if \(typeof document !== 'undefined'\) document\.documentElement\.style\.setProperty\('--hold-h', '0px'\);/);
});
