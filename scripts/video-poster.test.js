/**
 * A video with no poster shows Android's own play glyph, scaled to the
 * element, until a frame has been decoded. On a phone that reads as a broken
 * thumbnail: a huge blurry triangle where the lift should be. Every <video>
 * that can be shown before it is played carries a poster now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const helper = read('../src/lib/video-poster.js');
const sheet  = read('../src/components/diary/SetVideoSheet.svelte');
const player = read('../src/components/diary/SetVideoPlayer.svelte');

test('the helper makes a still from a playing element and from bytes', () => {
  assert.match(helper, /export function posterFromElement\(el\)/);
  assert.match(helper, /export function posterFromBlob\(blob/);
  assert.match(helper, /toDataURL\('image\/jpeg'/);
  assert.match(helper, /setTimeout\(\(\) => done\(null\), timeoutMs\)/, 'never holds a screen up');
});

test('the review player gets a poster, filmed or picked', () => {
  assert.match(sheet, /<video class="sv-video" src=\{clipUrl\} poster=\{posterUrl \|\| undefined\}/);
  // Filming: taken off the live preview before the camera is released.
  const stop = sheet.slice(sheet.indexOf('recorder.onstop'), sheet.indexOf('recorder.start()'));
  assert.ok(stop.indexOf('posterFromElement(previewEl)') < stop.indexOf('stopStream()'), 'grabbed before the stream stops');
  // A picked file: decoded offscreen, without blocking the review screen.
  assert.match(sheet, /posterFromBlob\(file\)\.then/);
});

test('the coach player gets one too, from the bytes it already fetched', () => {
  assert.match(player, /poster=\{posterUrl \|\| undefined\}/);
  assert.match(player, /posterUrl = await posterFromBlob\(bytes\)/);
});

test('the poster is cleared with the rest of the clip state', () => {
  assert.match(sheet, /clipUrl = null; clipBlob = null; posterUrl = null;/);
  assert.match(sheet, /stage = 'choose'; clipBlob = null; posterUrl = null;/);
});
