/**
 * The Android app finds and uses a server's SSO sign-in, and says so when it
 * can't (TraceApps/notetrace#36).
 *
 * The report: a server with SSO, and the app's first-run sign-in showed only
 * username and password. Behind a sign-in proxy (an Authentik or Authelia
 * outpost, Cloudflare Access) every request the app made got the proxy's own
 * web page with a 200: the server check took it for the server, the sign-in
 * options couldn't be read as JSON and were quietly dropped, and signing in
 * with a password showed "Unexpected token '<'". Settings → Server Connection
 * had no SSO at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { get } from 'svelte/store';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// localStorage, as the app has it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const signin = await import('../src/lib/server-signin.js');
const WEB_PAGE = /^Something other than LiftTrace answered with a web page: often a sign-in proxy \(Authentik, Authelia, Cloudflare Access\), or this isn't your server's address\. Let the app reach \/api on your server\.$/;
const PROXY_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body>Authentik</body></html>';
const GATEWAY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';
const isWebPage = (e) => e.webPage === true && WEB_PAGE.test(e.message);
const isUnreachable = (status) => (e) => e.unreachable === true && e.status === status && !e.webPage && e.message === 'Could not reach server';

// CapacitorHttp as a table of answers: path -> { status, data }.
function fakeHttp(answers) {
  const calls = [];
  const answer = (method) => async (opts) => {
    calls.push({ method, ...opts });
    const path = new URL(opts.url).pathname;
    const a = answers[path];
    if (!a) throw new Error('Unable to resolve host');
    return typeof a === 'function' ? a(opts) : a;
  };
  return { get: answer('GET'), post: answer('POST'), calls };
}
const URL_ = 'https://lift.example.com';

test('a web page is a sign-in proxy only where a proxy sends one (2xx, 401, 403); a gateway error page is the server out of reach', async () => {
  assert.deepEqual(signin.serverJson({ status: 200, data: { ok: true } }), { ok: true });
  assert.deepEqual(signin.serverJson({ status: 200, data: '{"ok":true}' }), { ok: true }, 'CapacitorHttp may hand back text');
  assert.deepEqual(signin.serverJson({ status: 204, data: '' }), {});
  assert.deepEqual(signin.serverJson({ status: 500, data: { error: 'boom' } }), { error: 'boom' }, "the server's own error comes back to judge");
  for (const status of [200, 401, 403]) {
    for (const data of [PROXY_PAGE, 'OK']) assert.throws(() => signin.serverJson({ status, data }), isWebPage, `${status} ${data}`);
  }
  // While the server restarts: a gateway's page, not a sign-in proxy.
  for (const status of [502, 504, 521, 404]) assert.throws(() => signin.serverJson({ status, data: GATEWAY_PAGE }), isUnreachable(status), String(status));
  // The same for fetch() (the sign-in page on the web).
  const res = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(signin.responseJson(res(200, PROXY_PAGE)), isWebPage);
  await assert.rejects(signin.responseJson(res(401, PROXY_PAGE)), isWebPage);
  await assert.rejects(signin.responseJson(res(403, PROXY_PAGE)), isWebPage);
  await assert.rejects(signin.responseJson(res(502, GATEWAY_PAGE)), isUnreachable(502));
  assert.deepEqual(await signin.responseJson(new Response('{"error":"Invalid"}', { status: 401 })), { error: 'Invalid' });
});

test('the server check: LiftTrace is there, or what answered instead is said', async () => {
  signin._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data: { ok: true } } }));
  await signin.serverReady(URL_);
  // The reporter's case: a proxy's sign-in page with a 200.
  signin._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data: PROXY_PAGE } }));
  await assert.rejects(signin.serverReady(URL_), isWebPage);
  // Another app's JSON at that address.
  signin._useHttpForTests(fakeHttp({ '/api/health': { status: 200, data: { status: 'UP' } } }));
  await assert.rejects(signin.serverReady(URL_), isWebPage);
  // The server restarting behind its gateway, and an error status.
  signin._useHttpForTests(fakeHttp({ '/api/health': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.serverReady(URL_), isUnreachable(502));
  signin._useHttpForTests(fakeHttp({ '/api/health': { status: 503, data: { error: 'down' } } }));
  await assert.rejects(signin.serverReady(URL_), /Server returned 503/);
});

test('the sign-in options come from /api/auth/status, and a failure to read them is an error, not an empty list', async () => {
  const sso = { oidc: { providers: [{ id: 1, display_name: 'Authentik' }], enable_email_password_login: true } };
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: sso } }));
  const found = await signin.discoverSignIn(URL_);
  assert.deepEqual([found.providers, found.passwordLoginEnabled, found.status], [[{ id: 1, display_name: 'Authentik' }], true, sso]);
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: JSON.stringify({ oidc: { providers: [], enable_email_password_login: false } }) } }));
  assert.equal((await signin.discoverSignIn(URL_)).passwordLoginEnabled, false);
  // A server from before SSO: password only.
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: { active: true } } }));
  assert.deepEqual((await signin.discoverSignIn(URL_)).providers, []);
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 200, data: PROXY_PAGE } }));
  await assert.rejects(signin.discoverSignIn(URL_), isWebPage);
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.discoverSignIn(URL_), isUnreachable(502));
  signin._useHttpForTests(fakeHttp({ '/api/auth/status': { status: 500, data: { error: 'boom' } } }));
  await assert.rejects(signin.discoverSignIn(URL_), isUnreachable(500));
  signin._useHttpForTests(fakeHttp({}));
  await assert.rejects(signin.discoverSignIn(URL_), /Unable to resolve host/);
  // What the user reads is translatable: no status inside it.
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.doesNotMatch(en.server_signin.options_failed, /\{/);
  assert.match(en.server_signin.web_page, WEB_PAGE);
});

test('password sign-in says what went wrong, never "Unexpected token"', async () => {
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 200, data: { token: 't', user: { id: 1 } } } }));
  assert.deepEqual(await signin.passwordSignIn(URL_, 'ann', 'pw'), { token: 't', user: { id: 1 } });
  for (const status of [200, 401, 403]) {
    signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status, data: PROXY_PAGE } }));
    await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), (e) => isWebPage(e) && !/Unexpected token/.test(e.message), String(status));
  }
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 401, data: { error: 'Invalid username or password' } } }));
  await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), /Invalid username or password/);
  signin._useHttpForTests(fakeHttp({ '/api/auth/login': { status: 504, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.passwordSignIn(URL_, 'ann', 'pw'), isUnreachable(504));
});

test('an SSO sign-in from Settings: the account is asked of that server with the token, the logo comes from that server', async () => {
  const http = fakeHttp({ '/api/auth/me': { status: 200, data: { user: { id: 7, username: 'ann' } } } });
  signin._useHttpForTests(http);
  assert.deepEqual(await signin.accountFor(URL_, 'tok'), { id: 7, username: 'ann' });
  assert.equal(http.calls[0].headers.Authorization, 'Bearer tok');
  signin._useHttpForTests(fakeHttp({ '/api/auth/me': { status: 200, data: { user: null } } }));
  await assert.rejects(signin.accountFor(URL_, 'tok'), /Sign-in failed/);
  signin._useHttpForTests(fakeHttp({ '/api/auth/me': { status: 502, data: GATEWAY_PAGE } }));
  await assert.rejects(signin.accountFor(URL_, 'tok'), isUnreachable(502));
  // The sign-in page: the app hand-off, back to the start of the app.
  const url = await signin.ssoSignInUrl(URL_, 3);
  assert.match(url, /^https:\/\/lift\.example\.com\/api\/auth\/oidc\/login\/3\?mobile=1&return=%23%2F&app_challenge=[\w-]+$/);
  const { challengeSent } = await import('../src/lib/oidc-app-handoff.js');
  assert.equal(challengeSent(), true, 'asking for a code is remembered');
  assert.equal(challengeSent(), false, 'taken by the link that answers it (nutritrace#222)');
  // A relative logo is the typed server's, not the one the app had before.
  assert.equal(signin.providerLogo(URL_, '/uploads/oidc/1.png'), 'https://lift.example.com/uploads/oidc/1.png');
  assert.equal(signin.providerLogo(URL_, 'https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.equal(signin.providerLogo(URL_, null), '');
});

test('a Settings SSO sign-in is waited for half an hour, then forgotten', () => {
  signin.rememberSsoConnect(URL_);
  assert.equal(signin.pendingSsoConnect().url, URL_);
  store.set('lt:sso_connect', JSON.stringify({ url: URL_, at: Date.now() - 29 * 60 * 1000 }));
  assert.equal(signin.pendingSsoConnect().url, URL_, 'a slow MFA setup still finishes');
  store.set('lt:sso_connect', JSON.stringify({ url: URL_, at: Date.now() - 31 * 60 * 1000 }));
  assert.equal(signin.pendingSsoConnect(), null, 'an old one is forgotten');
  signin.forgetSsoConnect();
  assert.equal(store.has('lt:sso_connect'), false);
});

test('a Settings sign-in takes only the code it asked for, never a token another app hands over', () => {
  const act = signin.ssoCallbackAction;
  const connecting = { url: URL_ };
  // Settings, having asked for a code: a bare token is refused, whoever sent it.
  assert.deepEqual(act({ token: 'forged', connecting, challengeSent: true, local: true }), { do: 'refuse' });
  assert.deepEqual(act({ code: 'c1', connecting, challengeSent: true, local: true }), { do: 'redeem', server: URL_ });
  assert.deepEqual(act({ error: 'denied', code: 'c1', connecting, challengeSent: true, local: true }), { do: 'error' });
  // Without WebCrypto no code was asked for: the token is the only answer.
  // A bare token nobody here asked for is another app's (nutritrace#222).
  assert.deepEqual(act({ token: 't', connecting, challengeSent: false, local: true }), { do: 'refuse' });
  assert.deepEqual(act({ token: 't', connecting: null, challengeSent: false }), { do: 'refuse' }, 'no sign-in under way');
  // First run and after Log Out (server mode): a server from before the code
  // hand-off answers with a token, so it's still taken there.
  assert.deepEqual(act({ token: 't', connecting: null, challengeSent: true }), { do: 'token' });
  assert.deepEqual(act({ code: 'c1', connecting: null, challengeSent: true }), { do: 'redeem', server: null });
  // A code in local mode with the Settings sign-in gone (over half an hour):
  // said, never sent to a server the app doesn't know.
  assert.deepEqual(act({ code: 'c1', connecting: null, challengeSent: true, local: true }), { do: 'expired' });
  assert.deepEqual(act({}), { do: 'none' });
  const en = JSON.parse(read('../src/i18n/en.json')).server_signin;
  assert.match(en.token_refused, /older than LiftTrace 1\.4, update it, or connect with your password/);
  assert.match(en.sso_expired, /took too long\. Start again from Settings → Server Connection\./);
});

test('Settings options: typing clears them at once, an old answer is dropped, a half-typed host is no error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const answers = {};
  const discover = (url) => new Promise((resolve, reject) => { asked.push(url); answers[url] = { resolve, reject }; });
  const opts = signin.createSignInOptions({ discover, delay: 700 });
  const now = () => get(opts);
  const flush = () => new Promise((r) => setImmediate(r));
  // Server A's buttons.
  opts.typed('https://a.example.com');
  t.mock.timers.tick(700);
  answers['https://a.example.com'].resolve({ providers: [{ id: 1 }], passwordLoginEnabled: true });
  await flush();
  assert.equal(now().state, 'ok');
  assert.equal(now().providers.length, 1);
  // Typing B: A's buttons go at once, before B is even asked.
  opts.typed('https://b.example.com');
  assert.deepEqual([now().state, now().providers, now().url], ['', [], '']);
  t.mock.timers.tick(700);
  // A late answer for an address no longer in the field is dropped.
  opts.typed('https://c.example.com');
  answers['https://b.example.com'].resolve({ providers: [{ id: 2 }], passwordLoginEnabled: false });
  await flush();
  assert.deepEqual([now().providers, now().passwordLoginEnabled], [[], true]);
  // A half-typed host isn't looked up while typing; once settled, a failure
  // while typing shows nothing; leaving the field says it.
  const before = asked.length;
  opts.typed('https://lift');
  t.mock.timers.tick(700);
  assert.equal(asked.length, before, 'no request for a host without a dot');
  opts.typed('https://lift.exa');
  t.mock.timers.tick(700);
  answers['https://lift.exa'].reject(new Error('Unable to resolve host'));
  await flush();
  assert.deepEqual([now().state, now().error], ['', '']);
  opts.left('https://lift.exa');
  answers['https://lift.exa'].reject(new Error('Unable to resolve host'));
  await flush();
  assert.equal(now().state, 'failed');
  assert.match(now().error, /sign-in options/);
  // A proxy's page is said as such.
  opts.retry();
  assert.equal(now().state, 'checking');
  answers['https://lift.exa'].reject(signin.webPageError());
  await flush();
  assert.match(now().error, WEB_PAGE);
  // A cleared field shows nothing; a name on the home network is looked up when left.
  opts.typed('');
  assert.deepEqual(now(), { state: '', providers: [], passwordLoginEnabled: true, error: '', url: '' });
  opts.left('http://nas:3002');
  assert.equal(asked.at(-1), 'http://nas:3002');
  opts.stop();
});

test('the SSO session hint is kept only once connected, never for a password connect, a cancel or after Disconnect', () => {
  const HINT = 'lt:oidc_logout_hint';
  const hint = { providerId: '1', idTokenHint: 'h' };
  // SSO, then the merge choice cancelled: nothing kept.
  let c = signin.createConnectHint();
  c.sso(hint);
  assert.equal(store.has(HINT), false, 'not while the data is still being moved');
  c.cancelled();
  c.connected();
  assert.equal(store.has(HINT), false);
  // SSO, connected: kept.
  c = signin.createConnectHint();
  c.sso(hint);
  c.connected();
  assert.equal(store.get(HINT), JSON.stringify(hint));
  // A password connect after it: an earlier SSO's hint never goes to this server.
  c = signin.createConnectHint();
  c.sso(hint);
  c.password();
  c.connected();
  assert.equal(store.has(HINT), false);
  // Disconnect clears it.
  signin.keepSsoLogoutHint(hint);
  signin.createConnectHint().disconnected();
  assert.equal(store.has(HINT), false);
  // Half a hint is none.
  c = signin.createConnectHint();
  c.sso({ providerId: '1' });
  c.connected();
  assert.equal(store.has(HINT), false);
});

// The screens use the helpers above (checked in the source: they're Svelte
// components the node tests can't run).
test('the screens use them: first run, Settings, the sign-in page, and the deep link', () => {
  const setup = read('../src/routes/NativeSetup.svelte');
  assert.doesNotMatch(setup, /leave defaults/, 'no quiet fallback to a password-only form');
  assert.match(setup, /await serverReady\(url\);\n\s*validatedUrl = url;\n\s*await loadSignInOptions\(\);/);
  assert.match(setup, /const data = await passwordSignIn\(validatedUrl, username\.trim\(\), password\);/);
  const settings = read('../src/routes/Settings.svelte');
  // Leaving the field looks the address up, after a plain-HTTP address's warning (TraceApps/nutritrace#194).
  assert.match(settings, /on:input=\{\(\) => signinOptions\.typed\(serverUrlInput\)\} on:blur=\{addressLeft\}/);
  assert.match(settings, /async function addressLeft\(\) \{[\s\S]{0,400}signinOptions\.left\(serverUrlInput\);/);
  assert.match(settings, /src=\{providerLogo\(signinFor, p\.logo_url\)\}/);
  assert.match(settings, /connectHint\.connected\(\);\n\s*setServerUrl\(_pendingServerUrl\);/);
  assert.match(settings, /function cancelMerge\(\) \{\n\s*connectHint\.cancelled\(\);/);
  assert.match(settings, /connectHint\.password\(\);/);
  assert.match(settings, /connectHint\.disconnected\(\);/);
  assert.match(settings, /async function connectServerSso\(provider\) \{[\s\S]{0,260}if \(serverConnecting\) return;/);
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /if \(isNative\) data = \(await discoverSignIn\(getServerUrl\(\)\)\)\.status;/);
  assert.match(login, /const data = await responseJson\(res\);\n\s*if \(!res\.ok\) \{ showError\(data\.error/);
  assert.match(login, /\{#if optionsError && !\$serverProblem\}[\s\S]*on:click=\{loadSignInOptions\}/);
  assert.match(login, /disabled=\{ssoOpening\}/);
  const app = read('../src/App.svelte');
  assert.match(app, /const action = signin\.ssoCallbackAction\(\{ code, token, error: errMsg, connecting, challengeSent: challengeSent\(\), local \}\);/);
  assert.match(app, /const data = await redeemHandoff\(code, action\.server\);/);
});

test('the native HTTP plugin is handed over as plain methods, so awaiting it settles', async () => {
  const { _wrapHttp } = await import('../src/lib/server-signin.js');
  // Like a Capacitor plugin: every property is a function, `then` included,
  // and that `then` never calls back.
  const plugin = new Proxy({}, { get: (_, key) => (key === 'then' ? () => {} : async (o) => ({ status: 200, data: { key, url: o.url } })) });
  const settles = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
  assert.equal(await settles((async () => plugin)()), false, 'the plugin itself never settles');
  const http = await (async () => _wrapHttp(plugin))();
  assert.deepEqual(await http.get({ url: 'https://x' }), { status: 200, data: { key: 'get', url: 'https://x' } });
  assert.deepEqual((await http.post({ url: 'https://y' })).data.key, 'post');
});
