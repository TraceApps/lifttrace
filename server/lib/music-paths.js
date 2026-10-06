// Paths the music proxy forwards to a Jellyfin, Emby or Plex server.

// Only the parts of each server's API the app uses, so a music-server
// address can't be used to read anything else on that host.
const API_ROOTS = {
  jf:   new Set(['users', 'system', 'artists', 'items', 'audio']),
  emby: new Set(['users', 'system', 'artists', 'items', 'audio']),
  plex: new Set(['identity', 'library', 'hubs', 'playlists', 'audio']),
  // Subsonic: any method, always under /rest/ (the route adds it).
  subsonic: null,
};
export function musicApiPath(provider, splat) {
  // Express decodes each segment, so one can hold a "/" (from %2F), and a
  // URL also reads "\\" as "/" and %2e as ".": split on both and refuse any
  // "." or ".." so the path can't climb out of the allowed part.
  const raw = (Array.isArray(splat) ? splat : [String(splat ?? '')]).map(String);
  // URL parsing drops tabs and line breaks (".\t." would become ".."), so
  // no control characters at all.
  if (/[\u0000-\u001f\u007f]/.test(raw.join('/'))) return null;
  const parts = raw.join('/').split(/[\\/]/);
  // No empty segment either: servers read "//" as "/", which would let
  // the path start anywhere.
  if (parts.some(p => p === '' || /^(\.|%2e){1,2}$/i.test(p))) return null;
  const roots = API_ROOTS[provider];
  if (roots && !roots.has(String(parts[0] || '').toLowerCase())) return null;
  // Segments go through as the app sent them (Plex's "/audio/:/transcode"
  // needs its ":"), except "?" and "#", which would end the path.
  return parts.map(p => p.replace(/\?/g, '%3F').replace(/#/g, '%23')).join('/');
}

/**
 * Whether a music server's reply is one the app reads: JSON, XML (Subsonic,
 * Plex), audio, an image, or a playlist. A web page or anything else is
 * never passed back, whatever path an address leads to.
 */
export function isMusicReply(contentType) {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!t) return false;
  return t === 'application/json' || t.endsWith('+json') || t === 'application/xml' || t === 'text/xml' || t.endsWith('+xml')
    || t.startsWith('audio/') || t.startsWith('image/') || t.startsWith('video/')
    || t === 'application/octet-stream' || t === 'application/ogg'
    || t === 'application/vnd.apple.mpegurl' || t === 'application/x-mpegurl';
}
