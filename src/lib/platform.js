/**
 * platform.js — Runtime detection for Capacitor native vs web browser.
 *
 * All platform-specific branching in the app goes through this module.
 * Uses @capacitor/core for reliable detection (not window.Capacitor directly).
 */

import { Capacitor } from '@capacitor/core';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { classifyServerAddress } from './local-address.js';

/**
 * True when running inside the Capacitor native shell (Android / iOS).
 * False in the browser (PWA, desktop).
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * Server-injected base path (when LiftTrace is mounted at a subpath via
 * BASE_URL env var, e.g. `/lifttrace`). Empty string when running at root,
 * or in native where API calls go through getServerUrl() which already
 * carries any path component the user configured.
 */
const _basePath = (typeof window !== 'undefined' && window.__LT_CONFIG__ && window.__LT_CONFIG__.basePath) || '';

/**
 * Native setup mode: 'local' | 'server' | null (not yet chosen).
 * Set during the Android onboarding wizard.
 */
export function getNativeMode() {
  if (!isNative) return null;
  return localStorage.getItem('lt:nativeMode') || null;
}

export function setNativeMode(mode) {
  if (mode) {
    localStorage.setItem('lt:nativeMode', mode);
  } else {
    localStorage.removeItem('lt:nativeMode');
  }
}

/**
 * The server URL to use for sync.
 * In web mode: always same-origin (relative URLs).
 * In native mode: read from localStorage, or null (standalone / offline-first).
 */
export function getServerUrl() {
  if (!isNative) return ''; // relative URLs — same origin
  return localStorage.getItem('lt:serverUrl') || null;
}

/**
 * Save the server URL for native sync mode.
 * Pass null to revert to standalone (offline-only) mode.
 */
export function setServerUrl(url) {
  if (url) {
    const clean = url.replace(/\/$/, '');
    localStorage.setItem('lt:serverUrl', clean);
    // Keep a copy for image cache lookups even after disconnecting
    localStorage.setItem('lt:lastServerUrl', clean);
  } else {
    localStorage.removeItem('lt:serverUrl');
  }
}

/**
 * True when running native but setup hasn't been completed yet.
 */
export function needsNativeSetup() {
  return isNative && !getNativeMode();
}

/** Store the JWT token for native server mode (used in Authorization header) */
export function setAuthToken(token) {
  if (token) localStorage.setItem('lt:authToken', token);
  else localStorage.removeItem('lt:authToken');
}

export function getAuthToken() {
  return localStorage.getItem('lt:authToken') || null;
}

/**
 * Translate a connect-server error into something the user can act on.
 * `t` is svelte-i18n's translate function ($_); without it the English.
 *
 * The Android app uses plain http:// only with a server on your own network,
 * after the warning (lib/plain-http.js, from TraceApps/nutritrace#194); any
 * other http:// address is refused before a request is made. So a plain-HTTP
 * failure is either that refusal, or a local server the phone can't reach (a
 * wrong address, or not on the same network or VPN), and the message says which.
 */
export function explainConnectError(rawError, serverUrl, t) {
  const say = (key, values, english) => {
    try {
      const said = (t || get(_))(key, values ? { values } : undefined);
      if (said && said !== key) return said;
    } catch { /* i18n not started */ }
    return english;
  };
  const fallback = rawError?.message || say('native_setup.toast.cant_reach', null, 'Could not reach server');
  if (!isNative) return fallback;
  const kind = classifyServerAddress(serverUrl);
  if (kind === 'invalid') return say('plain_http.invalid_address', null, 'Enter an address that starts with http:// or https://.');
  const msg = (rawError?.message || String(rawError) || '').toLowerCase();
  if (kind === 'public' || rawError?.code === 'PLAIN_HTTP_BLOCKED' || msg.includes('cleartext')) {
    return say('plain_http.refused_short', null, 'Plain HTTP works only with a server on your own network. Use an https:// address for this server.');
  }
  if (kind === 'local' && /network|not reachable|failed to fetch|connect|timed? ?out|unreachable/.test(msg)) {
    return say('plain_http.unreachable', { url: serverUrl }, `Couldn't reach ${serverUrl}.`);
  }
  return fallback;
}

/**
 * In-memory image cache map: server URL → local file URI.
 * Populated during sync by loadImageMap(). Used by resolveAssetUrl() synchronously.
 */
let _imageMap = {};

/** Load the image map from local DB into memory (call once on sync init) */
export async function loadImageMap() {
  if (!isNative) return;
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) _imageMap = JSON.parse(row.value);
  } catch {}
}

/** Update the in-memory image map (called after image cache downloads) */
export function setImageMap(map) {
  _imageMap = map || {};
}

/**
 * Append `?_lt_t=<jwt>` to API URLs on native server mode so `<img src=...>`
 * requests authenticate without a Bearer header (which the image loader
 * can't carry) and without a cookie (which Capacitor's WebView doesn't
 * reliably persist across launches). The server's authenticate middleware
 * reads this as a third token source for GET requests only.
 */
function _withAuthQuery(url) {
  if (!url || !url.startsWith('http')) return url;
  if (!url.includes('/api/')) return url;
  const t = getAuthToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + '_lt_t=' + encodeURIComponent(t);
}

/**
 * Resolve a relative URL (e.g. /uploads/photo.jpg) to an absolute URL
 * when in native server mode. Checks local image cache first for offline support.
 * On web, returns the path unchanged.
 */
/**
 * Version-busted URL for one of the app's icon PNGs. Browsers cache
 * these hard by URL and won't refetch when the file changes underneath
 * them; appending ?v=<version> makes each dev bump a new URL so a
 * shipped icon fix is actually visible without cache-clearing.
 */
export function iconUrl(path) {
  const resolved = resolveAssetUrl(path);
  if (!resolved) return resolved;
  if (resolved.startsWith('data:') || resolved.includes('?')) return resolved;
  const v = (typeof window !== 'undefined' && window.__APP_VERSION__) || 'dev';
  return `${resolved}?v=${encodeURIComponent(v)}`;
}

// WebView's own origin — historically https://localhost, now
// https://app.lifttrace.local after the hostname flip for password-
// manager identity. Any absolute URL that begins with this origin is
// already a bundled asset served from the APK.
const _webviewOrigin = typeof window !== 'undefined' ? window.location.origin : '';

export function resolveAssetUrl(path) {
  if (!path) return path;
  if (path.startsWith('data:')) return path;
  // Media uploaded with no server is a file:// URI in the app's Data dir
  // (local-uploads.js). The WebView can't load file:// from its https
  // origin; convertFileSrc() gives the address it serves those files at.
  if (path.startsWith('file:')) {
    return isNative && Capacitor?.convertFileSrc ? Capacitor.convertFileSrc(path) : path;
  }
  // The same file with its file:// prefix dropped.
  if (isNative && path.startsWith('/data/') && Capacitor?.convertFileSrc) {
    return Capacitor.convertFileSrc('file://' + path);
  }
  if (_webviewOrigin && path.startsWith(_webviewOrigin)) return path;
  if (isNative) {
    // Always check local image cache first (fastest, works offline + disconnected)
    if (_imageMap[path]) return _imageMap[path];
    const url = getServerUrl() || localStorage.getItem('lt:lastServerUrl') || '';
    if (url) {
      const fullUrl = path.startsWith('http') ? path : url + path;
      if (_imageMap[fullUrl]) return _imageMap[fullUrl];
    }
    // External URLs (radio station logos, iHeart amgArtworkURL, etc.) load
    // directly through the WebView. capacitor.config.ts has
    // allowMixedContent: true so HTTP-only URLs work too. We do NOT proxy
    // them through /api/proxy — that endpoint is JSON-only with a strict
    // domain allowlist (wger / RapidAPI), it 403s on everything else.
    if (path.startsWith('http')) return path;
    // Server-hosted relative paths (/api/subsonic/getCoverArt, /uploads/…)
    // need the server origin + an auth-query token because the WebView's
    // <img> loader can't carry an Authorization header.
    if (url) return _withAuthQuery(url + path);
  }
  // PWA: prefix server-relative paths with base path so they resolve under
  // the configured subpath instead of the document root.
  if (_basePath && (path.startsWith('/uploads/') || path.startsWith('/api/') || path.startsWith('/icons/') || path.startsWith('/fonts/'))) {
    return _basePath + path;
  }
  return path;
}

/**
 * Prefix an API path with the server URL when in native server-connected mode.
 * In native local mode, returns the path unchanged (caller intercepts to local
 * SQLite). In PWA mode, prefixes with the server-injected base path so the
 * request reaches the right place when the server is mounted at a subpath.
 */
export function apiUrl(path) {
  if (isNative) {
    const url = getServerUrl();
    if (url) return url + path; // server URL already carries any subpath the user configured
    return path; // native local — caller redirects to LtApiNative
  }
  return _basePath + path;
}

/**
 * Helper: build standard fetch headers with auth token attached when in
 * native server mode (web mode uses cookies, no header needed).
 */
export function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (isNative) {
    const t = getAuthToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  return headers;
}
