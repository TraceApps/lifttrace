/**
 * exerciseShare.js — single-exercise JSON export + import (file or URL).
 *
 * Format (v1):
 *   {
 *     format: 'lifttrace-exercise',
 *     version: 1,
 *     exportedAt: ISO timestamp,
 *     exercise: {
 *       name, category, primary_muscles[], secondary_muscles[], equipment[],
 *       instructions, tips, img_url, gif_url, video_url, load_type
 *     }
 *   }
 *
 * Notes:
 *   - id, source, created_by, is_global, favorite are stripped on export —
 *     they're local-to-the-instance.
 *   - Media is referenced by URL (not inlined). Recipients fetch the assets
 *     on-demand. Keeps shared files tiny and link-able from a community repo
 *     of plain .json files.
 *   - The importer creates a fresh custom exercise on the recipient side
 *     (source='custom', is_global=0). Existing exercises with the same name
 *     get a numeric suffix.
 */

import { isNative } from './platform.js';
import { LtApi } from './api.js';

const FORMAT = 'lifttrace-exercise';
const VERSION = 1;

// Fields preserved across export → import. Anything outside this list
// is dropped so installation-specific identifiers don't leak.
const PORTABLE_FIELDS = [
  'name', 'category',
  'primary_muscles', 'secondary_muscles', 'equipment',
  'instructions', 'tips',
  'img_url', 'gif_url', 'video_url',
  'load_type',
];

function _toPortable(exercise) {
  const out = {};
  for (const k of PORTABLE_FIELDS) {
    if (exercise[k] != null) out[k] = exercise[k];
  }
  return out;
}

/**
 * Build the shareable payload + a filename derived from the exercise name.
 */
export function buildExerciseShare(exercise) {
  const payload = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    exercise: _toPortable(exercise),
  };
  const safeName = (exercise.name || 'exercise')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'exercise';
  const filename = `${safeName}.lifttrace-exercise.json`;
  return { payload, filename, json: JSON.stringify(payload, null, 2) };
}

/**
 * Deliver the exercise JSON to the user — direct download on PWA,
 * write-to-device + Share intent on Android.
 */
export async function exportExercise(exercise) {
  const { json, filename } = buildExerciseShare(exercise);

  if (isNative) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const dir = 'lifttrace-exports';
    try { await Filesystem.mkdir({ path: dir, directory: Directory.Cache, recursive: true }); } catch {}
    const path = `${dir}/${filename}`;
    const writeRes = await Filesystem.writeFile({
      path,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({
        title: 'LiftTrace exercise',
        text: exercise.name || filename,
        url: writeRes?.uri,
        dialogTitle: 'Share exercise',
      });
    } catch { /* user dismissed; file is still on device */ }
    return;
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Validate a parsed payload + return just the portable exercise fields
 * ready to send to POST /api/exercises. Throws a clear Error on any issue
 * the caller can surface in a toast.
 */
export function parseSharePayload(raw) {
  let obj;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); }
    catch { throw new Error('File is not valid JSON'); }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== 'object') throw new Error('File is empty or not an object');
  if (obj.format !== FORMAT) throw new Error('File is not a LiftTrace exercise export');
  if (obj.version !== VERSION) throw new Error(`Unsupported format version ${obj.version}`);
  if (!obj.exercise || typeof obj.exercise !== 'object') throw new Error('Missing exercise data');
  if (!obj.exercise.name || typeof obj.exercise.name !== 'string') throw new Error('Exercise has no name');
  // Drop everything outside the allowlist — defends against future-version
  // payloads that smuggle in fields like id / created_by / source.
  return _toPortable(obj.exercise);
}

/** Read a File from a picker, parse + validate, return the importable exercise. */
export async function readSharedExerciseFile(file) {
  const text = await file.text();
  return parseSharePayload(text);
}

/**
 * Fetch a community-repo URL and return the importable exercise. Accepts
 * direct .json links (e.g. `https://raw.githubusercontent.com/.../foo.json`)
 * or github.com blob URLs (auto-rewritten to raw).
 */
export async function fetchSharedExerciseUrl(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) throw new Error('URL required');
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  // github.com/<user>/<repo>/blob/<ref>/<path> → raw.githubusercontent.com
  const ghBlob = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (ghBlob) {
    url = `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;
  }
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { throw new Error(`Could not reach URL: ${e.message || 'fetch failed'}`); }
  if (!res.ok) throw new Error(`URL returned ${res.status} ${res.statusText}`);
  const text = await res.text();
  return parseSharePayload(text);
}

/** Send a parsed payload through LtApi.createExercise. */
export async function importSharedExercise(payload) {
  return LtApi.createExercise(payload);
}

/**
 * Read a `content://`, `file://`, or fully-qualified file URI delivered
 * by the OS file-open intent (Android intent filter on
 * `*.lifttrace-exercise.json`, iOS document picker), parse + validate,
 * and return the importable payload.
 *
 * Capacitor Filesystem.readFile accepts content URIs directly — Android's
 * intent system grants the activity read access to the URI, which the
 * Filesystem plugin then uses through the system ContentResolver. No
 * extra permission shuffling needed.
 */
export async function readSharedExerciseFromUri(uri) {
  if (!uri) throw new Error('No file URI');
  const { Filesystem } = await import('@capacitor/filesystem');
  const res = await Filesystem.readFile({ path: uri });
  // Default encoding is base64; decode it through atob so the JSON
  // round-trips even if it contains UTF-8 bytes that aren't ASCII.
  // (Filesystem also supports an Encoding.UTF8 option, but it errors
  // on some content:// providers — base64 + manual decode is the
  // safer cross-provider path.)
  const raw = typeof res?.data === 'string' ? res.data : '';
  let text;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    // Fall back to the raw value in case the provider returned UTF-8
    // directly (some Capacitor versions do).
    text = raw;
  }
  return parseSharePayload(text);
}
