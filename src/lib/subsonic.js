import { DB } from './db.js';
import md5 from './md5.js';

/**
 * Subsonic API client. All calls go through the server proxy at
 * /api/subsonic/* to avoid CORS and hide credentials from the browser.
 */

const APP_NAME = 'LiftTrace';
const API_VERSION = '1.16.1';

function _getConfig() {
  return {
    url:      DB.getSetting('radioUrl', ''),
    user:     DB.getSetting('radioUser', ''),
    password: DB.getSetting('radioPassword', ''),
  };
}

function _buildParams(extra = {}) {
  const cfg = _getConfig();
  const salt = Math.random().toString(36).slice(2, 10);
  const token = md5(cfg.password + salt);
  return new URLSearchParams({
    u: cfg.user,
    t: token,
    s: salt,
    v: API_VERSION,
    c: APP_NAME,
    f: 'json',
    ...extra,
  });
}

async function _call(method, params = {}) {
  const qs = _buildParams(params);
  const res = await fetch(`/api/subsonic/rest/${method}?${qs}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Subsonic ${method} failed: ${res.status}`);
  const data = await res.json();
  const root = data['subsonic-response'];
  if (!root || root.status !== 'ok') {
    throw new Error(root?.error?.message || `Subsonic error: ${method}`);
  }
  return root;
}

export function getCoverArtUrl(id, size = 300) {
  if (!id) return null;
  const qs = _buildParams({ id, size: String(size) });
  return `/api/subsonic/rest/getCoverArt?${qs}`;
}

export function getStreamUrl(id) {
  const qs = _buildParams({ id });
  return `/api/subsonic/rest/stream?${qs}`;
}

// ── API methods ──────────────────────────────────────────────────────────────

export async function ping() {
  await _call('ping');
  return true;
}

export async function getArtists() {
  const data = await _call('getArtists');
  return data.artists?.index || [];
}

export async function getArtist(id) {
  const data = await _call('getArtist', { id });
  return data.artist || {};
}

export async function getAlbum(id) {
  const data = await _call('getAlbum', { id });
  return data.album || {};
}

export async function getAlbumList(type = 'random', size = 30, offset = 0) {
  const data = await _call('getAlbumList2', { type, size: String(size), offset: String(offset) });
  return data.albumList2?.album || [];
}

export async function search(query, artistCount = 10, albumCount = 10, songCount = 20) {
  const data = await _call('search3', {
    query,
    artistCount: String(artistCount),
    albumCount: String(albumCount),
    songCount: String(songCount),
  });
  return {
    artists: data.searchResult3?.artist || [],
    albums: data.searchResult3?.album || [],
    songs: data.searchResult3?.song || [],
  };
}

export async function getPlaylists() {
  const data = await _call('getPlaylists');
  return data.playlists?.playlist || [];
}

export async function getPlaylist(id) {
  const data = await _call('getPlaylist', { id });
  return data.playlist || {};
}

export async function getRandomSongs(size = 50) {
  const data = await _call('getRandomSongs', { size: String(size) });
  return data.randomSongs?.song || [];
}

// Starred / Favorites — Subsonic stores per-user starred state on tracks,
// albums, and artists. getStarred2 returns all three lists in one call.
export async function getStarred() {
  const data = await _call('getStarred2');
  return {
    songs: data.starred2?.song || [],
    albums: data.starred2?.album || [],
    artists: data.starred2?.artist || [],
  };
}
// star/unstar accept id (song), albumId, artistId — pass exactly one. The
// server treats the call as idempotent so calling star on an already-
// starred item is a no-op (and likewise for unstar).
export async function star({ id, albumId, artistId } = {}) {
  const params = {};
  if (id) params.id = id;
  if (albumId) params.albumId = albumId;
  if (artistId) params.artistId = artistId;
  await _call('star', params);
}
export async function unstar({ id, albumId, artistId } = {}) {
  const params = {};
  if (id) params.id = id;
  if (albumId) params.albumId = albumId;
  if (artistId) params.artistId = artistId;
  await _call('unstar', params);
}

/** Convert a Subsonic song object to our track format */
export function songToTrack(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist || 'Unknown',
    album: song.album || '',
    albumId: song.albumId || song.parent,
    duration: song.duration || 0,
    coverUrl: getCoverArtUrl(song.coverArt || song.albumId),
    streamUrl: getStreamUrl(song.id),
  };
}
