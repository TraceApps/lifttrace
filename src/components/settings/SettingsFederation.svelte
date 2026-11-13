<script>
  import { SECRET_SET, selectSecret } from '../../lib/secret-set.js';
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
    ntConnectionVersion, ntBodySyncEnabled, ntBodySource, ntBodyLastSyncAt, caloriesBurnedEnabled,
    cancelScheduledSave,
  } from '../../stores/settings.js';
  import { LtApi } from '../../lib/api.js';
  import {
    persistFederationConnectionTransition,
    persistServerSetting,
    publishToNtOwner,
  } from '../../lib/nt-federation-persistence.js';
  import { serverConnectionState } from '../../lib/nt-connection-state.js';
  import { runNtExclusive, captureNtAccount, ntAccountChanged, ntAccountChangedError } from '../../lib/nt-sync-coordination.js';
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
  let federationSaving = false;
  let bodyStateSaving = false;
  // A connection saved before identities existed: its URL, token and workout
  // push are still real, but body measurements need a fresh verification.
  let needsVerification = false;

  // Derive the visible Connected/Failed pill state from a combination of the
  // local in-flight test and the persisted verified flag, so the pill
  // survives navigating away from Settings and coming back.
  $: draftMatchesSaved = urlDraft.trim().replace(/\/+$/, '') === ($ntInstanceUrl || '').replace(/\/+$/, '')
    && tokenDraft === ($ntInstanceToken || '');
  $: visibleStatus = testing
    ? 'testing'
    : (testStatus === 'fail' ? 'fail'
      : (($ntConnectionVerified && $ntFederationEnabled && draftMatchesSaved) || testStatus === 'ok') ? 'ok'
      : '');

  $: canTest = !!urlDraft.trim() && !!tokenDraft.trim();
  $: bodyReadAvailable = !!capabilities?.bodyCompositionRead;
  $: bodySourceOptions = [...new Set([...bodySources, $ntBodySource].filter(Boolean))];

  const federationStores = {
    ntInstanceUrl,
    ntInstanceToken,
    ntFederationEnabled,
    ntConnectionVerified,
    ntConnectionIdentity,
    ntConnectionVersion,
    ntBodySyncEnabled,
    ntBodySource,
  };

  function federationSnapshot() {
    return {
      ntInstanceUrl: $ntInstanceUrl,
      ntInstanceToken: $ntInstanceToken,
      ntFederationEnabled: $ntFederationEnabled,
      ntConnectionVerified: $ntConnectionVerified,
      ntConnectionIdentity: $ntConnectionIdentity,
      ntConnectionVersion: $ntConnectionVersion,
      ntBodySyncEnabled: $ntBodySyncEnabled,
      ntBodySource: $ntBodySource,
    };
  }

  function setFederationLocally(values) {
    for (const [key, value] of Object.entries(values)) {
      federationStores[key].set(value);
      // The awaited federation PUT below owns persistence for these values.
      cancelScheduledSave(key);
    }
  }

  function saveSettingNow(key, value) {
    return persistServerSetting(key, value, {
      saveSetting: LtApi.saveSetting,
      cancelScheduledSave,
    });
  }

  // Every publication names the account that started the request: the answer
  // can arrive after a sign-in, and A's connection must never be written into
  // B's settings or shown under B's name.
  function publishConnection(result, account) {
    return publishToNtOwner(account, () => {
      setFederationLocally(result.values);
      needsVerification = false;
      capabilities = result.capabilities;
      if (result.user) {
        lastConnectedUser = result.user.username || result.user.full_name || 'NutriTrace';
      }
      const bodyRead = !!result.capabilities?.bodyCompositionRead;
      bodyStatus = bodyRead ? '' : 'scope-missing';
      bodyError = bodyRead ? '' : $_('settings_federation.body_sync_scope_missing');
    });
  }

  /** Publish the connection the server reports (GET, or a 409 answer). */
  function publishServerConnection(connection, account, { capabilities: caps, bodySyncEnabled } = {}) {
    if (!connection) return false;
    const state = serverConnectionState(connection);
    return publishToNtOwner(account, () => {
      setFederationLocally({
        ...state.values,
        ...(bodySyncEnabled === undefined ? {} : { ntBodySyncEnabled: !!bodySyncEnabled }),
      });
      urlDraft = connection.url;
      tokenDraft = SECRET_SET;
      needsVerification = state.needsVerification;
      if (caps) {
        capabilities = caps;
        const bodyRead = !!caps.bodyCompositionRead;
        bodyStatus = bodyRead ? '' : 'scope-missing';
        bodyError = bodyRead ? '' : $_('settings_federation.body_sync_scope_missing');
        if (!bodyRead && $ntBodySyncEnabled) ntBodySyncEnabled.set(false);
      }
    });
  }

  /**
   * Ask the server what it saved after a Save whose outcome is unknown (a
   * lost answer, or a 409 from another tab). The token is never restored: the
   * server does not send it, so the page keeps the placeholder.
   */
  async function reconcileConnection(account) {
    let state;
    try { state = await LtApi.getNtFederationConnection(); } catch { return null; }
    if (ntAccountChanged(account)) return null;
    if (state?.connection) {
      publishServerConnection(state.connection, account, {
        capabilities: state.capabilities || null,
        bodySyncEnabled: state.bodySyncEnabled,
      });
      return state;
    }
    // The server answered and has no connection: clear the saved copy rather
    // than keep a snapshot it does not have. The typed drafts stay, so a
    // retry does not need them entered again.
    publishToNtOwner(account, () => {
      setFederationLocally({
        ntInstanceUrl: '',
        ntInstanceToken: '',
        ntConnectionIdentity: null,
        ntConnectionVersion: 0,
        ntConnectionVerified: false,
        ntFederationEnabled: false,
      });
      needsVerification = false;
    });
    return state;
  }

  function savedTargetMatches(connection, candidate) {
    return !!connection && connection.url === candidate.ntInstanceUrl && !!connection.enabled && !!connection.identity;
  }

  // Refusals that wrote nothing. Anything else may have reached the server
  // before its answer was lost, so the page asks what is saved.
  const DEFINITE_CONNECTION_ERRORS = new Set([
    'token-required', 'invalid-connection', 'identity-missing', 'scope-missing', 'nt-error',
  ]);
  function isDefiniteConnectionError(error) {
    return DEFINITE_CONNECTION_ERRORS.has(error?.code);
  }

  function _invalidate() {
    testStatus = '';
    lastError = '';
    saved = false;
    capabilities = null;
    bodyStatus = '';
    bodyError = '';
    // Keep the last verified server connection intact while the user edits a
    // candidate: nothing is saved, on this device or the server, until Save
    // succeeds.
  }

  async function save() {
    if (testing || federationSaving || bodyStateSaving) return;
    saved = false;
    if (await test()) {
      saved = true;
      setTimeout(() => saved = false, 2000);
    }
  }

  async function test() {
    if (!canTest) {
      showError($_('settings_federation.url_token_required'));
      return false;
    }
    const previous = federationSnapshot();
    // Whose settings these are: a sign-out during the save must not let this
    // account's values be published into the next one's local copy.
    const account = captureNtAccount();
    const publish = (values) => {
      if (!ntAccountChanged(account)) setFederationLocally(values);
    };
    const candidate = {
      ...previous,
      ntInstanceUrl: urlDraft.trim().replace(/\/+$/, ''),
      ntInstanceToken: tokenDraft,
    };
    testing = true;
    testStatus = '';
    lastError = '';

    // One server transition verifies the address and token and saves URL,
    // token, identity and enabled together. Nothing is written locally
    // before the server confirms, so the pill can never say Connected for a
    // connection that only reached an offline queue.
    let result;
    try {
      result = await runNtExclusive(async () => {
        // The queue may hand this over after a sign-in. The account captured
        // before the request is the only one this transition may write for.
        if (ntAccountChanged(account)) throw ntAccountChangedError();
        // A body import and a connection change may not overlap: a running
        // import finishes against the connection it read.
        return persistFederationConnectionTransition({
          previous,
          next: { ...candidate, ntFederationEnabled: true },
          saveConnection: LtApi.saveNtFederationConnection,
          account,
        });
      });
    } catch (error) {
      const state = isDefiniteConnectionError(error) ? null : await reconcileConnection(account);
      if (state?.connection && savedTargetMatches(state.connection, candidate)) {
        return publishToNtOwner(account, () => {
          testStatus = 'ok';
          showSuccess($_('settings_federation.toast.connected_as', {
            values: { user: lastConnectedUser || state.connection.url.replace(/^https?:\/\//, '') },
          }));
          return true;
        });
      }
      publishToNtOwner(account, () => {
        // Without a server answer the local snapshot is the best this page
        // has; with one, keep the capabilities the reconciled connection
        // reported and only add the error.
        if (!state) {
          publish(previous);
          capabilities = null;
          bodyStatus = '';
          bodyError = '';
        }
        testStatus = 'fail';
        lastError = _persistError(error);
        showError(lastError);
      });
      return false;
    } finally { testing = false; }

    // The answer belongs to the account that asked for it. After a sign-in
    // while the request was in flight, nothing here may touch the new
    // account's stores, drafts, name or status.
    return publishToNtOwner(account, () => {
      publish(result.values);
      // The token now lives only on the server: the page keeps the
      // placeholder it was shown, even right after typing a new one.
      if (candidate.ntInstanceToken !== SECRET_SET) {
        publish({ ntInstanceToken: SECRET_SET });
      }
      // Show what the server now has, not what was typed: the identity may be
      // the one NutriTrace reports for this address, and body sync may have
      // been switched off by a token without the read scope.
      urlDraft = $ntInstanceUrl;
      tokenDraft = $ntInstanceToken;
      publishConnection(result, account);
      testStatus = 'ok';
      showSuccess($_('settings_federation.toast.connected_as', { values: { user: lastConnectedUser } }));
      return true;
    });
  }

  // What to tell the user when the server did not save the transition. A
  // refusal that names the current connection (another tab saved first) is
  // not the same as a queue that could not reach the server.
  function _persistError(error) {
    if (error?.code === 'connection-changed') return $_('settings_federation.connection_changed');
    if (error?.code === 'unconfirmed' || error?.offline) return $_('settings_federation.offline_unconfirmed');
    if (error?.code === 'token-required') return $_('settings_federation.access_token_required_for_address');
    if (error?.code === 'scope-missing') return $_('settings_federation.write_scope_missing');
    if (error?.code === 'nt-unreachable' || error?.code === 'nt-error') {
      return error.message || $_('settings_federation.toast.connection_failed');
    }
    return error?.message || $_('settings_federation.persist_failed');
  }

  async function onFederationToggle(event) {
    if (testing || federationSaving || bodyStateSaving) return;
    const previous = $ntFederationEnabled;
    const next = !!event.detail;
    if (next === previous) return;
    const account = captureNtAccount();
    federationSaving = true;
    try {
      // Moving the switch is a connection transition too: the server writes
      // it together with the connection it belongs to, and an offline answer
      // is not shown as saved.
      const result = await runNtExclusive(async () => {
        if (ntAccountChanged(account)) throw ntAccountChangedError();
        return persistFederationConnectionTransition({
          previous: federationSnapshot(),
          next: { ...federationSnapshot(), ntFederationEnabled: next },
          saveConnection: LtApi.saveNtFederationConnection,
          account,
        });
      });
      publishConnection(result, account);
    } catch (error) {
      const state = isDefiniteConnectionError(error) ? null : await reconcileConnection(account);
      if (!state?.connection) {
        publishToNtOwner(account, () => {
          setFederationLocally({ ntFederationEnabled: previous });
          showError(_persistError(error));
        });
      }
    } finally {
      federationSaving = false;
    }
  }

  async function onBodySyncToggle(event) {
    if (testing || federationSaving || bodyStateSaving) return;
    const previous = $ntBodySyncEnabled;
    const next = !!event.detail;
    if (next === previous) return;
    const account = captureNtAccount();
    bodyStateSaving = true;
    setFederationLocally({ ntBodySyncEnabled: next });
    try {
      await saveSettingNow('ntBodySyncEnabled', next);
    } catch (error) {
      publishToNtOwner(account, () => {
        setFederationLocally({ ntBodySyncEnabled: previous });
        showError(_persistError(error));
      });
      return;
    } finally {
      bodyStateSaving = false;
    }
    // The switch is saved for the account that flipped it; a sign-in while
    // the request was in flight must not start a sync for the next one.
    if (!ntAccountChanged(account) && next) syncBodyNow();
  }

  async function onBodySourceChange(event) {
    if (testing || federationSaving || bodyStateSaving) return;
    const previous = $ntBodySource;
    const next = event.currentTarget.value;
    if (next === previous) return;
    const account = captureNtAccount();
    bodyStateSaving = true;
    setFederationLocally({ ntBodySource: next });
    try {
      await saveSettingNow('ntBodySource', next);
    } catch (error) {
      publishToNtOwner(account, () => {
        setFederationLocally({ ntBodySource: previous });
        showError(_persistError(error));
      });
    } finally {
      bodyStateSaving = false;
    }
  }

  async function syncBodyNow() {
    if (!bodyReadAvailable || bodySyncing) return;
    const account = captureNtAccount();
    bodySyncing = true;
    bodyError = '';
    try {
      const result = await syncNtBodyMeasurements({ manual: true });
      // The import returns after its own account check; this page's labels
      // still belong to the account it started under.
      publishToNtOwner(account, () => {
        bodyStatus = result.status;
        bodySources = result.sources || [];
        if (result.status === 'error') bodyError = result.error;
        else if (result.status === 'account-changed' || result.status === 'connection-change-blocked' || result.status === 'read-receipt-required') bodyError = $_('settings_federation.body_sync_connection_change_blocked');
        else if (result.status === 'connection-verification-required') bodyError = $_('settings_federation.body_sync_connection_verification_required');
        else if (result.status === 'source-selection-required') bodyError = $_('settings_federation.body_sync_source_required');
        else if (result.status === 'source-change-blocked') bodyError = $_('settings_federation.body_sync_source_change_blocked', { values: { source: result.syncedSource || '' } });
        else if (result.status === 'selected-empty') bodyError = $_('settings_federation.body_sync_selected_empty');
        else if (result.status === 'no-data') bodyError = $_('settings_federation.body_sync_no_data');
        else if (result.status === 'ok') showSuccess($_('settings_federation.body_sync_complete'));
      });
    } catch (e) {
      publishToNtOwner(account, () => {
        bodyStatus = 'error';
        bodyError = e.message || $_('settings_federation.body_sync_failed');
      });
    } finally { bodySyncing = false; }
  }

  function formatLastSync(value) {
    if (!value) return '';
    try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
  }

  // The server owns the saved connection and its scopes. Refresh both when
  // this section is remounted, so a connection saved on another device (or
  // one that another tab replaced) is shown as it is, and an identity the
  // server no longer accepts is cleared rather than trusted.
  onMount(async () => {
    if (!$ntConnectionVerified && !$ntFederationEnabled && !$ntInstanceUrl) return;
    const account = captureNtAccount();
    try {
      const state = await LtApi.getNtFederationConnection();
      if (ntAccountChanged(account)) return;
      // Nothing may land in the middle of a Save, toggle or import this page
      // already started.
      if (testing || federationSaving || bodyStateSaving) return;
      // The server is the authority on the saved connection: another tab may
      // have enabled, disabled or replaced it since this page loaded. A
      // connection saved before identities existed keeps its URL, token
      // placeholder and workout switch; only body measurements wait for a
      // new verification.
      const presence = serverConnectionState(state?.connection);
      setFederationLocally({
        ...presence.values,
        ...(state?.bodySyncEnabled === undefined ? {} : { ntBodySyncEnabled: !!state.bodySyncEnabled }),
      });
      needsVerification = presence.needsVerification;
      urlDraft = presence.values.ntInstanceUrl;
      tokenDraft = presence.values.ntInstanceToken;
      if (!presence.present) {
        capabilities = null;
        bodyStatus = '';
        bodyError = '';
        return;
      }
      capabilities = state.capabilities || null;
      const bodyRead = !!capabilities?.bodyCompositionRead;
      bodyStatus = bodyRead ? '' : 'scope-missing';
      bodyError = bodyRead ? '' : $_('settings_federation.body_sync_scope_missing');
      if (!bodyRead && $ntBodySyncEnabled) ntBodySyncEnabled.set(false);
    } catch { /* keep what the settings pull gave */ }
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
          retestDisabled={testing || federationSaving || bodyStateSaving || !canTest}
        />

        {#if needsVerification}
          <p class="body-sync-warning">{$_('settings_federation.connection_needs_verification')}</p>
        {/if}

        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_federation.enable_federation')}</span>
            <span class="setting-hint">
              {$_('settings_federation.enable_federation_hint')}
            </span>
          </div>
          <Toggle checked={$ntFederationEnabled} on:change={onFederationToggle} disabled={testing || federationSaving || !canTest} />
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
            <Toggle checked={$ntBodySyncEnabled} on:change={onBodySyncToggle} disabled={!bodyReadAvailable || !$ntFederationEnabled || testing || bodyStateSaving} />
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
              <select class="form-input-sm" style="width:100%" value={$ntBodySource} on:change={onBodySourceChange} disabled={bodySyncing || testing || bodyStateSaving}>
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
                {$_('settings_federation.calories_off')}
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
            on:input={_invalidate} disabled={testing || federationSaving} />
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
                bind:value={tokenDraft} on:focus={selectSecret} placeholder="nt_pat_…" on:input={_invalidate} disabled={testing || federationSaving} />
            {:else}
              <input class="form-input-sm" style="flex:1;min-width:0;font-family:monospace" type="password"
                bind:value={tokenDraft} on:focus={selectSecret} placeholder="nt_pat_…" on:input={_invalidate} disabled={testing || federationSaving} />
            {/if}
            <button class="btn-icon-toggle" on:click={() => showToken = !showToken} title={showToken ? $_('settings_trace.labels.hide') : $_('settings_trace.labels.show')}>
              <span class="material-symbols-rounded">{showToken ? 'visibility_off' : 'visibility'}</span>
            </button>
            <button class="btn btn-primary save-btn" on:click={save}
              disabled={testing || federationSaving || bodyStateSaving || !urlDraft.trim() || !tokenDraft.trim()}>
              {saved ? $_('settings_federation.saved') : (testing ? $_('connection_status.testing') : $_('common.save'))}
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
