/**
 * AI settings on Android (issue #94): usable in portrait, and kept in step
 * with the web. Checked statically: the settings store and sync engine pull
 * in Capacitor.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const screen = read('../src/components/settings/SettingsTrace.svelte');
const sync = read('../src/lib/sync.js');
const store = read('../src/stores/settings.js');

test('base URL and API key have no inline Save button and save on blur', () => {
  assert.doesNotMatch(screen, /on:click=\{saveAiKey\}|on:click=\{saveAiBaseUrl\}/);
  assert.match(screen, /on:blur=\{saveAiBaseUrl\}/);
  assert.equal((screen.match(/on:blur=\{saveAiKey\}/g) || []).length, 1, 'one key input, its type flips');
  assert.match(screen, /type=\{aiShowKey \? 'text' : 'password'\}/);
});

test('saving only re-tests the connection when the value changed', () => {
  assert.match(screen, /if \(aiKeyVal === \(\$aiApiKey \|\| ''\)\) return;/);
  assert.match(screen, /if \(trimmed === \(\$aiBaseUrl \|\| ''\)\) return;/);
});

test('the screen follows synced values except in the field being typed in', () => {
  assert.match(screen, /\$: if \(!aiKeyFocused\) aiKeyVal = \$aiApiKey \|\| '';/);
  assert.match(screen, /\$: if \(!aiBaseUrlFocused\) aiBaseUrlVal = \$aiBaseUrl \|\| '';/);
  assert.match(screen, /_followModel\(\$aiModel, \$aiProvider\)/);
});

test('a pulled setting is skipped only while a local change is on its way', () => {
  const apply = sync.slice(sync.indexOf('async function _applySettings'), sync.indexOf('async function _applyChat'));
  assert.doesNotMatch(apply, /sync_state === 'pending'\) continue/, 'pending was never cleared for settings');
  assert.match(apply, /queued\.has\(s\.key\) \|\| isRecentlyChanged\(s\.key\)/);
});

test('the startup settings load keeps offline and just-made changes', () => {
  const load = store.slice(store.indexOf('export async function loadServerSettings'));
  assert.match(load.slice(0, 1200), /if \(queued\.has\(key\) \|\| isRecentlyChanged\(key\)\) continue;/);
  assert.match(store, /_recentlyChanged\.set\(key, Date\.now\(\)\)/);
});
