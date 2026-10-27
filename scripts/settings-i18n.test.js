/**
 * Settings shows no hardcoded English: every label, hint, button, title,
 * placeholder and aria-label in Settings and its sections goes through $_(),
 * so it follows the app's language. Names (LiftTrace, Plex, Strong...),
 * addresses, formats and code samples stay as written; they are listed below.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FILES = [
  '../src/routes/Settings.svelte',
  ...readdirSync(new URL('../src/components/settings/', import.meta.url))
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => `../src/components/settings/${f}`),
];

// Text that is the same in every language: names, addresses, formats, code.
const KEEP = new Set([
  'LiftTrace', 'TraceApps', '(AGPL-3.0)', 'RGB', '/api/mcp',
  'Subsonic (Navidrome, Airsonic, Gonic)',
  'https://nutritrace.example.com', 'write:workouts', 'nt_pat_…', 'you@example.com',
  'https://lifttrace.example.com', '#rrggbb',
  'console.anthropic.com', 'platform.openai.com', 'aistudio.google.com',
  'docker-compose pull && docker-compose up -d',
  'issuer:', 'authorization_endpoint:', 'token_endpoint:', 'end_session_endpoint:',
]);

/** Visible English left in a component's markup: text between tags, and title/placeholder/aria-label/alt values. */
function englishIn(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let t = src.replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<pre[\s\S]*?<\/pre>/g, blank);
  // Drop {...} expressions, innermost first, so nested ones go too.
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\{[^{}]*\}/g, (m) => blank(m)); }
  const found = [];
  for (const m of t.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!text || /^[a-z_0-9]+$/.test(text) || KEEP.has(text)) continue; // icon names
    found.push(text);
  }
  for (const m of t.matchAll(/\s(title|placeholder|aria-label|alt|\w+Label)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
    const v = m[2].trim();
    if (!KEEP.has(v) && !/^https?:\/\//.test(v)) found.push(`${m[1]}="${v}"`);
  }
  return found;
}

test('Settings and its sections have no hardcoded English in their markup', () => {
  const left = FILES.flatMap((f) => englishIn(read(f)).map((s) => `${f.split('/').pop()}: ${s}`));
  assert.deepEqual(left, []);
});

test('the strings moved out of Settings are in en.json and read the same', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const get = (k) => k.split('.').reduce((o, p) => o?.[p], en);
  assert.equal(get('settings_workout.goals.weekly_cardio'), 'Weekly Cardio Minutes');
  assert.equal(get('settings_workout.goals.weekly_cardio_desc'), 'Target line on the Statistics Cardio chart. Set to 0 to hide the target.');
  const workout = read('../src/components/settings/SettingsWorkout.svelte');
  assert.match(workout, /\$_\('settings_workout\.goals\.weekly_cardio'\)/);
  assert.match(workout, /\$_\('settings_workout\.goals\.weekly_cardio_desc'\)/);
});

test('the Settings messages are valid ICU, and the new ones have no long dashes', () => {
  const require = createRequire(import.meta.url);
  let IntlMessageFormat;
  try { ({ IntlMessageFormat } = require('intl-messageformat')); } catch { /* not installed: format check skipped */ }
  const en = JSON.parse(read('../src/i18n/en.json'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  for (const [k, v] of flat(en)) {
    if (!/^(connection_status|settings_|settings\.users)/.test(k)) continue;
    if (IntlMessageFormat) assert.doesNotThrow(() => new IntlMessageFormat(v, 'en', undefined, { ignoreTag: true }), k); // svelte-i18n's default
  }
  const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  for (const k of ['connection_status', 'settings_workout.goals.weekly_cardio_desc', 'settings_units', 'settings_email.banner', 'settings_radio.banner', 'settings_diagnostics.fold_flat']) {
    const v = k.split('.').reduce((o, p) => o?.[p], en);
    assert.doesNotMatch(JSON.stringify(v), DASHES, k);
  }
});

test('Settings search still finds Weekly Cardio Minutes', () => {
  const settings = read('../src/routes/Settings.svelte');
  const workout = settings.match(/^\s*workout:\s*\[([^\]]*)\]/m)[1];
  for (const kw of ['cardio minutes', 'weekly cardio']) assert.match(workout, new RegExp(`'${kw}'`), kw);
});
