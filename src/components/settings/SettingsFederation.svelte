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
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import {
    ntInstanceUrl, ntInstanceToken, ntFederationEnabled, ntConnectionVerified,
    caloriesBurnedEnabled,
  } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';

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

  // Derive the visible Connected/Failed pill state from a combination of the
  // local in-flight test and the persisted verified flag, so the pill
  // survives navigating away from Settings and coming back.
  $: visibleStatus = testing
    ? 'testing'
    : (testStatus === 'fail' ? 'fail'
      : (($ntConnectionVerified && $ntFederationEnabled) || testStatus === 'ok') ? 'ok'
      : '');

  $: canTest = !!urlDraft.trim() && !!tokenDraft.trim();

  function _invalidate() {
    testStatus = '';
    lastError = '';
    // Any field edit invalidates the previous verification — the URL or
    // token might now be different from what was tested.
    if ($ntConnectionVerified) ntConnectionVerified.set(false);
    if ($ntFederationEnabled) ntFederationEnabled.set(false);
  }

  async function save() {
    ntInstanceUrl.set(urlDraft.replace(/\/$/, ''));
    ntInstanceToken.set(tokenDraft);
    saved = true;
    setTimeout(() => saved = false, 2000);
    await test({ silentOk: false });
  }

  async function test({ silentOk = false } = {}) {
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
        ntFederationEnabled.set(true);
        ntConnectionVerified.set(true);
        if (!silentOk) showSuccess(`Connected to NutriTrace as ${lastConnectedUser}`);
      } else {
        testStatus = 'fail';
        lastError = body.error || 'Connection failed';
        ntFederationEnabled.set(false);
        ntConnectionVerified.set(false);
        showError(lastError);
      }
    } catch (e) {
      testStatus = 'fail';
      lastError = e.message || 'Connection failed';
      ntFederationEnabled.set(false);
      ntConnectionVerified.set(false);
      showError(lastError);
    } finally { testing = false; }
  }
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
  code {
    font-family: 'SFMono-Regular', 'Menlo', monospace;
    font-size: 11px;
    padding: 1px 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 3px;
  }
</style>
