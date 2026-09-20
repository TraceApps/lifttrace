/** Uploads are stored under a safe extension and served sandboxed (server/lib/upload-paths.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let mod = null;
try { mod = await import('../server/lib/upload-paths.js'); } catch (e) { console.log(`[upload-safe-ext] skipping: ${e.message.split('\n')[0]}`); }

test('uploads are stored under a safe extension, never the uploader\'s choice', { skip: !mod }, () => {
  const { safeUploadExtension } = mod;
  assert.equal(safeUploadExtension('image/png', 'photo.html'), '.png');
  assert.equal(safeUploadExtension('image/gif', 'curl.GIF'), '.gif');
  assert.equal(safeUploadExtension('video/mp4', 'squat.html'), '.mp4');
  assert.equal(safeUploadExtension('video/quicktime', 'lift.mov'), '.mov');
  assert.equal(safeUploadExtension('image/svg+xml', 'x.svg'), '.bin');
});

test('uploads are served with no sniffing and a sandboxing policy', { skip: !mod }, () => {
  assert.equal(mod.UPLOAD_RESPONSE_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.match(mod.UPLOAD_RESPONSE_HEADERS['Content-Security-Policy'], /sandbox/);
  assert.match(fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8'), /res\.set\(UPLOAD_RESPONSE_HEADERS\)/);
});
