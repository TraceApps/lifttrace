/**
 * Settings > Exercise Catalog in the phone's local mode (issue #133,
 * reported by @daniel-bernardino747).
 *
 * The section was hidden in local mode, so a library skipped or failed in
 * the setup wizard could never be imported afterwards, although the wizard
 * says sources can be changed "any time from Settings". Shown now, with
 * what can only fail on a phone with no server left out. Turning on the
 * section also showed that the phone never read a source's on/off switch,
 * and that Clear and Delete all reported "undefined". Verified on an
 * Android emulator: an update from the old build keeps the data, and every
 * control in the section works.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const settings = read('../src/routes/Settings.svelte');
const catalog = read('../src/components/settings/SettingsCatalog.svelte');
const native = read('../src/lib/api-native.js');

test('the catalog is in Settings in local mode, on phones and wide screens', () => {
  const at = settings.indexOf('<SettingsCatalog\n');
  assert.ok(at > 0);
  assert.doesNotMatch(settings.slice(at - 80, at), /\{#if !localOnly\}/, 'no longer wrapped in {#if !localOnly}');
  assert.match(settings, /<SettingsCatalog\s+visible=\{sectionVisible\(settingsQuery, 'catalog'\)\}[\s\S]*?\{localOnly\}\s*\/>/);
  assert.match(settings, /<SettingsCatalog visible=\{true\} expanded=\{true\} onToggle=\{backToIndex\} \{localOnly\} \/>/);
});

test('what can only fail without a server is left out in local mode', () => {
  assert.match(catalog, /export let localOnly = false;/);
  assert.match(catalog, /\{#if !localOnly\}\s*<div class="card" style="margin-top:12px">/, 'media pre-cache');
  assert.match(catalog, /\{#if src\.requiresKey && canManageLibrary && !localOnly\}/, 'the RapidAPI key');
  assert.match(catalog, /\{#if canManageLibrary && !\(localOnly && src\.requiresKey\)\}/, 'and its Import');
});

test('the template downloads on Android through the share sheet', () => {
  assert.match(catalog, /on:click=\{downloadTemplate\}/);
  assert.match(catalog, /if \(!isNative\) return; \/\/ a browser downloads it through the link itself/);
  assert.match(catalog, /Share\.share\(/);
});

test('a source switched off stays out of the library on the phone', () => {
  const list = native.slice(native.indexOf('const Exercises = {'), native.indexOf('async get(id)'));
  assert.match(list, /key LIKE 'catalog_disabled_%' AND value = 'true'/);
  assert.match(list, /builtIn\.has\(name\) \? name : `import:\$\{name\}`/, 'built-in sources by id, catalogs as import:<name>');
  assert.match(list, /\(source IS NULL OR source NOT IN \(/);
});

test('Clear and Delete all say how many, as the server does', () => {
  assert.match(native, /async deleteAllCustom\(\) \{[\s\S]*?return \{ ok: true, removed: r\?\.changes \|\| 0 \};/);
  const clear = native.slice(native.indexOf('async sourcesClear('), native.indexOf('unsupported()', native.indexOf('async sourcesClear(')));
  assert.match(clear, /return \{ ok: true, removed: r\.changes \|\| 0 \};/);
  assert.doesNotMatch(clear, /cleared:/);
});

test('an empty library sends you straight to the catalog', () => {
  assert.match(read('../src/routes/Exercises.svelte'), /push\('\/settings\/catalog'\)/);
});
