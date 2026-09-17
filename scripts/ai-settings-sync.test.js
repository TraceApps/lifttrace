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

// ── Same Trace settings as NutriTrace ────────────────────────────────────

test('an environment-locked install shows the banner and locks the controls', () => {
  assert.match(screen, /\{#if envLocks\.ai\}\s*<div class="env-lock-banner">/);
  assert.match(screen, /settings_trace\.env_lock_banner/);
  assert.match(screen, /bind:value=\{\$aiProvider\} on:change=\{_onProviderChange\} disabled=\{envLocks\.ai\}/);
  assert.match(screen, /\{#if !envLocks\.ai\}\s*<div class="setting-row" style="flex-wrap:wrap;gap:8px">/, 'no key field when the server holds it');
});

test('Smart Log has a switch, and its voice language is used by both microphones', () => {
  assert.match(screen, /checked=\{\$quickLogEnabled\}/);
  assert.match(screen, /\{#if \$quickLogEnabled\}[\s\S]*smartLogVoiceLang/);
  assert.match(read('../src/components/ai/Trace.svelte'), /smartLogAvailable = isEnabled && \$quickLogEnabled/);
  for (const f of ['../src/components/ai/Trace.svelte', '../src/components/diary/SmartLogModal.svelte']) {
    const src = read(f);
    assert.match(src, /\.lang = _resolveVoiceLang\(\)/, f);
    assert.doesNotMatch(src, /\.lang = navigator\.language/, f);
  }
  assert.match(store, /'quickLogEnabled', 'smartLogVoiceLang'/, 'both sync to the server');
  assert.match(store, /createSettingStore\('quickLogEnabled',\s+true\)/, 'hold to record stays on for existing users');
});

test('every voice language option has a label', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const codes = screen.match(/VOICE_LANG_CODES = \[([^\]]+)\]/)[1].match(/'[^']+'/g).map(c => c.slice(1, -1));
  assert.equal(codes.length, 25);
  for (const c of codes) assert.ok(en.settings_trace.voice_langs[c.replace('-', '_')], c);
  for (const k of ['env_lock_banner']) assert.ok(en.settings_trace[k], k);
  for (const k of ['smart_log', 'smart_log_desc', 'voice_lang', 'voice_lang_desc', 'key_stored_device', 'key_stored_server']) {
    assert.ok(en.settings_trace.labels[k], k);
  }
});
