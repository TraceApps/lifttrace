<script>
  import { onMount } from 'svelte';
  import { currentUser, userMgmtActive, loadAuthState } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { push } from 'svelte-spa-router';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { setAuthToken, resolveAssetUrl, isNative, apiUrl, getServerUrl } from '../lib/platform.js';

  let username = '';
  let password = '';
  let loading  = false;

  let showRecovery   = false;
  let recovering     = false;
  let recoveryDone   = false;
  let recoveryToken  = '';

  // OIDC providers — fetched on mount; SSO buttons render below the password
  // form when there are any. Hidden in native standalone mode (no server).
  let oidcProviders = [];
  let oidcLoaded    = false;
  let passwordLoginEnabled = true;
  $: showSso = !isNative || !!getServerUrl();

  // Biometric sign-in (Android server-mode only). Ready when hardware
  // supports it AND the user has previously logged in with biometric
  // enabled (so a saved JWT exists ready to be unlocked).
  let _biometricReady = false;

  onMount(async () => {
    if (!showSso) return;
    try {
      const res = await fetch(apiUrl('/api/auth/oidc/providers'), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        oidcProviders = Array.isArray(data.providers) ? data.providers : [];
        passwordLoginEnabled = data.enable_email_password_login !== false;
      }
    } catch {} finally { oidcLoaded = true; }

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
        else if (ok === 'linked') { await loadAuthState(); showSuccess('Linked'); }
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

  async function biometricLogin() {
    try {
      const bio = await import('../lib/biometric.js');
      const ok = await bio.authenticate('Sign in to LiftTrace');
      if (!ok) return;
      const saved = await bio.readSavedToken();
      if (!saved) { showError('No saved sign-in. Please use your password once first.'); return; }
      setAuthToken(saved);
      // /me brings the auth state up + refreshes CSRF.
      await loadAuthState();
      await loadServerSettings();
      push('/');
    } catch (e) {
      showError('Biometric sign-in failed. Use your password instead.');
    }
  }

  async function startOidc(providerId) {
    const ret = encodeURIComponent(window.location.hash || '#/');
    if (isNative) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({
        url: apiUrl(`/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}`),
        presentationStyle: 'popover',
      });
      return;
    }
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?return=${ret}`);
  }

  async function login() {
    if (!username.trim() || !password) return;
    loading = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('login.errors.failed')); return; }
      // Native Capacitor builds need the JWT in localStorage so apiFetch can
      // attach Authorization: Bearer on every subsequent request — the
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
      currentUser.set(data.user);
      await loadServerSettings();
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
      push('/');
    } catch(e) {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
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

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src={resolveAssetUrl('/icons/logo.png')} alt="LiftTrace" class="logo-img" />
      <h1 class="login-title">LiftTrace</h1>
      <p class="text-3 text-sm">{$_('login.subtitle')}</p>
    </div>

    {#if !recoveryDone}
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
          <span>Sign In with Biometric</span>
        </button>
      {/if}
      {/if}

      {#if showSso && oidcProviders.length}
        {#if passwordLoginEnabled}
          <div class="sso-divider"><span>{$_('login.or')}</span></div>
        {/if}
        <div class="sso-list">
          {#each oidcProviders as p (p.id)}
            <button class="btn btn-secondary sso-btn" type="button" on:click={() => startOidc(p.id)}>
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
          <span class="material-symbols-rounded" style="font-size:20px;color:var(--warning,#f59e0b)">warning</span>
          <p>{@html $_('login.recovery.explainer')}</p>
          <p style="margin-top:8px">{$_('login.recovery.token_prompt')}</p>
          <input class="input" type="password" bind:value={recoveryToken}
            placeholder={$_('login.recovery.token_placeholder')} />
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
</style>
