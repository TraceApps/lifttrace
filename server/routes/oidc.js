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
import { claimAnonymousData } from '../lib/claim-anonymous-data.js';

const router = Router();

const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000,
  secure:   !_insecureCookies,
};
const LOGOUT_COOKIE = 'lt_oidc_logout';

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
  // Shares one helper with the password path so the two cannot drift — an
  // OIDC-first instance has exactly the same single-user data to adopt.
  if (result.created && db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n === 1) {
    claimAnonymousData(result.user.id);
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(result.user.id);
    result.user.role = 'admin';
    logger.info(`[oidc] first-user OIDC bootstrap: ${result.user.username} → admin`);
  }

  const token = signToken(result.user);
  if (stored.mobile) {
    // Native (Capacitor) flow — token handed off via custom-scheme deep link.
    // Slash before the query string is required for Chrome Custom Tabs to
    // dispatch the OS intent reliably.
    // id_token_hint + provider_id ride along so the app can persist them
    // locally for RP-initiated logout later. The cookie path used by PWA
    // doesn't reach the WebView's separate cookie jar, so the client has
    // to remember these itself.
    let deepLink = `lifttrace://oidc-callback/?token=${encodeURIComponent(token)}`;
    if (tokenSet?.id_token) {
      deepLink += `&id_token_hint=${encodeURIComponent(tokenSet.id_token)}`;
      deepLink += `&provider_id=${encodeURIComponent(provider.id)}`;
    }
    return res.redirect(deepLink);
  }
  res.cookie('lt_token', token, { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  // Save enough OIDC session context for RP-initiated logout later.
  if (tokenSet?.id_token) {
    res.cookie(LOGOUT_COOKIE, JSON.stringify({ providerId: provider.id, idTokenHint: tokenSet.id_token }), {
      ...COOKIE_OPTS,
      maxAge: sessionMaxAge(),
    });
  } else {
    res.clearCookie(LOGOUT_COOKIE);
  }
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

/**
 * POST /api/auth/oidc/logout
 * Clears LiftTrace's own session, then (when we recorded a provider at
 * login) builds an end_session_endpoint URL with id_token_hint and
 * post_logout_redirect_uri and returns it to the client. The client
 * follows the URL to perform RP-initiated logout at the IdP so the
 * next sign-in isn't silently completed by a still-alive IdP session.
 */
router.post('/logout', wrap(async (req, res) => {
  const raw = req.cookies?.[LOGOUT_COOKIE];
  res.clearCookie('lt_token');
  res.clearCookie(LOGOUT_COOKIE);

  // Native clients can't reach the LOGOUT_COOKIE jar set in the Custom Tabs
  // browser, so they POST the same id_token_hint + providerId they were
  // handed at login time. Body wins when present; otherwise fall back to
  // the cookie (PWA path).
  let saved = null;
  if (req.body?.idTokenHint && req.body?.providerId) {
    saved = { idTokenHint: String(req.body.idTokenHint), providerId: req.body.providerId };
  } else if (raw) {
    try { saved = JSON.parse(raw); } catch {}
  }
  if (!saved?.providerId) return res.json({ ok: true });

  const provider = getProvider(saved.providerId);
  if (!provider || !provider.is_active) return res.json({ ok: true });

  try {
    const client = await getClient(provider.id);
    const endSessionEndpoint = client.issuer?.metadata?.end_session_endpoint;
    if (!endSessionEndpoint) return res.json({ ok: true });

    // Mobile (Capacitor) returns to the app via the same deep-link scheme
    // used by the OIDC login callback. The user must register
    // `lifttrace://oidc-callback` as a Post Logout Redirect URI at the
    // IdP (alongside the equivalent HTTPS root URL for PWA).
    const isMobile = req.query?.mobile === '1' || req.query?.mobile === 'true';
    let postLogoutRedirectUri;
    if (isMobile) {
      postLogoutRedirectUri = 'lifttrace://oidc-callback';
    } else {
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const basePath = (process.env.BASE_URL || '').replace(/\/$/, '');
      postLogoutRedirectUri = `${proto}://${host}${basePath}/`;
    }

    const logoutUrl = new URL(endSessionEndpoint);
    logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    if (saved.idTokenHint) logoutUrl.searchParams.set('id_token_hint', saved.idTokenHint);

    return res.json({ ok: true, logoutUrl: logoutUrl.toString() });
  } catch (e) {
    logger.warn(`[oidc] logout failed for provider ${saved.providerId}: ${e?.message || e}`);
    return res.json({ ok: true });
  }
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
