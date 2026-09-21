/**
 * The 30-second sync poll must stop when the app is not in front of you.
 *
 * A WebView keeps its timers running when the app is backgrounded and the
 * screen is off, so an ungated interval is a network round trip every thirty
 * seconds, all night, waking the radio each time. The comment always said
 * "while the app is active"; for a long time nothing enforced it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');

test('the poll is held in a handle rather than started and forgotten', () => {
  assert.match(source, /const startPolling = \(\) => \{[\s\S]{0,200}setInterval\(\(\) => sync\.fullSync\(true\)/);
  assert.match(source, /const stopPolling = \(\) => \{[\s\S]{0,160}clearInterval\(poll\)/);
});

test('it stops when the page is hidden and starts when it is shown', () => {
  assert.match(
    source,
    /visibilitychange[\s\S]{0,160}document\.hidden \? *stopPolling\(\)|visibilitychange[\s\S]{0,160}if \(document\.hidden\) stopPolling\(\); else startPolling\(\)/,
  );
});

test('it stops when the app is paused and starts again on resume', () => {
  const resume = source.slice(source.indexOf("addListener('resume'"), source.indexOf("addListener('pause'"));
  assert.match(resume, /startPolling\(\)/);
  const pause = source.slice(source.indexOf("addListener('pause'"));
  assert.match(pause.slice(0, 400), /stopPolling\(\)/);
});

test('nothing starts a bare uncontrolled sync interval any more', () => {
  // The exact shape of the bug: an interval whose handle nobody keeps.
  assert.doesNotMatch(source, /^\s*setInterval\(\(\) => sync\.fullSync/m);
});
