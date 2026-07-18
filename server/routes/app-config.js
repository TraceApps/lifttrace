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
  // backup_locked: BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION env
  // var set → Auto Backup UI disables, PUT schedule returns 409.
  // TraceApps parity with NT + CT.
  const { isBackupEnvLocked } = await import('./full-backup.js').catch(() => ({}));
  const backup_locked = typeof isBackupEnvLocked === 'function' ? isBackupEnvLocked() : false;
  res.json({
    smtp: isSmtpEnvLocked(),
    ai: aiLocked,
    ai_enabled,
    oidc_provider_ids: getEnvLockedProviderIds(),
    backup_locked,
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
  // Optional body: SMTP field overrides so the user can test unsaved
  // form values without saving first. Blocked when the env-lock is on
  // (config is baked into env vars, not the request).
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const envLocked = isSmtpEnvLocked();
  const overrides = envLocked ? undefined : {
    smtp_host:   body.smtp_host,
    smtp_port:   body.smtp_port,
    smtp_secure: body.smtp_secure,
    smtp_user:   body.smtp_user,
    // Never accept the redaction mask as a real password
    smtp_pass:   body.smtp_pass === '••••••••' ? undefined : body.smtp_pass,
    smtp_from:   body.smtp_from,
  };
  // Recipient priority: explicit body.to (from the Send Test dialog) →
  // current user's account email → fall through to email.js defaults
  // (smtp_from / smtp_user).
  const to = (typeof body.to === 'string' && body.to.trim()) || req.user?.email || undefined;
  // Origin lets the email template load the app logo. Recipient name
  // personalizes the greeting.
  const origin = `${req.protocol}://${req.get('host')}`;
  const recipientName = req.user?.full_name || req.user?.nickname || req.user?.username || null;
  try {
    const result = await testSmtp({ overrides, to, origin, recipientName });
    res.json({ ok: true, to: result.to });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'SMTP test failed' });
  }
}));

export default router;
