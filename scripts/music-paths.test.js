// The music proxy forwards only the parts of each server's API the app uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { musicApiPath, isMusicReply } from '../server/lib/music-paths.js';

test('the API paths the app uses go through', () => {
  assert.equal(musicApiPath('jf', ['Items', 'abc', 'Images', 'Primary']), 'Items/abc/Images/Primary');
  assert.equal(musicApiPath('jf', ['Audio', 'abc', 'universal']), 'Audio/abc/universal');
  assert.equal(musicApiPath('emby', ['System', 'Info', 'Public']), 'System/Info/Public');
  assert.equal(musicApiPath('jf', ['Users', 'Me']), 'Users/Me');
  assert.equal(musicApiPath('plex', ['library', 'sections']), 'library/sections');
  assert.equal(musicApiPath('plex', ['audio', ':', 'transcode', 'universal', 'start']), 'audio/:/transcode/universal/start');
  assert.equal(musicApiPath('plex', ['identity']), 'identity');
});

test('anything else on the server is refused', () => {
  assert.equal(musicApiPath('jf', ['secret']), null);
  assert.equal(musicApiPath('jf', ['web', 'index.html']), null);
  assert.equal(musicApiPath('plex', ['web']), null);
});

test("a path can't climb out of the allowed part", () => {
  assert.equal(musicApiPath('jf', ['Items', 'x/../../secret']), null);   // %2F decoded into a segment
  assert.equal(musicApiPath('jf', ['Items', '..', 'secret']), null);
  assert.equal(musicApiPath('jf', ['Items', 'x\\..\\..\\secret']), null);
  assert.equal(musicApiPath('jf', ['Items', '%2e%2e', 'secret']), null);
  assert.equal(musicApiPath('jf', ['Items', '.%2E', 'secret']), null);
  // A segment is encoded, so it can't become a query or fragment either.
  assert.equal(musicApiPath('jf', ['Items', 'a?b#c']), 'Items/a%3Fb%23c');
});

test('Subsonic: any method, but never out of /rest/', () => {
  assert.equal(musicApiPath('subsonic', ['getArtists']), 'getArtists');
  assert.equal(musicApiPath('subsonic', ['stream']), 'stream');
  assert.equal(musicApiPath('subsonic', ['x', '..', '..', 'secret']), null);
  assert.equal(musicApiPath('subsonic', ['x/../../secret']), null);
});

test('no empty segment: "//" would let the path start anywhere', () => {
  assert.equal(musicApiPath('plex', ['']), null);
  assert.equal(musicApiPath('plex', undefined), null);
  assert.equal(musicApiPath('plex', ['', 'admin']), null);
  assert.equal(musicApiPath('jf', ['Items', '', 'x']), null);
  assert.equal(musicApiPath('subsonic', ['/']), null);
});

test('only music-server replies are passed back', () => {
  for (const t of ['application/json', 'application/json; charset=utf-8', 'text/xml', 'application/xml', 'audio/mpeg', 'audio/ogg', 'image/jpeg', 'video/mp4', 'application/octet-stream', 'application/vnd.apple.mpegurl'])
    assert.equal(isMusicReply(t), true, t);
  for (const t of ['text/html', 'text/html; charset=utf-8', 'text/plain', 'application/javascript', '', undefined])
    assert.equal(isMusicReply(t), false, String(t));
});
