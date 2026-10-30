<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, userMgmtActive, loadAuthState, signInProblem, serverProblem, setupRequired, sessionEnded } from '../stores/auth.js';
  import { problemKey } from '../lib/auth-plan.js';
  import { cookieBlockedByHttp, droppedCookieReason } from '../lib/cookie-check.js';
  import CookieWarning from '../components/ui/CookieWarning.svelte';
  import { loadServerSettings } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { push } from 'svelte-spa-router';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { setAuthToken, resolveAssetUrl, iconUrl, isNative, apiUrl, getServerUrl } from '../lib/platform.js';
  import { responseJson, discoverSignIn } from '../lib/server-signin.js';
  import { twoStepChallenge } from '../lib/two-step.js';
  import TwoStepChallenge from '../components/two-step/TwoStepChallenge.svelte';
  import { isShortcutHash } from '../lib/app-shortcut.js';

  let username = '';
  let password = '';
  let loading  = false;

  let showRecovery   = false;
  let recovering     = false;
  let recoveryDone   = false;
  let recoveryToken  = '';
  // Locked Out? can also reset two-step sign-in for one account (nutritrace#222).
  let recoveryUsername = '';
  let resettingTwoStep = false;

  // Two-step sign-in (nutritrace#222): after a right password, the server may
  // ask for a code ('verify') or for setup ('setup'). Null while it doesn't.
  let challenge = null;
  let challengeShortcut = false;

  // OIDC providers — fetched on mount; SSO buttons render below the password
  // form when there are any. Hidden in native standalone mode (no server).
  let oidcProviders = [];
  let oidcLoaded    = false;
  let passwordLoginEnabled = true;
  let optionsError = '';  // the sign-in options couldn't be read: said, with Retry (TraceApps/notetrace#36)
  $: showSso = !isNative || !!getServerUrl();

  // Biometric sign-in (Android server-mode only). Ready when hardware
  // supports it AND the user has previously logged in with biometric
  // enabled (so a saved JWT exists ready to be unlocked).
  let _biometricReady = false;

  // Why signing in won't stick, if it won't: plain HTTP with an HTTPS-only
  // cookie is known before anyone signs in. See lib/cookie-check.js.
  let authStatus = null;

  onMount(async () => {
    if (!showSso) return;
    await loadSignInOptions();

    // Surface error/ok params from the IdP redirect (PWA path).
    try {
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      if (qIdx >= 0) {
        const q = new URLSearchParams(hash.slice(qIdx + 1));
        const err = q.get('oidc_error');
        const ok  = q.get('oidc');
        if (err) showError(decodeURIComponent(err));
        else if (ok === 'ok')     { await loadAuthState(); push('/'); }
        else if (ok === 'linked') { await loadAuthState(); showSuccess($_('login.linked')); }
      }
    } catch {}

    // Probe biometric availability + saved-token presence concurrently
    if (isNative && getServerUrl()) {
      try {
        const bio = await import('../lib/biometric.js');
        const [available, saved] = await Promise.all([bio.isAvailable(), bio.readSavedToken()]);
        _biometricReady = available && !!saved;
      } catch {}
    }
  });

  // The server couldn't say who is signed in (no connection, a gateway's
  // error page, a sign-in proxy's page): said at the top, with Retry, which
  // also runs on its own when the connection comes back. A server that
  // answers again takes over: the app opens if this browser is still
  // signed in, or this page signs in as usual.
  let rechecking = false;
  async function recheckServer() {
    if (rechecking) return;
    rechecking = true;
    try {
      await loadAuthState();
      // Back, and freshly installed: its first account is made in setup.
      if (!isNative && get(setupRequired)) { push('/wizard'); return; }
      if (!get(serverProblem)) await loadSignInOptions();
    } finally { rechecking = false; }
  }
  function _backOnline() { if (get(serverProblem)) recheckServer(); }

  // The server's sign-in options, from /api/auth/status. The app asks
  // natively (no CORS, so a sign-in proxy's page is said as such, not
  // "Failed to fetch"); the web page asks its own origin. When they can't
  // be read, the page says so with Retry and keeps the password form.
  async function loadSignInOptions() {
    try {
      let data;
      if (isNative) data = (await discoverSignIn(getServerUrl())).status;
      else {
        const r = await fetch(apiUrl('/api/auth/status'), { credentials: 'include' });
        data = await responseJson(r);
        if (!r.ok) throw Object.assign(new Error(`status ${r.status}`), { status: r.status });
      }
      authStatus = data;
      // Plain HTTP with an HTTPS-only cookie: said before anyone signs in.
      if (!isNative && cookieBlockedByHttp(authStatus)) signInProblem.set('http');
      if (data?.oidc) {
        oidcProviders = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
        passwordLoginEnabled = data.oidc.enable_email_password_login !== false;
      } else {
        await _providersFromOlderServer();
      }
      optionsError = '';
    } catch (e) {
      console.warn('[login] sign-in options:', e?.status || e?.message);
      optionsError = e?.webPage ? e.message : $_('server_signin.options_failed');
    } finally {
      oidcLoaded = true;
    }
  }

  // A server from before /api/auth/status told of SSO lists it here.
  async function _providersFromOlderServer() {
    try {
      const res = await fetch(apiUrl('/api/auth/oidc/providers'), { credentials: 'include' });
      if (!res.ok) return;
      const data = await responseJson(res);
      oidcProviders = Array.isArray(data.providers) ? data.providers : [];
      passwordLoginEnabled = data.enable_email_password_login !== false;
    } catch { /* password only, as before */ }
  }

  async function biometricLogin() {
    // An app icon shortcut waiting under this screen opens once signed in.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    try {
      const bio = await import('../lib/biometric.js');
      const ok = await bio.authenticate('Sign in to LiftTrace');
      if (!ok) return;
      const saved = await bio.readSavedToken();
      if (!saved) { showError($_('login.no_saved')); return; }
      setAuthToken(saved);
      // /me brings the auth state up + refreshes CSRF.
      await loadAuthState();
      // If /me rejected the saved token (expired, JWT_SECRET rotated,
      // backup restored, server URL changed), loadAuthState cleared
      // currentUser. Without an explicit check the user lands on '/'
      // briefly then bounces right back to Login — looks like biometric
      // "did nothing." Surface the error + wipe the stale stash so the
      // next tap doesn't repeat the loop. Mirrors the NT fix (commit
      // 9d33afb) confirmed via logcat when an NT JWT hit the 30-day
      // expiry boundary.
      if (!get(currentUser)) {
        showError($_('login.saved_expired'));
        await bio.clearSavedToken();
        return;
      }
      await loadServerSettings();
      if (!shortcutWaiting) push('/');
    } catch (e) {
      console.warn('[login] biometric flow failed:', e);
      showError($_('login.biometric_failed'));
    }
  }

  // One sign-in at a time: a second tap would open another browser and
  // replace the code's secret, so the first one's hand-off would fail.
  let ssoOpening = false;
  async function startOidc(providerId) {
    if (ssoOpening) return;
    ssoOpening = true;
    const ret = encodeURIComponent(window.location.hash || '#/');
    if (isNative) {
      try {
        const { Browser } = await import('@capacitor/browser');
        const { appChallengeParam } = await import('../lib/oidc-app-handoff.js');
        await Browser.open({
          url: apiUrl(`/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}${await appChallengeParam()}`),
          presentationStyle: 'popover',
        });
      } catch {
        showError($_('native_setup.toast.cant_open_oidc'));
      } finally {
        ssoOpening = false;
      }
      return;
    }
    // The web page leaves for the sign-in page; the button stays off.
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?return=${ret}`);
  }

  async function login() {
    if (!username.trim() || !password) return;
    // An app icon shortcut waiting under this screen opens once signed in:
    // read now, as the Diary may take it (and change the address) first.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    loading = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await responseJson(res);
      const ch = twoStepChallenge(data);
      if (ch) { challenge = ch; challengeShortcut = shortcutWaiting; return; }
      if (!res.ok) { showError(data.error || $_('login.errors.failed')); return; }
      await signedIn(data, shortcutWaiting);
    } catch(e) {
      // A sign-in proxy's web page in place of the server: said as such (TraceApps/notetrace#36).
      showError(e?.webPage ? e.message : $_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }

  // The second step finished: signed in as with a password alone.
  async function twoStepDone(e) {
    const data = e.detail || {};
    loading = true;
    try {
      await signedIn(data, challengeShortcut);
      if (data.recovery_codes_left != null) {
        showSuccess($_('two_step.signin.recovery_used', { values: { count: data.recovery_codes_left } }));
      }
    } catch {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }
  function twoStepRestart(e) {
    challenge = null;
    password = '';
    if (e.detail?.message) showError(e.detail.message);
  }

  // Signed in: the session (cookie on the web, token in the app), then the app.
  async function signedIn(data, shortcutWaiting) {
    // Native Capacitor builds need the JWT in localStorage so apiFetch can
    // attach Authorization: Bearer on every subsequent request: the
    // WebView doesn't reliably persist cookies across launches. Browser
    // PWA builds ignore this; they ride on the cookie the server set.
    if (data.token) setAuthToken(data.token);
    // If biometric login is enabled, stash the JWT so the next launch
    // can unlock with fingerprint/face instead of typing the password.
    if (isNative && data.token) {
      try {
        const { biometricLoginEnabled } = await import('../stores/settings.js');
        const { saveTokenForBiometric } = await import('../lib/biometric.js');
        const { get } = await import('svelte/store');
        if (get(biometricLoginEnabled)) await saveTokenForBiometric(data.token);
      } catch {}
    }
    localStorage.setItem('wl:userId', String(data.user.id));
    if (isNative) {
      currentUser.set(data.user);
      await loadServerSettings();
    } else {
      // Web: read the user back from the server rather than setting it
      // from this reply, so the app only appears once the session cookie
      // has actually stuck. If it didn't, say why instead of looping.
      // get(), not $currentUser: this page can be torn down meanwhile.
      await loadAuthState();
      if (!get(currentUser)) {
        signInProblem.set(droppedCookieReason(authStatus));
        challenge = null;
        return;
      }
      signInProblem.set(null);
    }
    challenge = null;
    // Native server mode: kick a full sync now so workouts / programs /
    // body stats land in the local cache before the user reaches the
    // home screen. Without this, the first 30 seconds after login show
    // empty Diary / Stats / Programs pages while the background timer
    // catches up.
    if (isNative && getServerUrl()) {
      try {
        const { fullSync, startBackgroundSync } = await import('../lib/sync.js');
        startBackgroundSync();
        await fullSync();
      } catch (e) { console.warn('[login] post-login sync failed:', e?.message || e); }
    }
    if (!shortcutWaiting) push('/');
  }

  // Locked Out?, the owner's way back in for one account: RECOVERY_TOKEN
  // turns two-step sign-in off for that account and changes nothing else.
  async function resetTwoStep() {
    if (!recoveryToken.trim() || !recoveryUsername.trim()) return;
    resettingTwoStep = true;
    try {
      const res = await fetch(apiUrl('/api/auth/two-step/recover'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim(), username: recoveryUsername.trim() }),
      });
      const data = await responseJson(res);
      if (!res.ok) { showError(data.error || $_('two_step.locked_out.failed')); return; }
      showSuccess($_('two_step.locked_out.done', { values: { name: recoveryUsername.trim() } }));
      recoveryToken = '';
      showRecovery = false;
      username = recoveryUsername.trim();
      recoveryUsername = '';
    } catch (e) {
      showError(e?.webPage ? e.message : $_('common.errors.cant_reach_server'));
    } finally {
      resettingTwoStep = false;
    }
  }

  async function recover() {
    recovering = true;
    try {
      if (!recoveryToken.trim()) { showError($_('login.recovery.token_missing')); recovering = false; return; }
      const res = await fetch('/api/auth/recover', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('login.recovery.failed')); return; }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      recoveryDone = true;
      showSuccess($_('login.recovery.success'));
    } catch(e) {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      recovering = false;
    }
  }

  function onKey(e) { if (e.key === 'Enter') login(); }
</script>

<svelte:window on:online={_backOnline} />

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src={iconUrl('/icons/logo.png')} alt="LiftTrace" class="logo-img" />
      <h1 class="login-title">{$_('login.app_name')}</h1>
      <p class="text-3 text-sm">{$_('login.subtitle')}</p>
    </div>

    {#if $signInProblem}
      <CookieWarning reason={$signInProblem} />
    {/if}

    {#if $serverProblem}
      <div class="options-error server-problem" role="alert">
        <span>{$_(problemKey($serverProblem, isNative))}</span>
        <button class="btn btn-secondary options-retry" type="button" on:click={recheckServer} disabled={rechecking}>{$_('server_signin.retry')}</button>
      </div>
    {/if}

    {#if $sessionEnded && !challenge}
      <!-- This device was signed out (a password change, Sign Out Everywhere: server/lib/session-version.js). -->
      <div class="session-ended" role="status">
        <span class="material-symbols-rounded">logout</span>
        <div>{$_('login.session_ended')}</div>
      </div>
    {/if}

    {#if challenge}
      <TwoStepChallenge {challenge} account={username.trim()} on:done={twoStepDone} on:restart={twoStepRestart} />
    {:else if !recoveryDone}
      {#if passwordLoginEnabled}
      <div class="form-group">
        <label class="form-label">{$_('login.username')}</label>
        <input class="input" type="text" autocomplete="username"
          bind:value={username} on:keydown={onKey}
          placeholder={$_('login.username_placeholder')} autofocus />
      </div>

      <div class="form-group">
        <label class="form-label">{$_('login.password')}</label>
        <input class="input" type="password" autocomplete="current-password"
          bind:value={password} on:keydown={onKey}
          placeholder={$_('login.password_placeholder')} />
      </div>

      <button class="btn btn-primary w-full" class:loading on:click={login} disabled={loading || !username || !password}>
        {loading ? $_('login.signing_in') : $_('login.sign_in')}
      </button>

      {#if _biometricReady}
        <button class="btn btn-secondary w-full" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px"
          on:click={biometricLogin} disabled={loading}>
          <span class="material-symbols-rounded" style="font-size:20px">fingerprint</span>
          <span>{$_('login.biometric_signin')}</span>
        </button>
      {/if}
      {/if}

      {#if optionsError && !$serverProblem}
        <div class="options-error" role="alert">
          <span>{optionsError}</span>
          <button class="btn btn-secondary options-retry" type="button" on:click={loadSignInOptions}>{$_('server_signin.retry')}</button>
        </div>
      {/if}

      {#if showSso && oidcProviders.length}
        {#if passwordLoginEnabled}
          <div class="sso-divider"><span>{$_('login.or')}</span></div>
        {/if}
        <div class="sso-list">
          {#each oidcProviders as p (p.id)}
            <button class="btn btn-secondary sso-btn" type="button" on:click={() => startOidc(p.id)} disabled={ssoOpening}>
              {#if p.logo_url}
                <img src={p.logo_url} alt="" class="sso-logo" />
              {:else}
                <span class="material-symbols-rounded sso-logo">vpn_key</span>
              {/if}
              <span>{$_('login.continue_with', { values: { provider: p.display_name || 'OIDC' } })}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div style="text-align:center">
        <button class="recovery-toggle" on:click={() => push('/forgot-password')}>{$_('login.forgot_password')}</button>
      </div>

      <!-- Locked out recovery -->
      <button class="recovery-toggle" on:click={() => showRecovery = !showRecovery}>
        {showRecovery ? $_('common.hide') : $_('login.locked_out')}
      </button>

      {#if showRecovery}
        <div class="recovery-box" transition:slide={{ duration: 180 }}>
          <p style="margin:0">{@html $_('login.recovery.token_prompt')}</p>
          <input class="input" type="password" bind:value={recoveryToken}
            placeholder={$_('login.recovery.token_placeholder')} />

          <!-- The gentler way first: two-step sign-in off for one account. -->
          <div class="recovery-part">
            <strong class="recovery-heading">{$_('two_step.locked_out.title')}</strong>
            <p style="margin:0">{$_('two_step.locked_out.explain')}</p>
            <input class="input" type="text" autocomplete="off" autocapitalize="off" bind:value={recoveryUsername} placeholder={$_('two_step.locked_out.username_placeholder')} />
            <button class="btn btn-secondary" style="width:100%" on:click={resetTwoStep} disabled={resettingTwoStep || !recoveryToken.trim() || !recoveryUsername.trim()}>
              {resettingTwoStep ? $_('two_step.locked_out.resetting') : $_('two_step.locked_out.action')}
            </button>
          </div>

          <div class="recovery-part">
            <strong class="recovery-heading recovery-heading-danger">
              <span class="material-symbols-rounded" style="font-size:18px;color:var(--warning,#f59e0b)">warning</span>
              {$_('two_step.locked_out.disable_title')}
            </strong>
            <p style="margin:0">{@html $_('login.recovery.explainer')}</p>
          </div>
          <button class="btn btn-secondary" style="width:100%;border-color:var(--danger);color:var(--danger)"
            on:click={recover} disabled={recovering || !recoveryToken.trim()}>
            {recovering ? $_('login.recovery.disabling') : $_('login.recovery.action')}
          </button>
        </div>
      {/if}
    {:else}
      <div style="text-align:center;padding:8px 0">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="margin-top:8px;color:var(--text-2)">{@html $_('login.recovery.done')}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .options-error {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    padding: 10px 12px; margin-bottom: 12px; border-radius: 8px; font-size: 13px; color: var(--text-2);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
  .options-retry { height: 32px; padding: 0 14px; font-size: 13px; }
  .login-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
  }
  .login-card {
    width: 100%;
    max-width: 360px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .login-logo {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    text-align: center;
  }
  .logo-img {
    width: 72px;
    height: 72px;
    border-radius: 16px;
    object-fit: cover;
  }
  .login-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0;
  }
  .recovery-toggle {
    background: none;
    border: none;
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    text-align: center;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .recovery-toggle:hover { color: var(--text-2); }
  .recovery-part { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
  .recovery-heading { display: flex; align-items: center; gap: 6px; color: var(--text-1); font-size: 13px; }
  .recovery-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .sso-divider {
    display: flex; align-items: center; gap: 10px;
    color: var(--text-3); font-size: 12px;
    margin: 4px 0;
  }
  .sso-divider::before, .sso-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }
  .sso-list { display: flex; flex-direction: column; gap: 8px; }
  .sso-btn {
    display: flex; align-items: center; justify-content: center;
    gap: 10px; width: 100%;
  }
  .sso-logo {
    width: 18px; height: 18px; object-fit: contain;
    font-size: 18px;
  }
  .session-ended {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px; background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent); border-radius: 4px;
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .session-ended .material-symbols-rounded { font-size: 20px; color: var(--accent); flex-shrink: 0; }
</style>
