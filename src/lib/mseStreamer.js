/**
 * MediaSource-based audio streamer.
 *
 * Keeps a single <audio> element continuously playing by appending each
 * track's audio data into one SourceBuffer. The element never pauses
 * between tracks, so Chrome's "playing audio" tab exemption stays
 * active — background audio survives the track boundary.
 *
 * Requirements:
 *   - Browser supports MediaSource + 'audio/mpeg'
 *   - Server can serve each track as MP3 (we use Jellyfin's transcode URL)
 *
 * Graceful fallback: if MSE init fails at any point, consumers can
 * detect via `isReady()` returning false and fall back to direct
 * `audio.src =` usage.
 */

const DEFAULT_MIME = 'audio/mpeg';

/** Map a Jellyfin `container` to a MediaSource MIME type (if supported). */
export function mimeForContainer(container) {
  switch ((container || '').toLowerCase()) {
    case 'mp3':           return 'audio/mpeg';
    case 'flac':          return 'audio/flac';
    case 'm4a':
    case 'mp4':
    case 'aac':           return 'audio/mp4; codecs="mp4a.40.2"';
    case 'ogg':
    case 'oga':           return 'audio/ogg; codecs="vorbis"';
    case 'opus':
    case 'webm':          return 'audio/webm; codecs="opus"';
    default:              return null;
  }
}

export function isTypeSupported(mime) {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
}

function isSupported() {
  return isTypeSupported(DEFAULT_MIME);
}

/**
 * Create an MSE streamer.
 * @param {object} [opts]
 * @param {string} [opts.mime]      MIME type for the SourceBuffer (default `audio/mpeg`)
 * @param {boolean} [opts.raw]      If true, appendTrack fetches `streamUrl` instead
 *                                   of `transcodeUrl` — for "keep original format" mode.
 */
export function createMseStreamer(opts = {}) {
  const mime = opts.mime || DEFAULT_MIME;
  const useRaw = !!opts.raw;
  if (!isTypeSupported(mime)) return null;

  const state = {
    audio: null,
    mediaSource: null,
    sourceBuffer: null,
    sourceOpenPromise: null,
    // Each entry: { id, startTime, duration, track }
    tracks: [],
    // Where the next appended track will begin, in audio-element seconds
    cumulativeOffset: 0,
    // Pending serialized append operations
    queue: Promise.resolve(),
    destroyed: false,
    onTrackAdvance: null, // called with the new track when playback crosses its start
    // Last track index we fired advance for
    lastAnnouncedIndex: -1,
    // For timeupdate listener cleanup
    timeUpdateHandler: null,
  };

  /** Attach the streamer to an <audio> element and start a MediaSource on it. */
  function attach(audioEl) {
    if (state.destroyed) return Promise.reject(new Error('streamer destroyed'));
    state.audio = audioEl;
    state.mediaSource = new MediaSource();
    audioEl.src = URL.createObjectURL(state.mediaSource);

    state.sourceOpenPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        try {
          state.sourceBuffer = state.mediaSource.addSourceBuffer(mime);
          state.sourceBuffer.mode = 'sequence';
          resolve();
        } catch (e) { reject(e); }
      };
      state.mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      state.mediaSource.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
    });

    // Track advance detection — when currentTime crosses a new track's start time
    state.timeUpdateHandler = () => _checkTrackAdvance();
    audioEl.addEventListener('timeupdate', state.timeUpdateHandler);

    return state.sourceOpenPromise;
  }

  function _checkTrackAdvance() {
    if (!state.audio || state.tracks.length === 0) return;
    const t = state.audio.currentTime;
    // Find which track contains currentTime
    let idx = -1;
    for (let i = state.tracks.length - 1; i >= 0; i--) {
      if (t >= state.tracks[i].startTime) { idx = i; break; }
    }
    if (idx >= 0 && idx !== state.lastAnnouncedIndex) {
      state.lastAnnouncedIndex = idx;
      if (state.onTrackAdvance) {
        try { state.onTrackAdvance(state.tracks[idx].track, idx); } catch {}
      }
    }
  }

  function _awaitUpdateEnd() {
    if (!state.sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve) => {
      state.sourceBuffer.addEventListener('updateend', resolve, { once: true });
    });
  }

  /** Append a track's MP3 data to the buffer. Serialized via state.queue.
   *  If the track is already in the buffer, returns the existing entry
   *  without re-appending (idempotent). */
  function appendTrack(track) {
    const op = async () => {
      if (state.destroyed) return null;
      // Idempotent: if already appended, return existing
      const existing = state.tracks.find(t => t.id === track.id);
      if (existing) return existing;

      await state.sourceOpenPromise;
      if (!state.sourceBuffer || state.mediaSource.readyState !== 'open') {
        throw new Error('MediaSource not open');
      }
      // Prefer the codec the MSE source-buffer was created for. If we're in
      // transcode mode and the track only exposes a raw streamUrl whose
      // codec doesn't match our MIME, append will fail downstream \u2014 surface
      // the mismatch clearly instead of getting a cryptic decode error.
      const url = useRaw
        ? (track.streamUrl || track.transcodeUrl)
        : (track.transcodeUrl || track.streamUrl);
      if (!url) throw new Error(`no stream URL for ${track.title || track.id}`);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = await res.arrayBuffer();

      await _awaitUpdateEnd();
      state.sourceBuffer.timestampOffset = state.cumulativeOffset;
      state.sourceBuffer.appendBuffer(buf);
      await _awaitUpdateEnd();

      const buffered = state.sourceBuffer.buffered;
      const end = buffered.length > 0 ? buffered.end(buffered.length - 1) : state.cumulativeOffset;
      const entry = {
        id: track.id,
        track,
        startTime: state.cumulativeOffset,
        duration: end - state.cumulativeOffset,
      };
      state.cumulativeOffset = end;
      state.tracks.push(entry);
      return entry;
    };
    state.queue = state.queue.then(op, op);
    return state.queue;
  }

  /** Clear all buffer data and reset offsets. Used on skip/stop. */
  async function reset() {
    if (!state.sourceBuffer || state.mediaSource.readyState !== 'open') return;
    await _awaitUpdateEnd();
    const buffered = state.sourceBuffer.buffered;
    if (buffered.length > 0) {
      state.sourceBuffer.remove(0, buffered.end(buffered.length - 1));
      await _awaitUpdateEnd();
    }
    state.tracks = [];
    state.cumulativeOffset = 0;
    state.lastAnnouncedIndex = -1;
  }

  /** Seek within the current buffer. Seconds are cumulative across tracks. */
  function seekInCurrentTrack(fraction) {
    if (!state.audio || state.tracks.length === 0) return;
    const cur = _currentTrackEntry();
    if (!cur) return;
    state.audio.currentTime = cur.startTime + fraction * cur.duration;
  }

  function _currentTrackEntry() {
    if (!state.audio || state.tracks.length === 0) return null;
    const t = state.audio.currentTime;
    for (let i = state.tracks.length - 1; i >= 0; i--) {
      if (t >= state.tracks[i].startTime) return state.tracks[i];
    }
    return state.tracks[0];
  }

  function getCurrentTrackEntry() { return _currentTrackEntry(); }
  function getTrackEntryById(id) {
    return state.tracks.find(t => t.id === id) || null;
  }
  function getTrackEntries() { return state.tracks.slice(); }
  function getBufferedDuration() { return state.cumulativeOffset; }
  function isReady() { return !state.destroyed && !!state.sourceBuffer; }

  function setOnTrackAdvance(fn) { state.onTrackAdvance = fn; }

  function destroy() {
    state.destroyed = true;
    if (state.audio && state.timeUpdateHandler) {
      state.audio.removeEventListener('timeupdate', state.timeUpdateHandler);
    }
    try {
      if (state.mediaSource && state.mediaSource.readyState === 'open') {
        state.mediaSource.endOfStream();
      }
    } catch {}
    state.audio = null;
    state.mediaSource = null;
    state.sourceBuffer = null;
    state.tracks = [];
  }

  return {
    attach, appendTrack, reset, seekInCurrentTrack, getCurrentTrackEntry,
    getTrackEntryById, getTrackEntries,
    getBufferedDuration, isReady, setOnTrackAdvance, destroy,
  };
}

export { isSupported };
