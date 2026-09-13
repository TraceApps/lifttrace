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
