/**
 * image-localizer.js: a photo that arrived embedded becomes a file.
 *
 * The web app can't upload a file when it can't reach the server, so a photo
 * taken with no connection travels inside the row it belongs to, as a data
 * URL, and is turned back into an ordinary file here when the queue goes up
 * (src/lib/offline-api.js). Every route that accepts an image runs it
 * through this, so nothing is ever stored as a data URL: a row holds a path,
 * the way it always has.
 *
 * The same shape is used in NutriTrace and CookTrace.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { assertAllowedMedia } from './image-magic.js';
import { logger } from '../logger.js';

const DATA_URL = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i;
const MAX_EMBEDDED_BYTES = 12 * 1024 * 1024;
const UPLOADS_DIR = () => process.env.UPLOADS_PATH || './uploads';

/**
 * An embedded image becomes a file and its public path; anything else (a
 * path, an http URL, nothing at all) is returned exactly as it came.
 *
 * `subdir` puts it somewhere other than the root of /uploads: progress
 * photos live in body-stats/, which is served through an authenticated
 * route rather than the public tree.
 */
export function localizeDataUrl(value, { subdir = '' } = {}) {
  if (typeof value !== 'string' || !DATA_URL.test(value)) return value;
  const [head, b64] = value.split(',', 2);
  const ext = head.match(/^data:image\/([a-z]+);/i)?.[1].toLowerCase().replace('jpeg', 'jpg') || 'jpg';
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > MAX_EMBEDDED_BYTES) {
    throw new Error('That picture is too large.');
  }
  const dir = subdir ? path.join(UPLOADS_DIR(), subdir) : UPLOADS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, bytes);
  // The same magic-byte check the upload routes run: a client-sent type is
  // not evidence of anything.
  try {
    assertAllowedMedia(filePath, ['image']);
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch {}
    logger.warn(`[image-localizer] Refusing an embedded image: ${e.message}`);
    throw e;
  }
  return `/uploads/${subdir ? `${subdir}/` : ''}${filename}`;
}
