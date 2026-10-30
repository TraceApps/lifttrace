/**
 * fresh-session.js: when the account's sessions change (nutritrace#222).
 *
 * A password change, two-step sign-in turned on or off, or Sign Out
 * Everywhere signs every session out (server/lib/session-version.js). The
 * device that made the change gets a new session in the same answer
 * (`session`: { token, csrf }), and adoptSession() puts it where this app
 * keeps its sign-in: the Android app's token (and the copy biometric unlock
 * keeps), a paired watch's (it is handed the new one), the browser's CSRF
 * token (the server set the new cookie). A watch on a phone that was signed
 * out has its token refused, keeps what it logged, and takes the phone's
 * next token once the phone signs in again.
 *
 * Every other device is told 401 with `session_ended` from then on.
 * endSessionHere() takes it to the sign-in page with a plain message
 * (stores/auth.js sessionEnded). Nothing waiting to go up is dropped: the
 * browser's queue is kept under the account (lib/offline-api.js), the
 * Android app's unsent changes stay on the phone (lib/local-account.js) and
 * a watch's on the watch, and all go up at the account's next sign-in.
 */
import { isNative, getServerUrl } from './platform.js';

/** Takes the new session an answer carries, if it carries one. */
export async function adoptSession(session) {
  if (!session || typeof session !== 'object') return;
  if (isNative && getServerUrl() && typeof session.token === 'string' && session.token) {
    const { setAuthToken } = await import('./platform.js');
    setAuthToken(session.token);
    try {
      // Biometric unlock restores its own copy: the old one no longer works.
      const { readSavedToken, saveTokenForBiometric } = await import('./biometric.js');
      if (await readSavedToken()) await saveTokenForBiometric(session.token);
    } catch { /* no biometric unlock */ }
    // A paired watch uses the phone's token: it gets the new one.
    import('./wear-pairing.js').then(({ pairWatch }) => pairWatch()).catch(() => {});
  }
  if (typeof session.csrf === 'string' && session.csrf) {
    try { localStorage.setItem('lt:csrf', session.csrf); } catch { /* no storage */ }
  }
}

// A request sent before this device took its new session (a password
// change, Sign Out Everywhere made here) can come back refused after it:
// asked again with what this device holds now (lib/apiFetch.js adds it),
// the server says whether this device is really signed out.
async function _stillSignedIn() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return false;
    return !!(await res.json())?.user;
  } catch { return false; }
}

/**
 * This device was signed out: the sign-in page, saying why. The account's
 * copy on this device and anything waiting to go up are kept for its next
 * sign-in; only the sign-in itself goes.
 */
export async function endSessionHere() {
  if (await _stillSignedIn()) return;
  const { currentUser, sessionEnded } = await import('../stores/auth.js');
  sessionEnded.set(true);
  if (isNative) {
    // No sync until someone signs in again: the queue waits for this account.
    try { (await import('./account-gen.js')).markSignedOut(true); } catch { /* none */ }
    try {
      const { setAuthToken } = await import('./platform.js');
      setAuthToken(null);
    } catch { /* nothing kept */ }
    try {
      const { clearSavedToken } = await import('./biometric.js');
      await clearSavedToken();
    } catch { /* no biometric unlock */ }
    try {
      const { forgetServerCookies } = await import('./local-account.js');
      await forgetServerCookies();
    } catch { /* none kept */ }
  }
  try {
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('lt:cachedUser');
    localStorage.removeItem('lt:csrf');
  } catch { /* no storage */ }
  currentUser.set(null);
}
