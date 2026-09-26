import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const route = read('../server/routes/nt-federation.js');
const api = read('../src/lib/api.js');
const settings = read('../src/stores/settings.js');
const federation = read('../src/components/settings/SettingsFederation.svelte');
const app = read('../src/App.svelte');

test('body proxy is narrow, server-side authenticated, and query allowlisted', () => {
  const start = route.indexOf("router.get('/body-measurements'");
  const end = route.indexOf("// POST /log-workout", start);
  assert.ok(start >= 0 && end > start);
  const bodyProxy = route.slice(start, end);

  assert.match(bodyProxy, /const \{ start, end, source \} = req\.query/);
  assert.match(bodyProxy, /new URLSearchParams\(\)/);
  assert.match(bodyProxy, /query\.set\('start', start\)/);
  assert.match(bodyProxy, /query\.set\('end', end\)/);
  assert.match(bodyProxy, /query\.set\('source', source\)/);
  assert.match(bodyProxy, /_ntFetch\(cfg, path\)/);
  assert.doesNotMatch(bodyProxy, /req\.query\.[A-Za-z_$][\w$]+/);
  assert.doesNotMatch(bodyProxy, /res\.json\(\{[^}]*token/);

  assert.match(route, /headers:\s*\{[\s\S]{0,180}Authorization.*cfg\.token/);
  assert.match(api, /getNtBodyMeasurements: \(start, end, source\)/);
  assert.match(api, /fetch\(`\/api\/nt\/body-measurements\$\{suffix\}`/);
});

test('workout-only federation tokens remain valid while body read is optional', () => {
  const start = route.indexOf("router.post('/test'");
  const end = route.indexOf("// GET /body-measurements", start);
  const connectionTest = route.slice(start, end);

  assert.match(connectionTest, /workoutWrite: scopes\.includes\('write:workouts'\)/);
  assert.match(connectionTest, /bodyMeasurementsRead: scopes\.includes\('read:body-measurements'\)/);
  assert.match(connectionTest, /body\?\.instance\?\.url/);
  assert.match(connectionTest, /body\?\.user\?\.id/);
  assert.match(connectionTest, /connectionIdentity = \{ instanceUrl, userId: String\(userId\) \}/);
  assert.doesNotMatch(connectionTest, /connectionIdentity\s*=\s*\{[^}]*token/i);
  assert.match(connectionTest, /if \(!scopes\.includes\('write:workouts'\)\)/);
  assert.doesNotMatch(connectionTest, /if \(!scopes\.includes\('read:body-measurements'\)\)/);
  assert.match(federation, /body_sync_scope_missing/);
  assert.match(federation, /if \(!bodyRead\) ntBodySyncEnabled\.set\(false\)/);
});

test('body sync settings and lifecycle are opt-in and foreground-triggered', () => {
  // Regression guard: persisted body-sync settings must be registered in the
  // SERVER_SETTINGS set so scheduleSave()/the store setter actually PUT them to
  // the server. Missing membership silently drops persistence.
  const ssStart = settings.indexOf('const SERVER_SETTINGS');
  const ssEnd = settings.indexOf(']);', ssStart);
  assert.ok(ssStart >= 0 && ssEnd > ssStart, 'SERVER_SETTINGS literal not found');
  const serverSettings = settings.slice(ssStart, ssEnd);
  for (const key of ['ntBodySyncEnabled', 'ntBodySource', 'ntBodySyncedSource', 'ntBodySyncedConnectionIdentity', 'ntBodyLastSyncAt', 'ntConnectionIdentity']) {
    assert.match(settings, new RegExp(`'${key}'`));
    assert.match(settings, new RegExp(`createSettingStore\\('${key}'`));
    assert.match(serverSettings, new RegExp(`'${key}'`));
  }
  assert.match(federation, /disabled=\{!bodyReadAvailable \|\| !\$ntFederationEnabled\}/);
  assert.match(federation, /syncNtBodyMeasurements\(\{ manual: true \}\)/);
  assert.match(federation, /on:change=\{onBodySyncToggle\}/);
  assert.match(federation, /if \(event\.detail\) syncBodyNow\(\);/);
  assert.match(federation, /preserveExistingOnFail = false/);
  assert.match(federation, /if \(!preserveExistingOnFail\) \{[\s\S]*?ntFederationEnabled\.set\(false\);[\s\S]*?ntConnectionVerified\.set\(false\);[\s\S]*?\}/);
  assert.match(federation, /test\(\{ silentOk: true, silentFail: true, preserveExistingOnFail: true \}\)/);
  assert.match(federation, /body_sync_source_change_blocked/);
  assert.match(federation, /ntConnectionIdentity\.set\(body\.connectionIdentity\)/);
  assert.match(federation, /if \(\$ntConnectionIdentity\) ntConnectionIdentity\.set\(null\)/);
  assert.match(federation, /connection-verification-required/);
  assert.match(federation, /connection-change-blocked/);
  assert.match(read('../src/lib/nt-body-sync.js'), /ntBodySyncedConnectionIdentity/);
  assert.match(read('../src/lib/nt-body-sync.js'), /saveSetting\('ntBodySyncedConnectionIdentity', connectionIdentity\)/);
  assert.match(read('../src/lib/nt-body-sync.js'), /saveSetting\('ntBodySyncedSource', source\)/);
  assert.match(app, /await loadAuthState\(\);[\s\S]{0,260}_syncNtBodySilently\(\);/);
  assert.match(app, /visibilitychange[\s\S]{0,140}_syncNtBodySilently\(\);/);
  assert.match(app, /addListener\('resume'[\s\S]{0,180}_syncNtBodySilently\(\);/);
  assert.doesNotMatch(read('../src/lib/nt-body-sync.js'), /setInterval|setTimeout/);
});

test('existing workout proxy remains a separate POST contract', () => {
  const start = route.indexOf("router.post('/log-workout'");
  const workout = route.slice(start);
  assert.match(workout, /_ntFetch\(cfg, '\/api\/v1\/workouts'/);
  assert.match(workout, /method: 'POST'/);
  assert.match(workout, /external_id: String\(external_id\)/);
  assert.doesNotMatch(workout, /body-measurements/);
});


test('passive capability refresh preserves an established workout federation on transport failure', () => {
  assert.match(federation, /async function test\(\{ silentOk = false, silentFail = false, preserveExistingOnFail = false \} = \{\}\)/);
  const failGuards = federation.match(/if \(!preserveExistingOnFail\) \{\s*ntFederationEnabled\.set\(false\);\s*ntConnectionVerified\.set\(false\);\s*\}/g) || [];
  assert.equal(failGuards.length, 2, 'both non-ok and catch paths must preserve existing federation during passive probes');
  assert.match(federation, /test\(\{ silentOk: true, silentFail: true, preserveExistingOnFail: true \}\)/);
  assert.match(federation, /if \(!bodyRead\) ntBodySyncEnabled\.set\(false\)/, 'a successful capability result may still disable body sync when its optional scope is missing');
});
