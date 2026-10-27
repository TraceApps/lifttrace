/**
 * The watch keeps itself on the phone's release (android/wear WatchUpdate.kt).
 * The phone says which release it runs when it pairs; the watch, installed
 * from GitHub, fetches that release's watch build and installs it. These keep
 * the two halves wired together; the watch's own logic is tested in
 * android/wear/src/test (WatchUpdateTest) and was run on a Wear OS emulator.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the phone tells the watch which release it runs when it pairs', () => {
  const js = read('../src/lib/wear-pairing.js');
  assert.match(js, /import \{ APP_VERSION \} from '\.\/version\.js';/);
  assert.match(js, /WearPairing\.pair\(\{ serverUrl, token, appVersion: APP_VERSION, httpOk: mirroredConfirmation\(serverUrl\) \}\)/);
  const plugin = read('../android/app/src/main/java/com/lifttrace/app/WearPairingPlugin.java');
  assert.match(plugin, /putString\("appVersion", call\.getString\("appVersion", ""\)\)/);
});

test('the watch knows its own exact release, from the same package.json', () => {
  const gradle = read('../android/wear/build.gradle');
  assert.match(gradle, /def release = "v" \+ new groovy\.json\.JsonSlurper\(\)\.parse\(rootProject\.file\("\.\.\/package\.json"\)\)\.version/);
  assert.match(gradle, /buildConfigField "String", "UPDATE_API", "\\"https:\/\/api\.github\.com\/repos\/TraceApps\/lifttrace\\""/);
  const version = read('../src/lib/version.js');
  const pkg = JSON.parse(read('../package.json'));
  assert.ok(version.includes(`'v${pkg.version}'`), 'APP_VERSION and package.json agree, so phone and watch name the same release');
});

test('the watch can install its update and hears how it went', () => {
  const manifest = read('../android/wear/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest, /android\.permission\.UPDATE_PACKAGES_WITHOUT_USER_ACTION/);
  assert.match(manifest, /android:name="\.UpdateResultReceiver"/);
  assert.doesNotMatch(manifest, /usesCleartextTraffic/, 'GitHub is https; nothing plain');
  const service = read('../android/wear/src/main/java/com/lifttrace/app/wear/PairingService.kt');
  assert.match(service, /Pairing\.save\(this, url, token, map\.getString\("appVersion"\)\.orEmpty\(\), map\.getString\("httpOk"\)\.orEmpty\(\)\)/);
  assert.match(service, /WatchUpdate\.check\(this\)/);
});
