import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { mergeStatsObject } from '../lib/workout-merge.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { unlinkMediaFile, resolvePhotoFileForUser } from '../lib/body-stat-media.js';
import { listProgressPhotosCore } from '../lib/mcp/tools/list-progress-photos.js';
import { addProgressPhotoCore } from '../lib/mcp/tools/add-progress-photo.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { assertAllowedMedia } from '../lib/image-magic.js';

const router = Router();
router.use(requireAuth);

// GET /api/body-stats/range?start=YYYY-MM-DD&end=YYYY-MM-DD — batch fetch
// Returns every body_stats_log row in the window, already JSON-parsed.
// Used by Statistics to avoid N sequential requests per date.
router.get('/range', wrap((req, res) => {
  const { start, end } = req.query;
  const userId = uid(req);
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' });
  const rows = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC').all(userId, start, end)
    : db.prepare('SELECT * FROM body_stats_log WHERE user_id IS NULL AND date BETWEEN ? AND ? ORDER BY date ASC').all(start, end);
  for (const r of rows) r.stats = JSON.parse(r.stats || '{}');
  res.json(rows);
}));

// ── Progress photos ───────────────────────────────────────────────────────
// Declared BEFORE /:date, or Express matches "photos" as a date param.
//
// Reads and writes go through the same xCore functions the MCP tools and
// /api/v1 use, so there is one implementation of each, not three. Delete
// is app-only (no MCP or REST equivalent, matching how public-api.js
// exposes no DELETE at all) and owns its own logic here.

// GET /api/body-stats/photos?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/photos', wrap((req, res) => {
  try {
    res.json(listProgressPhotosCore(uid(req), { start: req.query.start, end: req.query.end }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// POST /api/body-stats/photos  { date, url }
// Two-step: the client uploads to /api/upload/body-stats first, then
// attaches the URL that route returns. Keeps the upload route unaware of
// body-stats and reusable.
// An embedded image becomes a file in the progress-photo directory and its
// path; anything else is left exactly as it came.
const _DATA_URL = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i;
const MAX_EMBEDDED_BYTES = 12 * 1024 * 1024;
function _photoFromDataUrl(value) {
  if (typeof value !== 'string' || !_DATA_URL.test(value)) return null;
  const [head, b64] = value.split(',', 2);
  const ext = head.match(/^data:image\/([a-z]+);/i)?.[1].toLowerCase().replace('jpeg', 'jpg') || 'jpg';
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > MAX_EMBEDDED_BYTES) throw new Error('That photo is too large.');
  const dir = path.join(process.env.UPLOADS_PATH || './uploads', 'body-stats');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  // The same magic-byte check the upload route runs: a client-sent type is
  // not evidence of anything.
  try { assertAllowedMedia(path.join(dir, filename), ['image']); }
  catch (e) { try { fs.unlinkSync(path.join(dir, filename)); } catch {} throw e; }
  return `/uploads/body-stats/${filename}`;
}

router.post('/photos', wrap((req, res) => {
  try {
    // A photo taken with no connection has nowhere to upload to, so it
    // arrives embedded in this request instead. It becomes a file here,
    // under the same directory the upload route writes to, and the row
    // still holds an ordinary path: addProgressPhotoCore rightly refuses
    // to store a data: value, and that stays true.
    const url = _photoFromDataUrl(req.body?.url) ?? req.body?.url;
    res.status(201).json(addProgressPhotoCore(uid(req), { date: req.body?.date, url }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// GET /api/body-stats/photos/:id/file, the image bytes themselves.
//
// Progress photos are NOT served from the static /uploads tree the way
// avatars and exercise media are. That tree is mounted ahead of the auth
// middleware so an Android WebView <img> can load it without an
// Authorization header, which means anything in it is readable by anyone
// holding the URL. That is an accepted trade for a shared exercise-demo
// GIF and a bad one for a progress photo.
//
// Serving them here instead means the request passes through requireAuth
// like every other route, and the row is looked up by id so ownership is
// checked against the database rather than inferred from a filename. The
// client fetches this with an ordinary fetch() (which already carries the
// cookie on web and a bearer token on native) and renders the result from
// an object URL, so no <img> request ever has to authenticate itself.
router.get('/photos/:id/file', wrap((req, res) => {
  const found = resolvePhotoFileForUser(uid(req), req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  res.sendFile(found.path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
}));

// DELETE /api/body-stats/photos/:id, soft-deletes the row so the delete
// syncs to other devices, and unlinks the file so it does not linger as
// an orphan the way custom-exercise media currently does.
router.delete('/photos/:id', wrap((req, res) => {
  const userId = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = userId != null
    ? db.prepare('SELECT * FROM body_stat_media WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId)
    : db.prepare('SELECT * FROM body_stat_media WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE body_stat_media SET deleted_at = datetime('now') WHERE id = ?").run(id);
  unlinkMediaFile(row.url);
  res.json({ ok: true });
}));

router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const row = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  if (row) row.stats = JSON.parse(row.stats || '{}');
  res.json({ stats: row || null });
}));

// PUT /api/body-stats/:date — save/update
//
// Per-key merge (Option C port, 2026-08-11). Prior behavior replaced
// the whole `stats` JSON object, so a stale client PUT with an empty
// or partial stats blob wiped every measurement the user had recorded
// that day. New behavior: incoming keys with defined values overwrite;
// incoming keys explicitly set to null are treated as user-initiated
// clears; keys the client didn't mention are preserved. This matches
// the intent of every UI flow — saveBodyStats always spreads over
// existing, so a missing key was never meant to signal "clear this".
router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { stats } = req.body;

  const existing = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  const serverStats = existing ? JSON.parse(existing.stats || '{}') : {};
  const merged = mergeStatsObject(serverStats, stats);
  const mergedJson = JSON.stringify(merged);

  if (existing) {
    db.prepare('UPDATE body_stats_log SET stats = ? WHERE id = ?').run(mergedJson, existing.id);
  } else {
    db.prepare('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)').run(userId, date, mergedJson);
  }

  const row = userId != null
    ? db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(date, userId)
    : db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id IS NULL').get(date);
  if (row) row.stats = JSON.parse(row.stats || '{}');

  // body_stat.logged webhook (issue #79). Fires on every save, no
  // "was it new" gate, matching log_body_stat's own always-merge-and-
  // return semantics; no-op in single-user mode (userId null) since a
  // webhook needs a real account to own it, same as API tokens.
  try { dispatchWebhookEvent(userId, 'body_stat.logged', { date, stats: merged }); }
  catch (e) { /* never let a webhook failure block the save */ }

  res.json({ stats: row });
}));

export default router;
