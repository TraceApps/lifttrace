/**
 * How the Android app enforces the plain-HTTP rule (src/lib/plain-http.js,
 * from TraceApps/nutritrace#194): the warning once per server, the backstop
 * on every request path, the watch's confirmation, images and media, native
 * players, and the web app left exactly as it was.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
beforeEach(() => store.clear());

const KEY = 'lt:plainHttpOk';
const APP = 'lifttrace';
const {
  serverAddressCheck, confirmPlainHttp, plainHttpConfirmed, requestAllowed, confirmedServerOrigin,
  mirroredConfirmation, mediaPolicy, mediaPolicyStale, blockedError, confirmedOrigins, logBlocked, canonicalServerBase,
} = await import('../src/lib/plain-http.js');
const { nativeRequestUrl, nativeRequestOptions, NativeHttp } = await import('../src/lib/native-http.js');
const { askPlainHttp, plainHttpRequest } = await import('../src/stores/plainHttp.js');
const { isOfflineError } = await import('../src/lib/offline-edits.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PAGE = `https://app.${APP}.local/#/`;

test('connecting: https goes, local http asks once per server, public http is refused', () => {
  assert.equal(serverAddressCheck('https://lt.example.com'), 'https');
  assert.equal(serverAddressCheck('http://203.0.113.10:3002'), 'refuse');
  assert.equal(serverAddressCheck('http://example.com'), 'refuse');
  assert.equal(serverAddressCheck('http://192.168.1.5@evil.com'), 'refuse');
  assert.equal(serverAddressCheck(`${APP}.lan:3002`), 'invalid');
  assert.equal(serverAddressCheck('http://10.0.2.2:3971'), 'ask');
  assert.equal(confirmPlainHttp('http://10.0.2.2:3971'), true);
  assert.equal(serverAddressCheck('http://10.0.2.2:3971'), 'confirmed');
  // Per origin: the same server with a path is the same answer, another port is not.
  assert.equal(serverAddressCheck(`http://10.0.2.2:3971/${APP}`), 'confirmed');
  assert.equal(serverAddressCheck('http://10.0.2.2:3972'), 'ask');
  // The same server written another way is the same origin.
  assert.equal(serverAddressCheck('HTTP://10.0.2.2:3971/'), 'confirmed');
});

test('only a local http address can be confirmed', () => {
  assert.equal(confirmPlainHttp('http://203.0.113.10'), false);
  assert.equal(confirmPlainHttp('https://lt.example.com'), false);
  assert.deepEqual(confirmedOrigins(), []);
  // Even a tampered list can't open a public origin.
  store.set(KEY, JSON.stringify(['http://203.0.113.10']));
  assert.equal(plainHttpConfirmed('http://203.0.113.10'), false);
  assert.equal(requestAllowed('http://203.0.113.10/api/health', PAGE), false);
  store.set(KEY, 'not json');
  assert.deepEqual(confirmedOrigins(), []);
});

test('the backstop: http only to a confirmed local server, everything else as before', () => {
  assert.equal(requestAllowed('http://10.0.2.2:3971/api/health', PAGE), false, 'local but not confirmed');
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(requestAllowed('http://10.0.2.2:3971/api/sync/push', PAGE), true);
  assert.equal(requestAllowed('http://10.0.2.2:3971/uploads/a.png', PAGE), true);
  assert.equal(requestAllowed('http://10.0.2.2:3972/api/health', PAGE), false, 'another port');
  assert.equal(requestAllowed('http://192.168.1.9/x.png', PAGE), false, 'another local host');
  assert.equal(requestAllowed('http://example.com/x', PAGE), false);
  assert.equal(requestAllowed('http://10.0.2.2:3971@example.com/x', PAGE), false);
  // https, the app's own pages, data and blob URLs are untouched.
  for (const u of ['https://api.github.com/repos/x', '/api/health', 'data:image/png;base64,AA', `blob:https://app.${APP}.local/1`, `https://app.${APP}.local/_capacitor_file_/x.jpg`]) {
    assert.equal(requestAllowed(u, PAGE), true, u);
  }
});

test('a refused request is a network error, so callers treat it as offline', () => {
  const e = blockedError('http://203.0.113.10:3002/api/health');
  assert.ok(e instanceof TypeError);
  assert.equal(e.code, 'PLAIN_HTTP_BLOCKED');
  assert.equal(e.offline, true);
  assert.equal(isOfflineError(e), true, 'queued like any offline write');
  assert.match(e.message, /203\.0\.113\.10:3002/);
  // Untranslated here (i18n isn't started in tests): the same words as en.json.
  const en = JSON.parse(read('../src/i18n/en.json')).plain_http.blocked;
  assert.equal(e.message, en.replace('{origin}', 'http://203.0.113.10:3002'));
});

test('a refusal is logged once per origin, not on every retry', () => {
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    for (let i = 0; i < 5; i++) logBlocked('http://203.0.113.10:3002/api/health');
    logBlocked('http://203.0.113.10:3002/api/sync/pull');
    logBlocked('http://203.0.113.11/x');
  } finally { console.warn = warn; }
  assert.equal(seen.length, 2);
});

test('one plain-HTTP sheet at a time: a second request is answered no', async () => {
  const first = askPlainHttp('http://10.0.2.2:3971');
  assert.equal(await askPlainHttp('http://10.0.2.2:3972'), false);
  let req; plainHttpRequest.subscribe(v => { req = v; })();
  assert.equal(req.url, 'http://10.0.2.2:3971');
  req.resolve(true); plainHttpRequest.set(null);
  assert.equal(await first, true);
});

test('CapacitorHttp: https as given, confirmed local http as the URL parser writes it, the rest refused', async () => {
  assert.equal(nativeRequestUrl('https://wger.de/a b?x=1'), 'https://wger.de/a b?x=1');
  assert.throws(() => nativeRequestUrl('http://10.0.2.2:3971/api/health'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('http://ntfy.example.com/topic'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('not a url'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('ftp://10.0.2.2/x'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  confirmPlainHttp('http://192.168.1.5:3002');
  assert.equal(nativeRequestUrl('http://192.168.1.5:3002/api/health'), 'http://192.168.1.5:3002/api/health');
  // Plain HTTP never follows a redirect (Android would resend it in cleartext); https is as before.
  assert.deepEqual(nativeRequestOptions({ url: 'http://192.168.1.5:3002/api/health', headers: { a: 1 } }),
    { url: 'http://192.168.1.5:3002/api/health', headers: { a: 1 }, disableRedirects: true });
  assert.deepEqual(nativeRequestOptions({ url: 'https://wger.de/x' }), { url: 'https://wger.de/x' });
  // Java reads "\@" differently from the URL parser; the normalized URL leaves it no room.
  assert.equal(nativeRequestUrl('http://192.168.1.5:3002\\@evil.com/api/health'), 'http://192.168.1.5:3002/@evil.com/api/health');
  // Every method the app uses is there, and each one checks first (no plugin is reached).
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'request']) {
    assert.equal(typeof NativeHttp[m], 'function', m);
    await assert.rejects(NativeHttp[m]({ url: 'http://203.0.113.10/x' }), e => e.code === 'PLAIN_HTTP_BLOCKED', m);
  }
});

test('every CapacitorHttp request goes through lib/native-http.js', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|svelte)$/.test(f)) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const offenders = files.filter(f => !f.endsWith('native-http.js'))
    .filter(f => /CapacitorHttp\s*\.\s*(get|post|put|patch|delete|request)\s*\(|\{\s*CapacitorHttp\s*\}/.test(readFileSync(f, 'latin1')));
  assert.deepEqual(offenders, []);
});

test('every native download but the APK goes through the same check', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|svelte)$/.test(f)) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  for (const f of files) {
    const src = readFileSync(f, 'latin1');
    for (const m of src.matchAll(/Filesystem\.downloadFile\(/g)) {
      const at = src.slice(m.index, m.index + 60);
      if (f.endsWith('updates.js')) continue; // https only, below
      assert.match(at, /downloadFile\(nativeRequestOptions\(/, f);
    }
  }
});

test('the watch gets the confirmation only for a confirmed local http server', () => {
  assert.equal(mirroredConfirmation('https://lt.example.com'), '');
  assert.equal(mirroredConfirmation('http://192.168.1.5:3002'), '');
  confirmPlainHttp('http://192.168.1.5:3002');
  assert.equal(mirroredConfirmation('http://192.168.1.5:3002'), 'http://192.168.1.5:3002');
  assert.equal(mirroredConfirmation(`http://192.168.1.5:3002/${APP}/`), `http://192.168.1.5:3002/${APP}`);
  // Written as the URL parser writes it, which the watch's Kotlin must rebuild exactly.
  assert.equal(mirroredConfirmation('HTTP://192.168.1.5:3002/'), 'http://192.168.1.5:3002');
  assert.equal(canonicalServerBase('http://0xC0A80105:80/lt'), 'http://192.168.1.5/lt');
  confirmPlainHttp('http://straße.local:3002');
  assert.equal(mirroredConfirmation('http://straße.local:3002'), 'http://xn--strae-oqa.local:3002');
  assert.equal(mirroredConfirmation(''), '');
  assert.equal(mirroredConfirmation(null), '');
});

test('native code gets the one origin it may use over plain HTTP: a confirmed server, never anything else', () => {
  assert.equal(confirmedServerOrigin('http://192.168.1.5:3002/lt'), '');
  assert.equal(confirmedServerOrigin('https://lt.example.com'), '');
  assert.equal(confirmedServerOrigin(null), '');
  confirmPlainHttp('http://192.168.1.5:3002');
  assert.equal(confirmedServerOrigin('http://192.168.1.5:3002/lt'), 'http://192.168.1.5:3002');
});

test('images, audio, video and frames: no http except confirmed local servers', () => {
  const base = "'self' https: data: blob: file: content:";
  const all = (extra) => ['img-src', 'media-src', 'frame-src'].map(d => `${d} ${base}${extra}`).join('; ');
  assert.equal(mediaPolicy([]), all(''));
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(mediaPolicy(), all(' http://10.0.2.2:3971'));
  assert.equal(mediaPolicy(['http://203.0.113.10', 'http://10.0.0.1:3002']), all(' http://10.0.0.1:3002'));
  // A source list can't name IPv6 or an underscore: left out, never written malformed.
  assert.equal(mediaPolicy(['http://[fd00::5]:3002', `http://${APP}_srv:3002`, 'http://nas.local:3002']), all(' http://nas.local:3002'));
});

test('the media policy is stale once a server is confirmed after start', () => {
  const atStart = mediaPolicy();
  assert.equal(mediaPolicyStale(atStart), false);
  assert.equal(mediaPolicyStale(undefined), false, 'no policy (web): never');
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(mediaPolicyStale(atStart), true);
  assert.equal(mediaPolicyStale(mediaPolicy()), false);
  const app = read('../src/App.svelte');
  const token = app.indexOf('setAuthToken(token);');
  const reload = app.indexOf('if (mediaPolicyStale(');
  assert.ok(token > 0 && reload > token, 'checked after an OIDC sign-in');
});

// A fake window for the fetch and XMLHttpRequest guard.
function fakeWindow() {
  const calls = [];
  class FakeXHR extends EventTarget {
    open(method, url) { this.url = url; }
    send() { calls.push(['xhr', this.url]); }
  }
  const win = {
    location: { href: PAGE },
    fetch: async (input) => { calls.push(['fetch', String(input?.url || input)]); return new Response('{}', { status: 200 }); },
    XMLHttpRequest: FakeXHR,
  };
  return { win, calls };
}

async function withGuard(run) {
  const { win, calls } = fakeWindow();
  const saved = globalThis.window;
  globalThis.window = win;
  try {
    const mod = await import(`../src/lib/plain-http-guard.js?${Math.random()}`);
    mod.installPlainHttpGuard();
    await run(win, calls);
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
}

test('Android fetch: refused before anything is sent, the rest as before', async () => {
  await withGuard(async (win, calls) => {
    await assert.rejects(win.fetch('http://203.0.113.10:3002/api/health'), e => e.code === 'PLAIN_HTTP_BLOCKED');
    await assert.rejects(win.fetch('http://10.0.2.2:3971/api/health'), e => e instanceof TypeError);
    await assert.rejects(win.fetch(new Request('http://203.0.113.10/x')), e => e.code === 'PLAIN_HTTP_BLOCKED');
    await assert.rejects(win.fetch(new URL('http://203.0.113.10/y')), e => e.code === 'PLAIN_HTTP_BLOCKED');
    assert.deepEqual(calls, [], 'nothing reached the network');
    confirmPlainHttp('http://10.0.2.2:3971');
    await win.fetch('http://10.0.2.2:3971/api/health');
    await win.fetch('https://api.github.com/x');
    await win.fetch('/icons/icon-192.png');
    assert.deepEqual(calls.map(c => c[1]), ['http://10.0.2.2:3971/api/health', 'https://api.github.com/x', '/icons/icon-192.png']);
  });
});

test('Android XMLHttpRequest: a refused one fails like a network error, with nothing sent', async () => {
  await withGuard(async (win, calls) => {
    const xhr = new win.XMLHttpRequest();
    const events = [];
    xhr.addEventListener('error', () => events.push('error'));
    xhr.addEventListener('loadend', () => events.push('loadend'));
    xhr.open('POST', 'http://203.0.113.10/api/backup/restore');
    xhr.send('x');
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(events, ['error', 'loadend']);
    assert.deepEqual(calls, []);
    const ok = new win.XMLHttpRequest();
    ok.open('POST', 'https://lt.example.com/api/backup/restore');
    ok.send('x');
    assert.deepEqual(calls, [['xhr', 'https://lt.example.com/api/backup/restore']]);
  });
});

test('wiring: the guards are installed for the Android app only, before the fetch interceptor', () => {
  const main = read('../src/main.js');
  const guard = main.indexOf('installPlainHttpGuard();');
  assert.ok(guard > 0 && guard < main.indexOf('installApiFetch();'), 'the guard is under every other fetch wrapper');
  assert.match(main, /if \(Capacitor\.isNativePlatform\(\)\) \{\s*installPlainHttpGuard\(\);[\s\S]*?Content-Security-Policy[\s\S]*?mediaPolicy\(\)/);
  const app = read('../src/App.svelte');
  assert.match(app, /\{#if isNative\}<PlainHttpSheetMount \/>\{\/if\}/);
});

test('wiring: both connect screens check the address before any request', () => {
  for (const [f, first] of [['../src/routes/NativeSetup.svelte', 'await serverReady(url)'], ['../src/routes/Settings.svelte', 'await serverReady(url)']]) {
    const src = read(f);
    const check = src.indexOf('serverAddressCheck(url)');
    const req = src.indexOf(first);
    assert.ok(check > 0 && req > check, `${f}: the check comes first`);
    assert.match(src, /plain === 'invalid'\) \{ showError\(\$_\('plain_http\.invalid_address'\)\); return( false)?; \}/);
    assert.match(src, /plain === 'refuse'\) \{ await askPlainHttp\(url, \{ kind: 'refuse' \}\); return( false)?; \}/);
    assert.match(src, /if \(!\(await (askPlainHttp|_askOnce)\(url\)\)\) return( false)?;\s*confirmPlainHttp\(url\);/);
  }
  const settings = read('../src/routes/Settings.svelte');
  assert.equal((settings.match(/if \(!\(await _plainHttpOk\(url\)\)\) return;/g) || []).length, 2, 'password and SSO both');
  // Leaving the field and tapping Connect share one warning: the tap waits for its answer.
  assert.match(settings, /function _askOnce\(url\) \{\s*if \(_asking\?\.url !== url\)/);
  assert.equal((settings.match(/await _askOnce\(url\)/g) || []).length, 2, 'addressLeft and _plainHttpOk');
  assert.match(settings, /discover: \(url\) => _lookupAllowed\(url\) \? discoverSignIn\(url\)/, 'nothing looked up before the warning');
  assert.match(settings, /\{#if _plainHttp\}\s*<div class="not-encrypted">/);
});

test('wiring: a saved http server is asked about at start, before auth goes to it', () => {
  const app = read('../src/App.svelte');
  const gate = app.indexOf('const plain = serverAddressCheck(saved);');
  const auth = app.indexOf('try { await loadAuthState(); } finally { authLoaded = true; }');
  assert.ok(gate > 0 && auth > gate);
  assert.match(app, /if \(plain === 'ask' \|\| plain === 'refuse'\) \{\s*authLoaded = false;/);
  assert.match(app, /askPlainHttp\(saved, \{ kind: plain, stored: true \}\)/);
});

test('wiring: the radio and music player reach plain HTTP only at your confirmed server', () => {
  const dir = '../android/app/src/main/java/com/lifttrace/app/';
  const gate = read(dir + 'PlainHttpGate.java');
  assert.match(gate, /connectionSpecs\(Collections\.singletonList\(ConnectionSpec\.MODERN_TLS\)\)/, 'https: no cleartext, a redirect to http included');
  assert.match(gate, /\.followRedirects\(false\)\s*\.followSslRedirects\(false\)\s*\.addInterceptor\(GUARD\)/, 'http: never redirected, checked first');
  const player = readFileSync(new URL(dir + 'RadioPlayerPlugin.java', import.meta.url), 'latin1');
  assert.match(player, /new OkHttpDataSource\.Factory\(_calls\)/);
  assert.doesNotMatch(player, /new OkHttpDataSource\.Factory\(_httpClient\)/);
  assert.equal((player.match(/PlainHttpGate\.setConfirmedOrigin\(call\.getString\("httpOrigin"\)\)/g) || []).length, 2, 'play and setQueue');
  assert.doesNotMatch(player, /setArtworkUri\(Uri\.parse\(/, 'every artwork goes through the gate');
  const proxy = read(dir + 'StreamProxyPlugin.java');
  assert.match(proxy, /_calls\.newCall\(req\)/);
  assert.doesNotMatch(proxy, /_http\.newCall\(/);
  const service = read(dir + 'RadioPlaybackService.java');
  assert.ok(service.indexOf('if (!PlainHttpGate.allowed(s)) return null;') < service.indexOf('url.openConnection()'));
  const np = read('../src/lib/native-player.js');
  assert.match(np, /httpOrigin: confirmedServerOrigin\(getServerUrl\(\)\),/);
  assert.match(np, /p\.setQueue\(\{ items, startIndex, httpOrigin: confirmedServerOrigin\(getServerUrl\(\)\) \}\)/);
  assert.match(read('../src/lib/stream-proxy.js'), /plugin\.start\(\{ url: upstreamUrl, httpOrigin: confirmedServerOrigin\(getServerUrl\(\)\) \}\)/);
});

test('wiring: the watch uses plain HTTP only for the server the phone confirmed, and updates over HTTPS only', () => {
  const wear = '../android/wear/src/main/java/com/lifttrace/app/wear/';
  const api = read(wear + 'LiftApi.kt');
  const base = api.indexOf('?: LocalAddress.workerBase(cfg.serverUrl, cfg.httpOk)');
  // https:// goes as saved, as before; only plain HTTP needs the phone's confirmation.
  assert.match(api, /val base = \(if \(cfg\.serverUrl\.trim\(\)\.startsWith\("https:\/\/", ignoreCase = true\)\) cfg\.serverUrl\.trim\(\) else null\)/);
  assert.ok(base > 0 && base < api.indexOf('.newCall(request)'));
  assert.match(api, /\.url\(base\.trimEnd\('\/'\) \+ path\)/);
  assert.match(api, /\.connectionSpecs\(listOf\(ConnectionSpec\.MODERN_TLS\)\)/);
  assert.match(api, /\.followRedirects\(false\)\s*\.followSslRedirects\(false\)/);
  const pairing = read(wear + 'Pairing.kt');
  assert.match(pairing, /map\.getString\("httpOk"\)/);
  assert.match(read(wear + 'PairingService.kt'), /map\.getString\("httpOk"\)/);
  assert.match(read(wear + 'WatchUpdate.kt'), /\.connectionSpecs\(listOf\(ConnectionSpec\.MODERN_TLS\)\)/);
  assert.match(read('../android/app/src/main/java/com/lifttrace/app/WearPairingPlugin.java'), /putString\("httpOk", call\.getString\("httpOk", ""\)\)/);
  assert.match(read('../src/lib/wear-pairing.js'), /httpOk: mirroredConfirmation\(serverUrl\)/);
  const xml = read('../android/wear/src/main/res/xml/network_security_config.xml');
  assert.match(xml, /<base-config cleartextTrafficPermitted="true">/);
  assert.match(read('../android/wear/src/main/AndroidManifest.xml'), /android:networkSecurityConfig="@xml\/network_security_config"/);
});

test('Android allows cleartext app-wide but keeps both trust anchors; the app enforces the rule', () => {
  for (const f of ['../android/app/src/main/res/xml/network_security_config.xml', '../android/app/src/debug/res/xml/network_security_config.xml']) {
    const xml = read(f);
    assert.match(xml, /<base-config cleartextTrafficPermitted="true">/, f);
    assert.match(xml, /<certificates src="system" \/>/, f);
    assert.match(xml, /<certificates src="user" \/>/, f);
    assert.doesNotMatch(xml, /domain-config/, f);
  }
});

test('the APK download stays on HTTPS', () => {
  const src = read('../src/lib/updates.js');
  const check = src.indexOf("if (assetUrl?.protocol !== 'https:') throw new Error('Download failed');");
  assert.ok(check > 0 && check < src.indexOf('Filesystem.downloadFile('));
});

test('every plain_http string the screens use is in en.json', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const used = new Set();
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|svelte)$/.test(f)) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  for (const f of files) for (const m of readFileSync(f, 'latin1').matchAll(/'(plain_http\.[a-z_]+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 10);
  for (const k of used) assert.equal(typeof en.plain_http[k.split('.')[1]], 'string', k);
  for (const k of ['common.close', 'common.cancel']) assert.equal(typeof k.split('.').reduce((o, p) => o?.[p], en), 'string', k);
});
