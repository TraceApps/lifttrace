<script>
  import { setNativeMode, setServerUrl, setAuthToken, resolveAssetUrl } from '../lib/platform.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { countLocalData, uploadLocalToServer } from '../lib/migrate.js';
  import { destroyLocalDb } from '../lib/db-native.js';

  // 'choose'         — Use Locally / Connect to Server picker
  // 'server-form'    — URL + credentials form
  // 'migrate-choice' — three-option dialog when local data exists
  // 'migrating'      — upload in flight, with progress
  // 'migration-done' — final summary screen with continue button
  let step = 'choose';
  let serverUrl = '';
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
    step = 'server-form';
  }

  async function connectToServer() {
    if (!serverUrl.trim()) { showError('Enter your server URL'); return; }
    if (!username.trim() || !password.trim()) { showError('Enter your credentials'); return; }

    const url = serverUrl.trim().replace(/\/$/, '');
    connecting = true;

    try {
      const { CapacitorHttp } = await import('@capacitor/core');

      // 1. Reachability check
      const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
      if (healthRes.status < 200 || healthRes.status >= 300) {
        throw new Error(`Server returned ${healthRes.status}`);
      }

      // 2. Login → get JWT for native (cookies don't persist across WebView reloads)
      const loginRes = await CapacitorHttp.post({
        url: `${url}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { username: username.trim(), password },
      });
      const data = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
      if (loginRes.status < 200 || loginRes.status >= 300) {
        throw new Error(data?.error || 'Login failed');
      }

      // 3. Flip native mode → server BEFORE checking for local data, so the
      // upload pass (if the user picks it) routes through apiFetch correctly.
      // Local SQLite stays intact; we just stop reading from it for new
      // operations.
      setServerUrl(url);
      setAuthToken(data.token);
      setNativeMode('server');

      // 4. If the user has been running standalone, count what's there. If
      // anything exists, show the three-option migration dialog. Otherwise
      // we're done — reload straight into the connected app.
      try {
        localCounts = await countLocalData();
      } catch {
        localCounts = null;
      }
      if (localCounts && localCounts.total > 0) {
        showSuccess('Connected to server');
        step = 'migrate-choice';
      } else {
        showSuccess('Connected to server');
        window.location.reload();
      }
    } catch (e) {
      showError(e.message || 'Could not connect to server');
    } finally {
      connecting = false;
    }
  }

  // ── Migration handlers ────────────────────────────────────────────────────
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
      // After upload finishes, optionally pull the server snapshot to refresh
      // the local cache so the UI reflects the merged state on next render.
      if (alsoPullAfter) {
        try {
          const { runSync } = await import('../lib/sync.js');
          await runSync();
        } catch {}
      }
      step = 'migration-done';
    } catch (e) {
      showError(e.message || 'Migration failed');
      step = 'migrate-choice';
    } finally {
      migrateBusy = false;
    }
  }

  async function migrateDownload() {
    // "Replace local with server" — wipe the standalone SQLite, then the
    // existing pullSnapshot() on next launch repopulates from the server.
    migrateBusy = true;
    try {
      await destroyLocalDb();
      showSuccess('Local data cleared');
    } catch (e) {
      showError(e.message || 'Could not clear local data');
    } finally {
      migrateBusy = false;
    }
    window.location.reload();
  }

  function migrateSkip() {
    // User chose to not upload local data. It stays in SQLite, untouched,
    // but is unreachable through the UI from now on (server is source of
    // truth). They can still wipe it later via Settings → Clear Local.
    window.location.reload();
  }

  function finishMigration() {
    window.location.reload();
  }

  function backToChoose() {
    step = 'choose';
    serverUrl = '';
    username = '';
    password = '';
  }

  // Pretty-print stage names for the in-flight progress UI.
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
      <img src={resolveAssetUrl('/icons/icon-192.png')} alt="LiftTrace" class="setup-logo" />
      <h1 class="setup-title">LiftTrace</h1>
      <p class="setup-subtitle">Track Every Rep</p>
    </div>

    {#if step === 'choose'}
      <div class="setup-cards">
        <button class="setup-card" on:click={chooseLocal}>
          <span class="material-symbols-rounded setup-card-icon">smartphone</span>
          <div class="setup-card-title">Use Locally</div>
          <p class="setup-card-desc">
            All data stays on this device. Works fully offline, no server needed.
            You can connect to a server later in Settings.
          </p>
        </button>

        <button class="setup-card" on:click={chooseServer}>
          <span class="material-symbols-rounded setup-card-icon">cloud_sync</span>
          <div class="setup-card-title">Connect to Server</div>
          <p class="setup-card-desc">
            Sync with your LiftTrace server. Your workouts are available on
            every device and the web app.
          </p>
        </button>
      </div>

    {:else if step === 'server-form'}
      <div class="setup-form">
        <div class="form-group">
          <label class="form-label">Server URL</label>
          <input
            class="input"
            type="url"
            placeholder="https://lifttrace.example.com"
            bind:value={serverUrl}
            autocapitalize="off"
            autocorrect="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input
            class="input"
            type="text"
            placeholder="Your username"
            bind:value={username}
            autocapitalize="off"
            autocorrect="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <div style="position:relative">
            {#if showPw}
              <input class="input" type="text" placeholder="Your password" bind:value={password} style="padding-right:40px" />
            {:else}
              <input class="input" type="password" placeholder="Your password" bind:value={password} style="padding-right:40px" />
            {/if}
            <button type="button" class="pw-toggle" on:click={() => showPw = !showPw}>
              <span class="material-symbols-rounded" style="font-size:20px">{showPw ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </div>

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToChoose} disabled={connecting}>Back</button>
          <button class="btn btn-primary" on:click={connectToServer} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>

    {:else if step === 'migrate-choice' && localCounts}
      <!-- Three-option migration dialog. Mirrors NutriTrace's pattern but
           shows per-table counts up front so the user knows what's about
           to move. -->
      <div class="migrate-summary">
        <div class="migrate-title">You have local data on this device</div>
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
          <div class="setup-card-title">Upload to server</div>
          <p class="setup-card-desc">Push everything on this device to your server. Re-uploaded dates overwrite cleanly.</p>
        </button>

        <button class="setup-card" on:click={migrateDownload} disabled={migrateBusy}>
          <span class="material-symbols-rounded setup-card-icon">cloud_download</span>
          <div class="setup-card-title">Replace with server</div>
          <p class="setup-card-desc">Discard local data and load everything fresh from the server. <strong>Local entries are deleted.</strong></p>
        </button>

        <button class="setup-card" on:click={() => migrateUpload(true)} disabled={migrateBusy}>
          <span class="material-symbols-rounded setup-card-icon">merge</span>
          <div class="setup-card-title">Merge both</div>
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
        <div class="migrate-title">Migration complete</div>
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
        <button class="btn btn-primary" on:click={finishMigration}>Continue</button>
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
    color: var(--text-1);
  }
  .setup-card:hover {
    background: var(--surface-2);
    border-color: var(--accent, #FF7433);
  }
  .setup-card:active {
    transform: scale(0.98);
  }
  .setup-card-icon {
    font-size: 40px;
    color: var(--accent, #FF7433);
  }
  .setup-card-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-1);
  }
  .setup-card-desc {
    font-size: 13px;
    color: var(--text-3);
    margin: 0;
    line-height: 1.5;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-form-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .setup-form-actions .btn {
    flex: 1;
  }
  .pw-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
  }
  .migrate-summary {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    text-align: center;
  }
  .migrate-title {
    font-size: 18px; font-weight: 600; color: var(--text-1);
  }
  .migrate-sub {
    font-size: 13px; color: var(--text-3); margin: 0; line-height: 1.5;
  }
  .count-list {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 6px;
    font-size: 14px; color: var(--text-2);
  }
  .count-list li {
    padding: 6px 12px;
    background: var(--surface-1);
    border-radius: var(--radius-md, 8px);
  }
  .migrate-skip {
    margin-top: 8px; font-size: 13px;
  }
  .migrate-progress {
    display: flex; flex-direction: column; align-items: center; gap: 16px;
    padding: 32px 16px; text-align: center;
  }
  .migrate-spinner {
    font-size: 48px; color: var(--accent, #FF7433);
    animation: spin 1.5s linear infinite;
  }
  .migrate-done-icon {
    font-size: 48px; color: #34C759;
  }
  .progress-bar {
    width: 100%; max-width: 280px; height: 6px;
    background: var(--surface-2); border-radius: 3px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: var(--accent, #FF7433);
    transition: width 0.2s ease;
  }
  .progress-text {
    font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums;
  }
  .migrate-errors {
    width: 100%; padding: 12px; background: var(--surface-1);
    border-radius: 8px; font-size: 12px; color: var(--text-3);
    text-align: left;
  }
  .migrate-errors ul {
    margin: 4px 0 0; padding-left: 16px;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
</style>
