/**
 * native-player.js — JS wrapper for the LtRadioPlayer Capacitor plugin.
 *
 * The plugin runs an Android-side ExoPlayer instance, decoding audio
 * natively and routing to the device speaker. Bypasses Chromium WebView's
 * broken HE-AAC decoder for radio streams.
 *
 * On web this module is a no-op shim (use the regular `<audio>` path
 * via player.js instead).
 *
 * Usage from player.js / Radio.svelte:
 *   await NativePlayer.play(url, { isHls });
 *   await NativePlayer.pause();
 *   await NativePlayer.resume();
 *   await NativePlayer.stop();
 *   await NativePlayer.setVolume(0..1);
 *   NativePlayer.onState(cb);  // cb({ state, error? })
 *
 * State strings: 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error'.
 */

import { isNative } from './platform.js';
import { registerPlugin } from '@capacitor/core';

let _plugin = null;
const _stateCallbacks = new Set();
const _fftCallbacks = new Set();
const _nowPlayingCallbacks = new Set();
const _positionCallbacks = new Set();
const _nextCallbacks = new Set();
const _prevCallbacks = new Set();
const _trackTransitionCallbacks = new Set();

// Procedural-visualizer state. Used when Android's audiofx.Visualizer
// can't initialize (some devices return INIT_CHECK_FAILED -3 due to audio
// policy restrictions). We drive 32 bins with a slow-evolving sine field
// so the FAB ring still looks alive while audio plays through ExoPlayer.
let _isPlayingNative = false;
let _proceduralRaf = null;
const _PROC_BINS = 64;
const _proceduralBuf = new Float32Array(_PROC_BINS);
function _emitProcedural() {
  for (const cb of _fftCallbacks) { try { cb(_proceduralBuf); } catch {} }
}
function _proceduralTick() {
  if (!_isPlayingNative) { _proceduralRaf = null; return; }
  // Two summed sines per bin with offset phases — produces a wavy ring
  // that breathes in/out over a few seconds. Looks like a smoothed
  // music visualizer without needing actual audio data.
  const t = performance.now() / 600;
  for (let i = 0; i < _PROC_BINS; i++) {
    const a = Math.sin(t + i * 0.27) * 0.5 + 0.5;
    const b = Math.sin(t * 1.7 + i * 0.13) * 0.5 + 0.5;
    _proceduralBuf[i] = Math.max(0.05, Math.min(1, (a * 0.6 + b * 0.4) * 0.85));
  }
  _emitProcedural();
  // ~30Hz — matches what Android Visualizer would deliver if it worked.
  _proceduralRaf = setTimeout(_proceduralTick, 33);
}
let _gotRealFft = false;

function _getPlugin() {
  if (!isNative) return null;
  if (_plugin) return _plugin;
  try {
    _plugin = registerPlugin('LtRadioPlayer');
    // Bridge plugin events into single fan-out listeners.
    _plugin.addListener('state', ev => {
      const s = ev?.state;
      // Drive the procedural visualizer fallback off playback state.
      const wasPlaying = _isPlayingNative;
      _isPlayingNative = (s === 'playing');
      if (_isPlayingNative && !wasPlaying && !_gotRealFft) {
        if (_proceduralRaf) clearTimeout(_proceduralRaf);
        _proceduralTick();
      }
      if (!_isPlayingNative && _proceduralRaf) {
        clearTimeout(_proceduralRaf);
        _proceduralRaf = null;
      }
      for (const cb of _stateCallbacks) { try { cb(ev); } catch {} }
    });
    _plugin.addListener('nowPlaying', ev => {
      // ICY in-band StreamTitle from ExoPlayer's metadata events. Native
      // side emits { title: 'Artist - Song' [, url] } whenever the radio
      // server sends a new StreamTitle (typically every 10-30 seconds).
      for (const cb of _nowPlayingCallbacks) { try { cb(ev); } catch {} }
    });
    // Lockscreen custom-button taps. Plugin's MediaSession.Callback
    // surfaces them as nextRequested / prevRequested events; player.js
    // owns the queue and decides which track to load next.
    _plugin.addListener('nextRequested', () => {
      for (const cb of _nextCallbacks) { try { cb(); } catch {} }
    });
    _plugin.addListener('prevRequested', () => {
      for (const cb of _prevCallbacks) { try { cb(); } catch {} }
    });
    // Track transition (auto-advance or skip-to-index): native side fires
    // ev = { index, reason }. JS uses index to keep its queueIndex /
    // currentTrack stores in lockstep with what ExoPlayer is actually
    // playing.
    _plugin.addListener('trackTransition', ev => {
      for (const cb of _trackTransitionCallbacks) { try { cb(ev); } catch {} }
    });
    _plugin.addListener('position', ev => {
      // 250ms position ticks while playing. ev = { position: ms[, duration: ms] }.
      // duration omitted for live streams (radio).
      for (const cb of _positionCallbacks) { try { cb(ev); } catch {} }
    });
    _plugin.addListener('fft', ev => {
      // Native side base64-encodes the FFT byte array (each pair of bytes
      // is a real,imag coefficient). Decode here and compute magnitudes
      // so callers receive a Float32Array of normalized 0..1 bin levels.
      const bins = _decodeFft(ev?.fft);
      if (!bins) return;
      // Real Visualizer worked — kill any procedural fallback.
      _gotRealFft = true;
      if (_proceduralRaf) { clearTimeout(_proceduralRaf); _proceduralRaf = null; }
      for (const cb of _fftCallbacks) { try { cb(bins); } catch {} }
    });
  } catch { _plugin = null; }
  return _plugin;
}

function _decodeFft(b64) {
  if (!b64) return null;
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  } catch { return null; }
  if (bytes.length === 0) return null;
  // Each byte is a dB-scaled per-bin magnitude (0..255), matching
  // AnalyserNode.getByteFrequencyData() on the PWA. Linear-normalize to
  // [0, 1] for the FAB visualizer to render at the same bar heights as
  // the web side.
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return out;
}

/**
 * Start playback of a single URL. `opts` lets callers pre-fill the
 * MediaSession metadata + supply per-request HTTP headers (Subsonic /
 * Jellyfin auth) so the native ExoPlayer can reach authenticated
 * library tracks.
 *
 *   opts.isHls    — force HLS pipeline (auto-detected from .m3u8 otherwise)
 *   opts.title    — pre-fill lockscreen title
 *   opts.artist   — pre-fill lockscreen artist
 *   opts.album    — pre-fill lockscreen album
 *   opts.coverUrl — pre-fill lockscreen artwork
 *   opts.headers  — extra HTTP headers (e.g. { Authorization: 'Bearer …' })
 */
export async function play(url, opts = {}) {
  const p = _getPlugin();
  if (!p) return false;
  try {
    await p.play({
      url,
      isHls:    !!opts.isHls,
      title:    opts.title    || undefined,
      artist:   opts.artist   || undefined,
      album:    opts.album    || undefined,
      coverUrl: opts.coverUrl || undefined,
      headers:  opts.headers  || undefined,
    });
    return true;
  } catch (e) {
    console.warn('[native-player] play failed:', e?.message || e);
    return false;
  }
}

/** Seek the current track to an absolute position (milliseconds). */
export async function seek(positionMs) {
  const p = _getPlugin();
  if (!p) return;
  try { await p.seek({ position: Math.max(0, Math.floor(positionMs)) }); } catch {}
}

/**
 * Hand ExoPlayer the full queue + a start index so it can pre-buffer the
 * next track while the current plays. `items` is an array of
 *   { url, title, artist, album, coverUrl, headers, isHls }
 * matching what play() takes for a single track.
 */
export async function setQueue(items, startIndex = 0) {
  const p = _getPlugin();
  if (!p) return false;
  try {
    await p.setQueue({ items, startIndex });
    return true;
  } catch (e) {
    console.warn('[native-player] setQueue failed:', e?.message || e);
    return false;
  }
}

/** Jump to a track index in the already-loaded queue (cheap — no rebuild). */
export async function seekToIndex(index) {
  const p = _getPlugin();
  if (!p) return;
  try { await p.seekToIndex({ index: Math.max(0, Math.floor(index)) }); } catch {}
}

/** Native skip-next using the pre-buffered playlist (gapless). */
export async function seekToNext() {
  const p = _getPlugin();
  if (!p) return;
  try { await p.seekToNext(); } catch {}
}

/** Native skip-prev using the pre-buffered playlist (gapless). */
export async function seekToPrevious() {
  const p = _getPlugin();
  if (!p) return;
  try { await p.seekToPrevious(); } catch {}
}

/**
 * Toggle the lockscreen / notification action layout.
 *   library = true  → Prev + Next + Stop (finite library tracks)
 *   library = false → Stop only          (live radio)
 */
export async function setLibraryLayout(library) {
  const p = _getPlugin();
  if (!p) return;
  try { await p.setLibraryLayout({ library: !!library }); } catch {}
}

export async function pause() {
  const p = _getPlugin();
  if (!p) return;
  try { await p.pause(); } catch {}
}

export async function resume() {
  const p = _getPlugin();
  if (!p) return;
  try { await p.resume(); } catch {}
}

export async function stop() {
  const p = _getPlugin();
  if (!p) return;
  try { await p.stop(); } catch {}
}

export async function setVolume(volume) {
  const p = _getPlugin();
  if (!p) return;
  try { await p.setVolume({ volume: Math.max(0, Math.min(1, volume)) }); } catch {}
}

/** Subscribe to playback state events. Returns an unsubscribe fn. */
export function onState(cb) {
  _getPlugin();
  _stateCallbacks.add(cb);
  return () => _stateCallbacks.delete(cb);
}

/**
 * Subscribe to native FFT frequency captures. Callback receives a
 * Float32Array (length 128 by default) of normalized magnitudes in 0..1.
 * The Trace FAB visualizer feeds this directly into its bar heights when
 * audio is playing through ExoPlayer, replacing the Web Audio analyser
 * (which can't see native-side audio).
 *
 * Returns an unsubscribe fn.
 */
export function onFft(cb) {
  _getPlugin();
  _fftCallbacks.add(cb);
  return () => _fftCallbacks.delete(cb);
}

/**
 * Subscribe to in-band ICY metadata updates ("Artist - Song" titles)
 * delivered by ExoPlayer when the upstream server sends StreamTitle
 * fields. Callback receives { title, url? }.
 */
export function onNowPlaying(cb) {
  _getPlugin();
  _nowPlayingCallbacks.add(cb);
  return () => _nowPlayingCallbacks.delete(cb);
}

/**
 * Subscribe to position ticks emitted every 250ms while playing.
 * Callback receives { position: ms [, duration: ms] }. Duration is
 * omitted for live streams (radio).
 */
export function onPosition(cb) {
  _getPlugin();
  _positionCallbacks.add(cb);
  return () => _positionCallbacks.delete(cb);
}

/**
 * Subscribe to lockscreen / notification "Next" button taps. Plugin's
 * MediaSession owns no queue, so JS receives this as a request and
 * picks the next track from its own queue.
 */
export function onNext(cb) {
  _getPlugin();
  _nextCallbacks.add(cb);
  return () => _nextCallbacks.delete(cb);
}

/** Subscribe to lockscreen "Previous" button taps. See onNext. */
export function onPrev(cb) {
  _getPlugin();
  _prevCallbacks.add(cb);
  return () => _prevCallbacks.delete(cb);
}

/**
 * Subscribe to ExoPlayer track-transition events. Fires whenever the
 * currently-playing item in the native queue changes — auto-advance,
 * lockscreen skip, in-app skip — so JS can sync queueIndex / currentTrack
 * to whatever ExoPlayer landed on.
 *
 * Callback receives { index, reason } where reason matches Media3's
 * MEDIA_ITEM_TRANSITION_REASON_* constants:
 *   0 = REPEAT      (single-item repeat fired)
 *   1 = AUTO        (track ended, advancing to next)
 *   2 = SEEK        (seekToNextMediaItem etc.)
 *   3 = PLAYLIST_CHANGED (setMediaSources)
 */
export function onTrackTransition(cb) {
  _getPlugin();
  _trackTransitionCallbacks.add(cb);
  return () => _trackTransitionCallbacks.delete(cb);
}

export const isAvailable = () => isNative;
