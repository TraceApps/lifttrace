/**
 * local-uploads.js — Filesystem-backed replacement for /api/upload* on
 * Capacitor standalone (no server). Writes the uploaded blob to
 * Directory.Data/lifttrace-uploads/, returns a stable file:// URI the rest
 * of the app can render via <img src> / <video src> directly.
 *
 * When the user later connects the app to a server, the differential sync
 * push will mirror the row that references this URI; the bytes themselves
 * stay on the device (the server's /uploads/ tree is regenerated from the
 * data the user already has locally). resolveAssetUrl() handles either form
 * of URL at render time.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import { isNative } from './platform.js';

const UP_DIR = 'lifttrace-uploads';

async function _ensureDir() {
  try { await Filesystem.mkdir({ path: UP_DIR, directory: Directory.Data, recursive: true }); }
  catch {} // already exists
}

function _extFromName(name, fallback = 'bin') {
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? m[1] : fallback;
}

function _extFromMime(mime, fallback = 'bin') {
  if (!mime) return fallback;
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png')  return 'png';
  if (mime === 'image/gif')  return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'video/mp4')  return 'mp4';
  if (mime === 'video/webm') return 'webm';
  return fallback;
}

async function _readAsBase64(blob) {
  // Web's FileReader.readAsDataURL → strip the data: prefix to get raw base64.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}

/**
 * Write the blob locally. Returns { url, mimeType, size, kind } in the same
 * shape /api/upload + /api/upload/exercise-media return server-side.
 *
 * `category` is 'avatar' | 'exercise' | 'misc' — used only for naming so
 * the user can browse the cache directory and recognize what's what.
 */
export async function writeLocalUpload(blob, { category = 'misc', originalName = '' } = {}) {
  if (!isNative) throw new Error('local-uploads only runs on Capacitor');
  if (!blob) throw new Error('No file provided');
  await _ensureDir();

  const mime = blob.type || 'application/octet-stream';
  const ext  = _extFromName(originalName) || _extFromMime(mime);
  const stamp = Date.now();
  const rand  = Math.random().toString(36).slice(2, 8);
  const fileName = `${UP_DIR}/${category}-${stamp}-${rand}.${ext}`;

  const base64 = await _readAsBase64(blob);
  const res = await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.Data,
  });

  let kind = 'img';
  if (mime === 'image/gif') kind = 'gif';
  else if (mime.startsWith('video/')) kind = 'video';

  return {
    url:      res?.uri ? (res.uri.startsWith('file://') ? res.uri : `file://${res.uri}`) : '',
    mimeType: mime,
    size:     blob.size,
    kind,
  };
}
