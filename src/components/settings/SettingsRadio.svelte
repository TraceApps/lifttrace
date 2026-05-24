<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { radioEnabled, radioProvider, radioUrl, radioUser, radioPassword, radioCrossfade, radioOriginalFormat, radioStationsEnabled } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let radioTesting = false;
  let radioTestResult = null;
  let radioSaving = false;
  let _rUrl = '', _rUser = '', _rPass = '';
  let _radioLoaded = false;

  function loadRadioFields() {
    if (_radioLoaded) return;
    _rUrl = $radioUrl; _rUser = $radioUser; _rPass = $radioPassword;
    _radioLoaded = true;
  }
  $: if (expanded) loadRadioFields();

  async function saveRadio() {
    radioSaving = true;
    $radioUrl = _rUrl; $radioUser = _rUser; $radioPassword = _rPass;
    try {
      await fetch('/api/app-config', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'radio_url', value: _rUrl }),
      });
      showSuccess('Radio settings saved');
    } catch(e) { showError(e.message); }
    radioSaving = false;
  }

  async function testRadio() {
    await saveRadio();
    radioTesting = true; radioTestResult = null;
    try {
      const { ping } = await import('../../lib/radio-provider.js');
      await ping();
      radioTestResult = 'ok';
    } catch { radioTestResult = 'fail'; }
    radioTesting = false;
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">radio</span></span>
    <span class="section-name">{$_('settings.radio.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Self-hosted music</span>
            <span class="setting-hint">Stream from a Subsonic-compatible server (Navidrome, Jellyfin, Airsonic, etc.)</span>
          </div>
          <Toggle bind:checked={$radioEnabled} />
        </div>

        <!-- Streaming stations is independent of self-hosted music. -->
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Streaming stations</span>
            <span class="setting-hint">Listen to internet radio. Add stations from the directory or paste a stream URL.</span>
          </div>
          <Toggle bind:checked={$radioStationsEnabled} />
        </div>

        {#if $radioEnabled}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Provider</span>
            <select class="form-select-sm" bind:value={$radioProvider} on:change={() => { _radioLoaded = false; loadRadioFields(); }}>
              <option value="emby">Emby</option>
              <option value="jellyfin">Jellyfin</option>
              <option value="plex">Plex</option>
              <option value="subsonic">Subsonic (Navidrome, Airsonic, Gonic)</option>
            </select>
          </div>
          <div class="setting-row">
            <span class="setting-label">Server URL</span>
            <input class="form-input-sm" type="text" bind:value={_rUrl}
              placeholder={$radioProvider === 'plex' ? 'https://plex.example.com:32400' : $radioProvider === 'jellyfin' ? 'https://jellyfin.example.com' : 'https://navidrome.example.com'} />
          </div>
          <div class="setting-row">
            <span class="setting-label">{$radioProvider === 'plex' ? 'Plex Token' : 'Username'}</span>
            <input class="form-input-sm" type="text" bind:value={_rUser}
              placeholder={$radioProvider === 'plex' ? 'Token from plex.tv/claim' : 'username'} />
          </div>
          {#if $radioProvider !== 'plex'}
            <div class="setting-row">
              <span class="setting-label">{$radioProvider === 'emby' ? 'API Key' : 'Password'}</span>
              <input class="form-input-sm" type="password" bind:value={_rPass}
                placeholder={$radioProvider === 'emby' ? 'API key from Emby dashboard' : 'password'} />
            </div>
          {/if}
          <div class="setting-row" style="justify-content:flex-end;gap:8px">
            <button class="btn btn-primary" style="height:32px;font-size:12px" on:click={saveRadio} disabled={radioSaving}>
              {radioSaving ? 'Saving\u2026' : 'Save'}
            </button>
            <button class="btn btn-secondary" style="height:32px;font-size:12px" on:click={testRadio} disabled={radioTesting || !_rUrl}>
              {#if radioTesting}
                <span class="material-symbols-rounded spin" style="font-size:14px">autorenew</span> Testing…
              {:else if radioTestResult === 'ok'}
                <span class="material-symbols-rounded" style="font-size:14px;color:var(--success)">check_circle</span> Connected
              {:else if radioTestResult === 'fail'}
                <span class="material-symbols-rounded" style="font-size:14px;color:var(--danger)">error</span> Failed
              {:else}
                Test Connection
              {/if}
            </button>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Crossfade</span>
              <span class="setting-hint">Blend tracks together during transitions</span>
            </div>
            <select class="form-select-sm" bind:value={$radioCrossfade}>
              <option value={0}>Off</option>
              {#each [1,2,3,4,5,6,8,10,12] as s}
                <option value={s}>{s}s</option>
              {/each}
            </select>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Highest quality playback</span>
              <span class="setting-hint">Stream original format when your library is homogeneous; falls back automatically for mixed queues</span>
            </div>
            <Toggle bind:checked={$radioOriginalFormat} />
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  .exp-badge {
    font-size: 9px; font-weight: 700; padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-left: 6px;
  }
</style>
