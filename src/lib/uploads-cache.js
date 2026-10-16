/**
 * uploads-cache.js: housekeeping for the service worker's uploads-cache
 * (the CacheFirst rule for /uploads/ in vite.config.js).
 *
 * Kept out of photo-blobs.js, which by design never touches a service-worker
 * cache (progress photos must not land in one shared by every account).
 */

const PAGES_FLAG = 'lt:uploads-cache-pages-purged';

/**
 * One-shot sweep of pages kept in place of pictures.
 *
 * Pre-cache media for offline fetched without credentials, so behind a
 * login proxy that signs people in on another address (Authelia, VoidAuth
 * and the like) the proxy answered with a redirect to its sign-in page, and
 * the service worker kept that opaque answer under the picture's address.
 * A proxy whose sign-in is on this address, once its session ran out, and a
 * picture whose file is gone (answered with the app's page) left an HTML
 * page there the same way. Either way the picture or video stayed broken,
 * online too, for up to 90 days. This server's own files are never opaque
 * and never HTML, so every such entry goes; the picture is fetched again the
 * next time it shows.
 */
export async function purgePagesKeptAsPictures() {
  if (typeof caches === 'undefined') return;
  try {
    if (localStorage.getItem(PAGES_FLAG)) return;
  } catch { /* private mode: sweep every launch rather than never */ }
  try {
    if (await caches.has('uploads-cache')) {
      const cache = await caches.open('uploads-cache');
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (res?.type === 'opaque' || /^text\/html/i.test(res?.headers?.get('Content-Type') || '')) await cache.delete(req);
      }
    }
    localStorage.setItem(PAGES_FLAG, '1');
  } catch { /* tried again next launch */ }
}
