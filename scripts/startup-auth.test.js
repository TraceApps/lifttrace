/**
 * What the app opens on when the server can't say who is signed in.
 *
 * The web app read /api/auth/status and /api/auth/me at startup; when they
 * couldn't be read (a gateway's error page while the server restarts, a
 * sign-in proxy's page, no connection), it took that for a server without
 * accounts and opened the app for nobody: no sign-in page, no account,
 * empty screens. Android, signed out, showed the app until the server
 * answered.
 *
 * Now a server with accounts gets the sign-in page saying why, with Retry;
 * single-user servers still open straight to the app; an install updated
 * from before any of this was kept opens as it did with no connection; and
 * only the server's own answer is ever remembered as "single-user".
 *
 * The plan (lib/auth-plan.js) is tested on its own, then the real store
 * (stores/auth.js) applying it, with what it imports from the browser and
 * Capacitor swapped for stand-ins (auth-store-hooks.mjs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { get } from 'svelte/store';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { authPlan, signedOutAtLaunch, tokenClaims, problemKey } = await import('../src/lib/auth-plan.js');

// ── The plan ────────────────────────────────────────────────────────────
const ACCOUNTS = { active: true, setup_required: false };
const SINGLE = { active: false, setup_required: false };
const ANN = { id: 7, username: 'ann', role: 'admin' };
const webPage = Object.assign(new Error('a web page'), { webPage: true });
const gateway = Object.assign(new Error('Could not reach server'), { status: 502, unreachable: true });
const serverErr = Object.assign(new Error('status 500'), { status: 500, serverError: true });

test('the server\'s own answer: accounts, single-user, setup', () => {
  assert.deepEqual(authPlan({ status: ACCOUNTS, me: { user: ANN } }), { open: 'server', active: true, setupRequired: false, user: ANN });
  assert.deepEqual(authPlan({ status: ACCOUNTS, me: { user: null } }), { open: 'server', active: true, setupRequired: false, user: null });
  assert.deepEqual(authPlan({ status: SINGLE, me: { user: null } }), { open: 'single', answered: true });
});

test('an empty or partial reply is not an answer, so never "single-user"', () => {
  for (const [status, me] of [[{}, {}], [{ active: 'false' }, { user: null }], [SINGLE, {}], [null, { user: null }]]) {
    for (const native of [false, true]) {
      const plan = authPlan({ status, me, known: '1', native, claims: native ? ANN : null });
      assert.notEqual(plan.open, 'single', JSON.stringify({ status, me, native }));
      assert.equal(plan.open, native ? 'session' : 'signin');
    }
  }
});

test('the sign-in page says why: no connection, a sign-in proxy, or the server\'s own error', () => {
  assert.deepEqual(authPlan({ error: gateway, known: '1' }), { open: 'signin', problem: 'unreachable' });
  assert.deepEqual(authPlan({ error: webPage, known: '1' }), { open: 'signin', problem: 'web_page' });
  assert.deepEqual(authPlan({ error: serverErr, known: '1' }), { open: 'signin', problem: 'server_error' });
  assert.deepEqual(authPlan({ status: { offline: true }, me: { offline: true }, known: '1', networkFailure: true }), { open: 'signin', problem: 'unreachable' });
  // The web's line for a proxy's page is about its sign-in; the app's, about letting it reach /api.
  assert.equal(problemKey('web_page', false), 'server_signin.proxy_sign_in');
  assert.equal(problemKey('web_page', true), 'server_signin.web_page');
  assert.equal(problemKey('unreachable', false), 'server_signin.unreachable');
});

test('single-user last time opens to the app; Android keeps its session', () => {
  assert.deepEqual(authPlan({ error: gateway, known: '0' }), { open: 'single', answered: false });
  assert.deepEqual(authPlan({ error: gateway, known: '0', native: true }), { open: 'as-is' });
  assert.deepEqual(authPlan({ error: gateway, known: '1', native: true, claims: ANN }), { open: 'session', user: ANN });
  assert.deepEqual(authPlan({ error: gateway, known: '1', native: true }), { open: 'signin', problem: 'unreachable' });
});

test('updated from before: nothing remembered and simply no connection opens as before; anything else signs in', () => {
  const offline = { status: { offline: true }, me: { offline: true }, networkFailure: true };
  assert.deepEqual(authPlan({ ...offline, known: null }), { open: 'as-before' });
  assert.deepEqual(authPlan({ error: new TypeError('Failed to fetch'), known: null, networkFailure: true }), { open: 'as-before' });
  assert.equal(authPlan({ ...offline, known: '1' }).open, 'signin', 'known to have accounts');
  assert.equal(authPlan({ ...offline, known: null, cachedUser: true }).open, 'signin', 'an account kept here');
  assert.equal(authPlan({ error: webPage, known: null }).open, 'signin', 'a web page');
  assert.equal(authPlan({ error: gateway, known: null }).open, 'signin', 'a gateway\'s 5xx');
  assert.equal(authPlan({ error: serverErr, known: null }).open, 'signin', 'the server\'s error');
});

test('Android signed out starts on the sign-in page only when the server has accounts', () => {
  assert.equal(signedOutAtLaunch({ native: true, serverMode: true, token: null, known: '1' }), true);
  for (const [o, why] of [
    [{ native: true, serverMode: true, token: 'x.y.z', known: '1' }, 'signed in'],
    [{ native: true, serverMode: true, token: null, known: '0' }, 'single-user'],
    [{ native: true, serverMode: true, token: null, known: null }, 'not known yet'],
    [{ native: true, serverMode: false, token: null, known: '1' }, 'no server'],
    [{ native: false, serverMode: true, token: null, known: '1' }, 'the web asks the server'],
  ]) assert.equal(signedOutAtLaunch(o), false, why);
  const jwt = `h.${Buffer.from(JSON.stringify(ANN)).toString('base64url')}.s`;
  assert.deepEqual(tokenClaims(jwt), ANN);
  assert.equal(tokenClaims('not-a-token'), null);
});

// ── The real store ──────────────────────────────────────────────────────
register('./auth-store-hooks.mjs', import.meta.url);
const kept = new Map();
globalThis.localStorage = {
  getItem: (k) => (kept.has(k) ? kept.get(k) : null),
  setItem: (k, v) => kept.set(k, String(v)),
  removeItem: (k) => kept.delete(k),
  key: (i) => [...kept.keys()][i] ?? null,
  get length() { return kept.size; },
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status, body = '<!doctype html><title>Sign in</title>') => () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const empty = (status = 200) => () => new Response(null, { status });
const refused = () => { throw new TypeError('Failed to fetch'); };
// What fetch hands back for a redirect it was told not to follow.
const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false, text: async () => '' });
let asked = [];
let nativeAsked = [];
const signin = await import('../src/lib/server-signin.js');
const jwt = (u) => `h.${Buffer.from(JSON.stringify(u)).toString('base64url')}.s`;

let cases = 0;
/** A device: what it keeps, what the server (or what answers for it) says, and the store loading on it. */
async function device({ native = false, token = null, keep = {}, status, me }) {
  kept.clear();
  for (const [k, v] of Object.entries(keep)) kept.set(k, v);
  globalThis.__auth = { native, serverUrl: native ? 'https://lift.example.com' : null, token, settings: { localUserName: 'Solo' } };
  asked = [];
  nativeAsked = [];
  const pick = (url) => (String(url).includes('/api/auth/status') ? status : me);
  globalThis.fetch = async (url, init) => { asked.push(init || {}); return pick(url)(); };
  // The app asks natively (CapacitorHttp): { status, data }, JSON already
  // read, anything else as text; no answer at all rejects.
  signin._useHttpForTests({
    get: async (o) => {
      nativeAsked.push(o);
      const r = await pick(o.url)();
      const text = await r.text();
      let data = text;
      if (/json/.test(r.headers?.get?.('content-type') || '')) { try { data = JSON.parse(text); } catch { /* as text */ } }
      return { status: r.status, data };
    },
  });
  const auth = await import(`../src/stores/auth.js?case=${++cases}`);
  await auth.loadAuthState();
  return {
    auth,
    shows: get(auth.userMgmtActive) && !get(auth.currentUser) ? 'signin' : 'app',
    user: get(auth.currentUser),
    problem: get(auth.serverProblem),
    known: kept.get('lt:userMgmt') ?? null,
  };
}

test('store: an empty reply never turns a server with accounts into single-user', async () => {
  const web = await device({ keep: { 'lt:userMgmt': '1' }, status: empty(), me: empty(204) });
  assert.equal(web.shows, 'signin');
  assert.equal(web.known, '1', 'never remembered as single-user');
  const app = await device({ native: true, token: jwt(ANN), keep: { 'lt:userMgmt': '1' }, status: empty(), me: empty() });
  assert.equal(app.user?.id, 7, 'the session\'s account, not the local user');
  assert.equal(app.known, '1');
});

test('store: a server with accounts that can\'t be read shows the sign-in page saying why', async () => {
  for (const [status, me, problem] of [
    [html(502, '<html>502 Bad Gateway</html>'), html(502, '<html>502 Bad Gateway</html>'), 'unreachable'],
    [html(200), html(200), 'web_page'],
    [json(500, { error: 'boom' }), json(200, { user: null }), 'server_error'],
    [json(429, { error: 'Too many requests' }), json(429, { error: 'Too many requests' }), 'server_error'],
    [refused, refused, 'unreachable'],
  ]) {
    const d = await device({ keep: { 'lt:userMgmt': '1' }, status, me });
    assert.deepEqual([d.shows, d.problem, d.known], ['signin', problem, '1'], problem);
  }
});

test('store: a real single-user answer is remembered and opens the local user; silence is not', async () => {
  const d = await device({ status: json(200, SINGLE), me: json(200, { user: null }) });
  assert.deepEqual([d.shows, d.known, d.user?.id, d.user?.full_name], ['app', '0', 1, 'Solo']);
  assert.equal(kept.has('wl:userId'), false, 'single-user settings stay where they are');
  const off = await device({ keep: { 'lt:userMgmt': '0' }, status: refused, me: refused });
  assert.deepEqual([off.shows, off.known, off.user?.full_name], ['app', '0', 'Solo'], 'single-user, unreachable');
});

test('store: an install updated from before opens as it did with no connection, remembering nothing', async () => {
  const d = await device({ status: refused, me: refused });
  assert.deepEqual([d.shows, d.known, d.problem], ['app', null, null]);
  const offlineCopy = await device({ status: json(503, { error: 'Offline.', offline: true }), me: json(503, { error: 'Offline.', offline: true }) });
  assert.deepEqual([offlineCopy.shows, offlineCopy.known], ['app', null], 'the offline layer\'s answer');
  // A page or a 5xx is not "no connection".
  const page = await device({ status: html(200), me: html(200) });
  assert.deepEqual([page.shows, page.problem, page.known], ['signin', 'web_page', null]);
  const gw = await device({ status: html(502), me: html(502) });
  assert.deepEqual([gw.shows, gw.problem], ['signin', 'unreachable']);
  // An account kept here: signed in on a server with accounts.
  const keptUser = await device({ keep: { 'wl:userId': '7' }, status: refused, me: refused });
  assert.equal(keptUser.shows, 'signin');
});

test('store: signed in on a server with accounts opens the account and remembers it', async () => {
  const d = await device({ status: json(200, ACCOUNTS), me: json(200, { user: ANN }) });
  assert.deepEqual([d.shows, d.user?.username, d.known, d.problem], ['app', 'ann', '1', null]);
  assert.equal(globalThis.__auth.serverSettingsLoaded, true);
  // Back from a problem: the notice goes.
  const after = await device({ keep: { 'lt:userMgmt': '1' }, status: refused, me: refused });
  assert.equal(after.problem, 'unreachable');
});

test('store: Android signed out shows the sign-in page before the server answers', async () => {
  kept.clear(); kept.set('lt:userMgmt', '1');
  globalThis.__auth = { native: true, serverUrl: 'https://lift.example.com', token: null };
  const auth = await import(`../src/stores/auth.js?case=${++cases}`);
  assert.equal(get(auth.userMgmtActive), false, 'nothing decided yet');
  auth.launchState();
  assert.deepEqual([get(auth.userMgmtActive), get(auth.currentUser)], [true, null]);
  // Signed in: the session's account from the first frame, so the check of
  // the phone's copy starts there (no app with nobody in it first).
  kept.clear(); kept.set('lt:userMgmt', '1');
  globalThis.__auth = { native: true, serverUrl: 'https://lift.example.com', token: jwt(ANN) };
  const signedIn = await import(`../src/stores/auth.js?case=${++cases}`);
  signedIn.launchState();
  assert.deepEqual([get(signedIn.userMgmtActive), get(signedIn.currentUser)?.id], [true, 7]);
  // Never known to have accounts, single-user, or on the web: left for the server to say.
  for (const [native, token, known] of [[true, jwt(ANN), null], [true, null, null], [true, jwt(ANN), '0'], [false, jwt(ANN), '1']]) {
    kept.clear(); if (known) kept.set('lt:userMgmt', known);
    globalThis.__auth = { native, serverUrl: native ? 'https://lift.example.com' : null, token };
    const a = await import(`../src/stores/auth.js?case=${++cases}`);
    a.launchState();
    assert.deepEqual([get(a.userMgmtActive), get(a.currentUser)], [false, null], `native ${native}, token ${!!token}, known ${known}`);
  }
});

test('store: on the web a sign-in proxy\'s redirect is the proxy, not "can\'t reach"', async () => {
  for (const [status, me] of [[opaqueRedirect, opaqueRedirect], [opaqueRedirect, json(200, { user: null })]]) {
    const d = await device({ keep: { 'lt:userMgmt': '1' }, status, me });
    assert.deepEqual([d.shows, d.problem], ['signin', 'web_page']);
    assert.ok(asked.length === 2 && asked.every((i) => i.redirect === 'manual'), 'asked not to follow redirects');
  }
  // Updated from before, no connection remembered: a redirect isn't "no connection".
  const fresh = await device({ status: opaqueRedirect, me: opaqueRedirect });
  assert.deepEqual([fresh.shows, fresh.problem], ['signin', 'web_page']);
});

test('store: the app asks natively, so a sign-in wall\'s page is the web page, not "can\'t reach"', async () => {
  // Signed out (no session), behind a wall that answers every path with its page.
  const wall = await device({ native: true, keep: { 'lt:userMgmt': '1' }, status: html(200), me: html(200) });
  assert.deepEqual([wall.shows, wall.problem], ['signin', 'web_page']);
  assert.equal(asked.length, 0, 'not through the WebView');
  assert.ok(nativeAsked.some((o) => o.url === 'https://lift.example.com/api/auth/status'));
  // Signed in: asked with the session, and the account comes back.
  const signedIn = await device({ native: true, token: jwt(ANN), keep: { 'lt:userMgmt': '1' }, status: json(200, ACCOUNTS), me: json(200, { user: ANN }) });
  assert.equal(signedIn.user?.username, 'ann');
  assert.ok(nativeAsked.every((o) => o.headers?.Authorization === `Bearer ${jwt(ANN)}`));
  // No connection: the session's account (offline); signed out, the sign-in page saying so.
  const offline = await device({ native: true, token: jwt(ANN), keep: { 'lt:userMgmt': '1' }, status: refused, me: refused });
  assert.deepEqual([offline.shows, offline.user?.id], ['app', 7]);
  const offlineOut = await device({ native: true, keep: { 'lt:userMgmt': '1' }, status: refused, me: refused });
  assert.deepEqual([offlineOut.shows, offlineOut.problem], ['signin', 'unreachable']);
});

// ── Wiring ──────────────────────────────────────────────────────────────
test('App and the sign-in page use them', () => {
  assert.match(read('../src/App.svelte'), /let authLoaded = isNative;\n\s*launchState\(\);/, 'before the first render');
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /\{#if \$serverProblem\}[\s\S]{0,200}\$_\(problemKey\(\$serverProblem, isNative\)\)[\s\S]{0,200}on:click=\{recheckServer\}/, 'resolved at render');
  assert.match(login, /await loadAuthState\(\);\n[^\n]*\n\s*if \(!isNative && get\(setupRequired\)\) \{ push\('\/wizard'\); return; \}/, 'a fresh install goes to setup');
  assert.match(login, /<svelte:window on:online=\{_backOnline\} \/>/);
  const en = JSON.parse(read('../src/i18n/en.json')).server_signin;
  for (const k of ['unreachable', 'server_error', 'proxy_sign_in', 'web_page', 'retry']) assert.ok(en[k], k);
  assert.match(en.proxy_sign_in, /asking you to sign in/);
  assert.equal(en.unreachable, "Can't reach your server right now. Check that it's running, then Retry.");
});
