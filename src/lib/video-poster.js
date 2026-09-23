/**
 * video-poster.js: a still for a <video> that has not been played yet.
 *
 * Android draws its own play glyph, scaled to the element, over a video with
 * no poster and no decoded frame. On a phone that reads as a broken
 * thumbnail: a huge blurry triangle where the lift should be. Giving the
 * element a poster replaces it with the actual first frame.
 *
 * Desktop browsers decode a frame by themselves, so this is belt and braces
 * there, and costs one canvas draw.
 */

/** A JPEG data URL from anything canvas can draw (a playing <video>). */
export function posterFromElement(el) {
  try {
    if (!el?.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.7);
    return url.startsWith('data:image/jpeg') ? url : null;
  } catch { return null; }
}

/**
 * Decode a clip offscreen for the two things we want before uploading it: a
 * still, and how long it runs. Resolves { poster, duration } with nulls
 * rather than throwing, and gives up after `timeoutMs` so a file this
 * browser cannot decode never holds a screen up.
 */
export function probeVideoBlob(blob, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!blob) return resolve({ poster: null, duration: null });
    let url;
    try { url = URL.createObjectURL(blob); } catch { return resolve({ poster: null, duration: null }); }
    const video = document.createElement('video');
    let settled = false;
    const done = (poster) => {
      if (settled) return;
      settled = true;
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration) : null;
      try { URL.revokeObjectURL(url); } catch {}
      resolve({ poster, duration });
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    // Seek a little way in: frame zero of a clip is often the camera still
    // settling, and some encoders start on a black frame.
    video.addEventListener('loadeddata', () => {
      try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); } catch { done(null); }
    });
    video.addEventListener('seeked', () => done(posterFromElement(video)));
    video.addEventListener('error', () => done(null));
    setTimeout(() => done(null), timeoutMs);
  });
}

/** Just the still, for callers that do not care how long the clip runs. */
export function posterFromBlob(blob, opts) {
  return probeVideoBlob(blob, opts).then(r => r.poster);
}
