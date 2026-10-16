/**
 * Which requests the fetch interceptor claims (issue #118, found by
 * @kgenerozov).
 *
 * An absolute URL used to be claimed on its path alone, so
 * https://openrouter.ai/api/v1/chat/completions was rewritten to the
 * connected LiftTrace server and answered 404. These run the real rule, and
 * the last one pins that nothing but third-party URLs changed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isInterceptable, ownOrigins } from '../src/lib/api-route.js';

const PAGE = 'https://localhost';                  // Capacitor's own origin
const SERVER = 'https://lt.example.com';
const NATIVE = ownOrigins(PAGE, SERVER);            // native, connected
const WEB = ownOrigins('https://lt.example.com', ''); // served by the server

test('relative LiftTrace calls are still ours', () => {
  assert.equal(isInterceptable('/api/workout/2026-09-24', NATIVE), true);
  assert.equal(isInterceptable('/uploads/set-videos/a.mp4', NATIVE), true);
  assert.equal(isInterceptable('/api/workout/2026-09-24', WEB), true);
});

test('an OpenAI-compatible base URL ending in /api goes to its own host', () => {
  // The reported case, on native and on the web.
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  assert.equal(isInterceptable(url, NATIVE), false);
  assert.equal(isInterceptable(url, WEB), false);
});

test('no third party is claimed for having an /api/ or /uploads/ path', () => {
  for (const url of [
    'https://example.com/api/test',
    'https://example.com/uploads/photo.jpg',
    'https://music.example.net/api/stream/42',       // a music server's stream
    'https://gist.example.org/api/exercise.json',    // a shared exercise link
  ]) {
    assert.equal(isInterceptable(url, NATIVE), false, url);
  }
});

test('an absolute URL at the connected server is still ours', () => {
  // apiUrl() builds exactly this on native, from 29 call sites; it is how
  // those requests get their bearer token.
  assert.equal(isInterceptable(`${SERVER}/api/admin/oidc/providers`, NATIVE), true);
  assert.equal(isInterceptable(`${SERVER}/uploads/avatar.png`, NATIVE), true);
});

test('an absolute URL at the page origin is still ours', () => {
  assert.equal(isInterceptable(`${PAGE}/api/health`, NATIVE), true);
});

test('the same host on another port is another origin', () => {
  const onPort = ownOrigins(PAGE, 'https://lt.example.com:8443');
  assert.equal(isInterceptable('https://lt.example.com/api/x', onPort), false);
  assert.equal(isInterceptable('https://lt.example.com:8443/api/x', onPort), true);
});

test('only /api/ and /uploads/ are claimed, even at our own origin', () => {
  assert.equal(isInterceptable(`${SERVER}/assets/index.js`, NATIVE), false);
  assert.equal(isInterceptable('/assets/index.js', NATIVE), false);
});

test('nothing it cannot read is claimed, and nothing throws', () => {
  assert.equal(isInterceptable('', NATIVE), false);
  assert.equal(isInterceptable(undefined, NATIVE), false);
  assert.equal(isInterceptable('http://[not a url', NATIVE), false);
});

test('standalone native has no server, so only the page is ours', () => {
  const standalone = ownOrigins(PAGE, null);
  assert.deepEqual(standalone, [PAGE]);
  assert.equal(isInterceptable('/api/workout/2026-09-24', standalone), true);
  assert.equal(isInterceptable('https://openrouter.ai/api/v1/chat/completions', standalone), false);
});

test('the only requests that changed are absolute ones to somebody else', () => {
  // The rule as it was before the fix, verbatim.
  const before = (url) => {
    if (!url) return false;
    const path = url.startsWith('http') ? new URL(url).pathname + (new URL(url).search || '') : url;
    return path.startsWith('/api/') || path.startsWith('/uploads/');
  };
  const foreign = (url) => url.startsWith('http') && !new Set(NATIVE).has(new URL(url).origin);
  const urls = [
    '/api/workout/2026-09-24', '/api/sync?since=1', '/uploads/a.png', '/assets/x.js', '/',
    `${SERVER}/api/workout/x`, `${SERVER}/uploads/a.png`, `${SERVER}/other`,
    `${PAGE}/api/health`, `${PAGE}/index.html`,
    // A subpath install: never claimed before (its path starts /lifttrace),
    // and not claimed now. Unchanged, not fixed, by this.
    'https://lt.example.com/lifttrace/api/x',
    'https://openrouter.ai/api/v1/chat/completions', 'https://example.com/api/test',
    'https://example.com/uploads/a.png', 'https://example.com/other',
  ];
  for (const url of urls) {
    if (foreign(url)) continue;
    assert.equal(isInterceptable(url, NATIVE), before(url), `changed for our own ${url}`);
  }
  // And every foreign /api/ or /uploads/ URL the old rule claimed is released.
  for (const url of urls.filter(foreign)) {
    assert.equal(isInterceptable(url, NATIVE), false, url);
  }
});
