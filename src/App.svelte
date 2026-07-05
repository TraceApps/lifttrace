<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import Router, { location } from 'svelte-spa-router';

  import BottomNav from './components/layout/BottomNav.svelte';
  import Sidebar   from './components/layout/Sidebar.svelte';
  import Toast     from './components/ui/Toast.svelte';
  import ConfirmDialogMount from './components/ui/ConfirmDialogMount.svelte';
  import Trace   from './components/ai/Trace.svelte';
  import { DB }    from './lib/db.js';
  import { navStyle, applyAccentColor, accentColor, applyAppearance, appearance, disableAnimations, sidebarPersistent, language, pageBanners, bannerStyle, bannerAnimation } from './stores/settings.js';
  import { locale } from 'svelte-i18n';

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
        } catch {}
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
  });

  const AUTH_BYPASS = ['/forgot-password', '/reset-password', '/accept-invite'];
  $: needsLogin = $userMgmtActive && !$currentUser && !AUTH_BYPASS.includes($location);
</script>

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
      {#if _syncModeActive && !$syncState.online}
        <span class="conn-badge conn-offline" aria-label="Offline">
          <span class="material-symbols-rounded" style="font-size:10px">cloud_off</span>
        </span>
      {/if}
    </button>
  </header>
{/if}

{#key $location}
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
