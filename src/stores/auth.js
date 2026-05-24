import { writable } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl } from '../lib/platform.js';

export const currentUser = writable(null);
export const userMgmtActive = writable(false);
export const setupRequired = writable(false);

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
    const active     = !!statusData.active;
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
    if (user) localStorage.setItem('wl:userId', String(user.id));
    else       localStorage.removeItem('wl:userId');
    if (user) await loadServerSettings();
  } catch {
    userMgmtActive.set(false);
    currentUser.set(null);
  }
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  const userId = localStorage.getItem('wl:userId');
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
  // Wipe biometric-cached JWT too, otherwise the next launch could
  // bypass the password gate after the user explicitly signed out.
  try {
    const { clearSavedToken } = await import('../lib/biometric.js');
    await clearSavedToken();
  } catch {}
  currentUser.set(null);
}
