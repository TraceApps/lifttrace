<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiAssistantName, aiKeyVerified, envLocks as envLocksStore } from '../../stores/settings.js';
  import { AI_MODELS, AI_DEFAULT_MODELS, callAI, callAIProxy } from '../../lib/aiChat.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  // Subscribe to the global envLocks store (populated by App.svelte at
  // startup from /api/app-config/env-locks). When env-locked, the
  // displayed enabled state comes from the operator's AI_ENABLED env var,
  // not the per-user setting (which stays empty since user_settings sync
  // doesn't run server-wide env values into per-user rows). Without this
  // short-circuit the toggle was stuck OFF + disabled even with
  // AI_ENABLED=true. Mirrors NutriTrace #36.
  $: envLocks = $envLocksStore;
  $: _displayedAiEnabled = envLocks.ai ? !!envLocks.ai_enabled : $aiEnabled;

  let aiKeyVal = $aiApiKey || '';
  let aiBaseUrlVal = $aiBaseUrl || '';
  let aiShowKey = false;
  let testing = false;
  let testError = '';

  $: providerModels = AI_MODELS[$aiProvider] || [];

  // Branded providers render a <select>. To let users pick a model outside
  // the hardcoded list (e.g. after a vendor renames), the select has a
  // 'Custom…' option that reveals a free-text input.
  //   aiModelSelectVal — the select's current option ('__custom__' or preset id)
  //   aiCustomModelVal — the free-text input's value (only meaningful in custom mode)
  //   $aiModel         — source-of-truth persisted to the store
  let aiModelSelectVal;
  let aiCustomModelVal = '';
  {
    const saved = $aiModel;
    const isPreset = AI_MODELS[$aiProvider]?.some(m => m.value === saved && m.value !== '__custom__');
    if (saved && !isPreset && $aiProvider !== 'oai-compat') {
      aiModelSelectVal = '__custom__';
      aiCustomModelVal = saved;
    } else {
      aiModelSelectVal = saved || AI_DEFAULT_MODELS[$aiProvider] || '';
    }
  }

  function _syncModelFromSelect() {
    if ($aiProvider === 'oai-compat') return;
    const next = (aiModelSelectVal === '__custom__')
      ? aiCustomModelVal.trim()
      : (aiModelSelectVal || '');
    $aiModel = next;
    _invalidate();
  }
  function _onProviderChange() {
    if ($aiProvider === 'oai-compat') return;
    const isPreset = AI_MODELS[$aiProvider]?.some(m => m.value === $aiModel && m.value !== '__custom__');
    if (!$aiModel || !isPreset) {
      aiModelSelectVal = AI_DEFAULT_MODELS[$aiProvider] || '';
      aiCustomModelVal = '';
      $aiModel = aiModelSelectVal;
    } else {
      aiModelSelectVal = $aiModel;
    }
  }

  // Any change to provider/model/key/baseUrl clears the prior verification —
  // the user must re-save (which re-tests) before the green pill returns.
  function _invalidate() {
    if ($aiKeyVerified) aiKeyVerified.set(false);
    testError = '';
  }

  // Reactive invalidation when provider changes.
  $: { $aiProvider; _invalidate(); }

  async function saveAiKey() {
    aiApiKey.set(aiKeyVal);
    await testConnection();
  }

  async function saveAiBaseUrl() {
    aiBaseUrl.set(aiBaseUrlVal.trim());
    await testConnection();
  }

  // Required fields for a meaningful test.
  $: canTest = !envLocks.ai
    && !!aiKeyVal?.trim()
    && !!$aiModel?.trim()
    && ($aiProvider !== 'oai-compat' || !!aiBaseUrlVal?.trim());

  // "Effectively connected" — green banner when the user has all the
  // required pieces in place, even before they go through Save (covers
  // upgrades from a pre-banner release whose AI was working).
  // Env-locked + AI_ENABLED=true short-circuits the field checks (operator
  // supplied them server-side; the client doesn't see the API key). Without
  // this the connection-status banner stays blank in env-lock.
  $: _hasAll = envLocks.ai
    ? !!envLocks.ai_enabled
    : ($aiEnabled
        && !!$aiModel?.trim()
        && !!$aiApiKey?.trim()
        && ($aiProvider !== 'oai-compat' || !!$aiBaseUrl?.trim()));
  $: testStatus = testing
    ? 'testing'
    : testError
      ? 'fail'
      : ($aiKeyVerified || _hasAll ? 'ok' : '');

  async function testConnection() {
    if (!canTest && !envLocks.ai) {
      testError = $_('settings_trace.toast.fill_required');
      return;
    }
    testing   = true;
    testError = '';
    try {
      const messages     = [{ role: 'user', content: 'Say "hi" in one word.' }];
      const systemPrompt = 'You are a test bot. Reply with exactly one short word.';
      let text;
      if (envLocks.ai) {
        text = await callAIProxy({ messages, systemPrompt });
      } else {
        text = await callAI({
          provider: $aiProvider,
          apiKey:   $aiApiKey,
          model:    $aiModel,
          baseUrl:  $aiBaseUrl,
          messages,
          systemPrompt,
        });
      }
      if (!text || typeof text !== 'string') throw new Error($_('settings_trace.toast.empty_response'));
      aiKeyVerified.set(true);
      showSuccess($_('settings_trace.toast.connected'));
    } catch (e) {
      testError = e.message || $_('settings_trace.toast.test_failed');
      aiKeyVerified.set(false);
      showError(testError);
    } finally {
      testing = false;
    }
  }

  $: _providerLabel = envLocks.ai
    ? $_('settings_trace.provider_env_locked')
    : ({
        claude:       $_('settings_trace.provider_claude'),
        openai:       $_('settings_trace.provider_openai'),
        gemini:       $_('settings_trace.provider_gemini'),
        'oai-compat': $_('settings_trace.provider_oai_compat'),
      }[$aiProvider] || $aiProvider || '');
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">smart_toy</span></span>
    <span class="section-name">{$_('settings.trace.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        {#if _displayedAiEnabled}
          <ConnectionStatus
            status={testStatus}
            connectedAs={_providerLabel}
            error={testError}
            onRetest={() => testConnection()}
            retestDisabled={testing}
          />
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_trace.labels.enable')}</span>
            <span class="setting-hint">{$_('settings_trace.labels.enable_desc')}</span>
          </div>
          <Toggle checked={_displayedAiEnabled} on:change={e => { if (!envLocks.ai) aiEnabled.set(e.detail); }} disabled={envLocks.ai} />
        </div>
        {#if _displayedAiEnabled}
          <div class="setting-row">
            <span class="setting-label">{$_('settings_trace.labels.provider')}</span>
            <select class="form-select-sm" bind:value={$aiProvider} on:change={_onProviderChange}>
              <option value="claude">{$_('settings_trace.provider_claude')}</option>
              <option value="openai">{$_('settings_trace.provider_openai')}</option>
              <option value="gemini">{$_('settings_trace.provider_gemini')}</option>
              <option value="oai-compat">{$_('settings_trace.provider_oai_compat')}</option>
            </select>
          </div>

          {#if $aiProvider === 'oai-compat'}
            <div class="setting-row" style="flex-wrap:wrap;gap:8px">
              <div class="setting-label-group" style="width:100%">
                <span class="setting-label">{$_('settings_trace.labels.base_url')}</span>
                <span class="setting-hint">{$_('settings_trace.labels.base_url_desc')}</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;width:100%">
                <input class="form-input-sm" style="flex:1" type="url"
                  placeholder={$_('settings_trace.labels.base_url_ph')}
                  bind:value={aiBaseUrlVal} autocomplete="off" />
                <button class="btn btn-primary" style="height:36px;font-size:13px;white-space:nowrap" on:click={saveAiBaseUrl} disabled={testing}>
                  {testing ? $_('settings_trace.labels.testing') : $_('settings_trace.labels.save')}
                </button>
              </div>
            </div>
            <div class="setting-row">
              <span class="setting-label">{$_('settings_trace.labels.model')}</span>
              <input class="form-input-sm" type="text" bind:value={$aiModel} placeholder={$_('settings_trace.labels.model_ph')} />
            </div>
            <div style="padding:10px 16px;display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,#f59e0b 8%, transparent);border-left:3px solid #f59e0b;border-radius:6px">
              <span class="material-symbols-rounded" style="font-size:18px;color:#f59e0b;flex-shrink:0">info</span>
              <div class="setting-hint" style="margin:0;line-height:1.5">
                <strong>{$_('settings_trace.labels.reliability_title')}</strong> {$_('settings_trace.labels.reliability_body')}
              </div>
            </div>
          {:else}
            <div class="setting-row">
              <span class="setting-label">{$_('settings_trace.labels.model')}</span>
              <select class="form-select-sm" bind:value={aiModelSelectVal} on:change={_syncModelFromSelect}>
                {#each providerModels as m}
                  <option value={m.value}>{m.label}</option>
                {/each}
              </select>
            </div>
            {#if aiModelSelectVal === '__custom__'}
              <div class="setting-row">
                <span class="setting-label">{$_('settings_trace.labels.custom_model_id')}</span>
                <input class="form-input-sm" type="text"
                  placeholder={$aiProvider === 'gemini' ? 'gemini-3.5-flash' : $aiProvider === 'claude' ? 'claude-sonnet-5' : 'gpt-4o'}
                  bind:value={aiCustomModelVal} on:input={_syncModelFromSelect} />
              </div>
              <div style="padding:8px 16px 12px;display:flex;gap:8px;align-items:flex-start">
                <span class="material-symbols-rounded" style="font-size:16px;color:var(--muted);flex-shrink:0;margin-top:2px">info</span>
                <div class="setting-hint" style="margin:0;line-height:1.5">
                  {$_('settings_trace.labels.custom_hint')}
                </div>
              </div>
            {/if}
          {/if}

          <div class="setting-row" style="flex-wrap:wrap;gap:8px">
            <div class="setting-label-group" style="width:100%">
              <span class="setting-label">
                {$_('settings_trace.labels.api_key')}{$aiProvider === 'oai-compat' ? $_('settings_trace.labels.api_key_optional') : ''}
              </span>
              <span class="setting-hint">
                {#if $aiProvider === 'claude'}
                  {$_('settings_trace.labels.key_hint_claude')} <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
                {:else if $aiProvider === 'openai'}
                  {$_('settings_trace.labels.key_hint_openai')} <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
                {:else if $aiProvider === 'gemini'}
                  {$_('settings_trace.labels.key_hint_gemini')} <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
                {:else if $aiProvider === 'oai-compat'}
                  {$_('settings_trace.labels.key_hint_oai')}
                {/if}
              </span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;width:100%">
              {#if aiShowKey}
                <input class="form-input-sm" style="flex:1" type="text" bind:value={aiKeyVal} placeholder={$aiProvider === 'oai-compat' ? $_('settings_trace.labels.key_ph_local') : $_('settings_trace.labels.key_ph_cloud')} autocomplete="off" />
              {:else}
                <input class="form-input-sm" style="flex:1" type="password" bind:value={aiKeyVal} placeholder={$aiProvider === 'oai-compat' ? $_('settings_trace.labels.key_ph_local') : $_('settings_trace.labels.key_ph_cloud')} autocomplete="off" />
              {/if}
              <button class="btn-icon-toggle" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? $_('settings_trace.labels.hide') : $_('settings_trace.labels.show')}>
                <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
              </button>
              <button class="btn btn-primary" style="height:36px;font-size:13px;white-space:nowrap" on:click={saveAiKey} disabled={testing}>
                {testing ? $_('settings_trace.labels.testing') : $_('settings_trace.labels.save')}
              </button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">{$_('settings_trace.labels.assistant_name')}</span>
            <input class="form-input-sm" type="text" bind:value={$aiAssistantName} placeholder={$_('settings_trace.labels.assistant_name_ph')} />
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .btn-icon-toggle {
    background: none; border: 1px solid var(--border); cursor: pointer;
    color: var(--text-3); padding: 6px 8px;
    border-radius: var(--radius-sm);
    display: flex; align-items: center;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .btn-icon-toggle:hover { color: var(--text-1); background: var(--surface-2); }
  .about-link { color: var(--accent); text-decoration: underline; }
  .setting-desc { font-size: 12px; color: var(--text-3); padding: 0 16px; }
</style>
