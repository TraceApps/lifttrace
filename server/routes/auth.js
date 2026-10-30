import { Router } from 'express';
import { linkBase } from '../lib/public-url.js';
import { localizeDataUrl } from '../lib/image-localizer.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { wrap } from '../logger.js';
import { signToken, sessionMaxAge, userMgmtActive, requireAuth, requireAdmin } from '../middleware/auth.js';
import { isPasswordLoginEnabled, listProviders as oidcListProviders, publicProvider as oidcPublicProvider } from '../lib/oidc.js';
import { sendPasswordReset, sendInvite, isEmailConfigured } from '../email.js';
import { estimate as estimatePasswordStrength, STRONG_MIN_SCORE } from '../lib/password-strength.js';
import { claimAnonymousData, releaseDataBeforeDisable, purgeUserRows } from '../lib/claim-anonymous-data.js';
import { deleteMediaForUser } from '../lib/body-stat-media.js';
import { deleteMediaForUser as deleteSetMediaForUser } from '../lib/set-media.js';
import { deletePhotosForUser, deleteAllPhotos } from '../lib/coaching-messages.js';
import {
  COACHING_VERSION, coachingState, requestFromInvite, requestClient, endPairing, endAsClient,
  endCoachingIfNotCoach, canCoach, roleOf, personName,
} from '../lib/coaching.js';
import { challengeFor, issuePending, isEnabled as twoStepEnabled, checkRecoveryToken } from '../lib/two-step.js';
import { freshSignIn, FRESH_SIGN_IN_MINUTES, noteEmailChange, resetRecipient } from '../lib/link-grant.js';
import { bumpSessionVersion } from '../lib/session-version.js';

const router = Router();

// ── Password validation (single source of truth) ────────────────────────────
function validatePassword(pw, userInputs = []) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a number';
  if (!/[^a-zA-Z0-9]/.test(pw)) return 'Password must include a special character';
  // When the admin enabled the strong-policy app_config, also enforce zxcvbn
  // score >= STRONG_MIN_SCORE. Default policy ('standard' / null) keeps the
  // existing rules only.
  const policy = db.prepare(`SELECT value FROM app_config WHERE key = 'password_policy'`).get()?.value;
  if (policy === 'strong') {
    const r = estimatePasswordStrength(pw, userInputs);
    if (r.score < STRONG_MIN_SCORE) {
      const tip = r.feedback?.warning || r.feedback?.suggestions?.[0] || 'Use a longer, less predictable password';
      return `Password is too weak: ${tip}`;
    }
  }
  return null;
}

// ── bcrypt cost ─────────────────────────────────────────────────────────────
// 12 = ~250 ms per hash on modern hardware. Bumped from 10 (~60 ms) for
// stronger resistance to GPU offline cracking if a DB ever leaks.
const BCRYPT_COST = 12;

// ── Rate limiting ───────────────────────────────────────────────────────────
// Two parallel buckets: per-IP (catches a single attacker hammering one
// endpoint) AND per-username (catches credential-stuffing across IPs aimed
// at one account). Both have to clear before the request proceeds.
const _ipAttempts = new Map();
const _userAttempts = new Map();
const IP_LIMIT = 10, USER_LIMIT = 6, WINDOW_MS = 15 * 60 * 1000;

function _bucketHit(map, key, limit) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + WINDOW_MS };
  entry.count++;
  map.set(key, entry);
  return entry.count > limit;
}

export function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (_bucketHit(_ipAttempts, ip, IP_LIMIT)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const username = (req.body?.username || '').toString().trim().toLowerCase();
  if (username && _bucketHit(_userAttempts, `u:${username}`, USER_LIMIT)) {
    // Generic message — don't confirm the username exists.
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  next();
}
// Cleanup stale entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const m of [_ipAttempts, _userAttempts]) {
    for (const [k, entry] of m) if (now > entry.resetAt) m.delete(k);
  }
}, 30 * 60 * 1000);

// Cookie security:
//   - Default `secure: true` (HTTPS-only). Most self-hosters never set
//     NODE_ENV=production, so the previous tie-in left cookies plaintext-
//     transmittable in many real deployments.
//   - Opt-out via INSECURE_COOKIES=1 (logs a warning at startup).
const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
if (_insecureCookies) {
  console.warn('[WARN] INSECURE_COOKIES=1 — auth cookie will be sent over plain HTTP. Only do this for local dev / behind-VPN deployments.');
}
const COOKIE_OPTS = {
  httpOnly: true, sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: !_insecureCookies,
};

// A browser drops a Secure cookie on a plain-HTTP page (localhost aside), so
// signing in from one succeeds and then lands back on the login page with
// nothing in the log to say why. The browser's Origin header shows the page
// it was on, whatever proxy sits in between. Said once an hour at most. The
// login page shows the same thing on screen.
let _plainHttpWarnedAt = 0;
function warnIfPlainHttp(req) {
  if (_insecureCookies) return;
  const origin = String(req.get('origin') || req.get('referer') || '');
  if (!/^http:\/\//i.test(origin)) return;
  if (/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(origin)) return;
  if (Date.now() - _plainHttpWarnedAt < 60 * 60 * 1000) return;
  _plainHttpWarnedAt = Date.now();
  let page = origin;
  try { page = new URL(origin).origin; } catch {}
  console.warn(`[WARN] Sign-in from a plain-HTTP page (${page}). The sign-in cookie only works over HTTPS, so the browser drops it and the user lands back on the login page. Serve LiftTrace over HTTPS, or set INSECURE_COOKIES=1 on a trusted LAN. See https://traceapps.github.io/docs/getting-started/lan-http/`);
}

function safeUser(u) {
  const { password_hash, ...rest } = u;
  // Whether two-step sign-in is on (nutritrace#222): Settings, Users offers its reset.
  let two_step_enabled = false;
  try { two_step_enabled = twoStepEnabled(u.id); } catch {}
  return { ...rest, two_step_enabled };
}

/**
 * Signs someone in. Signed once, returned both as a cookie (browser PWA
 * path) AND in the response body (native Capacitor path stores the bearer
 * in localStorage and sends it as Authorization: Bearer on every request).
 */
export function finishSignIn(req, res, user, extra = {}) {
  const token = signToken(user);
  warnIfPlainHttp(req);
  res.cookie('lt_token', token, { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  res.json({ ...extra, user: safeUser(user), token });
}

/**
 * A new session for the device that just signed every other one out (a
 * password change, two-step sign-in turned on or off, Sign Out Everywhere,
 * nutritrace#222): the cookie, and { token } for the answer's
 * `session`, so the app keeps going. It keeps the time of the last real
 * sign-in (signToken's authTime).
 */
export function reissueSession(req, res, user) {
  const token = signToken(user, { authTime: Number(req.user?.auth_time ?? req.user?.iat) });
  res.cookie('lt_token', token, { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  return { token };
}

// Two-step sign-in (nutritrace#222): the password was right, but a code is
// due ('verify') or must be set up first ('setup'). No session, no token: a
// pending token that opens only /api/auth/two-step. The answer is a 401
// with a plain error, so an app or a cached web page from before two-step
// sign-in says so instead of signing in without the code.
export const TWO_STEP_OLD_CLIENT = {
  verify: 'This account uses two-step sign-in. Update LiftTrace (or reload this page) to enter your code.',
  setup: 'Your admin requires two-step sign-in. Update LiftTrace (or reload this page) to set it up.',
};
function sendTwoStepChallenge(res, user, kind, extra = {}) {
  res.status(401).json({ error: TWO_STEP_OLD_CLIENT[kind], two_step: kind, pending_token: issuePending(user, kind), ...extra });
}

// This server's random id (see /status), made once and kept in app_config.
// Made again if a restore emptied app_config.
function serverInstanceId() {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = 'instance_id'`).get();
  if (row?.value) return row.value;
  db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('instance_id', ?)`).run(crypto.randomUUID());
  return db.prepare(`SELECT value FROM app_config WHERE key = 'instance_id'`).get()?.value || null;
}

router.get('/status', wrap((req, res) => {
  const active = userMgmtActive();
  // setup_required distinguishes a fresh install (no users, setup needed)
  // from an instance where user management was intentionally disabled (no
  // users, NO setup needed). single_user_mode flag set by DELETE
  // /management and POST /recover, cleared by the first POST /register.
  // Same fix as NutriTrace #34.
  const singleUser = db.prepare(`SELECT value FROM app_config WHERE key = 'single_user_mode'`).get()?.value === '1';
  const policy = db.prepare(`SELECT value FROM app_config WHERE key = 'password_policy'`).get()?.value || 'standard';
  // Surface OIDC providers + password-login flag for the Login page + the
  // Android NativeSetup flow (which uses these to decide which auth buttons
  // to render). Was previously absent from LT's /status response, so the
  // NativeSetup fix from LT #15 fell through to "no OIDC providers found"
  // and only rendered the password form even when the admin had configured
  // Authentik/Keycloak/etc. Matches NutriTrace's shape verbatim.
  let providers = [];
  let enable_email_password_login = true;
  try {
    providers = oidcListProviders({ activeOnly: true }).map(oidcPublicProvider);
    enable_email_password_login = isPasswordLoginEnabled();
  } catch { /* OIDC not available for some reason — safe fallback */ }
  res.json({
    active,
    setup_required: !active && !singleUser,
    single_user_mode: singleUser,
    password_policy: policy,                  // 'standard' | 'strong'
    password_min_score: policy === 'strong' ? STRONG_MIN_SCORE : 0,
    oidc: { providers, enable_email_password_login },
    // Whether the sign-in cookie is HTTPS-only, so the login page can say up
    // front that signing in from a plain-HTTP page will not stick.
    secure_cookies: !_insecureCookies,
    // A random id for this server, so the Android app can tell the same
    // server at another address (LAN IP, domain) from a different one.
    instance_id: serverInstanceId(),
    // Coaching with consent. Servers before it report none, and the app
    // hides what is new there.
    coaching: COACHING_VERSION,
  });
}));

router.get('/me', wrap((req, res) => {
  // session_ended: this device was signed out (lib/session-version.js), for
  // the sign-in page to say so.
  if (!req.user) return res.json({ user: null, ...(req.sessionEnded ? { session_ended: true } : {}) });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // Where this person stands in coaching, so the app knows whether to show
  // the Coach tab without asking again.
  const coaching = user && userMgmtActive() ? coachingState(user.id) : null;
  res.json({ user: user ? safeUser(user) : null, coaching });
}));

router.post('/login', rateLimitLogin, wrap((req, res) => {
  // Block password login when admins have switched the instance to OIDC-only.
  if (!isPasswordLoginEnabled()) {
    return res.status(403).json({ error: 'Password login is disabled. Use Single Sign-On instead.' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  // Reject OIDC-only users (no password_hash) the same way as a wrong password.
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const kind = challengeFor(user);
  if (kind) return sendTwoStepChallenge(res, user, kind);
  finishSignIn(req, res, user);
}));

router.post('/logout', (req, res) => { res.clearCookie('lt_token'); res.json({ ok: true }); });

router.post('/register', wrap((req, res) => {
  const isFirst = !userMgmtActive();
  if (!isFirst && (!req.user || req.user.role !== 'admin'))
    return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, nickname, birthday, gender, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  { const pwErr = validatePassword(password, [username, email, full_name].filter(Boolean)); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const assignedRole = isFirst ? 'admin' : (role || 'member');
  // A coach chosen on the form (never implied by who created the account).
  const coachId = isFirst ? null : _chosenCoach(req.body?.coach_id, assignedRole);
  if (coachId === false) return res.status(400).json({ error: 'That person can\'t coach.' });
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const result = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, nickname, birthday, gender, role, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(username.trim().toLowerCase(), hash, full_name || null, nickname || null, birthday || null, gender || null, assignedRole, email ? email.trim().toLowerCase() : null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  // Whoever creates a member used to become their trainer. Now an account
  // gets a coaching request only when a coach was chosen for it, from that
  // coach; it waits for the first sign-in and shares nothing until accepted.
  if (coachId) requestFromInvite(coachId, user.id);
  let token = null;
  if (isFirst) {
    claimAnonymousData(user.id);
    token = signToken(user);
    warnIfPlainHttp(req);
    res.cookie('lt_token', token, COOKIE_OPTS);
  }
  res.json({ user: safeUser(user), token });
}));

router.put('/profile', requireAuth, wrap((req, res) => {
  const body = req.body || {};
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) || {};
  // A field the request leaves out stays as it is. Profile always sends all
  // of them (an empty one clears it); the first-run setup sends only gender
  // and birthday, and used to wipe the name and email just registered
  // (TraceApps/nutritrace#269).
  const given = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const full_name = given('full_name') ? body.full_name : before.full_name;
  const nickname = given('nickname') ? body.nickname : before.nickname;
  const birthday = given('birthday') ? body.birthday : before.birthday;
  const gender = given('gender') ? body.gender : before.gender;
  const email = given('email') ? body.email : before.email;
  // A picture chosen with no connection arrives embedded in this request,
  // since there was nowhere to upload it to. It becomes a file here.
  const avatar_url = given('avatar_url') ? localizeDataUrl(body.avatar_url) : before.avatar_url;
  db.prepare('UPDATE users SET full_name=?, nickname=?, birthday=?, gender=?, avatar_url=?, email=? WHERE id=?')
    .run(full_name || null, nickname || null, birthday || null, gender || null, avatar_url || null, email ? String(email).trim().toLowerCase() : null, req.user.id);
  // Unconfirmed until the account confirms it (nutritrace#222): no single sign-on
  // link by it, and a reset goes to the address before it.
  noteEmailChange(req.user.id, before.email, email);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: safeUser(user) });
}));

// OIDC-only users (no password_hash) can use this endpoint to *set* their
// first password without supplying current_password. Existing-password users
// still need to verify with their current one.
router.put('/password', requireAuth, wrap((req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'New password required' });
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.password_hash) {
    if (!current_password) return res.status(400).json({ error: 'Current password required' });
    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  } else if (!freshSignIn(req.user)) {
    // A first password for a single sign-on account: a sign-in this recent,
    // or a stolen session could give itself a password (nutritrace#222).
    return res.status(401).json({ error: `To set a password, sign out and sign in again with your provider, then set it within ${FRESH_SIGN_IN_MINUTES} minutes.`, reauth: true });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, BCRYPT_COST), req.user.id);
  // Every other device is signed out (lib/session-version.js); this one is
  // given a new session in the answer, and keeps going.
  bumpSessionVersion(req.user.id, user.password_hash ? 'password changed' : 'password set', { req });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, session: reissueSession(req, res, updated) });
}));

// ── Sign Out Everywhere ────────────────────────────────────────────────────
// Every session this account has ends, on every device; this one is given
// a new session in the answer (nutritrace#222). API tokens and MCP tokens
// are separate, with their own Revoke, and keep working.
router.post('/sign-out-everywhere', requireAuth, wrap((req, res) => {
  if (!req.user) return res.status(400).json({ error: 'Sign Out Everywhere needs an account.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  bumpSessionVersion(user.id, 'Sign Out Everywhere', { req });
  res.json({ ok: true, session: reissueSession(req, res, user) });
}));

router.get('/users', requireAuth, requireAdmin, wrap((req, res) => {
  // Coaching requests waiting for each member's answer, so Users shows them
  // (the trainer picker sends one) without a request of its own.
  const pending = new Map();
  for (const r of db.prepare(`
    SELECT cc.id, cc.client_id, u.id AS coach_id, u.full_name, u.nickname, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.coach_id WHERE cc.status = 'pending' ORDER BY cc.id
  `).all()) {
    if (!pending.has(r.client_id)) pending.set(r.client_id, []);
    pending.get(r.client_id).push({ id: r.id, coach: { id: r.coach_id, name: personName(r) } });
  }
  res.json(db.prepare('SELECT * FROM users ORDER BY created_at').all().map(u => ({ ...safeUser(u), coaching_requests: pending.get(u.id) || [] })));
}));

router.delete('/me', requireAuth, wrap((req, res) => {
  const id = req.user.id;
  // Last-admin guard — never let the only admin delete themselves and lock
  // the instance out. They must transfer admin to another user first.
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (user?.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
    if (admins.count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only admin account. Transfer admin to another user first.' });
    }
  }
  // Anything that owns files on disk goes FIRST, through its file-aware
  // helper: a plain row delete here would orphan the images and videos, and
  // so would any cascade that removed the rows before this ran.
  deleteMediaForUser(id);
  deleteSetMediaForUser(id);
  // Coaching conversations go with the pairing (it cascades); their photo
  // files go here, first, while the rows still say which they are.
  deletePhotosForUser(id);
  db.prepare('DELETE FROM workout_log WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM body_stats_log WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM program_assignments WHERE assigned_to = ?').run(id);
  db.prepare('DELETE FROM coach_prescriptions WHERE trainer_id = ? OR member_id = ?').run(id, id);
  db.prepare('DELETE FROM ai_chat_history WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  db.prepare('UPDATE users SET trainer_id = NULL WHERE trainer_id = ?').run(id);
  // Tables with no FK to users(id) do not cascade — clear this user's rows.
  purgeUserRows(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.clearCookie('lt_token');
  res.json({ ok: true });
}));

router.delete('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself — use Delete My Account' });
  // Anything that owns files on disk goes FIRST, through its file-aware
  // helper: a plain row delete here would orphan the images and videos, and
  // so would any cascade that removed the rows before this ran.
  deleteMediaForUser(id);
  deleteSetMediaForUser(id);
  // Coaching conversations go with the pairing (it cascades); their photo
  // files go here, first, while the rows still say which they are.
  deletePhotosForUser(id);
  db.prepare('DELETE FROM workout_log WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM body_stats_log WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM program_assignments WHERE assigned_to = ?').run(id);
  db.prepare('DELETE FROM coach_prescriptions WHERE trainer_id = ? OR member_id = ?').run(id, id);
  db.prepare('DELETE FROM ai_chat_history WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  db.prepare('UPDATE users SET trainer_id = NULL WHERE trainer_id = ?').run(id);
  // Tables with no FK to users(id) do not cascade — clear this user's rows.
  purgeUserRows(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

router.put('/users/:id/password', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { new_password } = req.body;
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Your own goes through Profile, which asks for the current password: a
  // session alone never sets it, or a stolen one could take the account (nutritrace#222).
  if (req.user && id === req.user.id) return res.status(400).json({ error: 'Change your own password in Settings > Profile.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, BCRYPT_COST), id);
  // Their sessions end everywhere.
  bumpSessionVersion(id, 'password set by an admin', { by: req.user, req });
  res.json({ ok: true });
}));

router.put('/users/:id/role', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body;
  if (!['admin', 'trainer', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  // Only Members are coached: anyone else leaves their coach (and their
  // requests end). Someone who can no longer coach (made a Member) stops
  // coaching. An admin can coach, so a Trainer made an admin keeps clients.
  const endedAsClient = role !== 'member' ? endAsClient(id, req.user.id) : 0;
  const endedAsCoach = endCoachingIfNotCoach(id, req.user.id);
  res.json({ ok: true, coaching_ended: endedAsClient + endedAsCoach });
}));

// PUT /api/auth/users/:id/trainer: an admin's pairing control. Choosing a
// trainer sends that trainer's request, which the member accepts or
// declines (an admin used to pair them outright). No trainer ends the
// member's coaching and any request waiting for them.
router.put('/users/:id/trainer', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { trainer_id } = req.body;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role !== 'member') return res.status(400).json({ error: 'Only members can be assigned a trainer' });
  if (trainer_id == null || trainer_id === '') {
    const open = db.prepare(`SELECT id FROM coach_clients WHERE client_id = ? AND status IN ('pending', 'active')`).all(id);
    for (const r of open) endPairing(r.id, req.user.id);
    db.prepare('UPDATE users SET trainer_id = NULL WHERE id = ?').run(id);
    return res.json({ ok: true, status: null });
  }
  const trainerId = parseInt(trainer_id);
  const trainer = db.prepare('SELECT role FROM users WHERE id = ?').get(trainerId);
  if (!trainer) return res.status(400).json({ error: 'Trainer not found' });
  if (trainer.role !== 'trainer' && trainer.role !== 'admin') return res.status(400).json({ error: 'Selected user is not a trainer' });
  const own = db.prepare(`SELECT status FROM coach_clients WHERE coach_id = ? AND client_id = ? AND status IN ('pending', 'active')`).get(trainerId, id);
  if (own) return res.json({ ok: true, status: own.status });
  try { requestClient(trainerId, id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.json({ ok: true, status: 'pending' });
}));

router.delete('/management', requireAuth, requireAdmin, wrap((req, res) => {
  // Hand the sole account's data back to single-user mode before dropping
  // accounts, otherwise it keeps a user id nothing can read again.
  releaseDataBeforeDisable();
  // Coaching goes with the accounts (it cascades); so do its photos.
  deleteAllPhotos();
  db.prepare('DELETE FROM users').run();
  // Persist intent: this was an explicit disable, not a fresh install.
  // /status uses this to keep setup_required=false so the client doesn't
  // re-route to the wizard on every load. Cleared by the next /register.
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('single_user_mode', '1')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  res.clearCookie('lt_token');
  res.json({ ok: true });
}));

router.post('/recover', rateLimitLogin, wrap((req, res) => {
  if (req.user) return res.status(400).json({ error: 'Already signed in' });
  // Constant time, with wrong tokens from every address counted together,
  // shared with Locked Out?'s two-step reset (lib/two-step.js).
  const check = checkRecoveryToken(req.body?.token, { ip: req.ip });
  if (check === 'limited') return res.status(429).json({ error: 'Too many wrong recovery tokens. Try again later, or use npm run reset-2fa on the server.' });
  if (check === 'unset') return res.status(503).json({ error: 'Recovery not available. Set RECOVERY_TOKEN environment variable.' });
  if (check !== 'ok') return res.status(403).json({ error: 'Invalid recovery token.' });
  releaseDataBeforeDisable();
  // Coaching goes with the accounts (it cascades); so do its photos.
  deleteAllPhotos();
  db.prepare('DELETE FROM users').run();
  // Same single_user_mode flag as DELETE /management — recovery is an
  // intentional disable, not a fresh install.
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('single_user_mode', '1')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  res.clearCookie('lt_token');
  res.json({ ok: true });
}));

router.post('/forgot-password', rateLimitLogin, wrap(async (req, res) => {
  const startedAt = Date.now();
  const { email } = req.body;
  // ALWAYS return 200 (after a constant-time pad) regardless of whether the
  // email matches a real account, SMTP is configured, or the send fails.
  // The pad defeats response-timing as an enumeration oracle.
  const respondOk = async () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 400) await new Promise(r => setTimeout(r, 400 - elapsed));
    res.json({ ok: true });
  };
  if (!email) return respondOk();
  if (!isEmailConfigured()) return respondOk();
  // An email changed without confirming it gets no reset: the address before
  // it does (lib/link-grant.js, nutritrace#222).
  const found = resetRecipient(email);
  const user = found?.user;
  if (!user) return respondOk();
  try {
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
    const baseUrl = linkBase(req);
    if (baseUrl) await sendPasswordReset(found.to, `${baseUrl}/#/reset-password?token=${token}`);
  } catch (e) {
    // Don't surface email-send errors to the client — it would leak existence.
    console.warn('[forgot-password] send failed:', e?.message);
  }
  return respondOk();
}));

router.post('/reset-password', wrap((req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link has expired' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, BCRYPT_COST), row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);
  // Whoever had a session, a stolen one included, is signed out.
  bumpSessionVersion(row.user_id, 'password reset by email link', { req });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  // An emailed link proves the inbox, not the second step: with two-step
  // sign-in on (or required), the new password signs in on the sign-in
  // page, which asks for the code. A 401 so a page from before this says
  // the message instead of signing in.
  const due = challengeFor(user);
  if (due) {
    const error = due === 'setup'
      ? 'Your password was changed. Sign in with it to set up two-step sign-in, which your admin requires.'
      : 'Your password was changed. Sign in with it and your two-step sign-in code.';
    return res.status(401).json({ error, password_changed: true });
  }
  const token2 = signToken(user);
  res.cookie('lt_token', token2, COOKIE_OPTS);
  res.json({ user: safeUser(user), token: token2 });
}));

// The coach chosen for a new account: null when none, false when the
// person chosen can't coach (or the new account won't be a Member).
function _chosenCoach(raw, role) {
  if (raw == null || raw === '') return null;
  const id = parseInt(raw);
  if (!Number.isInteger(id) || role !== 'member' || !canCoach(roleOf(id))) return false;
  return id;
}

router.post('/invite', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { email, role = 'member' } = req.body;
  const coachId = _chosenCoach(req.body?.coach_id, role);
  if (coachId === false) return res.status(400).json({ error: 'That person can\'t coach.' });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_tokens (token, email, role, created_by, expires_at, coach_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, email ? email.trim().toLowerCase() : null, role, req.user.id, expires, coachId);
  const baseUrl = linkBase(req);
  if (!baseUrl) return res.status(500).json({ error: 'The app\'s address is unknown. Set PUBLIC_URL, then try again.' });
  const inviteUrl = `${baseUrl}/#/accept-invite?token=${token}`;
  if (email && isEmailConfigured()) {
    const inviter = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const inviterName = inviter?.nickname || inviter?.full_name || inviter?.username || 'An admin';
    await sendInvite(email, inviteUrl, inviterName);
    res.json({ ok: true, sent: true, inviteUrl });
  } else {
    res.json({ ok: true, sent: false, inviteUrl });
  }
}));

// ── Admin: list pending invites (not used, not expired) ───────────────────
router.get('/invites', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT token, email, role, expires_at, created_by, coach_id
     FROM invite_tokens
     WHERE used = 0 AND expires_at > datetime('now')
     ORDER BY expires_at DESC`
  ).all();
  res.json(rows);
}));

// ── Admin: revoke a pending invite ────────────────────────────────────────
router.delete('/invites/:token', requireAuth, requireAdmin, wrap((req, res) => {
  const result = db.prepare('DELETE FROM invite_tokens WHERE token = ?').run(req.params.token);
  if (result.changes === 0) return res.status(404).json({ error: 'Invite not found' });
  res.json({ ok: true });
}));

router.post('/accept-invite', wrap((req, res) => {
  const { token, username, password, full_name } = req.body;
  if (!token || !username || !password) return res.status(400).json({ error: 'Token, username and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const invite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token);
  if (!invite || invite.used) return res.status(400).json({ error: 'Invalid or already used invite link' });
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite link has expired' });
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const result = db.prepare('INSERT INTO users (username, password_hash, full_name, role, email) VALUES (?, ?, ?, ?, ?)')
    .run(username.trim().toLowerCase(), hash, full_name || null, invite.role, invite.email || null);
  db.prepare('UPDATE invite_tokens SET used = 1 WHERE token = ?').run(token);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  // A member invited by a trainer or admin used to get the inviter as their
  // trainer. Now only a coach chosen on the invite asks, and their request
  // waits here; nothing is shared until it's accepted.
  if (invite.role === 'member' && invite.coach_id) requestFromInvite(invite.coach_id, user.id);
  // The admin requires two-step sign-in: it's set up before the first session.
  const kind = challengeFor(user);
  if (kind) return sendTwoStepChallenge(res, user, kind, { account_created: true });
  const issued = signToken(user);
  res.cookie('lt_token', issued, COOKIE_OPTS);
  res.json({ user: safeUser(user), token: issued });
}));

router.get('/validate-token', wrap((req, res) => {
  const { token, type } = req.query;
  if (!token || !type) return res.status(400).json({ error: 'token and type required' });
  if (type === 'reset') {
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row || row.used || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired link' });
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
    return res.json({ ok: true, username: user?.username });
  }
  if (type === 'invite') {
    const row = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token);
    if (!row || row.used || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired link' });
    return res.json({ ok: true, email: row.email || null, role: row.role });
  }
  res.status(400).json({ error: 'Unknown token type' });
}));

export default router;
