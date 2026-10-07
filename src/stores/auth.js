import { writable } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl, apiUrl, setAuthToken, getAuthToken } from '../lib/platform.js';
import { clearPhotoBlobs } from '../lib/photo-blobs.js';

export const currentUser = writable(null);
export const userMgmtActive = writable(false);
export const setupRequired = writable(false);
// Why the last sign-in didn't stick, if it didn't ('http' | 'dropped'), so
// the login page can say so. A store, not page state, because the login page
// is torn down and rebuilt when the user flips on and back off. See
// lib/cookie-check.js.
export const signInProblem = writable(null);

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

export async function loadAuthState() {
  // Native standalone: use the synthetic local user, skip all HTTP calls.
  if (isNative && !getServerUrl()) {
    userMgmtActive.set(false);
    setupRequired.set(false);
    await _hydrateLocalUser();
    return;
  }

  try {
    const [statusRes, meRes] = await Promise.all([
      fetch('/api/auth/status', { credentials: 'include' }),
      fetch('/api/auth/me',     { credentials: 'include' }),
    ]);
    const statusData = await statusRes.json();
    const meData     = await meRes.json();
    const user       = meData.user || null;
    // With no connection and nothing seen yet, neither answer says anything
    // about who is signed in. Leave what's on screen alone rather than
    // deciding from silence that this is a single-user instance.
    if (statusData?.offline || meData?.offline) {
      // Signed out on a server with accounts: the sign-in screen, even with
      // no connection, never the last account's data.
      // Signed in: the account in the session, so the account check sees the
      // same account and the app opens on its data.
      let known = null;
      try { known = localStorage.getItem('lt:userMgmt'); } catch { /* none */ }
      if (isNative && known !== '0') {
        let claims = null;
        try { claims = JSON.parse(atob(String(getAuthToken() || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { claims = null; }
        userMgmtActive.set(true);
        currentUser.set(claims?.id != null ? { id: claims.id, username: claims.username, role: claims.role } : null);
      }
      return;
    }
    const active     = !!statusData.active;
    try { localStorage.setItem('lt:userMgmt', active ? '1' : '0'); } catch { /* none */ }
    userMgmtActive.set(active);
    setupRequired.set(!!statusData.setup_required);

    // PWA single-user mode (server reachable, user mgmt off): hydrate the
    // synthetic LOCAL_USER from local settings so $currentUser is never
    // null. Mirrors native standalone — keeps Sidebar / Trace / gates that
    // read $currentUser.role === 'admin' working uniformly. Don't touch
    // `wl:userId`: settings already live under the anonymous `wl_<key>`
    // prefix and switching to per-user keys would silently orphan them.
    if (!active && !user) {
      await _hydrateLocalUser({ setUserId: false });
      localStorage.removeItem('wl:userId');
      return;
    }

    currentUser.set(user);
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
  } catch {
    userMgmtActive.set(false);
    currentUser.set(null);
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
      if (!sent) {
        const waiting = await pendingCount();
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
