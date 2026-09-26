<script>
  /**
   * SettingsFederation.svelte — NutriTrace federation for LiftTrace.
   *
   * Mirrors CookTrace's federation flow: user pastes their NutriTrace URL
   * + a personal access token (created in NT under User Management → API
   * Tokens with the write:workouts scope), Save runs a connection test
   * via this server's proxy at /api/nt/test (so the token doesn't ride
   * in the browser), and on success the federation toggle auto-flips.
   * From then on Diary.finishWorkout() pushes the completed workout's
   * estimated calories burned to NT.
  */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import {
    ntInstanceUrl, ntInstanceToken, ntFederationEnabled, ntConnectionVerified, ntConnectionIdentity,
    ntBodySyncEnabled, ntBodySource, ntBodyLastSyncAt, caloriesBurnedEnabled,
  } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { syncNtBodyMeasurements } from '../../lib/nt-body-sync.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let testing = false;
  let showToken = false;
  let urlDraft   = $ntInstanceUrl  || '';
  let tokenDraft = $ntInstanceToken || '';
  let saved      = false;
  let testStatus = '';   // '' | 'ok' | 'fail' | 'testing'
  let lastConnectedUser = '';
  let lastError = '';
  let capabilities = null;
  let bodyStatus = '';
  let bodyError = '';
  let bodySources = [];
  let bodySyncing = false;

  // Derive the visible Connected/Failed pill state from a combination of the
  // local in-flight test and the persisted verified flag, so the pill
  // survives navigating away from Settings and coming back.
  $: visibleStatus = testing
    ? 'testing'
    : (testStatus === 'fail' ? 'fail'
      : (($ntConnectionVerified && $ntFederationEnabled) || testStatus === 'ok') ? 'ok'
      : '');

  $: canTest = !!urlDraft.trim() && !!tokenDraft.trim();
  $: bodyReadAvailable = !!capabilities?.bodyMeasurementsRead;
  $: bodySourceOptions = [...new Set([...bodySources, $ntBodySource].filter(Boolean))];

  function _invalidate() {
    testStatus = '';
    lastError = '';
    capabilities = null;
    bodyStatus = '';
    bodyError = '';
    // Any field edit invalidates the previous verification — the URL or
    // token might now be different from what was tested.
    if ($ntConnectionVerified) ntConnectionVerified.set(false);
    if ($ntConnectionIdentity) ntConnectionIdentity.set(null);
    if ($ntFederationEnabled) ntFederationEnabled.set(false);
  }

  async function save() {
    ntInstanceUrl.set(urlDraft.replace(/\/$/, ''));
    ntInstanceToken.set(tokenDraft);
    saved = true;
    setTimeout(() => saved = false, 2000);
    await test({ silentOk: false });
  }

  async function test({ silentOk = false, silentFail = false, preserveExistingOnFail = false } = {}) {
    if (!canTest) {
      showError($_('settings_federation.url_token_required'));
      return;
    }
    testing = true;
    testStatus = '';
    lastError = '';
    try {
      const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('lt:csrf') : null;
      const res = await fetch('/api/nt/test', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ url: urlDraft, token: tokenDraft }),
      });
      const body = await res.json();
      if (body.ok) {
        testStatus = 'ok';
        lastConnectedUser = body.user?.username || body.user?.full_name || 'NutriTrace';
        capabilities = body.capabilities || {
          workoutWrite: (body.scopes || []).includes('write:workouts'),
          bodyMeasurementsRead: (body.scopes || []).includes('read:body-measurements'),
        };
        // Svelte reactive declarations run after this function yields. Use
        // the response-derived value here so a missing optional scope is
        // handled during this test, not only after the next render.
        const bodyRead = !!capabilities.bodyMeasurementsRead;
        bodyStatus = bodyRead ? '' : 'scope-missing';
        bodyError = bodyRead ? '' : $_('settings_federation.body_sync_scope_missing');
        if (!bodyRead) ntBodySyncEnabled.set(false);
        ntFederationEnabled.set(true);
        ntConnectionVerified.set(true);
        ntConnectionIdentity.set(body.connectionIdentity);
        if (!silentOk) showSuccess(`Connected to NutriTrace as ${lastConnectedUser}`);
      } else {
        testStatus = preserveExistingOnFail ? '' : 'fail';
        lastError = preserveExistingOnFail ? '' : (body.error || 'Connection failed');
        capabilities = null;
        bodyStatus = '';
        bodyError = '';
        if (!preserveExistingOnFail) {
          ntFederationEnabled.set(false);
          ntConnectionVerified.set(false);
        }
        if (!preserveExistingOnFail) ntConnectionIdentity.set(null);
        if (!silentFail) showError(lastError);
      }
    } catch (e) {
      testStatus = preserveExistingOnFail ? '' : 'fail';
      lastError = preserveExistingOnFail ? '' : (e.message || 'Connection failed');
      capabilities = null;
      bodyStatus = '';
      bodyError = '';
      if (!preserveExistingOnFail) {
        ntFederationEnabled.set(false);
        ntConnectionVerified.set(false);
      }
      if (!preserveExistingOnFail) ntConnectionIdentity.set(null);
      if (!silentFail) showError(lastError);
    } finally { testing = false; }
  }

  async function syncBodyNow() {
    if (!bodyReadAvailable || bodySyncing) return;
    bodySyncing = true;
    bodyError = '';
    try {
      const result = await syncNtBodyMeasurements({ manual: true });
      bodyStatus = result.status;
      bodySources = result.sources || [];
      if (result.status === 'error') bodyError = result.error;
      else if (result.status === 'connection-verification-required') bodyError = $_('settings_federation.body_sync_connection_verification_required');
      else if (result.status === 'connection-change-blocked') bodyError = $_('settings_federation.body_sync_connection_change_blocked');
      else if (result.status === 'source-selection-required') bodyError = $_('settings_federation.body_sync_source_required');
      else if (result.status === 'source-change-blocked') bodyError = $_('settings_federation.body_sync_source_change_blocked', { values: { source: result.syncedSource || '' } });
      else if (result.status === 'selected-empty') bodyError = $_('settings_federation.body_sync_selected_empty');
      else if (result.status === 'no-data') bodyError = $_('settings_federation.body_sync_no_data');
      else if (result.status === 'ok') showSuccess($_('settings_federation.body_sync_complete'));
    } catch (e) {
      bodyStatus = 'error';
      bodyError = e.message || $_('settings_federation.body_sync_failed');
    } finally { bodySyncing = false; }
  }

  function onBodySyncToggle(event) {
    if (event.detail) syncBodyNow();
  }

  function formatLastSync(value) {
    if (!value) return '';
    try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
  }

  // Capabilities are returned by the connection check rather than persisted
  // as a second source of truth. Refresh them when this settings section is
  // remounted so a previously verified workout connection still exposes the
  // body-sync scope state after navigating away and back.
  onMount(() => {
    if ($ntConnectionVerified && $ntFederationEnabled && canTest) {
      test({ silentOk: true, silentFail: true, preserveExistingOnFail: true });
    }
  });
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">restaurant</span></span>
    <span class="section-name">{$_('settings.federation.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <ConnectionStatus
          status={visibleStatus}
          connectedAs={lastConnectedUser || $ntInstanceUrl.replace(/^https?:\/\//, '')}
          error={lastError}
          onRetest={() => test()}
          retestDisabled={testing || !canTest}
        />

        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_federation.enable_federation')}</span>
            <span class="setting-hint">
              {$_('settings_federation.enable_federation_hint')}
            </span>
          </div>
          <Toggle bind:checked={$ntFederationEnabled} />
        </div>

        <div class="body-sync-block">
          <div class="body-sync-heading">{$_('settings_federation.body_sync_title')}</div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_federation.body_sync_enable')}</span>
              <span class="setting-hint">
                {$_('settings_federation.body_sync_enable_hint')} {$_('settings_federation.body_sync_current_weight_hint')}
              </span>
            </div>
            <Toggle bind:checked={$ntBodySyncEnabled} on:change={onBodySyncToggle} disabled={!bodyReadAvailable || !$ntFederationEnabled} />
          </div>

          {#if $ntConnectionVerified && capabilities && !bodyReadAvailable}
            <p class="body-sync-warning">{$_('settings_federation.body_sync_scope_missing')}</p>
          {/if}

          {#if bodySourceOptions.length > 0 || $ntBodySource}
            <div class="setting-row" style="flex-wrap:wrap;gap:8px">
              <div class="setting-label-group" style="width:100%">
                <span class="setting-label">{$_('settings_federation.body_sync_source')}</span>
                <span class="setting-hint">{$_('settings_federation.body_sync_source_hint')}</span>
              </div>
              <select class="form-input-sm" style="width:100%" bind:value={$ntBodySource} disabled={bodySyncing}>
                <option value="">{$_('settings_federation.body_sync_source_auto')}</option>
                {#each bodySourceOptions as source}
                  <option value={source}>{source}</option>
                {/each}
              </select>
            </div>
          {/if}

          <div class="body-sync-actions">
            <button class="btn btn-secondary" on:click={syncBodyNow} disabled={bodySyncing || !bodyReadAvailable || !$ntFederationEnabled}>
              {bodySyncing ? $_('settings_federation.body_sync_syncing') : $_('settings_federation.body_sync_now')}
            </button>
            {#if $ntBodyLastSyncAt}
              <span class="setting-hint">{$_('settings_federation.body_sync_last_sync', { values: { when: formatLastSync($ntBodyLastSyncAt) } })}</span>
            {/if}
          </div>
          {#if bodyError}
            <p class="body-sync-warning">{bodyError}</p>
          {:else if bodyStatus === 'ok'}
            <p class="body-sync-ok">{$_('settings_federation.body_sync_ready')}</p>
          {/if}
        </div>

        {#if !$caloriesBurnedEnabled}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-hint" style="color: var(--warning, #f59e0b)">
                Calorie estimation is off in Settings → Workout. Federation needs it on to have anything to send.
              </span>
            </div>
          </div>
        {/if}

        <div class="setting-row" style="flex-wrap:wrap;gap:8px">
          <div class="setting-label-group" style="width:100%">
            <span class="setting-label">{$_('settings_federation.instance_url')}</span>
            <span class="setting-hint">{$_('settings_federation.instance_url_hint')} <code>https://nutritrace.example.com</code></span>
          </div>
          <input class="form-input-sm" style="flex:1;min-width:0;width:100%" type="url"
            bind:value={urlDraft} placeholder="https://nutritrace.example.com"
            on:input={_invalidate} />
        </div>

        <div class="setting-row" style="flex-wrap:wrap;gap:8px">
          <div class="setting-label-group" style="width:100%">
            <span class="setting-label">{$_('settings_federation.access_token')}</span>
            <span class="setting-hint">
              {$_('settings_federation.access_token_hint_prefix')} <code>write:workouts</code> {$_('settings_federation.access_token_hint_suffix')}
            </span>
          </div>
          <div class="key-row">
            {#if showToken}
              <input class="form-input-sm" style="flex:1;min-width:0;font-family:monospace" type="text"
                bind:value={tokenDraft} placeholder="nt_pat_…" on:input={_invalidate} />
            {:else}
              <input class="form-input-sm" style="flex:1;min-width:0;font-family:monospace" type="password"
                bind:value={tokenDraft} placeholder="nt_pat_…" on:input={_invalidate} />
            {/if}
            <button class="btn-icon-toggle" on:click={() => showToken = !showToken} title={showToken ? $_('settings_trace.labels.hide') : $_('settings_trace.labels.show')}>
              <span class="material-symbols-rounded">{showToken ? 'visibility_off' : 'visibility'}</span>
            </button>
            <button class="btn btn-primary save-btn" on:click={save}
              disabled={testing || !urlDraft.trim() || !tokenDraft.trim()}>
              {saved ? 'Saved' : (testing ? 'Testing…' : $_('common.save'))}
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_federation.wearable_priority')}</span>
            <span class="setting-hint">
              {$_('settings_federation.wearable_priority_hint')}
            </span>
          </div>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .key-row {
    display: flex; gap: 6px; align-items: stretch;
    flex: 1; min-width: 0; width: 100%;
  }
  .btn-icon-toggle {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3); flex-shrink: 0;
  }
  .btn-icon-toggle:hover { color: var(--text-1); }
  .save-btn { height: 36px; font-size: 13px; white-space: nowrap; padding: 0 14px; flex-shrink: 0; }
  .body-sync-block { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 14px; }
  .body-sync-heading { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .body-sync-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0 0; }
  .body-sync-warning { color: var(--warning, #f59e0b); font-size: 12px; line-height: 1.45; margin: 6px 0; }
  .body-sync-ok { color: var(--success, #22c55e); font-size: 12px; line-height: 1.45; margin: 6px 0; }
  .body-sync-heading,
  .body-sync-actions,
  .body-sync-warning,
  .body-sync-ok { padding-inline: 16px; }
  code {
    font-family: 'SFMono-Regular', 'Menlo', monospace;
    font-size: 11px;
    padding: 1px 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
</style>
