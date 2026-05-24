import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { testSmtp, isSmtpEnvLocked } from '../email.js';
import { isAiEnvLocked } from '../ai.js';

const router = Router();

const ALLOWED_KEYS = new Set([
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
  'ai_enabled', 'ai_provider', 'ai_api_key', 'ai_model',
  'session_hours',
  'radio_url',
  'password_policy',
]);

router.get('/env-locks', requireAuth, wrap(async (req, res) => {
  // Lazy import — oidc-env is only meaningful when OIDC is configured.
  const { getEnvLockedProviderIds } = await import('../lib/oidc-env.js');
  // Surface ai_enabled too when env-locked — without it the client can
  // disable the toggle but the per-user setting never reflects the
  // operator's AI_ENABLED=true choice. Mirrors NutriTrace #36.
  const aiLocked = isAiEnvLocked();
  let ai_enabled = false;
  if (aiLocked) {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = 'ai_enabled'`).get();
    ai_enabled = row?.value === 'true';
  }
  res.json({
    smtp: isSmtpEnvLocked(),
    ai: aiLocked,
    ai_enabled,
    oidc_provider_ids: getEnvLockedProviderIds(),
  });
}));

router.get('/', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_config').all();
  const out = {};
  for (const { key, value } of rows) {
    const redacted = key === 'smtp_pass' || key === 'ai_api_key';
    out[key] = redacted ? (value ? '••••••••' : '') : (value || '');
  }
  res.json(out);
}));

router.put('/', requireAuth, requireAdmin, wrap((req, res) => {
  const { key, value } = req.body;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Unknown config key' });
  if (key.startsWith('smtp_') && isSmtpEnvLocked()) return res.status(403).json({ error: 'SMTP locked via env vars' });
  if (key.startsWith('ai_') && isAiEnvLocked()) return res.status(403).json({ error: 'AI locked via env vars' });
  if ((key === 'smtp_pass' || key === 'ai_api_key') && value === '••••••••') return res.json({ ok: true });
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value || null);
  res.json({ ok: true });
}));

router.post('/test-email', requireAuth, requireAdmin, wrap(async (req, res) => {
  await testSmtp();
  res.json({ ok: true });
}));

export default router;
