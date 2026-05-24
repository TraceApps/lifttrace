import { writable, get } from 'svelte/store';
import { DB } from '../lib/db.js';
import { createMseStreamer, isSupported as mseSupported, mimeForContainer, isTypeSupported as mseTypeSupported } from '../lib/mseStreamer.js';
import { isNative, getAuthToken, apiUrl, resolveAssetUrl } from '../lib/platform.js';

/**
 * Music player store — aligned with Google's canonical Media Session sample:
 * https://googlechrome.github.io/samples/media-session/audio.html
 *
 * Principles matching canonical:
 *   - Single <audio> element created at module level
 *   - All Media Session action handlers registered at module load
 *   - Metadata updated inside audio.play().then(...) callback
 *   - Native 'play'/'pause' audio events drive mediaSession.playbackState
 *   - Same audio element reused for every track (only src changes)
 */

// ── Native ExoPlayer routing for radio streams ─────────────────────────
// Capacitor builds route radio streams through Android's native ExoPlayer
// (LtRadioPlayer plugin) instead of the WebView's <audio> element. Avoids
// Chromium's deterministic HE-AAC decoder bug at packet #128 of iHeart-
// style streams. Music tracks (transcodeUrl / streamUrl from Subsonic)
// continue to use the audio element + MSE pipeline as before.
let _nativeStreamActive = false;
let _nativeMusicActive = false;     // true when a library track plays via native ExoPlayer
let _nativeStateUnsub = null;
let _nativePositionUnsub = null;
let _nativeNextUnsub = null;
let _nativePrevUnsub = null;

async function _playStreamNative(track) {
  // Tear down audio-element pipeline so it doesn't fight with native output.
  if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {} }
  _destroyHls();
  _resetMse();
  _stopProgress();
  if (_crossfadeAudio) { _crossfadeAudio.pause(); _crossfadeAudio = null; }

  const np = await import('../lib/native-player.js');
  _wireNativeListenersOnce(np);

  _nativeStreamActive = true;
  const isHls = _isHlsUrl(track.streamUrl);
  await np.play(track.streamUrl, {
    isHls,
    title:    track.title || '',
    artist:   track.artist || '',
    // Same cover-URL resolution as library tracks — station icons are
    // typically external HTTPS URLs that load fine, but the wrap is
    // harmless there and uniformly handles any /uploads/... case too.
    coverUrl: resolveAssetUrl(track.coverUrl || ''),
  });
  await np.setVolume(get(volume));
  isPlaying.set(true);
}

async function _teardownNativeStream() {
  if (!_nativeStreamActive) return;
  _nativeStreamActive = false;
  try {
    const np = await import('../lib/native-player.js');
    await np.stop();
  } catch {}
}

// ── Native music routing for library tracks (Subsonic / Jellyfin / etc) ──
// Phase 2 of the unified Media3 player: library tracks now also flow
// through the same native ExoPlayer + MediaSession that radio uses.
// Replaces the audio-element + MSE pipeline + capacitor-music-controls
// stack on Android — one MediaSession, one notification UX, no more
// dual-session conflicts.
// Track the last queue we handed to ExoPlayer. If the JS queue still
// matches when the user picks a different track, we just call
// seekToIndex (cheap — already pre-buffered) instead of rebuilding the
// whole MediaSource list.
let _lastNativeQueueSig = null;

function _trackToNativeItem(t) {
  const rawUrl = t.streamUrl || '';
  const url = rawUrl.startsWith('http') ? rawUrl : apiUrl(rawUrl);
  const headers = {};
  const token = getAuthToken();
  if (token && url.startsWith(apiUrl('/'))) {
    headers.Authorization = `Bearer ${token}`;
  }
  return {
    url,
    title:    t.title  || '',
    artist:   t.artist || '',
    album:    t.album  || '',
    coverUrl: resolveAssetUrl(t.coverUrl || ''),
    headers:  Object.keys(headers).length ? headers : undefined,
    isHls:    _isHlsUrl(rawUrl),
  };
}

async function _playMusicNative(track) {
  // Tear down audio-element pipeline so it doesn't fight with native output.
  if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {} }
  _destroyHls();
  _resetMse();
  _stopProgress();
  if (_crossfadeAudio) { _crossfadeAudio.pause(); _crossfadeAudio = null; }

  const np = await import('../lib/native-player.js');
  _wireNativeListenersOnce(np);

  _nativeMusicActive = true;
  // Reset progress stores — the position-tick listener will refill them
  // as soon as ExoPlayer enters READY.
  currentTime.set(0);
  progress.set(0);
  duration.set(0);

  // Hand ExoPlayer the FULL queue + start index so it pre-buffers the
  // next track while the current plays — the equivalent of the PWA's
  // MSE-streamer gapless pipeline. Each MediaItem carries its own
  // metadata, so subsequent track changes auto-update the lockscreen
  // title/artist/cover via Media3's native onMediaItemTransition path.
  const q = get(queue);
  const idx = q.findIndex(t => t.id === track.id);
  const startIndex = idx >= 0 ? idx : 0;
  // Stable signature of the queue contents so we can skip rebuilds when
  // the user just picks a different track in the same album.
  const sig = q.map(t => t.id).join('|');

  if (sig === _lastNativeQueueSig && idx >= 0) {
    await np.seekToIndex(idx);
  } else {
    const items = q.length > 0 ? q.map(_trackToNativeItem) : [_trackToNativeItem(track)];
    await np.setQueue(items, startIndex);
    _lastNativeQueueSig = sig;
  }
  await np.setVolume(get(volume));
  isPlaying.set(true);
}

async function _teardownNativeMusic() {
  if (!_nativeMusicActive) return;
  _nativeMusicActive = false;
  // Drop the cached queue signature so the next play rebuilds the
  // native MediaSource list cleanly (the player gets released by stop()).
  _lastNativeQueueSig = null;
  try {
    const np = await import('../lib/native-player.js');
    await np.stop();
  } catch {}
}

/**
 * One-time listener wiring for native player events. Both _playStreamNative
 * and _playMusicNative call this on first use; subsequent calls are no-ops.
 * Listeners check _nativeStreamActive vs _nativeMusicActive to know which
 * pipeline owns the current playback.
 */
function _wireNativeListenersOnce(np) {
  if (!_nativeStateUnsub) {
    _nativeStateUnsub = np.onState(ev => {
      const s = ev?.state;
      if (s === 'playing') {
        isPlaying.set(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      } else if (s === 'paused' || s === 'ended') {
        isPlaying.set(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        // Library track auto-advance — when ExoPlayer ends a finite
        // track, hop to the next queue entry.
        if (s === 'ended' && _nativeMusicActive) _debouncedNext();
      } else if (s === 'error') {
        console.warn('[player] native error:', ev.error);
        isPlaying.set(false);
      }
    });
  }
  if (!_nativePositionUnsub) {
    _nativePositionUnsub = np.onPosition(ev => {
      // Position ticks are 4Hz while a finite track plays. Streams report
      // position only (no duration). Mirror to the same stores the
      // audio-element path uses so the UI doesn't care which backend ran.
      if (typeof ev?.position === 'number') {
        const seconds = ev.position / 1000;
        currentTime.set(seconds);
        if (typeof ev.duration === 'number' && ev.duration > 0) {
          const dur = ev.duration / 1000;
          duration.set(dur);
          progress.set(seconds / dur);
        }
      }
    });
  }
  if (!_nativeNextUnsub && np.onNext) _nativeNextUnsub = np.onNext(() => _debouncedNext());
  if (!_nativePrevUnsub && np.onPrev) _nativePrevUnsub = np.onPrev(() => _debouncedPrev());

  // ExoPlayer's native auto-advance + skip events. With the queue handed
  // to ExoPlayer via setQueue(), track transitions happen INSIDE the
  // player and we just sync the JS-side queueIndex / currentTrack stores
  // to whatever index ExoPlayer landed on. This is what makes the in-app
  // mini player + Trace AI context catch up after a lockscreen skip.
  if (np.onTrackTransition) np.onTrackTransition(ev => {
    if (!_nativeMusicActive) return;
    const idx = ev?.index;
    if (typeof idx !== 'number') return;
    const q = get(queue);
    if (idx < 0 || idx >= q.length) return;
    queueIndex.set(idx);
    currentTrack.set(q[idx]);
  });

  // ICY metadata wiring is only relevant for streams; left in place so
  // _playStreamNative's existing flow keeps working.
  np.onNowPlaying(ev => {
    if (!ev?.title) return;
    if (!_nativeStreamActive) return; // ignore for library tracks
    const directArtwork = ev.artwork || '';
    import('../lib/radio-icy.js').then(m => {
      const { title, artwork } = m.parseStreamTitle(ev.title);
      if (title) streamNowPlaying.set(title);
      const finalArt = directArtwork || artwork;
      if (finalArt) streamArtwork.set(finalArt);
    }).catch(() => {
      streamNowPlaying.set(ev.title);
      if (directArtwork) streamArtwork.set(directArtwork);
    });
  });
}

// ── HLS support (lazy-loaded so hls.js only hits the bundle when needed) ───
let _hls = null;

function _isHlsUrl(url) {
  return url && /\.m3u8(\?|$)/i.test(url);
}

function _destroyHls() {
  if (_hls) { try { _hls.destroy(); } catch {} _hls = null; }
}

// Minimal ID3v2 parser — pulls TIT2 (title) and TPE1 (artist) from the
// bytes hls.js hands us in FRAG_PARSING_METADATA events. Returns "" if the
// buffer isn't a valid ID3 tag.
function _parseId3(bytes) {
  if (!bytes || bytes.length < 10) return '';
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return '';
  const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
  const end = Math.min(10 + size, bytes.length);
  let pos = 10, title = '', artist = '';
  while (pos <= end - 10) {
    const id = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = (bytes[pos+4] << 24) | (bytes[pos+5] << 16) | (bytes[pos+6] << 8) | bytes[pos+7];
    if (frameSize <= 0 || pos + 10 + frameSize > end) break;
    if (id === 'TIT2' || id === 'TPE1') {
      const enc = bytes[pos + 10];
      const data = bytes.subarray(pos + 11, pos + 10 + frameSize);
      let text = '';
      try {
        if (enc === 0) text = new TextDecoder('iso-8859-1').decode(data);
        else if (enc === 1 || enc === 2) text = new TextDecoder('utf-16').decode(data);
        else text = new TextDecoder('utf-8').decode(data);
      } catch {}
      text = text.replace(/\0+$/g, '').trim();
      if (id === 'TIT2') title = text;
      else artist = text;
    }
    pos += 10 + frameSize;
  }
  if (artist && title) return `${artist} - ${title}`;
  return title || artist || '';
}

async function _attachHls(a, url) {
  _destroyHls();
  const { default: Hls } = await import('hls.js');
  if (Hls.isSupported()) {
    _hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    _hls.loadSource(url);
    _hls.attachMedia(a);
    return new Promise((resolve) => {
      _hls.on(Hls.Events.MANIFEST_PARSED, () => {
        a.play().catch((err) => console.warn('[player] HLS play() rejected:', err?.name));
        resolve();
      });
      // ID3 metadata from TS segments — where HLS stations put "now playing".
      // Run the raw "Artist - Title" through the same sanitizer the ICY path
      // uses so RDS Italia's `Song*A*B*C*D` shape (and other quirky formats)
      // get cleaned before hitting the UI / lockscreen.
      _hls.on(Hls.Events.FRAG_PARSING_METADATA, (_, data) => {
        if (!data?.samples) return;
        for (const sample of data.samples) {
          const raw = _parseId3(sample.data);
          if (!raw) continue;
          import('../lib/radio-icy.js').then(m => {
            const clean = m.sanitizeTitle(raw);
            if (!clean) return;
            streamNowPlaying.set(clean);
            _updateStreamMediaSession(clean, '');
          }).catch(() => {
            streamNowPlaying.set(raw);
          });
          break;
        }
      });
      _hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          console.warn('[player] HLS fatal error:', data.type, data.details);
          _destroyHls();
          resolve();
        }
      });
    });
  } else if (a.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari — native HLS
    a.src = url;
    a.play().catch((err) => console.warn('[player] HLS play() rejected:', err?.name));
  } else {
    console.warn('[player] HLS not supported in this browser');
  }
}

// ── Stores ──────────────────────────────────────────────────────────────────
export const currentTrack      = writable(null);
export const queue             = writable([]);
export const queueIndex        = writable(-1);
export const isPlaying         = writable(false);
export const progress          = writable(0);
export const currentTime       = writable(0);
export const duration          = writable(0);
export const volume            = writable(DB.getSetting('playerVolume', 0.5));
export const shuffle           = writable(DB.getSetting('playerShuffle', false));
export const repeat            = writable(DB.getSetting('playerRepeat', 'off'));
export const miniPlayerVisible = writable(false);
export const showQueue         = writable(false);
export const isBuffering       = writable(false);
export const streamNowPlaying  = writable('');  // ICY StreamTitle for current radio stream
export const streamArtwork     = writable('');  // Per-song artwork URL (iHeart amgArtworkURL); '' = fall back to station icon

// ── Single audio element, created lazily on first user-gesture play ─────────
let audio = null;
let _progressInterval = null;
let _crossfadeAudio = null; // second element used only for crossfade
let _crossfadeTimer = null;
let _isCrossfading = false;

// MSE streamer — continuous buffer approach for background playback.
// When active, auto-advance to next track happens by appending to the
// existing buffer rather than changing audio.src (which would cause a
// brief pause and trigger Chrome's background tab freeze).
let _mse = null;
let _mseActive = false;

// Committed "next up" index for shuffle mode. In shuffle, both prefetch
// and actual advance must agree on which track plays next — otherwise
// we'd prefetch random track A and then auto-advance to random track B
// (wasted bandwidth + silence gap while B is fetched).
// Cleared on: track advance (consumed), stop, queue mutation, shuffle toggle.
let _shuffleNextIdx = -1;

// Lightweight prefetch element for the non-MSE fallback path. Uses
// preload='auto' to populate the browser HTTP cache without playing,
// so when the main element loads the same URL on track change, bytes
// come from cache.
let _prefetchAudio = null;

function _getAudio() {
  if (audio) return audio;
  audio = document.createElement('audio');
  audio.volume = get(volume);
  // Per real-world PWA audio reports, the element must be rendered in
  // DOM — browser treats detached Audio objects as lower-priority and
  // suspends them faster when the tab backgrounds.
  audio.setAttribute('playsinline', 'true');
  audio.setAttribute('webkit-playsinline', 'true');
  audio.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(audio);
  }

  // Native events drive both our internal state AND Media Session playbackState
  audio.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    isPlaying.set(true);
    _startProgress();
  });
  audio.addEventListener('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    isPlaying.set(false);
    _stopProgress();
  });
  audio.addEventListener('ended', _onEnded);
  audio.addEventListener('loadedmetadata', () => duration.set(audio.duration || 0));
  audio.addEventListener('durationchange', () => duration.set(audio.duration || 0));
  audio.addEventListener('error', _onError);
  return audio;
}

// Recover audio state when returning from a frozen/backgrounded tab.
// On some Android browsers the audio element can enter a "stuck" state
// where audio.paused is true but audio.play() resolves without audibly
// playing. Re-issuing play() reliably wakes it up.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !audio) return;
    // If the store says we should be playing but the element paused
    // itself (browser suspended), restart playback
    if (get(isPlaying) && audio.paused && audio.src) {
      audio.play().catch((err) => {
        console.warn('[player] visibility resume play rejected:', err?.name);
      });
    }
  });
}

// Live-stream auto-recovery: how many times we'll re-open a stream that
// errors mid-playback before giving up. iHeart HE-AAC streams (Z100, KIIS,
// etc.) deterministically hit a Chromium decoder error every ~5s; resetting
// the src starts a fresh decoder pipeline that gets another ~5s of audio
// before failing again. Net effect: continuous playback with brief gaps
// instead of silence after the first error.
const _STREAM_RECOVER_MAX = 60;          // ~5min of recoveries at 5s each
const _STREAM_RECOVER_DELAY_MS = 400;    // tiny gap during reset
let _streamRecoverCount = 0;
let _streamRecoverTrackId = null;

function _onError() {
  // Ignore errors triggered by stop() clearing the src
  if (_stopping) return;
  const err = audio.error;
  const codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
  console.warn(`[player] Audio error: ${codes[err?.code] || err?.code} — ${err?.message || 'unknown'}`);
  const track = get(currentTrack);

  // Live-stream recovery: re-set the src so a fresh decoder pipeline opens.
  // Only triggers for stream tracks that have already played at least once.
  if (track?.isStream && track?.streamUrl) {
    if (_streamRecoverTrackId !== track.id) {
      _streamRecoverTrackId = track.id;
      _streamRecoverCount = 0;
    }
    if (_streamRecoverCount < _STREAM_RECOVER_MAX) {
      _streamRecoverCount += 1;
      const url = track.streamUrl;
      console.info(`[player] live-stream recovery ${_streamRecoverCount}/${_STREAM_RECOVER_MAX}`);
      // Full audio element reset — just re-assigning src after a DECODE
      // error leaves the decoder in its broken state and the play() call
      // synchronously fails with "no supported source was found".
      // removeAttribute + load() forces a clean tear-down before the new
      // src assignment.
      try { audio.pause(); } catch {}
      audio.removeAttribute('src');
      try { audio.load(); } catch {}
      setTimeout(() => {
        if (get(currentTrack)?.id !== track.id) return;  // user moved on
        // Cache-buster so the WebView doesn't short-circuit the new
        // request thinking it has a cached "this URL failed" response.
        const sep = url.includes('?') ? '&' : '?';
        audio.src = url + sep + '_lr=' + Date.now();
        audio.play().catch(e => console.warn('[player] recover play() rejected:', e?.message));
      }, _STREAM_RECOVER_DELAY_MS);
      return;
    }
    console.warn('[player] live-stream recovery cap reached — giving up');
  }

  // Try transcoded stream once
  if (track?.transcodeUrl && !audio.src.includes('transcode') && !audio.src.includes('universal')) {
    console.info('[player] Falling back to transcoded stream');
    audio.src = track.transcodeUrl;
    audio.play().catch(() => {});
    return;
  }
  // Both main and transcode failed — skip to next so one bad file doesn't stall the queue
  const q = get(queue);
  if (q.length > 1) {
    console.info('[player] unsupported track, auto-skipping');
    next();
  } else {
    isPlaying.set(false);
  }
}

// ── Progress tick ───────────────────────────────────────────────────────────
function _startProgress() {
  clearInterval(_progressInterval);
  let posTickCount = 0;
  _progressInterval = setInterval(() => {
    if (audio && !audio.paused) {
      if (_mseActive && _mse) {
        // MSE mode: audio.currentTime is cumulative across tracks.
        // Compute per-track position from the streamer's entry info.
        const entry = _mse.getCurrentTrackEntry();
        if (entry && entry.duration > 0) {
          const rel = audio.currentTime - entry.startTime;
          currentTime.set(rel);
          duration.set(entry.duration);
          progress.set(Math.max(0, Math.min(1, rel / entry.duration)));
          // Auto-pre-append next track when current has < 8s remaining
          const remaining = entry.duration - rel;
          if (remaining <= 8 && remaining > 0 && !_mseAppendInFlight) {
            _mseAppendInFlight = true;
            _mseAppendNext().finally(() => { _mseAppendInFlight = false; });
          }
          // End-of-queue detection: MSE doesn't fire 'ended' when the buffer
          // runs out (MediaSource stays open), so the 'pause' event never
          // fires and isPlaying stays true. When we're at the buffer end with
          // nothing more to append (last track, repeat off), explicitly pause.
          if (remaining <= 0.1) {
            const q = get(queue);
            const curIdx = get(queueIndex);
            const rep = get(repeat);
            const atEndOfQueue = curIdx >= q.length - 1 && rep !== 'all' && rep !== 'one';
            if (atEndOfQueue && !_mseAppendInFlight) {
              pause();
              return;
            }
          }
        }
        if (++posTickCount >= 4) { _updatePositionState(); posTickCount = 0; }
        return;
      }
      const d = audio.duration;
      currentTime.set(audio.currentTime);
      if (Number.isFinite(d) && d > 0) {
        progress.set(audio.currentTime / d);
        if (++posTickCount >= 4) { _updatePositionState(); posTickCount = 0; }

        const cf = DB.getSetting('radioCrossfade', 0);
        const remaining = d - audio.currentTime;
        if (cf > 0 && !_isCrossfading && remaining <= cf && d > cf + 2) {
          _startCrossfade(cf);
        }
        // Warm up the next track's bytes ~15s before end so the browser
        // cache is primed when we swap audio.src on track change.
        if (!_fallbackPrefetchFired && remaining <= 15 && remaining > 0) {
          _fallbackPrefetchFired = true;
          _prefetchNextFallback();
        }
      } else {
        progress.set(0);
      }
    }
  }, 250);
}
let _mseAppendInFlight = false;
// Fires once per current track — reset whenever a new track starts playing.
let _fallbackPrefetchFired = false;
function _stopProgress() { clearInterval(_progressInterval); }

// ── Crossfade (manual, using second audio element) ──────────────────────────
function _startCrossfade(fadeSecs) {
  _isCrossfading = true;
  const q = get(queue);
  const nextIdx = _getNextIndex();
  if (nextIdx < 0 || !q[nextIdx]) { _isCrossfading = false; return; }

  const nextTrack = q[nextIdx];
  _crossfadeAudio = document.createElement('audio');
  _crossfadeAudio.volume = 0;
  _crossfadeAudio.src = nextTrack.streamUrl;
  _crossfadeAudio.play().catch(() => {});

  const steps = fadeSecs * 20;
  let step = 0;
  const vol = get(volume);
  clearInterval(_crossfadeTimer);
  _crossfadeTimer = setInterval(() => {
    step++;
    const f = step / steps;
    if (audio) audio.volume = vol * (1 - f);
    if (_crossfadeAudio) _crossfadeAudio.volume = vol * f;
    if (step >= steps) {
      clearInterval(_crossfadeTimer);
      // Move the faded-in stream into the main element (reuse element — critical for mobile)
      const swappedSrc = _crossfadeAudio.src;
      const swappedPos = _crossfadeAudio.currentTime;
      _crossfadeAudio.pause();
      _crossfadeAudio = null;
      queueIndex.set(nextIdx);
      currentTrack.set(nextTrack);
      audio.src = swappedSrc;
      audio.currentTime = swappedPos;
      audio.volume = vol;
      audio.play().then(() => _updateMediaSession(nextTrack)).catch(() => {});
      _isCrossfading = false;
    }
  }, 50);
}

// ── Queue navigation ────────────────────────────────────────────────────────
function _pickRandomNext() {
  const q = get(queue);
  if (q.length === 0) return -1;
  if (q.length === 1) return 0;
  const cur = get(queueIndex);
  let r;
  do { r = Math.floor(Math.random() * q.length); } while (r === cur);
  return r;
}

/** Peek at the next index without consuming it. Used by prefetch so
 *  prefetch and actual advance agree in shuffle mode. */
function _peekNextIndex() {
  const q = get(queue);
  if (q.length === 0) return -1;
  if (get(shuffle)) {
    if (_shuffleNextIdx < 0 || _shuffleNextIdx >= q.length) {
      _shuffleNextIdx = _pickRandomNext();
    }
    return _shuffleNextIdx;
  }
  const next = get(queueIndex) + 1;
  if (next >= q.length) return get(repeat) === 'all' ? 0 : -1;
  return next;
}

/** Consume the committed next index. Used by actual advance. */
function _getNextIndex() {
  const idx = _peekNextIndex();
  _shuffleNextIdx = -1;
  return idx;
}

function _resetNextUp() { _shuffleNextIdx = -1; }

function _onEnded() {
  if (_isCrossfading) return;
  const rep = get(repeat);
  if (rep === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  next();
}

// ── Media Session setup (canonical pattern — registered at module load) ────
function _updateMediaSession(track) {
  if (!track) return;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      artwork: track.coverUrl ? [
        { src: track.coverUrl, sizes: '96x96',  type: 'image/jpeg' },
        { src: track.coverUrl, sizes: '192x192', type: 'image/jpeg' },
        { src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });
  }
  _updatePositionState();
  // Lockscreen on Capacitor is owned by Media3 + RadioPlaybackService — see
  // _playStreamNative / _playMusicNative which set MediaMetadata directly
  // on the native ExoPlayer.
}

function _updatePositionState() {
  if (!('mediaSession' in navigator) || !audio) return;
  if (!('setPositionState' in navigator.mediaSession)) return;
  try {
    if (_mseActive && _mse) {
      const entry = _mse.getCurrentTrackEntry();
      if (entry && entry.duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: entry.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.max(0, audio.currentTime - entry.startTime),
        });
      }
      return;
    }
    if (audio.duration && Number.isFinite(audio.duration)) {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: audio.currentTime || 0,
      });
    }
  } catch {}
}

// Debounce next/prev — some Android lock screens fire the action handler
// twice for one tap, which would advance by 2 or skip unpredictably.
let _lastSkipAt = 0;
const _SKIP_DEBOUNCE_MS = 300;
function _debouncedNext() {
  const now = Date.now();
  if (now - _lastSkipAt < _SKIP_DEBOUNCE_MS) return;
  _lastSkipAt = now;
  next();
}
function _debouncedPrev() {
  const now = Date.now();
  if (now - _lastSkipAt < _SKIP_DEBOUNCE_MS) return;
  _lastSkipAt = now;
  prev();
}

// Lockscreen / notification controls on Capacitor are now owned exclusively
// by Media3 via RadioPlaybackService — see android/.../RadioPlaybackService.java.
// (Pre-unification we also ran capacitor-music-controls-plugin alongside
// Media3 for library tracks, which created two competing MediaSessions and
// caused intermittent dead-tap bugs on the lockscreen.)
//
// On the web, the Web Media Session API below handles the same job natively.

// Register all action handlers at module load — canonical pattern
if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
  const setHandler = (name, fn) => {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch {}
  };
  setHandler('play',          () => play());
  setHandler('pause',         () => pause());
  setHandler('previoustrack', _debouncedPrev);
  setHandler('nexttrack',     _debouncedNext);
  setHandler('stop',          () => stop());
  setHandler('seekbackward',  (e) => {
    if (!audio) return;
    const skip = e?.seekOffset || 10;
    // Clamp to current track start in MSE mode so we don't fall into
    // the previous track's buffered region
    let min = 0;
    if (_mseActive && _mse) {
      const entry = _mse.getCurrentTrackEntry();
      if (entry) min = entry.startTime;
    }
    audio.currentTime = Math.max(audio.currentTime - skip, min);
    _updatePositionState();
  });
  setHandler('seekforward',   (e) => {
    if (!audio) return;
    const skip = e?.seekOffset || 10;
    // Clamp to current track end in MSE mode so we don't skip into the next
    let max = audio.duration || Infinity;
    if (_mseActive && _mse) {
      const entry = _mse.getCurrentTrackEntry();
      if (entry) max = entry.startTime + entry.duration;
    }
    audio.currentTime = Math.min(audio.currentTime + skip, max);
    _updatePositionState();
  });
  setHandler('seekto',        (e) => {
    if (!audio) return;
    // Lock-screen scrubber reports per-track seekTime (0 to track duration).
    // In MSE mode audio.currentTime is cumulative — translate to absolute.
    let target = e.seekTime;
    if (_mseActive && _mse) {
      const entry = _mse.getCurrentTrackEntry();
      if (entry) {
        target = entry.startTime + Math.max(0, Math.min(entry.duration, e.seekTime));
      }
    }
    if (e.fastSeek && 'fastSeek' in audio) { audio.fastSeek(target); return; }
    audio.currentTime = target;
    _updatePositionState();
  });
}

// ── Keyboard shortcuts (desktop) ────────────────────────────────────────────
// Only fire when nothing is being typed. Spacebar to play/pause, arrows to
// skip tracks. Kept minimal so we don't hijack standard page shortcuts.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (!get(currentTrack)) return; // nothing playing \u2192 ignore
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        if (e.shiftKey) { _debouncedNext(); e.preventDefault(); }
        break;
      case 'ArrowLeft':
        if (e.shiftKey) { _debouncedPrev(); e.preventDefault(); }
        break;
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function playTrack(track, newQueue = null, startIndex = 0) {
  _stopping = false;
  _isCrossfading = false;
  _fallbackPrefetchFired = false;
  _resetNextUp();
  clearInterval(_crossfadeTimer);
  _destroyHls();
  if (_crossfadeAudio) { _crossfadeAudio.pause(); _crossfadeAudio = null; }

  if (newQueue) {
    queue.set(newQueue);
    queueIndex.set(startIndex);
  }
  currentTrack.set(track);
  miniPlayerVisible.set(true);

  // Radio station with ICY metadata → start polling now-playing.
  // Skip the poll on native — ExoPlayer's IcyInfo events deliver the
  // same data via onNowPlaying() and the poll's /status-json.xsl
  // fallback returns 404 on iHeart, clearing the title every 8s.
  if (track.isStream && track.originalUrl && !isNative) _startNowPlayingPoll(track.originalUrl);
  else _stopNowPlayingPoll();

  // Capacitor: route ALL playback through the native ExoPlayer plugin.
  // Radio streams + library tracks share one MediaSession, one notification,
  // one decoder. The audio-element + MSE + capacitor-music-controls path
  // is web-only.
  if (isNative) {
    // Android 13+ requires POST_NOTIFICATIONS as a runtime permission
    // before the MediaSession notification will render. Idempotent.
    try {
      const { requestPermission } = await import('../lib/notifications.js');
      requestPermission().catch(() => {});
    } catch {}
    if (track.isStream) {
      if (_nativeMusicActive) await _teardownNativeMusic();
      _nativeStreamActive = true;
      _updateMediaSession(track);   // Web Media Session no-op on Capacitor
      await _playStreamNative(track);
    } else {
      if (_nativeStreamActive) await _teardownNativeStream();
      _nativeMusicActive = true;
      _updateMediaSession(track);
      await _playMusicNative(track);
    }
    return;
  }
  // Web only — audio element + MSE pipeline.

  const a = _getAudio();
  a.volume = get(volume);
  isPlaying.set(true);
  _startProgress();
  _updateMediaSession(track);

  // Try MSE path first (gapless background playback via continuous buffer)
  if (track.transcodeUrl && mseSupported() && !_mse) {
    try {
      const mseOpts = _decideMseOptions(track);
      _mse = createMseStreamer(mseOpts);
      if (!_mse) throw new Error('MSE options not supported');
      await _mse.attach(a);
      _mse.setOnTrackAdvance((t) => {
        // User's perception: a new track started. Update UI AND
        // queueIndex so prev/next compute correctly from the real
        // current position (not the one we started playback from).
        currentTrack.set(t);
        _updateMediaSession(t);
        const q = get(queue);
        const idx = q.findIndex(qt => qt.id === t.id);
        if (idx >= 0) queueIndex.set(idx);
        // The track we committed as "next up" is now the current track —
        // clear the commit so the next prefetch picks a fresh random.
        _resetNextUp();
      });
      _mseActive = true;
    } catch (e) {
      console.warn('[player] MSE attach failed, falling back to src:', e?.message);
      _mse = null;
      _mseActive = false;
    }
  }

  if (_mseActive && _mse) {
    try {
      // If no new queue is passed (switching within the existing queue,
      // e.g. clicking a song in the queue panel), prefer seeking into
      // the existing buffer if the track is already there. Avoids the
      // silence gap from _mse.reset() + re-fetching.
      if (!newQueue) {
        const existing = _mse.getTrackEntryById(track.id);
        if (existing && a) {
          a.currentTime = existing.startTime;
          currentTrack.set(track);
          _updateMediaSession(track);
          _mseAppendNext();
          await a.play().catch((err) => console.warn('[player] MSE play() rejected:', err?.name, err?.message));
          return;
        }
        // Not yet buffered — append additively (no reset) so pre-fetched
        // tracks already in the buffer stay usable
        isBuffering.set(true);
        let entry;
        try { entry = await _mse.appendTrack(track); }
        finally { isBuffering.set(false); }
        if (entry && a) {
          a.currentTime = entry.startTime;
          _mseAppendNext();
          await a.play().catch((err) => console.warn('[player] MSE play() rejected:', err?.name, err?.message));
          return;
        }
      }

      // Fresh-session path: when a new queue is being loaded
      await _mse.reset();
      isBuffering.set(true);
      try { await _mse.appendTrack(track); }
      finally { isBuffering.set(false); }
      if (a) a.currentTime = 0;
      _mseAppendNext();
      await a.play().catch((err) => console.warn('[player] MSE play() rejected:', err?.name, err?.message));
      return;
    } catch (e) {
      console.warn('[player] MSE track load failed, falling back to src:', e?.message);
      _mseActive = false;
      try { _mse?.destroy(); } catch {}
      _mse = null;
      // Fall through to direct src
    }
  }

  // Fallback: direct audio.src (or HLS for .m3u8 manifests / proxied
  // blob: URLs containing synthetic HLS manifests). The blob: case is the
  // Capacitor live-stream proxy path — see src/lib/stream-proxy.js — which
  // wraps cross-origin radio streams in a one-segment EVENT playlist so
  // hls.js handles the AAC demuxing instead of Chromium's WebView.
  if (_isHlsUrl(track.streamUrl) || (track.isStream && track.streamUrl?.startsWith('blob:'))) {
    await _attachHls(a, track.streamUrl);
    return;
  }
  console.info('[player] setting audio.src =', track.streamUrl);
  a.src = track.streamUrl;
  a.play().catch((err) => console.warn('[player] play() rejected:', err?.name, err?.message));
  _prefetchNextFallback();
}

/**
 * Choose MSE codec + raw/transcoded based on user setting + queue homogeneity.
 *
 * Decision tree:
 *   1. User toggled "Keep original format" OFF → transcoded MP3 (universal)
 *   2. Queue has mixed codecs → transcoded MP3 (MSE can't mix formats)
 *   3. Queue's codec isn't MSE-supported → transcoded MP3
 *   4. Otherwise → raw files with codec-matching MIME
 */
function _decideMseOptions(firstTrack) {
  const defaults = { mime: 'audio/mpeg', raw: false };
  const keepOriginal = DB.getSetting('radioOriginalFormat', false);
  if (!keepOriginal) return defaults;

  const q = get(queue);
  const containers = new Set();
  for (const t of q) {
    containers.add((t.container || '').toLowerCase());
    if (containers.size > 1) return defaults; // mixed → transcode
  }
  // Also consider firstTrack in case queue isn't populated yet
  containers.add((firstTrack.container || '').toLowerCase());
  if (containers.size > 1) return defaults;

  const container = [...containers][0];
  if (!container) return defaults;
  const mime = mimeForContainer(container);
  if (!mime || !mseTypeSupported(mime)) return defaults;
  return { mime, raw: true };
}

async function _mseAppendNext() {
  // Shuffle only commits one track ahead; ordered can look 2 ahead.
  return _mseAppendAhead(get(shuffle) ? 1 : 2);
}

/** Keep the buffer warm with the next `n` tracks.
 *  Runs silently — does NOT flip isBuffering (that's for the current
 *  track only). Background prefetch should never show a spinner. */
async function _mseAppendAhead(n = 2) {
  if (!_mseActive || !_mse) return;
  const q = get(queue);
  let idx = get(queueIndex);
  for (let i = 0; i < n; i++) {
    idx = _computeNextIndex(idx);
    if (idx < 0 || !q[idx]) return;
    try {
      console.info('[player] prefetch MSE', q[idx].title);
      await _mse.appendTrack(q[idx]);
    } catch (e) {
      console.warn('[player] MSE append-ahead failed:', e?.message);
      break;
    }
  }
}

/** Next-index helper that doesn't mutate state (for look-ahead).
 *  In shuffle mode, returns the committed next-up so prefetch and
 *  actual advance target the same track. */
function _computeNextIndex(fromIdx) {
  const q = get(queue);
  if (q.length === 0) return -1;
  if (get(shuffle)) return _peekNextIndex();
  const next = fromIdx + 1;
  if (next >= q.length) return get(repeat) === 'all' ? 0 : -1;
  return next;
}

// ── Fallback prefetch (non-MSE path) ────────────────────────────────────────
function _getPrefetchAudio() {
  if (_prefetchAudio) return _prefetchAudio;
  _prefetchAudio = document.createElement('audio');
  _prefetchAudio.preload = 'auto';
  _prefetchAudio.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(_prefetchAudio);
  }
  return _prefetchAudio;
}

function _prefetchNextFallback() {
  if (_mseActive) return;
  const q = get(queue);
  const idx = _peekNextIndex();
  if (idx < 0 || !q[idx]) return;
  const url = q[idx].streamUrl || q[idx].transcodeUrl;
  if (!url) return;
  const el = _getPrefetchAudio();
  if (el.src === url) return;
  console.info('[player] prefetch fallback', q[idx].title);
  try {
    el.src = url;
    el.load();
  } catch {}
}

function _clearPrefetchFallback() {
  if (_prefetchAudio) {
    try { _prefetchAudio.pause(); } catch {}
    _prefetchAudio.removeAttribute('src');
    try { _prefetchAudio.load(); } catch {}
  }
}

export function play() {
  if (_nativeStreamActive || _nativeMusicActive) {
    import('../lib/native-player.js').then(m => m.resume()).catch(() => {});
    isPlaying.set(true);
    return;
  }
  const a = _getAudio();
  if (!a.src) return;
  isPlaying.set(true);
  _startProgress();
  // If the element was suspended (networkState === NETWORK_NO_SOURCE or 0)
  // while we were backgrounded, calling play() alone may not resume. Force
  // a fresh load first so the browser re-establishes the buffer.
  if (a.readyState === 0 || a.networkState === 3) {
    try { a.load(); } catch {}
  }
  a.play().catch((err) => console.warn('[player] play() rejected:', err?.name, err?.message));
}

export function togglePlay() {
  // Native paths: audio element is always "paused" (no src), so we drive
  // off the isPlaying store rather than audio.paused.
  if (_nativeStreamActive || _nativeMusicActive) {
    if (get(isPlaying)) pause();
    else play();
    return;
  }
  if (!audio) return;
  if (audio.paused) play();
  else pause();
}

export function pause() {
  if (_nativeStreamActive || _nativeMusicActive) {
    import('../lib/native-player.js').then(m => m.pause()).catch(() => {});
    isPlaying.set(false);
    return;
  }
  if (audio) {
    audio.pause();
    isPlaying.set(false);
    _stopProgress();
  }
}

let _stopping = false;

export function stop() {
  _stopping = true;
  _isCrossfading = false;
  _resetNextUp();
  _clearPrefetchFallback();
  clearInterval(_crossfadeTimer);
  _destroyHls();
  _stopNowPlayingPoll();
  // Tear down native ExoPlayer (radio OR library — only one is active at a time).
  _teardownNativeStream();
  _teardownNativeMusic();
  if (_crossfadeAudio) { _crossfadeAudio.pause(); _crossfadeAudio = null; }
  _resetMse();
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  _stopProgress();
  // Flip isPlaying false so subscribers (mini-player UI, Trace mascot
  // headphones overlay, etc.) react to the stop the same way they would
  // to a pause. Was previously only flipped via the audio element's
  // 'pause' event, which doesn't fire reliably here because we strip
  // the src before pause completes.
  isPlaying.set(false);
  currentTrack.set(null);
  miniPlayerVisible.set(false);
  progress.set(0);
  currentTime.set(0);
  duration.set(0);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
  // Reset live-stream auto-recovery so the next station starts with a
  // fresh attempt budget.
  _streamRecoverCount = 0;
  _streamRecoverTrackId = null;
  // Native proxy shutdown — interrupts the pump thread + closes the
  // upstream connection. No-op on web / when no proxy was opened.
  import('../lib/stream-proxy.js').then(m => m.closeProxy()).catch(() => {});
  _stopping = false;
}

export async function next() {
  const q = get(queue);
  if (q.length === 0) return;
  const idx = _getNextIndex();
  if (idx < 0) { pause(); return; }
  queueIndex.set(idx);

  // Native music: ExoPlayer already has the full queue pre-buffered from
  // the setQueue() call in _playMusicNative. seekToNext is a cheap jump
  // (gapless) — playTrack would force a full setMediaSources rebuild and
  // re-buffer. The onTrackTransition listener in _wireNativeListenersOnce
  // syncs queueIndex / currentTrack from the index ExoPlayer lands on.
  if (_nativeMusicActive) {
    const np = await import('../lib/native-player.js');
    if (idx === get(queueIndex) + 1) {
      // Sequential next — let ExoPlayer's pre-buffered next item kick in
      await np.seekToNext();
    } else {
      // Skipped over multiple (e.g. shuffle) — explicit index jump
      await np.seekToIndex(idx);
    }
    currentTrack.set(q[idx]);
    return;
  }
  if (_nativeStreamActive) {
    // Streams have no real queue; playTrack rebuilds with the new station.
    playTrack(q[idx]);
    return;
  }

  // MSE path: seek into the (pre-appended or fresh) next track without
  // touching audio.src. Keeps the tab-freeze exemption alive on locked
  // screens.
  if (_mseActive && _mse) {
    try {
      isBuffering.set(true);
      let entry;
      try { entry = await _mse.appendTrack(q[idx]); }
      finally { isBuffering.set(false); }
      if (entry && audio) {
        audio.currentTime = entry.startTime;
        await audio.play().catch(() => {});
        currentTrack.set(q[idx]);
        _updateMediaSession(q[idx]);
        _mseAppendNext();
        return;
      }
    } catch (e) {
      console.warn('[player] MSE next failed, falling back:', e?.message);
      _resetMse();
    }
  }

  playTrack(q[idx]);
}

function _resetMse() {
  // Destroy the streamer so the next playTrack call creates a fresh one.
  // Don't touch audio.src — the caller will assign a new one immediately
  // (either a fresh MSE blob URL or a direct stream URL).
  if (_mse) {
    try { _mse.destroy(); } catch {}
  }
  _mse = null;
  _mseActive = false;
}

export async function prev() {
  if (_nativeMusicActive) {
    // Native music: gapless skip via ExoPlayer's pre-buffered playlist.
    // Same restart-vs-back rule as elsewhere: within 3s → restart current
    // (cheap seek); otherwise step back one item.
    const q = get(queue);
    if (q.length === 0) return;
    const np = await import('../lib/native-player.js');
    const elapsed = get(currentTime);
    if (elapsed > 3) {
      await np.seek(0);
      return;
    }
    await np.seekToPrevious();
    return;
  }
  if (_nativeStreamActive) {
    const q = get(queue);
    if (q.length === 0) return;
    const cur = get(queueIndex);
    const elapsed = get(currentTime);
    if (elapsed > 3) { playTrack(q[cur]); return; }
    const target = Math.max(0, cur - 1);
    if (target !== cur) queueIndex.set(target);
    playTrack(q[target]);
    return;
  }
  if (!audio) return;
  // Within 3s of track start, restart current (or stay at track 0)
  if (_mseActive && _mse) {
    const cur = _mse.getCurrentTrackEntry();
    if (cur && audio.currentTime - cur.startTime > 3) {
      audio.currentTime = cur.startTime;
      return;
    }
  } else if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const q = get(queue);
  const curIdx = get(queueIndex);
  // Don't wrap around to the last track — if we're at the start,
  // just restart track 0 (what most music apps do, and prevents
  // double-tap on lock screen from jumping to the end)
  if (curIdx <= 0) {
    if (audio) audio.currentTime = 0;
    return;
  }
  const idx = curIdx - 1;
  queueIndex.set(idx);

  // MSE path: if prev track is already in buffer, seek to it
  if (_mseActive && _mse) {
    const existing = _mse.getTrackEntryById(q[idx]?.id);
    if (existing && audio) {
      audio.currentTime = existing.startTime;
      audio.play().catch(() => {});
      currentTrack.set(q[idx]);
      _updateMediaSession(q[idx]);
      return;
    }
    // Previous track not buffered — reset and start fresh
    _resetMse();
  }

  if (q[idx]) playTrack(q[idx]);
}

export function seek(fraction) {
  // Native music: scrub via the native plugin's seek() method. duration
  // store is populated from the position-tick events, so we can convert
  // a 0..1 fraction into milliseconds.
  if (_nativeMusicActive) {
    const dur = get(duration);
    if (!dur || dur <= 0) return;
    const seconds = Math.max(0, Math.min(dur, fraction * dur));
    currentTime.set(seconds);
    progress.set(seconds / dur);
    import('../lib/native-player.js').then(m => m.seek(seconds * 1000)).catch(() => {});
    return;
  }
  // Native radio streams aren't seekable — no-op.
  if (_nativeStreamActive) return;
  if (!audio) return;
  if (_mseActive && _mse) {
    // MSE: seek relative to current track's segment of the buffer
    _mse.seekInCurrentTrack(fraction);
    _updatePositionState();
    return;
  }
  if (!audio.duration) return;
  audio.currentTime = fraction * audio.duration;
  currentTime.set(audio.currentTime);
  progress.set(fraction);
  _updatePositionState();
}

export function setVolume(v) {
  volume.set(v);
  DB.setSetting('playerVolume', v);
  if (audio) audio.volume = v;
  if (_crossfadeAudio) _crossfadeAudio.volume = v;
  // Mirror the volume to the native ExoPlayer pipeline when active.
  if (_nativeStreamActive || _nativeMusicActive) {
    import('../lib/native-player.js').then(m => m.setVolume(v)).catch(() => {});
  }
}

export function toggleShuffle() {
  const v = !get(shuffle);
  shuffle.set(v);
  DB.setSetting('playerShuffle', v);
  _resetNextUp();
}

export function cycleRepeat() {
  const modes = ['off', 'all', 'one'];
  const cur = get(repeat);
  const n = modes[(modes.indexOf(cur) + 1) % modes.length];
  repeat.set(n);
  DB.setSetting('playerRepeat', n);
}

// Cap the queue to keep memory + URL-rotation surface bounded. 500 tracks
// is ~8 hours of continuous playback \u2014 more than any workout needs, and
// well under browser storage limits.
const QUEUE_MAX = 500;

export function clearQueue() { stop(); queue.set([]); queueIndex.set(-1); _resetNextUp(); }
export function addToQueue(track) {
  queue.update(q => {
    if (q.length >= QUEUE_MAX) return q;
    return [...q, track];
  });
  _resetNextUp();
}
export function playNext(track) {
  const idx = get(queueIndex);
  queue.update(q => {
    if (q.length >= QUEUE_MAX) return q;
    const c = [...q]; c.splice(idx + 1, 0, track); return c;
  });
  _resetNextUp();
}

export function removeFromQueue(index) {
  const qi = get(queueIndex);
  queue.update(q => q.filter((_, i) => i !== index));
  _resetNextUp();
  if (index < qi) queueIndex.update(i => i - 1);
  else if (index === qi) {
    const q = get(queue);
    if (q.length === 0) stop();
    else {
      const newIdx = Math.min(qi, q.length - 1);
      queueIndex.set(newIdx);
      playTrack(q[newIdx]);
    }
  }
}

// ── ICY now-playing polling (radio stations only) ─────────────────────────
let _nowPlayingTimer = null;
function _startNowPlayingPoll(originalUrl) {
  _stopNowPlayingPoll();
  if (!originalUrl) return;
  const poll = async () => {
    try {
      const res = await fetch(`/api/radio-proxy/now-playing?url=${encodeURIComponent(originalUrl)}`, { credentials: 'include' });
      if (res.ok) {
        const { title, artwork } = await res.json();
        if (title) streamNowPlaying.set(title);
        // Server-extracted iHeart amgArtworkURL — empty for non-iHeart
        // stations, in which case we don't override the existing value
        // (could already be set from a previous still-relevant poll).
        if (artwork) streamArtwork.set(artwork);
        // Push the new title + artwork onto the OS-level Media Session so
        // the lockscreen / notification / Bluetooth display update as the
        // song changes. Without this, the metadata is frozen on the
        // station name from the initial _updateMediaSession call.
        if (title || artwork) _updateStreamMediaSession(title, artwork);
      }
    } catch {}
  };
  poll();
  _nowPlayingTimer = setInterval(poll, 8000);
}

/**
 * Update navigator.mediaSession.metadata with a fresh "Artist - Song"
 * + per-song artwork while a stream is playing. Splits "Artist - Song"
 * into structured fields so the lockscreen shows them properly stacked,
 * and falls back to the station's own coverUrl when the per-song
 * artwork isn't available.
 */
function _updateStreamMediaSession(title, artwork) {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
  const track = get(currentTrack);
  if (!track || !track.isStream) return;
  const stationName = track.title || '';
  let songTitle = title || stationName;
  let songArtist = '';
  if (title) {
    const dash = title.indexOf(' - ');
    if (dash > 0) {
      songArtist = title.slice(0, dash).trim();
      songTitle  = title.slice(dash + 3).trim();
    }
  }
  const artUrl = artwork || track.coverUrl || '';
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  songTitle,
      artist: songArtist || stationName,
      album:  stationName,
      artwork: artUrl ? [
        { src: artUrl, sizes: '96x96',   type: 'image/jpeg' },
        { src: artUrl, sizes: '192x192', type: 'image/jpeg' },
        { src: artUrl, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });
  } catch {}
}
function _stopNowPlayingPoll() {
  if (_nowPlayingTimer) { clearInterval(_nowPlayingTimer); _nowPlayingTimer = null; }
  streamNowPlaying.set('');
  streamArtwork.set('');
}

// Expose the raw audio element so callers (e.g. the visualizer in Trace)
// can attach a Web Audio AnalyserNode without going through play().
// Returns null if no track has played yet this session.
export function getAudioForAnalyser() { return audio; }

export function moveInQueue(from, to) {
  const qi = get(queueIndex);
  queue.update(q => {
    const c = [...q];
    const [item] = c.splice(from, 1);
    c.splice(to, 0, item);
    return c;
  });
  _resetNextUp();
  if (from === qi) queueIndex.set(to);
  else if (from < qi && to >= qi) queueIndex.update(i => i - 1);
  else if (from > qi && to <= qi) queueIndex.update(i => i + 1);
}
