/**
 * The radio proxy only passes audio.
 *
 * It answers from LiftTrace's own origin with the station's own content type,
 * so a "station" link to an HTML page ran that page's script as the app for
 * anyone signed in who opened it (reproduced in a browser). Pages are now
 * refused, and what does come through can't be sniffed or run script. Real
 * audio still plays through it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../server/routes/radio-proxy.js', import.meta.url), 'utf8');
const stream = src.slice(src.indexOf("router.get('/', async"), src.indexOf("router.get('/now-playing'"));
const refused = (ct) => /html|xml|svg|javascript|ecmascript/i.test(ct);

test('pages and scripts are refused, audio and playlists are not', () => {
  assert.match(stream, /if \(ct && \/html\|xml\|svg\|javascript\|ecmascript\/i\.test\(ct\)\)/);
  for (const ct of ['text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/javascript']) assert.ok(refused(ct), ct);
  for (const ct of ['audio/mpeg', 'audio/aac', 'application/ogg', 'audio/x-mpegurl', 'application/vnd.apple.mpegurl', 'video/mp2t', 'application/octet-stream']) assert.ok(!refused(ct), ct);
});

test('what comes through is sent so it cannot act as a page', () => {
  assert.match(stream, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\);/);
  assert.match(stream, /res\.setHeader\('Content-Security-Policy', "default-src 'none'; sandbox"\);/);
  assert.ok(stream.indexOf("isn't a radio stream") < stream.indexOf('res.status(upstream.status)'), 'refused before any of it is sent');
});

test('the music proxy sends what it passes so it cannot act as a page', () => {
  const music = readFileSync(new URL('../server/routes/subsonic-proxy.js', import.meta.url), 'utf8');
  const pipe = music.slice(music.indexOf('async function pipeUpstream'));
  assert.match(pipe, /res\.set\('X-Content-Type-Options', 'nosniff'\);/);
  assert.match(pipe, /res\.set\('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"\);/);
  assert.ok(pipe.indexOf("'nosniff'") < pipe.indexOf('nodeStream.pipe(res)'), 'set before the body goes out');
});
