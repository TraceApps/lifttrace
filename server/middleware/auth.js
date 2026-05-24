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
function _resolveSessionHours() {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const raw = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : 720;
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

export function authenticate(req, res, next) {
  // Accept token from cookie OR Authorization: Bearer header. Browser builds
  // (PWA) ride on the cookie; native Capacitor builds use the Bearer header
  // because the patched fetch in src/lib/apiFetch.js calls origFetch with
  // credentials:'omit' (Capacitor's WebView doesn't reliably persist
  // cross-launch cookies).
  let token = req.cookies?.lt_token;
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }
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
