/**
 * The browser's offline mode is wired where it should be. Text checks, so they
 * run without a browser; behaviour is covered by offline-edits.test.js and the
 * end-to-end runs in design/tools/offline-*.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const apiFetch = read('../src/lib/apiFetch.js');
const offline = read('../src/lib/offline-api.js');
const app = read('../src/App.svelte');
const auth = read('../src/stores/auth.js');
const vite = read('../vite.config.js');
const en = JSON.parse(read('../src/i18n/en.json'));

test('the web app goes through the offline layer, and native is untouched', () => {
  assert.match(apiFetch, /import \{ installOffline, offlineFetch \} from '\.\/offline-api\.js'/);
  assert.match(apiFetch, /if \(!isNative\) installOffline\(_origFetch\)/);
  assert.match(apiFetch, /return offlineFetch\(target, init, _origFetch\)/);
  // The interceptor is installed for the web app at the root too, which is
  // where it used to bail out.
  assert.ok(!/if \(!isNative && !_basePath\) return;/.test(apiFetch));
  // Native keeps its own SQLite paths and its own queue.
  assert.match(apiFetch, /_dispatchServerWithFallback/);
  assert.match(apiFetch, /_dispatchLocal/);
});

test('uploads and Request objects are left to the service worker and the browser', () => {
  assert.match(apiFetch, /!_isApiCall\(url\) \|\| typeof input !== 'string'/);
  assert.match(apiFetch, /function _isApiCall\(/);
});

test('the queue is replayed against the same routes, not a second merge path', () => {
  assert.match(offline, /collapseOps\(ops\)/);
  assert.match(offline, /method: op\.method/);
  // No hand-rolled push body: the requests the app already made go up as they were.
  assert.ok(!/sync\/push/.test(offline));
});

test('sending is guarded across tabs and retries with a backoff', () => {
  assert.match(offline, /navigator\.locks\.request\('lifttrace-offline-flush'/);
  assert.match(offline, /navigator\.locks\?\.request/);  // guarded for browsers without it
  assert.match(offline, /new BroadcastChannel\('lifttrace-offline'\)/);
  assert.match(offline, /RETRY_MIN_MS = 3_000/);
  assert.match(offline, /RETRY_MAX_MS = 30_000/);
  // Safari has no Background Sync, and the iPhone is half the point.
  assert.ok(!/BackgroundSync|sync\.register/.test(offline));
  assert.match(offline, /addEventListener\('online'/);
  assert.match(offline, /visibilitychange/);
});

test('a refusal from the server stops the replay instead of looping', () => {
  assert.match(offline, /if \(!res\.ok\) \{/);
  assert.match(offline, /stopped = \{ error: message \}/);
  assert.match(offline, /_scheduleFlush\(_backoff\(\)\)/);
});

test('a row created offline is changed by its real id after the queue goes up', () => {
  assert.match(offline, /let _swapped = \{\}/);
  assert.match(offline, /remapPath\(String\(url\), _swapped\)/);
  assert.match(offline, /_channel\?\.postMessage\(\{ type: 'outbox', ids: map \}\)/);
  assert.match(offline, /if \(e\.data\.ids\) _swapped = /);
});

test('the header badge reports the queue on the web', () => {
  assert.match(app, /import \{ offlineState \} from '\.\/lib\/offline-api\.js'/);
  assert.match(app, /_webOffline = !isNative &&/);
  assert.match(app, /_webFailing = !isNative && \(!!\$offlineState\.error/);
  assert.ok(en.sync.pending_web, 'sync.pending_web copy exists');
  assert.match(en.sync.pending_web, /plural/, 'it counts what is waiting');
  // A change the server refused is named, not just counted.
  assert.match(app, /\$offlineState\.refused/);
  assert.ok(en.sync.refused, 'sync.refused copy exists');
});

test('signing out sends what is waiting, then clears the copy in the browser', () => {
  const i = auth.indexOf('flushOutbox');
  assert.ok(i > 0, 'sign-out flushes the outbox');
  assert.ok(auth.indexOf('clearOffline') > i, 'and only then clears the mirror');
  assert.ok(auth.indexOf('flushOutbox') < auth.indexOf("'/api/auth/logout'"), 'before the session ends');
});

test('the app itself is precached, not just the fallback page', () => {
  assert.match(vite, /globPatterns: \['\*\*\/\*\.\{js,mjs,css,html,woff2,woff,ttf,png,svg,ico,webmanifest\}'\]/);
  assert.match(vite, /maximumFileSizeToCacheInBytes/);
  // The two big optional libraries still come down when first needed.
  assert.match(vite, /heic2any-\*\.js/);
  assert.match(vite, /hls-\*\.js/);
});

test('signing out in a dead zone asks before discarding what is waiting', () => {
  // Clearing the queue on a sign-out that could not send it would destroy work
  // the user never saw fail.
  assert.match(auth, /const sent = await flushOutbox\(\)\.catch\(\(\) => false\)/);
  assert.match(auth, /if \(!ok\) return;/);
  assert.ok(en.sync.sign_out_waiting && en.sync.sign_out_anyway, 'the copy exists');
  assert.ok(!/discards it\. Connect and try again to keep them/.test(en.sync.sign_out_waiting), 'the plural reads correctly');
});

test('cardio and starting a program are queued, editing a program is not', () => {
  const edits = readFileSync(new URL('../src/lib/offline-edits.js', import.meta.url), 'utf8');
  assert.match(edits, /kind: 'cardio-create'/);
  assert.match(edits, /kind: 'program-activate'/);
  assert.ok(edits.includes('week-cursor'), 'the week cursor is queued');
  assert.ok(edits.includes("kind: 'program-week'"));
});

test('coaching text is queued, access changes are not', () => {
  const edits = readFileSync(new URL('../src/lib/offline-edits.js', import.meta.url), 'utf8');
  for (const kind of ['coach-note', 'coach-reply', 'prescription-create']) {
    assert.ok(edits.includes(`'${kind}'`), `${kind} is queued`);
  }
  // Adding or removing a member, and assigning a program, stay online-only.
  assert.ok(!/trainer\/members\\\/\(\\d\+\)\$/.test(edits), 'membership changes are not queued');
  assert.ok(!edits.includes("'/api/programs/' + id + '/assign'"), 'assignment is not queued');
});

test('a note is pinned to the exercise, not to where it sat in the list', () => {
  const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const trainer = readFileSync(new URL('../server/routes/trainer.js', import.meta.url), 'utf8');
  const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.match(db, /addColumnIfMissing\('coach_feedback', 'exercise_uuid'/);
  assert.match(trainer, /WHERE workout_id = \? AND exercise_uuid = \? AND trainer_id = \?/);
  // Both sides match on the uuid first, falling back to the old position.
  assert.match(diary, /f\.exercise_uuid \? f\.exercise_uuid === gEx\.uuid : f\.exercise_idx/);
});

test('a change the server refuses is set aside and named, not left blocking the queue', () => {
  assert.match(offline, /isTransientStatus\(res\.status\)/);
  assert.match(offline, /refused\.push\(\{ at: Date\.now\(\)/);
  assert.match(offline, /console\.error\(`\[offline\] your server refused/);
  assert.match(offline, /export async function forgetRefused/);
});
