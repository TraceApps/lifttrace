import { writable, get } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl, apiUrl, setAuthToken, getAuthToken } from '../lib/platform.js';
import { clearPhotoBlobs } from '../lib/photo-blobs.js';
import { setCoachingFromServer, loadCachedCoaching, clearCoaching } from './coaching.js';
import { authPlan, signedOutAtLaunch, tokenClaims } from '../lib/auth-plan.js';
import { responseJson, serverJson, readSession, webPageError } from '../lib/server-signin.js';

export const currentUser = writable(null);
export const userMgmtActive = writable(false);
export const setupRequired = writable(false);
// Why the last sign-in didn't stick, if it didn't ('http' | 'dropped'), so
// the login page can say so. A store, not page state, because the login page
// is torn down and rebuilt when the user flips on and back off. See
// lib/cookie-check.js.
export const signInProblem = writable(null);
// Why the server couldn't say who is signed in, if it couldn't
// ('unreachable' | 'web_page' | 'server_error'): the sign-in page says so,
// with Retry (lib/auth-plan.js problemKey for the line).
export const serverProblem = writable(null);

// Synthetic local user for native standalone mode (no server configured).
// full_name + nickname + dob + gender + avatar are overridden at load time
// from the corresponding settings (set in the Wizard's name step + Profile)
// so the rest of the UI (Sidebar, Trace, Profile, etc.) can read
// $currentUser.* uniformly across server and local modes.
const LOCAL_USER = {
  id:        1,
  username:  'local',
  full_name: 'Local User',
  role:      'admin',
  email:     null,
  avatar_url: null,
  nickname:  null,
};

/** Read profile fields from local settings and set $currentUser to the
 *  synthetic LOCAL_USER. Used by both native standalone and PWA single-user
 *  so the rest of the UI can read $currentUser uniformly.
 *
 *  `setUserId` controls whether to also write `wl:userId`. Native standalone
 *  always sets it (LOCAL_USER.id=1) — its settings are keyed `wl_u1_<key>`
 *  from day one. PWA single-user does NOT set it: existing installs already
 *  have settings under the anonymous `wl_<key>` prefix, and switching to a
 *  per-user key would orphan them. */
async function _hydrateLocalUser({ setUserId = true } = {}) {
  let fullName = 'Local User';
  let nickname = null;
  let birthday = null;
  let gender   = null;
  let avatar   = null;
  try {
    const { DB } = await import('../lib/db.js');
    const _s = (k) => {
      const v = DB.getSetting(k, null);
      return (typeof v === 'string' && v.trim()) ? v.trim() : null;
    };
    fullName = _s('localUserName')     || fullName;
    nickname = _s('localUserNickname') || null;
    birthday = _s('dob')               || null;
    gender   = _s('gender')            || null;
    avatar   = _s('localUserAvatar')   || null;
  } catch {}
  currentUser.set({ ...LOCAL_USER, full_name: fullName, nickname, birthday, gender, avatar_url: avatar });
  if (setUserId) localStorage.setItem('wl:userId', String(LOCAL_USER.id));
}

function _knownUserMgmt() {
  try { return localStorage.getItem('lt:userMgmt'); } catch { return null; }
}

/**
 * Android, connected, before the server answers: signed out, the sign-in
 * page; signed in, the session's account, so the check that the phone's
 * copy is that account's runs from the first frame (not the app with
 * nobody in it, then a blank while it checks, then the app again).
 * App.svelte calls it before anything renders; loadAuthState again.
 */
export function launchState() {
  const known = _knownUserMgmt();
  if (signedOutAtLaunch({ native: isNative, serverMode: !!getServerUrl(), token: getAuthToken(), known })) {
    userMgmtActive.set(true);
    currentUser.set(null);
    return;
  }
  const claims = isNative && getServerUrl() && known === '1' ? tokenClaims(getAuthToken()) : null;
  if (claims?.id != null && get(currentUser)?.id !== claims.id) {
    userMgmtActive.set(true);
    currentUser.set({ id: claims.id, username: claims.username, role: claims.role });
  }
}

export async function loadAuthState() {
  // Native standalone: use the synthetic local user, skip all HTTP calls.
  if (isNative && !getServerUrl()) {
    userMgmtActive.set(false);
    setupRequired.set(false);
    await _hydrateLocalUser();
    return;
  }

  const known = _knownUserMgmt();
  launchState();

  // What the server says about the session. An answer that isn't its own
  // (a gateway's error page, a sign-in proxy's page, an empty reply, an
  // error) says nothing about who is signed in, and nor does no connection:
  // none is taken for a server without accounts (lib/auth-plan.js).
  let status = null, me = null, error = null;
  try {
    // On the web a sign-in proxy often answers with a redirect to its own
    // sign-in page, at another address: not followed (a redirect to another
    // site would only fail as if the server were down), but taken for what
    // it is. The app asks natively, where that page is read as one.
    let replies;
    if (isNative) {
      // The app asks natively, where a sign-in proxy's page reads as one
      // (lib/server-signin.js readSession).
      const r = await readSession(getServerUrl(), getAuthToken());
      status = serverJson(r.status);
      me     = serverJson(r.me);
      replies = [[r.status.status, status], [r.me.status, me]];
    } else {
      const ask = { credentials: 'include', redirect: 'manual' };
      const [statusRes, meRes] = await Promise.all([
        fetch('/api/auth/status', ask),
        fetch('/api/auth/me',     ask),
      ]);
      if (statusRes.type === 'opaqueredirect' || meRes.type === 'opaqueredirect') throw webPageError();
      status = await responseJson(statusRes);
      me     = await responseJson(meRes);
      replies = [[statusRes.status, status], [meRes.status, me]];
    }
    // The server's own error (JSON, a 5xx or a 429): it's there, it just
    // didn't answer this time.
    for (const [code, data] of replies) {
      if (!(code >= 200 && code < 300) && !data?.offline) throw Object.assign(new Error(`status ${code}`), { status: code, serverError: true });
    }
  } catch (e) {
    error = e;
    console.warn('[auth] who is signed in could not be read:', e?.status || e?.message);
  }
  let cachedUser = false;
  try { cachedUser = !!localStorage.getItem('wl:userId'); } catch { /* none */ }
  const networkFailure = !!(status?.offline || me?.offline) || error instanceof TypeError || !!error?.network
    || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const plan = authPlan({ status, me, error, known, native: isNative, claims: tokenClaims(getAuthToken()), cachedUser, networkFailure });

  try {
    if (plan.open !== 'server' && plan.open !== 'single') {
      if (plan.open === 'session') {
        // Android: the account in the session, so the account check sees the
        // same account and the app opens on its data.
        userMgmtActive.set(true);
        currentUser.set(plan.user);
      } else if (plan.open === 'signin') {
        // Signed out, or no telling who: the sign-in page, saying why, never
        // the app with no account.
        userMgmtActive.set(true);
        currentUser.set(null);
      } else if (plan.open === 'as-before') {
        // Updated from a version that kept nothing, with no connection: as
        // that version opened (lib/auth-plan.js), remembering nothing.
        userMgmtActive.set(false);
        currentUser.set(null);
      }
      serverProblem.set(plan.open === 'signin' ? plan.problem : null);
      // Coaching as this account last knew it (kept on this device).
      try { const uid = localStorage.getItem('wl:userId'); if (uid) loadCachedCoaching(uid); } catch { /* none */ }
      return;
    }
    serverProblem.set(null);

    // PWA single-user mode (server reachable, user mgmt off): hydrate the
    // synthetic LOCAL_USER from local settings so $currentUser is never
    // null. Mirrors native standalone — keeps Sidebar / Trace / gates that
    // read $currentUser.role === 'admin' working uniformly. Don't touch
    // `wl:userId`: settings already live under the anonymous `wl_<key>`
    // prefix and switching to per-user keys would silently orphan them.
    // A single-user server that can't be reached opens the same way, as it
    // does offline.
    if (plan.open === 'single') {
      // Remembered only from the server's own answer, never from silence.
      if (plan.answered) {
        try { localStorage.setItem('lt:userMgmt', '0'); } catch { /* none */ }
        setupRequired.set(!!status.setup_required);
      }
      userMgmtActive.set(false);
      await _hydrateLocalUser({ setUserId: false });
      localStorage.removeItem('wl:userId');
      clearCoaching();
      return;
    }

    const { active, user } = plan;
    const statusData = status, meData = me;
    try { localStorage.setItem('lt:userMgmt', active ? '1' : '0'); } catch { /* none */ }
    userMgmtActive.set(active);
    setupRequired.set(plan.setupRequired);

    currentUser.set(user);
    // Coaching: a server from before consent sends neither field, and what
    // is new stays away.
    if (user) setCoachingFromServer({ supported: statusData.coaching ?? 0, state: meData.coaching ?? null, userId: user.id });
    else clearCoaching();
    if (user) {
      try { (await import('../lib/account-gen.js')).markSignedOut(false); } catch { /* none */ }
    }
    if (user) localStorage.setItem('wl:userId', String(user.id));
    else       localStorage.removeItem('wl:userId');
    // The setting stores read this account's own values now (those kept on
    // this device only included), without waiting for a reload.
    try { (await import('./settings.js')).reloadSettingStores(); } catch { /* not loaded */ }
    // A paired watch talks to the server itself, so it needs this account's
    // address and token. Sent on every sign-in, which is also what refreshes
    // a token the watch has had refused.
    if (user && isNative) import('../lib/wear-pairing.js').then(({ pairWatch }) => pairWatch()).catch(() => {});
    if (user) await loadServerSettings();
  } catch (e) {
    // Applying what the server said failed partway (settings, coaching):
    // who is signed in stands, and the rest loads on the next start.
    console.warn('[auth] after the server answered:', e?.message);
  }
}

export async function logout() {
  // Progress-photo bytes are held as object URLs in memory. Drop them so the
  // next account on this device cannot read the previous one's photos.
  try { clearPhotoBlobs(); } catch { /* nothing cached yet */ }
  // A workout edit or a setting still waiting to save goes up now, under
  // this account (offline, into this account's queue). Never for long.
  const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  try { await within((await import('./workout.js')).flushWorkoutSave(), 4000); } catch { /* nothing waiting */ }
  try { await within((await import('./settings.js')).flushSettingSaves(), 4000); } catch { /* nothing waiting */ }
  const leavingId = localStorage.getItem('wl:userId');
  if (isNative) {
    // Signed out at once, connection or not: nothing more goes up as this
    // account, no sync runs until someone signs in (its queued changes wait
    // for its own next sign-in), and its data is off the screen now rather
    // than after the server answers.
    try {
      const { markSignedOut } = await import('../lib/account-gen.js');
      markSignedOut(true);
      await (await import('../lib/sync.js')).stopSyncForAccountChange(4000);
    } catch { /* not connected */ }
    try { await (await import('../lib/local-account.js')).forgetServerCookies(); } catch { /* none */ }
    try { setAuthToken(null); } catch { /* none */ }
    localStorage.removeItem('wl:userId');
    currentUser.set(null);
  }
  // OIDC RP-initiated logout: ask the server for an end_session URL so
  // signing out also ends the IdP session and the next sign-in isn't
  // silently completed by a still-alive IdP cookie. Mobile flag tells
  // the server to use the lifttrace://oidc-callback deep link as
  // post_logout_redirect_uri so the Capacitor browser can route back
  // into the app after the IdP destroys the session.
  let logoutUrl = null;
  try {
    const logoutPath = isNative
      ? '/api/auth/oidc/logout?mobile=1'
      : '/api/auth/oidc/logout';
    // Native clients send back the id_token_hint + providerId they were
    // handed at OIDC login time. PWA leaves the body empty and the server
    // reads the matching httpOnly cookie instead.
    let body = null;
    if (isNative) {
      try {
        const raw = localStorage.getItem('lt:oidc_logout_hint');
        if (raw) body = JSON.parse(raw);
      } catch {}
    }
    // Offline there's no session at the server to end (and the request is
    // never queued for later: see apiFetch.js).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
    const oidcRes = await fetch(apiUrl(logoutPath), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout?.(5000),
    });
    const oidcData = await oidcRes.json().catch(() => null);
    logoutUrl = oidcData?.logoutUrl || null;
    try { localStorage.removeItem('lt:oidc_logout_hint'); } catch {}
  } catch {}
  // Anything logged offline goes up before the session ends, and the copy this
  // browser keeps is cleared afterwards so the next account can't read it. If
  // it can't go up (signing out in a dead zone), ask first: clearing it would
  // destroy work the user never saw fail.
  if (!isNative) {
    try {
      const { flushOutbox, clearOffline, pendingCount } = await import('../lib/offline-api.js');
      const sent = await flushOutbox().catch(() => false);
      // Coaching messages written offline wait in their own store: they go
      // now too, and count as waiting if they can't.
      let messagesWaiting = 0;
      try {
        const m = await import('../lib/coach-messages.js');
        await m.flushCoachMessages().catch(() => {});
        messagesWaiting = (await m.pendingCoachMessages()).length;
      } catch { /* none */ }
      if (!sent || messagesWaiting) {
        const waiting = (sent ? 0 : await pendingCount()) + messagesWaiting;
        if (waiting > 0) {
          const { confirmDialog } = await import('./confirmDialog.js');
          const { get: getStore } = await import('svelte/store');
          const { _: t } = await import('svelte-i18n');
          const say = getStore(t);
          const ok = await confirmDialog({
            title: say('sync.sign_out_waiting_title'),
            message: say('sync.sign_out_waiting', { values: { count: waiting } }),
            confirmText: say('sync.sign_out_anyway'),
            dangerous: true,
          });
          if (!ok) return;
        }
      }
      await clearOffline();
    } catch { /* nothing queued, or no database */ }
  }
  try {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include', signal: AbortSignal.timeout?.(5000) });
    }
  } catch { /* the server's cookie goes with the jar on Android; on the web it expires */ }
  // Where this account stood in coaching goes with it.
  clearCoaching();
  const userId = leavingId;
  if (userId) {
    const prefix = `wl_u${userId}_`;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  }
  localStorage.removeItem('wl:userId');
  // The session itself (lt:authToken): kept, it went on syncing this
  // account's data in the background, and opened it again on the next
  // launch.
  try { setAuthToken(null); } catch { /* none */ }
  // Nothing of this account stays in memory for the next one to see or
  // save as its own (lib/user-state.js).
  try { await (await import('../lib/user-state.js')).resetUserState(); } catch { /* nothing loaded */ }
  // Wipe biometric-cached JWT too, otherwise the next launch could
  // bypass the password gate after the user explicitly signed out.
  try {
    const { clearSavedToken } = await import('../lib/biometric.js');
    await clearSavedToken();
  } catch {}
  currentUser.set(null);
  // The watch should not keep a working token for an account that signed out.
  if (isNative) import('../lib/wear-pairing.js').then(({ unpairWatch }) => unpairWatch()).catch(() => {});
  if (logoutUrl) {
    if (isNative) {
      try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: logoutUrl, presentationStyle: 'popover' });
      } catch {}
    } else {
      window.location.href = logoutUrl;
    }
  }
}
