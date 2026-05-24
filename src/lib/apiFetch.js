/**
 * apiFetch.js — Fetch interceptor.
 *
 * Patches `window.fetch` so every existing `fetch('/api/...')` call in the
 * frontend Just Works in four modes:
 *
 *   1. Web PWA at root            → relative URL, cookies, original fetch
 *   2. Web PWA at subpath         → prefix with __LT_CONFIG__.basePath
 *   3. Native + server connected  → rewrite to absolute URL + Bearer token
 *   4. Native + standalone        → route to LtApiNative, return synthetic Response
 *
 * Mounted once from src/main.js BEFORE the app boots so any early fetches
 * (auth probe, etc.) hit the patched handler.
 */

import { isNative, getServerUrl, getAuthToken } from './platform.js';
import { LtApiNative } from './api-native.js';

const _basePath = (typeof window !== 'undefined' && window.__LT_CONFIG__ && window.__LT_CONFIG__.basePath) || '';

let _installed = false;

export function installApiFetch() {
  if (_installed) return;
  // Skip patching only when there's nothing to do (web at root). Subpath
  // PWA + native both need interception.
  if (!isNative && !_basePath) return;
  _installed = true;

  const _origFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';

    // Only intercept /api/... and /uploads/... — everything else (assets,
    // external) passes through.
    if (!_isInterceptable(url)) return _origFetch(input, init);

    // ── Web PWA at subpath: prefix the path, otherwise stay relative ──
    if (!isNative) {
      if (_basePath && url.startsWith('/') && !url.startsWith(_basePath + '/')) {
        return _origFetch(_basePath + url, init);
      }
      return _origFetch(input, init);
    }

    const serverUrl = getServerUrl();

    // ── Native + server connected: rewrite + add bearer, with offline fallback ─
    if (serverUrl) {
      return _dispatchServerWithFallback(url, init, serverUrl, _origFetch);
    }

    // ── Native + standalone: dispatch to local SQLite handler ───────────
    return _dispatchLocal(url, init);
  };
}

// Paths that are safe to serve from the local SQLite cache first when in
// native+server mode. The list is high-volume / latency-sensitive endpoints
// the user navigates through repeatedly — diary, exercise picker, programs,
// stats. Background sync keeps the cache fresh; on each local-first hit we
// also kick a debounced pullSnapshot so subsequent visits stay current.
const LOCAL_FIRST_GET_PATTERNS = [
  /^\/api\/workout\/\d{4}-\d{2}-\d{2}(\?|$)/,    // Diary entry by date
  /^\/api\/workout\/recent(\?|$)/,                // Statistics recent workouts
  /^\/api\/workout\/history\/\d+(\?|$)/,          // ExerciseDetail history
  /^\/api\/exercises(\?|$)/,                      // Exercise list
  /^\/api\/exercises\/\d+(\?|$)/,                 // Single exercise detail
  /^\/api\/programs(\?|$)/,                       // Programs list
  /^\/api\/programs\/\d+(\?|\/?$)/,               // Program detail
  /^\/api\/templates\/\d+(\?|$)/,                 // Workout template
  /^\/api\/body-stats\/[\d-]+(\?|$)/,             // Body stats by date or range
  /^\/api\/stats\//,                              // Statistics aggregates
];

function _isLocalFirstGet(path, method) {
  if (method !== 'GET') return false;
  const cleanPath = path.startsWith('http') ? new URL(path).pathname : path.split('?')[0];
  return LOCAL_FIRST_GET_PATTERNS.some(re => re.test(cleanPath));
}

// Debounce + last-fired tracking for the background sync trigger so reads
// fired in rapid succession (a route load fetching 4-5 endpoints) only kick
// one pullSnapshot. The actual sync engine has its own `_syncing` re-entry
// guard, so this is just to keep noise down in logs and avoid re-entrant
// dynamic imports.
let _lastBgSync = 0;
async function _kickBackgroundSync() {
  const now = Date.now();
  if (now - _lastBgSync < 5000) return;          // ignore bursts within 5s
  _lastBgSync = now;
  try {
    const { runSync } = await import('./sync.js');
    runSync().catch(() => {});
  } catch {}
}

/**
 * Server mode: try real server first. On network failure (TypeError) fall
 * back to LtApiNative for offline reads. On non-2xx server response or
 * write failure for writes, optionally enqueue for retry.
 *
 * Exception — local-first paths (LOCAL_FIRST_GET_PATTERNS): serve from the
 * native SQLite cache immediately and refresh from the server in the
 * background via runSync(). Components subscribed to lt:sync-complete will
 * re-render with fresh data when the snapshot lands.
 */
async function _dispatchServerWithFallback(url, init, serverUrl, origFetch) {
  const absolute = serverUrl + _stripBase(url);
  const headers = new Headers(init.headers || {});
  const token = getAuthToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

  const method = (init.method || 'GET').toUpperCase();
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  // Local-first: serve cache, refresh in background.
  if (!isWrite && _isLocalFirstGet(url, method)) {
    try {
      const cached = await _dispatchLocal(url, init);
      _kickBackgroundSync();
      return cached;
    } catch {
      // Local handler threw — fall through to server.
    }
  }

  try {
    const res = await origFetch(absolute, { ...init, headers, credentials: 'omit' });
    return res;
  } catch (netErr) {
    // Real network failure — TypeError from fetch (DNS, offline, etc.)
    if (isWrite) {
      // Enqueue write for retry, write to local cache, return synthetic 202.
      try {
        const { enqueueWrite } = await import('./sync.js');
        let body = null;
        if (typeof init.body === 'string') {
          try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        await enqueueWrite(method, _stripBase(url), body);
        // Mirror the write to local cache so UI stays consistent.
        try {
          const path = _stripBase(url).split('?')[0];
          const u = new URL(url, 'http://localhost');
          const query = Object.fromEntries(u.searchParams.entries());
          await LtApiNative.handle(method, path, body, query);
        } catch {}
        return _jsonResponse(202, { queued: true, offline: true });
      } catch {
        return _jsonResponse(503, { error: 'Offline and could not enqueue.' });
      }
    }
    // Read fallback — try local cache.
    return _dispatchLocal(url, init);
  }
}

function _isInterceptable(url) {
  if (!url) return false;
  // Absolute URL pointing at our own server URL? still an API call
  const path = url.startsWith('http')
    ? new URL(url).pathname + (new URL(url).search || '')
    : url;
  return path.startsWith('/api/') || path.startsWith('/uploads/');
}

function _stripBase(url) {
  if (url.startsWith('http')) {
    const u = new URL(url);
    return u.pathname + u.search;
  }
  return url;
}

async function _dispatchLocal(url, init) {
  const u = url.startsWith('http')
    ? new URL(url)
    : new URL(url, 'http://localhost');
  const path = u.pathname;
  const query = Object.fromEntries(u.searchParams.entries());
  const method = (init.method || 'GET').toUpperCase();

  let body = null;
  if (init.body != null) {
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    } else if (init.body instanceof FormData) {
      // Pass FormData through verbatim — the local handler reads the
      // blob via .get() and writes it to Capacitor Filesystem or runs the
      // pure-JS adapter on the text, depending on the route. Standalone
      // is no longer a hard 501 for uploads / imports.
      body = init.body;
    } else {
      body = init.body;
    }
  }

  try {
    const result = await LtApiNative.handle(method, path, body, query);
    // Distinguish handler-returns-null (preserve as JSON null — UI uses
    // truthy checks for "no record") from handler-returns-undefined.
    return _jsonResponse(200, result === undefined ? {} : result);
  } catch (e) {
    if (e instanceof LtApiNative._Unsupported) {
      return _jsonResponse(501, { error: e.message, offline: true });
    }
    return _jsonResponse(500, { error: e.message || 'Local handler failed' });
  }
}

function _jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
