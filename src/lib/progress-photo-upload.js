/**
 * src/lib/progress-photo-upload.js
 *
 * Shared capture path for progress photos, used by both doors in: the
 * Progress timeline's own "Add photo" control and the Body Stats sheet's.
 * One implementation so the two cannot drift.
 *
 * HEIC is the reason this is not a two-line inline handler. iPhones
 * default to HEIC, and Chrome, Firefox and Android WebView all refuse to
 * decode it in an <img>, so a photo shot on an iPhone would upload fine
 * and then render as a broken thumbnail everywhere except Safari. Canvas
 * cannot decode it either, so there is no zero-dependency fix: heic2any
 * is pulled in dynamically, only when a HEIC file is actually picked, so
 * it never lands in the bundle for anyone else.
 */
import { LtApi } from './api.js';

function isHeic(file) {
  return /\.hei[cf]$/i.test(file?.name || '') || /^image\/hei[cf]/i.test(file?.type || '');
}

/** Convert a HEIC/HEIF File to JPEG. Returns the original on any failure. */
async function normalizeForUpload(file) {
  if (!isHeic(file)) return file;
  try {
    const { default: heic2any } = await import('heic2any');
    const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    const out = Array.isArray(blob) ? blob[0] : blob;
    return new File([out], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' });
  } catch {
    // Fall through with the original: the server still accepts HEIC (its
    // magic-byte allowlist includes it), so the photo is stored rather
    // than lost. It may not render on non-Safari browsers, which is worse
    // than converting but better than refusing the upload outright.
    return file;
  }
}

/**
 * Upload a picked file and attach it to `date`.
 * Returns the created photo row. Throws with a human-readable message.
 */
export async function uploadAndAttachPhoto(file, date) {
  const prepared = await normalizeForUpload(file);
  const uploaded = await LtApi.uploadProgressPhoto(prepared);
  if (!uploaded?.url) throw new Error(uploaded?.error || 'Upload failed');
  const saved = await LtApi.addProgressPhoto(date, uploaded.url);
  if (!saved?.photo) throw new Error(saved?.error || 'Could not save photo');
  return saved.photo;
}
