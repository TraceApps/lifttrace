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
 *   GET  /body-composition  read persisted NT body-composition observations
 *   POST /body-provenance   fix which connection+source own imported body data
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { fetchChecked, serviceBase } from '../lib/ssrf-guard.js';
import { readSettingRaw, SECRET_SET } from '../lib/secret-settings.js';
import { claimProvenance, stableProvenance, stableIdentity, readMatchesClaim } from '../lib/nt-body-provenance.js';
import { issueReadReceipt, takeReadReceipt } from '../lib/nt-read-receipts.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

function _getSetting(userId, key) {
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE ${userId == null ? 'user_id IS NULL' : 'user_id = ?'} AND key = ?`
  ).get(...(userId == null ? [key] : [userId, key]));
  if (!row?.value) return null;
  return readSettingRaw(key, row.value);
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
  // A token typed in is tested as typed. The saved one (the page sends back
  // the placeholder it was shown) only goes to the address it was saved
  // for, never to one the request names (TraceApps/cooktrace#92).
  const typed = req.body?.token && req.body.token !== SECRET_SET ? req.body.token : null;
  if (!raw) return res.status(400).json({ ok: false, error: 'URL and token required' });
  const url = serviceBase(raw);
  if (!url) return res.status(400).json({ ok: false, error: 'URL must start with http(s)://' });
  const savedToken = _getSetting(u, 'ntInstanceToken');
  const sameAddress = url === serviceBase(_getSetting(u, 'ntInstanceUrl') || '');
  const token = typed || (sameAddress ? savedToken : null);
  if (!token) {
    const error = savedToken && !sameAddress ? 'Enter the access token again for this address' : 'URL and token required';
    return res.status(400).json({ ok: false, error });
  }
  try {
    const ntRes = await _ntFetch({ url, token }, '/api/v1/me');
    if (!ntRes.ok) {
      return res.json({ ok: false, error: `NutriTrace returned ${ntRes.status}${await _ntErrorMessage(ntRes)}` });
    }
    const body = await ntRes.json().catch(() => ({}));
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    const capabilities = {
      workoutWrite: scopes.includes('write:workouts'),
      bodyCompositionRead: scopes.includes('mcp:read'),
    };
    // Use the identity returned by NutriTrace, not user-entered URL text.
    // Token rotation for the same instance/user must not change provenance.
    const instanceUrl = typeof body?.instance?.url === 'string'
      ? body.instance.url.replace(/\/+$/, '')
      : '';
    const userId = body?.user?.id;
    if (!instanceUrl || userId == null || String(userId).length === 0) {
      return res.json({
        ok: false,
        error: 'NutriTrace response did not include a stable connection identity.',
        user: _who(body),
        scopes,
        capabilities,
      });
    }
    const connectionIdentity = { instanceUrl, userId: String(userId) };
    if (!capabilities.workoutWrite) {
      return res.json({
        ok: false,
        error: 'Token is missing the write:workouts scope. Edit the token in NutriTrace and re-check the box.',
        user: _who(body),
        scopes,
        capabilities,
        connectionIdentity,
      });
    }
    return res.json({ ok: true, user: _who(body), scopes, capabilities, connectionIdentity });
  } catch (e) {
    return res.json({ ok: false, error: _linkError(e) });
  }
}));

// GET /body-composition — narrow proxy to NutriTrace's native read API.
// Only documented query parameters are forwarded; the bearer token remains
// server-side. NutriTrace requires mcp:read and PUBLIC_API_ENABLED=1.
//
// Every successful read carries a receipt (X-LT-Nt-Read-Id) bound to the
// verified connection the read was answered with. The import claim must present
// it, so measurements read through one connection can never be attributed to
// another that was restored before the claim (see lib/nt-read-receipts.js).
router.get('/body-composition', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) return res.status(503).json({ error: 'Federation not enabled' });

  // Snapshot before the await: this is the connection the proxy is about to
  // read with, and the receipt has to name it, not whatever is saved when the
  // other server answers.
  const readIdentity = stableIdentity(_getSetting(u, 'ntConnectionIdentity'));
  if (!readIdentity) {
    return res.status(503).json({ error: 'NutriTrace connection is not verified', code: 'connection-unverified' });
  }

  const { start, end, source } = req.query || {};
  for (const [name, value] of [['start', start], ['end', end]]) {
    if (value != null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
    }
  }
  if (source != null && typeof source !== 'string') {
    return res.status(400).json({ error: 'source must be a string' });
  }

  const query = new URLSearchParams();
  if (start) query.set('start', start);
  if (end) query.set('end', end);
  if (source) query.set('source', source);
  const path = `/api/v1/body-composition${query.toString() ? `?${query}` : ''}`;

  try {
    const ntRes = await _ntFetch(cfg, path);
    const body = await ntRes.json().catch(() => ({}));
    if (!ntRes.ok) {
      return res.status(502).json({
        error: body?.error || `NutriTrace returned ${ntRes.status}`,
        code: body?.code,
      });
    }
    const readId = issueReadReceipt(u, readIdentity);
    // Header only: the answered body keeps NutriTrace's own shape.
    if (readId) res.set('X-LT-Nt-Read-Id', readId);
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: _linkError(e) });
  }
}));

/**
 * Send a finished workout's calories to the account's NutriTrace. The app
 * asks for it through POST /log-workout below; a workout finished on the
 * watch has the server ask for it itself (lib/watch-finish.js). Returns
 * { status, body }: what the route answers with.
 */
export async function logWorkoutToNt(userId, { date, name, duration_min, calories_burned, external_id, start_time } = {}) {
  const cfg = _config(userId);
  if (!cfg || !cfg.enabled) return { status: 503, body: { error: 'Federation not enabled' } };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return { status: 400, body: { error: 'date must be YYYY-MM-DD' } };
  }
  if (!external_id) {
    return { status: 400, body: { error: 'external_id required' } };
  }
  const kcal = Number(calories_burned);
  if (!Number.isFinite(kcal) || kcal <= 0) {
    // 0 kcal would just dirty the NT row for no value; reject so the
    // client knows it doesn't have a usable estimate yet.
    return { status: 400, body: { error: 'calories_burned must be > 0' } };
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
      return { status: 502, body: { error, code: typeof body?.code === 'string' ? body.code.slice(0, 60) : undefined } };
    }
    // The app only needs to know it worked; nothing else of the reply goes back.
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 502, body: { error: _linkError(e) } };
  }
}

// POST /log-workout: forward a completed workout summary to NT.
// Body shape (passed straight through after light validation):
//   { date, name, duration_min, calories_burned, external_id, start_time? }
// Server-side gates: federation must be enabled and configured.
router.post('/log-workout', wrap(async (req, res) => {
  const { status, body } = await logWorkoutToNt(uid(req), req.body || {});
  res.status(status).json(body);
}));

// POST /body-provenance — fix, once per account, which NutriTrace connection
// and source own the body measurements imported here.
//
// The client cannot decide this by itself: two tabs (or two devices) opened
// before the first import both see an empty local marker and both would pass
// a local check, mixing one account's history between sources. The claim is a
// compare-and-set in lib/nt-body-provenance.js, so exactly one pair is fixed
// and every later different claim is refused with the pair that won.
//
// The claim must also name the connection this server verified and will proxy
// with. In the window where the app already shows a new connection but the
// server still holds the old one, an import would otherwise be attributed to
// the wrong NutriTrace account.
router.post('/body-provenance', wrap((req, res) => {
  const u = uid(req);
  if (u == null) return res.status(400).json({ error: 'Account required', code: 'no-account' });
  const candidate = stableProvenance({
    connectionIdentity: req.body?.connectionIdentity,
    source: req.body?.source,
  });
  if (!candidate) {
    return res.status(400).json({ error: 'A connection identity and source are required', code: 'invalid-claim' });
  }
  const verified = stableIdentity(_getSetting(u, 'ntConnectionIdentity'));
  if (!verified || verified.instanceUrl !== candidate.instanceUrl || verified.userId !== candidate.userId) {
    return res.status(409).json({
      error: 'The saved connection does not match this import',
      code: 'connection-mismatch',
      provenance: verified ? { ...verified, source: candidate.source } : null,
    });
  }
  // The claim must present the receipt of the read its measurements came from.
  // The saved connection can be switched away and back between that read and
  // this call, so "matches what is saved now" alone cannot tell whose data it
  // is; the receipt names the connection the read was actually answered with.
  const readId = typeof req.body?.readId === 'string' ? req.body.readId : '';
  if (!readId) {
    return res.status(409).json({ error: 'The read this import came from is unknown', code: 'read-receipt-missing' });
  }
  const receipt = takeReadReceipt(readId, u);
  if (!receipt) {
    return res.status(409).json({ error: 'The read this import came from is unknown or expired', code: 'read-receipt-missing' });
  }
  if (!readMatchesClaim(receipt, candidate)) {
    return res.status(409).json({
      error: 'The measurements were read through another connection',
      code: 'read-identity-mismatch',
      provenance: { ...receipt, source: candidate.source },
    });
  }
  const result = claimProvenance(db, u, candidate);
  if (!result.ok) {
    return res.status(409).json({
      error: 'Body measurements are already attributed to another source',
      code: result.code,
      provenance: result.provenance || null,
    });
  }
  res.json({ ok: true, first: result.first, provenance: result.provenance });
}));

export default router;
