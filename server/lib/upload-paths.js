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
 * backups: BACKUPS_PATH defaults to a directory INSIDE UPLOADS_PATH, and a
 * full-backup ZIP contains every user's photos, password hashes, reset
 * tokens and OIDC config. Its filename is a timestamp, so it was guessable
 * as well as public. Every /api/full-backup route is admin-only; serving
 * the artefact itself from the pre-auth static tree handed the same data to
 * anyone. Gating photos while leaving this open would have achieved nothing.
 */
const PRIVATE_SUBDIRS = ['body-stats', 'backups'];

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
