/**
 * From nutritrace#326 (cooktrace#93): defaults for everyone, here for the
 * language, date format and time format. A setting nobody chose starts from
 * the server's default, else the device's locale, else the app's own; a
 * person's choice always wins and nothing is written into their settings.
 * Admins set the defaults; an environment variable sets one and locks it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
import { localeDefault, localeFacts, regionalDefault, rememberInstanceDefaults, instanceDefaults } from '../src/lib/regional-defaults.js';
import { REGIONAL_OPTIONS } from '../server/lib/regional-options.js';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'regional-defaults-secret-x-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  return { base, stop: () => new Promise(r => { proc.on('exit', r); proc.kill(); }) };
}



const read = p => readFileSync(new URL(p, root), 'utf8');

test('the locale suggests units, formats and food search', () => {
  const d = (tag, ...keys) => keys.map(k => localeDefault(k, tag));
  const keys = ['measurementSystem', 'energyUnit', 'dateFormat', 'timeFormat', 'offSearchLanguage'];
  assert.deepEqual(d('en-US', ...keys), ['imperial', 'kcal', 'US', '12h', 'en']);
  assert.deepEqual(d('en-GB', ...keys), ['metric', 'kcal', 'EU', '24h', 'en']);
  assert.deepEqual(d('de-DE', ...keys), ['metric', 'kcal', 'EU', '24h', 'de']);
  assert.deepEqual(d('en-AU', ...keys).slice(0, 2), ['metric', 'kJ']);
  assert.deepEqual(d('ja-JP', 'dateFormat', 'offSearchLanguage'), ['ISO', 'ja']);
  // Food search stays worldwide: a country would narrow every search.
  assert.equal(localeDefault('offSearchCountry', 'de-DE'), undefined);
  // 'en_GB' as some phones write it.
  assert.deepEqual(d('en_GB', 'measurementSystem', 'dateFormat'), ['metric', 'EU']);
  assert.deepEqual(d('sv-SE', 'dateFormat', 'offSearchLanguage'), ['ISO', 'en'], 'a language OFF search lacks searches in English');
  // A bare language: the region the browser would guess.
  assert.equal(localeFacts('de').region, 'DE');
  assert.equal(localeDefault('measurementSystem', 'fr'), 'metric');
  // Nothing to go on: no suggestion, and the app's own default stands.
  assert.equal(localeDefault('measurementSystem', null), undefined);
  assert.equal(localeDefault('measurementSystem', 'not a locale!!'), undefined);
  assert.equal(localeDefault('language', 'de-DE'), undefined, "language has the app's own rule");
  // An engine without Intl.Locale (older Android WebViews): the tag's parts.
  const IntlLocale = Intl.Locale;
  try {
    delete Intl.Locale;
    assert.deepEqual(d('en-GB', 'measurementSystem', 'energyUnit', 'offSearchLanguage'), ['metric', 'kcal', 'en']);
    assert.deepEqual(d('en-AU', 'measurementSystem', 'energyUnit'), ['metric', 'kJ']);
    assert.equal(localeDefault('measurementSystem', 'en-US'), 'imperial');
  } finally { Intl.Locale = IntlLocale; }
  // Every suggestion is a value the app offers.
  for (const tag of ['en-US', 'en-GB', 'de-DE', 'en-AU', 'ja-JP', 'pt-BR', 'zh-CN', 'ar-EG', 'ko-KR', 'es-MX', 'fr-CA', 'hi-IN']) {
    for (const k of keys) {
      if (!REGIONAL_OPTIONS[k]) continue;   // not a setting LiftTrace has
      const v = localeDefault(k, tag);
      assert.ok(v === undefined || REGIONAL_OPTIONS[k].values.includes(v), `${tag} ${k}=${v}`);
    }
  }
});

test("the server's default comes first, for its own server, and only a value the app offers", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  try {
    const allowed = ['metric', 'imperial'];
    assert.equal(regionalDefault('measurementSystem', 'imperial', { tag: 'de-DE', allowed }), 'metric', 'the locale, with no server default');
    assert.equal(rememberInstanceDefaults({ measurementSystem: 'imperial', energyUnit: 'kJ' }, ''), true);
    assert.equal(rememberInstanceDefaults({ measurementSystem: 'imperial', energyUnit: 'kJ' }, ''), false, 'the same again changes nothing');
    assert.equal(regionalDefault('measurementSystem', 'imperial', { tag: 'de-DE', allowed }), 'imperial', "the server's over the locale");
    assert.equal(regionalDefault('measurementSystem', 'imperial', { tag: 'de-DE', allowed, scope: 'https://other' }), 'metric', "another server's don't count");
    assert.equal(regionalDefault('energyUnit', 'FALLBACK', { tag: null, allowed: ['kcal'] }), 'FALLBACK', "a value this app doesn't offer is ignored");
    assert.equal(regionalDefault('energyUnit', 'FALLBACK', { tag: null }), 'kJ');
    assert.equal(regionalDefault('timeFormat', () => '12h', { tag: null }), '12h', 'the fallback last (a function too)');
    // Kept across a reload (offline).
    assert.deepEqual(JSON.parse(store.get('trace_instance_defaults')).values, { measurementSystem: 'imperial', energyUnit: 'kJ' });
    assert.deepEqual(instanceDefaults(''), { measurementSystem: 'imperial', energyUnit: 'kJ' });
  } finally { delete globalThis.localStorage; }
});

test("the app's pickers and the server offer the same values", () => {
  const i18n = read('src/i18n/index.js');
  const codes = [...i18n.slice(i18n.indexOf('AVAILABLE_LOCALES')).matchAll(/code: '([A-Za-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(REGIONAL_OPTIONS.language.values, codes, 'languages');
  const units = read('src/components/settings/SettingsUnits.svelte');
  for (const key of ['dateFormat', 'timeFormat']) {
    const block = units.slice(units.indexOf(`bind:value={$${key}}`));
    const opts = [...block.slice(0, block.indexOf('</select>')).matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual([...opts].sort(), [...REGIONAL_OPTIONS[key].values].sort(), key);
  }
  // The weight unit is no default: a logged set is a number in the
  // account's unit, and a default that moved would misread it.
  assert.equal('weightUnit' in REGIONAL_OPTIONS, false);
  const settings = read('src/stores/settings.js');
  for (const key of Object.keys(REGIONAL_OPTIONS)) assert.match(settings, new RegExp(`regionalStore\\('${key}'`), key);
  assert.match(settings, /export const weightUnit  = createSettingStore\('weightUnit',  'lbs'\);/);
  // Reset to Defaults: today's defaults for the dates and clock, not US.
  const backup = read('src/components/settings/SettingsBackup.svelte');
  assert.match(backup, /dateFormat\.set\(regionalFallback\('dateFormat', 'US'\)\)/);
  assert.match(backup, /timeFormat\.set\(regionalFallback\('timeFormat', '12h'\)\)/);
});

test('admins set the defaults; the environment sets and locks one', { skip, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-defaults-'));
  const srv = await boot(dir, { DEFAULT_DATE_FORMAT: 'mm/dd', DEFAULT_LANGUAGE: 'es-MX', DEFAULT_WEIGHT_UNIT: 'kg' });
  try {
    const call = async (method, path, body, jwt, csrf) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(jwt ? { Cookie: `lt_token=${jwt}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    // Before setup and signed out: readable (the wizard starts from it).
    let got = await call('GET', '/api/app-config/defaults');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { values: { language: 'es' }, locked: ['language'] }, "the environment's, matched without case, a language by its own part; a bad one ignored");

    const login = async (username, password, adminJwt, adminCsrf) => {
      const reg = await fetch(srv.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(adminJwt ? { Cookie: `lt_token=${adminJwt}`, 'X-CSRF-Token': adminCsrf } : {}) }, body: JSON.stringify({ username, password }) });
      assert.ok(reg.status < 300, `register ${username}: ${reg.status}`);
      const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const jwt = l.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
      const me = await call('GET', '/api/auth/me', null, jwt);
      return { jwt, csrf: me.body.csrf };
    };
    const admin = await login('cook', 'Str0ng-Pass-88!y');
    const pat = await login('pat', 'Str0ng-Pass-77!z', admin.jwt, admin.csrf);

    // An admin sets some; values match without case and come back as stored.
    got = await call('PUT', '/api/app-config/defaults', { values: { dateFormat: 'iso', timeFormat: '24H' } }, admin.jwt, admin.csrf);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body.values, { dateFormat: 'ISO', timeFormat: '24h', language: 'es' });
    // Sent from another site's page: refused (the cross-site write guard).
    const cross = await fetch(srv.base + '/api/app-config/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: `lt_token=${admin.jwt}`, Origin: 'https://evil.example' }, body: JSON.stringify({ values: { timeFormat: '12h' } }) });
    assert.equal(cross.status, 403);
    // A name every object has isn't a setting.
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { constructor: 'x' } }, admin.jwt, admin.csrf)).status, 400);
    // The environment's can't be changed; a value the app doesn't offer or an
    // unknown key is refused, and nothing in that request is saved.
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { language: 'en' } }, admin.jwt, admin.csrf)).status, 409);
    // The weight unit can't be given a default (DEFAULT_WEIGHT_UNIT is ignored above).
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { weightUnit: 'kg' } }, admin.jwt, admin.csrf)).status, 400);
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { dateFormat: 'US', timeFormat: 'furlongs' } }, admin.jwt, admin.csrf)).status, 400);
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { theme: 'dark' } }, admin.jwt, admin.csrf)).status, 400);
    got = await call('GET', '/api/app-config/defaults');
    assert.equal(got.body.values.dateFormat, 'ISO', 'the refused request saved nothing');
    // null takes one away.
    got = await call('PUT', '/api/app-config/defaults', { values: { timeFormat: null } }, admin.jwt, admin.csrf);
    assert.equal(got.body.values.timeFormat, undefined);
    // Not an admin: refused. Signed out: refused.
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { timeFormat: '24h' } }, pat.jwt, pat.csrf)).status, 403);
    assert.equal((await call('PUT', '/api/app-config/defaults', { values: { timeFormat: '24h' } })).status, 401);
    // Nothing was written into anyone's settings.
    const patSettings = await call('GET', '/api/settings', null, pat.jwt);
    for (const k of Object.keys(REGIONAL_OPTIONS)) assert.equal(k in patSettings.body, false, k);
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same two files in NutriTrace, LiftTrace, CookTrace and NoteTrace
// (regional-options.js is each app's own). A change here goes to all four.
test('the shared files are the family copy', async () => {
  const { createHash } = await import('node:crypto');
  const sha = p => createHash('sha256').update(read(p)).digest('hex');
  assert.equal(sha('src/lib/regional-defaults.js'), '80b7cca782c446346b9815f70edda61ba501201a72ad8af081d52e0ea1d18fbf');
  assert.equal(sha('server/lib/instance-defaults.js'), 'f06e4480a7ba34f026651c6d0340a16132498b074ff3017c1c6ac659ae78436f');
});
