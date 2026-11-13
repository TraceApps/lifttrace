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
  const start = route.indexOf("router.get('/body-composition'");
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
  assert.match(api, /getNtBodyComposition: \(start, end, source\)/);
  assert.match(api, /fetch\(`\/api\/nt\/body-composition\$\{suffix\}`/);
});

test('workout-only federation tokens remain valid while body read is optional', () => {
  const start = route.indexOf("router.post('/test'");
  const end = route.indexOf("// GET /body-composition", start);
  const connectionTest = route.slice(start, end);

  assert.match(connectionTest, /workoutWrite: scopes\.includes\('write:workouts'\)/);
  assert.match(connectionTest, /bodyCompositionRead: scopes\.includes\('mcp:read'\)/);
  assert.match(connectionTest, /body\?\.instance\?\.url/);
  assert.match(connectionTest, /body\?\.user\?\.id/);
  assert.match(connectionTest, /connectionIdentity = \{ instanceUrl, userId: String\(userId\) \}/);
  assert.doesNotMatch(connectionTest, /connectionIdentity\s*=\s*\{[^}]*token/i);
  assert.match(connectionTest, /if \(!capabilities\.workoutWrite\)/);
  assert.doesNotMatch(connectionTest, /if \(!scopes\.includes\('mcp:read'\)\)/);
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
  for (const key of ['ntBodySyncEnabled', 'ntBodySource', 'ntBodyLastSyncAt', 'ntConnectionIdentity']) {
    assert.match(settings, new RegExp(`createSettingStore\\('${key}'`));
    assert.match(serverSettings, new RegExp(`'${key}'`));
  }
  // The provenance marker is server-owned: its stores still exist (a read-only
  // per-account cache), but the generic debounce must never PUT them.
  for (const key of ['ntBodySyncedSource', 'ntBodySyncedConnectionIdentity']) {
    assert.match(settings, new RegExp(`createSettingStore\\('${key}'`));
    assert.doesNotMatch(serverSettings, new RegExp(`'${key}'`));
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
  const bodySync = read('../src/lib/nt-body-sync.js');
  assert.match(bodySync, /ntBodySyncedConnectionIdentity/);
  // The marker is fixed by one server-side compare-and-set, and every
  // imported write carries it; two separate settings PUTs are exactly the
  // race the review found.
  assert.match(bodySync, /api\.claimNtBodyProvenance\(\{ connectionIdentity, source, readId \}\)/);
  assert.match(bodySync, /api\.saveBodyStats\(measurement\.date, \{ stats: changed, provenance \}\)/);
  assert.doesNotMatch(bodySync, /saveSetting\('ntBodySyncedSource'/);
  assert.doesNotMatch(bodySync, /saveSetting\('ntBodySyncedConnectionIdentity'/);
  assert.match(app, /await loadAuthState\(\);[\s\S]*?_syncNtBodySilently\(\);/);
  assert.match(app, /visibilitychange[\s\S]{0,140}_syncNtBodySilently\(\);/);
  assert.match(app, /addListener\('resume'[\s\S]{0,180}_syncNtBodySilently\(\);/);
  assert.doesNotMatch(bodySync, /setInterval|setTimeout/);
});

test('existing workout proxy remains a separate POST contract', () => {
  // Upstream moved the outbound call into logWorkoutToNt() (the watch's own
  // finish path uses it too); the route still delegates to it. Cover both.
  const start = route.indexOf('export async function logWorkoutToNt(');
  const workout = route.slice(start);
  assert.ok(start >= 0, 'logWorkoutToNt helper not found');
  assert.match(workout, /_ntFetch\(cfg, '\/api\/v1\/workouts'/);
  assert.match(workout, /method: 'POST'/);
  assert.match(workout, /external_id: String\(external_id\)/);
  assert.doesNotMatch(workout, /body-composition/);
  const restStart = route.indexOf("router.post('/log-workout'");
  assert.ok(restStart > start, 'POST /log-workout route must follow the helper');
  assert.match(route.slice(restStart), /logWorkoutToNt\(uid\(req\), req\.body \|\| \{\}\)/);
});


test('passive capability refresh preserves an established workout federation on transport failure', () => {
  assert.match(federation, /async function test\(\{ silentOk = false, silentFail = false, preserveExistingOnFail = false \} = \{\}\)/);
  const failGuards = federation.match(/if \(!preserveExistingOnFail\) \{\s*ntFederationEnabled\.set\(false\);\s*ntConnectionVerified\.set\(false\);\s*\}/g) || [];
  assert.equal(failGuards.length, 2, 'both non-ok and catch paths must preserve existing federation during passive probes');
  assert.match(federation, /test\(\{ silentOk: true, silentFail: true, preserveExistingOnFail: true \}\)/);
  assert.match(federation, /if \(!bodyRead\) ntBodySyncEnabled\.set\(false\)/, 'a successful capability result may still disable body sync when its optional scope is missing');
});

test('provenance is fixed by a server compare-and-set and checked on every imported write', () => {
  // The claim endpoint refuses a different fixed source and requires the
  // connection the server actually verified.
  assert.match(route, /claimProvenance\(db, u, candidate\)/);
  assert.match(route, /code: 'connection-mismatch'/);
  assert.doesNotMatch(route, /ntBodyProvenance[\s\S]{0,200}req\.query/);

  const bodyStats = read('../server/routes/body-stats.js');
  const verifyAt = bodyStats.indexOf('verifyProvenance(db, userId, provenance)');
  assert.ok(verifyAt >= 0, 'a body-stat write must verify its provenance');
  assert.ok(verifyAt < bodyStats.indexOf('INSERT INTO body_stats_log'), 'the check runs before any write');
  assert.ok(verifyAt < bodyStats.indexOf('UPDATE body_stats_log'), 'the check runs before any update');

  // The claim itself is one IMMEDIATE transaction (compare-and-set), not a
  // read followed by a separate write.
  const provenanceLib = read('../server/lib/nt-body-provenance.js');
  assert.match(provenanceLib, /database\.exec\('BEGIN IMMEDIATE'\)/);
  assert.match(provenanceLib, /source-provenance-conflict/);
  assert.match(provenanceLib, /connection-provenance-conflict/);

  // The marker is server-owned and never travels through device settings sync.
  assert.match(read('../server/routes/sync.js'), /isReservedProvenanceKey\(key\)/);
  assert.match(api, /claimNtBodyProvenance/);
  assert.match(api, /\/api\/nt\/body-provenance/);
});

test('a claim is bound to the read that produced its measurements', () => {
  const start = route.indexOf("router.get('/body-composition'");
  const end = route.indexOf('// POST /log-workout', start);
  const bodyProxy = route.slice(start, end);

  // The read snapshot is taken before the await, and every successful answer
  // carries a receipt in a header (NutriTrace's body shape is unchanged).
  assert.match(bodyProxy, /const readIdentity = stableIdentity\(_getSetting\(u, 'ntConnectionIdentity'\)\);/);
  assert.ok(bodyProxy.indexOf("stableIdentity(_getSetting(u, 'ntConnectionIdentity'))") < bodyProxy.indexOf('await _ntFetch(cfg, path)'),
    'the connection is snapshotted before the other server answers');
  assert.match(bodyProxy, /issueReadReceipt\(u, readIdentity\)/);
  assert.match(bodyProxy, /res\.set\('X-LT-Nt-Read-Id', readId\)/);
  assert.match(bodyProxy, /res\.json\(body\)/);

  const claimStart = route.indexOf("router.post('/body-provenance'");
  const claim = route.slice(claimStart);
  const takeAt = claim.indexOf('takeReadReceipt(readId, u)');
  const matchAt = claim.indexOf('readMatchesClaim(receipt, candidate)');
  const casAt = claim.indexOf('claimProvenance(db, u, candidate)');
  assert.ok(takeAt > 0 && matchAt > takeAt && casAt > matchAt,
    'the receipt is taken and matched before anything is fixed');
  assert.match(claim, /code: 'read-receipt-missing'/);
  assert.match(claim, /code: 'read-identity-mismatch'/);
  assert.match(claim, /code: 'connection-mismatch'/);

  // The client asks for and forwards the receipt. The header is exposed to
  // the Android WebView's origin, or a native build could never present it.
  assert.match(api, /res\.headers\.get\('X-LT-Nt-Read-Id'\)/);
  assert.match(read('../src/lib/nt-body-sync.js'), /status: 'read-receipt-required'/);
  const index = read('../server/index.js');
  assert.match(index, /Access-Control-Expose-Headers', 'X-LT-Coaching, X-LT-Nt-Read-Id'/);
});

test('the provenance keys are reserved against the generic settings API and device sync', () => {
  const settingsRoute = read('../server/routes/settings.js');
  const putStart = settingsRoute.indexOf("router.put('/'");
  const putEnd = settingsRoute.indexOf("router.delete('/'", putStart);
  const put = settingsRoute.slice(putStart, putEnd);
  const guardAt = put.indexOf('isReservedProvenanceKey(key)');
  assert.ok(guardAt > 0, 'the settings PUT must refuse a reserved key');
  assert.ok(guardAt < put.indexOf('INSERT OR REPLACE INTO user_settings'),
    'and refuse it before it can replace the claim row');
  assert.match(put, /code: 'reserved-setting'/);

  // Deleting settings keeps the claim; deleting the imported history releases
  // it, so a source can be chosen again after a full wipe.
  assert.match(settingsRoute, /deleteUserSettingsKeepingProvenance\(db, req\.user\.id\)/);
  assert.match(settingsRoute, /clearProvenance\(db, userId\)/);

  const syncRoute = read('../server/routes/sync.js');
  assert.match(syncRoute, /function isServerOnlyKey\(key\) \{ return isReservedProvenanceKey\(key\); \}/);
  assert.match(syncRoute, /import \{ isReservedProvenanceKey \} from '..\/lib\/nt-body-provenance.js';/);
});
