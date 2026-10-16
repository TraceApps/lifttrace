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
import { fetchChecked, serviceBase } from '../lib/ssrf-guard.js';

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
  const base = serviceBase(url);
  if (!base) return null;
  return { url: base, token, enabled: !!enabled };
}

// Only the name the Settings page shows, not whatever the address answered.
function _who(body) {
  const u = body?.user;
  if (!u || typeof u !== 'object') return null;
  const str = v => (typeof v === 'string' ? v.slice(0, 200) : null);
  return { username: str(u.username), full_name: str(u.full_name) };
}

// NutriTrace's own short error ("invalid token"), never the raw reply.
async function _ntErrorMessage(res) {
  const raw = await res.text().catch(() => '');
  try {
    const e = JSON.parse(raw)?.error;
    if (typeof e === 'string' && e) return `: ${e.slice(0, 200)}`;
  } catch {}
  return '';
}

// What went wrong, without the other server's words.
function _linkError(e) {
  const m = String(e?.message || '');
  if (/addresses are not allowed|addresses are blocked/.test(m)) return m;
  if (e?.name === 'AbortError' || /aborted/i.test(m)) return 'NutriTrace didn\'t answer in time';
  return 'Could not reach NutriTrace';
}

async function _ntFetch(cfg, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    // NutriTrace usually lives on the home network, so that's allowed for
    // every account; the address is still checked (never cloud metadata),
    // on every redirect hop (only followed on the same server), and the
    // connection pinned to it.
    return await fetchChecked(cfg.url + path, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    }, { allowPrivate: true, maxRedirects: 3, sameOrigin: true });
  } finally { clearTimeout(t); }
}

// POST /test — verify URL + token against NT's bearer-auth /api/v1/me.
// Body may include `url` and `token` overrides so the Settings page can
// test before the saved values reflect what the user typed.
router.post('/test', wrap(async (req, res) => {
  const u = uid(req);
  const raw = req.body?.url || _getSetting(u, 'ntInstanceUrl') || '';
  const token = req.body?.token || _getSetting(u, 'ntInstanceToken');
  if (!raw || !token) return res.status(400).json({ ok: false, error: 'URL and token required' });
  const url = serviceBase(raw);
  if (!url) return res.status(400).json({ ok: false, error: 'URL must start with http(s)://' });
  try {
    const ntRes = await _ntFetch({ url, token }, '/api/v1/me');
    if (!ntRes.ok) {
      return res.json({ ok: false, error: `NutriTrace returned ${ntRes.status}${await _ntErrorMessage(ntRes)}` });
    }
    const body = await ntRes.json().catch(() => ({}));
    // Surface the token's scopes so the UI can warn if write:workouts is missing.
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    if (!scopes.includes('write:workouts')) {
      return res.json({
        ok: false,
        error: 'Token is missing the write:workouts scope. Edit the token in NutriTrace and re-check the box.',
        user: _who(body),
      });
    }
    return res.json({ ok: true, user: _who(body) });
  } catch (e) {
    return res.json({ ok: false, error: _linkError(e) });
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
      const error = typeof body?.error === 'string' && body.error ? body.error.slice(0, 200) : `NutriTrace returned ${ntRes.status}`;
      return res.status(502).json({ error, code: typeof body?.code === 'string' ? body.code.slice(0, 60) : undefined });
    }
    // The app only needs to know it worked; nothing else of the reply goes back.
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: _linkError(e) });
  }
}));

export default router;
