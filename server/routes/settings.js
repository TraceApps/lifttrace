import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive, uid } from '../middleware/auth.js';
import { pushNotify } from '../lib/push-notify.js';

const router = Router();
router.use(requireAuth);

router.get('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({});
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id);
  const out = {};
  for (const { key, value } of rows) {
    try { out[key] = JSON.parse(value); } catch { out[key] = value; }
  }
  res.json(out);
}));

router.put('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({ ok: true });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
    .run(req.user.id, key, JSON.stringify(value));
  res.json({ ok: true });
}));

router.delete('/', wrap((req, res) => {
  if (userMgmtActive() && req.user) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(req.user.id);
  }
  res.json({ ok: true });
}));

// Clear all workout data for the current user (keeps exercises, settings, account)
router.delete('/clear-data', wrap((req, res) => {
  const userId = uid(req);
  db.prepare('DELETE FROM workout_log WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM body_stats_log WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM ai_chat_history WHERE user_id = ?').run(userId);
  // Delete user-created programs and their templates
  const userPrograms = db.prepare('SELECT id FROM programs WHERE created_by = ?').all(userId);
  for (const p of userPrograms) {
    db.prepare('DELETE FROM workout_templates WHERE program_id = ?').run(p.id);
  }
  db.prepare('DELETE FROM programs WHERE created_by = ?').run(userId);
  db.prepare('DELETE FROM program_assignments WHERE assigned_to = ?').run(userId);
  res.json({ ok: true });
}));

// Push test — sends a test notification via the specified push service
router.post('/push-test', wrap(async (req, res) => {
  const { service, title, message, priority } = req.body;
  const userId = uid(req);

  // Read user's stored push config
  function getSetting(key) {
    if (!userId) return null;
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  const svc = service || getSetting('notifPushService') || 'none';
  const t = title || 'LiftTrace';
  const m = message || 'Test notification — push service connected!';
  const p = priority || 5;

  try {
    if (svc === 'gotify') {
      const url = getSetting('gotifyUrl');
      const token = getSetting('gotifyToken');
      if (!url || !token) throw new Error('Gotify URL and token required');
      const r = await fetch(`${url}/message?token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, message: m, priority: p }),
      });
      if (!r.ok) throw new Error(`Gotify returned ${r.status}: ${await r.text()}`);
    } else if (svc === 'ntfy') {
      const url = getSetting('ntfyUrl') || 'https://ntfy.sh';
      const topic = getSetting('ntfyTopic');
      const token = getSetting('ntfyToken');
      if (!topic) throw new Error('ntfy topic required');
      const headers = { Title: t, Priority: String(Math.min(5, Math.ceil(p / 2))) };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`${url}/${topic}`, { method: 'POST', headers, body: m });
      if (!r.ok) throw new Error(`ntfy returned ${r.status}`);
    } else if (svc === 'apprise') {
      const url = getSetting('appriseUrl');
      const tag = getSetting('appriseTag');
      if (!url) throw new Error('Apprise URL required');
      const payload = { title: t, body: m, type: 'info' };
      if (tag) payload.tag = tag;
      const r = await fetch(`${url}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Apprise returned ${r.status}`);
    } else {
      throw new Error('No push service configured');
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
