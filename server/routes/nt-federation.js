/**
 * nt-federation.js — proxy layer to a configured NutriTrace instance.
 *
 * Stores the user's NT URL + bearer token in user_settings (per-user) and
 * forwards calls to NT server-side so the token never leaves this server
 * to the WebView / browser. Modelled on CookTrace's federation pattern.
 *
 * Endpoints (all require LiftTrace auth):
 *   POST /test          verify URL + token via NT /api/v1/me
 *   POST /log-workout   forward a completed workout to NT /api/v1/workouts
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

function _getSetting(userId, key) {
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE ${userId == null ? 'user_id IS NULL' : 'user_id = ?'} AND key = ?`
  ).get(...(userId == null ? [key] : [userId, key]));
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _config(userId) {
  const url = _getSetting(userId, 'ntInstanceUrl');
  const token = _getSetting(userId, 'ntInstanceToken');
  const enabled = _getSetting(userId, 'ntFederationEnabled');
  if (!url || !token) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url: url.replace(/\/$/, ''), token, enabled: !!enabled };
}

async function _ntFetch(cfg, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(cfg.url + path, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

// POST /test — verify URL + token against NT's bearer-auth /api/v1/me.
// Body may include `url` and `token` overrides so the Settings page can
// test before the saved values reflect what the user typed.
router.post('/test', wrap(async (req, res) => {
  const u = uid(req);
  const url = (req.body?.url || _getSetting(u, 'ntInstanceUrl') || '').replace(/\/$/, '');
  const token = req.body?.token || _getSetting(u, 'ntInstanceToken');
  if (!url || !token) return res.status(400).json({ ok: false, error: 'URL and token required' });
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'URL must start with http(s)://' });
  try {
    const ntRes = await _ntFetch({ url, token }, '/api/v1/me');
    if (!ntRes.ok) {
      const text = await ntRes.text().catch(() => '');
      const detail = text && text.length < 240 ? `: ${text}` : '';
      return res.json({ ok: false, error: `NutriTrace returned ${ntRes.status}${detail}` });
    }
    const body = await ntRes.json().catch(() => ({}));
    // Surface the token's scopes so the UI can warn if write:workouts is missing.
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    if (!scopes.includes('write:workouts')) {
      return res.json({
        ok: false,
        error: 'Token is missing the write:workouts scope. Edit the token in NutriTrace and re-check the box.',
        user: body.user || null,
      });
    }
    return res.json({ ok: true, user: body.user || null });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'Connection failed' });
  }
}));

// POST /log-workout — forward a completed workout summary to NT.
// Body shape (passed straight through after light validation):
//   { date, name, duration_min, calories_burned, external_id, start_time? }
// Server-side gates: federation must be enabled and configured.
router.post('/log-workout', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) return res.status(503).json({ error: 'Federation not enabled' });
  const { date, name, duration_min, calories_burned, external_id, start_time } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (!external_id) {
    return res.status(400).json({ error: 'external_id required' });
  }
  const kcal = Number(calories_burned);
  if (!Number.isFinite(kcal) || kcal <= 0) {
    // 0 kcal would just dirty the NT row for no value; reject so the
    // client knows it doesn't have a usable estimate yet.
    return res.status(400).json({ error: 'calories_burned must be > 0' });
  }
  try {
    const ntRes = await _ntFetch(cfg, '/api/v1/workouts', {
      method: 'POST',
      body: JSON.stringify({
        date,
        name: name || 'Workout',
        duration_min: duration_min != null ? Number(duration_min) : null,
        calories_burned: Math.round(kcal),
        external_id: String(external_id),
        start_time: start_time || null,
      }),
    });
    const body = await ntRes.json().catch(() => ({}));
    if (!ntRes.ok) {
      return res.status(502).json({ error: body?.error || `NutriTrace returned ${ntRes.status}`, code: body?.code });
    }
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Federation request failed' });
  }
}));

export default router;
