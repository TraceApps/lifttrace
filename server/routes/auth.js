import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { wrap } from '../logger.js';
import { signToken, sessionMaxAge, userMgmtActive, requireAuth, requireAdmin } from '../middleware/auth.js';
import { isPasswordLoginEnabled, listProviders as oidcListProviders, publicProvider as oidcPublicProvider } from '../lib/oidc.js';
import { sendPasswordReset, sendInvite, isEmailConfigured } from '../email.js';
import { estimate as estimatePasswordStrength, STRONG_MIN_SCORE } from '../lib/password-strength.js';
import { claimAnonymousData, releaseDataBeforeDisable, purgeUserRows } from '../lib/claim-anonymous-data.js';

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

function rateLimitLogin(req, res, next) {
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

function safeUser(u) { const { password_hash, ...rest } = u; return rest; }

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
  });
}));

router.get('/me', wrap((req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: user ? safeUser(user) : null });
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
  const cookieOpts = { ...COOKIE_OPTS, maxAge: sessionMaxAge() };
  // Sign once, return both as a cookie (browser PWA path) AND in the response
  // body (native Capacitor path stores the bearer in localStorage and sends
  // it as Authorization: Bearer on every request).
  const token = signToken(user);
  res.cookie('lt_token', token, cookieOpts);
  res.json({ user: safeUser(user), token });
}));

router.post('/logout', (req, res) => { res.clearCookie('lt_token'); res.json({ ok: true }); });

router.post('/register', wrap((req, res) => {
  const isFirst = !userMgmtActive();
  if (!isFirst && (!req.user || req.user.role !== 'admin'))
    return res.status(403).json({ error: 'Admin only' });
  const { username, password, full_name, nickname, birthday, gender, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  { const pwErr = validatePassword(password, [username, email, full_name].filter(Boolean)); if (pwErr) return res.status(400).json({ error: pwErr }); }
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const assignedRole = isFirst ? 'admin' : (role || 'member');
  // Default: whoever creates a member is their trainer. Reversible from the
  // admin dropdown if that's wrong.
  const defaultTrainerId = (!isFirst && assignedRole === 'member' && req.user
    && (req.user.role === 'trainer' || req.user.role === 'admin'))
    ? req.user.id : null;
  const result = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, nickname, birthday, gender, role, email, trainer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(username.trim().toLowerCase(), hash, full_name || null, nickname || null, birthday || null, gender || null, assignedRole, email ? email.trim().toLowerCase() : null, defaultTrainerId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  let token = null;
  if (isFirst) {
    claimAnonymousData(user.id);
    token = signToken(user);
    res.cookie('lt_token', token, COOKIE_OPTS);
  }
  res.json({ user: safeUser(user), token });
}));

router.put('/profile', requireAuth, wrap((req, res) => {
  const { full_name, nickname, birthday, gender, avatar_url, email } = req.body;
  db.prepare('UPDATE users SET full_name=?, nickname=?, birthday=?, gender=?, avatar_url=?, email=? WHERE id=?')
    .run(full_name || null, nickname || null, birthday || null, gender || null, avatar_url || null, email ? email.trim().toLowerCase() : null, req.user.id);
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
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, BCRYPT_COST), req.user.id);
  // Rotate JWT so existing sessions on other devices stop working after a
  // password change — important for "I forgot to log out the old phone" cases.
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.cookie('lt_token', signToken(updated), { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  res.json({ ok: true });
}));

router.get('/users', requireAuth, requireAdmin, wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY created_at').all().map(safeUser));
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, BCRYPT_COST), id);
  res.json({ ok: true });
}));

router.put('/users/:id/role', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body;
  if (!['admin', 'trainer', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  // If role flipped away from member, detach any trainer_id; if away from trainer, detach all members
  if (role !== 'member') db.prepare('UPDATE users SET trainer_id = NULL WHERE id = ?').run(id);
  if (role !== 'trainer') db.prepare('UPDATE users SET trainer_id = NULL WHERE trainer_id = ?').run(id);
  res.json({ ok: true });
}));

// PUT /api/auth/users/:id/trainer — admin assigns a trainer to a member
router.put('/users/:id/trainer', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { trainer_id } = req.body;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role !== 'member') return res.status(400).json({ error: 'Only members can be assigned a trainer' });
  if (trainer_id != null) {
    const trainer = db.prepare('SELECT role FROM users WHERE id = ?').get(trainer_id);
    if (!trainer) return res.status(400).json({ error: 'Trainer not found' });
    if (trainer.role !== 'trainer' && trainer.role !== 'admin') return res.status(400).json({ error: 'Selected user is not a trainer' });
  }
  db.prepare('UPDATE users SET trainer_id = ? WHERE id = ?').run(trainer_id || null, id);
  res.json({ ok: true });
}));

router.delete('/management', requireAuth, requireAdmin, wrap((req, res) => {
  // Hand the sole account's data back to single-user mode before dropping
  // accounts, otherwise it keeps a user id nothing can read again.
  releaseDataBeforeDisable();
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
  const expected = process.env.RECOVERY_TOKEN;
  if (!expected) return res.status(503).json({ error: 'RECOVERY_TOKEN env var not set — cannot recover' });
  const { token } = req.body || {};
  // Constant-time compare to defeat byte-by-byte timing attacks.
  // Equal-length buffers are required by timingSafeEqual.
  let ok = false;
  try {
    const a = Buffer.from(String(token || ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {}
  if (!ok) return res.status(403).json({ error: 'Invalid recovery token' });
  releaseDataBeforeDisable();
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
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return respondOk();
  try {
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const baseUrl = `${proto}://${req.headers['x-forwarded-host'] || req.get('host')}`;
    await sendPasswordReset(user.email, `${baseUrl}/#/reset-password?token=${token}`);
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
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  const token2 = signToken(user);
  res.cookie('lt_token', token2, COOKIE_OPTS);
  res.json({ user: safeUser(user), token: token2 });
}));

router.post('/invite', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { email, role = 'member' } = req.body;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, email ? email.trim().toLowerCase() : null, role, req.user.id, expires);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const baseUrl = `${proto}://${req.headers['x-forwarded-host'] || req.get('host')}`;
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
    `SELECT token, email, role, expires_at, created_by
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
  // If invited as member by a trainer/admin, inherit inviter as default trainer
  let inviterTrainerId = null;
  if (invite.role === 'member' && invite.created_by) {
    const inviter = db.prepare('SELECT role FROM users WHERE id = ?').get(invite.created_by);
    if (inviter && (inviter.role === 'trainer' || inviter.role === 'admin')) {
      inviterTrainerId = invite.created_by;
    }
  }
  const result = db.prepare('INSERT INTO users (username, password_hash, full_name, role, email, trainer_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username.trim().toLowerCase(), hash, full_name || null, invite.role, invite.email || null, inviterTrainerId);
  db.prepare('UPDATE invite_tokens SET used = 1 WHERE token = ?').run(token);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
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
