import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive, uid } from '../middleware/auth.js';
import { decide } from '../lib/newer-wins.js';
import { resetWins } from '../lib/deleted-rows.js';
import { pushNotify } from '../lib/push-notify.js';
import { deleteMediaForUser } from '../lib/body-stat-media.js';
import { deleteMediaForUser as deleteSetMediaForUser } from '../lib/set-media.js';
import { fetchChecked, serviceBase } from '../lib/ssrf-guard.js';
import { clientSetting, readSettingRaw, settingToStore } from '../lib/secret-settings.js';
import {
  isReservedProvenanceKey,
  deleteUserSettingsKeepingProvenance,
  clearProvenance,
} from '../lib/nt-body-provenance.js';
import {
  NT_CONNECTION_VERSION_KEY,
  bumpConnectionVersion,
  isConnectionSettingKey,
  isServerOwnedNtKey,
} from '../lib/nt-connection.js';

// Push services usually live on the home network, so that's allowed for
// every account; the address is still checked, and a redirect only
// followed on the same server.
async function _sendPush(url, init) {
  const res = await fetchChecked(url, init, { allowPrivate: true, maxRedirects: 3, sameOrigin: true });
  if (res.ok) { try { await res.body?.cancel(); } catch {} }
  return res;
}

// The service's own short error ("unauthorized"), never its raw reply.
async function _pushErrorMessage(resp) {
  const raw = await resp.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    for (const v of [j?.errorDescription, j?.error?.message, j?.error, j?.message]) {
      if (typeof v === 'string' && v) return `: ${v.slice(0, 100)}`;
    }
  } catch {}
  return '';
}

const router = Router();
router.use(requireAuth);

router.get('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({});
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id);
  const out = {};
  for (const { key, value } of rows) {
    let v; try { v = JSON.parse(value); } catch { v = value; }
    // A secret only the server uses is said to be set, never sent (TraceApps/cooktrace#92).
    out[key] = clientSetting(key, v);
  }
  res.json(out);
}));

router.put('/', wrap((req, res) => {
  if (!userMgmtActive() || !req.user) return res.json({ ok: true });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  // The body-import provenance is owned by the server (lib/nt-body-provenance.js).
  // Accepting it here would let a settings write replace a fixed claim, or forge
  // the legacy pair that seeds the first one, and then imported measurements
  // from another source would pass verifyProvenance() over the first history.
  if (isReservedProvenanceKey(key) || isServerOwnedNtKey(key)) {
    return res.status(403).json({
      error: 'This setting is owned by the server',
      code: 'reserved-setting',
    });
  }
  // The newer edit of a setting stays (lib/newer-wins.js). Losing, the row
  // is still written (as it is), so its change time moves and the device
  // gets the value that stays with its next pull.
  const existing = db.prepare('SELECT * FROM user_settings WHERE user_id = ? AND key = ?').get(req.user.id, key);
  // Reset (Clear All Settings) after this change was made: it stays reset,
  // and the device that sent it goes back to the default with its next pull.
  if (!existing && resetWins(req, req.user.id, key)) return res.json({ ok: true, value: null, reset: true });
  // A secret is stored encrypted, and the placeholder sent back for one
  // leaves it be (TraceApps/cooktrace#92).
  const sent = value === undefined ? undefined : settingToStore(key, value, existing?.value ?? null);
  if (value !== undefined && sent === undefined) return res.json({ ok: true, value: clientSetting(key, readSettingRaw(key, existing?.value ?? 'null')) });
  // Compared as stored (JSON text): an object sent is the same setting as
  // the same object kept.
  const { keep, times } = decide(req, existing, { value: sent }, { fields: ['value'] });
  const stays = existing && keep.has('value') ? existing.value : sent;
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value, field_times) VALUES (?, ?, ?, ?)')
    .run(req.user.id, key, stays, times);
  // A client from before the atomic endpoint still saves the connection one
  // key at a time. That is a transition too: bump the version so a Save that
  // was already on its way with the old one cannot pass its compare-and-set
  // after this write. The value is compared as stored, so writing the same
  // value changes nothing.
  if (isConnectionSettingKey(key) && stays !== (existing?.value ?? null)) {
    bumpConnectionVersion(db, req.user.id);
  }
  res.json({ ok: true, value: clientSetting(key, readSettingRaw(key, stays ?? 'null')) });
}));

router.delete('/', wrap((req, res) => {
  if (userMgmtActive() && req.user) {
    // Was there a connection to clear? A user who never saved one must not get
    // a version row out of "Clear All Settings".
    const hadConnection = !!db.prepare(
      `SELECT 1 FROM user_settings WHERE user_id = ? AND key IN ('ntInstanceUrl', 'ntInstanceToken', 'ntFederationEnabled', ?)`
    ).get(req.user.id, NT_CONNECTION_VERSION_KEY);
    // Ordinary settings only: deleting the provenance would release a source
    // that still owns the imported body history, letting the next import mix
    // another source over it. It is released with the history (clear-data).
    // Keep the monotonic connection version too: settings are cleared, but the
    // saved connection still exists, and a stale Save must not become current
    // again just because the counter row went away.
    deleteUserSettingsKeepingProvenance(db, req.user.id, [NT_CONNECTION_VERSION_KEY]);
    // Clearing the connection is a transition even though the version row is
    // kept: a Save waiting on NutriTrace while this ran must not pass its
    // compare-and-set and restore the connection alone.
    if (hadConnection) bumpConnectionVersion(db, req.user.id);
  }
  res.json({ ok: true });
}));

// Clear all workout data for the current user (keeps exercises, settings, account)
router.delete('/clear-data', wrap((req, res) => {
  const userId = uid(req);
  db.prepare('DELETE FROM workout_log WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM body_stats_log WHERE user_id = ?').run(userId);
  // Excused days are the diary's too (issue #121). Without accounts they're
  // the NULL owner's, which `= ?` never matches.
  db.prepare('DELETE FROM excused_days WHERE user_id IS ?').run(userId);
  // The imported body history is gone with it, so its provenance claim is
  // released too; keeping it would refuse every later source forever. The
  // six-hour throttle goes with it, or the next automatic import would be
  // skipped because the cleared one "just ran".
  if (userId != null) {
    clearProvenance(db, userId);
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, 'ntBodyLastSyncAt');
  }
  // Progress photos own files on disk, so they need the file-aware
  // helper rather than a plain row delete, or the images are orphaned.
  deleteMediaForUser(userId);
  deleteSetMediaForUser(userId);
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
    return readSettingRaw(key, row.value);
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
      const r = await _sendPush(`${serviceBase(url) ?? url}/message?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, message: m, priority: p }),
      });
      if (!r.ok) throw new Error(`Gotify returned ${r.status}${await _pushErrorMessage(r)}`);
    } else if (svc === 'ntfy') {
      const url = getSetting('ntfyUrl') || 'https://ntfy.sh';
      const topic = getSetting('ntfyTopic');
      const token = getSetting('ntfyToken');
      if (!topic) throw new Error('ntfy topic required');
      const headers = { Title: t, Priority: String(Math.min(5, Math.ceil(p / 2))) };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await _sendPush(`${serviceBase(url) ?? url}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: m });
      if (!r.ok) throw new Error(`ntfy returned ${r.status}${await _pushErrorMessage(r)}`);
    } else if (svc === 'apprise') {
      const url = getSetting('appriseUrl');
      const tag = getSetting('appriseTag');
      if (!url) throw new Error('Apprise URL required');
      const payload = { title: t, body: m, type: 'info' };
      if (tag) payload.tag = tag;
      const r = await _sendPush(`${serviceBase(url) ?? url}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Apprise returned ${r.status}${await _pushErrorMessage(r)}`);
    } else {
      throw new Error('No push service configured');
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
