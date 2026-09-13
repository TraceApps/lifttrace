/**
 * photo-blobs.js
 *
 * Fetches progress-photo bytes through the authenticated API and hands back
 * object URLs an <img> can render.
 *
 * Progress photos are not served from the static /uploads tree, because that
 * tree is mounted ahead of the auth middleware and anything in it is readable
 * by anyone holding the URL. Going through GET /api/body-stats/photos/:id/file
 * means the request carries the session (cookie on web, bearer on native, both
 * applied by the patched fetch in apiFetch.js) and the server checks the row's
 * owner. The blob is the bridge: an <img src> request cannot authenticate
 * itself, but a fetch() can, and an object URL needs no auth at all.
 *
 * The cache is deliberately in memory and per-session rather than in the
 * service worker: an SW cache is shared by every account that signs in on
 * that browser profile, which is the exact leak this is closing.
 */
import { resolveAssetUrl } from './platform.js';

// Roughly two screens of a desktop grid. Object URLs pin their blob in
// memory until revoked, so this is a real ceiling, not a hint.
const MAX_CACHED = 60;

const cache = new Map();      // id -> objectURL. Map order doubles as LRU.
const stale = new Set();      // evicted URLs, still possibly on screen
const failures = new Map();   // id -> timestamp of the last failed attempt
const inflight = new Map();   // id -> Promise, so a grid and the scrubber
                              // asking for the same photo share one request.

/**
 * Some rows are renderable without the API at all. Returns that URL, or null
 * when the bytes have to be fetched:
 *
 *  - file: / data: / blob:  Capacitor standalone stores photos on the device
 *    as file:// URIs (see local-uploads.js); there is no server involved.
 *  - http(s)               MCP and the REST API accept an already-hosted
 *    image, since neither can take raw bytes. Not ours to serve.
 *  - native offline cache  resolveAssetUrl maps a previously downloaded
 *    /uploads path to a local file:// URI.
 */
export function directUrlFor(src) {
  if (!src) return null;
  if (/^(file|data|blob):/i.test(src)) return src;
  if (/^https?:/i.test(src)) return src;
  const resolved = resolveAssetUrl(src);
  if (resolved && /^(file|data|blob):/i.test(resolved)) return resolved;
  return null;
}

// Eviction drops the entry but does NOT revoke the object URL, because a
// mounted <img> may still be using it: the timeline is a plain list, not a
// virtualised one, so with more than MAX_CACHED photos in range scrolling
// past one evicts a tile that is still on screen. Revoking there turned a
// cache policy into a visible broken image. The URLs are all released
// together on sign-out, which is the point that actually matters.
function evict() {
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    stale.add(cache.get(oldest));
    cache.delete(oldest);
  }
}

const RETRY_AFTER_MS = 30000;

/** Object URL for one photo's bytes. Throws if it cannot be read. */
export async function photoBlobUrl(id) {
  // Negative caching, so a photo the server will not serve (a 409 for an
  // externally hosted row, say) is not retried on every render.
  const failedAt = failures.get(id);
  if (failedAt != null && Date.now() - failedAt < RETRY_AFTER_MS) {
    throw new Error('Recently failed');
  }
  if (cache.has(id)) {
    const url = cache.get(id);
    cache.delete(id);        // reinsert to mark as most recently used
    cache.set(id, url);
    return url;
  }
  if (inflight.has(id)) return inflight.get(id);

  const req = (async () => {
    const res = await fetch(`/api/body-stats/photos/${id}/file`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Not every 200 is an image. On native, apiFetch falls back to the local
    // SQLite handler when the network is unreachable, and that handler
    // answers an unknown path with 200 {"stats":null}. Caching that as an
    // object URL renders a broken <img> that never recovers, because the
    // cache would then serve JSON for the rest of the session.
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`Unexpected content-type ${type || 'none'}`);
    const url = URL.createObjectURL(await res.blob());
    cache.set(id, url);
    evict();
    return url;
  })();

  inflight.set(id, req);
  try {
    const url = await req;
    failures.delete(id);
    return url;
  } catch (e) {
    failures.set(id, Date.now());
    throw e;
  } finally {
    inflight.delete(id);
  }
}

/** Drop one entry so the next request refetches it. */
export function invalidatePhoto(id) {
  if (cache.has(id)) {
    stale.add(cache.get(id));
    cache.delete(id);
  }
  failures.delete(id);
}

/**
 * Warm the cache without caring about the result (scrubber preloading).
 *
 * Takes the whole row, not an id, so a photo that needs no fetch at all is
 * skipped: on Capacitor standalone every row is a file:// URI, and an
 * externally hosted row is answered with 409. Without both guards, dragging
 * the scrub handle across such a set fired a fresh request per photo per
 * pointer move, since a rejected fetch leaves nothing in the cache to
 * dedupe against.
 */
export function prefetchPhoto(photo) {
  if (!photo || directUrlFor(photo.url)) return;
  photoBlobUrl(photo.id).catch(() => {});
}

/**
 * Drop every cached blob. Called on sign-out so the next account on this
 * device cannot pull the previous one's photos out of memory.
 */
export function clearPhotoBlobs() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  for (const url of stale) URL.revokeObjectURL(url);
  cache.clear();
  stale.clear();
  inflight.clear();
  failures.clear();

  // The service worker's uploads-cache is CacheFirst with a 90 day TTL and
  // is shared by every account on this browser profile. Installs that
  // rendered photos before they moved behind auth still hold those bytes,
  // and would keep serving them from cache even though the server now
  // refuses the path. Purge it on the way out.
  if (typeof caches !== 'undefined') {
    caches.delete('uploads-cache').catch(() => {});
  }
}

/**
 * One-shot purge of the legacy service-worker cache.
 *
 * Before photos moved behind auth they were plain /uploads URLs, and the
 * uploads-cache rule in vite.config.js is CacheFirst with a 90 day TTL. Any
 * install that rendered a photo still holds those bytes and would keep
 * serving them to whoever signs in next, for months, even though the server
 * now refuses the path. The rule no longer matches photo paths, but that
 * only stops new entries; the existing ones have to be cleared, and waiting
 * for a sign-out that may never come is not good enough.
 */
const PURGE_FLAG = 'lt:uploads-cache-purged';
export async function purgeLegacyPhotoCache() {
  if (typeof caches === 'undefined') return;
  try {
    if (localStorage.getItem(PURGE_FLAG)) return;
  } catch { /* private mode: purge every launch rather than never */ }
  try {
    await caches.delete('uploads-cache');
    localStorage.setItem(PURGE_FLAG, '1');
  } catch { /* a cache we cannot reach is one we cannot leak from here */ }
}
