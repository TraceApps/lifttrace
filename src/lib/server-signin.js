/**
 * Talking to a server before the app is signed in to it: the Android app's
 * first run (routes/NativeSetup.svelte), Settings → Server Connection, and
 * the sign-in page (TraceApps/notetrace#36).
 *
 * A sign-in proxy in front of the server (an Authentik or Authelia outpost,
 * Cloudflare Access) answers the app with its own web page, often with a
 * 200. That's never taken for the server, nor read as JSON ("Unexpected
 * token '<'"): it's said plainly. And when the server's sign-in options
 * can't be read, the screen says so and offers Retry, instead of quietly
 * showing a password form that may not work.
 */
import { get, writable } from 'svelte/store';
import { _ } from 'svelte-i18n';

const WEB_PAGE = "Something other than LiftTrace answered with a web page: often a sign-in proxy (Authentik, Authelia, Cloudflare Access), or this isn't your server's address. Let the app reach /api on your server.";
const OPTIONS_FAILED = "Couldn't load this server's sign-in options. Retry, or sign in with your password if the server allows it.";

/** A translated string, or the English one when i18n isn't loaded. */
function _say(key, english) {
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(key) : null;
    if (said && said !== key) return said;
  } catch { /* i18n not loaded */ }
  return english;
}

/** The error for a web page where the server's JSON should be. */
export function webPageError() {
  return Object.assign(new Error(_say('server_signin.web_page', WEB_PAGE)), { webPage: true });
}

/**
 * A reply that's neither the server's JSON nor a sign-in page: a gateway's
 * error page while the server restarts (502, 504, Cloudflare's 52x). That's
 * "can't reach the server", with the status kept for the log.
 */
function _unreachable(status) {
  return Object.assign(new Error(_say('common.errors.cant_reach_server', 'Could not reach server')), { status, unreachable: true });
}

// A web page with one of these is a sign-in proxy answering: an outpost
// that sends its sign-in page (after a redirect, or straight away with a
// 401 or 403). Anything else that isn't JSON is the server out of reach.
const _proxyStatus = (s) => (s >= 200 && s < 300) || s === 401 || s === 403;

/** Text to JSON, or null when it isn't a JSON object. */
function _parse(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

function _json(status, data) {
  if (data && typeof data === 'object') return data;
  if (data == null || (typeof data === 'string' && !data.trim())) return {};
  const j = typeof data === 'string' ? _parse(data) : null;
  if (j) return j;
  if (_proxyStatus(status)) throw webPageError();
  console.warn('[server-signin] not the server\'s JSON, status', status);
  throw _unreachable(status);
}

/**
 * The JSON a server answered, from a CapacitorHttp reply ({ status, data }),
 * which hands back text for anything it doesn't take for JSON. An empty body
 * is {}. Whatever the status, the server's own JSON comes back for the
 * caller to judge; a web page is a sign-in proxy or the server out of reach.
 */
export function serverJson(res) {
  return _json(res?.status, res?.data);
}

/** The same for a fetch() Response. */
export async function responseJson(res) {
  return _json(res.status, await res.text());
}

// CapacitorHttp, replaceable in tests.
let _httpImpl = null;
// A Capacitor plugin answers every property, `then` included, so an async
// function that returns it never settles (sign-in hung at "Checking..."):
// hand back plain methods instead.
export const _wrapHttp = (plugin) => ({ get: (o) => plugin.get(o), post: (o) => plugin.post(o) });
async function _http() {
  if (_httpImpl) return _httpImpl;
  const { CapacitorHttp } = await import('@capacitor/core');
  return _wrapHttp(CapacitorHttp);
}
export function _useHttpForTests(http) { _httpImpl = http; }

const _ok = (res) => res.status >= 200 && res.status < 300;

/**
 * The server is there and is LiftTrace: /api/health answers its own
 * { ok: true } (every version does). A sign-in proxy's page, or another
 * app's JSON, is said as such; an error status is that status.
 */
export async function serverReady(url) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/health` });
  const data = serverJson(res);
  if (!_ok(res)) throw new Error(`Server returned ${res.status}`);
  if (data.ok !== true) throw webPageError();
}

/**
 * Which ways the server offers to sign in: { providers, passwordLoginEnabled,
 * status } (status: the whole /api/auth/status answer). Throws when they
 * can't be read (no answer, an error, a web page), so the screen can say so
 * and offer Retry. A server from before SSO says nothing about it: password only.
 */
export async function discoverSignIn(url) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/auth/status` });
  const data = serverJson(res);
  if (!_ok(res)) {
    console.warn('[server-signin] sign-in options: status', res.status);
    throw _unreachable(res.status);
  }
  return {
    providers: Array.isArray(data?.oidc?.providers) ? data.oidc.providers : [],
    passwordLoginEnabled: data?.oidc?.enable_email_password_login !== false,
    status: data,
  };
}

/**
 * Who is signed in, asked natively by the Android app at startup:
 * /api/auth/status and /api/auth/me as { status, data }. The WebView's fetch
 * can't tell a sign-in proxy from no connection (its redirect to another
 * site fails as a network error); asked here, the proxy's page is read as
 * the web page it is (serverJson). No answer at all is marked `network`.
 */
export async function readSession(url, token) {
  const http = await _http();
  const base = String(url || '').trim().replace(/\/+$/, '');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const ask = (path) => http.get({ url: `${base}${path}`, headers, connectTimeout: 15000, readTimeout: 15000 })
    .catch((e) => { throw Object.assign(new Error(e?.message || 'Failed to fetch'), { network: true }); });
  const [status, me] = await Promise.all([ask('/api/auth/status'), ask('/api/auth/me')]);
  return { status, me };
}

/** Username and password sign-in: the server's { token, user }. */
export async function passwordSignIn(url, username, password) {
  const http = await _http();
  const res = await http.post({
    url: `${url}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    data: { username, password },
  });
  const body = serverJson(res);
  if (!_ok(res)) throw new Error(body.error || 'Login failed');
  return body;
}

/** The account a token signs in as, asked of a server the app isn't connected to yet. */
export async function accountFor(url, token) {
  const http = await _http();
  const res = await http.get({ url: `${url}/api/auth/me`, headers: { Authorization: `Bearer ${token}` } });
  const data = serverJson(res);
  if (!_ok(res) || !data.user) throw new Error(data.error || 'Sign-in failed');
  return data.user;
}

/** The SSO sign-in page for the app's browser hand-off (lib/oidc-app-handoff.js). */
export async function ssoSignInUrl(url, providerId) {
  const { appChallengeParam } = await import('./oidc-app-handoff.js');
  return `${url}/api/auth/oidc/login/${providerId}?mobile=1&return=${encodeURIComponent('#/')}${await appChallengeParam()}`;
}

/** A provider's logo, from the server whose options these are (not the app's current one). */
export function providerLogo(server, logo) {
  if (!logo) return '';
  return /^https?:/i.test(logo) ? logo : `${server}${logo}`;
}

// ── The sign-in options on Settings → Server Connection ───────────────
/**
 * The options for whatever address is in the field, as a store:
 * { state: '' | 'checking' | 'ok' | 'failed', providers, passwordLoginEnabled, error, url }.
 * Typing clears them at once (no buttons for the address that was there),
 * and an answer for an address that's gone is dropped. A host half typed
 * isn't an error: a failure while typing shows nothing, and is said when
 * the field is left or on Retry.
 */
export function createSignInOptions({ discover = discoverSignIn, delay = 700 } = {}) {
  const blank = { state: '', providers: [], passwordLoginEnabled: true, error: '', url: '' };
  const store = writable(blank);
  let timer = null;
  let asked = 0;
  let target = '';
  const clean = (raw) => String(raw || '').trim().replace(/\/$/, '');
  // While typing, only an address that looks whole (a dot in the host, or
  // localhost or an IP); once the field is left, any http(s) address
  // (a name on the home network, like http://nas:3002).
  const looksWhole = (url) => /^https?:\/\/([^\s/.]+\.[^\s/]*[^\s/.]|localhost|[\d.]+)(:\d+)?(\/|$)/i.test(url);
  const isAddress = (url) => /^https?:\/\/[^\s/]+/i.test(url);

  async function load(url, quiet) {
    const mine = ++asked;
    store.set({ ...blank, state: 'checking', url });
    try {
      const found = await discover(url);
      if (mine !== asked) return;
      store.set({ ...blank, state: 'ok', url, providers: found.providers, passwordLoginEnabled: found.passwordLoginEnabled });
    } catch (e) {
      if (mine !== asked) return;
      if (quiet) { store.set({ ...blank, url }); return; }
      store.set({ ...blank, state: 'failed', url, error: e?.webPage ? e.message : _say('server_signin.options_failed', OPTIONS_FAILED) });
    }
  }

  return {
    subscribe: store.subscribe,
    /** The field changed: clear what's shown, and look the address up once typing settles. */
    typed(raw) {
      clearTimeout(timer);
      asked++;
      target = clean(raw);
      store.set(blank);
      if (looksWhole(target)) timer = setTimeout(() => load(target, true), delay);
    },
    /** The field was left: look it up now, and say if that fails. */
    left(raw) {
      clearTimeout(timer);
      target = clean(raw);
      const now = get(store);
      if (!isAddress(target)) { asked++; store.set(blank); return; }
      if (now.url === target && (now.state === 'ok' || now.state === 'checking' || now.state === 'failed')) return;
      load(target, false);
    },
    retry() { clearTimeout(timer); if (target) load(target, false); },
    stop() { clearTimeout(timer); asked++; },
  };
}

// ── SSO from Settings → Server Connection ─────────────────────────────
// The phone is still in local mode while the browser is open, so the
// deep link that comes back (App.svelte) can't take the token for the
// app's own server: it hands it to Server Connection, which moves the
// phone's workouts over exactly as a password sign-in does.
const PENDING = 'lt:sso_connect';
const PENDING_FOR_MS = 30 * 60 * 1000;

export function rememberSsoConnect(url) {
  try { localStorage.setItem(PENDING, JSON.stringify({ url, at: Date.now() })); } catch { /* storage unavailable */ }
}

/** The server a Settings SSO sign-in is for, if one was started in the last half hour. */
export function pendingSsoConnect() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING) || 'null');
    if (p?.url && Date.now() - (p.at || 0) < PENDING_FOR_MS) return p;
  } catch { /* none */ }
  return null;
}

export function forgetSsoConnect() {
  try { localStorage.removeItem(PENDING); } catch { /* storage unavailable */ }
}

/** { url, token, idTokenHint, providerId } from the deep link, for Server Connection to finish. */
export const ssoConnectResult = writable(null);

/**
 * What to do with a lifttrace://oidc-callback link.
 *   { do: 'error' }                  the server said why sign-in failed
 *   { do: 'redeem', server }         swap the single-use code (server: null = the app's own)
 *   { do: 'token' }                  a bare token (a server from before the code hand-off, 1.4)
 *   { do: 'refuse' }                 a bare token for a Settings sign-in that asked for a code
 *   { do: 'expired' }                a code in local mode with no Settings sign-in waiting
 *   { do: 'none' }
 * `connecting`: the pending Settings sign-in, if any; `challengeSent`: the
 * app asked for a code (lib/oidc-app-handoff.js); `local`: the phone isn't
 * connected to a server. A bare token is taken only where it's the only way
 * an older server signs in: never for a Settings sign-in that asked for a
 * code, where any app could hand over a token of its own and have the
 * phone's workouts go to that account. A code with nowhere to go (the
 * Settings sign-in took longer than half an hour) is said, not sent off to
 * a server the app doesn't know.
 */
export function ssoCallbackAction({ code, token, error, connecting, challengeSent, local = false }) {
  if (error) return { do: 'error' };
  if (code) {
    if (connecting) return { do: 'redeem', server: connecting.url };
    return local ? { do: 'expired' } : { do: 'redeem', server: null };
  }
  if (token) return connecting && challengeSent ? { do: 'refuse' } : { do: 'token' };
  return { do: 'none' };
}

const LOGOUT_HINT = 'lt:oidc_logout_hint';

/**
 * The SSO session Log Out also ends ({ providerId, idTokenHint }), or none:
 * a password sign-in or Disconnect clears it, so an old hint never goes to
 * another server.
 */
export function keepSsoLogoutHint(hint) {
  try {
    if (hint?.providerId && hint?.idTokenHint) localStorage.setItem(LOGOUT_HINT, JSON.stringify(hint));
    else localStorage.removeItem(LOGOUT_HINT);
  } catch { /* storage unavailable */ }
}

/**
 * Server Connection's hint through a connect: held while the phone's data
 * is moved, kept only once connected, dropped on Cancel and by a password
 * sign-in, cleared on Disconnect.
 */
export function createConnectHint() {
  let held = null;
  return {
    sso(hint) { held = hint?.providerId && hint?.idTokenHint ? hint : null; },
    password() { held = null; },
    cancelled() { held = null; },
    connected() { keepSsoLogoutHint(held); held = null; },
    disconnected() { held = null; keepSsoLogoutHint(null); },
  };
}
