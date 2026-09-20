/**
 * Radio on Jellyfin 12 (issue #100). Jellyfin 12 refuses the legacy
 * X-Emby-Authorization login (400) and X-Emby-Token requests (401); the
 * documented `Authorization: MediaBrowser ..., Token="..."` header works on
 * 12.x and on 10.x. Checked against real 12.1 and 10.10.7 servers when this
 * was written; these guard the shape of it without a server.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const proxy = read('../server/routes/subsonic-proxy.js');
const jf = proxy.slice(proxy.indexOf('// ── Jellyfin'), proxy.indexOf('// ── Plex'));

test('the Jellyfin header is the documented MediaBrowser scheme, with the token inside it', () => {
  assert.match(jf, /const JF_CLIENT = 'MediaBrowser Client="LiftTrace", Device="[^"]+", DeviceId="[^"]+", Version="[^"]+"'/);
  assert.match(jf, /`\$\{JF_CLIENT\}, Token="\$\{token\}"`/);
  assert.match(jf, /Authorization: jfAuthHeader\(token\)/);
});

test('sign-in and requests try the current header first, then the legacy one for older servers', () => {
  assert.match(jf, /for \(const auth of \[_jfModern\(null\), \{ 'X-Emby-Authorization': JF_CLIENT \}\]\)/);
  assert.match(jf, /let r = await send\(_jfModern\(t\)\);\s*if \(r\.status === 401 && t\)/);
  assert.match(jf, /r = await send\(_jfLegacy\(t\)\);/);
});

test('a dead or foreign saved token leads to a fresh sign-in, not a permanent 401', () => {
  assert.match(jf, /saved === `\$\{cfg\.url\}\|\$\{cfg\.user\}`/);
  assert.match(jf, /upstream\.status === 401 && hasLogin && !fresh/);
  assert.match(jf, /Jellyfin refused the sign-in/);
});

test('the Settings test signs in instead of reading the public info page', () => {
  const provider = read('../src/lib/radio-provider.js');
  const ping = provider.slice(provider.indexOf('const jellyfin = {'), provider.indexOf('async getArtists()'));
  assert.match(ping, /_proxyJson\('\/jf\/Users\/Me'\)/);
  assert.doesNotMatch(ping, /System\/Info\/Public/);
});
