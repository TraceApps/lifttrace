/**
 * server/lib/upload-paths.js
 *
 * Safe resolution and deletion of files under UPLOADS_PATH. Deliberately
 * has NO db.js import so the traversal check below can be unit-tested
 * directly, without a compiled better-sqlite3 native binding. Anything
 * that needs both the database and the filesystem (deleteMediaForUser in
 * body-stat-media.js) imports these.
 *
 * Not photo-specific: any feature that stores user-supplied files under
 * UPLOADS_PATH should resolve them through here rather than joining
 * paths by hand.
 */
import path from 'path';
import fs from 'fs';
import { logger } from '../logger.js';

const uploadsPath = process.env.UPLOADS_PATH || './uploads';

/**
 * Resolve a stored `/uploads/...` URL to its path on disk, refusing
 * anything that escapes the uploads directory. Stored URLs are always
 * server-generated, but this is cheap and means a tampered row can never
 * turn an unlink into an arbitrary file delete. Returns null when the
 * URL is not a local upload path at all (an http(s) link, say).
 */
export function resolveUploadPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const rel = url.slice('/uploads/'.length);
  const abs = path.resolve(uploadsPath, rel);
  const root = path.resolve(uploadsPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Subdirectories under UPLOADS_PATH whose contents must never be served by
 * the static handler.
 *
 * body-stats: progress photos are personal in a way an avatar or a shared
 * exercise-demo GIF is not, so they are read only through
 * GET /api/body-stats/photos/:id/file, which checks the row's owner.
 *
 * set-videos: the same argument for footage of someone lifting in their gym
 * (issue #57). Read only through GET /api/set-media/:id/file, which checks
 * the row's owner and that owner's trainer.
 *
 * backups: BACKUPS_PATH defaults to a directory INSIDE UPLOADS_PATH, and a
 * full-backup ZIP contains every user's photos, password hashes, reset
 * tokens and OIDC config. Its filename is a timestamp, so it was guessable
 * as well as public. Every /api/full-backup route is admin-only; serving
 * the artefact itself from the pre-auth static tree handed the same data to
 * anyone. Gating photos while leaving this open would have achieved nothing.
 */
const PRIVATE_SUBDIRS = ['body-stats', 'backups', 'set-videos'];

/**
 * True when a request path under the /uploads mount would land inside a
 * private subdirectory.
 *
 * Works on the RESOLVED path, not the URL text, because those two disagree
 * in ways an attacker controls. express.static percent-decodes before
 * looking up the file, while a router.use('/uploads/body-stats') prefix
 * matches the raw path, so `/uploads/%62ody-stats/x.jpg`,
 * `/uploads/body%2Dstats/x.jpg` and `/uploads//body-stats/x.jpg` all slip
 * past a prefix guard and are then happily served. Decoding once (which is
 * what serve-static does) and resolving collapses every one of those to the
 * same absolute path.
 *
 * @param {string} reqPath path below the mount, e.g. '/body-stats/a.jpg'
 */
export function isPrivateUploadPath(reqPath) {
  if (typeof reqPath !== 'string') return true;
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    // Malformed encoding: serve-static will reject it too, but refuse here
    // rather than guess at what it was meant to say.
    return true;
  }
  if (decoded.includes('\0')) return true;
  const root = path.resolve(uploadsPath);
  const abs = path.resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  // Compared case-insensitively because the filesystem may be: on APFS or
  // NTFS a request for /BODY-STATS/x.jpg resolves to the same file, and a
  // case-sensitive guard would wave it through to express.static.
  const lower = abs.toLowerCase();
  return PRIVATE_SUBDIRS.some((sub) => {
    const dir = path.join(root, sub).toLowerCase();
    return lower === dir || lower.startsWith(dir + path.sep);
  });
}

/** Delete one stored file by its `/uploads/...` URL. Never throws. */
export function unlinkMediaFile(url) {
  const abs = resolveUploadPath(url);
  if (!abs) return false;
  try {
    fs.unlinkSync(abs);
    return true;
  } catch (e) {
    // Already gone is the expected case on a re-run or a partial restore.
    if (e?.code !== 'ENOENT') logger.warn(`[upload-paths] could not unlink ${abs}: ${e.message}`);
    return false;
  }
}

// ── Safe file names for uploads ─────────────────────────────────────────────
// The extension decides the Content-Type the static handler serves a file
// with, so it can't come from the uploader: "note.html" sent as audio/webm
// would otherwise be served as a web page from this origin.
const EXT_BY_KIND = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp'],
  audio: ['webm', 'weba', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'mp3', 'wav', 'aac', 'flac', 'amr', 'awb', '3gp', '3gpp'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'ogv', '3gp'],
};
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/avif': 'avif', 'image/bmp': 'bmp',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'audio/amr': 'amr', 'audio/amr-wb': 'awb', 'audio/3gpp': '3gp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/3gpp': '3gp',
};

/**
 * The extension (with its dot) to store an upload under: the uploader's own
 * when it's a known one for that kind of file, else one from the type, else
 * ".bin", which is served as a download.
 */
export function safeUploadExtension(mimetype, originalname) {
  const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
  const kind = mime.split('/')[0];
  const own = path.extname(String(originalname || '')).toLowerCase().replace(/^\./, '');
  if (EXT_BY_KIND[kind]?.includes(own)) return `.${own}`;
  if (EXT_BY_MIME[mime]) return `.${EXT_BY_MIME[mime]}`;
  return '.bin';
}

/**
 * Headers for every file served from /uploads: no type sniffing, and a
 * sandboxing content policy, so even a file that isn't what it claims can't
 * run script on this origin. Media and images display as usual.
 */
export const UPLOAD_RESPONSE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
};
