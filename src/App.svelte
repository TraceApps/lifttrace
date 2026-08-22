<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import Router, { location } from 'svelte-spa-router';

  import BottomNav from './components/layout/BottomNav.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import Sidebar   from './components/layout/Sidebar.svelte';
  import Toast     from './components/ui/Toast.svelte';
  import ConfirmDialogMount from './components/ui/ConfirmDialogMount.svelte';
  import Trace   from './components/ai/Trace.svelte';
  import { DB }    from './lib/db.js';
  import { navStyle, applyAccentColor, accentColor, applyAppearance, appearance, disableAnimations, sidebarPersistent, language, pageBanners, bannerStyle, bannerAnimation, forceMobileLayout } from './stores/settings.js';
  import { _, locale } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { portal } from './lib/portal.js';
  import { describeConnectionIssue } from './lib/connection-message.js';

  // Drive svelte-i18n's active locale from the user's saved language setting.
  $: if ($language) locale.set($language);
  import { currentUser, userMgmtActive, setupRequired, loadAuthState } from './stores/auth.js';
  import { needsNativeSetup, isNative, getNativeMode, getServerUrl, apiUrl } from './lib/platform.js';
  import { syncState } from './lib/sync.js';
  import NativeSetup from './routes/NativeSetup.svelte';

  // Native-server connection state for the hamburger offline badge.
  // Mirrors NutriTrace's pattern (App.svelte#367) — only show when the
  // user picked "Connect to server" mode AND the syncer reports offline.
  // Local-only standalone or PWA never show the badge (no server to be
  // offline from).
  $: _syncModeActive = isNative && getNativeMode() === 'server';
  // Server is reachable when the OS reports online AND the classifier
  // hasn't flagged a structured issue. Drives the red cloud badge and
  // banner suppression — matches NT's exact predicate.
  $: _serverReachable = $syncState.online && !$syncState.connectionIssue;
  // Reactive copy build for the smart connection banner. Falls back to
  // the generic "Sync error" title when a non-connection error is
  // surfaced with showFailureBanner=true.
  $: _connectionCopy = describeConnectionIssue($syncState.connectionIssue, $_, true);
  $: _syncBannerCopy = $syncState.showErrorBanner && _connectionCopy
    ? { ..._connectionCopy, icon: 'cloud_off' }
    : ($syncState.showErrorBanner && $syncState.error
      ? { title: $_('sync.error_title'), detail: $syncState.error, icon: 'error' }
      : null);

  // Pull-to-refresh gesture (native server mode). Mirrors NT App.svelte.
  // LT-specific: the whole viewport scrolls the document (not a fixed
  // .page-transition inner scroller like NT/CT), so the "at the top?"
  // check reads window.scrollY / documentElement.scrollTop rather than
  // scrollTop on the .page-transition element.
  const PULL_SYNC_SLOP = 10;
  const PULL_SYNC_THRESHOLD = 64;
  const PULL_SYNC_MAX = 88;
  let _pullStartX = 0;
  let _pullStartY = 0;
  let _pullDistance = 0;
  let _pullTracking = false;
  let _pullRefreshing = false;
  let _retryingConnection = false;

  async function _waitForSyncIdle(maxMs = 4000) {
    const start = Date.now();
    return new Promise(resolve => {
      const check = () => {
        let s; syncState.subscribe(v => s = v)();
        if (!s?.syncing || Date.now() - start > maxMs) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  async function _runForcedSync() {
    try {
      const mod = await import('./lib/sync.js');
      let result = await mod.fullSync(false, true, true);
      if (result?.reason === 'busy') {
        await _waitForSyncIdle();
        result = await mod.fullSync(false, true, true);
      }
      return result;
    } catch (e) {
      console.warn('[sync] forced sync failed:', e?.message);
      return { ok: false };
    }
  }

  async function _retryServerConnection() {
    if (_retryingConnection) return;
    _retryingConnection = true;
    try { await _runForcedSync(); }
    finally { _retryingConnection = false; }
  }

  function _dismissSyncBanner() {
    // LT imports syncState directly (not via mirror), so no dynamic
    // import needed. Clears only the full banner surface; leaves
    // connectionIssue so the badge + Settings status keep reflecting
    // the actual reachability state.
    syncState.update(s => ({ ...s, showErrorBanner: false, error: null }));
  }

  function _startPullSync(event) {
    if (!_syncModeActive || _pullRefreshing || sidebarOpen || showNativeSetup) return;
    if (event.target?.closest?.('[role="dialog"], .sheet-backdrop, .sidebar-panel, .sidebar-backdrop, .bottom-nav')) return;
    // Walk up from the touch target to the nearest scrolling ancestor.
    // Catches nested overflow containers (should the layout add one later)
    // AND the document itself (LT's current default: no nested scrollers,
    // document scrolls).
    let el = event.target;
    let foundScroller = false;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        if (el.scrollTop > 0) return;
        foundScroller = true;
        break;
      }
      el = el.parentElement;
    }
    if (!foundScroller) {
      const rootScroll = window.scrollY || document.scrollingElement?.scrollTop || 0;
      if (rootScroll > 0) return;
    }
    _pullStartX = event.touches[0].clientX;
    _pullStartY = event.touches[0].clientY;
    _pullTracking = true;
    _pullDistance = 0;
  }
  function _movePullSync(event) {
    if (!_pullTracking) return;
    const dx = event.touches[0].clientX - _pullStartX;
    const dy = event.touches[0].clientY - _pullStartY;
    if (Math.abs(dx) > Math.abs(dy)) { _pullTracking = false; _pullDistance = 0; return; }
    if (dy < PULL_SYNC_SLOP) return;
    event.preventDefault();
    _pullDistance = Math.min(PULL_SYNC_MAX, (dy - PULL_SYNC_SLOP) * 0.5);
  }
  async function _finishPullSync() {
    if (!_pullTracking) return;
    const hit = _pullDistance >= PULL_SYNC_THRESHOLD;
    _pullTracking = false;
    if (!hit) { _pullDistance = 0; return; }
    _pullRefreshing = true;
    console.info('[sync] pull-to-refresh triggered');
    try { await _runForcedSync(); }
    finally { _pullRefreshing = false; _pullDistance = 0; }
  }
  function _cancelPullSync() { _pullTracking = false; _pullDistance = 0; }

  // True on first launch in Capacitor when the user hasn't picked local-vs-server.
  // Renders before any routing so the user can't slip past it.
  let showNativeSetup = needsNativeSetup();

  // Synchronously redirect to the wizard at script-load BEFORE any route
  // resolves — kills the "Diary flashes for half a second" flicker on
  // post-NativeSetup native local launches. We can determine this state
  // from localStorage alone (isNative, getNativeMode, setupComplete are
  // all sync reads), so no need to wait for loadAuthState.
  // PWA paths still go through the async branch in onMount because
  // $setupRequired needs a server roundtrip.
  if (!showNativeSetup && isNative && getNativeMode() === 'local'
      && !DB.getSetting('setupComplete', false)
      && !window.location.hash.startsWith('#/wizard')) {
    window.location.hash = '#/wizard';
  }

  import Diary           from './routes/Diary.svelte';
  import Exercises       from './routes/Exercises.svelte';
  import ExerciseDetail  from './routes/ExerciseDetail.svelte';
  import Programs        from './routes/Programs.svelte';
  import ProgramDetail   from './routes/ProgramDetail.svelte';
  import WorkoutEditor   from './routes/WorkoutEditor.svelte';
  import Statistics      from './routes/Statistics.svelte';
  import Radio           from './routes/Radio.svelte';
  import Settings        from './routes/Settings.svelte';
  import Coaching        from './routes/Coaching.svelte';
  import MiniPlayer      from './components/radio/MiniPlayer.svelte';
  import RestTimer       from './components/diary/RestTimer.svelte';
  import FullPlayer      from './components/radio/FullPlayer.svelte';
  import WorkoutModeBar  from './components/WorkoutModeBar.svelte';
  import { miniPlayerVisible } from './stores/player.js';
  let fullPlayerOpen = false;
  import Wizard          from './routes/Wizard.svelte';
  import Login           from './routes/Login.svelte';
  import Profile         from './routes/Profile.svelte';
  import ForgotPassword  from './routes/ForgotPassword.svelte';
  import ResetPassword   from './routes/ResetPassword.svelte';
  import AcceptInvite    from './routes/AcceptInvite.svelte';

  const routes = {
    '/':                      Diary,
    '/exercises':             Exercises,
    '/exercise/:id':          ExerciseDetail,
    '/programs':              Programs,
    '/programs/:id':          ProgramDetail,
    '/programs/:programId/template/:templateId': WorkoutEditor,
    '/statistics':            Statistics,
    '/radio':                 Radio,
    '/settings':              Settings,
    '/settings/:section':     Settings,
    '/coaching':              Coaching,
    '/coaching/:memberId':    Coaching,
    '/wizard':                Wizard,
    '/profile':               Profile,
    '/forgot-password':       ForgotPassword,
    '/reset-password':        ResetPassword,
    '/accept-invite':         AcceptInvite,
    '*':                      Diary,
  };

  const NAV_HIDDEN = ['/wizard', '/profile', '/programs/', '/exercise/'];
  $: showNav = !NAV_HIDDEN.some(p => $location.startsWith(p)) ||
               $location === '/programs' || $location === '/exercises';

  // Only hide nav on wizard (setup flow)
  $: _showNav = $location !== '/wizard';

  // Viewport gate — the persistent sidebar only kicks in on tablets +
  // desktop. On phones the screen is too narrow to dedicate 280px to a
  // pinned panel (the user setting can stay ON, it just doesn't apply
  // until they're back on a wide viewport). Threshold 768px = standard
  // tablet breakpoint, matches NutriTrace's behavior. Tracks resize so a
  // tablet rotated portrait↔landscape re-evaluates without a refresh.
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;

  $: _hasSidebar   = _showNav && ($navStyle === 'sidebar' || $navStyle === 'both');
  $: sidebarPinned = _hasSidebar && _persistentAllowed && $sidebarPersistent;
  $: showHamburger = _hasSidebar && !sidebarPinned;

  // --page-top: just the device safe area (hamburger floats over banner)
  // --hamburger-offset: aligns h1 left edge with hamburger button left edge
  //   (used by the banner-on layout where the title sits BELOW the button)
  // --hamburger-row: extra header top-padding so title sits below hamburger
  //   (banner-on only — compact / no-banner layout drops this)
  // --hamburger-clearance: button RIGHT edge + small gap, used by the
  //   compact (banner-off) layout where the title sits BESIDE the button
  //   and needs padding-left to clear the button itself.
  // --sidebar-w: shifts content right when sidebar is persistent
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-top', 'var(--safe-top)');
    document.documentElement.style.setProperty(
      '--hamburger-offset',
      showHamburger ? '12px' : '0px'
    );
    // --hamburger-row only adds a vertical row of padding when the
    // banner-on layout is active (title sits BELOW the floating
    // hamburger). In banner-off / compact mode the title sits NEXT to
    // the button so no extra row is needed; setting this to 0px lets
    // sticky sub-bars (Diary date strip, Settings search) snap up
    // against the bottom of the compact header instead of leaving a
    // ~48px gap that assumed the old layout.
    // All three banner modes share the same compact-header geometry as
    // of rc.6 (illustrated SVG banners were retired), so the title
    // always sits beside the hamburger button and there's never a
    // separate "row below" to push it into. --hamburger-row stays 0.
    document.documentElement.style.setProperty('--hamburger-row', '0px');
    // 12px (left margin) + 40px (button width) + 12px (gap before title)
    document.documentElement.style.setProperty(
      '--hamburger-clearance',
      showHamburger ? '64px' : '0px'
    );
    document.documentElement.style.setProperty(
      '--sidebar-w',
      sidebarPinned ? '280px' : '0px'
    );
  }

  let sidebarOpen = false;
  let _prevPinned = false;

  function _syncSidebarToPin(pinned) {
    if (pinned) {
      sidebarOpen = true;
    } else if (_prevPinned) {
      sidebarOpen = false;
    }
    _prevPinned = pinned;
  }
  $: _syncSidebarToPin(sidebarPinned);
  $: if (!_hasSidebar) sidebarOpen = false;

  $: applyAccentColor($accentColor);
  $: applyAppearance($appearance);

  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('no-animations', !!$disableAnimations);
  }
  // Desktop opt-out — when the user turns on Force Mobile Layout in
  // Settings > Appearance, stamp html.force-mobile-layout so the
  // desktop-only CSS (Settings two-pane rail, any future >=1024px
  // layouts) reverts to the mobile stack. Mirrors NutriTrace's shape
  // exactly so shared debug tooling recognizes the same class.
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('force-mobile-layout', !!$forceMobileLayout);
  }
  // Mirror NutriTrace's banner-gradient global class so portaled top-bar
  // action buttons (.diary-topbar-actions) outside the .page-header still
  // pick up the frosted-pill treatment.
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('banner-gradient-mode', $bannerStyle === 'gradient');
    document.documentElement.classList.toggle('banner-animated-mode', $bannerStyle === 'animated');
    // Pick exactly one animation class so the CSS rules in base.css can
    // target a single decorative style without conflicting selectors.
    // Only active when bannerStyle is 'animated'; gradient + off get
    // no animation class regardless of the saved animation pick.
    for (const cls of ['banner-animation-shimmer','banner-animation-drift','banner-animation-pulse','banner-animation-aurora']) {
      document.documentElement.classList.remove(cls);
    }
    if ($bannerStyle === 'animated') {
      document.documentElement.classList.add(`banner-animation-${$bannerAnimation || 'shimmer'}`);
    }
  }
  $: document.documentElement.style.setProperty('--mini-player-h', $miniPlayerVisible ? '56px' : '0px');
  $: {
    const hasBottomNav = _showNav && ($navStyle === 'bottom' || $navStyle === 'both');
    document.documentElement.style.setProperty('--nav-bar-h', hasBottomNav ? 'var(--nav-h)' : '0px');
  }

  onMount(async () => {
    // Local-mode scheduled backup tick — JS-side scheduler that fires
    // buildBackup() when due. TraceApps parity with NT + CT.
    if (isNative && getNativeMode() === 'local') {
      import('./lib/local-backup-scheduler.js').then(({ startLocalBackupScheduler }) => {
        startLocalBackupScheduler();
      }).catch(e => console.warn('[local-backup] scheduler start failed:', e?.message));
    }

    // Migrate assistant name: legacy 'LiftBot' default → 'Trace'.
    // Users who set their own custom name keep it.
    {
      const _curName = DB.getSetting('aiAssistantName', null);
      if (_curName === 'LiftBot') {
        DB.setSetting('aiAssistantName', 'Trace');
      }
    }

    // Native server mode: kick off background sync (pull + flush queue, then
    // re-trigger on online events / app foreground). No-op in web/standalone.
    if (isNative && getNativeMode() === 'server') {
      try {
        const sync = await import('./lib/sync.js');
        sync.startBackgroundSync();
        // Periodic differential pull every 30s while the app is active.
        // The handler is silent so users don't see a blinking sync bar
        // unless something actually changed (Settings UI subscribes to
        // syncState and can show its own activity indicator).
        // Cheap enough now that pullSnapshot() is differential (steady
        // state returns 0-5 rows); the heavy snapshot path is gone.
        setInterval(() => sync.fullSync(true).catch(() => {}), 30000);
        // Resume from background → fire a visible sync (matches NT's
        // App.resume listener wiring).
        try {
          const { App: CapApp } = await import('@capacitor/app');
          CapApp.addListener('resume', () => sync.fullSync().catch(() => {}));
          // Pause (app backgrounded) → flush any pending debounced workout
          // save so Android can't kill the process with unsynced work in
          // the 350ms window. Without this, a set/exercise added just
          // before the user swipes away is lost silently.
          CapApp.addListener('pause', async () => {
            try {
              const { flushWorkoutSave } = await import('./stores/workout.js');
              await flushWorkoutSave();
            } catch {}
          });
        } catch {}
        // Web/PWA fallbacks — same reason as above but for the browser
        // page lifecycle (tab hidden, page unload). Cheap idempotent
        // flush; no-op if nothing pending.
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState !== 'hidden') return;
          try {
            const { flushWorkoutSave } = await import('./stores/workout.js');
            await flushWorkoutSave();
          } catch {}
        });
        window.addEventListener('pagehide', async () => {
          try {
            const { flushWorkoutSave } = await import('./stores/workout.js');
            await flushWorkoutSave();
          } catch {}
        });
      } catch (e) { console.warn('[App] background sync init failed:', e?.message || e); }
    } else {
      // Web / native+local — preserve existing behavior (no periodic).
      try {
        const { startBackgroundSync } = await import('./lib/sync.js');
        startBackgroundSync();
      } catch {}
    }

    // Native: schedule local notifications via Capacitor (until the
    // WorkManager bridge in Phase 10 takes over). Also re-runs on settings
    // change so toggling reminders off cancels them immediately.
    try {
      const { scheduleNativeReminders } = await import('./lib/notifications.js');
      await scheduleNativeReminders();
      window.addEventListener('wl:setting', e => {
        const k = e.detail?.key || '';
        if (k.startsWith('notif')) scheduleNativeReminders();
      });
    } catch {}

    // Capacitor deep-link handler — for OIDC SSO callback. Server callback
    // route redirects to lifttrace://oidc-callback/?token=<jwt> after a
    // successful sign-in (or ?error=… / ?linked=1 for the link flow). The
    // slash before the query string matters: Chrome Custom Tabs only
    // dispatches the OS intent reliably when the host has a trailing path.
    try {
      if (isNative) {
        const { App } = await import('@capacitor/app');
        App.addListener('appUrlOpen', async ({ url }) => {
          try {
            const { Browser } = await import('@capacitor/browser');
            await Browser.close().catch(() => {});
          } catch {}
          try {
            const u = new URL(url);
            const host = (u.hostname || u.host || '').toLowerCase();
            const params = u.searchParams;
            if (host === 'oidc-callback') {
              const errMsg = params.get('error');
              const linked = params.get('linked');
              const token = params.get('token');
              const idTokenHint = params.get('id_token_hint');
              const providerId  = params.get('provider_id');
              if (errMsg) {
                const { showError } = await import('./stores/toast.js');
                showError(decodeURIComponent(errMsg));
              } else if (linked) {
                const { showSuccess } = await import('./stores/toast.js');
                showSuccess('Linked');
                await loadAuthState();
              } else if (token) {
                const { setAuthToken } = await import('./lib/platform.js');
                setAuthToken(token);
                // Stash the OIDC session hint so logout() can ask the IdP
                // to end the session via RP-initiated logout. PWA stores
                // this in an httpOnly cookie at the same point; native
                // can't reach that jar so we keep the equivalent here.
                if (idTokenHint && providerId) {
                  try {
                    localStorage.setItem('lt:oidc_logout_hint', JSON.stringify({
                      providerId,
                      idTokenHint,
                    }));
                  } catch {}
                }
                const { showSuccess } = await import('./stores/toast.js');
                showSuccess('Signed in');
                await loadAuthState();
                // Re-evaluate the NativeSetup gate. Without this the user
                // completes OIDC from NativeSetup, gets a valid token, and
                // stays visually stuck on the setup screen — because the
                // showNativeSetup flag was captured at App.svelte mount and
                // never re-checked. needsNativeSetup() reads the current
                // nativeMode which NativeSetup persists before opening the
                // OIDC browser, so this correctly flips to false and reveals
                // the router. Cross-app fix mirrored from NutriTrace #110.
                showNativeSetup = needsNativeSetup();
                window.location.hash = '#/';
              }
            }
          } catch (e) {
            console.warn('[app] deep link parse error:', e);
          }
        });
      }
    } catch {}

    await loadAuthState();

    // Env-lock state for AI / SMTP / OIDC. Fetched globally so the Trace
    // FAB knows about env-set AI_ENABLED without waiting for Settings to
    // load. Mirrors NutriTrace #36.
    if (!isNative || getServerUrl()) {
      fetch(apiUrl('/api/app-config/env-locks'), { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(async d => {
          if (!d) return;
          const { envLocks } = await import('./stores/settings.js');
          envLocks.set(d);
        })
        .catch(() => {});
    }

    const _isNativeServer = isNative && getNativeMode() === 'server';
    const _isNativeLocal  = isNative && getNativeMode() === 'local';
    if (!isNative && $setupRequired) {
      // PWA: server has no users — force wizard with mandatory account creation
      window.location.hash = '#/wizard';
    } else if (_isNativeLocal && !DB.getSetting('setupComplete', false)) {
      // Native local first-time setup. Web "no user + no user management"
      // case is fully covered by $setupRequired above (the server tells us
      // via single_user_mode whether to suppress the wizard). Same fix as
      // NutriTrace #34.
      window.location.hash = '#/wizard';
    }

    if (isNative) {
      // Update-notification tap listener: registered at boot so a
      // shade-notification tap that cold-starts the app still routes
      // to Settings for the install action.
      import('./lib/notifications.js').then(({ registerUpdateTapListener }) => {
        registerUpdateTapListener(() => {
          import('svelte-spa-router').then(({ push }) => push('/settings/updates'));
        });
      }).catch(() => { /* ignore */ });

      // Clean stale APKs from Directory.Data/updates/ on boot.
      import('./lib/updates.js').then(({ cleanUpdateCache }) => {
        cleanUpdateCache();
      }).catch(() => { /* ignore */ });
    } else {
      // PWA: register the service worker via virtual:pwa-register so we
      // get onNeedRefresh callbacks. Without this, registerType:'prompt'
      // downloads new bundles but never tells the app they're ready.
      import('./lib/pwa-update.js').then(({ registerPwaSw }) => registerPwaSw()).catch(() => {});
    }

    // Visibility-change trigger for BOTH update channels. A user who
    // leaves the tab open for hours / a laptop that resumes from sleep
    // gets a re-check the moment the tab regains focus — respecting the
    // per-user cadence setting (Settings → Updates). The GitHub-tag
    // check returns cached inside the cadence window; the PWA SW-file
    // check just forces the browser to compare sw.js against what it
    // registered (otherwise the browser only bothers every 24h).
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        import('./lib/updates.js').then(({ checkForUpdate, getAutoCheck }) => {
          if (!getAutoCheck()) return;
          checkForUpdate({ force: false }).catch(() => {});
        }).catch(() => {});
        if (!isNative) {
          import('./lib/pwa-update.js').then(({ checkForPwaUpdate }) => checkForPwaUpdate()).catch(() => {});
        }
      });
    }

    // Periodic PWA-bundle poll on the same cadence as the GitHub-tag
    // check, so a tab that stays open all day still surfaces a fresh
    // deploy without a full reload. Cadence honors the same
    // updateCheckInterval setting; 0 (manual) disables the poll.
    if (!isNative && typeof window !== 'undefined') {
      Promise.all([
        import('./lib/pwa-update.js'),
        import('./stores/settings.js'),
      ]).then(([{ checkForPwaUpdate }, { updateCheckInterval }]) => {
        let _pwaPollTimer = null;
        const _resetPoll = (hours) => {
          if (_pwaPollTimer) clearInterval(_pwaPollTimer);
          _pwaPollTimer = null;
          const h = Number(hours) || 0;
          if (!h) return; // manual only
          _pwaPollTimer = setInterval(checkForPwaUpdate, h * 60 * 60 * 1000);
        };
        updateCheckInterval.subscribe(_resetPoll);
      }).catch(() => {});
    }
  });

  const AUTH_BYPASS = ['/forgot-password', '/reset-password', '/accept-invite'];
  $: needsLogin = $userMgmtActive && !$currentUser && !AUTH_BYPASS.includes($location);
</script>

<svelte:window
  on:touchstart|capture={_startPullSync}
  on:touchmove|nonpassive|capture={_movePullSync}
  on:touchend|capture={_finishPullSync}
  on:touchcancel|capture={_cancelPullSync}
/>

{#if showNativeSetup}
  <NativeSetup />
  <Toast />
{:else if needsLogin}
  <Login />
{:else}

<Sidebar bind:open={sidebarOpen} persistent={sidebarPinned} on:close={() => { if (!sidebarPinned) sidebarOpen = false; }} />

{#if showHamburger}
  <header class="app-topbar">
    <button
      class="hamburger"
      on:click={() => sidebarOpen = !sidebarOpen}
      aria-label="Open menu"
    >
      <span class="material-symbols-rounded">menu</span>
      {#if _syncModeActive && !_serverReachable}
        <span class="conn-badge conn-offline" aria-label="Offline">
          <span class="material-symbols-rounded" style="font-size:10px">cloud_off</span>
        </span>
      {/if}
    </button>
  </header>
{/if}

<!-- In-app update banner (native only). Renders only if the OS-level
     notification permission is denied — grants suppress the banner and
     route through a shade notification instead. -->
{#if !needsLogin}<UpdateBanner />{/if}

{#if _syncModeActive && !needsLogin && _syncBannerCopy}
  <div class="sync-connection-banner"
    use:portal
    transition:slide={{ duration: $disableAnimations ? 0 : 200 }}>
    <span class="material-symbols-rounded sync-banner-icon">{_syncBannerCopy.icon}</span>
    <div class="sync-banner-copy">
      <div class="sync-banner-title">{_syncBannerCopy.title}</div>
      <div class="sync-banner-detail">{_syncBannerCopy.detail}</div>
    </div>
    <button class="sync-banner-btn sync-banner-retry"
      on:click={_retryServerConnection}
      disabled={_retryingConnection || $syncState.syncing}>
      {_retryingConnection ? $_('sync.retrying') : $_('sync.retry')}
    </button>
    <button class="sync-banner-btn sync-banner-dismiss"
      on:click={_dismissSyncBanner}
      aria-label={$_('sync.dismiss_message')}>
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

{#if _syncModeActive && !sidebarOpen && (_pullDistance > 0 || _pullRefreshing)}
  <div
    class="pull-sync-indicator"
    class:ready-to-sync={_pullDistance >= PULL_SYNC_THRESHOLD}
    use:portal
    style:transform={`translate(-50%, ${Math.round(_pullDistance * 0.45)}px)`}
    aria-hidden="true"
  >
    <span class="material-symbols-rounded" class:pull-sync-spin={_pullRefreshing}>
      {_pullRefreshing ? 'autorenew' : 'arrow_downward'}
    </span>
  </div>
{/if}

{#key ($location || '').split('/')[1] || ''}
  <!-- Key on the FIRST url segment ('settings', 'diary', etc.) rather
       than the full $location. Full-location keying meant any sub-path
       change (jumping between /settings/appearance <-> /settings/units
       via the desktop rail) triggered a full route remount + fade-in,
       which reads as a page load and blows away all local state in the
       shell (rail scroll, expand states, cross-fade context, etc.).
       Segment-keyed means only true shell changes animate. Matches
       NutriTrace's pattern. -->
  <div
    class="page-transition"
    in:fade={{ duration: $disableAnimations ? 0 : 180 }}
  >
    <Router {routes} />
  </div>
{/key}

{#if _showNav && ($navStyle === 'bottom' || $navStyle === 'both')}
  <BottomNav />
{/if}

<MiniPlayer on:expand={() => fullPlayerOpen = true} />
<FullPlayer bind:open={fullPlayerOpen} />
<RestTimer />
<WorkoutModeBar />
<Toast />
<ConfirmDialogMount />
<Trace />

{/if}

{#if needsLogin}<Toast />{/if}

<style>
  :global(body) { overflow-x: hidden; }

  :global(.no-animations *) {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }

  .app-topbar {
    position: fixed;
    top: var(--safe-top);
    left: 0; right: 0;
    height: 0;
    z-index: 40;
    pointer-events: none;
  }

  .hamburger {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    left: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    background: var(--surface-1);
    border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    z-index: 41;
    pointer-events: all;
    color: var(--text-1);
    box-shadow: var(--shadow-sm);
    transition: background var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
  }
  .hamburger:hover  { background: var(--surface-2); }
  .hamburger:active { transform: scale(0.92); }

  /* Connection badge on the hamburger — visible only in native-server
     mode while offline. Mirrors NutriTrace's App.svelte rule for cross-
     app brand consistency. */
  .conn-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface-1);
    transition: background 0.3s;
  }
  .conn-offline {
    background: var(--error, #ef4444);
    color: #fff;
  }

  /* Smart connection banner. Ported from NT so it sits BELOW the
     device status bar and the app's compact header instead of covering
     the clock / hamburger on Android. */
  .sync-connection-banner {
    position: fixed;
    top: calc(var(--safe-top) + 60px);
    left: calc(var(--sidebar-w, 0px) + 12px);
    right: 12px;
    z-index: 250;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    color: var(--error, #ef4444);
    background: color-mix(in srgb, var(--error, #ef4444) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--error, #ef4444) 25%, var(--border));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    font-size: 12px;
    font-weight: 500;
    transition: left 0.25s ease;
  }
  .sync-banner-icon {
    flex: 0 0 auto;
    font-size: 18px;
  }
  .sync-banner-copy {
    min-width: 0; flex: 1;
    display: flex; flex-direction: column; gap: 2px;
    line-height: 1.35;
  }
  .sync-banner-title { font-size: 13px; font-weight: 600; }
  .sync-banner-detail { color: var(--text-2); font-weight: 400; }
  .sync-banner-btn {
    flex: 0 0 auto;
    border: 0;
    color: var(--error, #ef4444);
    background: transparent;
    font: inherit; font-weight: 600;
    cursor: pointer;
  }
  .sync-banner-btn:disabled { opacity: 0.6; cursor: default; }
  .sync-banner-dismiss {
    display: flex; align-items: center;
    padding: 2px;
  }
  .sync-banner-dismiss .material-symbols-rounded { font-size: 18px; }

  /* Pull-to-refresh spinner — mirrors NT App.svelte exactly. Fixed
     top with safe-area offset so it clears the status bar; left
     accounts for a persistent sidebar so it centers over the CONTENT
     area, not the whole viewport. */
  .pull-sync-indicator {
    position: fixed;
    top: calc(var(--safe-top, 0px) + 8px);
    left: calc(var(--sidebar-w, 0px) + (100vw - var(--sidebar-w, 0px)) / 2);
    z-index: 251;
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-2);
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    box-shadow: var(--shadow-lg);
    pointer-events: none;
    transition: color 120ms, border-color 120ms;
  }
  .pull-sync-indicator.ready-to-sync {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .pull-sync-indicator .material-symbols-rounded {
    font-size: 20px;
    transition: transform 120ms;
  }
  .pull-sync-indicator.ready-to-sync .material-symbols-rounded {
    transform: rotate(180deg);
  }
  @keyframes pull-sync-spin { to { transform: rotate(360deg); } }
  .pull-sync-indicator .pull-sync-spin {
    animation: pull-sync-spin 0.8s linear infinite;
  }

  :global(.page-transition) {
    position: relative;
    min-height: 100dvh;
    width: calc(100% - var(--sidebar-w, 0px));
    margin-left: var(--sidebar-w, 0px);
    transition: margin-left 0.25s ease, width 0.25s ease;
  }
  :global(.bottom-nav) {
    left: var(--sidebar-w, 0px) !important;
    transition: left 0.25s ease !important;
  }
</style>
