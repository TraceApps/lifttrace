/**
 * Exercise media is shown through resolveAssetUrl() (#141, reported by
 * @rgpag1).
 *
 * Media uploaded in the exercise editor is stored as a server-relative
 * path (/uploads/exercises/...). Put straight into <img src>, it resolved
 * against the Android app's own origin (https://app.lifttrace.local), so
 * uploaded GIFs and pictures were blank in the app, and on the web when
 * LiftTrace is served from a subpath (BASE_URL). resolveAssetUrl() adds the
 * server address on Android and the subpath on the web, and leaves full
 * links (the built-in libraries) as they are.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const svelteFiles = (dir) => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
});

test('every src and poster that shows exercise media goes through resolveAssetUrl', () => {
  const bad = [];
  for (const file of svelteFiles(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(src|poster)=\{([^}]*)\}/g)) {
        const expr = m[2];
        if (!/\b(gif_url|img_url|video_url|previewUrl)\b/.test(expr)) continue;
        // A YouTube embed (an iframe) is a full link built from the video address.
        if (/<iframe\b/.test(line) || /youtubeId/.test(expr)) continue;
        if (!/^\s*resolveAssetUrl\(/.test(expr)) bad.push(`${file.slice(SRC.length)}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [], `exercise media shown without resolveAssetUrl:\n${bad.join('\n')}`);
});

test('the places reported in #141 are covered', () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  assert.match(read('routes/Exercises.svelte'), /src=\{resolveAssetUrl\(ex\.gif_url \|\| ex\.img_url\)\}/);
  assert.match(read('routes/ExerciseDetail.svelte'), /src=\{resolveAssetUrl\(s\.gif_url \|\| s\.img_url\)\}/);
  const info = read('components/exercises/ExerciseInfo.svelte');
  assert.match(info, /src=\{resolveAssetUrl\(exercise\.gif_url\)\}/);
  assert.match(info, /src=\{resolveAssetUrl\(exercise\.img_url\)\}/);
  assert.match(info, /src=\{resolveAssetUrl\(exercise\.video_url\)\}/);
});

test('media uploaded with no server (a file on the phone) is given an address the app can load', () => {
  // local-uploads.js stores standalone uploads as file:// URIs, which the
  // WebView can't load from its https origin.
  const platform = readFileSync(new URL('../src/lib/platform.js', import.meta.url), 'utf8');
  const body = platform.slice(platform.indexOf('export function resolveAssetUrl'));
  assert.match(body, /if \(path\.startsWith\('file:'\)\) \{\s*return isNative && Capacitor\?\.convertFileSrc \? Capacitor\.convertFileSrc\(path\) : path;/);
  assert.match(body, /path\.startsWith\('\/data\/'\)[\s\S]{0,80}Capacitor\.convertFileSrc\('file:\/\/' \+ path\)/);
  assert.ok(body.indexOf("startsWith('file:')") < body.indexOf('_imageMap'), 'before the server address is added');
});
