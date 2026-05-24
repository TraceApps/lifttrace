/**
 * image-cache.js — Download exercise media for offline playback.
 *
 * Exercise GIFs / images live on external CDNs (wger, Free Exercise DB,
 * ExerciseDB) so the app needs network to render them. On native we mirror
 * them to local storage and remember the mapping in sync_meta so
 * `resolveAssetUrl()` can swap in the local file:// URI synchronously.
 *
 * Storage location: Filesystem.Directory.Data + /lifttrace-images/<hash>.<ext>
 * The hash is the path/URL run through a cheap djb2 hash so collisions are
 * unlikely without needing a real digest.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import { isNative, getServerUrl, setImageMap } from './platform.js';
import { dbQuery, getSyncMeta, setSyncMeta } from './db-native.js';

const IMG_DIR = 'lifttrace-images';

function _hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function _extFromUrl(url) {
  const m = url.match(/\.(gif|png|jpg|jpeg|webp|mp4|webm)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

async function _ensureDir() {
  try {
    await Filesystem.mkdir({ path: IMG_DIR, directory: Directory.Data, recursive: true });
  } catch {} // already exists
}

async function _downloadOne(url) {
  const fileName = `${IMG_DIR}/${_hash(url)}.${_extFromUrl(url)}`;
  // Check if already cached.
  try {
    const stat = await Filesystem.stat({ path: fileName, directory: Directory.Data });
    if (stat?.uri) return { url, fileUri: stat.uri };
  } catch {}

  // Download via Capacitor Filesystem (handles binary blobs).
  try {
    const res = await Filesystem.downloadFile({
      path: fileName,
      directory: Directory.Data,
      url,
    });
    return { url, fileUri: res?.path ? `file://${res.path}` : null };
  } catch (e) {
    return { url, error: e?.message || String(e) };
  }
}

/**
 * Iterate the local exercises table and download every img_url / gif_url
 * that isn't already cached. Returns counts.
 */
export async function syncExerciseMedia() {
  if (!isNative) return { ok: false, reason: 'web' };
  await _ensureDir();
  const rows = await dbQuery(
    `SELECT id, img_url, gif_url, video_url FROM exercises WHERE deleted_at IS NULL`,
    []
  );
  const map = await _loadMap();
  let downloaded = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    for (const url of [r.img_url, r.gif_url, r.video_url]) {
      if (!url || !url.startsWith('http')) continue;
      if (map[url]) { skipped++; continue; }
      const out = await _downloadOne(url);
      if (out.fileUri) { map[url] = out.fileUri; downloaded++; }
      else failed++;
    }
  }
  await _saveMap(map);
  setImageMap(map);
  return { ok: true, downloaded, failed, skipped, total: rows.length };
}

/**
 * Drop the local cache. Reverses the disk usage at the cost of needing
 * the network on next exercise view.
 */
export async function clearExerciseMedia() {
  if (!isNative) return { ok: false, reason: 'web' };
  try {
    await Filesystem.rmdir({
      path: IMG_DIR,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {}
  await setSyncMeta('image_map', '{}');
  setImageMap({});
  return { ok: true };
}

async function _loadMap() {
  try {
    const json = await getSyncMeta('image_map');
    if (!json) return {};
    return JSON.parse(json);
  } catch { return {}; }
}

async function _saveMap(map) {
  await setSyncMeta('image_map', JSON.stringify(map || {}));
}

export async function imageCacheSize() {
  const map = await _loadMap();
  return Object.keys(map).length;
}
