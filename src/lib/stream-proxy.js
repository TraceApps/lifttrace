/**
 * stream-proxy.js — JS wrapper for the native LtStreamProxy plugin.
 *
 * The plugin runs a one-shot HTTP server on 127.0.0.1:&lt;port&gt; that
 * pipes a configured upstream radio URL back through with synthetic
 * `Access-Control-Allow-Origin: *` headers. Used by Radio.svelte in
 * Capacitor builds so cross-origin direct audio streams (most US iHeart
 * stations, Shoutcast/Icecast servers without CORS) become CORS-clean,
 * which keeps Chromium's MediaElementAudioSource from zeroing the output
 * — i.e. lets the Trace FAB visualizer animate against any station.
 *
 * On web the module is a no-op; the dev / production server's
 * /api/radio-proxy already provides the same same-origin remapping.
 */

import { isNative } from './platform.js';
import { registerPlugin } from '@capacitor/core';

let _plugin = null;
let _activeUpstream = null;
let _activeLocal = null;
let _activeBlobUrl = null;

/**
 * Build a synthetic HLS manifest that wraps the proxy URL as a single
 * infinite-duration segment. Letting hls.js handle decoding instead of
 * Chromium's direct &lt;audio src=...&gt; path avoids deterministic
 * PIPELINE_ERROR_DECODE crashes on iHeart-style HE-AAC streams:
 *   - Chromium's WebView HE-AAC decoder fails at exact stream timestamp
 *     5461333μs (packet #128) on every connection — likely an SBR/PS
 *     boundary issue.
 *   - hls.js demuxes AAC ADTS in-process and feeds fragmented MP4 into
 *     MSE, hitting a different decoder pathway that's robust on these
 *     streams.
 *
 * The "segment" never ends — bytes keep flowing from upstream until the
 * user stops. hls.js with EVENT playlist type tolerates this.
 */
function _wrapInHlsManifest(proxyUrl) {
  const manifest =
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    '#EXT-X-TARGETDURATION:99999\n' +
    '#EXT-X-PLAYLIST-TYPE:EVENT\n' +
    '#EXTINF:99999.0,\n' +
    proxyUrl + '\n';
  const blob = new Blob([manifest], { type: 'application/vnd.apple.mpegurl' });
  return URL.createObjectURL(blob);
}

function _getPlugin() {
  if (!isNative) return null;
  if (_plugin) return _plugin;
  try { _plugin = registerPlugin('LtStreamProxy'); }
  catch { _plugin = null; }
  return _plugin;
}

/**
 * Returns true when a URL needs to go through the local proxy in order to
 * be CORS-clean for the audio visualizer. HLS (.m3u8) is handled by hls.js
 * which already produces a same-origin blob: URL via MSE — skip those.
 * Same-origin URLs (relative, https://localhost, blob:, data:) also skip.
 */
export function needsProxy(url) {
  if (!isNative) return false;
  if (!url) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return false;        // hls.js handles
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (!url.startsWith('http')) return false;          // relative — same origin
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return false;
  } catch { return false; }
  return true;
}

/**
 * Open a proxy for `upstreamUrl` and return a `http://127.0.0.1:<port>/stream`
 * URL safe to feed to an `<audio>` element. Idempotent: calling with the same
 * URL while a proxy is already running just returns the existing local URL.
 *
 * In server-connected native mode `/api/radio-proxy` is already same-origin
 * after the apiFetch interceptor rewrites it, but only the proxy *path* is
 * rewritten — actual audio loading bypasses the interceptor. So we still
 * route through the local proxy when the URL would otherwise be cross-origin.
 */
export async function openProxy(upstreamUrl) {
  if (!needsProxy(upstreamUrl)) return upstreamUrl;
  const plugin = _getPlugin();
  if (!plugin) return upstreamUrl;
  if (_activeBlobUrl && _activeUpstream === upstreamUrl) return _activeBlobUrl;
  // Different upstream — close any existing proxy first so we don't leak
  // an accept loop, and free the previous synthetic-manifest blob URL.
  if (_activeBlobUrl) {
    try { await plugin.stop(); } catch {}
    try { URL.revokeObjectURL(_activeBlobUrl); } catch {}
    _activeBlobUrl = null;
    _activeLocal = null;
  }
  try {
    const r = await plugin.start({ url: upstreamUrl });
    _activeUpstream = upstreamUrl;
    _activeLocal = r?.localUrl || null;
    return _activeLocal || upstreamUrl;
    // NOTE: previously wrapped this in a synthetic HLS manifest blob URL
    // so hls.js would handle decoding. Logs showed clean MSE pipeline +
    // AudioFlinger output but produced no audible audio. Reverted to the
    // direct audio.src path which produces audible audio (with brief
    // gaps every ~5s when the deterministic Chromium HE-AAC decoder bug
    // kicks in; the recovery loop in player.js handles those resets).
    // See FUTURE.md for the proper fix path.
  } catch (e) {
    console.warn('[stream-proxy] start failed:', e?.message || e);
    return upstreamUrl;
  }
}

/**
 * Tear down the proxy. Called from player.js stop() so the loopback socket
 * doesn't linger after playback ends.
 */
export async function closeProxy() {
  const plugin = _getPlugin();
  if (!plugin) return;
  if (!_activeLocal && !_activeBlobUrl) return;
  try { await plugin.stop(); } catch {}
  if (_activeBlobUrl) {
    try { URL.revokeObjectURL(_activeBlobUrl); } catch {}
  }
  _activeUpstream = null;
  _activeLocal = null;
  _activeBlobUrl = null;
}

export function activeProxyUrl() { return _activeBlobUrl || _activeLocal; }
