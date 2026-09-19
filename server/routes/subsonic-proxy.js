import { Router } from 'express';
import db from '../db.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { logger } from '../logger.js';

const router = Router();
router.use(requireAuth);

/**
 * Multi-provider music proxy.
 *
 * Subsonic:  /api/subsonic/rest/*           → radioUrl/rest/*
 * Jellyfin:  /api/subsonic/provider/jf/*    → radioUrl/*  (with X-Emby-Token)
 * Plex:      /api/subsonic/provider/plex/*  → radioUrl/*  (with X-Plex-Token)
 * Emby:      /api/subsonic/provider/emby/*  → radioUrl/*  (with X-Emby-Token)
 */

function _getSetting(userId, key, def) {
  if (userId) {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    if (row) try { return JSON.parse(row.value); } catch { return row.value; }
  }
  // Fallback to app_config
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row?.value || def;
}

function getRadioConfig(req) {
  const userId = uid(req);
  return {
    provider: _getSetting(userId, 'radioProvider', 'subsonic'),
    url:      _getSetting(userId, 'radioUrl', '') || _getSetting(null, 'radio_url', ''),
    user:     _getSetting(userId, 'radioUser', ''),
    password: _getSetting(userId, 'radioPassword', ''),
    token:    _getSetting(userId, 'radioToken', ''),   // for Plex/Emby API keys
  };
}

async function proxyRequest(targetUrl, headers, req, res) {
  try {
    // Forward Range header for audio seeking
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
    await pipeUpstream(upstream, res);
  } catch(e) {
    logger.warn(`[radio-proxy] ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'Could not reach music server' });
  }
}

/** Send an upstream response straight through, streaming audio without buffering it. */
async function pipeUpstream(upstream, res) {
  const ct = upstream.headers.get('content-type') || 'application/octet-stream';
  res.status(upstream.status);
  res.set('Content-Type', ct);

  // Forward audio/streaming headers
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }

  // Stream the body directly — don't buffer large audio files
  if (upstream.body) {
    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
  } else {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  }
}

// ── Subsonic: /api/subsonic/rest/* ───────────────────────────────────────────
// Express 5: wildcard must be named. `req.params.splat` is an array of path
// segments, joined back with `/` to reconstruct the upstream path.
router.all('/rest/*splat', async (req, res) => {
  const cfg = getRadioConfig(req);
  if (!cfg.url) return res.status(503).json({ error: 'Radio server not configured' });
  const subPath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
  const qs = new URLSearchParams(req.query).toString();
  const url = `${cfg.url.replace(/\/+$/, '')}/rest/${subPath}${qs ? '?' + qs : ''}`;
  await proxyRequest(url, {}, req, res);
});

// ── Jellyfin: /api/subsonic/provider/jf/* ────────────────────────────────────
// Auth follows Jellyfin's documented scheme: an `Authorization: MediaBrowser
// ..., Token="..."` header. Jellyfin 12 no longer accepts the legacy
// X-Emby-Authorization / X-Emby-Token headers this used to send, which left
// every library request at 401 (issue #100). The MediaBrowser header works on
// older servers too; if one still refuses it, the legacy headers are tried
// once before giving up, so an un-upgraded server keeps working.
const JF_CLIENT = 'MediaBrowser Client="LiftTrace", Device="Server", DeviceId="lifttrace-server", Version="1.3"';
export const jfAuthHeader = (token) => (token ? `${JF_CLIENT}, Token="${token}"` : JF_CLIENT);
const _jfModern = (token) => ({ Authorization: jfAuthHeader(token) });
const _jfLegacy = (token) => (token ? { 'X-Emby-Token': token } : { 'X-Emby-Authorization': JF_CLIENT });

async function _jfLogin(base, cfg) {
  for (const auth of [_jfModern(null), { 'X-Emby-Authorization': JF_CLIENT }]) {
    try {
      const r = await fetch(`${base}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ Username: cfg.user, Pw: cfg.password }),
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        if (data?.AccessToken) return data.AccessToken;
      } else {
        await r.body?.cancel().catch(() => {});
      }
    } catch (e) {
      logger.warn(`[radio-proxy] Jellyfin sign-in failed: ${e.message}`);
      return null;
    }
  }
  return null;
}

// The cached token belongs to one server and account: after the URL or the
// username changes it is ignored, rather than sent to the wrong server.
function _jfSavedToken(req, cfg) {
  const saved = _getSetting(uid(req), 'radioTokenFor', '');
  return cfg.token && saved === `${cfg.url}|${cfg.user}` ? cfg.token : '';
}
function _jfSaveToken(req, cfg, token) {
  const userId = uid(req);
  if (!userId) return;
  const put = db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
  put.run(userId, 'radioToken', JSON.stringify(token || ''));
  put.run(userId, 'radioTokenFor', JSON.stringify(token ? `${cfg.url}|${cfg.user}` : ''));
}

router.all('/provider/jf/*splat', async (req, res) => {
  const cfg = getRadioConfig(req);
  if (!cfg.url) return res.status(503).json({ error: 'Radio server not configured' });
  const base = cfg.url.replace(/\/+$/, '');
  const subPath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
  const qs = new URLSearchParams(req.query).toString();
  const url = `${base}/${subPath}${qs ? '?' + qs : ''}`;
  const hasLogin = !!(cfg.user && cfg.password);

  let token = _jfSavedToken(req, cfg);
  let fresh = false;
  if (!token && hasLogin) {
    token = await _jfLogin(base, cfg);
    fresh = true;
    _jfSaveToken(req, cfg, token);
  }

  try {
    const send = async (auth) => {
      const headers = { ...auth };
      if (req.headers.range) headers.Range = req.headers.range;
      return fetch(url, { headers, redirect: 'follow' });
    };
    const attempt = async (t) => {
      let r = await send(_jfModern(t));
      if (r.status === 401 && t) {
        await r.body?.cancel().catch(() => {});
        r = await send(_jfLegacy(t));   // older server that wants the legacy header
      }
      return r;
    };

    let upstream = await attempt(token);
    // A saved token can stop working (server reinstalled, password changed,
    // session signed out on the server): sign in again once and retry.
    if (upstream.status === 401 && hasLogin && !fresh) {
      await upstream.body?.cancel().catch(() => {});
      token = await _jfLogin(base, cfg);
      _jfSaveToken(req, cfg, token);
      upstream = await attempt(token);
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      return res.status(401).json({
        error: hasLogin
          ? 'Jellyfin refused the sign-in. Check the username and password in Settings, Radio.'
          : 'Jellyfin needs a username and password. Add them in Settings, Radio.',
      });
    }
    await pipeUpstream(upstream, res);
  } catch (e) {
    logger.warn(`[radio-proxy] ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'Could not reach music server' });
  }
});

// ── Plex: /api/subsonic/provider/plex/* ──────────────────────────────────────
router.all('/provider/plex/*splat', async (req, res) => {
  const cfg = getRadioConfig(req);
  if (!cfg.url) return res.status(503).json({ error: 'Radio server not configured' });
  const subPath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
  // Plex uses token in query or header
  const token = cfg.password || cfg.token; // Plex token goes in password field
  const params = { ...req.query };
  if (token) params['X-Plex-Token'] = token;
  const qs = new URLSearchParams(params).toString();
  const url = `${cfg.url.replace(/\/+$/, '')}/${subPath}${qs ? '?' + qs : ''}`;
  const headers = { Accept: 'application/json' };
  if (token) headers['X-Plex-Token'] = token;
  await proxyRequest(url, headers, req, res);
});

// ── Emby: /api/subsonic/provider/emby/* ──────────────────────────────────────
router.all('/provider/emby/*splat', async (req, res) => {
  const cfg = getRadioConfig(req);
  if (!cfg.url) return res.status(503).json({ error: 'Radio server not configured' });

  // Same auth flow as Jellyfin (Emby forked from it)
  let token = cfg.token;
  if (!token && cfg.user && cfg.password) {
    try {
      const authRes = await fetch(`${cfg.url.replace(/\/+$/, '')}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': `MediaBrowser Client="LiftTrace", Device="Web", DeviceId="lt-web", Version="1.0"` },
        body: JSON.stringify({ Username: cfg.user, Pw: cfg.password }),
      });
      if (authRes.ok) {
        const authData = await authRes.json();
        token = authData.AccessToken;
        const userId = uid(req);
        if (userId) {
          db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, 'radioToken', JSON.stringify(token));
        }
      }
    } catch(e) {
      logger.warn(`[radio-proxy] Emby auth failed: ${e.message}`);
    }
  }

  const subPath = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
  const qs = new URLSearchParams(req.query).toString();
  const url = `${cfg.url.replace(/\/+$/, '')}/${subPath}${qs ? '?' + qs : ''}`;
  const headers = {};
  if (token) headers['X-Emby-Token'] = token;
  await proxyRequest(url, headers, req, res);
});

export default router;
