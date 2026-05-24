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
  // Reset model to provider default when switching to a built-in provider.
  // 'oai-compat' has no curated model list (free-text input), so skip the reset.
  $: if ($aiProvider !== 'oai-compat' && $aiProvider && !providerModels.find(m => m.value === $aiModel)) {
    $aiModel = AI_DEFAULT_MODELS[$aiProvider];
    _invalidate();
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
      testError = 'Fill in provider, API key, and model first';
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
      if (!text || typeof text !== 'string') throw new Error('Empty response from AI');
      aiKeyVerified.set(true);
      showSuccess('Trace AI connected — assistant is ready');
    } catch (e) {
      testError = e.message || 'Test failed';
      aiKeyVerified.set(false);
      showError(testError);
    } finally {
      testing = false;
    }
  }

  $: _providerLabel = envLocks.ai
    ? 'Environment-locked'
    : ({
        claude:      'Anthropic Claude',
        openai:      'OpenAI',
        gemini:      'Google Gemini',
        'oai-compat':'OpenAI Compatible',
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
            <span class="setting-label">Enable AI Assistant</span>
            <span class="setting-hint">Adds a floating chat button to all pages</span>
          </div>
          <Toggle checked={_displayedAiEnabled} on:change={e => { if (!envLocks.ai) aiEnabled.set(e.detail); }} disabled={envLocks.ai} />
        </div>
        {#if _displayedAiEnabled}
          <div class="setting-row">
            <span class="setting-label">Provider</span>
            <select class="form-select-sm" bind:value={$aiProvider}>
              <option value="claude">Anthropic Claude</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="oai-compat">OpenAI Compatible</option>
            </select>
          </div>

          {#if $aiProvider === 'oai-compat'}
            <!-- Custom OpenAI-compatible: free-text Base URL + Model name -->
            <div class="setting-row" style="flex-wrap:wrap;gap:8px">
              <div class="setting-label-group" style="width:100%">
                <span class="setting-label">Base URL</span>
                <span class="setting-hint">
                  Any OpenAI Compatible <code>/v1/chat/completions</code> endpoint — Ollama, LM Studio, LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq, Together AI, Mistral La Plateforme, etc. Don't include the path; just the origin.
                </span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;width:100%">
                <input class="form-input-sm" style="flex:1" type="url"
                  placeholder="http://localhost:11434  or  https://api.deepseek.com"
                  bind:value={aiBaseUrlVal} autocomplete="off" />
                <button class="btn btn-primary" style="height:36px;font-size:13px;white-space:nowrap" on:click={saveAiBaseUrl} disabled={testing}>
                  {testing ? 'Testing…' : 'Save'}
                </button>
              </div>
            </div>
            <div class="setting-row">
              <span class="setting-label">Model</span>
              <input class="form-input-sm" type="text" bind:value={$aiModel} placeholder="llama3.1:8b" />
            </div>
            <div style="padding:10px 16px;display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,#f59e0b 8%, transparent);border-left:3px solid #f59e0b;border-radius:6px">
              <span class="material-symbols-rounded" style="font-size:18px;color:#f59e0b;flex-shrink:0">info</span>
              <div class="setting-hint" style="margin:0;line-height:1.5">
                <strong>Tool calls / vision reliability varies by model.</strong> Llama 3.1+, Mistral, Qwen 2.5+ handle reasoning well; smaller or older models may struggle with Smart Log parsing. If you're unsure, start with a known-good model and verify chat works before relying on it.
              </div>
            </div>
          {:else}
            <div class="setting-row">
              <span class="setting-label">Model</span>
              <select class="form-select-sm" bind:value={$aiModel}>
                {#each providerModels as m}
                  <option value={m.value}>{m.label}</option>
                {/each}
              </select>
            </div>
          {/if}

          <div class="setting-row" style="flex-wrap:wrap;gap:8px">
            <div class="setting-label-group" style="width:100%">
              <span class="setting-label">
                API key{$aiProvider === 'oai-compat' ? ' (optional)' : ''}
              </span>
              <span class="setting-hint">
                {#if $aiProvider === 'claude'}
                  Get one at <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
                {:else if $aiProvider === 'openai'}
                  Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
                {:else if $aiProvider === 'gemini'}
                  Get one at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
                {:else if $aiProvider === 'oai-compat'}
                  Local endpoints (Ollama, LM Studio, etc.) typically don't need a key. Cloud providers like DeepSeek or Groq do — get one from their dashboard.
                {/if}
              </span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;width:100%">
              {#if aiShowKey}
                <input class="form-input-sm" style="flex:1" type="text" bind:value={aiKeyVal} placeholder={$aiProvider === 'oai-compat' ? 'Leave blank for local endpoints' : 'Paste your API key here'} autocomplete="off" />
              {:else}
                <input class="form-input-sm" style="flex:1" type="password" bind:value={aiKeyVal} placeholder={$aiProvider === 'oai-compat' ? 'Leave blank for local endpoints' : 'Paste your API key here'} autocomplete="off" />
              {/if}
              <button class="btn-icon-toggle" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
              </button>
              <button class="btn btn-primary" style="height:36px;font-size:13px;white-space:nowrap" on:click={saveAiKey} disabled={testing}>
                {testing ? 'Testing…' : 'Save'}
              </button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">Assistant Name</span>
            <input class="form-input-sm" type="text" bind:value={$aiAssistantName} placeholder="Trace" />
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
