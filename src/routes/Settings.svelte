<script>
  import { onMount, tick } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import { push, querystring } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { currentUser, userMgmtActive } from '../stores/auth.js';
  import { accentColor, applyAccentColor, pageBanners, bannerStyle } from '../stores/settings.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import SettingsAbout from '../components/settings/SettingsAbout.svelte';
  import SettingsUpdates from '../components/settings/SettingsUpdates.svelte';
  import SettingsAppearance from '../components/settings/SettingsAppearance.svelte';
  import SettingsUnits from '../components/settings/SettingsUnits.svelte';
  import SettingsWorkout from '../components/settings/SettingsWorkout.svelte';
  import SettingsStatistics from '../components/settings/SettingsStatistics.svelte';
  import SettingsTrace from '../components/settings/SettingsTrace.svelte';
  import SettingsRadio from '../components/settings/SettingsRadio.svelte';
  import SettingsFederation from '../components/settings/SettingsFederation.svelte';
  import SettingsCatalog from '../components/settings/SettingsCatalog.svelte';
  import SettingsBackup from '../components/settings/SettingsBackup.svelte';
  import SettingsWorkoutImport from '../components/settings/SettingsWorkoutImport.svelte';
  import SettingsNotifications from '../components/settings/SettingsNotifications.svelte';
  import SettingsEmail from '../components/settings/SettingsEmail.svelte';
  import SettingsUserManagement from '../components/settings/SettingsUserManagement.svelte';
  import SettingsAuth from '../components/settings/SettingsAuth.svelte';
  import SettingsDiagnostics from '../components/settings/SettingsDiagnostics.svelte';
  import Sheet from '../components/ui/Sheet.svelte';
  import { portal } from '../lib/portal.js';
  import {
    isNative, getNativeMode, setNativeMode, getServerUrl, setServerUrl,
    getAuthToken, setAuthToken, resolveAssetUrl, explainConnectError,
  } from '../lib/platform.js';

  // ── Server Connection (native only) ─────────────────────────────────────
  let serverUrlInput = getServerUrl() || '';
  let serverUsername = '';
  let serverPassword = '';
  let serverShowPw = false;
  let serverConnecting = false;
  let serverMode = getNativeMode(); // 'local' | 'server'
  // True when running as a standalone phone app (hide multi-user / server
  // features). Reactive on serverMode so the UI updates instantly when the
  // user disconnects, without waiting for the post-disconnect reload.
  $: localOnly = isNative && (serverMode !== 'server' || !getServerUrl());

  // ── Sync state + manual trigger ────────────────────────────────────────
  let lastSyncAt = null;
  let _nowTick = Date.now(); // re-render the "X ago" label every 30s
  let _syncing = false;

  onMount(() => {
    refreshSyncStatus();
    const t = setInterval(() => { _nowTick = Date.now(); }, 30000);
    window.addEventListener('lt:sync-complete', refreshSyncStatus);
    return () => {
      clearInterval(t);
      window.removeEventListener('lt:sync-complete', refreshSyncStatus);
    };
  });

  async function refreshSyncStatus() {
    if (!isNative || serverMode !== 'server') return;
    try {
      const { getSyncStatus } = await import('../lib/sync.js');
      const s = await getSyncStatus();
      lastSyncAt = s?.lastPullAt || null;
    } catch {}
  }

  async function manualSync() {
    if (_syncing) return;
    _syncing = true;
    try {
      const { runSync } = await import('../lib/sync.js');
      await runSync();
      await refreshSyncStatus();
      showSuccess($_('settings_main.toast.synced'));
    } catch (e) {
      showError(e.message || $_('settings_main.toast.sync_failed'));
    } finally {
      _syncing = false;
    }
  }

  function _fmtTimeAgo(iso) {
    if (!iso) return 'never';
    const ms = _nowTick - new Date(iso).getTime();
    if (ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 10)  return 'just now';
    if (s < 60)  return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  // ── Server connect / merge flow ────────────────────────────────────────
  let mergeStep = null;  // null | 'ask-settings' | 'syncing' | 'summary'
  let mergeProgress = '';
  let mergeProgressPct = 0;
  let mergeStage = '';
  let _pendingServerUrl = '';
  let localCounts = null;   // counts from migrate.countLocalData()
  let migrationSummary = null;

  async function connectServer() {
    if (!serverUrlInput.trim()) { showError($_('settings_main.toast.server_url_required')); return; }
    if (!serverUsername.trim() || !serverPassword.trim()) { showError($_('settings_main.toast.credentials_required')); return; }
    const url = serverUrlInput.trim().replace(/\/$/, '');
    serverConnecting = true;
    try {
      // Use CapacitorHttp on native to bypass CORS (WebView fetch can't reach external origins)
      let loginData;
      if (isNative) {
        const { CapacitorHttp } = await import('@capacitor/core');
        const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
        if (healthRes.status < 200 || healthRes.status >= 300) throw new Error('Server not reachable');
        const loginRes = await CapacitorHttp.post({
          url: `${url}/api/auth/login`,
          headers: { 'Content-Type': 'application/json' },
          data: { username: serverUsername.trim(), password: serverPassword },
        });
        loginData = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
        if (loginRes.status < 200 || loginRes.status >= 300) throw new Error(loginData.error || 'Login failed');
      } else {
        const healthRes = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (!healthRes.ok) throw new Error('Server not reachable');
        const loginRes = await fetch(`${url}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: serverUsername.trim(), password: serverPassword }),
        });
        loginData = await loginRes.json();
        if (!loginRes.ok) throw new Error(loginData.error || 'Login failed');
      }

      _pendingServerUrl = url;
      if (loginData.token) setAuthToken(loginData.token);
      if (loginData.user?.id) localStorage.setItem('wl:userId', String(loginData.user.id));

      // Count local data so the merge dialog can show what's about to move
      const { countLocalData } = await import('../lib/migrate.js');
      localCounts = await countLocalData();

      if (localCounts.total > 0) {
        mergeStep = 'ask-settings';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      serverConnecting = false;
    }
  }

  async function _mergeAndConnect(mode) {
    mergeStep = 'syncing';
    mergeProgress = '';
    mergeProgressPct = 0;
    mergeStage = '';
    migrationSummary = null;

    try {
      if (mode === 'upload' || mode === 'merge') {
        // Switch into server mode before uploading so apiFetch routes the
        // writes to the remote instead of intercepting them as local SQLite.
        setServerUrl(_pendingServerUrl);
        setNativeMode('server');

        const { uploadLocalToServer } = await import('../lib/migrate.js');
        const stageLabels = {
          settings:        'settings',
          workouts:        'workouts',
          bodyStats:       'body stats',
          programs:        'programs',
          templates:       'templates',
          customExercises: 'custom exercises',
        };
        migrationSummary = await uploadLocalToServer({
          onProgress: (stage, current, total) => {
            mergeStage = stageLabels[stage] || stage;
            mergeProgress = `Uploading ${mergeStage} (${current + 1} / ${total})`;
            mergeProgressPct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
          },
        });
      }

      // mode === 'download' or 'merge': server data is pulled on reload via
      // runSync(). mode === 'upload': server settings stay, local data
      // pushed up.

      if (migrationSummary && (migrationSummary.errors.length > 0 || migrationSummary.totalSuccess > 0)) {
        mergeStep = 'summary';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      mergeStep = null;
      showError($_('settings_main.toast.sync_failed_prefix', { values: { error: e.message || $_('settings_main.toast.unknown_error') } }));
    }
  }

  function _finalizeConnect() {
    setServerUrl(_pendingServerUrl);
    setNativeMode('server');
    serverMode = 'server';
    mergeStep = null;
    showSuccess($_('settings_main.toast.connected'));
    setTimeout(() => window.location.reload(), 600);
  }

  function cancelMerge() {
    mergeStep = null;
    _pendingServerUrl = '';
    localCounts = null;
    migrationSummary = null;
  }

  async function disconnectServer() {
    setServerUrl(null);
    setAuthToken(null);
    setNativeMode('local');

    localStorage.removeItem('wl:userId');

    currentUser.set(null);
    userMgmtActive.set(false);

    serverMode = 'local';
    serverUrlInput = '';
    serverUsername = '';
    serverPassword = '';

    showSuccess($_('settings_main.toast.disconnected'));
    setTimeout(() => window.location.reload(), 600);
  }

  async function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    try {
      const { logout } = await import('../stores/auth.js');
      await logout();
    } catch {}
    setTimeout(() => window.location.reload(), 300);
  }

  // AI model handling moved into SettingsTrace.svelte

  const ACCENTS = [
    { id: 'orange', label: 'Iron',    color: '#FF7433' },
    { id: 'mint',   label: 'Mint',    color: '#4FFFB0' },
    { id: 'blue',   label: 'Blue',    color: '#4FC3F7' },
    { id: 'red',    label: 'Red',     color: '#FF7070' },
    { id: 'purple', label: 'Purple',  color: '#CE93D8' },
    { id: 'teal',   label: 'Teal',    color: '#4DD0E1' },
    { id: 'yellow', label: 'Gold',    color: '#FFF176' },
    { id: 'indigo', label: 'Indigo',  color: '#9FA8DA' },
    { id: 'pink',   label: 'Pink',    color: '#F48FB1' },
    { id: 'rose',   label: 'Rose',    color: '#FF80AB' },
    { id: 'cyan',   label: 'Cyan',    color: '#80DEEA' },
    { id: 'lime',   label: 'Lime',    color: '#C5E1A5' },
  ];

  const START_PAGES = [
    { value: '/',           label: 'Diary'      },
    { value: '/exercises',  label: 'Exercises'  },
    { value: '/programs',   label: 'Programs'   },
    { value: '/statistics', label: 'Statistics' },
    { value: '/settings',   label: 'Settings'   },
  ];

  // ── Custom accent color (HSL/RGB/Hex picker — matches NutriTrace) ────────
  $: isCustomHex = /^#[0-9a-fA-F]{6}$/.test($accentColor);
  let customColorHex = isCustomHex ? $accentColor : '#FF7433';
  let customHexInput = customColorHex;
  let showColorSheet = false;
  let cpHue = 20, cpSat = 100, cpLgt = 60;
  let cpR = 255, cpG = 116, cpB = 51;

  function _hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  function _hexToHsl(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      switch(max) {
        case r: h = ((g-b)/d + (g<b?6:0))/6; break;
        case g: h = ((b-r)/d + 2)/6; break;
        case b: h = ((r-g)/d + 4)/6; break;
      }
    }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }
  function _syncRgbFromHex(hex) {
    cpR = parseInt(hex.slice(1,3),16);
    cpG = parseInt(hex.slice(3,5),16);
    cpB = parseInt(hex.slice(5,7),16);
  }
  function openColorSheet() {
    const cur = isCustomHex ? $accentColor : '#FF7433';
    customColorHex = cur;
    customHexInput = cur;
    [cpHue, cpSat, cpLgt] = _hexToHsl(cur);
    _syncRgbFromHex(cur);
    showColorSheet = true;
  }
  function cpUpdateFromSliders() {
    customColorHex = _hslToHex(cpHue, cpSat, cpLgt);
    customHexInput = customColorHex;
    _syncRgbFromHex(customColorHex);
    applyAccentColor(customColorHex);
  }
  function cpUpdateFromHex() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) {
      customColorHex = customHexInput;
      [cpHue, cpSat, cpLgt] = _hexToHsl(customHexInput);
      _syncRgbFromHex(customHexInput);
      applyAccentColor(customHexInput);
    }
  }
  function cpUpdateFromRgb() {
    const r = Math.min(255, Math.max(0, cpR || 0));
    const g = Math.min(255, Math.max(0, cpG || 0));
    const b = Math.min(255, Math.max(0, cpB || 0));
    cpR = r; cpG = g; cpB = b;
    const hex = '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
    customColorHex = hex;
    customHexInput = hex;
    [cpHue, cpSat, cpLgt] = _hexToHsl(hex);
    applyAccentColor(hex);
  }
  function applyCustomColor() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) {
      applyAccentColor(customHexInput);
    }
    showColorSheet = false;
  }

  // ── Search ───────────────────────────────────────────────────────────────
  let settingsSearch = '';
  $: settingsQuery = settingsSearch.toLowerCase().trim();

  const SECTION_KEYWORDS = {
    profile:        ['profile','my profile','account','user','name','nickname','birthday','dob','date of birth','gender','sex','male','female','height','cm','centimetres','feet','foot','inches','weight','lbs','kg','body','about you','sign out','logout','log out','password','change password','email'],
    appearance:     ['appearance','theme','dark','light','accent','colour','color','custom','navigation','sidebar','persistent','start page','banner','animation','animations','motion','reduce'],
    workout:        ['workout','weekly','goal','goals','celebration','celebrations','screen','keep awake','keep-awake','wake lock','rest','timer','rest timer','countdown','duration','alert','vibrate','calorie','calories','kcal','burn','burned','estimate','cardio','cardio minutes','weekly cardio','track cardio','enable cardio','bike','run','row','treadmill'],
    units:          ['units','measurement','measurement system','format','date','time','12h','24h','locale','region','weight unit','height unit','lbs','kg','cm','ft','imperial','metric'],
    statistics:     ['statistics','stats','chart','bar','line','average','trend','y-axis','zero','calorie','calories','kcal'],
    trace:          ['trace','ai','assistant','chat','provider','model','custom model','model id','claude','openai','gemini','sonnet','opus','haiku','gpt','gemini 3','ollama','lm studio','deepseek','groq','localai','vllm','llama.cpp','mistral','base url','oai-compat','openai compatible','api key','rapidapi','artificial intelligence','bot','voice','hold to record','smart log','smart add','microphone','speech','attach','image'],
    radio:          ['radio','music','player','subsonic','navidrome','jellyfin','streaming','audio','playlist'],
    federation:     ['federation','nutritrace','nt','sync','integration','calorie sync','log workouts','log calories','api','api token','access token','instance','wearable','double count'],
    catalog:        ['catalog','catalogue','exercise','exercises','source','sources','wger','free','db','exercisedb','rapidapi','import','sync','library','custom','custom exercise','custom exercises','my exercises','create exercise','offline','offline exercise library','image cache'],
    data:           ['data','export','import','backup','reset','json','defaults','local backup','full backup','restore','schedule'],
    workoutImport:  ['import','workout','strong','hevy','fitnotes','jefit','garmin','fit','fit file','garmin connect','watch','strength training','migration','csv'],
    notifications:  ['notifications','reminders','workout reminder','rest day','streak','push','gotify','ntfy','apprise','celebration','pr','weekly summary','alert','permission','channel','sound','vibrate','vibration','battery','low battery','android'],
    email:          ['email','smtp','mail','host','port','tls','password reset','invite','test','test email','send test','recipient','change password','stored password'],
    users:          ['users','user management','accounts','login','admin','trainer','member','register','invite','session','my profile','account','biometric','fingerprint','face'],
    authentication: ['authentication','auth','sso','single sign-on','single sign on','oidc','openid','authentik','keycloak','authelia','pocket id','auth0','google','password login','admin group','provider','client id','client secret','discovery','discovery url','redirect uri','callback','env lock'],
    serverConnection: ['server','connection','sync','cloud','local','remote','connect','disconnect','url','last sync','log out','logout','sign out'],
    updates:        ['updates','update','upgrade','version','new version','changelog','release','releases','apk','install','download','check for updates','auto-check','channel','stable','dev','dev-latest','beta','github','server update','docker','compose','docker-compose'],
    helpImprove:    ['diagnostics','logs','log','verbose','debug','bug','troubleshoot','report','clipboard'],
    about:          ['about','version','lifttrace','license','sister','nutritrace'],
  };

  // Search match: a settings sub-component declares its keyword bucket either
  // as a known SECTION_KEYWORDS key (e.g. 'workout') OR as a space-separated
  // inline string of fallback terms ('mode app server'). The inline form is
  // what older call sites pass; we treat each whitespace-separated token as
  // its own alternative keyword so they actually match search.
  // ── Drill-in navigation ────────────────────────────────────────────────
  // svelte-spa-router passes route params via a `params` prop. When URL is
  // /settings/<slug>, currentSection = <slug> and we render only that
  // section under a back-arrow header ("sub-page view"). On /settings
  // alone (index view) we render the list of section rows.
  export let params = {};
  $: currentSection = params?.section || null;

  const SECTION_META = {
    appearance:       { titleKey: 'settings.appearance.section',        icon: 'contrast' },
    units:            { titleKey: 'settings.units.section',             icon: 'straighten' },
    workout:          { titleKey: 'settings.workout.section',           icon: 'fitness_center' },
    statistics:       { titleKey: 'settings.statistics.section',        icon: 'bar_chart' },
    catalog:          { titleKey: 'settings.catalog.section',           icon: 'library_books' },
    trace:            { titleKey: 'settings.trace.section',             icon: 'bolt' },
    radio:            { titleKey: 'settings.radio.section',             icon: 'radio' },
    federation:       { titleKey: 'settings.federation.section',        icon: 'link' },
    serverConnection: { titleKey: 'settings.server.section',            icon: 'cloud' },
    notifications:    { titleKey: 'settings.notifications.section',     icon: 'notifications' },
    data:             { titleKey: 'settings.backup.section',            icon: 'archive' },
    workoutImport:    { titleKey: 'settings.workout_import.section',    icon: 'upload' },
    updates:          { titleKey: 'settings.updates.section',           icon: 'system_update' },
    helpImprove:      { titleKey: 'settings.diagnostics.section',       icon: 'troubleshoot' },
    users:            { titleKey: 'settings.users.section',             icon: 'group' },
    authentication:   { titleKey: 'settings.authentication.section',    icon: 'shield_person' },
    email:            { titleKey: 'settings.email.section',             icon: 'mail' },
    about:            { titleKey: 'settings.about.section',             icon: 'info' },
  };

  // Reactive predicates. On sub-page (currentSection truthy) hide every
  // other section via visible=false, force-open the current one via
  // expanded=true. On index keep the classic keyword filter.
  $: sectionVisible = (query, keyOrInline) => {
    if (currentSection) return keyOrInline === currentSection;
    if (!query) return true;
    if (SECTION_KEYWORDS[keyOrInline]) {
      return SECTION_KEYWORDS[keyOrInline].some(kw => kw.includes(query));
    }
    return String(keyOrInline || '').toLowerCase().split(/\s+/).filter(Boolean)
      .some(kw => kw.includes(query));
  };

  // Reverse the peel-in animation on tap: swap the back button + title
  // into their -out classes so the reversed CSS keyframe plays, then
  // navigate after the animation completes.
  let _leaving = false;
  async function backToIndex() {
    if (_leaving) return;
    _leaving = true;
    await new Promise(r => setTimeout(r, 240));
    push('/settings');
  }

  // Deep-link ?q= scroll: on sub-page mount, scan DOM for the search
  // query and scroll+highlight the first matching setting.
  $: _urlQuery = $querystring ? new URLSearchParams($querystring).get('q') : null;
  let _lastDeepLinkKey = null;
  $: {
    const key = `${currentSection || ''}|${_urlQuery || ''}`;
    if (currentSection && _urlQuery && key !== _lastDeepLinkKey) {
      _lastDeepLinkKey = key;
      _scheduleDeepLinkScroll(_urlQuery);
    }
  }
  async function _scheduleDeepLinkScroll(q) {
    await tick();
    await new Promise(r => setTimeout(r, 60));
    const q_norm = q.toLowerCase().trim();
    if (!q_norm) return;
    const scope = document.querySelector('.subpage-view');
    if (!scope) return;
    const candidates = scope.querySelectorAll('.setting-label, .setting-desc, .sub-label, .setting-row');
    let hit = null;
    for (const el of candidates) {
      if ((el.textContent || '').toLowerCase().includes(q_norm)) { hit = el; break; }
    }
    if (!hit) return;
    const row = hit.closest('.setting-row') || hit;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('deep-link-highlight');
    setTimeout(() => row.classList.remove('deep-link-highlight'), 2200);
  }

  // ── Collapsible sections ─────────────────────────────────────────────────
  let openSections = {
    serverConnection: false,
    profile: false,
    appearance: false,
    workout: false,
    units: false,
    statistics: false,
    trace: false,
    radio: false,
    federation: false,
    catalog: false,
    data: false,
    workoutImport: false,
    notifications: false,
    email: false,
    users: false,
    authentication: false,
    updates: false,
    helpImprove: false,
    about: false,
  };
  // Drill-in navigation replaces the old accordion toggle. On the index
  // (/settings) tapping a section-toggle button routes to the section's
  // sub-page. On a sub-page tapping the same section behaves as "back to
  // index". Forwards active search query as ?q= so the sub-page can
  // auto-scroll to the matching setting on land.
  function toggleSection(key) {
    if (currentSection === key) push('/settings');
    else {
      const q = settingsQuery ? `?q=${encodeURIComponent(settingsQuery)}` : '';
      push(`/settings/${key}${q}`);
    }
  }
  // Reactive expanded map: on sub-page force-open the current section,
  // on index keep everything collapsed (drill-in replaces accordion,
  // bodies are one nav-click away).
  $: expanded = Object.fromEntries(
    Object.keys(openSections).map(k => [k, currentSection === k])
  );

  // Exercise catalog state moved into SettingsCatalog.svelte

  // Backup / restore / danger-zone moved into SettingsBackup.svelte

  // SMTP config moved into SettingsEmail.svelte

  // User management + enable flow moved into SettingsUserManagement.svelte
  // Exercise import + Catalog state moved into SettingsCatalog.svelte
  // AI key + Radio config moved into SettingsTrace.svelte / SettingsRadio.svelte
  // Push test moved into SettingsNotifications.svelte
  // Reset to defaults + clear-data + delete-account moved into SettingsBackup.svelte

  // Sign-out is handled in the sidebar footer. See Sidebar.svelte.
</script>

<div class="page">
  <!-- Sticky header + search wrap so the search bar tracks the page header
       at the same y position when scrolling instead of computing its own
       top offset (which budged when the header re-laid out under it). -->
  <div class="settings-sticky-top">
    <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
      {#if currentSection}
        <!-- Back button "peels out" from the left edge of the section
             title via a CSS keyframe (Svelte transitions don't fire
             here because svelte-spa-router unmounts + remounts the
             whole component between /settings and /settings/:section). -->
        <button class="settings-back"
                class:back-peel-in={!_leaving}
                class:back-peel-out={_leaving}
                on:click={backToIndex}
                aria-label={$_('common.back')}>
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
        <h1 class:title-slide-in={!_leaving}
            class:title-slide-out={_leaving}>
          {SECTION_META[currentSection]?.titleKey ? $_(SECTION_META[currentSection].titleKey) : currentSection}
        </h1>
      {:else}
        <h1>{$_('routes.settings.title')}</h1>
      {/if}
    </header>

    {#if !currentSection}
      <div class="settings-search-bar">
      <span class="material-symbols-rounded settings-search-icon">search</span>
      <input
        class="settings-search-input"
        type="search"
        placeholder={$_('settings_main.search_ph')}
        bind:value={settingsSearch}
      />
      {#if settingsSearch}
        <button class="settings-search-clear" on:click={() => settingsSearch = ''} title={$_('settings_main.clear_search')}>
          <span class="material-symbols-rounded" style="font-size:18px">close</span>
        </button>
      {/if}
      </div>
    {/if}
  </div>

  <div class="content" class:subpage-view={!!currentSection}>

    <!-- ── Profile hero — identity card at the top of Settings.
         Avatar + name (nickname → full name → "My Profile" fallback) +
         optional admin pill. Click → /profile. Hidden during search
         when no profile keyword matches so it doesn't dilute results. -->
    {#if sectionVisible(settingsQuery, 'profile')}
    {@const _u = $currentUser || {}}
    {@const _nick = (_u.nickname || '').trim()}
    {@const _full = (_u.full_name || '').trim()}
    {@const _displayName = _nick || (_full && _full !== 'Local User' ? _full : '') || 'My Profile'}
    {@const _hasName = _displayName !== 'My Profile'}
    {@const _initial = (_displayName[0] || '?').toUpperCase()}
    <button class="profile-hero" on:click={() => push('/profile')}>
      <div class="profile-hero-avatar">
        {#if _u.avatar_url}
          <img src={resolveAssetUrl(_u.avatar_url)} alt="" />
        {:else if _hasName}
          <span class="profile-hero-initial">{_initial}</span>
        {:else}
          <span class="material-symbols-rounded">person</span>
        {/if}
      </div>
      <div class="profile-hero-info">
        <span class="profile-hero-name">{_displayName}</span>
        {#if _hasName && _u.role === 'admin' && $userMgmtActive}
          <span class="profile-hero-role">admin</span>
        {:else if !_hasName}
          <span class="profile-hero-sub">{$_('settings_main.profile_hero_sub')}</span>
        {/if}
      </div>
      <span class="material-symbols-rounded profile-hero-chev">chevron_right</span>
    </button>
    {/if}

    <!-- ═══ DISPLAY ═══════════════════════════════════════════════════════ -->
    <p class="group-label">{$_('settings_main.group_display')}</p>

    <SettingsAppearance
      visible={sectionVisible(settingsQuery, 'appearance')}
      expanded={expanded.appearance}
      onToggle={() => toggleSection('appearance')}
      onOpenColorSheet={openColorSheet}
    />

    <SettingsUnits
      visible={sectionVisible(settingsQuery, 'units')}
      expanded={expanded.units}
      onToggle={() => toggleSection('units')}
    />

    <!-- ═══ DATA & TRACKING (workout settings, charts — mirrors NutriTrace) -->
    <p class="group-label">Data &amp; Tracking</p>

    <SettingsWorkout
      visible={sectionVisible(settingsQuery, 'workout')}
      expanded={expanded.workout}
      onToggle={() => toggleSection('workout')}
    />

    <SettingsStatistics
      visible={sectionVisible(settingsQuery, 'statistics')}
      expanded={expanded.statistics}
      onToggle={() => toggleSection('statistics')}
    />

    <!-- ═══ INTEGRATIONS ══════════════════════════════════════════════════ -->
    <p class="group-label">{$_('settings_main.group_integrations')}</p>

    {#if !localOnly}
      <SettingsCatalog
        visible={sectionVisible(settingsQuery, 'catalog')}
        expanded={expanded.catalog}
        onToggle={() => toggleSection('catalog')}
      />
    {/if}

    <SettingsTrace
      visible={sectionVisible(settingsQuery, 'trace')}
      expanded={expanded.trace}
      onToggle={() => toggleSection('trace')}
    />

    <SettingsRadio
      visible={sectionVisible(settingsQuery, 'radio')}
      expanded={expanded.radio}
      onToggle={() => toggleSection('radio')}
    />

    {#if !localOnly}
      <SettingsFederation
        visible={sectionVisible(settingsQuery, 'federation')}
        expanded={expanded.federation}
        onToggle={() => toggleSection('federation')}
      />
    {/if}

    <!-- ═══ APP (server connection + notifications + data movement, app-level — visible to all) -->
    <p class="group-label">App</p>

    <!-- ── Server Connection (native only — manages connection to a remote
         LiftTrace server). PWA users have no "server connection" concept;
         their Log Out lives in My Profile. -->
    {#if isNative}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverConnection')} on:click={() => toggleSection('serverConnection')}>
      <span class="material-symbols-rounded si">cloud_sync</span>
      <span class="section-name">{$_('settings.server.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.serverConnection}>expand_more</span>
    </button>
    {#if expanded.serverConnection && sectionVisible(settingsQuery, 'serverConnection')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          {#if serverMode === 'server' && getServerUrl()}
            <div class="setting-row">
              <div>
                <span class="setting-label">{$_('settings_main.server.connected')}</span>
                <div class="setting-desc">{getServerUrl()}</div>
              </div>
              <span class="material-symbols-rounded" style="color:var(--success, #22c55e);font-size:22px">cloud_done</span>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">{$_('settings_main.server.last_synced')}</span>
                <div class="setting-desc">
                  {#key _nowTick}{_fmtTimeAgo(lastSyncAt)}{/key}
                </div>
              </div>
              <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;display:flex;align-items:center;gap:6px" on:click={manualSync} disabled={_syncing}>
                <span class="material-symbols-rounded" class:spin={_syncing} style="font-size:16px">{_syncing ? 'autorenew' : 'sync'}</span>
                {_syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <div class="setting-divider"></div>
            <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">
              <button class="btn btn-ghost w-full" on:click={logoutServer}>
                <span class="material-symbols-rounded" style="font-size:18px">logout</span>
                Log Out
              </button>
              <button class="btn btn-ghost w-full" style="color:var(--error,#f87171)" on:click={disconnectServer}>
                <span class="material-symbols-rounded" style="font-size:18px">link_off</span>
                Disconnect &amp; Use Locally
              </button>
            </div>
          {:else}
            <div class="setting-row">
              <div>
                <span class="setting-label">{$_('settings_main.server.local_mode')}</span>
                <div class="setting-desc">{$_('settings_main.server.local_mode_desc')}</div>
              </div>
              <span class="material-symbols-rounded" style="color:var(--text-3);font-size:22px">smartphone</span>
            </div>
            <div class="setting-divider"></div>
            <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
              <div class="form-group" style="margin:0">
                <label class="form-label">{$_('settings_main.server.server_url')}</label>
                <input class="form-input" type="url" placeholder="https://lifttrace.example.com" bind:value={serverUrlInput} />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">{$_('settings_main.server.username')}</label>
                <input class="form-input" type="text" placeholder={$_('settings_main.server.username_ph')} bind:value={serverUsername} autocapitalize="off" />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">{$_('settings_main.server.password')}</label>
                <div style="position:relative">
                  {#if serverShowPw}
                    <input class="form-input" type="text" placeholder={$_('settings_main.server.password_ph')} bind:value={serverPassword} style="padding-right:40px" />
                  {:else}
                    <input class="form-input" type="password" placeholder={$_('settings_main.server.password_ph')} bind:value={serverPassword} style="padding-right:40px" />
                  {/if}
                  <button type="button" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-3);padding:4px" on:click={() => serverShowPw = !serverShowPw}>
                    <span class="material-symbols-rounded" style="font-size:20px">{serverShowPw ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <button class="btn btn-primary" style="width:100%;justify-content:center;height:42px" on:click={connectServer} disabled={serverConnecting}>
                {serverConnecting ? 'Connecting…' : 'Connect to Server'}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
    {/if}

    <SettingsNotifications
      visible={sectionVisible(settingsQuery, 'notifications')}
      expanded={expanded.notifications}
      onToggle={() => toggleSection('notifications')}
    />

    <!-- SettingsBackup is now visible in BOTH server + local mode so
         the new Auto Backup section is reachable from local-mode
         installs too. The server full-backup sub-section gates itself
         internally to server mode; local-mode users see only the
         Auto Backup config. -->
    {#if true}
      <SettingsBackup
        visible={sectionVisible(settingsQuery, 'data')}
        expanded={expanded.data}
        onToggle={() => toggleSection('data')}
      />
    {/if}

    <!-- Workout Import works in local-only mode too — the adapters run
         client-side and write directly to the local SQLite. When the
         user is server-connected, the imported rows sync up through
         the differential push like any other workout. -->
    <SettingsWorkoutImport
      visible={sectionVisible(settingsQuery, 'workoutImport')}
      expanded={expanded.workoutImport}
      onToggle={() => toggleSection('workoutImport')}
    />

    <!-- Updates — inline section since SettingsUpdates is a shared
         component across TraceApps and doesn't take the LT-specific
         visible/expanded/onToggle prop shape. Canonical position across
         NT/CT/LT: right before Diagnostics in the App group. -->
    {#if sectionVisible(settingsQuery, 'updates')}
      <button class="section-toggle" on:click={() => toggleSection('updates')}>
        <span class="material-symbols-rounded si">system_update</span>
        <span class="section-name">{$_('settings.updates.section')}</span>
        <span class="material-symbols-rounded chevron" class:rotated={openSections.updates}>expand_more</span>
      </button>
      {#if expanded.updates}
        <div class="section-body" transition:slide={{ duration: 180 }}>
          <SettingsUpdates />
        </div>
      {/if}
    {/if}

    <SettingsDiagnostics
      visible={sectionVisible(settingsQuery, 'helpImprove')}
      expanded={expanded.helpImprove}
      onToggle={() => toggleSection('helpImprove')}
    />

    <!-- ═══ ADMIN (Users + Authentication + Email — admin only).
         Mirrors NutriTrace: the profile-hero card at the top of Settings
         covers per-user profile editing in every mode, so this group is
         purely admin-facing. Hidden on native standalone (no server),
         and hidden for non-admin members on multi-user instances. -->
    {#if !localOnly && (!$userMgmtActive || $currentUser?.role === 'admin')}
      <p class="group-label">{$_('settings_main.group_admin')}</p>

      <SettingsUserManagement
        visible={sectionVisible(settingsQuery, 'users')}
        expanded={expanded.users}
        onToggle={() => toggleSection('users')}
      />

      {#if $userMgmtActive && $currentUser?.role === 'admin'}
        <SettingsAuth
          visible={sectionVisible(settingsQuery, 'authentication')}
          expanded={expanded.authentication}
          onToggle={() => toggleSection('authentication')}
        />
      {/if}

      <SettingsEmail
        visible={sectionVisible(settingsQuery, 'email')}
        expanded={expanded.email}
        onToggle={() => toggleSection('email')}
      />
    {/if}

    <!-- ═══ ABOUT (standalone footer — always last) ════════════════════════ -->
    <SettingsAbout
      visible={sectionVisible(settingsQuery, 'about')}
      expanded={expanded.about}
      onToggle={() => toggleSection('about')}
    />

    {#if settingsQuery && !Object.values(expanded).some(v => v)}
      <p class="empty-state">No settings match "{settingsSearch}"</p>
    {/if}

    <div style="height:24px"></div>
  </div>
</div>

<!-- Merge dialog (shown when connecting to server with existing local data) -->
{#if mergeStep === 'ask-settings'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">{$_('settings_main.merge.title')}</h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 12px;line-height:1.5">
        You have data on this phone. How should it be handled when connecting?
      </p>
      {#if localCounts && localCounts.total > 0}
        <div class="merge-counts" style="margin:0 0 16px">
          <div class="merge-counts-title">On this phone:</div>
          <div class="merge-counts-grid">
            {#if localCounts.workouts        > 0}<div><strong>{localCounts.workouts}</strong> {localCounts.workouts === 1 ? 'workout' : 'workouts'}</div>{/if}
            {#if localCounts.bodyStats       > 0}<div><strong>{localCounts.bodyStats}</strong> body {localCounts.bodyStats === 1 ? 'stat' : 'stats'}</div>{/if}
            {#if localCounts.programs        > 0}<div><strong>{localCounts.programs}</strong> {localCounts.programs === 1 ? 'program' : 'programs'}</div>{/if}
            {#if localCounts.templates       > 0}<div><strong>{localCounts.templates}</strong> {localCounts.templates === 1 ? 'template' : 'templates'}</div>{/if}
            {#if localCounts.customExercises > 0}<div><strong>{localCounts.customExercises}</strong> custom {localCounts.customExercises === 1 ? 'exercise' : 'exercises'}</div>{/if}
            {#if localCounts.settings        > 0}<div><strong>{localCounts.settings}</strong> settings</div>{/if}
          </div>
        </div>
      {/if}
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="merge-option" on:click={() => _mergeAndConnect('upload')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_upload</span>
          <div>
            <div class="merge-option-title">{$_('settings_main.merge.upload')}</div>
            <div class="merge-option-desc">Send this phone's workouts, programs, and settings to the server. Existing server data stays.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('download')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_download</span>
          <div>
            <div class="merge-option-title">{$_('settings_main.merge.download')}</div>
            <div class="merge-option-desc">Replace this phone's data with everything from the server. Local data is discarded.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('merge')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">sync</span>
          <div>
            <div class="merge-option-title">{$_('settings_main.merge.merge')}</div>
            <div class="merge-option-desc">Upload phone data to the server AND download server data. Nothing is lost, but duplicates are possible.</div>
          </div>
        </button>
        <button class="btn btn-ghost" style="color:var(--text-3);margin-top:4px;width:100%;justify-content:center;height:40px" on:click={cancelMerge}>{$_('settings_main.merge.cancel')}</button>
      </div>
    </div>
  </div>
{:else if mergeStep === 'syncing'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog" style="text-align:center">
      <span class="material-symbols-rounded" style="font-size:36px;color:var(--accent);animation:settings-spin 1.2s linear infinite">sync</span>
      <p style="font-size:15px;color:var(--text-1);margin:12px 0 4px;font-weight:600">Syncing…</p>
      <p style="font-size:13px;color:var(--text-3);margin:0">{mergeProgress || 'Preparing…'}</p>
      {#if mergeProgressPct > 0}
        <div class="merge-progress-bar" style="margin-top:14px">
          <div class="merge-progress-fill" style="width:{mergeProgressPct}%"></div>
        </div>
      {/if}
    </div>
  </div>
{:else if mergeStep === 'summary' && migrationSummary}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">
        {migrationSummary.errors.length === 0 ? 'Upload complete' : 'Upload finished with issues'}
      </h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 14px;line-height:1.5">
        {migrationSummary.totalSuccess} of {migrationSummary.total} {migrationSummary.total === 1 ? 'item' : 'items'} uploaded successfully.
      </p>
      <div class="merge-counts" style="margin:0 0 14px">
        <div class="merge-counts-title">Uploaded to server:</div>
        <div class="merge-counts-grid">
          {#if migrationSummary.success.workouts        > 0}<div><strong>{migrationSummary.success.workouts}</strong> {migrationSummary.success.workouts === 1 ? 'workout' : 'workouts'}</div>{/if}
          {#if migrationSummary.success.bodyStats       > 0}<div><strong>{migrationSummary.success.bodyStats}</strong> body {migrationSummary.success.bodyStats === 1 ? 'stat' : 'stats'}</div>{/if}
          {#if migrationSummary.success.programs        > 0}<div><strong>{migrationSummary.success.programs}</strong> {migrationSummary.success.programs === 1 ? 'program' : 'programs'}</div>{/if}
          {#if migrationSummary.success.templates       > 0}<div><strong>{migrationSummary.success.templates}</strong> {migrationSummary.success.templates === 1 ? 'template' : 'templates'}</div>{/if}
          {#if migrationSummary.success.customExercises > 0}<div><strong>{migrationSummary.success.customExercises}</strong> custom {migrationSummary.success.customExercises === 1 ? 'exercise' : 'exercises'}</div>{/if}
          {#if migrationSummary.success.settings        > 0}<div><strong>{migrationSummary.success.settings}</strong> settings</div>{/if}
        </div>
      </div>
      {#if migrationSummary.errors.length > 0}
        <div style="margin:0 0 14px">
          <div class="merge-counts-title" style="color:var(--danger,#e57373)">
            {migrationSummary.errors.length} {migrationSummary.errors.length === 1 ? 'error' : 'errors'}
            {#if migrationSummary.errors.length > 5}(showing first 5){/if}
          </div>
          <ul style="font-size:12px;color:var(--text-3);padding-left:18px;margin:6px 0 0;line-height:1.5">
            {#each migrationSummary.errors.slice(0, 5) as err}
              <li><strong>{err.stage}</strong> · {err.name}: {err.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <button class="btn btn-primary" style="width:100%;justify-content:center;height:42px" on:click={_finalizeConnect}>{$_('settings_main.merge.continue')}</button>
    </div>
  </div>
{/if}

<!-- Custom color picker sheet -->
<Sheet bind:open={showColorSheet} title={$_('settings_main.color.title')}>
  <div class="cp-body">
    <div class="cp-preview" style="background:{customColorHex}">
      <span class="cp-preview-hex">{customHexInput}</span>
    </div>
    <div class="cp-slider-group">
      <label class="form-label">Hue</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-hue" min="0" max="360"
          bind:value={cpHue} on:input={cpUpdateFromSliders} />
      </div>
    </div>
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_main.color.saturation')}</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-sat" min="0" max="100"
          bind:value={cpSat} on:input={cpUpdateFromSliders}
          style="--cp-sat-lo:hsl({cpHue},0%,{cpLgt}%);--cp-sat-hi:hsl({cpHue},100%,{cpLgt}%)" />
      </div>
    </div>
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_main.color.lightness')}</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-lgt" min="0" max="100"
          bind:value={cpLgt} on:input={cpUpdateFromSliders}
          style="--cp-lgt-lo:hsl({cpHue},{cpSat}%,0%);--cp-lgt-mid:hsl({cpHue},{cpSat}%,50%);--cp-lgt-hi:hsl({cpHue},{cpSat}%,100%)" />
      </div>
    </div>
    <div class="cp-slider-group">
      <label class="form-label">RGB</label>
      <div class="cp-rgb-row">
        <div class="cp-rgb-field">
          <input class="form-input cp-rgb-input" type="number" min="0" max="255" bind:value={cpR} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">R</span>
        </div>
        <div class="cp-rgb-field">
          <input class="form-input cp-rgb-input" type="number" min="0" max="255" bind:value={cpG} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">G</span>
        </div>
        <div class="cp-rgb-field">
          <input class="form-input cp-rgb-input" type="number" min="0" max="255" bind:value={cpB} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">B</span>
        </div>
      </div>
    </div>
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_main.color.hex_code')}</label>
      <div class="cp-hex-row">
        <span class="cp-hex-dot" style="background:{/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : '#ccc'}"></span>
        <input class="form-input" type="text" placeholder="#rrggbb" maxlength="7"
          style="font-family:monospace;letter-spacing:0.05em;flex:1"
          bind:value={customHexInput}
          on:input={cpUpdateFromHex}
          on:keydown={e => e.key === 'Enter' && applyCustomColor()} />
      </div>
    </div>
    <button class="btn btn-primary" style="height:44px;width:100%;margin-top:4px;justify-content:center" on:click={applyCustomColor}>{$_('settings_main.color.apply')}</button>
  </div>
</Sheet>

<style>
  .page {
    min-height: 100dvh;
    background: var(--bg);
    padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 32px);
  }

  /* Profile hero — identity card at the top of Settings (mirrors NutriTrace) */
  .profile-hero {
    display: flex; align-items: center; gap: 14px;
    width: calc(100% - var(--page-px) * 2);
    margin: 4px var(--page-px) 14px;
    padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    color: var(--text-1);
    cursor: pointer;
    font-family: inherit; text-align: left;
    transition: background var(--dur-fast, 120ms), transform var(--dur-fast, 120ms);
  }
  .profile-hero:hover  { background: var(--surface-3); }
  .profile-hero:active { transform: scale(0.99); }
  .profile-hero-avatar {
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .profile-hero-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-hero-avatar :global(.material-symbols-rounded) { font-size: 26px; }
  .profile-hero-initial { font-size: 20px; font-weight: 700; line-height: 1; }
  .profile-hero-info { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .profile-hero-name {
    font-size: 17px; font-weight: 700; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .profile-hero-role {
    align-self: flex-start;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full, 999px);
  }
  .profile-hero-sub { font-size: 13px; color: var(--text-3); }
  .profile-hero-chev { color: var(--text-3); flex-shrink: 0; }

  /* ── Sticky search bar (NutriTrace pattern) ─────────────────────────── */
  /* Sticky container — keeps the page header AND the search bar pinned
     together as one unit so the search row doesn't shift relative to the
     header as the page scrolls. Single sticky-top is more reliable than
     two separate sticky elements with computed offsets. The nested
     .page-header is forced to static (!important to beat base.css's
     `.page-header { position: sticky }` rule) so it doesn't double-stick
     inside this container. */
  .settings-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  :global(.settings-sticky-top .page-header) {
    position: static !important;
    top: auto !important;
    z-index: auto !important;
  }
  .settings-search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px var(--page-px) 12px;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  .settings-search-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .settings-search-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 8px 14px;
    font-size: 14px;
    color: var(--text-1);
    outline: none;
    font-family: inherit;
    transition: border-color var(--dur-fast);
  }
  .settings-search-input:focus { border-color: var(--accent); }
  .settings-search-clear {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px; display: flex;
    border-radius: var(--radius-sm);
  }
  .settings-search-clear:hover { color: var(--text-1); background: var(--surface-2); }

  .content { padding: 16px var(--page-px) 0; }
  /* Settings-only override: reduce horizontal page padding on phone
     widths so cards get ~10-12px more breathing room per side. Desktop
     / tablet widths (>= 768px) keep the default padding. */
  @media (max-width: 767px) {
    .content { padding-left: 8px; padding-right: 8px; }
  }

  /* Sub-page view: hide index-only chrome (group labels, profile hero,
     the section-toggle header row). Each SettingsX wrapper renders
     both a section-toggle button AND its body when expanded=true;
     on drill-in we want ONLY the body, so hide every section-toggle
     descendant here. */
  .subpage-view :global(.group-label) { display: none; }
  .subpage-view :global(.profile-hero) { display: none; }
  .subpage-view :global(.section-toggle) { display: none; }

  /* Back arrow header button — mirrors NT + CT. */
  .settings-back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    margin-right: 8px;
    border: none; background: transparent; cursor: pointer;
    color: var(--text-1);
    border-radius: 50%;
    transition: background-color 120ms ease;
  }
  .settings-back:hover  { background: var(--surface-2); }
  .settings-back:active { background: var(--surface-3); }
  .settings-back .material-symbols-rounded { font-size: 24px; }

  /* Back button peel-in — the button appears to unfold from the left
     edge of the section title. Delayed 80ms so the title appears
     first, then the arrow reveals. */
  .back-peel-in {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes back-peel {
    from { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
    to   { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
  }
  .back-peel-out {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel-reverse 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes back-peel-reverse {
    from { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
    to   { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
  }
  .title-slide-in {
    animation: title-slide 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes title-slide {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: 1; transform: translateX(0);      }
  }
  .title-slide-out {
    animation: title-slide-back 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes title-slide-back {
    from { opacity: 1; transform: translateX(0);      }
    to   { opacity: 0; transform: translateX(-16px); }
  }

  /* Deep-link highlight — brief pulse on the target row after a
     search-driven drill-in scroll. */
  :global(.setting-row.deep-link-highlight) {
    animation: deep-link-pulse 2s cubic-bezier(.2, .8, .2, 1) both;
    border-radius: 8px;
  }
  @keyframes deep-link-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
    12%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent); background-color: color-mix(in srgb, var(--accent) 14%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
  }

  /* .group-label is :global — see below */

  /* ── Section framework (collapsible header + body). These are :global so
     extracted per-section sub-components inherit the styling. */
  :global(.section-toggle) {
    display: flex; align-items: center; gap: 12px; width: 100%;
    padding: 14px var(--page-px);
    background: none; border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-1); font-size: 15px; font-weight: 600;
    cursor: pointer; text-align: left;
    transition: background var(--dur-fast);
    font-family: inherit;
  }
  :global(.section-toggle:hover)  { background: var(--surface-2); }
  :global(.section-toggle:active) { background: var(--surface-3); }
  :global(.section-name) { flex: 1; }
  :global(.si) {
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--accent-dim); color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  :global(.si .material-symbols-rounded) { font-size: 18px; }
  /* Drill-in indicator: chevron always points right (rotate -90deg turns
     the down-arrow into a right-arrow). No expanded state on the index
     anymore since each section drills into its own sub-page. */
  :global(.chevron) { color: var(--text-3); transform: rotate(-90deg); }
  :global(.chevron.rotated) { transform: rotate(-90deg); color: var(--text-3); }

  :global(.section-body) { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }

  :global(.card) {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  :global(.setting-row) {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  :global(.setting-row:last-child) { border-bottom: none; }
  :global(.setting-label) { font-size: 14px; color: var(--text-1); }
  :global(.setting-label-group) { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  :global(.setting-hint) { font-size: 12px; color: var(--text-3); }
  :global(.setting-divider) { height: 1px; background: var(--border); margin: 0 16px; }

  /* Prevent long text/labels from pushing trailing controls (toggles, chevrons,
     icon buttons) off-screen. Direct children that are containers (div / span.setting-label)
     get to grow + shrink with min-width:0 so internal text wraps; everything else
     (toggles, action icons) stays at intrinsic width. */
  :global(.setting-row > *) { flex-shrink: 0; }
  :global(.setting-row > div),
  :global(.setting-row > span.setting-label) {
    flex: 1 1 0;
    min-width: 0;
  }

  .accent-row { flex-wrap: wrap; gap: 12px; }

  .theme-btns { display: flex; gap: 4px; }
  .theme-btn {
    padding: 6px 12px; border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 12px; font-weight: 600; cursor: pointer;
    transition: all var(--dur-fast);
  }
  .theme-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

  .accent-grid { display: flex; gap: 8px; flex-wrap: wrap; }
  .accent-swatch {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid transparent; cursor: pointer;
    transition: transform var(--dur-fast);
    display: flex; align-items: center; justify-content: center;
    position: relative;
  }
  .accent-swatch.active { border-color: var(--text-1); transform: scale(1.15); }
  .accent-swatch:hover { transform: scale(1.08); }
  .swatch-check { font-size: 16px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }
  .accent-swatch-custom { background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); }

  :global(.form-select-sm) {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 10px;
    color: var(--text-1); font-size: 13px; font-family: inherit;
  }
  :global(.form-input-sm) {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 10px;
    color: var(--text-1); font-size: 13px; width: 200px; font-family: inherit;
  }
  :global(.btn-sm) { padding: 6px 14px; font-size: 12px; }
  :global(.group-label) {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-3);
    padding: 20px var(--page-px) 8px;
    margin: 0;
  }
  :global(.row-btn) {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 16px; width: 100%;
    background: none; border: none; cursor: pointer; text-align: left;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    font-family: inherit; font-size: 14px;
  }
  :global(.row-btn:last-child) { border-bottom: none; }
  :global(.row-btn:hover) { background: var(--surface-2); }
  :global(.row-btn.danger-row:hover) { background: rgba(255,92,92,0.08); }
  :global(.row-btn.danger-row .setting-label) { color: var(--danger); }

  /* .row-btn is :global — see below */

  /* ── About section ──────────────────────────────────────────────────── */
  .about-hero { display: flex; align-items: center; gap: 16px; padding: 16px; }
  .about-icon { width: 56px; height: 56px; border-radius: 12px; }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version { margin-top: 2px; font-size: 13px; color: var(--text-3); }
  .about-desc { font-size: 13px; color: var(--text-2); line-height: 1.5; padding: 12px 16px; }
  .about-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; font-size: 14px; color: var(--text-1); }
  .about-feat-icon { font-size: 20px; color: var(--accent); flex-shrink: 0; }
  .exp-badge {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--warning); color: #0A0B0F;
    padding: 2px 6px; border-radius: var(--radius-full);
    vertical-align: middle; margin-left: 6px;
  }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .form-input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none; width: 100%; transition: border-color var(--dur-fast);
  }
  .form-input:focus { border-color: var(--accent); }
  .form-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .env-lock-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; margin-bottom: 8px;
    background: color-mix(in srgb, var(--warning) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px; color: var(--warning);
  }
  .btn-icon-toggle {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 6px; display: flex; border-radius: var(--radius-sm);
  }
  .btn-icon-toggle:hover { color: var(--text-1); background: var(--surface-2); }
  .about-link { color: var(--accent); text-decoration: underline; }
  .about-link:hover { opacity: 0.8; }

  /* ── User management rows ──────────────────────────────────────────── */
  .user-row-mgmt {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .user-row-mgmt:last-child { border-bottom: none; }
  .user-row-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-dim); color: var(--accent);
    font-size: 15px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .user-row-info { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .user-row-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .user-row-meta { font-size: 12px; color: var(--text-3); }
  .user-row-selects { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .user-role-badge {
    font-size: 11px; font-weight: 600; color: var(--text-3);
    background: var(--surface-2); padding: 3px 8px; border-radius: var(--radius-sm);
    text-transform: capitalize;
  }
  .form-select-xs {
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 11px; font-family: inherit;
    border-radius: var(--radius-sm); padding: 3px 6px; height: 24px;
    outline: none; cursor: pointer;
  }
  .form-select-xs:focus { border-color: var(--accent); }

  .invite-result {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 0 0;
  }
  .invite-link-row { display: flex; gap: 8px; align-items: center; }

  .empty-state {
    text-align: center; color: var(--text-3); font-size: 13px;
    padding: 32px 16px;
  }

  /* ── Exercise source rows ──────────────────────────────────────────── */
  .src-row {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .src-row:last-child { border-bottom: none; }
  .src-info { flex: 1; min-width: 0; }
  .src-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
  .src-name { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .src-count {
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 700;
    padding: 1px 8px; border-radius: var(--radius-full);
  }
  .src-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .src-key { width: 100%; margin-top: 6px; }
  .src-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
  .btn-danger {
    background: rgba(255,92,92,0.12); border: 1px solid rgba(255,92,92,0.3);
    color: var(--danger); font-weight: 600;
    padding: 6px 12px; border-radius: var(--radius-md);
    cursor: pointer; font-size: 12px;
  }
  .btn-danger:hover:not(:disabled) { background: rgba(255,92,92,0.2); }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Sub-label (shared, :global so sub-components inherit) ──────── */
  :global(.sub-label) {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 12px 2px 4px; margin: 0;
  }
  .setting-desc {
    font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; line-height: 1.5;
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text); border: none; border-radius: var(--radius-md);
    padding: 0 14px;
    cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 6px;
    transition: opacity var(--dur-fast);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .restore-progress {
    padding: 0 0 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .restore-progress-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-2);
  }
  .restore-progress-track {
    height: 6px; border-radius: 3px;
    background: var(--surface-2); overflow: hidden;
  }
  .restore-progress-fill {
    height: 100%; border-radius: 3px;
    background: var(--accent); transition: width 300ms ease;
  }
  .spin { animation: settings-spin 0.8s linear infinite; }
  @keyframes settings-spin { to { transform: rotate(360deg); } }

  .backup-table-header {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 6px 16px;
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    color: var(--text-3);
  }
  .backup-row {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 10px 16px;
    align-items: center;
  }
  .backup-name {
    font-size: 12px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .backup-col-date { font-size: 13px; color: var(--text-2); }
  .backup-col-size { font-size: 13px; color: var(--text-2); }
  .backup-actions {
    display: flex; align-items: center; gap: 6px;
    justify-content: flex-end; flex-wrap: wrap;
  }
  .backup-action-btn {
    height: 30px; font-size: 12px; padding: 0 10px;
    display: flex; align-items: center; gap: 4px;
  }
  .btn-icon-danger {
    background: none; border: none; cursor: pointer;
    color: var(--danger); padding: 0 4px;
    display: flex; align-items: center;
  }
  .btn-icon-danger:hover { opacity: 0.7; }
  .btn-icon-danger:disabled { opacity: 0.4; cursor: not-allowed; }
  .src-clear {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--danger) !important;
    border-color: color-mix(in srgb, var(--danger) 30%, var(--border)) !important;
  }
  .src-clear:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface-2)) !important;
    border-color: var(--danger) !important;
  }

  /* Offline media pre-cache progress */
  .precache-progress { display: flex; align-items: center; gap: 10px; }
  .pp-bar {
    flex: 1; height: 6px;
    background: var(--surface-2); border-radius: var(--radius-full);
    overflow: hidden;
  }
  .pp-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
    box-shadow: 0 0 8px var(--accent-dim);
  }
  .pp-text {
    font-size: 12px; font-weight: 600; color: var(--text-2);
    font-variant-numeric: tabular-nums;
    min-width: 80px; text-align: right;
  }

  @media (max-width: 480px) {
    .backup-table-header { display: none; }
    .backup-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
    }
    .backup-name { grid-column: 1; grid-row: 1; }
    .backup-col-date { grid-column: 1; grid-row: 2; font-size: 12px; }
    .backup-col-size { display: none; }
    .backup-actions {
      grid-column: 2; grid-row: 1 / 3;
      flex-direction: column; align-items: stretch;
    }
    .backup-action-btn { justify-content: center; }
  }

  /* ── Danger Zone ────────────────────────────────────────────────────── */
  .danger-zone-label { color: var(--danger) !important; opacity: 0.85; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .setting-action {
    cursor: pointer; background: none; border: none; width: 100%; text-align: left;
    transition: background var(--dur-fast);
  }
  .setting-action:hover { background: var(--surface-2); }
  .setting-action.danger:hover { background: rgba(255,92,92,0.06); }
  .si-danger {
    font-size: 20px; color: var(--danger); flex-shrink: 0;
    width: 32px; display: flex; align-items: center; justify-content: center;
  }

  /* ── Custom color picker (NutriTrace pattern) ──────────────────────── */
  .cp-body { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
  .cp-preview {
    height: 70px; border-radius: var(--radius-lg);
    display: flex; align-items: flex-end; justify-content: flex-end;
    padding: 8px 12px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .cp-preview-hex {
    font-size: 11px; font-family: monospace; letter-spacing: 0.06em;
    color: rgba(255,255,255,0.75); text-shadow: 0 1px 3px rgba(0,0,0,0.5);
    font-weight: 600;
  }
  .cp-slider-group { display: flex; flex-direction: column; gap: 8px; }
  .cp-slider-wrap { padding: 4px 0; }
  .cp-slider {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 16px; border-radius: 8px; outline: none; cursor: pointer;
    border: 1px solid rgba(128,128,128,0.2);
  }
  .cp-hue {
    background: linear-gradient(to right,
      hsl(0,100%,50%), hsl(30,100%,50%), hsl(60,100%,50%), hsl(90,100%,50%),
      hsl(120,100%,50%), hsl(150,100%,50%), hsl(180,100%,50%), hsl(210,100%,50%),
      hsl(240,100%,50%), hsl(270,100%,50%), hsl(300,100%,50%), hsl(330,100%,50%), hsl(360,100%,50%));
  }
  .cp-sat { background: linear-gradient(to right, var(--cp-sat-lo), var(--cp-sat-hi)); }
  .cp-lgt { background: linear-gradient(to right, var(--cp-lgt-lo), var(--cp-lgt-mid), var(--cp-lgt-hi)); }
  .cp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-slider::-moz-range-thumb {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-rgb-row { display: flex; gap: 10px; }
  .cp-rgb-field { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
  .cp-rgb-input { height: 42px; text-align: center; font-size: 16px; font-weight: 600; padding: 0 4px; width: auto; }
  .cp-rgb-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--text-3); text-transform: uppercase; }
  .cp-hex-row { display: flex; align-items: center; gap: 10px; }
  .cp-hex-dot {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid var(--border); flex-shrink: 0;
  }

  /* ── Merge dialog (shown when connecting to server with existing local data) ── */
  .merge-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .merge-dialog {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    padding: 20px; width: 100%; max-width: 360px;
  }
  .merge-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .merge-option:hover { border-color: var(--accent); }
  .merge-option-title { font-size: 14px; font-weight: 600; color: var(--text-1); margin-bottom: 2px; }
  .merge-option-desc  { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .merge-counts {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
  }
  .merge-counts-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .merge-counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 4px 12px;
    font-size: 13px;
    color: var(--text-2);
  }
  .merge-counts-grid strong { color: var(--text-1); font-weight: 600; }
  .merge-progress-bar {
    height: 6px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
  }
  .merge-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
</style>
