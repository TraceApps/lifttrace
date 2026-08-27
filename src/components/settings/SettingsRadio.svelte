<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { radioEnabled, radioProvider, radioUrl, radioUser, radioPassword, radioCrossfade, radioOriginalFormat, radioStationsEnabled } from '../../stores/settings.js';
  import { showSuccess } from '../../stores/toast.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let radioTesting = false;
  let radioTestResult = null;

  // Inputs are bound directly to the SettingStore instances ($radioUrl,
  // $radioUser, $radioPassword) — each store handles debounced server
  // sync on its own, matching NutriTrace's per-field auto-save pattern.
  // No explicit Save button is needed.

  async function testRadio() {
    radioTesting = true; radioTestResult = null;
    try {
      const { ping } = await import('../../lib/radio-provider.js');
      await ping();
      radioTestResult = 'ok';
      showSuccess(`Connected to ${radioProviderLabel || 'your music server'}`);
    } catch { radioTestResult = 'fail'; }
    radioTesting = false;
  }

  // Banner status follows the same pattern as SettingsEmail / NT's SMTP:
  // "Configured" as soon as the URL is filled (creds entered, never verified),
  // "Connected" after a successful test. Failed test takes priority.
  $: radioBannerStatus = radioTesting
    ? 'testing'
    : radioTestResult === 'fail'
      ? 'fail'
      : ($radioUrl ? 'ok' : '');
  $: radioBannerLabel   = radioTestResult === 'ok' ? 'Connected' : 'Configured';
  $: radioBannerSubtext = radioTestResult === 'ok'
    ? 'Last test succeeded; click Test again to re-verify'
    : 'Click Test to verify these credentials';
  // Provider chip rendered in the banner so the user always sees which
  // music library the "Configured" / "Connected" state refers to.
  $: radioProviderLabel = $radioProvider === 'subsonic' ? 'Subsonic'
                        : $radioProvider === 'jellyfin' ? 'Jellyfin'
                        : $radioProvider === 'plex' ? 'Plex'
                        : $radioProvider === 'emby' ? 'Emby'
                        : '';
  // Clear stale test result when the user switches providers.
  let _lastRadioProvider = $radioProvider;
  $: if ($radioProvider !== _lastRadioProvider) {
    _lastRadioProvider = $radioProvider;
    radioTestResult = null;
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
        {#if $radioEnabled}
          <ConnectionStatus
            status={radioBannerStatus}
            okLabel={radioBannerLabel}
            connectedAs={radioProviderLabel}
            subtext={radioBannerSubtext}
            error={radioTestResult === 'fail' ? `${radioProviderLabel || 'Server'} test failed — check URL and credentials below` : ''}
            onRetest={testRadio}
            retestDisabled={radioTesting || !$radioUrl}
            retestLabel="Test"
          />
        {/if}
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_radio.self_hosted')}</span>
            <span class="setting-hint">{$_('settings_radio.self_hosted_hint')}</span>
          </div>
          <Toggle bind:checked={$radioEnabled} />
        </div>

        <!-- Streaming stations is independent of self-hosted music. -->
        <div class="setting-divider"></div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_radio.streaming_stations')}</span>
            <span class="setting-hint">{$_('settings_radio.streaming_stations_hint')}</span>
          </div>
          <Toggle bind:checked={$radioStationsEnabled} />
        </div>

        {#if $radioEnabled}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">{$_('settings_radio.provider')}</span>
            <select class="form-select-sm" bind:value={$radioProvider}>
              <option value="emby">{$_('settings_radio.emby')}</option>
              <option value="jellyfin">{$_('settings_radio.jellyfin')}</option>
              <option value="plex">{$_('settings_radio.plex')}</option>
              <option value="subsonic">Subsonic (Navidrome, Airsonic, Gonic)</option>
            </select>
          </div>
          <div class="setting-row">
            <span class="setting-label">{$_('settings_radio.server_url')}</span>
            <input class="form-input-sm" type="text" bind:value={$radioUrl}
              placeholder={$radioProvider === 'plex' ? 'https://plex.example.com:32400' : $radioProvider === 'jellyfin' ? 'https://jellyfin.example.com' : 'https://navidrome.example.com'} />
          </div>
          <div class="setting-row">
            <span class="setting-label">{$radioProvider === 'plex' ? 'Plex Token' : 'Username'}</span>
            <input class="form-input-sm" type="text" bind:value={$radioUser}
              placeholder={$radioProvider === 'plex' ? 'Token from plex.tv/claim' : 'username'} />
          </div>
          {#if $radioProvider !== 'plex'}
            <div class="setting-row">
              <span class="setting-label">{$radioProvider === 'emby' ? 'API Key' : 'Password'}</span>
              <input class="form-input-sm" type="password" bind:value={$radioPassword}
                placeholder={$radioProvider === 'emby' ? 'API key from Emby dashboard' : 'password'} />
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_radio.crossfade')}</span>
              <span class="setting-hint">{$_('settings_radio.crossfade_hint')}</span>
            </div>
            <select class="form-select-sm" bind:value={$radioCrossfade}>
              <option value={0}>{$_('settings_radio.off')}</option>
              {#each [1,2,3,4,5,6,8,10,12] as s}
                <option value={s}>{s}s</option>
              {/each}
            </select>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_radio.highest_quality')}</span>
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
