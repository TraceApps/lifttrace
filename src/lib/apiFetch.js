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
import { installOffline, offlineFetch } from './offline-api.js';

const _basePath = (typeof window !== 'undefined' && window.__LT_CONFIG__ && window.__LT_CONFIG__.basePath) || '';

let _installed = false;

export function installApiFetch() {
  if (_installed) return;
  _installed = true;

  const _origFetch = window.fetch.bind(window);
  // The web app keeps a copy of what it has read and queues what it changes,
  // so a dead zone doesn't end the session (offline-api.js).
  if (!isNative) installOffline(_origFetch);

  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';

    // Only intercept /api/... and /uploads/... — everything else (assets,
    // external) passes through.
    if (!_isInterceptable(url)) return _origFetch(input, init);

    // ── Web PWA: the offline layer, at a subpath if that's how it's served ──
    if (!isNative) {
      const target = (_basePath && url.startsWith('/') && !url.startsWith(_basePath + '/'))
        ? _basePath + url
        : input;
      // Pictures come from the service worker's own cache, not from here.
      // A Request object carries its own body and headers, so it is passed
      // through untouched rather than taken apart.
      if (!_isApiCall(url) || typeof input !== 'string') return _origFetch(target, init);
      return offlineFetch(target, init, _origFetch);
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
  // Statistics aggregates are deliberately NOT local-first: when the server
  // is reachable it answers, so the numbers always match the web app. The
  // device's own copy (api-native Stats) is used offline, through the read
  // fallback below (issue #101).
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
      await _localWrites;
      const cached = await _dispatchLocal(url, init);
      // 501 means the device has no local answer for this path; ask the
      // server rather than failing a request the server can serve (#101).
      if (cached.status !== 501) {
        _kickBackgroundSync();
        return cached;
      }
    } catch {
      // Local handler threw — fall through to server.
    }
  }

  try {
    const res = await origFetch(absolute, { ...init, headers, credentials: 'omit' });
    // Writes whose screens read local-first also update the device's copy,
    // so reopening the screen cannot show the older value until the next
    // pull. This runs behind the reply; local reads wait on _localWrites.
    if (isWrite && res.ok) {
      const copy = res.clone();
      // Capped, so a stuck update can never hold reads for more than a moment.
      _localWrites = _localWrites
        .then(() => Promise.race([_mirrorSuccessfulWrite(url, method, init, copy), new Promise(r => setTimeout(r, 3000))]))
        .catch(() => {});
    }
    return res;
  } catch (netErr) {
    // Real network failure — TypeError from fetch (DNS, offline, etc.)
    if (isWrite) {
      // Enqueue write for retry, write to local cache, return synthetic 202.
      try {
        const { enqueueWrite, noteQueuedLocalId, workoutDateOf } = await import('./sync.js');
        let body = null;
        if (typeof init.body === 'string') {
          try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        const queueId = await enqueueWrite(method, _stripBase(url), body);
        // Mirror the write to local cache so UI stays consistent, and answer
        // with what the local write returned: callers read the saved record
        // from the reply (a workout save reads `workout`), and a bare
        // "queued" reply made the Diary blank the workout on screen when the
        // connection dropped (issue #102).
        let local = null;
        try {
          const path = _stripBase(url).split('?')[0];
          const u = new URL(url, 'http://localhost');
          const query = Object.fromEntries(u.searchParams.entries());
          local = await LtApiNative.handle(method, path, body, query);
        } catch {}
        if (local && typeof local === 'object' && !Array.isArray(local)) {
          // A workout that exists only on the device so far gets a device-side
          // id; note it on the queued write so the replay can swap in the
          // server's id.
          const created = local.workout?.id;
          const sentId = body && typeof body === 'object' ? body.id : null;
          if (method === 'PUT' && created != null && created !== sentId && workoutDateOf(_stripBase(url))) {
            try { await noteQueuedLocalId(queueId, created); } catch { /* replay falls back to the date's session */ }
          }
          return _jsonResponse(200, { ...local, queued: true, offline: true });
        }
        return _jsonResponse(202, { queued: true, offline: true });
      } catch {
        return _jsonResponse(503, { error: 'Offline and could not enqueue.' });
      }
    }
    // Read fallback — try local cache.
    await _localWrites;
    return _dispatchLocal(url, init);
  }
}

// Chain of device-copy updates still running behind a server reply.
let _localWrites = Promise.resolve();

async function _mirrorSuccessfulWrite(url, method, init, res) {
  try {
    const path = _stripBase(url).split('?')[0];
    if (/^\/api\/exercises\/\d+\/muscle-load$/.test(path)
      || /^\/api\/stats\/muscle-recovery-adjustments\/[a-z-]+$/.test(path)) {
      let body = null;
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body); } catch {}
      }
      await LtApiNative.handle(method, path, body, {});
      return;
    }
    const { workoutDateOf, mirrorSavedWorkout, forgetDeletedWorkout, reconcileWorkoutDate } = await import('./sync.js');
    const date = workoutDateOf(_stripBase(url));
    if (!date) return;
    if (method === 'PUT') {
      const data = await res.clone().json();
      await mirrorSavedWorkout(date, data?.workout);
    } else if (method === 'DELETE') {
      // Local only, so reads never wait on the network; the full refresh of
      // that day from the server runs on its own afterwards.
      const id = new URL(url, 'http://localhost').searchParams.get('id');
      await forgetDeletedWorkout(date, id != null && id !== '' ? Number(id) : null);
      reconcileWorkoutDate(date).catch(() => {});
    }
  } catch { /* the next pull brings the copy up to date */ }
}

function _isInterceptable(url) {
  if (!url) return false;
  // Absolute URL pointing at our own server URL? still an API call
  const path = url.startsWith('http')
    ? new URL(url).pathname + (new URL(url).search || '')
    : url;
  return path.startsWith('/api/') || path.startsWith('/uploads/');
}

/** An /api/ call, as opposed to an upload the service worker caches. */
function _isApiCall(url) {
  if (!url) return false;
  const path = url.startsWith('http') ? new URL(url).pathname : url;
  return path.startsWith('/api/') || (!!_basePath && path.startsWith(_basePath + '/api/'));
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
