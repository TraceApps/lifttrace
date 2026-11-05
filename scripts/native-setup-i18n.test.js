/**
 * The connect screen's last choice, keeping only what is on the server, is
 * said in the app's language (src/i18n/en.json), in Title Case and without
 * a dash, like the three choices above it. It was English written into
 * NativeSetup.svelte.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Skip, Keep Server Only is a key in en.json', () => {
  const src = read('src/routes/NativeSetup.svelte');
  assert.match(src, /class="btn btn-ghost migrate-skip"[^>]*>\s*\{\$_\('native_setup\.skip_keep_server'\)\}\s*<\/button>/);
  assert.doesNotMatch(src, /keep server only/i);
  const en = JSON.parse(read('src/i18n/en.json'));
  assert.equal(en.native_setup.skip_keep_server, 'Skip, Keep Server Only');
});
