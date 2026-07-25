/**
 * server/lib/oidc.js — OIDC helper layer.
 *
 * Wraps the `openid-client` library with LiftTrace-specific concerns:
 *   - Discovery cache (1h TTL, lazy)
 *   - PKCE/state/nonce persistence to the existing oauth_state table
 *   - User resolution + auto-link policy + admin claim mapping
 *
 * Schema is in server/db.js (oidc_providers, user_oidc_links). Client
 * secrets are stored encrypted via server/lib/token-crypto.js.
 */
import { Issuer, generators, custom } from 'openid-client';

// openid-client v5.7.x defaults outgoing HTTP requests to a 3500ms timeout,
// which is too tight in practice — first-time Authentik / Keycloak / Authelia
// callbacks that involve token exchange + userinfo + JWKS fetches can spike
// past 3s on a slightly cold network without anything actually being wrong.
// Users see "callback failed" on the first OIDC sign-in attempt; retry
// succeeds because the discovery cache is warm. Bumping to 10s matches most
// OAuth client library defaults and gives real network flakiness a chance
// to recover without silently failing the auth flow. Cross-app fix mirrored
// from NutriTrace.
custom.setHttpOptionsDefaults({ timeout: 10000 });
import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';
import { logger } from '../logger.js';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;             // 1h
const STATE_TTL_MS     = 10 * 60 * 1000;             // 10 min — IdP round-trip window

const _discoveryCache = new Map();   // providerId → { issuer, expiresAt }

// ── Provider row helpers ──────────────────────────────────────────────────

export function listProviders({ activeOnly = true } = {}) {
  const sql = activeOnly
    ? `SELECT * FROM oidc_providers WHERE is_active = 1 ORDER BY id`
    : `SELECT * FROM oidc_providers ORDER BY id`;
  return db.prepare(sql).all();
}

export function getProvider(id) {
  return db.prepare(`SELECT * FROM oidc_providers WHERE id = ?`).get(Number(id));
}

/** Public-safe shape — strip secret + admin-claim fields. */
export function publicProvider(p) {
  if (!p) return null;
  return {
    id:           p.id,
    display_name: p.display_name || 'OIDC',
    logo_url:     p.logo_url || null,
    is_active:    !!p.is_active,
  };
}

/** Admin-safe shape — strip secret only. */
export function adminProvider(p) {
  if (!p) return null;
  const { client_secret, ...rest } = p;
  return {
    ...rest,
    has_client_secret: !!client_secret,
    redirect_uris:  _safeJsonArray(p.redirect_uris),
    response_types: _safeJsonArray(p.response_types),
    is_active:      !!p.is_active,
    auto_link_verified_email: p.auto_link_verified_email != null ? !!p.auto_link_verified_email : !!p.auto_register,
    auto_register_new_users:  p.auto_register_new_users  != null ? !!p.auto_register_new_users  : !!p.auto_register,
    auto_register:  !!p.auto_register,
  };
}

function _safeJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// ── Discovery + client ────────────────────────────────────────────────────

export async function getClient(providerId) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown OIDC provider ${providerId}`);
  if (!provider.is_active) throw new Error(`OIDC provider ${providerId} is disabled`);

  const cached = _discoveryCache.get(provider.id);
  let issuer;
  if (cached && cached.expiresAt > Date.now()) {
    issuer = cached.issuer;
  } else {
    issuer = await Issuer.discover(provider.issuer_url);
    _discoveryCache.set(provider.id, { issuer, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  }

  const clientSecret = provider.client_secret ? decrypt(provider.client_secret) : undefined;
  return new issuer.Client({
    client_id: provider.client_id,
    client_secret: clientSecret || undefined,
    redirect_uris: _safeJsonArray(provider.redirect_uris),
    response_types: _safeJsonArray(provider.response_types),
    token_endpoint_auth_method: provider.token_endpoint_auth_method,
    id_token_signed_response_alg: provider.id_token_signed_response_alg,
    userinfo_signed_response_alg: provider.userinfo_signed_response_alg,
  });
}

export function invalidateDiscovery(providerId) {
  if (providerId == null) _discoveryCache.clear();
  else _discoveryCache.delete(Number(providerId));
}

// ── PKCE / state persistence (reuses oauth_state) ─────────────────────────

export function persistState({ providerId, redirectUri, returnPath, codeVerifier, state, nonce, mobile, linkUserId }) {
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const data = { providerId, redirectUri, returnPath, codeVerifier, nonce };
  if (mobile)      data.mobile = true;
  if (linkUserId)  data.linkUserId = linkUserId;
  db.prepare(
    `INSERT OR REPLACE INTO oauth_state (state, user_id, provider, data, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    state,
    null,
    `oidc:${providerId}`,
    JSON.stringify(data),
    expiresAt
  );
}

export function consumeState(state) {
  const row = db.prepare(
    `SELECT * FROM oauth_state WHERE state = ? AND provider LIKE 'oidc:%'`
  ).get(state);
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_state WHERE state = ?`).run(state);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  try { return JSON.parse(row.data); }
  catch { return null; }
}

export function purgeExpiredStates() {
  db.prepare(`DELETE FROM oauth_state WHERE expires_at < datetime('now') AND provider LIKE 'oidc:%'`).run();
}

// ── Auth flow helpers ─────────────────────────────────────────────────────

export function generateAuthChecks() {
  const codeVerifier = generators.codeVerifier();
  return {
    codeVerifier,
    codeChallenge: generators.codeChallenge(codeVerifier),
    state: generators.state(),
    nonce: generators.nonce(),
  };
}

// ── User resolution + admin mapping ───────────────────────────────────────

/**
 * Map OIDC claims to a LiftTrace user. Returns { user, created, linked }
 * or throws with a user-facing message.
 */
export function resolveUser(provider, claims) {
  const sub = String(claims.sub || '');
  if (!sub) throw new Error('OIDC provider returned no `sub` claim');

  const existingLink = db.prepare(
    `SELECT u.* FROM user_oidc_links l JOIN users u ON u.id = l.user_id
      WHERE l.oidc_provider_id = ? AND l.oidc_sub = ?`
  ).get(provider.id, sub);
  if (existingLink) {
    db.prepare(
      `UPDATE user_oidc_links SET last_login_at = datetime('now'), email_verified = ?
        WHERE oidc_provider_id = ? AND oidc_sub = ?`
    ).run(claims.email_verified ? 1 : 0, provider.id, sub);
    return { user: existingLink, created: false, linked: false };
  }

  const email = claims.email ? String(claims.email).trim().toLowerCase() : null;
  const emailVerified = !!claims.email_verified;

  const autoLink = provider.auto_link_verified_email != null
    ? !!provider.auto_link_verified_email
    : !!provider.auto_register;
  const autoCreate = provider.auto_register_new_users != null
    ? !!provider.auto_register_new_users
    : !!provider.auto_register;

  if (email && emailVerified && autoLink) {
    const localByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    if (localByEmail) {
      db.prepare(
        `INSERT INTO user_oidc_links (user_id, oidc_provider_id, oidc_sub, email_verified, last_login_at)
         VALUES (?, ?, ?, 1, datetime('now'))`
      ).run(localByEmail.id, provider.id, sub);
      return { user: localByEmail, created: false, linked: true };
    }
  }
  if (email) {
    const collision = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (collision && !autoLink) {
      throw new Error(`Your ${provider.display_name || 'OIDC'} account matches an existing LiftTrace user. Sign in once with your password and link this provider from Profile → Linked accounts. After that, SSO will sign you in directly.`);
    }
  }

  if (autoCreate) {
    const username = _deriveUsername(claims);
    const emailVal = email || null;
    const fullName = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || null;

    const result = db.prepare(
      `INSERT INTO users (username, password_hash, full_name, role, email)
       VALUES (?, NULL, ?, 'member', ?)`
    ).run(username, fullName, emailVal);

    const newUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO user_oidc_links (user_id, oidc_provider_id, oidc_sub, email_verified, last_login_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(newUser.id, provider.id, sub, emailVerified ? 1 : 0);
    return { user: newUser, created: true, linked: true };
  }

  throw new Error('No LiftTrace account is linked to this identity. Ask your admin to enable Auto-register new users on this provider, or have them invite you first.');
}

/**
 * Re-evaluate role from claims on every login. Sets 'admin' if the configured
 * claim contains the configured value; otherwise demotes to 'member'.
 */
export function applyAdminMapping(provider, user, claims) {
  if (!provider.admin_group_claim || !provider.admin_group_value) return;
  const claimVal = claims[provider.admin_group_claim];
  let isAdmin = false;
  if (Array.isArray(claimVal)) {
    isAdmin = claimVal.includes(provider.admin_group_value);
  } else if (typeof claimVal === 'string') {
    isAdmin = claimVal === provider.admin_group_value
           || claimVal.split(/[\s,]+/).includes(provider.admin_group_value);
  }
  const desired = isAdmin ? 'admin' : 'member';
  if (user.role !== desired) {
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(desired, user.id);
    user.role = desired;
    logger.info(`[oidc] role for user ${user.id} (${user.username}) → ${desired} via provider ${provider.id}`);
  }
}

export function linkUser(userId, providerId, sub, emailVerified) {
  const existing = db.prepare(
    `SELECT user_id FROM user_oidc_links WHERE oidc_provider_id = ? AND oidc_sub = ?`
  ).get(providerId, sub);
  if (existing && existing.user_id !== userId) {
    throw new Error('This provider identity is already linked to a different LiftTrace account.');
  }
  if (existing) return;
  db.prepare(
    `INSERT INTO user_oidc_links (user_id, oidc_provider_id, oidc_sub, email_verified, last_login_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(userId, providerId, sub, emailVerified ? 1 : 0);
}

export function unlinkUser(userId, linkId) {
  const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId);
  const links = db.prepare(`SELECT id FROM user_oidc_links WHERE user_id = ?`).all(userId);
  const hasPassword = !!(user && user.password_hash);
  if (!hasPassword && links.length <= 1) {
    throw new Error('Cannot unlink your last sign-in method. Set a password first, or link another provider.');
  }
  db.prepare(`DELETE FROM user_oidc_links WHERE id = ? AND user_id = ?`).run(linkId, userId);
}

export function listUserLinks(userId) {
  return db.prepare(
    `SELECT l.id, l.oidc_provider_id, l.oidc_sub, l.email_verified, l.last_login_at,
            l.created_at, p.display_name, p.logo_url
       FROM user_oidc_links l JOIN oidc_providers p ON p.id = l.oidc_provider_id
      WHERE l.user_id = ? ORDER BY l.created_at`
  ).all(userId);
}

// ── Settings: enable_email_password_login flag ───────────────────────────

export function isPasswordLoginEnabled() {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = 'enable_email_password_login'`).get();
  if (!row) return true;
  return row.value !== '0' && row.value !== 'false';
}

export function setPasswordLoginEnabled(on) {
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES ('enable_email_password_login', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(on ? '1' : '0');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _deriveUsername(claims) {
  let base = (claims.preferred_username || (claims.email && claims.email.split('@')[0]) || `user${Date.now()}`)
    .toString().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  if (!base) base = `user${Date.now()}`;
  let candidate = base;
  let n = 1;
  while (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(candidate)) {
    n++;
    candidate = `${base}${n}`.slice(0, 32);
    if (n > 999) candidate = `${base}-${Date.now()}`.slice(0, 32);
  }
  return candidate;
}

export function encryptClientSecret(secret) {
  return secret == null || secret === '' ? null : encrypt(secret);
}

export function decryptClientSecret(stored) {
  return stored == null ? null : decrypt(stored);
}
