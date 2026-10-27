/**
 * What the app opens on at startup, from what the server said about the
 * session (stores/auth.js applies it). Kept free of the browser and the
 * app's stores so it can be tested on its own.
 *
 * Never the app with no account: when the server's answer can't be read
 * (no connection, a gateway's error page while the server restarts, a
 * sign-in proxy's page, an empty reply), a server with accounts gets the
 * sign-in page saying why, with Retry. Before, those answers were taken for
 * a server without accounts and the app opened for nobody.
 */

/**
 * The server's own answer: /api/auth/status says whether there are accounts
 * and /api/auth/me who is signed in (every release since 0.10.1 sends both).
 * Anything else (an empty reply, a page, an error) says nothing about either.
 */
function _answered(status, me) {
  return !!status && !!me && typeof status.active === 'boolean'
    && Object.prototype.hasOwnProperty.call(me, 'user');
}

/**
 * @param {object} o
 * @param {object|null} o.status   /api/auth/status as read, or null
 * @param {object|null} o.me       /api/auth/me as read, or null
 * @param {Error|null}  o.error    why they couldn't be read: webPage (a sign-in
 *   proxy's page), serverError (the server answered with an error of its own)
 * @param {string|null} o.known    what the server last said: '1' accounts,
 *   '0' single-user, null never (an install from before this was kept)
 * @param {boolean} o.native         the Android app (connected to a server)
 * @param {object|null} o.claims     the Android app's session token, read
 * @param {boolean} o.cachedUser     an account is kept on this device
 * @param {boolean} o.networkFailure no connection at all (not a page, not an error)
 * @returns {{ open: 'server', active: boolean, setupRequired: boolean, user: object|null }
 *   | { open: 'single', answered: boolean } | { open: 'session', user: object }
 *   | { open: 'as-is' } | { open: 'as-before' }
 *   | { open: 'signin', problem: 'unreachable'|'web_page'|'server_error' }}
 */
export function authPlan({ status, me, error = null, known = null, native = false, claims = null, cachedUser = false, networkFailure = false }) {
  if (!error && _answered(status, me)) {
    const user = me.user || null;
    if (!status.active && !user) return { open: 'single', answered: true };
    return { open: 'server', active: status.active, setupRequired: !!status.setup_required, user };
  }
  // A server without accounts last time opens to the app, as it does
  // offline. The Android app leaves it as it always has.
  if (known === '0') return native ? { open: 'as-is' } : { open: 'single', answered: false };
  // The Android app keeps working on the account in its session.
  if (native && claims?.id != null) return { open: 'session', user: { id: claims.id, username: claims.username, role: claims.role } };
  // Updated from a version that didn't keep what the server said, nobody
  // kept here, and simply no connection: it may well be a single-user
  // install, so it opens as it always did, and nothing is remembered.
  if (known == null && !cachedUser && networkFailure) return { open: 'as-before' };
  return { open: 'signin', problem: error?.webPage ? 'web_page' : error?.serverError ? 'server_error' : 'unreachable' };
}

/**
 * The Android app, connected to a server with accounts, with no session
 * (signed out): the sign-in page from the first frame, not the app until
 * the server answers. Only when the server is known to have accounts: a
 * single-user one needs no session.
 */
export function signedOutAtLaunch({ native, serverMode, token, known }) {
  return !!native && !!serverMode && !token && known === '1';
}

/** The session token's claims (a JWT's middle part), or null. */
export function tokenClaims(token) {
  try {
    return JSON.parse(atob(String(token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

/** The sign-in page's line for a problem; on the web, a proxy's page means its own sign-in ran out. */
export function problemKey(problem, native) {
  if (problem === 'web_page' && !native) return 'server_signin.proxy_sign_in';
  return `server_signin.${problem}`;
}
