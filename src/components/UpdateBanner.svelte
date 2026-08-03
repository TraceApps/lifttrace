<script>
  /**
   * UpdateBanner — top-of-app dismissible banner announcing an available
   * update. Renders in App.svelte, above the page content, on every
   * screen post-login.
   *
   * Platforms:
   *   Android: shows APK-update banner (deep-links to Settings → Updates
   *            for install action).
   *   PWA:     shows PWA-bundle-update banner when a new service worker
   *            is ready (tap "Reload" activates it) — see App.svelte's
   *            SW hook for the trigger.
   *
   * Server-update banner (admin only) lives inside SettingsUpdates
   * rather than at the app top, to avoid nagging admins on every screen.
   *
   * Skip-this-version behavior: user can dismiss and never see the same
   * version again. Reset happens automatically the moment a newer
   * version appears (getSkippedVersion returns the exact string; any
   * newer tag doesn't match).
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { isNative } from '../lib/platform.js';
  import {
    checkForUpdate, isUpdateAvailable, getAutoCheck,
    getSkippedVersion, skipVersion,
  } from '../lib/updates.js';
  import {
    isUpdateNotificationPermissionGranted, showUpdateNotification,
  } from '../lib/notifications.js';

  // Remembers which version we already posted the OS notification for so
  // we don't re-post on every app open (the notification stays in the
  // shade until dismissed; re-scheduling with the same ID replaces it
  // and would reset the user's dismissal, defeating the point).
  const NOTIFIED_KEY = 'nt_updates_notified_version';

  let latest      = null;
  let visible     = false;

  onMount(async () => {
    if (!isNative) return; // PWA client-update comes from the service worker; server-update lives in Settings.
    if (!getAutoCheck()) return;
    try {
      latest = await checkForUpdate({ force: false });
      if (!latest || !isUpdateAvailable(latest)) return;
      const skipped = getSkippedVersion();
      if (skipped === latest.version) return;

      // Suppression: if the OS notification channel is available, post
      // there instead of showing the banner. Users who granted permission
      // get a proper, dismissible OS notification and a clean app UI.
      // Users who denied permission still get the banner as fallback.
      if (await isUpdateNotificationPermissionGranted()) {
        const alreadyNotified = _getNotifiedVersion() === latest.version;
        if (!alreadyNotified) {
          const posted = await showUpdateNotification(latest);
          if (posted) _setNotifiedVersion(latest.version);
        }
        return; // banner stays hidden
      }
      visible = true;
    } catch { /* silent — this is best-effort */ }
  });

  function _getNotifiedVersion() {
    try { return localStorage.getItem(NOTIFIED_KEY) || ''; } catch { return ''; }
  }
  function _setNotifiedVersion(v) {
    try { localStorage.setItem(NOTIFIED_KEY, v); } catch {}
  }

  function goToUpdates() {
    push('/settings');
    visible = false;
  }
  function dismiss() {
    if (latest?.version) skipVersion(latest.version);
    visible = false;
  }
</script>

{#if visible && latest}
  <div class="update-banner" transition:fade={{ duration: 200 }}>
    <span class="material-symbols-rounded icon" aria-hidden="true">system_update</span>
    <div class="body">
      <div class="title">{$_('updates.available_headline', { values: { version: latest.version } })}</div>
      <div class="sub">{$_('updates.banner_cta')}</div>
    </div>
    <button class="btn primary" on:click={goToUpdates}>{$_('updates.banner_view')}</button>
    <button class="dismiss" on:click={dismiss} aria-label={$_('updates.skip_this_version')}>
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

<style>
  .update-banner {
    position: sticky; top: 0; z-index: 200;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 15%, var(--surface-1));
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--text-1);
  }
  .icon { color: var(--accent); flex-shrink: 0; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 14px; }
  .sub   { font-size: 12px; color: var(--text-2); }
  .btn.primary {
    background: var(--accent); color: white; border: none;
    padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .dismiss {
    background: transparent; border: none; padding: 4px; cursor: pointer;
    display: flex; align-items: center; color: var(--text-2);
  }
  .dismiss:hover { color: var(--text-1); }
</style>
