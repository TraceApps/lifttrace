/**
 * push-notify.js — Server-side push notifications via Gotify, ntfy, or Apprise.
 * Reads the user's push service config from user_settings.
 * Same pattern as NutriTrace: prefixes titles with "LiftTrace — ",
 * checks per-notification-type setting before sending.
 */

import db from '../db.js';
import { logger } from '../logger.js';

function _getSetting(userId, key) {
  if (userId) {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    if (row?.value) try { return JSON.parse(row.value); } catch { return row.value; }
  }
  // Fallback for single-user mode
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  if (row?.value) try { return JSON.parse(row.value); } catch { return row.value; }
  return '';
}

function _isEnabled(userId, key) {
  const val = _getSetting(userId, key);
  return val === true || val === 'true';
}

// ── Push dispatch ────────────────────────────────────────────────────────────

async function _pushToService(userId, title, message, priority = 5) {
  const service = _getSetting(userId, 'notifPushService');
  if (!service || service === 'none') return;

  const fullTitle = `LiftTrace — ${title}`;

  try {
    if (service === 'gotify') {
      const url = _getSetting(userId, 'gotifyUrl');
      const token = _getSetting(userId, 'gotifyToken');
      if (!url || !token) return;
      const res = await fetch(`${url}/message?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: fullTitle, message, priority }),
      });
      if (!res.ok) throw new Error(`Gotify ${res.status}`);
      logger.debug(`[push] gotify: "${title}" → user ${userId}`);

    } else if (service === 'ntfy') {
      const url = _getSetting(userId, 'ntfyUrl') || 'https://ntfy.sh';
      const topic = _getSetting(userId, 'ntfyTopic');
      const token = _getSetting(userId, 'ntfyToken');
      if (!topic) return;
      const headers = { 'Title': fullTitle, 'Priority': String(Math.min(5, priority)) };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST', headers, body: message,
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      logger.debug(`[push] ntfy: "${title}" → user ${userId}`);

    } else if (service === 'apprise') {
      const url = _getSetting(userId, 'appriseUrl');
      const tag = _getSetting(userId, 'appriseTag');
      if (!url) return;
      const body = { title: fullTitle, body: message, type: priority >= 7 ? 'warning' : 'info' };
      if (tag) body.tag = tag;
      const res = await fetch(`${url.replace(/\/+$/, '')}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Apprise ${res.status}`);
      logger.debug(`[push] apprise: "${title}" → user ${userId}`);
    }
  } catch(e) {
    logger.warn(`[push] ${service} failed for user ${userId}: ${e.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a push notification if the specific setting is enabled.
 * @param {number|null} userId
 * @param {string} title — notification title (emoji prefix included by caller)
 * @param {string} message — notification body
 * @param {number} priority — 1-10 (mapped to service-specific scale)
 */
export async function pushNotify(userId, title, message, priority = 5) {
  return _pushToService(userId, title, message, priority);
}
