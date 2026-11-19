/**
 * The shape of NutriTrace body federation that the wire behaviour depends on.
 *
 * The behaviour itself (one account cannot read another's, two interleaved
 * Saves never mix address and identity, a read receipt fails across a
 * restart, Clear Data releases the claim) is in nt-federation-routes.test.js,
 * against the real server. What is left here are the invariants that are
 * cheapest to guard in the source: the proxy is narrow, the token never
 * travels back, the connection is written by one server transaction, and the
 * provenance keys are not ordinary settings.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const route = read('../server/routes/nt-federation.js');
const connectionLib = read('../server/lib/nt-connection.js');
const api = read('../src/lib/api.js');
const settings = read('../src/stores/settings.js');
const federation = read('../src/components/settings/SettingsFederation.svelte');
const app = read('../src/App.svelte');
const settingsRoute = read('../server/routes/settings.js');
const syncRoute = read('../server/routes/sync.js');
const bodyStats = read('../server/routes/body-stats.js');
const provenanceLib = read('../server/lib/nt-body-provenance.js');
const bodySync = read('../src/lib/nt-body-sync.js');

test('the body proxy is narrow, authenticated, and never returns the token', () => {
  const start = route.indexOf("router.get('/body-composition'");
  const end = route.indexOf("// POST /log-workout", start);
  assert.ok(start >= 0 && end > start);
  const bodyProxy = route.slice(start, end);

  assert.match(bodyProxy, /const \{ start, end, source \} = req\.query/);
  assert.match(bodyProxy, /new URLSearchParams\(\)/);
  assert.match(bodyProxy, /query\.set\('start', start\)/);
  assert.match(bodyProxy, /query\.set\('end', end\)/);
  assert.match(bodyProxy, /query\.set\('source', source\)/);
  assert.doesNotMatch(bodyProxy, /req\.query\.[A-Za-z_$][\w$]+/);
  assert.doesNotMatch(bodyProxy, /res\.json\(\{[^}]*token/);

  assert.match(route, /headers:\s*\{[\s\S]{0,180}Authorization.*cfg\.token/);
  assert.match(api, /getNtBodyComposition: \(start, end, source\)/);
  assert.match(api, /fetch\(`\/api\/nt\/body-composition\$\{suffix\}`/);
});

test('a workout-only token still connects, while body read stays optional', () => {
  assert.match(route, /workoutWrite: scopes\.includes\('write:workouts'\)/);
  assert.match(route, /bodyCompositionRead: scopes\.includes\('mcp:read'\)/);
  assert.match(route, /body\?\.instance\?\.url/);
  assert.match(route, /body\?\.user\?\.id/);
  assert.doesNotMatch(route, /connectionIdentity\s*=\s*\{[^}]*\btoken\s*:/i);
  assert.match(route, /if \(!scopes\.includes\('write:workouts'\)\)/);
  assert.match(federation, /body_sync_scope_missing/);
});

test('body sync is opt-in and runs from the existing app lifecycle', () => {
  // Persisted body-sync settings must be registered in SERVER_SETTINGS so the
  // store setter actually PUTs them to the server.
  const ssStart = settings.indexOf('const SERVER_SETTINGS');
  const ssEnd = settings.indexOf(']);', ssStart);
  assert.ok(ssStart >= 0 && ssEnd > ssStart, 'SERVER_SETTINGS literal not found');
  const serverSettings = settings.slice(ssStart, ssEnd);
  for (const key of ['ntBodySyncEnabled', 'ntBodySource', 'ntBodyLastSyncAt', 'ntConnectionIdentity']) {
    assert.match(settings, new RegExp(`createSettingStore\\('${key}'`));
    assert.match(serverSettings, new RegExp(`'${key}'`));
  }
  // The provenance marker is server-owned: its stores are a per-account cache
  // and the generic debounce must never PUT them.
  for (const key of ['ntBodySyncedSource', 'ntBodySyncedConnectionIdentity', 'ntConnectionVersion']) {
    assert.match(settings, new RegExp(`createSettingStore\\('${key}'`));
    assert.doesNotMatch(serverSettings, new RegExp(`'${key}'`), `${key} is server-owned, never a device PUT`);
  }
  assert.match(federation, /disabled=\{!bodyReadAvailable \|\| !\$ntFederationEnabled \|\| testing \|\| bodyStateSaving\}/);
  assert.match(federation, /syncNtBodyMeasurements\(\{ manual: true \}\)/);
  assert.match(federation, /on:change=\{onBodySyncToggle\}/);
  assert.match(federation, /if \(!ntAccountChanged\(account\) && next\) syncBodyNow\(\);/);
  assert.match(federation, /body_sync_source_change_blocked/);
  assert.match(federation, /connection-verification-required/);
  assert.match(federation, /connection-change-blocked/);
  assert.match(bodySync, /ntBodySyncedConnectionIdentity/);
  // Provenance is fixed by one server compare-and-set and every imported
  // write carries it.
  assert.match(bodySync, /api\.claimNtBodyProvenance\(\{ connectionIdentity, source, readId \}\)/);
  assert.match(bodySync, /api\.saveBodyStats\(measurement\.date, \{ stats: changed, provenance \}\)/);
  assert.doesNotMatch(bodySync, /saveSetting\('ntBodySyncedSource'/);
  assert.doesNotMatch(bodySync, /saveSetting\('ntBodySyncedConnectionIdentity'/);
  assert.match(app, /await loadAuthState\(\);[\s\S]*?_syncNtBodySilently\(\);/);
  assert.match(app, /visibilitychange[\s\S]{0,140}_syncNtBodySilently\(\);/);
  assert.match(app, /addListener\('resume'[\s\S]{0,180}_syncNtBodySilently\(\);/);
  assert.doesNotMatch(bodySync, /setInterval|setTimeout/);
});

test('one connection transition is verified and saved by one server transaction', () => {
  assert.match(route, /router\.put\('\/federation-connection'/);
  assert.match(route, /saveConnectionTransition\(db, u, \{/);
  assert.match(connectionLib, /database\.exec\('BEGIN IMMEDIATE'\)/);
  assert.match(connectionLib, /isStale\(currentVersion, expectedVersion\)/);
  assert.match(connectionLib, /connectionFingerprint\(url, token, identity\)/);
  // URL, token, identity, scopes and enabled are inside that transaction.
  const saveStart = connectionLib.indexOf('export function saveConnectionTransition');
  const saveBody = connectionLib.slice(saveStart);
  for (const key of ['ntInstanceUrl', 'ntInstanceToken', 'ntConnectionIdentity', 'ntFederationEnabled', 'ntConnectionScopes']) {
    assert.match(saveBody, new RegExp(`'${key}'`), `${key} is part of the atomic transition`);
  }

  // The UI saves through that endpoint and publishes only the confirmed
  // values; it never writes the enabled flag as a separate setting.
  assert.match(federation, /saveConnection: LtApi\.saveNtFederationConnection/);
  assert.match(federation, /persistFederationConnectionTransition\(\{/);
  assert.match(federation, /publish\(result\.values\)/);
  assert.doesNotMatch(federation, /saveSettingNow\('ntFederationEnabled'/);
  assert.match(api, /saveNtFederationConnection: \(connection\)/);
  assert.match(api, /_jsonConfirmed/);
});

test('existing workout proxy remains a separate POST contract', () => {
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

test('provenance is fixed by a server compare-and-set and checked on every imported write', () => {
  assert.match(route, /claimProvenance\(db, u, candidate\)/);
  assert.match(route, /code: 'connection-mismatch'/);
  assert.doesNotMatch(route, /ntBodyProvenance[\s\S]{0,200}req\.query/);

  const verifyAt = bodyStats.indexOf('verifyProvenance(db, userId, provenance)');
  assert.ok(verifyAt >= 0, 'a body-stat write must verify its provenance');
  assert.ok(verifyAt < bodyStats.indexOf('INSERT INTO body_stats_log'), 'the check runs before any write');
  assert.ok(verifyAt < bodyStats.indexOf('UPDATE body_stats_log'), 'the check runs before any update');

  assert.match(provenanceLib, /database\.exec\('BEGIN IMMEDIATE'\)/);
  assert.match(provenanceLib, /source-provenance-conflict/);
  assert.match(provenanceLib, /connection-provenance-conflict/);

  assert.match(syncRoute, /isReservedProvenanceKey\(key\)/);
  assert.match(api, /claimNtBodyProvenance/);
  assert.match(api, /\/api\/nt\/body-provenance/);
});

test('a claim is bound to the read and to the exact saved configuration', () => {
  const start = route.indexOf("router.get('/body-composition'");
  const end = route.indexOf('// POST /log-workout', start);
  const bodyProxy = route.slice(start, end);

  // The read snapshot is taken before the await; the identity only counts
  // while its fingerprint matches the saved address and token.
  assert.match(bodyProxy, /const readIdentity = cfg\.identity;/);
  assert.match(bodyProxy, /!readIdentity \|\| !cfg\.fingerprint/);
  assert.ok(bodyProxy.indexOf('const readIdentity = cfg.identity;') < bodyProxy.indexOf('await _ntFetch(cfg, path)'),
    'the connection is snapshotted before the other server answers');
  assert.match(bodyProxy, /issueReadReceipt\(u, \{\s*\n\s*\.\.\.readIdentity,\s*\n\s*fingerprint: cfg\.fingerprint,\s*\n\s*version: cfg\.version,/);
  assert.match(bodyProxy, /res\.set\('X-LT-Nt-Read-Id', readId\)/);
  assert.match(bodyProxy, /res\.json\(body\)/);

  const claimStart = route.indexOf("router.post('/body-provenance'");
  const claim = route.slice(claimStart);
  const takeAt = claim.indexOf('takeReadReceipt(readId, u)');
  const matchAt = claim.indexOf('readMatchesClaim(receipt, candidate)');
  const versionAt = claim.indexOf('receipt.version !== saved.version');
  const casAt = claim.indexOf('claimProvenance(db, u, candidate)');
  assert.ok(takeAt > 0 && matchAt > takeAt && versionAt > matchAt && casAt > versionAt,
    'the receipt, its fingerprint and its version are matched before anything is fixed');
  assert.match(claim, /code: 'read-receipt-missing'/);
  assert.match(claim, /code: 'read-identity-mismatch'/);
  assert.match(claim, /code: 'connection-mismatch'/);

  assert.match(api, /res\.headers\.get\('X-LT-Nt-Read-Id'\)/);
  assert.match(bodySync, /status: 'read-receipt-required'/);
  const index = read('../server/index.js');
  assert.match(index, /Access-Control-Expose-Headers', 'X-LT-Coaching, X-LT-Nt-Read-Id'/);
});

test('the provenance keys are reserved against the generic settings API and device sync', () => {
  const putStart = settingsRoute.indexOf("router.put('/'");
  const putEnd = settingsRoute.indexOf("router.delete('/'", putStart);
  const put = settingsRoute.slice(putStart, putEnd);
  const guardAt = put.indexOf('isReservedProvenanceKey(key)');
  assert.ok(guardAt > 0, 'the settings PUT must refuse a reserved key');
  assert.ok(guardAt < put.indexOf('INSERT OR REPLACE INTO user_settings'),
    'and refuse it before it can replace the claim row');
  assert.match(put, /code: 'reserved-setting'/);

  assert.match(settingsRoute, /deleteUserSettingsKeepingProvenance\(db, req\.user\.id, \[NT_CONNECTION_VERSION_KEY\]\)/);
  assert.match(settingsRoute, /clearProvenance\(db, userId\)/);
  assert.match(syncRoute, /function isServerOnlyKey\(key\) \{ return isReservedProvenanceKey\(key\) \|\| isServerOwnedNtKey\(key\); \}/);
});

test('the client provenance cache follows the server record, including its absence', () => {
  const cache = read('../src/lib/nt-provenance-cache.js');
  assert.match(cache, /ntBodySyncedSource/);
  assert.match(cache, /ntBodySyncedConnectionIdentity/);
  assert.match(settings, /ntProvenanceCache\(provenance\)/);
  assert.match(settings, /export function resetNtBodyProvenanceCache/);
  assert.match(settings, /DB\.setSetting\('ntBodyLastSyncAt', null\)/);
  assert.match(read('../src/components/settings/SettingsBackup.svelte'), /resetNtBodyProvenanceCache\(\)/);
});
