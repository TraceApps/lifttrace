/**
 * server/routes/oidc.js — public OIDC endpoints.
 *
 * Mounted at /api/auth/oidc.
 */
import { Router } from 'express';
import { wrap, logger } from '../logger.js';
import { signToken, sessionMaxAge, requireAuth, userMgmtActive } from '../middleware/auth.js';
import {
  listProviders, publicProvider, getProvider, getClient,
  generateAuthChecks, persistState, consumeState,
  resolveUser, applyAdminMapping, linkUser, unlinkUser, listUserLinks,
  isPasswordLoginEnabled,
} from '../lib/oidc.js';
import db from '../db.js';

const router = Router();

const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000,
  secure:   !_insecureCookies,
};

function _resolveRedirectUri(provider, req) {
  let configured = [];
  try { configured = JSON.parse(provider.redirect_uris || '[]'); } catch {}
  if (!configured.length) return null;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const expectedOrigin = `${proto}://${host}`;
  const match = configured.find(u => typeof u === 'string' && u.startsWith(expectedOrigin));
  return match || configured[0];
}

router.get('/providers', wrap((req, res) => {
  const providers = listProviders({ activeOnly: true }).map(publicProvider);
  res.json({
    providers,
    enable_email_password_login: isPasswordLoginEnabled(),
  });
}));

router.get('/login/:providerId', wrap(async (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider || !provider.is_active) return res.status(404).send('Provider not found');

  const redirectUri = _resolveRedirectUri(provider, req);
  if (!redirectUri) return res.status(500).send('Provider has no redirect_uris configured');

  let client;
  try { client = await getClient(provider.id); }
  catch (e) {
    logger.warn(`[oidc] discovery failed for provider ${provider.id}: ${e?.message || e}`);
    return res.status(502).send('Could not reach identity provider');
  }

  const checks = generateAuthChecks();
  const linkMode = req.query.link === '1' && !!req.user;
  const isMobile = req.query.mobile === '1';
  const returnPath = typeof req.query.return === 'string' ? req.query.return.slice(0, 256) : '';
  persistState({
    providerId: provider.id,
    redirectUri,
    returnPath: linkMode ? (returnPath || '/profile') : returnPath,
    codeVerifier: checks.codeVerifier,
    state: checks.state,
    nonce: checks.nonce,
    mobile: isMobile,
    linkUserId: linkMode ? req.user.id : null,
  });

  const url = client.authorizationUrl({
    redirect_uri: redirectUri,
    scope: provider.scope,
    state: checks.state,
    nonce: checks.nonce,
    code_challenge: checks.codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(url);
}));

router.get('/callback/:providerId', wrap(async (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider) return res.status(404).send('Provider not found');

  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const state = params.get('state');
  if (!state) return res.status(400).send('Missing state');

  const stored = consumeState(state);
  if (!stored) return res.status(400).send('Invalid or expired state');
  if (Number(stored.providerId) !== Number(provider.id)) {
    return res.status(400).send('State / provider mismatch');
  }

  let tokenSet, claims;
  try {
    const client = await getClient(provider.id);
    const callbackParams = client.callbackParams(req);
    tokenSet = await client.callback(stored.redirectUri, callbackParams, {
      state,
      nonce: stored.nonce,
      code_verifier: stored.codeVerifier,
    });
    claims = tokenSet.claims();
  } catch (e) {
    logger.warn(`[oidc] callback failed for provider ${provider.id}: ${e?.message || e}`);
    if (stored.mobile) return res.redirect(`lifttrace://oidc-callback/?error=callback_failed`);
    return _redirectToLogin(res, stored.returnPath, 'callback_failed');
  }

  if (stored.linkUserId) {
    try {
      linkUser(stored.linkUserId, provider.id, claims.sub, !!claims.email_verified);
    } catch (e) {
      const msg = encodeURIComponent(e?.message || 'link_failed');
      if (stored.mobile) return res.redirect(`lifttrace://oidc-callback/?error=${msg}`);
      return _redirectToLogin(res, stored.returnPath, msg);
    }
    if (stored.mobile) return res.redirect(`lifttrace://oidc-callback/?linked=1`);
    return _redirectToLogin(res, stored.returnPath, null, 'linked');
  }

  let result;
  try {
    result = resolveUser(provider, claims);
  } catch (e) {
    logger.info(`[oidc] resolveUser rejected for sub=${claims.sub}: ${e.message}`);
    const msg = encodeURIComponent(e.message);
    if (stored.mobile) return res.redirect(`lifttrace://oidc-callback/?error=${msg}`);
    return _redirectToLogin(res, stored.returnPath, msg);
  }
  applyAdminMapping(provider, result.user, claims);

  // First-user bootstrap: claim orphaned data (mirrors password /register).
  if (result.created && db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n === 1) {
    db.prepare('UPDATE workout_log SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare('UPDATE body_stats_log SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare('UPDATE programs SET created_by = ? WHERE created_by IS NULL').run(result.user.id);
    db.prepare('UPDATE user_settings SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare('UPDATE ai_chat_history SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(result.user.id);
    result.user.role = 'admin';
    logger.info(`[oidc] first-user OIDC bootstrap: ${result.user.username} → admin`);
  }

  const token = signToken(result.user);
  if (stored.mobile) {
    // Native (Capacitor) flow — token handed off via custom-scheme deep link.
    // Slash before the query string is required for Chrome Custom Tabs to
    // dispatch the OS intent reliably.
    return res.redirect(`lifttrace://oidc-callback/?token=${encodeURIComponent(token)}`);
  }
  res.cookie('lt_token', token, { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  return _redirectToLogin(res, stored.returnPath, null, 'ok');
}));

function _redirectToLogin(res, returnPath, error, ok) {
  const basePath = (process.env.BASE_URL || '').replace(/\/$/, '');
  let dest = `${basePath}/`;
  let hash = returnPath || '/';
  if (!hash.startsWith('/')) hash = '/' + hash;
  let qs = '';
  if (error) qs = `?oidc_error=${error}`;
  else if (ok) qs = `?oidc=${ok}`;
  res.redirect(`${dest}#${hash}${qs}`);
}

router.post('/logout', wrap(async (req, res) => {
  res.clearCookie('lt_token');
  res.json({ ok: true });
}));

router.post('/unlink/:linkId', requireAuth, wrap((req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    unlinkUser(req.user.id, Number(req.params.linkId));
    res.json({ ok: true, links: listUserLinks(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Unlink failed' });
  }
}));

router.get('/links', requireAuth, wrap((req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ links: listUserLinks(req.user.id) });
}));

export default router;
