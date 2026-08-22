<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { radioEnabled, radioUrl, radioStations, radioStationsEnabled } from '../stores/settings.js';
  import { isNative, getServerUrl, resolveAssetUrl } from '../lib/platform.js';
  import {
    playTrack, addToQueue, playNext,
    currentTrack, streamNowPlaying, streamArtwork,
    isPlaying, togglePlay, next as playerNext, prev as playerPrev,
    queue, queueIndex, removeFromQueue,
  } from '../stores/player.js';
  import { showSuccess } from '../stores/toast.js';
  import { showError } from '../stores/toast.js';
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import Dialog from '../components/ui/Dialog.svelte';
  import * as sub from '../lib/radio-provider.js';
  import { confirmDialog } from '../stores/confirmDialog.js';

  // Module-level cache that survives the {#key $location} route remount.
  // sessionStorage already preserves which tab the user was on, but the
  // fetched library data (albums / artists / playlists / search results)
  // was component-local state and got dropped on every nav. That's why
  // returning to the Radio tab while a station was playing showed a blank
  // grid + "Loading…" until Jellyfin responded again. Cache survives in
  // memory until the WebView itself is killed.
  const _LIB_CACHE = (typeof window !== 'undefined' && (window.__LT_RADIO_CACHE ||= {})) || {};
  if (!_LIB_CACHE.albums)   _LIB_CACHE.albums   = null;
  if (!_LIB_CACHE.artists)  _LIB_CACHE.artists  = null;
  if (!_LIB_CACHE.playlists) _LIB_CACHE.playlists = null;

  // Read saved view state SYNCHRONOUSLY at script init so the initial
  // values of tab/stationsSubTab/search already match what we persisted.
  // Doing this in onMount instead caused a race: the `$:` reactive that
  // calls _saveRadioState() runs once on initial values BEFORE onMount,
  // overwriting the saved state with the default 'albums' before the
  // restore could read it. (Reproduced as: play a station, leave Radio,
  // come back → tab snapped back to Artists/Albums.)
  const RADIO_STATE_KEY = 'lt:radio:state';
  const _savedRadio = (() => {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(RADIO_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();

  // Default to 'stations' if self-hosted music isn't on; library tabs are
  // useless without a connected music server.
  let tab = _savedRadio?.tab
    || (($radioEnabled && $radioUrl) ? 'albums' : 'stations');   // 'albums' | 'artists' | 'playlists' | 'stations' | 'search'

  // ── Streaming stations ──────────────────────────────────────────────────
  let showStationDialog = false;
  let stationEdit = null;   // null = adding, otherwise the station being edited
  let stationName = '';
  let stationUrl = '';
  let stationGenre = '';
  let stationIcon = '';
  let stationGroup = '';
  let stationHomepage = '';

  // Group stations by their `group` field, preserving array order within
  // each group and the order in which groups first appear. Ungrouped
  // stations go last under an empty-string key.
  $: groupedStations = (() => {
    const groups = new Map();
    for (const s of ($radioStations || [])) {
      const g = (s.group || '').trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    // Sort: named groups first (insertion order), then ungrouped
    const entries = [...groups.entries()];
    entries.sort((a, b) => {
      if (a[0] === '' && b[0] !== '') return 1;
      if (a[0] !== '' && b[0] === '') return -1;
      return 0;
    });
    return entries;
  })();
  $: existingGroups = [...new Set(($radioStations || []).map(s => (s.group || '').trim()).filter(Boolean))];
  // Set of URLs already saved — used to mark Browse results as "Added" so
  // the user doesn't accidentally add the same station twice.
  $: existingStationUrls = new Set(($radioStations || []).map(s => (s.url || '').trim()).filter(Boolean));

  function openAddStation() {
    stationEdit = null;
    stationName = ''; stationUrl = ''; stationGenre = ''; stationIcon = ''; stationGroup = ''; stationHomepage = '';
    showStationDialog = true;
  }
  function openEditStation(s) {
    stationEdit = s;
    stationName = s.name || '';
    stationUrl = s.url || '';
    stationGenre = s.genre || '';
    stationIcon = s.iconUrl || '';
    stationGroup = s.group || '';
    stationHomepage = s.homepage || '';
    showStationDialog = true;
  }
  function saveStation() {
    const name = stationName.trim();
    const url = stationUrl.trim();
    if (!name || !url) { showError($_('radio.toast.name_url_required')); return; }
    const record = {
      id: stationEdit?.id || `station:${Date.now()}`,
      name, url,
      genre: stationGenre.trim() || '',
      iconUrl: stationIcon.trim() || '',
      group: stationGroup.trim() || '',
      homepage: stationHomepage.trim() || '',
    };
    const list = [...($radioStations || [])];
    if (stationEdit) {
      const i = list.findIndex(s => s.id === stationEdit.id);
      if (i >= 0) list[i] = record; else list.push(record);
    } else {
      list.push(record);
    }
    $radioStations = list;
    showStationDialog = false;
    showSuccess(stationEdit ? $_('radio.toast.station_updated') : $_('radio.toast.station_added'));
  }

  // Move a station up/down within its group (swaps with the nearest
  // same-group neighbour in the flat array).
  function moveStation(s, dir) {
    const list = [...($radioStations || [])];
    const idx = list.findIndex(x => x.id === s.id);
    if (idx < 0) return;
    const g = (s.group || '').trim();
    const step = dir === 'up' ? -1 : 1;
    let j = idx + step;
    while (j >= 0 && j < list.length && (list[j].group || '').trim() !== g) j += step;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    $radioStations = list;
  }
  function canMove(s, dir) {
    const list = $radioStations || [];
    const idx = list.findIndex(x => x.id === s.id);
    if (idx < 0) return false;
    const g = (s.group || '').trim();
    const step = dir === 'up' ? -1 : 1;
    for (let j = idx + step; j >= 0 && j < list.length; j += step) {
      if ((list[j].group || '').trim() === g) return true;
    }
    return false;
  }

  // Rename-group dialog state
  let showRenameGroup = false;
  let renameGroupOld = '';
  let renameGroupNew = '';
  function openRenameGroup(g) {
    renameGroupOld = g;
    renameGroupNew = g;
    showRenameGroup = true;
  }
  function saveRenameGroup() {
    const next = renameGroupNew.trim();
    if (next === renameGroupOld.trim()) { showRenameGroup = false; return; }
    const list = ($radioStations || []).map(s => {
      const cur = (s.group || '').trim();
      return cur === renameGroupOld.trim() ? { ...s, group: next } : s;
    });
    $radioStations = list;
    showRenameGroup = false;
    showSuccess(next ? $_('radio.toast.renamed_to', { values: { name: next } }) : $_('radio.toast.moved_ungrouped'));
  }

  // ── Stations sub-tab (My vs Browse) ─────────────────────────────────────
  let stationsSubTab = _savedRadio?.stationsSubTab || 'my';  // 'my' | 'browse'

  // ── Collapsible groups (persisted to localStorage) ──────────────────────
  const COLLAPSE_KEY = 'lt:collapsedStationGroups';
  let collapsedGroups = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
    catch { return new Set(); }
  })();
  function groupKey(g) { return (g || '').trim() || '__ungrouped__'; }
  function toggleGroupCollapse(g) {
    const k = groupKey(g);
    if (collapsedGroups.has(k)) collapsedGroups.delete(k);
    else collapsedGroups.add(k);
    collapsedGroups = collapsedGroups;
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
  }
  $: isGroupCollapsed = (g) => collapsedGroups.has(groupKey(g));

  // ── Auto-fill from URL (pulls icy-name / icy-genre) ─────────────────────
  let detectingInfo = false;
  async function autoFillFromUrl() {
    const url = stationUrl.trim();
    if (!url || detectingInfo) return;
    detectingInfo = true;
    try {
      const res = await fetch(`/api/radio-proxy/info?url=${encodeURIComponent(url)}`, { credentials: 'include' });
      if (res.ok) {
        const info = await res.json();
        if (info.name  && !stationName.trim())  stationName  = info.name;
        if (info.genre && !stationGenre.trim()) stationGenre = info.genre;
        if (!info.name && !info.genre) showError($_('radio.toast.no_metadata'));
      } else showError($_('radio.toast.cant_probe'));
    } catch(e) { showError(e.message); }
    detectingInfo = false;
  }

  // ── Icon auto-fetch ─────────────────────────────────────────────────────
  // Prefer homepage (real logos live there) over stream URL (often a CDN).
  let fetchingIcon = false;
  async function autoFetchIcon() {
    const probeUrl = (stationHomepage || '').trim() || (stationUrl || '').trim();
    if (!probeUrl || fetchingIcon) return;
    fetchingIcon = true;
    try {
      const res = await fetch(`/api/radio-proxy/icon-suggest?url=${encodeURIComponent(probeUrl)}`, { credentials: 'include' });
      if (res.ok) {
        const { iconUrl } = await res.json();
        if (iconUrl) stationIcon = iconUrl;
        else showError($_('radio.toast.no_icon'));
      }
    } catch {}
    fetchingIcon = false;
  }

  // ── Drag-and-drop reorder (desktop — cross-group drops change group) ────
  let dragStationId = null;
  let dragOverStationId = null;
  let dragOverGroup = null;
  function onStationDragStart(e, s) {
    dragStationId = s.id;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); } catch {}
  }
  function onStationDragOver(e, s) {
    if (!dragStationId || dragStationId === s.id) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    dragOverStationId = s.id;
    dragOverGroup = null;
  }
  function onGroupDragOver(e, g) {
    if (!dragStationId) return;
    e.preventDefault();
    dragOverGroup = g;
    dragOverStationId = null;
  }
  function onStationDragEnd() { dragStationId = null; dragOverStationId = null; dragOverGroup = null; }
  function onStationDrop(e, targetStation) {
    e.preventDefault();
    if (!dragStationId || dragStationId === targetStation.id) { onStationDragEnd(); return; }
    const list = [...($radioStations || [])];
    const from = list.findIndex(x => x.id === dragStationId);
    const to   = list.findIndex(x => x.id === targetStation.id);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    // Match target's group so cross-group drops move correctly
    moved.group = targetStation.group || '';
    const insertAt = list.findIndex(x => x.id === targetStation.id);
    list.splice(insertAt, 0, moved);
    $radioStations = list;
    onStationDragEnd();
  }
  function onGroupDrop(e, g) {
    e.preventDefault();
    if (!dragStationId) return;
    const list = [...($radioStations || [])];
    const from = list.findIndex(x => x.id === dragStationId);
    if (from < 0) return;
    const [moved] = list.splice(from, 1);
    moved.group = g;
    // Append at the end of that group (last index where group matches, else push)
    let insertAt = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if ((list[i].group || '') === g) { insertAt = i + 1; break; }
    }
    list.splice(insertAt, 0, moved);
    $radioStations = list;
    onStationDragEnd();
  }

  // ── Radio-Browser.info search ───────────────────────────────────────────
  // Public community-run directory of ~40k stations. CORS-enabled, no key.
  let rbQuery = '';
  let rbResults = [];
  let rbSearching = false;
  let rbDebounce = null;
  function rbDebouncedSearch() {
    clearTimeout(rbDebounce);
    rbDebounce = setTimeout(doRadioBrowserSearch, 350);
  }
  async function doRadioBrowserSearch() {
    const q = rbQuery.trim();
    if (!q) { rbResults = []; return; }
    rbSearching = true;
    try {
      const url = `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&limit=30&hidebroken=true&order=clickcount&reverse=true`;
      const res = await fetch(url);
      if (res.ok) rbResults = await res.json();
    } catch(e) { showError($_('radio.toast.rb_search_failed')); rbResults = []; }
    rbSearching = false;
  }
  async function addFromRadioBrowser(r) {
    const record = {
      id: `station:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      name:    r.name || 'Unnamed',
      url:     r.url_resolved || r.url,
      genre:   (r.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2).join(' / '),
      iconUrl: r.favicon || '',
      group:   '',
      homepage: r.homepage || '',
    };
    // The stream URL often points to a CDN (no icon there). Parse the
    // station's own homepage for the largest declared icon instead — this
    // is how we pull proper 180x180+ logos from Radio Deejay, etc.
    if (r.homepage) {
      try {
        const res = await fetch(`/api/radio-proxy/icon-suggest?url=${encodeURIComponent(r.homepage)}`, { credentials: 'include' });
        if (res.ok) {
          const { iconUrl } = await res.json();
          if (iconUrl) record.iconUrl = iconUrl;
        }
      } catch {}
    }
    $radioStations = [...($radioStations || []), record];
    showSuccess($_('radio.toast.added_named', { values: { name: record.name } }));
  }

  // Now-playing: `streamNowPlaying` store is driven globally by player.js.
  async function deleteStation(s) {
    if (!await confirmDialog({
      title: $_('radio.confirm.delete_station_title'),
      message: $_('radio.confirm.delete_station_msg', { values: { name: s.name } }),
      confirmText: $_('common.delete'),
      dangerous: true,
    })) return;
    $radioStations = ($radioStations || []).filter(x => x.id !== s.id);
  }
  async function playStation(s) {
    // Stream-routing strategy:
    //   - Capacitor (standalone OR server-mode): playTrack() in player.js
    //     detects isStream and routes through Android's native ExoPlayer
    //     (LtRadioPlayer plugin). ExoPlayer fetches directly via OkHttp,
    //     decodes natively (no Chromium HE-AAC bug), and the FAB visualizer
    //     gets real-time FFT data via android.media.audiofx.Visualizer.
    //   - HLS (.m3u8) on web: passed direct. hls.js fetches segments via
    //     XHR and feeds them into MSE; resulting audio.src is a blob: URL,
    //     which is always same-origin → visualizer works regardless.
    //   - Web (PWA, non-HLS): goes through the server's /api/radio-proxy
    //     so the audio source stays same-origin. The server adds CORS
    //     headers in the response and the AudioContext path isn't zeroed.
    const isHls = /\.m3u8(\?|$)/i.test(s.url);
    let streamUrl;
    if (isNative) {
      streamUrl = s.url;   // ExoPlayer fetches the upstream directly
    } else if (isHls) {
      streamUrl = s.url;
    } else {
      streamUrl = `/api/radio-proxy?url=${encodeURIComponent(s.url)}`;
    }
    const track = {
      id: s.id,
      title: s.name,
      artist: s.genre || 'Radio station',
      album: '',
      coverUrl: s.iconUrl || '',
      streamUrl,
      transcodeUrl: null,
      duration: 0,
      isStream: true,
      originalUrl: s.url,  // used for /now-playing polling
    };
    playTrack(track, [track], 0);
  }

  let loading = false;
  // Last loadTab error, surfaced as an inline retry block. Cleared on
  // successful load / tab switch / explicit retry so the empty grid no
  // longer reads as "no data" after a Subsonic/Jellyfin connection drop.
  let lastTabError = '';
  let lastTabKey = '';
  let search = _savedRadio?.search || '';

  // Data — initialized from the module cache so re-mounts don't show empty
  // grids while loadTab() re-fetches.
  let albums    = _LIB_CACHE.albums    || [];
  let artists   = _LIB_CACHE.artists   || [];
  let playlists = _LIB_CACHE.playlists || [];
  let searchResults = { artists: [], albums: [], songs: [] };

  // Detail views
  let selectedArtist = null;
  let artistAlbums = [];
  let selectedAlbum = null;
  let albumTracks = [];
  let selectedPlaylist = null;
  let playlistTracks = [];

  // Music ("Self-hosted music") and stations are independent features.
  // Only redirect away if both are disabled.
  $: musicAvailable = $radioEnabled && $radioUrl;
  $: if (!musicAvailable && !$radioStationsEnabled) push('/settings');
  // If user is on a music-only tab without music, fall back to stations.
  $: if (!musicAvailable && tab !== 'stations') { tab = 'stations'; }
  // If user turns off Stations while it's the active tab, fall back to albums.
  $: if (tab === 'stations' && !$radioStationsEnabled && musicAvailable) { tab = 'albums'; loadTab('albums'); }

  // Persist current view to sessionStorage on every change. svelte-spa-router's
  // {#key $location} pattern destroys/recreates the route on every nav, so
  // without this the Radio page snaps back to its default tab + scroll
  // position every time the user toggles to Diary or Settings and back.
  // Stored under sessionStorage so it survives nav but resets on a full app
  // close (matches PWA expectations). The READ side is synchronous, up at
  // the top of the script — see _savedRadio.
  function _saveRadioState() {
    try {
      sessionStorage.setItem(RADIO_STATE_KEY, JSON.stringify({
        tab,
        stationsSubTab,
        search,
        selectedAlbumId:    selectedAlbum?.id    ?? null,
        selectedArtistId:   selectedArtist?.id   ?? null,
        selectedPlaylistId: selectedPlaylist?.id ?? null,
        scrollY: window.scrollY || 0,
      }));
    } catch {}
  }

  onMount(async () => {
    if (!musicAvailable && !$radioStationsEnabled) return;
    // Skip loadTab for 'stations' — it's rendered from the local radioStations
    // store, not fetched from a music provider.
    if (tab !== 'stations') await loadTab(tab);

    // Restore any open detail view by re-fetching its content.
    if (_savedRadio?.selectedAlbumId)    await openAlbum({ id: _savedRadio.selectedAlbumId });
    if (_savedRadio?.selectedArtistId)   await openArtist({ id: _savedRadio.selectedArtistId });
    if (_savedRadio?.selectedPlaylistId) await openPlaylist({ id: _savedRadio.selectedPlaylistId });

    // Pre-load starred ids once on mount (cheap single call) so the heart
    // toggles render correctly across Albums / Artists / Search results
    // without forcing a tab visit. Failure is silent — non-Subsonic
    // providers just have no stars.
    if (musicAvailable && sub.supportsStarred?.()) {
      try {
        const data = await sub.getStarred();
        starredSongs   = data.songs   || [];
        starredAlbums  = data.albums  || [];
        starredArtists = data.artists || [];
        starredIds = new Set([
          ...starredSongs.map(s => s.id),
          ...starredAlbums.map(a => 'album:' + a.id),
          ...starredArtists.map(a => 'artist:' + a.id),
        ]);
        _LIB_CACHE.starredSongs   = starredSongs;
        _LIB_CACHE.starredAlbums  = starredAlbums;
        _LIB_CACHE.starredArtists = starredArtists;
      } catch {}
    }

    // Restore scroll AFTER the data is rendered so the position is meaningful.
    if (_savedRadio?.scrollY) {
      requestAnimationFrame(() => window.scrollTo(0, _savedRadio.scrollY));
    }
  });

  // Save reactively on every state change. Cheap (one JSON.stringify per
  // change), and Svelte deduplicates identical reactive runs by reference.
  $: if (typeof window !== 'undefined') {
    void tab; void stationsSubTab; void search;
    void selectedAlbum; void selectedArtist; void selectedPlaylist;
    _saveRadioState();
  }

  // Capture scroll position separately — scroll doesn't trigger Svelte
  // reactivity, but we want it persisted so navigating away mid-list and
  // back returns the user to the same row. Save on the destroy hook (fires
  // on every {#key $location} swap) so we always grab the LAST scrollY.
  onDestroy(() => {
    if (typeof window !== 'undefined') _saveRadioState();
    _wideMq?.removeEventListener?.('change', _syncWide);
    document.documentElement.classList.remove('lt-route-radio');
  });

  // Wide-mode gate — same pattern the picker + programs + statistics use.
  // At >=1280px on non-forced-mobile viewports, Radio becomes a 3-col
  // shell: source rail on the left, current tab content in the center,
  // Now Playing hero on the right. Also stamps html.lt-route-radio so
  // the App-level MiniPlayer can hide itself on this route at wide
  // widths (the hero is a richer replacement).
  let _wideMode = false;
  let _wideMq;
  function _syncWide() {
    if (typeof document === 'undefined') return;
    _wideMode = !!_wideMq?.matches
      && !document.documentElement.classList.contains('force-mobile-layout');
  }
  if (typeof window !== 'undefined') {
    _wideMq = window.matchMedia('(min-width: 1280px)');
    _syncWide();
    _wideMq.addEventListener?.('change', _syncWide);
    document.documentElement.classList.add('lt-route-radio');
  }

  // Now Playing hero — cover-tinted backdrop reusing FullPlayer's
  // color-extraction logic verbatim so the two surfaces feel like one
  // system. Cached per src via window.__LT_BG_CACHE so re-navigating
  // doesn't reprocess.
  $: _rnpCoverSrc = resolveAssetUrl($streamArtwork || $currentTrack?.coverUrl || '');
  let _rnpBg = '';
  const _rnpBgCache = (typeof window !== 'undefined' && (window.__LT_BG_CACHE ||= {})) || {};
  async function _rnpExtractColor(src) {
    if (!src) { _rnpBg = ''; return; }
    if (_rnpBgCache[src]) { _rnpBg = _rnpBgCache[src]; return; }
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject();
      });
      img.src = src;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const bright = (R + G + B) / 3;
        if (bright < 20 || bright > 235) continue;
        r += R; g += G; b += B; n++;
      }
      if (n > 0) {
        _rnpBg = `rgb(${Math.round(r/n)}, ${Math.round(g/n)}, ${Math.round(b/n)})`;
        _rnpBgCache[src] = _rnpBg;
      }
    } catch { /* cross-origin / load fail — leave default */ }
  }
  $: if (_rnpCoverSrc) _rnpExtractColor(_rnpCoverSrc);

  async function loadTab(t, { force = false } = {}) {
    // Local-first: if the cache already has data for this tab, render it
    // immediately and only re-fetch if the caller forced (e.g., manual
    // refresh or initial population). Avoids the blank-grid flash when
    // returning to Radio mid-listen.
    if (!force) {
      if (t === 'albums'    && _LIB_CACHE.albums?.length)    { albums    = _LIB_CACHE.albums;    return; }
      if (t === 'artists'   && _LIB_CACHE.artists?.length)   { artists   = _LIB_CACHE.artists;   return; }
      if (t === 'playlists' && _LIB_CACHE.playlists?.length) { playlists = _LIB_CACHE.playlists; return; }
      if (t === 'starred'   && (_LIB_CACHE.starredSongs?.length || _LIB_CACHE.starredAlbums?.length || _LIB_CACHE.starredArtists?.length)) {
        starredSongs   = _LIB_CACHE.starredSongs   || [];
        starredAlbums  = _LIB_CACHE.starredAlbums  || [];
        starredArtists = _LIB_CACHE.starredArtists || [];
        return;
      }
    }
    loading = true;
    lastTabError = '';
    lastTabKey = t;
    try {
      if (t === 'albums') {
        albums = await sub.getAlbumList('random', 50);
        _LIB_CACHE.albums = albums;
      } else if (t === 'artists') {
        artists = await sub.getArtists();
        _LIB_CACHE.artists = artists;
        if (!artists || artists.length === 0) {
          showError($_('radio.toast.no_artists'));
        }
      } else if (t === 'playlists') {
        playlists = await sub.getPlaylists();
        _LIB_CACHE.playlists = playlists;
      } else if (t === 'starred') {
        const data = await sub.getStarred();
        starredSongs   = data.songs   || [];
        starredAlbums  = data.albums  || [];
        starredArtists = data.artists || [];
        _LIB_CACHE.starredSongs   = starredSongs;
        _LIB_CACHE.starredAlbums  = starredAlbums;
        _LIB_CACHE.starredArtists = starredArtists;
        // Refresh the in-memory ID set so star toggles render correctly.
        starredIds = new Set([
          ...starredSongs.map(s => s.id),
          ...starredAlbums.map(a => 'album:' + a.id),
          ...starredArtists.map(a => 'artist:' + a.id),
        ]);
      }
    } catch(e) {
      console.error('[radio] loadTab error:', t, e);
      lastTabError = e?.message || 'Connection failed';
      showError(`${t}: ${lastTabError}`);
    }
    loading = false;
  }

  // Starred state — separate lists by type plus a flat ID set for O(1)
  // membership checks when rendering star icons on tracks/albums/artists.
  let starredSongs = [];
  let starredAlbums = [];
  let starredArtists = [];
  let starredIds = new Set();

  // Optimistic toggle — flips the icon immediately, then issues the
  // star/unstar API call. Failure rolls back so the UI doesn't lie.
  async function toggleStar(kind, item) {
    const idKey = kind === 'song' ? item.id
                : kind === 'album' ? 'album:' + item.id
                : 'artist:' + item.id;
    const isStarred = starredIds.has(idKey);
    const next = new Set(starredIds);
    if (isStarred) next.delete(idKey); else next.add(idKey);
    starredIds = next;
    try {
      const args = kind === 'song' ? { id: item.id }
                 : kind === 'album' ? { albumId: item.id }
                 : { artistId: item.id };
      if (isStarred) await sub.unstar(args);
      else await sub.star(args);
      // Invalidate the Starred cache so the next visit reloads from the
      // server — keeps the Starred tab honest without an explicit refetch.
      _LIB_CACHE.starredSongs = null;
      _LIB_CACHE.starredAlbums = null;
      _LIB_CACHE.starredArtists = null;
    } catch (e) {
      // Roll back the optimistic toggle if the server rejected it.
      const rolled = new Set(starredIds);
      if (isStarred) rolled.add(idKey); else rolled.delete(idKey);
      starredIds = rolled;
      showError(e.message || $_('radio.toast.cant_update_fav'));
    }
  }
  function isStarred(kind, item) {
    if (!item?.id) return false;
    const idKey = kind === 'song' ? item.id
                : kind === 'album' ? 'album:' + item.id
                : 'artist:' + item.id;
    return starredIds.has(idKey);
  }

  async function doSearch() {
    if (!search.trim()) return;
    loading = true;
    try { searchResults = await sub.search(search.trim()); }
    catch(e) { showError(e.message); }
    loading = false;
  }

  async function openArtist(artist) {
    loading = true;
    try {
      const data = await sub.getArtist(artist.id);
      selectedArtist = data;
      artistAlbums = data.album || [];
    } catch(e) { showError(e.message); }
    loading = false;
  }

  async function openAlbum(album) {
    loading = true;
    try {
      const data = await sub.getAlbum(album.id);
      selectedAlbum = data;
      albumTracks = (data.song || []).map(sub.songToTrack);
    } catch(e) { showError(e.message); }
    loading = false;
  }

  async function openPlaylist(pl) {
    loading = true;
    try {
      const data = await sub.getPlaylist(pl.id);
      selectedPlaylist = data;
      playlistTracks = (data.entry || []).map(sub.songToTrack);
    } catch(e) { showError(e.message); }
    loading = false;
  }

  function playAll(tracks, startIdx = 0) {
    if (tracks.length === 0) return;
    playTrack(tracks[startIdx], tracks, startIdx);
  }

  function shufflePlay(tracks) {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    playTrack(shuffled[0], shuffled, 0);
  }

  async function playRandom() {
    loading = true;
    try {
      const songs = await sub.getRandomSongs(50);
      const tracks = songs.map(sub.songToTrack);
      if (tracks.length > 0) playTrack(tracks[0], tracks, 0);
    } catch(e) { showError(e.message); }
    loading = false;
  }

  // Section-aware shuffle for the Stations tab. Picks one station at
  // random and plays it — equivalent role to "Mix" on music tabs.
  function playRandomStation() {
    const list = $radioStations || [];
    if (!list.length) { showError($_('radio.toast.add_station_first')); return; }
    const pick = list[Math.floor(Math.random() * list.length)];
    playStation(pick);
  }

  function back() {
    if (selectedAlbum) { selectedAlbum = null; albumTracks = []; }
    else if (selectedArtist) { selectedArtist = null; artistAlbums = []; }
    else if (selectedPlaylist) { selectedPlaylist = null; playlistTracks = []; }
  }

  function fmtDuration(s) {
    if (!s) return '';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // Context menu for tracks
  // On desktop, contextmenu (right-click) reports accurate clientX/clientY.
  // On mobile long-press, some Android browsers fire contextmenu with (0,0)
  // or stale coords — so we capture the touch/pointer position separately
  // and fall back to those when the event's coords look bogus.
  let ctxTrack = null;
  let ctxPos = { x: 0, y: 0 };
  let ctxMenuEl;
  let _lastPointerPos = { x: 0, y: 0 };

  function _recordPointer(e) {
    _lastPointerPos = { x: e.clientX || 0, y: e.clientY || 0 };
  }

  function showCtx(e, track) {
    e.preventDefault();
    e.stopPropagation();
    ctxTrack = track;
    // If event coords are bogus (0,0 or clearly off-screen), use the last
    // captured pointer position from pointerdown.
    let x = e.clientX, y = e.clientY;
    if (!x && !y && (_lastPointerPos.x || _lastPointerPos.y)) {
      x = _lastPointerPos.x;
      y = _lastPointerPos.y;
    }
    ctxPos = { x, y };
    // Clamp to viewport once the menu has mounted (next tick).
    setTimeout(_clampCtx, 0);
  }

  function _clampCtx() {
    if (!ctxMenuEl) return;
    const rect = ctxMenuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    let { x, y } = ctxPos;
    if (x + rect.width > vw - pad) x = vw - rect.width - pad;
    if (y + rect.height > vh - pad) y = vh - rect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    ctxPos = { x, y };
  }

  function ctxAddToQueue() {
    if (ctxTrack) { addToQueue(ctxTrack); showSuccess($_('radio.toast.added_to_queue')); }
    ctxTrack = null;
  }

  function ctxPlayNext() {
    if (ctxTrack) { playNext(ctxTrack); showSuccess($_('radio.toast.playing_next')); }
    ctxTrack = null;
  }

  $: isNowPlaying = (id) => $currentTrack?.id === id;

  $: showBack = selectedAlbum || selectedArtist || selectedPlaylist;
</script>

<div class="page">
  <!-- Sticky top — page-header banner + tab pill row + search bar.
       Lives at PAGE level (not inside the wide grid) so the banner
       spans full width like Diary / Settings / Programs do, and the
       3-col grid below aligns properly instead of the banner
       floating over one column only. Tab pill row is hidden on wide
       by CSS; the left source rail owns navigation there. -->
  <div class="sticky-top">
    <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
      {#if showBack}
        <button class="back-btn" on:click={back}>
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
      {/if}
      <h1>{selectedAlbum?.name || selectedArtist?.name || selectedPlaylist?.name || 'Radio'}</h1>
    </header>

    {#if !showBack}
      <div class="radio-bar">
        <div class="radio-tabs">
          {#each [...(musicAvailable ? [['albums','Albums'],['artists','Artists'],['playlists','Playlists']] : []),...(musicAvailable && sub.supportsStarred?.() ? [['starred','Starred']] : []),...($radioStationsEnabled ? [['stations','Stations']] : [])] as [val, label]}
            <button class="radio-tab" class:active={tab === val} on:click={() => { tab = val; if (val !== 'stations') loadTab(val); }}>
              {label}
            </button>
          {/each}
        </div>
        <div class="radio-actions">
          {#if musicAvailable}
            <button class="icon-btn" class:active={tab === 'search'}
              on:click={() => tab = 'search'}
              title={$_('radio.search_library')} aria-label={$_('radio.search')}>
              <span class="material-symbols-rounded">search</span>
            </button>
          {/if}
          {#if tab === 'stations'}
            <button class="shuffle-btn" on:click={playRandomStation}
              disabled={!($radioStations || []).length}
              title={$_('radio.play_random_station')}>
              <span class="material-symbols-rounded">shuffle</span> Random
            </button>
          {:else if musicAvailable && tab !== 'search'}
            <button class="shuffle-btn" on:click={playRandom}
              title={$_('radio.play_random_mix')}>
              <span class="material-symbols-rounded">shuffle</span> Mix
            </button>
          {/if}
        </div>
      </div>

      {#if tab === 'search' && musicAvailable}
        <div class="radio-search-bar">
          <input class="search-input" type="search" placeholder={$_('radio.search_ph')}
            bind:value={search} on:keydown={e => e.key === 'Enter' && doSearch()} />
          <button class="btn btn-primary" style="height:38px;font-size:13px;flex-shrink:0" on:click={doSearch} disabled={loading}>
            {#if loading}
              <span class="material-symbols-rounded spin" style="font-size:16px">progress_activity</span>
            {:else}
              Search
            {/if}
          </button>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Body wrapper — at >=1280px on non-forced-mobile viewports this
       becomes a 3-col shell: left source-nav rail | center content |
       right Now Playing hero. On mobile it's a plain block so nothing
       changes below phone widths. -->
  <div class="radio-body">

  <!-- Left source-nav rail (desktop only via CSS). Grouped nav
       replaces the horizontal tab pill row (which is hidden on wide)
       — mid-workout station changes become one click without
       scrolling past collapsed group headers. -->
  <nav class="radio-source-rail" aria-label="Radio sections">
    {#if musicAvailable}
      <div class="rsr-group">
        <span class="rsr-group-title">Music</span>
        <button type="button" class="rsr-btn" class:active={tab === 'albums'}
                on:click={() => { tab = 'albums'; loadTab('albums'); }}>
          <span class="material-symbols-rounded">album</span>
          <span class="rsr-label">Albums</span>
        </button>
        <button type="button" class="rsr-btn" class:active={tab === 'artists'}
                on:click={() => { tab = 'artists'; loadTab('artists'); }}>
          <span class="material-symbols-rounded">person</span>
          <span class="rsr-label">Artists</span>
        </button>
        <button type="button" class="rsr-btn" class:active={tab === 'playlists'}
                on:click={() => { tab = 'playlists'; loadTab('playlists'); }}>
          <span class="material-symbols-rounded">queue_music</span>
          <span class="rsr-label">Playlists</span>
        </button>
        {#if sub.supportsStarred?.()}
          <button type="button" class="rsr-btn" class:active={tab === 'starred'}
                  on:click={() => { tab = 'starred'; loadTab('starred'); }}>
            <span class="material-symbols-rounded">star</span>
            <span class="rsr-label">Starred</span>
          </button>
        {/if}
        <button type="button" class="rsr-btn" class:active={tab === 'search'}
                on:click={() => tab = 'search'}>
          <span class="material-symbols-rounded">search</span>
          <span class="rsr-label">Search</span>
        </button>
      </div>
    {/if}
    {#if $radioStationsEnabled}
      <div class="rsr-group">
        <span class="rsr-group-title">Radio</span>
        <button type="button" class="rsr-btn" class:active={tab === 'stations'}
                on:click={() => tab = 'stations'}>
          <span class="material-symbols-rounded">radio</span>
          <span class="rsr-label">Stations</span>
        </button>
      </div>
    {/if}
  </nav>

  <div class="radio-content">
    {#if loading}
      <div class="loading-state">
        <span class="material-symbols-rounded spin">autorenew</span>
      </div>

    <!-- Search results — search input lives in the sticky bar above. -->
    {:else if tab === 'search' && !showBack}
      {#if loading && search.trim()}
        <div class="loading-inline">
          <span class="material-symbols-rounded spin">progress_activity</span>
          Searching…
        </div>
      {/if}
      {#if searchResults.songs.length > 0}
        <p class="result-label">{$_('radio.songs')}</p>
        {#each searchResults.songs as song}
          {@const track = sub.songToTrack(song)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="track-row" class:now-playing={isNowPlaying(song.id)}
            on:click={() => playTrack(track, [track], 0)}
            on:pointerdown={_recordPointer} on:contextmenu={e => showCtx(e, track)}
            role="button" tabindex="0">
            {#if isNowPlaying(song.id)}<span class="now-eq" aria-hidden="true"><span></span><span></span><span></span></span>
            {:else}<img class="track-art" src={resolveAssetUrl(sub.getCoverArtUrl(song.coverArt || song.albumId, 80))} alt="" />{/if}
            <div class="track-info">
              <span class="track-title">{song.title}</span>
              <span class="track-meta">{song.artist} · {fmtDuration(song.duration)}</span>
            </div>
            {#if sub.supportsStarred?.()}
              <button class="star-btn" class:starred={isStarred('song', song)}
                on:click|stopPropagation={() => toggleStar('song', song)}
                title={isStarred('song', song) ? 'Unstar' : 'Star'}>
                <span class="material-symbols-rounded" class:filled={isStarred('song', song)}>
                  {isStarred('song', song) ? 'star' : 'star_outline'}
                </span>
              </button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if searchResults.albums.length > 0}
        <p class="result-label">{$_('radio.albums')}</p>
        <div class="album-grid">
          {#each searchResults.albums as album}
            <button class="album-card" on:click={() => openAlbum(album)}>
              <img class="album-art" src={resolveAssetUrl(sub.getCoverArtUrl(album.coverArt || album.id, 300))} alt="" />
              <span class="album-name">{album.name}</span>
              <span class="album-artist">{album.artist}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if searchResults.artists.length > 0}
        <p class="result-label">{$_('radio.artists')}</p>
        {#each searchResults.artists as artist}
          <button class="artist-row" on:click={() => openArtist(artist)}>
            <span class="material-symbols-rounded" style="font-size:20px;color:var(--accent)">person</span>
            <span class="artist-name">{artist.name}</span>
          </button>
        {/each}
      {/if}

    <!-- Album detail -->
    {:else if selectedAlbum}
      <div class="detail-header">
        <img class="detail-art" src={resolveAssetUrl(sub.getCoverArtUrl(selectedAlbum.coverArt || selectedAlbum.id, 400))} alt="" />
        <div class="detail-info">
          <span class="detail-title">{selectedAlbum.name}</span>
          <span class="detail-meta">{selectedAlbum.artist} · {selectedAlbum.songCount || albumTracks.length} tracks</span>
        </div>
        <div class="detail-actions">
          <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={() => playAll(albumTracks)}>
            <span class="material-symbols-rounded" style="font-size:16px">play_arrow</span> Play All
          </button>
          <button class="btn btn-secondary" style="height:36px;font-size:13px" on:click={() => shufflePlay(albumTracks)}>
            <span class="material-symbols-rounded" style="font-size:16px">shuffle</span> Shuffle
          </button>
        </div>
      </div>
      {#each albumTracks as track, i}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="track-row" class:now-playing={isNowPlaying(track.id)}
          on:click={() => playTrack(track, albumTracks, i)}
          on:pointerdown={_recordPointer} on:contextmenu={e => showCtx(e, track)}
          role="button" tabindex="0">
          {#if isNowPlaying(track.id)}<span class="now-eq" aria-hidden="true"><span></span><span></span><span></span></span>
          {:else}<span class="track-num">{i + 1}</span>{/if}
          <div class="track-info">
            <span class="track-title">{track.title}</span>
            <span class="track-meta">{fmtDuration(track.duration)}</span>
          </div>
          {#if sub.supportsStarred?.()}
            <button class="star-btn" class:starred={isStarred('song', track)}
              on:click|stopPropagation={() => toggleStar('song', track)}
              title={isStarred('song', track) ? 'Unstar' : 'Star'}>
              <span class="material-symbols-rounded" class:filled={isStarred('song', track)}>
                {isStarred('song', track) ? 'star' : 'star_outline'}
              </span>
            </button>
          {/if}
        </div>
      {/each}

    <!-- Artist detail -->
    {:else if selectedArtist}
      <div class="album-grid">
        {#each artistAlbums as album}
          <button class="album-card" on:click={() => openAlbum(album)}>
            <img class="album-art" src={resolveAssetUrl(sub.getCoverArtUrl(album.coverArt || album.id, 300))} alt="" />
            <span class="album-name">{album.name}</span>
            <span class="album-artist">{album.year || ''}</span>
          </button>
        {/each}
      </div>

    <!-- Playlist detail -->
    {:else if selectedPlaylist}
      <div class="detail-actions" style="padding:0 0 12px">
        <button class="btn btn-primary" style="height:36px;font-size:13px" on:click={() => playAll(playlistTracks)}>
          <span class="material-symbols-rounded" style="font-size:16px">play_arrow</span> Play All
        </button>
        <button class="btn btn-secondary" style="height:36px;font-size:13px" on:click={() => shufflePlay(playlistTracks)}>
          <span class="material-symbols-rounded" style="font-size:16px">shuffle</span> Shuffle
        </button>
      </div>
      {#each playlistTracks as track, i}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="track-row" class:now-playing={isNowPlaying(track.id)}
          on:click={() => playTrack(track, playlistTracks, i)}
          on:pointerdown={_recordPointer} on:contextmenu={e => showCtx(e, track)}
          role="button" tabindex="0">
          {#if isNowPlaying(track.id)}<span class="now-eq" aria-hidden="true"><span></span><span></span><span></span></span>
          {:else}<img class="track-art" src={resolveAssetUrl(track.coverUrl)} alt="" />{/if}
          <div class="track-info">
            <span class="track-title">{track.title}</span>
            <span class="track-meta">{track.artist} · {fmtDuration(track.duration)}</span>
          </div>
          {#if sub.supportsStarred?.()}
            <button class="star-btn" class:starred={isStarred('song', track)}
              on:click|stopPropagation={() => toggleStar('song', track)}
              title={isStarred('song', track) ? 'Unstar' : 'Star'}>
              <span class="material-symbols-rounded" class:filled={isStarred('song', track)}>
                {isStarred('song', track) ? 'star' : 'star_outline'}
              </span>
            </button>
          {/if}
        </div>
      {/each}

    <!-- Albums grid -->
    {:else if tab === 'albums'}
      <div class="album-grid">
        {#each albums as album}
          <button class="album-card" on:click={() => openAlbum(album)}>
            <img class="album-art" src={resolveAssetUrl(sub.getCoverArtUrl(album.coverArt || album.id, 300))} alt="" />
            <span class="album-name">{album.name}</span>
            <span class="album-artist">{album.artist}</span>
          </button>
        {/each}
      </div>
      {#if albums.length === 0 && !loading}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">
            {lastTabError && lastTabKey === 'albums' ? 'wifi_off' : 'library_music'}
          </span>
          {#if lastTabError && lastTabKey === 'albums'}
            <p><strong>Couldn't reach your media server.</strong></p>
            <p style="font-size:13px;color:var(--text-3)">{lastTabError}</p>
            <button class="btn btn-secondary" style="margin-top:8px" on:click={() => loadTab('albums', { force: true })}>
              <span class="material-symbols-rounded" style="font-size:16px">refresh</span> Retry
            </button>
          {:else}
            <p>No albums found. Check your Subsonic server connection in Settings.</p>
          {/if}
        </div>
      {/if}

    <!-- Artists list -->
    {:else if tab === 'artists'}
      {#each artists as group}
        {#each group.artist || [] as artist}
          <button class="artist-row" on:click={() => openArtist(artist)}>
            <span class="material-symbols-rounded" style="font-size:20px;color:var(--accent)">person</span>
            <span class="artist-name">{artist.name}</span>
            <span class="artist-count">{artist.albumCount || ''}</span>
          </button>
        {/each}
      {/each}
      {#if !loading && artists.reduce((n, g) => n + (g.artist?.length || 0), 0) === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">
            {lastTabError && lastTabKey === 'artists' ? 'wifi_off' : 'person'}
          </span>
          {#if lastTabError && lastTabKey === 'artists'}
            <p><strong>Couldn't reach your media server.</strong></p>
            <p style="font-size:13px;color:var(--text-3)">{lastTabError}</p>
            <button class="btn btn-secondary" style="margin-top:8px" on:click={() => loadTab('artists', { force: true })}>
              <span class="material-symbols-rounded" style="font-size:16px">refresh</span> Retry
            </button>
          {:else}
            <p>No artists found. Check your Subsonic server connection in Settings.</p>
          {/if}
        </div>
      {/if}

    <!-- Playlists -->
    {:else if tab === 'playlists'}
      {#each playlists as pl}
        <button class="artist-row" on:click={() => openPlaylist(pl)}>
          <span class="material-symbols-rounded" style="font-size:20px;color:var(--accent)">queue_music</span>
          <span class="artist-name">{pl.name}</span>
          <span class="artist-count">{pl.songCount || ''} tracks</span>
        </button>
      {/each}
      {#if playlists.length === 0 && !loading}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">
            {lastTabError && lastTabKey === 'playlists' ? 'wifi_off' : 'queue_music'}
          </span>
          {#if lastTabError && lastTabKey === 'playlists'}
            <p><strong>Couldn't reach your media server.</strong></p>
            <p style="font-size:13px;color:var(--text-3)">{lastTabError}</p>
            <button class="btn btn-secondary" style="margin-top:8px" on:click={() => loadTab('playlists', { force: true })}>
              <span class="material-symbols-rounded" style="font-size:16px">refresh</span> Retry
            </button>
          {:else}
            <p>No playlists found.</p>
          {/if}
        </div>
      {/if}

    <!-- Starred — favorites across songs / albums / artists -->
    {:else if tab === 'starred'}
      {#if starredAlbums.length > 0}
        <p class="result-label">{$_('radio.albums')}</p>
        <div class="album-grid">
          {#each starredAlbums as album (album.id)}
            <button class="album-card" on:click={() => openAlbum(album)}>
              <img class="album-art" src={resolveAssetUrl(sub.getCoverArtUrl(album.coverArt || album.id, 300))} alt="" loading="lazy" />
              <span class="album-name">{album.name}</span>
              <span class="album-artist">{album.artist}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if starredArtists.length > 0}
        <p class="result-label">{$_('radio.artists')}</p>
        {#each starredArtists as artist (artist.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="artist-row" on:click={() => openArtist(artist)} role="button" tabindex="0">
            <span class="material-symbols-rounded" style="font-size:20px;color:var(--accent)">person</span>
            <span class="artist-name">{artist.name}</span>
            <button class="star-btn" on:click|stopPropagation={() => toggleStar('artist', artist)} title={$_('radio.unstar')}>
              <span class="material-symbols-rounded filled">star</span>
            </button>
          </div>
        {/each}
      {/if}
      {#if starredSongs.length > 0}
        <p class="result-label">{$_('radio.songs')}</p>
        {#each starredSongs as song (song.id)}
          {@const track = sub.songToTrack(song)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="track-row" class:now-playing={isNowPlaying(song.id)}
            on:click={() => playTrack(track, starredSongs.map(s => sub.songToTrack(s)), starredSongs.findIndex(s => s.id === song.id))}
            on:pointerdown={_recordPointer} on:contextmenu={e => showCtx(e, track)}
            role="button" tabindex="0">
            {#if isNowPlaying(song.id)}<span class="now-eq" aria-hidden="true"><span></span><span></span><span></span></span>
            {:else}<img class="track-art" src={resolveAssetUrl(sub.getCoverArtUrl(song.coverArt || song.albumId, 80))} alt="" loading="lazy" />{/if}
            <div class="track-info">
              <span class="track-title">{song.title}</span>
              <span class="track-meta">{song.artist} · {fmtDuration(song.duration)}</span>
            </div>
            <button class="star-btn" on:click|stopPropagation={() => toggleStar('song', song)} title={$_('radio.unstar')}>
              <span class="material-symbols-rounded filled">star</span>
            </button>
          </div>
        {/each}
      {/if}
      {#if starredAlbums.length === 0 && starredArtists.length === 0 && starredSongs.length === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">star_border</span>
          <p>No favorites yet. Tap the star on a song, album, or artist to add it here.</p>
        </div>
      {/if}

    <!-- Streaming stations -->
    {:else if tab === 'stations'}
      <!-- Header row: My/Browse pill + Add station. Stacked on mobile
           (natural block flow), inline flex row on wide widths so the
           section chrome doesn't take three vertical bands. -->
      <div class="stations-header-row">
        <div class="station-sub-tabs" data-active={stationsSubTab}>
          <span class="sub-tab-pill" aria-hidden="true"></span>
          <button class="sub-tab" class:active={stationsSubTab === 'my'} on:click={() => stationsSubTab = 'my'}>{$_('radio.my_stations')}</button>
          <button class="sub-tab" class:active={stationsSubTab === 'browse'} on:click={() => stationsSubTab = 'browse'}>{$_('radio.browse')}</button>
        </div>
        {#if stationsSubTab === 'my'}
          <button class="btn btn-primary add-station-btn" on:click={openAddStation}>
            <span class="material-symbols-rounded" style="font-size:18px">add</span> Add station
          </button>
        {/if}
      </div>

      {#if stationsSubTab === 'my'}
        {#each groupedStations as [groupName, stations] (groupName)}
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <div class="station-group-header"
            class:drag-over-group={dragOverGroup === (groupName || '')}
            class:collapsed={isGroupCollapsed(groupName)}
            on:click={() => toggleGroupCollapse(groupName)}
            on:dragover={e => onGroupDragOver(e, groupName || '')}
            on:drop={e => onGroupDrop(e, groupName || '')}
            role="button" tabindex="0"
          >
            <span class="material-symbols-rounded group-chev" class:collapsed={isGroupCollapsed(groupName)}>expand_more</span>
            <span class="group-name">{groupName || 'Ungrouped'}</span>
            <span class="group-count">{stations.length}</span>
            <button class="group-rename-btn" on:click|stopPropagation={() => openRenameGroup(groupName)} title={$_('radio.rename_group')}>
              <span class="material-symbols-rounded">edit</span>
            </button>
          </div>
          {#if !isGroupCollapsed(groupName)}
          <!-- Station list wrapper — becomes a 2-col grid at wide
               widths so rows stop stretching to 1000px+ single-line
               strips. Group header still spans full width above. -->
          <div class="station-list">
          {#each stations as s (s.id)}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="station-row"
              class:now-playing-row={$currentTrack?.id === s.id}
              class:dragging={dragStationId === s.id}
              class:drag-over={dragOverStationId === s.id}
              draggable="true"
              on:dragstart={e => onStationDragStart(e, s)}
              on:dragover={e => onStationDragOver(e, s)}
              on:drop={e => onStationDrop(e, s)}
              on:dragend={onStationDragEnd}
            >
              <span class="material-symbols-rounded drag-handle" title={$_('radio.drag_reorder')}>drag_indicator</span>
              <div class="station-reorder">
                <button class="reorder-btn" disabled={!canMove(s, 'up')} on:click={() => moveStation(s, 'up')} title={$_('radio.move_up')}>
                  <span class="material-symbols-rounded">keyboard_double_arrow_up</span>
                </button>
                <button class="reorder-btn" disabled={!canMove(s, 'down')} on:click={() => moveStation(s, 'down')} title={$_('radio.move_down')}>
                  <span class="material-symbols-rounded">keyboard_double_arrow_down</span>
                </button>
              </div>
              <button class="station-main" on:click={() => playStation(s)}>
                {#if s.iconUrl}
                  <img class="station-icon" src={s.iconUrl} alt="" />
                {:else}
                  <span class="station-icon-fallback material-symbols-rounded">radio</span>
                {/if}
                <div class="track-info">
                  <span class="track-title">{s.name}</span>
                  {#if $currentTrack?.id === s.id && $streamNowPlaying}
                    <span class="track-meta now-playing">♪ {$streamNowPlaying}</span>
                  {:else}
                    <span class="track-meta">{s.genre || 'Radio station'}</span>
                  {/if}
                </div>
              </button>
              <button class="station-action" on:click={() => openEditStation(s)} title="Edit">
                <span class="material-symbols-rounded">edit</span>
              </button>
              <button class="station-action danger" on:click={() => deleteStation(s)} title="Delete">
                <span class="material-symbols-rounded">delete</span>
              </button>
            </div>
          {/each}
          </div><!-- /.station-list -->
          {/if}
        {/each}
      {:else}
        <!-- Browse Radio-Browser.info directory -->
        <div class="rb-search">
          <span class="material-symbols-rounded rb-search-icon">search</span>
          <input
            class="rb-search-input"
            type="search"
            bind:value={rbQuery}
            on:input={rbDebouncedSearch}
            placeholder="Search stations, genres, countries…"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          {#if rbQuery}
            <button class="rb-search-clear" on:click={() => { rbQuery = ''; rbResults = []; }} aria-label="Clear">
              <span class="material-symbols-rounded">close</span>
            </button>
          {/if}
        </div>
        <div class="rb-attribution">
          Powered by <a href="https://www.radio-browser.info" target="_blank" rel="noopener">radio-browser.info</a>
        </div>
        {#if rbSearching}
          <div class="loading-inline">
            <span class="material-symbols-rounded spin">progress_activity</span>
            Searching…
          </div>
        {:else if rbResults.length === 0 && rbQuery.trim()}
          <div class="empty-state"><p>No results. Try different keywords.</p></div>
        {:else if rbResults.length === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">travel_explore</span>
            <p>Type above to search the Radio-Browser directory.</p>
          </div>
        {/if}
        {#each rbResults as r}
          {@const already = existingStationUrls.has((r.url_resolved || r.url || '').trim())}
          <div class="station-row" class:rb-already={already}>
            <button class="station-main" on:click={() => !already && addFromRadioBrowser(r)} disabled={already}>
              {#if r.favicon}
                <img class="station-icon" src={r.favicon} alt="" on:error={e => e.currentTarget.style.display = 'none'} />
              {:else}
                <span class="station-icon-fallback material-symbols-rounded">radio</span>
              {/if}
              <div class="track-info">
                <span class="track-title">{r.name}</span>
                <span class="track-meta">
                  {[r.country, r.bitrate ? `${r.bitrate} kbps` : '', (r.tags || '').split(',').slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
                </span>
              </div>
            </button>
            {#if already}
              <span class="rb-added-chip" title="Already in My Stations">
                <span class="material-symbols-rounded">check_circle</span>
                Added
              </span>
            {:else}
              <button class="station-action" on:click={() => addFromRadioBrowser(r)} title="Add station">
                <span class="material-symbols-rounded">add</span>
              </button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if stationsSubTab === 'my' && !($radioStations || []).length}
        <div class="empty-state">
          <span class="material-symbols-rounded" style="font-size:48px;color:var(--text-3)">radio</span>
          <p>No stations yet — tap Add station, or use Browse to search the directory.</p>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Now Playing hero (desktop only via CSS). Reuses FullPlayer's
       cover-tint gradient logic so the two surfaces share visual
       language. Renders a placeholder card when nothing is playing
       so the rail stays balanced. -->
  <aside class="radio-now-playing" style="--rnp-bg: {_rnpBg || 'var(--surface-2)'}">
    {#if $currentTrack}
      <div class="rnp-cover-wrap">
        {#if _rnpCoverSrc}
          <img class="rnp-cover" src={_rnpCoverSrc} alt="" />
        {:else}
          <span class="material-symbols-rounded rnp-cover-fallback">radio</span>
        {/if}
      </div>
      <div class="rnp-meta">
        <div class="rnp-title" title={$currentTrack.title || $currentTrack.name || ''}>
          {$streamNowPlaying || $currentTrack.title || $currentTrack.name || 'Now Playing'}
        </div>
        {#if $streamNowPlaying && ($currentTrack.title || $currentTrack.name)}
          <div class="rnp-sub" title={$currentTrack.title || $currentTrack.name}>
            {$currentTrack.title || $currentTrack.name}
          </div>
        {:else if $currentTrack.artist}
          <div class="rnp-sub">{$currentTrack.artist}</div>
        {/if}
      </div>
      <div class="rnp-controls">
        <button type="button" class="rnp-btn" on:click={playerPrev} aria-label="Previous">
          <span class="material-symbols-rounded">skip_previous</span>
        </button>
        <button type="button" class="rnp-btn rnp-btn-primary" on:click={togglePlay}
                aria-label={$isPlaying ? 'Pause' : 'Play'}>
          <span class="material-symbols-rounded">{$isPlaying ? 'pause' : 'play_arrow'}</span>
        </button>
        <button type="button" class="rnp-btn" on:click={playerNext} aria-label="Next">
          <span class="material-symbols-rounded">skip_next</span>
        </button>
      </div>
      <!-- Queue — feature parity with the FullPlayer modal (which
           the wide layout hides the MiniPlayer entry-point for). A
           lifter on desktop can now see what's coming next + remove
           tracks from the queue without opening any modal. -->
      {#if ($queue || []).length > 1}
        {@const _qi = $queueIndex}
        {@const _upcoming = ($queue || []).slice(_qi + 1)}
        {#if _upcoming.length > 0}
          <div class="rnp-queue">
            <div class="rnp-queue-head">
              <span class="material-symbols-rounded">queue_music</span>
              <span class="rnp-queue-title">Up Next</span>
              <span class="rnp-queue-count">{_upcoming.length}</span>
            </div>
            <ol class="rnp-queue-list">
              {#each _upcoming as t, i (t.id || (_qi + 1 + i))}
                <li class="rnp-queue-row">
                  <button type="button" class="rnp-queue-play"
                          on:click={() => playTrack(t, $queue, _qi + 1 + i)}
                          title="Play now">
                    {#if t.coverUrl}
                      <img class="rnp-queue-cover" src={resolveAssetUrl(t.coverUrl)} alt="" />
                    {:else}
                      <span class="material-symbols-rounded rnp-queue-cover-fallback">music_note</span>
                    {/if}
                    <div class="rnp-queue-info">
                      <span class="rnp-queue-name">{t.title || t.name || 'Track'}</span>
                      {#if t.artist}<span class="rnp-queue-sub">{t.artist}</span>{/if}
                    </div>
                  </button>
                  <button type="button" class="rnp-queue-remove"
                          on:click={() => removeFromQueue(_qi + 1 + i)}
                          aria-label="Remove from queue" title="Remove">
                    <span class="material-symbols-rounded">close</span>
                  </button>
                </li>
              {/each}
            </ol>
          </div>
        {/if}
      {/if}
    {:else}
      <div class="rnp-empty">
        <span class="material-symbols-rounded rnp-empty-icon">headphones</span>
        <p class="rnp-empty-title">Nothing playing</p>
        <p class="rnp-empty-desc">Pick a station or track and it'll show here with cover art, live metadata, and quick controls.</p>
      </div>
    {/if}
  </aside>
  </div><!-- /.radio-body -->
</div>

<!-- Add / edit station dialog -->
<Dialog bind:open={showStationDialog}
  title={stationEdit ? 'Edit station' : 'Add station'}
  confirmText="Save"
  cancelText="Cancel"
  on:confirm={saveStation}>
  <div class="station-form">
    <label class="form-label">{$_('radio.name')}</label>
    <input class="form-input" type="text" bind:value={stationName} placeholder={$_('radio.name_ph')} />
    <div class="field-header">
      <label class="form-label">{$_('radio.stream_url')}</label>
      <button type="button" class="auto-btn" on:click={autoFillFromUrl} disabled={detectingInfo || !stationUrl.trim()} title="Detect station info">
        <span class="material-symbols-rounded">auto_awesome</span>
        {detectingInfo ? 'Detecting…' : 'Auto-fill'}
      </button>
    </div>
    <input class="form-input" type="url" bind:value={stationUrl} placeholder="https://ice1.somafm.com/groovesalad-128-mp3" />
    <label class="form-label">{$_('radio.genre')} <span class="optional">{$_('radio.optional')}</span></label>
    <input class="form-input" type="text" bind:value={stationGenre} placeholder="Ambient / Downtempo" />
    <label class="form-label">{$_('radio.homepage')} <span class="optional">{$_('radio.for_icon_lookup')}</span></label>
    <input class="form-input" type="url" bind:value={stationHomepage} placeholder="https://www.deejay.it" />
    <label class="form-label">{$_('radio.group')} <span class="optional">{$_('radio.optional')}</span></label>
    <input class="form-input" type="text" bind:value={stationGroup} list="station-groups" placeholder="Italian, Workout, Chill…" />
    <datalist id="station-groups">
      {#each existingGroups as g}<option value={g}></option>{/each}
    </datalist>
    <div class="field-header">
      <label class="form-label">{$_('radio.icon_url')} <span class="optional">{$_('radio.optional')}</span></label>
      <button type="button" class="auto-btn" on:click={autoFetchIcon} disabled={!stationUrl.trim()} title="Use favicon from stream URL's domain">
        <span class="material-symbols-rounded">image_search</span> Auto
      </button>
    </div>
    <input class="form-input" type="url" bind:value={stationIcon} placeholder="https://…/icon.png" />
  </div>
</Dialog>

<!-- Rename group dialog -->
<Dialog bind:open={showRenameGroup}
  title={$_('radio.rename_group')}
  confirmText="Save"
  cancelText="Cancel"
  on:confirm={saveRenameGroup}>
  <div class="station-form">
    <label class="form-label">{$_('radio.new_name')} <span class="optional">{$_('radio.leave_empty_ungroup')}</span></label>
    <input class="form-input" type="text" bind:value={renameGroupNew} placeholder="e.g. Italian, Workout" autofocus />
  </div>
</Dialog>

<!-- Context menu -->
{#if ctxTrack}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="ctx-backdrop" on:click={() => ctxTrack = null}></div>
  <div class="ctx-menu" bind:this={ctxMenuEl} style="left:{ctxPos.x}px;top:{ctxPos.y}px">
    <button class="ctx-item" on:click={ctxPlayNext}>
      <span class="material-symbols-rounded" style="font-size:18px">skip_next</span> Play next
    </button>
    <button class="ctx-item" on:click={ctxAddToQueue}>
      <span class="material-symbols-rounded" style="font-size:18px">queue_music</span> Add to queue
    </button>
  </div>
{/if}

<style>
  /* Note: no overflow-x here. body already clips horizontal in
     App.svelte (:global(body) { overflow-x: hidden }), and any
     overflow value other than `visible` on this wrapper would trap
     position: sticky inside it — the page-header + radio-bar wouldn't
     stick because .page itself doesn't scroll. */
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  .back-btn {
    background: none; border: none; cursor: pointer; color: var(--text-2);
    padding: 6px; border-radius: var(--radius-sm); display: flex;
  }

  /* The whole top stack — banner/header, tab pill bar, search bar —
     pins as a single unit. This sidesteps the previous bug where each
     bar had its own sticky `top` calc that didn't account for banner
     vs no-banner header heights, so the lower bars vanished under the
     header on scroll. */
  .sticky-top {
    position: sticky; top: 0; z-index: 10;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
  }
  /* Defeat the global page-header sticky inside our wrapper — the
     wrapper is the one doing the pinning now. Otherwise the header's
     own sticky competes and produces inconsistent behavior.
     `!important` here because base.css's `.page-header.banner-animated`
     rule has equal specificity (2 classes vs 2 classes) and Vite's CSS
     injection order isn't reliable between this scoped block and the
     global base — without !important the cascade is a coin flip and
     Animated mode lost on real builds, breaking the wrapper's pin. */
  .sticky-top :global(.page-header) {
    position: static !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    overflow: visible !important;     /* base's overflow:hidden on .banner-animated
                                         created a block formatting context that
                                         broke the wrapper's sticky on Radio's
                                         3-row stack specifically. */
  }
  /* Hide the animation pseudos when Animated mode is selected on Radio.
     The radial / cloud-of-light pseudos in base.css depend on the
     page-header being its own positioned containing block with
     overflow:hidden — neither is true once the override above strips
     those properties. Without hiding them, they paint relative to
     .sticky-top and bleed into the radio-bar + search-bar. Animated
     on Radio visually matches Gradient (same accent background); the
     other three pages with .sticky-top wrappers still animate normally
     because their CSS doesn't carry this override. */
  .sticky-top :global(.page-header.banner-animated::before),
  .sticky-top :global(.page-header.banner-animated::after) {
    display: none !important;
  }
  /* Strip the header bg so the .sticky-top wrapper's glass shows through,
     EXCEPT for the saturated-accent variants (Gradient and Animated),
     which are meant to repaint the bar with their own background. Both
     need to be excluded explicitly here; missing either makes Radio's
     header read as transparent in that mode while every other page's
     header looks accent-tinted. If a new banner-style class lands later,
     add it to this exclusion list too. */
  .sticky-top :global(.page-header:not(.banner-gradient):not(.banner-animated)) {
    background: transparent;
  }

  .radio-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px var(--page-px);
    border-bottom: 1px solid var(--border);
    gap: 8px; min-width: 0;
  }

  /* Search bar: own row directly below .radio-bar, still inside the
     pinned stack. Stays visible while results scroll underneath. */
  .radio-search-bar {
    display: flex; gap: 6px;
    padding: 8px var(--page-px);
    border-bottom: 1px solid var(--border);
  }
  .radio-search-bar .search-input { flex: 1; min-width: 0; height: 38px; }
  .radio-tabs {
    display: flex; gap: 4px;
    flex: 1; min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;          /* Firefox */
    -ms-overflow-style: none;       /* old Edge */
    /* Soft right-edge fade hints there's more to scroll on mobile. */
    -webkit-mask-image: linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%);
            mask-image: linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%);
  }
  .radio-tabs::-webkit-scrollbar { display: none; }
  .radio-tab {
    flex-shrink: 0;
    padding: 6px 12px; border-radius: var(--radius-full);
    background: none; border: 1px solid var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .radio-tab.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .radio-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .icon-btn {
    width: 34px; height: 34px;
    border-radius: var(--radius-full);
    background: none; border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all var(--dur-fast);
    padding: 0;
  }
  .icon-btn:hover { background: var(--surface-2); color: var(--text-1); }
  .icon-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .icon-btn .material-symbols-rounded { font-size: 18px; }
  /* Outline by default to match the tab pills — fills with accent on
     hover/active so the button signals tappability without dominating
     the bar visually. */
  .shuffle-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 12px; border-radius: var(--radius-full);
    background: none; border: 1px solid var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .shuffle-btn:hover:not(:disabled),
  .shuffle-btn:active:not(:disabled) {
    background: var(--accent-dim); border-color: var(--accent); color: var(--accent);
  }
  .shuffle-btn:disabled { opacity: 0.4; cursor: default; }
  .shuffle-btn .material-symbols-rounded { font-size: 16px; }

  .radio-content { padding: 12px var(--page-px); }

  .loading-state { text-align: center; padding: 48px; }
  .spin { animation: radio-spin 0.8s linear infinite; }
  @keyframes radio-spin { to { transform: rotate(360deg); } }

  .empty-state { text-align: center; padding: 48px 16px; color: var(--text-3); }
  .empty-state p { font-size: 14px; margin-top: 8px; }

  /* Streaming stations */
  .add-station-btn {
    display: flex; align-items: center; gap: 6px;
    height: 38px; font-size: 13px;
    margin-bottom: 12px;
  }
  .station-row {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .station-row:last-child { border-bottom: none; }
  .station-group-header {
    display: flex; align-items: center; gap: 6px;
    margin: 16px 0 4px;
    padding: 6px 8px; border-radius: var(--radius-md);
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-3);
    cursor: pointer;
    user-select: none;
    transition: background var(--dur-fast);
  }
  .station-group-header:hover { background: var(--surface-2); color: var(--text-2); }
  .station-group-header:first-of-type { margin-top: 8px; }
  .group-chev { font-size: 18px; transition: transform var(--dur-fast); }
  .group-chev.collapsed { transform: rotate(-90deg); }
  .group-name { flex: 1; }
  .group-count {
    font-size: 10px; font-weight: 600;
    padding: 1px 7px; border-radius: var(--radius-full);
    background: var(--surface-2); color: var(--text-3);
  }
  .group-rename-btn {
    width: 24px; height: 24px; border-radius: 6px;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); display: flex; align-items: center; justify-content: center;
    padding: 0; opacity: 0.6;
  }
  .group-rename-btn:hover { background: var(--surface-2); color: var(--text-1); opacity: 1; }
  .group-rename-btn .material-symbols-rounded { font-size: 14px; }
  .station-reorder {
    display: flex; flex-direction: column; gap: 2px;
    flex-shrink: 0;
  }
  .reorder-btn {
    width: 26px; height: 22px; border-radius: 6px;
    background: none; border: 1px solid var(--border);
    color: var(--text-3); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    padding: 0;
  }
  .reorder-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--text-1); }
  .reorder-btn:disabled { opacity: 0.3; cursor: default; }
  .reorder-btn .material-symbols-rounded { font-size: 16px; }
  /* Touch targets get bumped on coarse-pointer devices. Apple/Android HIG
     recommend ≥ 40–44px for tap targets; 26×22 was cramped with thumbs. */
  @media (hover: none) and (pointer: coarse) {
    .reorder-btn { width: 40px; height: 36px; }
    .reorder-btn .material-symbols-rounded { font-size: 20px; }
  }

  /* Stations sub-tabs with sliding pill indicator */
  .station-sub-tabs {
    position: relative;
    display: flex; margin: 0 0 14px;
    padding: 4px; background: var(--surface-2);
    border-radius: var(--radius-full); width: fit-content;
    isolation: isolate;
  }
  .sub-tab-pill {
    position: absolute;
    top: 4px; left: 4px;
    width: calc(50% - 4px); height: calc(100% - 8px);
    background: var(--accent);
    border-radius: var(--radius-full);
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    z-index: 0;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .station-sub-tabs[data-active="browse"] .sub-tab-pill { transform: translateX(100%); }
  .sub-tab {
    position: relative;
    z-index: 1;
    padding: 6px 18px; border-radius: var(--radius-full);
    border: none; background: none; color: var(--text-2);
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit;
    transition: color 0.2s;
    min-width: 110px;
  }
  .sub-tab.active { color: var(--accent-text, #fff); }

  /* Field header with Auto button */
  .field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .auto-btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid var(--accent); font-size: 11px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  .auto-btn:hover:not(:disabled) { opacity: 0.85; }
  .auto-btn:disabled { opacity: 0.4; cursor: default; }
  .auto-btn .material-symbols-rounded { font-size: 13px; }

  /* Drag-and-drop styling */
  .drag-handle {
    color: var(--text-3); opacity: 0.5;
    cursor: grab; font-size: 18px;
    flex-shrink: 0;
  }
  .drag-handle:active { cursor: grabbing; }
  .station-row.dragging { opacity: 0.5; }
  .station-row.drag-over {
    background: var(--accent-dim);
    border-radius: var(--radius-md);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .station-group-header.drag-over-group {
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius-md);
    padding: 6px 8px;
  }
  @media (hover: none) { .drag-handle { display: none; } }

  /* Now-playing (pulses) */
  .now-playing { color: var(--accent); font-weight: 600; animation: np-pulse 2.5s ease-in-out infinite; }
  @keyframes np-pulse { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }

  /* Radio-Browser search — native pill-style */
  .rb-search {
    position: relative;
    display: flex; align-items: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 0 10px 0 36px;
    height: 40px;
    margin: 4px 0 8px;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .rb-search:focus-within {
    border-color: var(--accent);
    background: var(--surface-1);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .rb-search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--text-3); font-size: 18px;
    pointer-events: none;
  }
  .rb-search-input {
    flex: 1;
    border: none; outline: none; background: none;
    color: var(--text-1);
    font-size: 14px; font-family: inherit;
    padding: 0;
    height: 100%;
    -webkit-appearance: none; appearance: none;
  }
  .rb-search-input::placeholder { color: var(--text-3); }
  /* Hide the native clear button on Chrome/Safari — we provide our own */
  .rb-search-input::-webkit-search-cancel-button,
  .rb-search-input::-webkit-search-decoration { -webkit-appearance: none; display: none; }
  .rb-search-clear {
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--text-3); color: var(--surface-1);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; opacity: 0.7;
    transition: opacity var(--dur-fast);
  }
  .rb-search-clear:hover { opacity: 1; }
  .rb-search-clear .material-symbols-rounded { font-size: 14px; font-weight: 700; }
  .rb-attribution {
    font-size: 11px; color: var(--text-3);
    margin: 0 0 14px 4px;
  }
  .rb-attribution a { color: var(--text-3); text-decoration: underline; }
  .rb-attribution a:hover { color: var(--accent); }

  .loading-inline {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 24px; color: var(--text-3); font-size: 13px;
  }
  .loading-inline .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .station-main {
    flex: 1; display: flex; align-items: center; gap: 12px;
    background: none; border: none; cursor: pointer;
    padding: 0; text-align: left; min-width: 0;
  }
  .station-icon {
    width: 44px; height: 44px; border-radius: 8px;
    object-fit: cover; background: var(--surface-2); flex-shrink: 0;
  }
  .station-icon-fallback {
    width: 44px; height: 44px; border-radius: 8px;
    background: var(--accent-dim); color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; flex-shrink: 0;
  }
  .station-action {
    background: none; border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    width: 34px; height: 34px; border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .station-action:hover { background: var(--surface-2); color: var(--text-1); }
  .station-action.danger:hover { background: rgba(255,92,92,0.1); color: var(--danger); border-color: var(--danger); }
  .station-action .material-symbols-rounded { font-size: 18px; }

  /* Browse result already in My Stations */
  .station-row.rb-already .station-main { opacity: 0.55; cursor: default; }
  .rb-added-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 10px; border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--success, #2FD66F) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--success, #2FD66F) 40%, transparent);
    color: var(--success, #2FD66F);
    font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  .rb-added-chip .material-symbols-rounded { font-size: 14px; }

  .station-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
  .station-form .form-label {
    font-size: 12px; font-weight: 600; color: var(--text-2);
    margin-bottom: -4px;
  }
  .station-form .form-label .optional {
    font-weight: 400; color: var(--text-3); font-size: 11px;
  }
  .station-form .form-input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none; width: 100%;
  }
  .station-form .form-input:focus { border-color: var(--accent); }

  /* Album grid */
  .album-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
  }
  .album-card {
    display: flex; flex-direction: column; gap: 6px;
    background: none; border: none; cursor: pointer;
    text-align: left; padding: 0;
    transition: transform var(--dur-fast);
  }
  .album-card:hover { transform: translateY(-2px); }
  .album-art {
    width: 100%; aspect-ratio: 1;
    border-radius: var(--radius-md);
    object-fit: cover; background: var(--surface-2);
  }
  .album-name {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .album-artist { font-size: 11px; color: var(--text-3); }

  /* Track rows */
  .track-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 10px 0;
    background: none; border: none; cursor: pointer;
    text-align: left; border-bottom: 1px solid var(--border);
    transition: background var(--dur-fast);
  }
  .track-row:hover { background: var(--surface-2); }
  .track-art {
    width: 44px; height: 44px; border-radius: var(--radius-sm);
    object-fit: cover; background: var(--surface-2); flex-shrink: 0;
  }
  .track-num {
    width: 24px; text-align: center;
    font-size: 13px; color: var(--text-3); font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .track-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .track-title {
    font-size: 14px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .track-meta { font-size: 12px; color: var(--text-3); }

  /* Artist rows */
  .artist-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 12px 0;
    background: none; border: none; cursor: pointer;
    text-align: left; border-bottom: 1px solid var(--border);
  }
  .artist-row:hover { background: var(--surface-2); }
  .artist-name { flex: 1; font-size: 14px; font-weight: 500; color: var(--text-1); }
  .artist-count { font-size: 12px; color: var(--text-3); }

  /* Detail header */
  .detail-header {
    display: flex; flex-direction: column; align-items: center;
    gap: 12px; padding: 0 0 16px; text-align: center;
  }
  .detail-art {
    width: 200px; height: 200px; border-radius: var(--radius-lg);
    object-fit: cover; background: var(--surface-2);
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .detail-info { display: flex; flex-direction: column; gap: 4px; }
  .detail-title { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .detail-meta { font-size: 13px; color: var(--text-3); }
  .detail-actions { display: flex; gap: 8px; justify-content: center; }

  /* Search input — lives in .search-row inside .radio-bar above. */
  .search-input {
    flex: 1; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-full); padding: 10px 16px;
    color: var(--text-1); font-size: 14px; font-family: inherit; outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .result-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-3);
    padding: 12px 0 6px; margin: 0;
  }

  /* Now playing indicator */
  .track-row.now-playing { background: var(--accent-dim); }
  .track-row.now-playing .track-title { color: var(--accent); }
  .station-row.now-playing-row {
    background: var(--accent-dim);
    border-radius: var(--radius-md);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .station-row.now-playing-row .track-title { color: var(--accent); }
  .np-icon {
    font-size: 20px; color: var(--accent);
    width: 44px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }

  /* Animated equalizer — three bars at different keyframe offsets so the
     now-playing row visibly pulses in the list. Replaces the static
     `equalizer` icon for a more alive feel. Bars pause when the user
     pauses playback via .paused-eq on the parent if needed (controlled
     by the player store; for now they animate whenever the row is the
     now-playing one). */
  .now-eq {
    width: 44px; height: 44px;
    display: inline-flex; align-items: flex-end; justify-content: center;
    gap: 2px; flex-shrink: 0;
    padding-bottom: 12px;
  }
  .now-eq > span {
    display: block;
    width: 3px; height: 6px;
    background: var(--accent);
    border-radius: 1px;
    animation: eq-bounce 1s ease-in-out infinite;
    transform-origin: bottom;
  }
  .now-eq > span:nth-child(1) { animation-delay: 0s; }
  .now-eq > span:nth-child(2) { animation-delay: -0.25s; }
  .now-eq > span:nth-child(3) { animation-delay: -0.5s; }
  @keyframes eq-bounce {
    0%, 100% { height: 6px; }
    50%      { height: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .now-eq > span { animation: none; height: 12px; }
  }

  /* Star (favorite) toggle on track rows. Empty outline by default, fills
     to accent gold when starred. Inherits the row's hover bg. */
  .star-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3);
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm); flex-shrink: 0;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .star-btn:hover { color: var(--text-1); background: var(--surface-2); }
  .star-btn .material-symbols-rounded { font-size: 18px; transition: transform 0.2s ease; }
  .star-btn .filled { color: #ffc107; }
  .star-btn.starred .material-symbols-rounded { color: #ffc107; }
  .star-btn:active .material-symbols-rounded { transform: scale(1.2); }

  /* Context menu */
  .ctx-backdrop { position: fixed; inset: 0; z-index: 100; }
  .ctx-menu {
    position: fixed; z-index: 101;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
    min-width: 160px; overflow: hidden;
  }
  .ctx-item {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 12px 16px;
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font-size: 14px; text-align: left;
  }
  .ctx-item:hover { background: var(--surface-2); }
  .ctx-item + .ctx-item { border-top: 1px solid var(--border); }

  /* Mobile default — rails hidden. Radio-body is a plain block so
     the existing sticky-top + radio-content stack is unchanged. */
  .radio-source-rail { display: none; }
  .radio-now-playing { display: none; }

  /* ────────────────────────────────────────────────────────────
     Radio Phase 1 wide layout (>=1280px, non-forced-mobile).
     Three-column shell — source rail | tab content | Now Playing
     hero — that turns Radio from "a mobile page shown on a big
     screen" into a workout-audience surface: rail owns fast
     navigation, hero always shows what's playing without expanding
     the MiniPlayer / FullPlayer modal. */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .radio-body {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 340px;
      gap: 20px;
      align-items: start;
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px var(--page-px);
      box-sizing: border-box;
    }
    :global(html:not(.force-mobile-layout)) .radio-body > .radio-content {
      min-width: 0;
    }
    /* Hide the horizontal tab pill row on wide — the left rail owns
       nav. Same for the radio-bar's action buttons (search, Mix/
       Random). Search moves to the rail; Mix/Random live in the
       Now Playing hero controls / accessible via context menu. */
    :global(html:not(.force-mobile-layout)) .sticky-top > .radio-bar {
      display: none;
    }
    /* Banner stays full-viewport-width at wide (matches Diary /
       Settings / Programs pattern). No cap here — the sticky-top
       is a 'hat' across the whole top; the grid below aligns to
       its own max-width. */
    /* Bump album grid density from 140px minmax to 200px so covers
       stay legible on wide monitors instead of shrinking to 9-10
       tiny cards per row. */
    :global(html:not(.force-mobile-layout)) .radio-body :global(.album-grid) {
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    }

    /* Left source rail — same visual language as the Statistics
       and Settings rails (surface-1 card, sticky). */
    :global(html:not(.force-mobile-layout)) .radio-body > .radio-source-rail {
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 60px + var(--hamburger-row, 0px));
      align-self: start;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - 150px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      padding: 10px 8px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    .rsr-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .rsr-group-title {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-3);
      font-weight: 600;
      padding: 4px 8px;
      margin-top: 8px;
    }
    .rsr-group:first-child .rsr-group-title { margin-top: 0; }
    .rsr-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 36px;
      padding: 8px 10px;
      border-radius: var(--radius-md);
      background: transparent;
      border: none;
      color: var(--text-1);
      font-size: 13px;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: background var(--dur-fast), color var(--dur-fast);
    }
    .rsr-btn:hover { background: var(--surface-2); }
    .rsr-btn.active {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent);
    }
    .rsr-btn.active .material-symbols-rounded { color: var(--accent); }
    .rsr-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      background: var(--surface-2);
    }
    .rsr-btn .material-symbols-rounded {
      font-size: 18px;
      color: var(--text-3);
      flex-shrink: 0;
    }

    /* Right Now Playing hero — sticky with a cover-tinted backdrop
       gradient so a lifter mid-set sees what's playing at a glance
       without opening the FullPlayer modal. --rnp-bg is set inline
       from the JS extractor. Falls back to surface-2 when nothing
       is playing so the card still occupies a stable slot. */
    :global(html:not(.force-mobile-layout)) .radio-body > .radio-now-playing {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 20px 18px;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      color: var(--text-1);
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 60px + var(--hamburger-row, 0px));
      align-self: start;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - 150px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow: hidden;
      /* Tinted gradient using the cover's dominant color. When the
         extractor hasn't run (empty state), --rnp-bg falls back to
         surface-2 so the card stays legible. */
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--rnp-bg) 55%, var(--surface-1)),
          color-mix(in srgb, var(--rnp-bg) 15%, var(--surface-1)) 60%,
          var(--surface-1));
      transition: background 400ms ease;
    }
    .rnp-cover-wrap {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: var(--radius-md);
      overflow: hidden;
      background: rgba(0, 0, 0, 0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .rnp-cover {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .rnp-cover-fallback {
      font-size: 64px;
      color: rgba(255, 255, 255, 0.5);
    }
    .rnp-meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .rnp-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-1);
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .rnp-sub {
      font-size: 13px;
      color: var(--text-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rnp-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 4px;
    }
    .rnp-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-1);
      cursor: pointer;
      transition: background var(--dur-fast), transform var(--dur-fast);
    }
    .rnp-btn:hover { background: rgba(255, 255, 255, 0.2); }
    .rnp-btn:active { transform: scale(0.94); }
    .rnp-btn .material-symbols-rounded { font-size: 22px; }
    .rnp-btn-primary {
      width: 56px;
      height: 56px;
      background: var(--accent);
      color: var(--surface-1);
      border-color: var(--accent);
    }
    .rnp-btn-primary .material-symbols-rounded { font-size: 32px; }
    .rnp-btn-primary:hover { filter: brightness(1.08); background: var(--accent); }
    .rnp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      padding: 40px 12px;
      color: var(--text-3);
    }
    .rnp-empty-icon { font-size: 40px; opacity: 0.6; }
    .rnp-empty-title { margin: 4px 0 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
    .rnp-empty-desc { margin: 0; font-size: 12px; line-height: 1.5; max-width: 240px; }

    /* Queue list — feature parity with FullPlayer's queue view,
       inline in the hero. Compact rows: 32px cover + title/artist
       stacked, remove-from-queue button on the right. Wrapper
       scrolls internally so the hero doesn't grow unbounded. */
    .rnp-queue {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      min-height: 0;
      overflow: hidden;
    }
    .rnp-queue-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.7);
    }
    .rnp-queue-head .material-symbols-rounded { font-size: 14px; }
    .rnp-queue-title { flex: 1; min-width: 0; }
    .rnp-queue-count {
      padding: 1px 6px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 999px;
      font-size: 10px;
    }
    .rnp-queue-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow-y: auto;
      min-height: 0;
    }
    .rnp-queue-row {
      display: flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border-radius: 6px;
      transition: background var(--dur-fast);
    }
    .rnp-queue-row:hover { background: rgba(255, 255, 255, 0.08); }
    .rnp-queue-play {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      padding: 4px 6px;
      background: transparent;
      border: none;
      color: var(--text-1);
      text-align: left;
      cursor: pointer;
    }
    .rnp-queue-cover {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .rnp-queue-cover-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.6);
      font-size: 18px;
      flex-shrink: 0;
    }
    .rnp-queue-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
    .rnp-queue-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rnp-queue-sub {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rnp-queue-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.5);
      border-radius: 4px;
      cursor: pointer;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity var(--dur-fast), color var(--dur-fast);
    }
    .rnp-queue-row:hover .rnp-queue-remove { opacity: 1; }
    .rnp-queue-remove:hover { color: var(--danger); background: rgba(255, 255, 255, 0.1); }
    .rnp-queue-remove .material-symbols-rounded { font-size: 16px; }

    /* Hide the App-level MiniPlayer on the Radio route at wide
       widths — the on-page Now Playing hero is a richer replacement
       and the two would create redundant transport controls. Uses
       the html.lt-route-radio stamp set on this route's mount/
       destroy. Other routes still get the MiniPlayer. */
    :global(html.lt-route-radio:not(.force-mobile-layout)) :global(.mini-player) {
      display: none;
    }

    /* Stations header row — sub-tab pill + Add-station button
       inline instead of stacked, so the tab chrome doesn't take
       three vertical bands before the first group. */
    :global(html:not(.force-mobile-layout)) .stations-header-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    :global(html:not(.force-mobile-layout)) .stations-header-row > .add-station-btn {
      margin: 0;
      margin-left: auto;
    }
    /* Station list becomes a 2-col grid so rows stop stretching
       into 1000px+ single-line strips. Group header still spans
       full width above (it's outside .station-list). */
    :global(html:not(.force-mobile-layout)) .station-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 8px;
    }
    /* Zero .radio-content top padding on wide so the tab body
       starts flush with the source rail + Now Playing hero (all
       three grid children align at grid-row-1 top). Mobile keeps
       the 12px top padding from the base .radio-content rule. */
    :global(html:not(.force-mobile-layout)) .radio-body > .radio-content {
      padding-top: 0;
    }

    /* ── Phase 2: detail view + list-row polish ─────────────────
       Detail views (Album / Artist / Playlist) previously centered
       a 200px cover in an infinite column with track list below —
       lots of dead space at wide widths. Turn the header into a
       proper hero row (bigger art left, meta + actions right), and
       cap track/artist row widths so they don't stretch into
       1000px+ single-line strips with the action buttons floating
       far from the row content. */
    :global(html:not(.force-mobile-layout)) .radio-body .detail-header {
      flex-direction: row;
      align-items: flex-end;
      text-align: left;
      gap: 20px;
      padding: 8px 0 20px;
      flex-wrap: wrap;
    }
    :global(html:not(.force-mobile-layout)) .radio-body .detail-art {
      width: 240px;
      height: 240px;
      flex-shrink: 0;
    }
    :global(html:not(.force-mobile-layout)) .radio-body .detail-info {
      flex: 1;
      min-width: 200px;
    }
    :global(html:not(.force-mobile-layout)) .radio-body .detail-title {
      font-size: 28px;
      line-height: 1.15;
    }
    :global(html:not(.force-mobile-layout)) .radio-body .detail-meta {
      font-size: 14px;
      margin-top: 4px;
    }
    :global(html:not(.force-mobile-layout)) .radio-body .detail-actions {
      justify-content: flex-start;
      flex-shrink: 0;
    }
    /* Track + artist list rows: cap at ~800px so the action buttons
       stay near the row content instead of floating far right. Center
       the capped list within the center column so long tracklists
       read like a proper list, not a stretched strip. */
    :global(html:not(.force-mobile-layout)) .radio-body :global(.track-row),
    :global(html:not(.force-mobile-layout)) .radio-body :global(.artist-row) {
      max-width: 800px;
      margin-left: auto;
      margin-right: auto;
    }
  }
</style>
