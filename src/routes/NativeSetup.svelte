<script>
  import { _ } from 'svelte-i18n';
  import { setNativeMode, setServerUrl, setAuthToken, resolveAssetUrl, iconUrl } from '../lib/platform.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { countLocalData, uploadLocalToServer } from '../lib/migrate.js';
  import { destroyLocalDb } from '../lib/db-native.js';

  // 'choose'         — Use Locally / Connect to Server picker
  // 'server-url'     — enter URL (NEW step, unlocks OIDC-only discovery)
  // 'server-auth'    — password form + OIDC buttons based on /api/auth/status
  // 'migrate-choice' — three-option dialog when local data exists (password flow only)
  // 'migrating'      — upload in flight, with progress
  // 'migration-done' — final summary screen with continue button
  //
  // The two-step split (server-url → server-auth) unlocks OIDC-only servers
  // (NT #110, mirrored here): the old single form demanded username+password
  // to submit, so users of Authentik-backed OIDC-only LiftTrace servers
  // couldn't get past this screen on a fresh install. Now the URL is
  // validated first, then we ask the server which auth methods to render.
  //
  // Migration limitation: the local-data migration prompt only fires on the
  // password path (connectToServer). OIDC completion happens via deep-link
  // callback in App.svelte which bypasses this component's logic. Existing
  // LT standalone users converting to OIDC-only auth would skip the
  // migration prompt — very narrow case (someone with pre-existing local
  // data setting up a brand-new OIDC-only server) and they can still clear
  // local data via Settings → Clear Local. Not fixing until a real report
  // surfaces.
  let step = 'choose';
  let serverUrl = '';
  let validatedUrl = '';        // set after successful step-1 validation
  let providers = [];            // OIDC providers array from /api/auth/status
  let passwordLoginEnabled = true;
  let username = '';
  let password = '';
  let showPw = false;
  let connecting = false;

  // Local-data state — populated after a successful login on the server form
  let localCounts = null;
  let migrateBusy = false;
  let migrateStage = '';
  let migrateProgress = { current: 0, total: 0 };
  let migrateSummary = null;

  function chooseLocal() {
    setNativeMode('local');
    setServerUrl(null);
    // Reload — local SQLite initializes lazily when first hit by LtApiNative.
    window.location.reload();
  }

  function chooseServer() {
    step = 'server-url';
  }

  // Step 1 → step 2: validate server reachability + discover which auth
  // methods the server supports. Uses CapacitorHttp to bypass WebView CORS.
  async function validateAndNext() {
    if (!serverUrl.trim()) { showError($_('native_setup.toast.server_url_required')); return; }
    const url = serverUrl.trim().replace(/\/$/, '');
    connecting = true;
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
      if (healthRes.status < 200 || healthRes.status >= 300) {
        throw new Error(`Server returned ${healthRes.status}`);
      }
      // Discover auth methods. If /api/auth/status fails or is missing OIDC
      // shape, fall back to password-only (safe default matching pre-fix).
      let discoveredProviders = [];
      let discoveredPasswordEnabled = true;
      try {
        const statusRes = await CapacitorHttp.get({ url: `${url}/api/auth/status` });
        if (statusRes.status >= 200 && statusRes.status < 300) {
          const data = typeof statusRes.data === 'string' ? JSON.parse(statusRes.data) : statusRes.data;
          if (data?.oidc) {
            discoveredProviders = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
            discoveredPasswordEnabled = data.oidc.enable_email_password_login !== false;
          }
        }
      } catch { /* leave defaults — safe fallback */ }
      validatedUrl = url;
      providers = discoveredProviders;
      passwordLoginEnabled = discoveredPasswordEnabled;
      step = 'server-auth';
    } catch (e) {
      showError(e.message || $_('native_setup.toast.cant_reach'));
    } finally {
      connecting = false;
    }
  }

  // Step 2 (password branch): traditional username+password sign-in. Preserves
  // the existing LT flow including the local-data migration prompt that fires
  // after successful login.
  async function loginWithPassword() {
    if (!username.trim() || !password.trim()) { showError($_('native_setup.toast.credentials_required')); return; }
    connecting = true;
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const loginRes = await CapacitorHttp.post({
        url: `${validatedUrl}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { username: username.trim(), password },
      });
      const data = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
      if (loginRes.status < 200 || loginRes.status >= 300) {
        throw new Error(data?.error || 'Login failed');
      }

      // Flip native mode → server BEFORE checking for local data, so the
      // upload pass (if the user picks it) routes through apiFetch correctly.
      // Local SQLite stays intact; we just stop reading from it for new ops.
      setServerUrl(validatedUrl);
      setAuthToken(data.token);
      setNativeMode('server');

      // If user has been running standalone, count what's there. If anything
      // exists, show the three-option migration dialog. Otherwise done.
      try {
        localCounts = await countLocalData();
      } catch {
        localCounts = null;
      }
      if (localCounts && localCounts.total > 0) {
        showSuccess($_('native_setup.toast.connected'));
        step = 'migrate-choice';
      } else {
        showSuccess($_('native_setup.toast.connected'));
        window.location.reload();
      }
    } catch (e) {
      showError(e.message || $_('native_setup.toast.cant_connect'));
    } finally {
      connecting = false;
    }
  }

  // Step 2 (OIDC branch): opens the Authentik/Keycloak/etc. sign-in flow in
  // the Capacitor browser. Server URL + native mode are persisted BEFORE
  // opening the browser because the deep-link callback (App.svelte
  // appUrlOpen handler) sets only the auth token — it relies on the app
  // already knowing which server to talk to. If the user cancels mid-OIDC,
  // the app is in a "URL known, no token" state and next launch lands on
  // Login.svelte which correctly renders the OIDC button now that
  // getServerUrl() is populated.
  //
  // NOTE: OIDC path skips the LT-specific local-data migration prompt. See
  // header comment for rationale.
  async function loginWithOidc(providerId) {
    setServerUrl(validatedUrl);
    setNativeMode('server');
    try {
      const ret = encodeURIComponent('#/');
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({
        url: `${validatedUrl}/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}`,
        presentationStyle: 'popover',
      });
      // Deep-link callback (lifttrace://oidc-callback?token=…) handled by
      // App.svelte's appUrlOpen listener — it sets the token, calls
      // loadAuthState, redirects to '#/', and the main app renders.
    } catch (e) {
      showError($_('native_setup.toast.cant_open_oidc'));
    }
  }

  // ── Migration handlers (unchanged from pre-fix; only reached via password path) ──
  async function migrateUpload(alsoPullAfter = false) {
    migrateBusy = true;
    step = 'migrating';
    migrateStage = '';
    migrateProgress = { current: 0, total: 0 };
    try {
      const summary = await uploadLocalToServer({
        onProgress: (stage, current, total) => {
          migrateStage    = stage;
          migrateProgress = { current, total };
        },
      });
      migrateSummary = summary;
      if (alsoPullAfter) {
        try {
          const { runSync } = await import('../lib/sync.js');
          await runSync();
        } catch {}
      }
      step = 'migration-done';
    } catch (e) {
      showError(e.message || $_('native_setup.toast.migration_failed'));
      step = 'migrate-choice';
    } finally {
      migrateBusy = false;
    }
  }

  async function migrateDownload() {
    migrateBusy = true;
    try {
      await destroyLocalDb();
      showSuccess($_('native_setup.toast.local_cleared'));
    } catch (e) {
      showError(e.message || $_('native_setup.toast.cant_clear_local'));
    } finally {
      migrateBusy = false;
    }
    window.location.reload();
  }

  function migrateSkip() {
    window.location.reload();
  }

  function finishMigration() {
    window.location.reload();
  }

  function backToChoose() {
    step = 'choose';
    serverUrl = '';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    username = '';
    password = '';
  }

  function backToServerUrl() {
    step = 'server-url';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    username = '';
    password = '';
  }

  const STAGE_LABELS = {
    customExercises: 'custom exercises',
    programs:        'programs',
    workouts:        'workouts',
    bodyStats:       'body stats',
    settings:        'settings',
  };
</script>

<div class="setup-wrap">
  <div class="setup-inner">
    <div class="setup-brand">
      <img src={iconUrl('/icons/icon-192.png')} alt="LiftTrace" class="setup-logo" />
      <h1 class="setup-title">{$_('native_setup.title')}</h1>
      <p class="setup-subtitle">{$_('native_setup.subtitle')}</p>
    </div>

    {#if step === 'choose'}
      <div class="setup-cards">
        <button class="setup-card" on:click={chooseLocal}>
          <span class="material-symbols-rounded setup-card-icon">smartphone</span>
          <div class="setup-card-title">{$_('native_setup.use_locally')}</div>
          <p class="setup-card-desc">
            All data stays on this device. Works fully offline, no server needed.
            You can connect to a server later in Settings.
          </p>
        </button>

        <button class="setup-card" on:click={chooseServer}>
          <span class="material-symbols-rounded setup-card-icon">cloud_sync</span>
          <div class="setup-card-title">{$_('native_setup.connect_server')}</div>
          <p class="setup-card-desc">
            Sync with your LiftTrace server. Your workouts are available on
            every device and the web app.
          </p>
        </button>
      </div>

    {:else if step === 'server-url'}
      <div class="setup-form">
        <div class="form-group">
          <label class="form-label">{$_('native_setup.server_url')}</label>
          <input
            class="input"
            type="url"
            placeholder="https://lifttrace.example.com"
            bind:value={serverUrl}
            autocapitalize="off"
            autocorrect="off"
          />
          <p class="form-hint">
            After you enter your server, sign-in options (password or SSO)
            will be shown based on what your server supports.
          </p>
        </div>

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToChoose} disabled={connecting}>{$_('native_setup.back')}</button>
          <button class="btn btn-primary" on:click={validateAndNext} disabled={connecting}>
            {connecting ? 'Checking…' : 'Next'}
          </button>
        </div>
      </div>

    {:else if step === 'server-auth'}
      <div class="setup-form">
        <p class="server-line">
          <span class="material-symbols-rounded server-icon">cloud_done</span>
          <span class="server-url">{validatedUrl}</span>
        </p>

        {#if providers.length}
          <div class="oidc-list">
            {#each providers as p (p.id)}
              <button class="btn btn-primary oidc-btn" on:click={() => loginWithOidc(p.id)} disabled={connecting}>
                {#if p.logo_url}
                  <img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-logo" on:error={e => e.target.style.display='none'} />
                {:else}
                  <span class="material-symbols-rounded" style="font-size:20px">login</span>
                {/if}
                Sign in with {p.display_name || p.name || p.id}
              </button>
            {/each}
          </div>
        {/if}

        {#if passwordLoginEnabled && providers.length}
          <div class="auth-divider"><span>or</span></div>
        {/if}
        {#if passwordLoginEnabled}
          <div class="form-group">
            <label class="form-label">{$_('native_setup.username')}</label>
            <input
              class="input"
              type="text"
              placeholder={$_('native_setup.username_ph')}
              bind:value={username}
              autocapitalize="off"
              autocorrect="off"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('native_setup.password')}</label>
            <div style="position:relative">
              {#if showPw}
                <input class="input" type="text" placeholder={$_('native_setup.password_ph')} bind:value={password} style="padding-right:40px" />
              {:else}
                <input class="input" type="password" placeholder={$_('native_setup.password_ph')} bind:value={password} style="padding-right:40px" />
              {/if}
              <button type="button" class="pw-toggle" on:click={() => showPw = !showPw}>
                <span class="material-symbols-rounded" style="font-size:20px">{showPw ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        {/if}

        {#if !providers.length && !passwordLoginEnabled}
          <div class="no-auth-warning">
            <span class="material-symbols-rounded">warning</span>
            <div>
              This server has no sign-in methods configured. Ask your admin
              to enable password login or configure an OIDC provider.
            </div>
          </div>
        {/if}

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToServerUrl} disabled={connecting}>{$_('native_setup.back')}</button>
          {#if passwordLoginEnabled}
            <button class="btn btn-primary" on:click={loginWithPassword} disabled={connecting}>
              {connecting ? 'Signing in…' : 'Sign In'}
            </button>
          {/if}
        </div>
      </div>

    {:else if step === 'migrate-choice' && localCounts}
      <!-- Three-option migration dialog. Mirrors NutriTrace's pattern but
           shows per-table counts up front so the user knows what's about
           to move. Only reached via password login (see header comment). -->
      <div class="migrate-summary">
        <div class="migrate-title">{$_('native_setup.migrate_title')}</div>
        <p class="migrate-sub">Choose how to combine it with your server account.</p>
        <ul class="count-list">
          {#if localCounts.workouts}<li>{localCounts.workouts} workout{localCounts.workouts === 1 ? '' : 's'}</li>{/if}
          {#if localCounts.bodyStats}<li>{localCounts.bodyStats} body-stats {localCounts.bodyStats === 1 ? 'entry' : 'entries'}</li>{/if}
          {#if localCounts.programs}<li>{localCounts.programs} program{localCounts.programs === 1 ? '' : 's'}{localCounts.templates ? ` (${localCounts.templates} template${localCounts.templates === 1 ? '' : 's'})` : ''}</li>{/if}
          {#if localCounts.customExercises}<li>{localCounts.customExercises} custom exercise{localCounts.customExercises === 1 ? '' : 's'}</li>{/if}
          {#if localCounts.settings}<li>{localCounts.settings} setting{localCounts.settings === 1 ? '' : 's'}</li>{/if}
        </ul>
      </div>

      <div class="setup-cards">
        <button class="setup-card" on:click={() => migrateUpload(false)} disabled={migrateBusy}>
          <span class="material-symbols-rounded setup-card-icon">cloud_upload</span>
          <div class="setup-card-title">{$_('native_setup.upload_to_server')}</div>
          <p class="setup-card-desc">Push everything on this device to your server. Re-uploaded dates overwrite cleanly.</p>
        </button>

        <button class="setup-card" on:click={migrateDownload} disabled={migrateBusy}>
          <span class="material-symbols-rounded setup-card-icon">cloud_download</span>
          <div class="setup-card-title">{$_('native_setup.replace_with_server')}</div>
          <p class="setup-card-desc">Discard local data and load everything fresh from the server. <strong>Local entries are deleted.</strong></p>
        </button>

        <button class="setup-card" on:click={() => migrateUpload(true)} disabled={migrateBusy}>
          <span class="material-symbols-rounded setup-card-icon">merge</span>
          <div class="setup-card-title">{$_('native_setup.merge_both')}</div>
          <p class="setup-card-desc">Upload local data, then pull the merged result back. Workouts dedupe by date; programs and exercises may duplicate.</p>
        </button>

        <button class="btn btn-ghost migrate-skip" on:click={migrateSkip} disabled={migrateBusy}>
          Skip — keep server only
        </button>
      </div>

    {:else if step === 'migrating'}
      <div class="migrate-progress">
        <span class="material-symbols-rounded migrate-spinner">sync</span>
        <div class="migrate-title">Uploading…</div>
        <p class="migrate-sub">{STAGE_LABELS[migrateStage] || ''}</p>
        {#if migrateProgress.total > 0}
          <div class="progress-bar">
            <div class="progress-fill" style="width: {(migrateProgress.current / migrateProgress.total) * 100}%"></div>
          </div>
          <div class="progress-text">{migrateProgress.current} / {migrateProgress.total}</div>
        {/if}
      </div>

    {:else if step === 'migration-done' && migrateSummary}
      <div class="migrate-summary">
        <span class="material-symbols-rounded migrate-done-icon">check_circle</span>
        <div class="migrate-title">{$_('native_setup.migration_complete')}</div>
        <ul class="count-list">
          {#if migrateSummary.success.workouts}<li>{migrateSummary.success.workouts} workout{migrateSummary.success.workouts === 1 ? '' : 's'} uploaded</li>{/if}
          {#if migrateSummary.success.bodyStats}<li>{migrateSummary.success.bodyStats} body-stats {migrateSummary.success.bodyStats === 1 ? 'entry' : 'entries'} uploaded</li>{/if}
          {#if migrateSummary.success.programs}<li>{migrateSummary.success.programs} program{migrateSummary.success.programs === 1 ? '' : 's'} uploaded</li>{/if}
          {#if migrateSummary.success.templates}<li>{migrateSummary.success.templates} template{migrateSummary.success.templates === 1 ? '' : 's'} uploaded</li>{/if}
          {#if migrateSummary.success.customExercises}<li>{migrateSummary.success.customExercises} custom exercise{migrateSummary.success.customExercises === 1 ? '' : 's'} uploaded</li>{/if}
          {#if migrateSummary.success.settings}<li>{migrateSummary.success.settings} setting{migrateSummary.success.settings === 1 ? '' : 's'} uploaded</li>{/if}
        </ul>
        {#if migrateSummary.errors.length > 0}
          <div class="migrate-errors">
            <strong>{migrateSummary.errors.length} error{migrateSummary.errors.length === 1 ? '' : 's'}:</strong>
            <ul>
              {#each migrateSummary.errors.slice(0, 5) as err}
                <li>{err.stage}: {err.name} — {err.message}</li>
              {/each}
              {#if migrateSummary.errors.length > 5}<li>…and {migrateSummary.errors.length - 5} more</li>{/if}
            </ul>
          </div>
        {/if}
        <button class="btn btn-primary" on:click={finishMigration}>{$_('native_setup.continue')}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 24px;
    background: var(--bg, #0F1115);
  }
  .setup-inner {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .setup-brand {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .setup-logo {
    width: 80px;
    height: 80px;
    border-radius: 20px;
  }
  .setup-title {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .setup-subtitle {
    font-size: 14px;
    color: var(--text-3);
    margin: 0;
  }
  .setup-cards {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    cursor: pointer;
    text-align: center;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .setup-card:hover {
    background: var(--surface-2);
    border-color: var(--accent, #3b82f6);
  }
  .setup-card:active { transform: scale(0.98); }
  .setup-card-icon { font-size: 40px; color: var(--accent, #3b82f6); }
  .setup-card-title { font-size: 18px; font-weight: 600; color: var(--text-1); }
  .setup-card-desc { font-size: 13px; color: var(--text-3); margin: 0; line-height: 1.5; }
  .setup-form { display: flex; flex-direction: column; gap: 16px; }
  .form-hint {
    font-size: 12px; color: var(--text-3);
    margin: 6px 0 0; line-height: 1.5;
  }
  .setup-form-actions { display: flex; gap: 12px; margin-top: 8px; }
  .setup-form-actions .btn { flex: 1; }
  .pw-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
  }
  .server-line {
    display: flex; align-items: center; gap: 8px;
    margin: 0; padding: 10px 12px;
    background: var(--surface-2); border-radius: 8px;
    font-size: 13px; color: var(--text-2);
  }
  .server-icon { font-size: 18px; color: var(--accent, #3b82f6); }
  .server-url {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
  .oidc-list { display: flex; flex-direction: column; gap: 8px; }
  .oidc-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; }
  .oidc-logo { width: 20px; height: 20px; object-fit: contain; }
  .auth-divider {
    display: flex; align-items: center; gap: 12px;
    color: var(--text-3); font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .auth-divider::before, .auth-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }
  .no-auth-warning {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px;
    background: color-mix(in srgb, #f59e0b 8%, transparent);
    border-left: 3px solid #f59e0b; border-radius: 4px;
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .no-auth-warning .material-symbols-rounded {
    font-size: 20px; color: #f59e0b; flex-shrink: 0;
  }
  .migrate-summary {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    text-align: center;
  }
  .migrate-title { font-size: 18px; font-weight: 600; color: var(--text-1); }
  .migrate-sub { font-size: 13px; color: var(--text-3); margin: 0; }
  .count-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 14px;
    color: var(--text-2);
    line-height: 1.6;
  }
  .migrate-skip { margin-top: 8px; }
  .migrate-progress {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    padding: 32px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
  }
  .migrate-spinner {
    font-size: 40px;
    color: var(--accent, #3b82f6);
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress-bar {
    width: 100%;
    height: 6px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 8px;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent, #3b82f6);
    transition: width 0.2s;
  }
  .progress-text { font-size: 12px; color: var(--text-3); }
  .migrate-done-icon { font-size: 40px; color: #22c55e; }
  .migrate-errors {
    background: color-mix(in srgb, #ef4444 8%, transparent);
    border-left: 3px solid #ef4444;
    padding: 10px 12px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-2);
    align-self: stretch;
    text-align: left;
  }
  .migrate-errors ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
</style>
