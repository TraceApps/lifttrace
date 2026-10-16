import jwt from 'jsonwebtoken';
import db from '../db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'lifttrace-dev-secret-change-in-production';

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // In production, refuse to start with the insecure dev default —
    // catches the most common self-host misconfiguration before it
    // turns into a session-forging vulnerability.
    console.error('[FATAL] JWT_SECRET must be set in production.');
    process.exit(1);
  }
  console.warn('[WARN] JWT_SECRET not set — using insecure dev default. Set JWT_SECRET in your environment for production.');
}

// Sessions cap at 1 year regardless of session_hours setting (a "0" used to
// mean ~100 years which is pretty much forever — bad incident-recovery posture).
// Override via MAX_SESSION_HOURS env var if you absolutely need a longer session.
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '8760', 10); // 1 year
// Default raised from 720h (30 days) to 8760h (1 year) on 2026-06-09 after
// users with biometric sign-in hit the silent 30-day token expiry. With
// biometric on, the JWT is essentially a refresh proxy — the actual auth
// gate is fingerprint/face on app open — so a 30-day expiry forces a
// password re-login every month without any security benefit. Admins who
// want shorter sessions still set Settings, Users, Session Duration.
function _resolveSessionHours() {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const raw = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : 8760;
  if (!Number.isFinite(raw) || raw <= 0) return MAX_SESSION_HOURS;
  return Math.min(raw, MAX_SESSION_HOURS);
}

export function userMgmtActive() {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() != null;
}

export function signToken(user) {
  const hours = _resolveSessionHours();
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: `${hours}h` },
  );
}

export function sessionMaxAge() {
  return _resolveSessionHours() * 60 * 60 * 1000;
}

/** One of this server's sessions: the signature checks out with our secret
 *  (expired or not yet valid still counts as ours). */
function _ours(token) {
  try { jwt.verify(token, JWT_SECRET); return true; }
  catch (e) { return e?.name === 'TokenExpiredError' || e?.name === 'NotBeforeError'; }
}

export function authenticate(req, res, next) {
  // Accept token from cookie OR Authorization: Bearer header. Browser builds
  // (PWA) ride on the cookie; native Capacitor builds use the Bearer header
  // because the patched fetch in src/lib/apiFetch.js calls origFetch with
  // credentials:'omit' (Capacitor's WebView doesn't reliably persist
  // cross-launch cookies).
  //
  // The header, when it carries one of this server's sessions, is the
  // session: it is set on purpose for each request. The cookie rides along
  // with whatever the client's cookie jar still holds: on Android,
  // CapacitorHttp sends the jar too, and a sign-in stored there could be
  // another account's. Read first, it answered every request as that
  // account. One of ours that has expired is no session at all, never a
  // fall-back to the cookie. A header that isn't one of ours (a reverse
  // proxy's own Authorization, oauth2-proxy and the like, or an API token,
  // which its own routes check) is left alone, and the cookie decides as
  // it always did.
  //
  // req.authVia says which one decided ('bearer' | 'cookie' | null), for any
  // check that a cookie-borne session needs and a header-borne one doesn't.
  // (This server has no CSRF middleware: the cookie is SameSite=Lax and
  // cross-origin requests are refused by the CORS allowlist, so a foreign
  // page can neither send the cookie with a write nor set a header.)
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (bearer && _ours(bearer)) {
    req.authVia = 'bearer';
    try { req.user = jwt.verify(bearer, JWT_SECRET); } catch { req.user = null; }
    return next();
  }
  let token = req.cookies?.lt_token;
  req.authVia = token ? 'cookie' : null;
  // Query-param fallback for asset URLs that go through the WebView's image
  // loader (<img src=...>) on native. Such requests can't carry a Bearer
  // header AND Capacitor's WebView doesn't reliably persist the cookie
  // across launches, so the only token channel left is the query string.
  // Only used for GET — POST/PUT requests must use cookie or Bearer.
  if (!token && req.method === 'GET' && req.query?._lt_t) {
    token = String(req.query._lt_t);
  }
  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!userMgmtActive()) return next();
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!userMgmtActive()) return next();  // single-user mode = effectively admin
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export function requireTrainerOrAdmin(req, res, next) {
  if (!userMgmtActive()) return next();
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin' && req.user.role !== 'trainer') {
    return res.status(403).json({ error: 'Trainer or admin access required' });
  }
  next();
}

/** Get user_id for DB queries: null in single-user, req.user.id in multi-user */
export function uid(req) {
  return userMgmtActive() ? req.user?.id ?? null : null;
}
