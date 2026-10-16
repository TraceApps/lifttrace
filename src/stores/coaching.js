/**
 * coaching.js: where the signed-in person stands in coaching, and which
 * Programs tabs that gives them (the same shape as NutriTrace's).
 *
 *   Coach tab     anyone with a coach or a request waiting for an answer
 *   Coaching tab  the Trainer role and admins, as before
 *
 * Everyone else sees Programs exactly as before: no tabs, no requests, no
 * timers. The state arrives with /api/auth/me, which the app loads anyway,
 * and a read the Diary already makes (unread notes) carries a short
 * fingerprint (X-LT-Coaching); the state is asked for again only when that
 * changes. A server from before consent reports no support, and what is new
 * stays away.
 */
import { writable, derived, get } from 'svelte/store';
import { isNative, getServerUrl } from '../lib/platform.js';

const KEY = 'lt:coaching';

/** The server knows coaching with consent (its /api/auth/status says so). */
export const coachingSupported = writable(false);
/** Which coaching it knows: 1 consent, 2 the conversation too. */
export const coachingVersion = writable(0);
/** { role, can_coach, as_client: active pairing | null, requests: [{ id, coach, note, requested_at }], as_coach: { pending, active, recent }, awaiting } */
export const coachingState = writable(null);

/** Android with no server: coaching has nowhere to happen. */
export const coachingNeedsServer = () => isNative && !getServerUrl();

/** Coach tab: someone with a coach, a request waiting for their answer, or
 *  a past coach's conversation (it stays readable for the client). */
export function showsCoachTab(supported, s) {
  return !!(supported && (s?.as_client || s?.requests?.length || s?.past?.length));
}

/** The dot on Programs: something waiting for this person's answer. */
export function showsBadge(supported, s) {
  return !!(supported && s && ((Number(s.unread) || 0) > 0 || (Number(s.awaiting) || 0) > 0));
}

/** In coaching at all: a coach or a request, or the Trainer role, or an
 *  admin who coaches (or asked) someone. Settings shows the Coaching
 *  notifications only then. */
export function inCoachingNow(supported, s) {
  if (!supported || !s) return false;
  if (showsCoachTab(true, s) || s.role === 'trainer') return true;
  const c = s.as_coach || {};
  return s.role === 'admin' && ((Number(c.pending) || 0) + (Number(c.active) || 0) + (Number(c.recent) || 0)) > 0;
}

export const coachTab = derived([coachingSupported, coachingState], ([$ok, $s]) => showsCoachTab($ok, $s));
export const inCoaching = derived([coachingSupported, coachingState], ([$ok, $s]) => inCoachingNow($ok, $s));
export const coachingBadge = derived([coachingSupported, coachingState], ([$ok, $s]) => showsBadge($ok, $s));
/** Unread on the Coach tab (as a client) and the Coaching tab (as a coach). */
export const coachUnread = derived(coachingState, ($s) => (Number($s?.as_client?.unread) || 0) + ($s?.past || []).reduce((n, p) => n + (Number(p.unread) || 0), 0));
export const clientsUnread = derived(coachingState, ($s) => Number($s?.as_coach?.unread) || 0);

/** The same fingerprint the server sends, from a state the app holds. */
export function coachingSignature(s) {
  if (!s) return null;
  const c = s.as_client ? String(s.as_client.id) : '-';
  const r = (s.requests || []).map(x => x.id).join(',') || '-';
  const p = (s.past || []).map(x => x.id).join(',') || '-';
  return `${s.role || '-'};${c};${r};${Number(s.as_coach?.pending) || 0}.${Number(s.as_coach?.active) || 0};${p};${Number(s.unread) || 0};${Number(s.awaiting) || 0}`;
}

function _save(userId) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ user: userId ?? null, supported: get(coachingSupported), version: get(coachingVersion), state: get(coachingState) }));
  } catch { /* private mode */ }
}

/** What the last session knew, for an app opened with no connection. */
export function loadCachedCoaching(userId) {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (kept && kept.user != null && String(kept.user) === String(userId)) {
      coachingSupported.set(!!kept.supported);
      coachingVersion.set(Number(kept.version) || (kept.supported ? 1 : 0));
      coachingState.set(kept.state || null);
      return;
    }
  } catch { /* nothing kept */ }
  coachingSupported.set(false);
  coachingVersion.set(0);
  coachingState.set(null);
}

/** From /api/auth/status and /api/auth/me. `supported` undefined leaves it as is. */
export function setCoachingFromServer({ supported, state, userId }) {
  const before = get(coachingState);
  if (supported !== undefined) { coachingSupported.set(Number(supported) >= 1); coachingVersion.set(Number(supported) || 0); }
  if (state !== undefined) coachingState.set(state || null);
  _save(userId);
  if (state !== undefined) _keepReadable(before, state || null);
  // Someone in coaching opening the app: anything written offline goes now.
  if (state && inCoachingNow(true, state)) {
    import('../lib/coach-messages.js').then(m => m.flushCoachMessages()).catch(() => {});
  }
}

/** The conversations this account may still read: the rest go from the
 *  device, with their photo copies (a coach whose client left loses it). */
function _keepReadable(before, s) {
  // Nobody in coaching, then or now: nothing kept, nothing to look at. With
  // no connection the state may be an old copy: nothing is dropped from it.
  if (!get(coachingSupported) || (!inCoachingNow(true, before) && !inCoachingNow(true, s))) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const readable = [s?.as_client?.id, ...(s?.past || []).map(p => p.id), ...(s?.as_coach?.active_ids || [])].filter(x => x != null);
  import('../lib/coach-messages.js').then(m => m.keepConversations(readable)).catch(() => {});
}

export function clearCoaching() {
  coachingSupported.set(false);
  coachingVersion.set(0);
  coachingState.set(null);
  import('../lib/coach-photos.js').then(m => m.clearCoachPhotos()).catch(() => {});
  try {
    localStorage.removeItem(KEY);
    for (const k of Object.keys(localStorage)) if (k.startsWith('lt:coach-cursor:')) localStorage.removeItem(k);
  } catch { /* private mode */ }
}

/**
 * A coaching call: JSON in and out, and an error that says whether the
 * server was out of reach (offline), its status and code.
 */
export async function coachingFetch(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(e?.message || 'offline');
    err.offline = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.code || null;
    err.offline = !!data?.offline || res.status === 503;
    throw err;
  }
  return data;
}

/** Ask the server again (only for people in coaching, or when the fingerprint changed). */
export async function refreshCoaching() {
  if (!get(coachingSupported) || coachingNeedsServer()) return get(coachingState);
  try {
    // Whose answer this is: an account that signs out while it is on its
    // way never hands its coaching to the next one.
    const asked = localStorage.getItem('wl:userId');
    const before = get(coachingState);
    const state = await coachingFetch('GET', '/api/coaching/state');
    if (localStorage.getItem('wl:userId') !== asked) return get(coachingState);
    coachingState.set(state || null);
    _save(asked);
    _keepReadable(before, state || null);
  } catch { /* offline: keep what is known */ }
  return get(coachingState);
}

/** A read brought a fingerprint: ask again only when it moved. */
export function noteCoachingSignature(sig) {
  if (!sig || !get(coachingSupported)) return;
  if (sig === coachingSignature(get(coachingState))) return;
  refreshCoaching();
}

// The Android app shows its first screen before it has asked the server who
// is signed in, so it starts from what this account knew last time.
if (isNative) {
  try {
    const uid = localStorage.getItem('wl:userId');
    if (uid && getServerUrl()) loadCachedCoaching(uid);
  } catch { /* private mode */ }
}

// Messages written in the browser with no connection go when it comes back,
// or when the app comes to the front. Only waiting messages make a request.
if (typeof window !== 'undefined' && !isNative) {
  const flush = () => {
    if (!get(coachingSupported) || !inCoachingNow(true, get(coachingState))) return;
    import('../lib/coach-messages.js').then(m => m.flushCoachMessages()).catch(() => {});
  };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
}
