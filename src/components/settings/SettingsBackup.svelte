<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { currentUser, userMgmtActive, logout } from '../../stores/auth.js';
  import {
    appearance, applyAppearance, accentColor, applyAccentColor,
    weightUnit, dateFormat, timeFormat, weeklyWorkoutGoal,
    navStyle, sidebarPersistent, disableAnimations, pageBanners,
    startPage, screenKeepAwake, goalCelebrations,
  } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import Dialog from '../ui/Dialog.svelte';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let fullBackups = [];
  let fullBackupBusy = false;
  let restoreTarget = null;
  let deleteTarget = null;
  let showRestoreDialog = false;
  let showDeleteBkDialog = false;
  let showUploadRestoreDialog = false;
  let uploadRestoreFile = null;
  let restoreStatus = null;
  let restoreProgressEl;

  let showClearDataDialog = false;
  let showClearSettingsDialog = false;

  $: if (expanded) loadFullBackups();

  async function loadFullBackups() {
    try {
      const res = await fetch('/api/full-backup', { credentials: 'include' });
      if (res.ok) fullBackups = await res.json();
    } catch {}
  }

  async function createFullBackup() {
    fullBackupBusy = true;
    try {
      const res = await fetch('/api/full-backup', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'Backup failed');
      showSuccess('Backup created');
      await loadFullBackups();
    } catch(e) { showError(e.message); }
    fullBackupBusy = false;
  }

  function downloadBackup(name) {
    const a = document.createElement('a');
    a.href = `/api/full-backup/${encodeURIComponent(name)}/download`;
    a.download = name;
    a.click();
  }

  function confirmRestoreBackup() {
    showRestoreDialog = false;
    restoreStatus = { phase: 'restoring', percent: 40, label: 'Restoring\u2026' };
    scrollToProgress();
    fetch(`/api/full-backup/${encodeURIComponent(restoreTarget)}/restore`, {
      method: 'POST', credentials: 'include',
    }).then(res => {
      if (!res.ok) throw new Error('Restore failed');
      restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete \u2014 reloading\u2026' };
      setTimeout(() => location.reload(), 1500);
    }).catch(e => {
      showError(e.message);
      restoreStatus = null;
    });
  }

  function confirmDeleteBackup() {
    showDeleteBkDialog = false;
    fetch(`/api/full-backup/${encodeURIComponent(deleteTarget)}`, {
      method: 'DELETE', credentials: 'include',
    }).then(() => loadFullBackups()).catch(e => showError(e.message));
  }

  function pickUploadRestore() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = () => {
      if (!input.files?.[0]) return;
      uploadRestoreFile = input.files[0];
      showUploadRestoreDialog = true;
    };
    input.click();
  }

  function confirmUploadRestore() {
    showUploadRestoreDialog = false;
    restoreStatus = { phase: 'uploading', percent: 0, label: 'Uploading\u2026' };
    scrollToProgress();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/full-backup/upload-restore');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        restoreStatus = { phase: 'uploading', percent: Math.round((e.loaded / e.total) * 85), label: 'Uploading\u2026' };
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 400) {
        const msg = xhr.status === 413 ? 'File too large' : (JSON.parse(xhr.responseText || '{}').error || 'Restore failed');
        showError(msg);
        restoreStatus = null;
        return;
      }
      restoreStatus = { phase: 'restoring', percent: 95, label: 'Restoring\u2026' };
      setTimeout(() => {
        restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete \u2014 reloading\u2026' };
        setTimeout(() => location.reload(), 1000);
      }, 600);
    };
    xhr.onerror = () => { showError('Network error during upload'); restoreStatus = null; };
    const form = new FormData();
    form.append('backup', uploadRestoreFile);
    xhr.send(form);
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function scrollToProgress() {
    setTimeout(() => restoreProgressEl?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }

  function resetDefaults() {
    appearance.set('system');     applyAppearance('system');
    accentColor.set('orange');    applyAccentColor('orange');
    weightUnit.set('lbs');
    dateFormat.set('US');
    timeFormat.set('12h');
    weeklyWorkoutGoal.set(3);
    navStyle.set('bottom');
    sidebarPersistent.set(false);
    disableAnimations.set(false);
    pageBanners.set(false);
    startPage.set('/');
    screenKeepAwake.set(true);
    goalCelebrations.set(true);
    showSuccess('Settings reset to defaults');
  }

  async function clearAllData() {
    showClearDataDialog = false;
    try {
      const res = await fetch('/api/settings/clear-data', { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      showSuccess('All workout data cleared');
      setTimeout(() => location.reload(), 1000);
    } catch(e) { showError(e.message); }
  }

  async function clearAllSettings() {
    showClearSettingsDialog = false;
    resetDefaults();
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">backup</span></span>
    <span class="section-name">{$_('settings.backup.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label">Full Backup</p>
      <div class="card">
        <div style="padding:12px 16px 4px">
          <p class="setting-desc" style="margin:0 0 12px">A complete snapshot of everything — all workout data, programs, exercises, settings, and uploaded images. Saved on the server and available to download or restore at any time.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            <button class="btn btn-primary" style="height:36px;font-size:13px"
              on:click={createFullBackup} disabled={fullBackupBusy}>
              {#if fullBackupBusy}
                <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
              {:else}
                <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
              {/if}
            </button>
            <button class="btn btn-secondary" style="height:36px;font-size:13px"
              on:click={pickUploadRestore} disabled={fullBackupBusy}>
              <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
            </button>
          </div>
          {#if restoreStatus}
            <div class="restore-progress" bind:this={restoreProgressEl}>
              <div class="restore-progress-label">
                <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
                {restoreStatus.label}
              </div>
              <div class="restore-progress-track">
                <div class="restore-progress-fill" style="width:{restoreStatus.percent}%"></div>
              </div>
            </div>
          {/if}
        </div>

        {#if fullBackups.length > 0}
          <div class="setting-divider"></div>
          <div class="backup-table-header">
            <span>Name</span>
            <span>Created</span>
            <span>Size</span>
            <span></span>
          </div>
          <div class="setting-divider"></div>
          {#each fullBackups as bk, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="backup-row">
              <span class="backup-name">{bk.filename || bk.name}</span>
              <span class="backup-col-date">{new Date(bk.createdAt || bk.created_at || bk.name).toLocaleDateString()}</span>
              <span class="backup-col-size">{fmtBytes(bk.size || 0)}</span>
              <div class="backup-actions">
                <button class="btn btn-secondary backup-action-btn"
                  on:click={() => downloadBackup(bk.filename || bk.name)}>
                  <span class="material-symbols-rounded" style="font-size:15px">download</span> Download
                </button>
                <button class="btn btn-secondary backup-action-btn"
                  on:click={() => { restoreTarget = bk.filename || bk.name; showRestoreDialog = true; }} disabled={fullBackupBusy}>
                  <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
                </button>
                <button class="btn-icon-danger"
                  on:click={() => { deleteTarget = bk.filename || bk.name; showDeleteBkDialog = true; }} title="Delete backup">
                  <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                </button>
              </div>
            </div>
          {/each}
        {:else}
          <div class="setting-divider"></div>
          <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">No backups yet — click Create Backup to get started.</p>
        {/if}
      </div>

      <p class="sub-label danger-zone-label">Danger Zone</p>
      <div class="card danger-zone-card">
        <button class="setting-row setting-action danger" on:click={() => showClearSettingsDialog = true}>
          <span class="material-symbols-rounded si-danger">manage_history</span>
          <div class="setting-label-group">
            <span class="setting-label" style="color:var(--danger)">Clear all settings</span>
            <div class="setting-desc">Resets preferences to defaults. Workout data is kept.</div>
          </div>
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
        </button>
        <div class="setting-divider"></div>
        <button class="setting-row setting-action danger" on:click={() => showClearDataDialog = true}>
          <span class="material-symbols-rounded si-danger">delete_forever</span>
          <div class="setting-label-group">
            <span class="setting-label" style="color:var(--danger)">Clear all data</span>
            <div class="setting-desc">Deletes all workouts, programs, body stats, and chat history. Cannot be undone.</div>
          </div>
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
        </button>
        <!-- Delete my account lives in Profile → Danger zone (single source of truth). -->
      </div>
    </div>
  {/if}
{/if}

<Dialog bind:open={showRestoreDialog}
  title="Restore backup?"
  message="This will replace all current data with the contents of this backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmRestoreBackup}
/>

<Dialog bind:open={showUploadRestoreDialog}
  title="Restore from uploaded file?"
  message="This will replace all current data with the contents of the uploaded backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmUploadRestore}
/>

<Dialog bind:open={showDeleteBkDialog}
  title="Delete backup?"
  message="This backup file will be permanently removed from the server."
  confirmText="Delete"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmDeleteBackup}
/>

<Dialog bind:open={showClearDataDialog}
  title="Clear all data?"
  message="This will permanently delete all your workouts, programs, body stats, personal records, and chat history. Settings and exercises will be kept. This cannot be undone."
  confirmText="Clear all data"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllData}
/>

<Dialog bind:open={showClearSettingsDialog}
  title="Clear all settings?"
  message="This will reset all preferences (appearance, units, notifications, integrations) back to their defaults. Your workout data will not be touched."
  confirmText="Clear all settings"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllSettings}
/>

<style>
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 2px 2px; margin: 0;
  }
  .setting-desc {
    font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; line-height: 1.5;
  }
  .restore-progress {
    padding: 0 0 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .restore-progress-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-2);
  }
  .restore-progress-track {
    height: 6px; border-radius: 3px;
    background: var(--surface-2); overflow: hidden;
  }
  .restore-progress-fill {
    height: 100%; border-radius: 3px;
    background: var(--accent); transition: width 300ms ease;
  }
  .spin { animation: settings-spin 0.8s linear infinite; }
  @keyframes settings-spin { to { transform: rotate(360deg); } }

  .backup-table-header {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 6px 16px;
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    color: var(--text-3);
  }
  .backup-row {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 10px 16px;
    align-items: center;
  }
  .backup-name {
    font-size: 12px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .backup-col-date { font-size: 13px; color: var(--text-2); }
  .backup-col-size { font-size: 13px; color: var(--text-2); }
  .backup-actions {
    display: flex; align-items: center; gap: 6px;
    justify-content: flex-end; flex-wrap: wrap;
  }
  .backup-action-btn {
    height: 30px; font-size: 12px; padding: 0 10px;
    display: flex; align-items: center; gap: 4px;
  }
  .btn-icon-danger {
    background: none; border: none; cursor: pointer;
    color: var(--danger); padding: 0 4px;
    display: flex; align-items: center;
  }
  .btn-icon-danger:hover { opacity: 0.7; }
  .btn-icon-danger:disabled { opacity: 0.4; cursor: not-allowed; }

  .danger-zone-label { color: var(--danger) !important; opacity: 0.85; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .setting-action {
    cursor: pointer; background: none; border: none; width: 100%; text-align: left;
    transition: background var(--dur-fast);
  }
  .setting-action:hover { background: var(--surface-2); }
  .setting-action.danger:hover { background: rgba(255,92,92,0.06); }
  .si-danger {
    font-size: 20px; color: var(--danger); flex-shrink: 0;
    width: 32px; display: flex; align-items: center; justify-content: center;
  }

  @media (max-width: 480px) {
    .backup-table-header { display: none; }
    .backup-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
    }
    .backup-name { grid-column: 1; grid-row: 1; }
    .backup-col-date { grid-column: 1; grid-row: 2; font-size: 12px; }
    .backup-col-size { display: none; }
    .backup-actions {
      grid-column: 2; grid-row: 1 / 3;
      flex-direction: column; align-items: stretch;
    }
    .backup-action-btn { justify-content: center; }
  }
</style>
