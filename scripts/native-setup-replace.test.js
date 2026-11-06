/**
 * The connect screen's Replace with Server asks before dropping changes that
 * never reached a server, as Settings' Download does (1.4.0's changelog said
 * both did; the connect screen deleted the phone's data straight away). The
 * question is lib/local-account.js settleQueuedChanges, whose behavior the
 * Android sync harness covers (scripts/android-sync/phone.mjs); here: the
 * connect screen asks it first, and stops when the answer is no, and the
 * dialog it asks with is mounted while the connect screen shows.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Replace with Server asks about unsent changes before clearing, and a no stops it', () => {
  const src = read('src/routes/NativeSetup.svelte');
  const fn = src.slice(src.indexOf('async function migrateDownload()'), src.indexOf('function migrateSkip()'));
  assert.ok(fn.length > 0, 'migrateDownload found');
  const ask = fn.indexOf("settleQueuedChanges('download', { send: false })");
  const clear = fn.indexOf('destroyLocalDb()');
  assert.ok(ask > 0, 'asks with the same question as Settings\' Download');
  assert.ok(clear > ask, 'asks before clearing');
  assert.match(fn.slice(0, clear), /if \(!\(await settleQueuedChanges\('download', \{ send: false \}\)\)\) \{[^}]*return;/, 'a no leaves the data alone');
  const settings = read('src/routes/Settings.svelte');
  assert.match(settings, /settleQueuedChanges\('download', \{ send: false \}\)/, 'the same call as Settings');
});

test('the confirm dialog is mounted while the connect screen shows', () => {
  const app = read('src/App.svelte');
  const branch = app.slice(app.indexOf('{#if showNativeSetup}'), app.indexOf('{:else if !authLoaded}'));
  assert.match(branch, /<NativeSetup \/>/);
  assert.match(branch, /<ConfirmDialogMount \/>/);
});
