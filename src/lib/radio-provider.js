import { DB } from './db.js';
import * as subsonic from './subsonic.js';

/**
 * Unified radio provider interface. Each provider implements:
 *   ping(), getArtists(), getArtist(id), getAlbum(id), getAlbumList(type, size),
 *   search(query), getPlaylists(), getPlaylist(id), getRandomSongs(size),
 *   getCoverArtUrl(id, size), getStreamUrl(id), songToTrack(song)
 */

export function getProvider() {
  return DB.getSetting('radioProvider', 'subsonic');
}

// ── Proxy helpers ────────────────────────────────────────────────────────────
async function _proxyGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/subsonic/provider${path}${qs ? '?' + qs : ''}`, { credentials: 'include' });
  if (!res.ok) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const data = await res.json();
      throw new Error(data.error || `API error ${res.status}`);
    }
    throw new Error(`API error ${res.status}`);
  }
  return res;
}

async function _proxyJson(path, params = {}) {
  const res = await _proxyGet(path, params);
  return res.json();
}

// ── Jellyfin ─────────────────────────────────────────────────────────────────
const jellyfin = {
  async ping() {
    await _proxyJson('/jf/System/Info/Public');
    return true;
  },
  async getArtists() {
    // Try /Artists/AlbumArtists first (more reliable — returns only artists
    // with albums, which is what we want for a music library UI).
    // Fall back to /Artists if the former fails.
    let data;
    try {
      data = await _proxyJson('/jf/Artists/AlbumArtists', {
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Recursive: 'true',
      });
    } catch (e) {
      data = await _proxyJson('/jf/Artists', {
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Recursive: 'true',
      });
    }
    const map = {};
    for (const item of data.Items || []) {
      const letter = (item.Name || '?')[0].toUpperCase();
      if (!map[letter]) map[letter] = { name: letter, artist: [] };
      map[letter].artist.push({ id: item.Id, name: item.Name, albumCount: item.AlbumCount || 0 });
    }
    return Object.values(map);
  },
  async getArtist(id) {
    const data = await _proxyJson(`/jf/Items`, { ParentId: id, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear', SortOrder: 'Descending', Recursive: 'true' });
    return { id, name: '', album: (data.Items || []).map(a => ({ id: a.Id, name: a.Name, artist: a.AlbumArtist || a.Artist, year: a.ProductionYear, coverArt: a.Id })) };
  },
  async getAlbum(id) {
    const album = await _proxyJson(`/jf/Items/${id}`);
    const songs = await _proxyJson(`/jf/Items`, { ParentId: id, IncludeItemTypes: 'Audio', SortBy: 'IndexNumber', SortOrder: 'Ascending' });
    return {
      id, name: album.Name, artist: album.AlbumArtist || album.Artist, coverArt: id,
      songCount: (songs.Items || []).length,
      song: (songs.Items || []).map(s => ({ id: s.Id, title: s.Name, artist: s.AlbumArtist || s.Artists?.[0] || '', album: album.Name, albumId: id, duration: Math.round((s.RunTimeTicks || 0) / 10000000), coverArt: id, container: (s.Container || '').toLowerCase() })),
    };
  },
  async getAlbumList(type = 'random', size = 30) {
    const sortMap = { random: 'Random', recent: 'DateCreated', frequent: 'PlayCount', newest: 'ProductionYear' };
    const data = await _proxyJson('/jf/Items', { IncludeItemTypes: 'MusicAlbum', SortBy: sortMap[type] || 'Random', SortOrder: 'Descending', Limit: String(size), Recursive: 'true' });
    return (data.Items || []).map(a => ({ id: a.Id, name: a.Name, artist: a.AlbumArtist || '', coverArt: a.Id }));
  },
  async search(query) {
    const data = await _proxyJson('/jf/Items', { searchTerm: query, Recursive: 'true', Limit: '30', IncludeItemTypes: 'MusicArtist,MusicAlbum,Audio' });
    const items = data.Items || [];
    return {
      artists: items.filter(i => i.Type === 'MusicArtist').map(a => ({ id: a.Id, name: a.Name })),
      albums: items.filter(i => i.Type === 'MusicAlbum').map(a => ({ id: a.Id, name: a.Name, artist: a.AlbumArtist || '', coverArt: a.Id })),
      songs: items.filter(i => i.Type === 'Audio').map(s => ({ id: s.Id, title: s.Name, artist: s.AlbumArtist || '', album: s.Album || '', albumId: s.AlbumId, duration: Math.round((s.RunTimeTicks || 0) / 10000000), coverArt: s.AlbumId || s.Id, container: (s.Container || '').toLowerCase() })),
    };
  },
  async getPlaylists() {
    const data = await _proxyJson('/jf/Items', { IncludeItemTypes: 'Playlist', Recursive: 'true' });
    return (data.Items || []).map(p => ({ id: p.Id, name: p.Name, songCount: p.ChildCount || 0 }));
  },
  async getPlaylist(id) {
    const data = await _proxyJson('/jf/Items', { ParentId: id, IncludeItemTypes: 'Audio' });
    return { id, name: '', entry: (data.Items || []).map(s => ({ id: s.Id, title: s.Name, artist: s.AlbumArtist || '', album: s.Album || '', albumId: s.AlbumId, duration: Math.round((s.RunTimeTicks || 0) / 10000000), coverArt: s.AlbumId || s.Id, container: (s.Container || '').toLowerCase() })) };
  },
  async getRandomSongs(size = 50) {
    const data = await _proxyJson('/jf/Items', { IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: String(size), Recursive: 'true' });
    return (data.Items || []).map(s => ({ id: s.Id, title: s.Name, artist: s.AlbumArtist || '', album: s.Album || '', albumId: s.AlbumId, duration: Math.round((s.RunTimeTicks || 0) / 10000000), coverArt: s.AlbumId || s.Id, container: (s.Container || '').toLowerCase() }));
  },
  getCoverArtUrl(id, size = 300) {
    if (!id) return null;
    return `/api/subsonic/provider/jf/Items/${id}/Images/Primary?maxWidth=${size}&maxHeight=${size}`;
  },
  getStreamUrl(id) {
    return `/api/subsonic/provider/jf/Audio/${id}/stream?static=true`;
  },
  getTranscodeUrl(id) {
    return `/api/subsonic/provider/jf/Audio/${id}/universal?Container=opus,webm,mp3|mp3,aac,m4a|aac,flac&TranscodingContainer=mp3&TranscodingProtocol=http&AudioCodec=mp3&MaxStreamingBitrate=320000`;
  },
  songToTrack(song) {
    return { id: song.id, title: song.title, artist: song.artist || 'Unknown', album: song.album || '', albumId: song.albumId, duration: song.duration || 0, container: song.container || '', coverUrl: jellyfin.getCoverArtUrl(song.coverArt || song.albumId), streamUrl: jellyfin.getStreamUrl(song.id), transcodeUrl: jellyfin.getTranscodeUrl(song.id) };
  },
};

// ── Plex ──────────────────────────────────────────────────────────────────────
const plex = {
  async ping() {
    await _proxyJson('/plex/');
    return true;
  },
  async getArtists() {
    const data = await _proxyJson('/plex/library/sections');
    // Find music library section
    const musicSection = (data.MediaContainer?.Directory || []).find(d => d.type === 'artist');
    if (!musicSection) return [];
    const artists = await _proxyJson(`/plex/library/sections/${musicSection.key}/all`);
    const map = {};
    for (const a of artists.MediaContainer?.Metadata || []) {
      const letter = (a.title || '?')[0].toUpperCase();
      if (!map[letter]) map[letter] = { name: letter, artist: [] };
      map[letter].artist.push({ id: a.ratingKey, name: a.title });
    }
    return Object.values(map);
  },
  async getArtist(id) {
    const data = await _proxyJson(`/plex/library/metadata/${id}/children`);
    return { id, name: '', album: (data.MediaContainer?.Metadata || []).map(a => ({ id: a.ratingKey, name: a.title, artist: a.parentTitle || '', year: a.year, coverArt: a.ratingKey })) };
  },
  async getAlbum(id) {
    const meta = await _proxyJson(`/plex/library/metadata/${id}`);
    const album = meta.MediaContainer?.Metadata?.[0] || {};
    const tracks = await _proxyJson(`/plex/library/metadata/${id}/children`);
    return {
      id, name: album.title, artist: album.parentTitle || '', coverArt: id,
      songCount: (tracks.MediaContainer?.Metadata || []).length,
      song: (tracks.MediaContainer?.Metadata || []).map(s => ({ id: s.ratingKey, title: s.title, artist: s.grandparentTitle || s.originalTitle || '', album: album.title, albumId: id, duration: Math.round((s.duration || 0) / 1000), coverArt: id })),
    };
  },
  async getAlbumList(type = 'random', size = 30) {
    const data = await _proxyJson('/plex/library/sections');
    const musicSection = (data.MediaContainer?.Directory || []).find(d => d.type === 'artist');
    if (!musicSection) return [];
    const sortMap = { random: 'random', recent: 'addedAt:desc', newest: 'year:desc' };
    const albums = await _proxyJson(`/plex/library/sections/${musicSection.key}/albums`, { sort: sortMap[type] || 'random', 'X-Plex-Container-Size': String(size) });
    return (albums.MediaContainer?.Metadata || []).map(a => ({ id: a.ratingKey, name: a.title, artist: a.parentTitle || '', coverArt: a.ratingKey }));
  },
  async search(query) {
    const data = await _proxyJson('/plex/hubs/search', { query, limit: '20' });
    const hubs = data.MediaContainer?.Hub || [];
    return {
      artists: (hubs.find(h => h.type === 'artist')?.Metadata || []).map(a => ({ id: a.ratingKey, name: a.title })),
      albums: (hubs.find(h => h.type === 'album')?.Metadata || []).map(a => ({ id: a.ratingKey, name: a.title, artist: a.parentTitle || '', coverArt: a.ratingKey })),
      songs: (hubs.find(h => h.type === 'track')?.Metadata || []).map(s => ({ id: s.ratingKey, title: s.title, artist: s.grandparentTitle || '', album: s.parentTitle || '', albumId: s.parentRatingKey, duration: Math.round((s.duration || 0) / 1000), coverArt: s.parentRatingKey })),
    };
  },
  async getPlaylists() {
    const data = await _proxyJson('/plex/playlists', { playlistType: 'audio' });
    return (data.MediaContainer?.Metadata || []).map(p => ({ id: p.ratingKey, name: p.title, songCount: p.leafCount || 0 }));
  },
  async getPlaylist(id) {
    const data = await _proxyJson(`/plex/playlists/${id}/items`);
    return { id, name: '', entry: (data.MediaContainer?.Metadata || []).map(s => ({ id: s.ratingKey, title: s.title, artist: s.grandparentTitle || '', album: s.parentTitle || '', albumId: s.parentRatingKey, duration: Math.round((s.duration || 0) / 1000), coverArt: s.parentRatingKey })) };
  },
  async getRandomSongs(size = 50) {
    const data = await _proxyJson('/plex/library/sections');
    const musicSection = (data.MediaContainer?.Directory || []).find(d => d.type === 'artist');
    if (!musicSection) return [];
    const tracks = await _proxyJson(`/plex/library/sections/${musicSection.key}/all`, { type: '10', sort: 'random', 'X-Plex-Container-Size': String(size) });
    return (tracks.MediaContainer?.Metadata || []).map(s => ({ id: s.ratingKey, title: s.title, artist: s.grandparentTitle || '', album: s.parentTitle || '', albumId: s.parentRatingKey, duration: Math.round((s.duration || 0) / 1000), coverArt: s.parentRatingKey }));
  },
  getCoverArtUrl(id, size = 300) {
    if (!id) return null;
    return `/api/subsonic/provider/plex/library/metadata/${id}/thumb?width=${size}&height=${size}`;
  },
  getStreamUrl(id) {
    // Plex direct stream — serves the original file
    return `/api/subsonic/provider/plex/library/parts/${id}/file`;
  },
  getTranscodeUrl(id) {
    return `/api/subsonic/provider/plex/audio/:/transcode/universal/start?path=/library/metadata/${id}&mediaIndex=0&partIndex=0&protocol=http`;
  },
  songToTrack(song) {
    return { id: song.id, title: song.title, artist: song.artist || 'Unknown', album: song.album || '', albumId: song.albumId, duration: song.duration || 0, coverUrl: plex.getCoverArtUrl(song.coverArt || song.albumId), streamUrl: plex.getStreamUrl(song.id), transcodeUrl: plex.getTranscodeUrl(song.id) };
  },
};

// ── Emby ──────────────────────────────────────────────────────────────────────
// Emby API is nearly identical to Jellyfin (forked from it)
const emby = {
  ...jellyfin,
  getCoverArtUrl(id, size = 300) {
    if (!id) return null;
    return `/api/subsonic/provider/emby/Items/${id}/Images/Primary?maxWidth=${size}&maxHeight=${size}`;
  },
  getStreamUrl(id) {
    return `/api/subsonic/provider/emby/Audio/${id}/stream?static=true`;
  },
  getTranscodeUrl(id) {
    return `/api/subsonic/provider/emby/Audio/${id}/universal?Container=opus,webm,mp3|mp3,aac,m4a|aac,flac&TranscodingContainer=mp3&TranscodingProtocol=http&AudioCodec=mp3&MaxStreamingBitrate=320000`;
  },
  songToTrack(song) {
    return { id: song.id, title: song.title, artist: song.artist || 'Unknown', album: song.album || '', albumId: song.albumId, duration: song.duration || 0, coverUrl: emby.getCoverArtUrl(song.coverArt || song.albumId), streamUrl: emby.getStreamUrl(song.id), transcodeUrl: emby.getTranscodeUrl(song.id) };
  },
  // Override paths to use /emby/ prefix
  async ping() { await _proxyJson('/emby/System/Info/Public'); return true; },
  async getArtists() { return jellyfin.getArtists.call({ ...jellyfin, _prefix: '/emby' }); },
};
// NOTE: library-browsing methods delegate to jellyfin.* and consequently
// hit the /jf/* proxy route. This works today because Emby is a Jellyfin
// fork with a compatible API and both use X-Emby-Token auth — the
// `/jf/*` proxy transparently forwards to whichever URL the user configured
// (which, in Emby mode, is their Emby server). If the two ever diverge,
// duplicate jellyfin's methods into this object with /emby/ prefixes.
for (const method of ['getArtists', 'getArtist', 'getAlbum', 'getAlbumList', 'search', 'getPlaylists', 'getPlaylist', 'getRandomSongs']) {
  const orig = jellyfin[method];
  emby[method] = async function(...args) { return orig.apply(jellyfin, args); };
}

// ── Provider registry ────────────────────────────────────────────────────────
const PROVIDERS = { subsonic, jellyfin, plex, emby };

export function getClient() {
  const provider = getProvider();
  if (provider === 'subsonic') return subsonic;
  return PROVIDERS[provider] || subsonic;
}

// Re-export unified API
export async function ping() { return getClient().ping(); }
export async function getArtists() { return getClient().getArtists(); }
export async function getArtist(id) { return getClient().getArtist(id); }
export async function getAlbum(id) { return getClient().getAlbum(id); }
export async function getAlbumList(type, size) { return getClient().getAlbumList(type, size); }
export async function search(query) { return getClient().search(query); }
export async function getPlaylists() { return getClient().getPlaylists(); }
export async function getPlaylist(id) { return getClient().getPlaylist(id); }
export async function getRandomSongs(size) { return getClient().getRandomSongs(size); }
// Starred / Favorites — only Subsonic supports a uniform getStarred2 today.
// Other providers fall back to empty/no-op so the UI can render the tab
// generically and individual stars degrade gracefully.
export async function getStarred() {
  return getClient().getStarred?.() ?? { songs: [], albums: [], artists: [] };
}
export async function star(args) { return getClient().star?.(args); }
export async function unstar(args) { return getClient().unstar?.(args); }
export function supportsStarred() { return typeof getClient().getStarred === 'function'; }
export function getCoverArtUrl(id, size) { return getClient().getCoverArtUrl(id, size); }
export function getStreamUrl(id) { return getClient().getStreamUrl(id); }
export function songToTrack(song) { return getClient().songToTrack(song); }
