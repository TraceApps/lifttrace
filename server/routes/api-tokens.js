/**
 * /api/admin/api-tokens — CRUD for personal access tokens (issue #78).
 *
 * Mounted INSIDE the regular /api authentication (cookie/session auth),
 * not the bearer auth those tokens themselves unlock. This is for the
 * Settings UI to manage tokens, not for MCP clients to use them.
 *
 * Restricted to admins; non-admins get 403. Single-user mode counts as
 * admin (requireAdmin already treats it that way — see middleware/auth.js).
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken, KNOWN_SCOPES, SCOPE_DESCRIPTIONS } from '../lib/api-tokens.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// A token needs a real owner (api_tokens.user_id is NOT NULL, referencing
// a real users row). requireAuth/requireAdmin both pass single-user-mode
// requests through unconditionally (mirroring every other admin-gated
// route), but single-user mode has zero rows in `users` — there is no
// id to own a token with. Refuse cleanly here rather than crashing on
// req.user.id below. The Settings UI additionally never routes here
// unless multi-user mode is genuinely active with a signed-in admin, so
// this only matters for someone calling the endpoint directly.
router.use((req, res, next) => {
  if (!req.user) {
    return res.status(400).json({
      error: 'API tokens require a signed-in account. Enable user management and sign in as an admin first.',
    });
  }
  next();
});

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

router.get('/', wrap((req, res) => {
  const tokens = listTokens(req.user.id);
  res.json({
    tokens,
    known_scopes: Array.from(KNOWN_SCOPES),
    scope_descriptions: SCOPE_DESCRIPTIONS,
    // Surface MCP flag state so the UI can show admins whether a token
    // holding mcp:write / mcp:destroy will actually work on this server.
    // Flags are captured at boot (env vars); change needs a restart.
    mcp_state: {
      enabled: _envFlag(process.env.MCP_ENABLED),
      write:   _envFlag(process.env.MCP_WRITE_ENABLED),
      destroy: _envFlag(process.env.MCP_DESTROY_ENABLED),
    },
  });
}));

router.post('/', wrap((req, res) => {
  const { name, scopes, expires_at } = req.body || {};
  try {
    const { row, raw } = createToken({
      userId: req.user.id,
      name,
      scopes,
      expiresAt: expires_at || null,
    });
    // raw is the only place the plaintext token appears. Returned
    // exactly once — the client UI is responsible for displaying it
    // to the user with a "save this now, you won't see it again"
    // affordance.
    res.status(201).json({ token: row, raw });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Not found' });
  const ok = revokeToken({ userId: req.user.id, id });
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

export default router;
