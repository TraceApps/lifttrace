import { Router } from 'express';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { pushNotify } from '../lib/push-notify.js';

const router = Router();
router.use(requireAuth);

/**
 * POST /api/notify
 * Client-triggered push notification (celebrations, PRs, etc.)
 * Body: { title, body, priority }
 * Routes through the user's configured push service with proper
 * "LiftTrace — " prefix. Title/body are used verbatim (caller provides
 * emoji prefix).
 */
router.post('/', wrap(async (req, res) => {
  const { title, body, priority } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  try {
    await pushNotify(uid(req), title, body, priority || 5);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

export default router;
