<script>
  /**
   * Diagnostics — in-app log capture + share.
   *
   * Lets users grab the in-memory log buffer (~500 lines), turn on verbose
   * mode while reproducing a bug, and copy/share the result without needing
   * adb logcat or DevTools. On native the system Share sheet is also offered
   * so the log can go straight to email / Drive / Files.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { isNative } from '../../lib/platform.js';
  import {
    getLogBufferText,
    clearLogBuffer,
    isVerboseLogging,
    setVerboseLogging,
  } from '../../lib/log-capture.js';

  export let visible = true;
  export let expanded = false;
  export let onToggle = () => {};

  let verboseOn = isVerboseLogging();
  let logsSheet = false;
  let logsText = '';
  let logsCopied = false;

  function openLogsSheet() {
    logsText = getLogBufferText() || '(no log lines captured yet)';
    logsCopied = false;
    logsSheet = true;
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logsText);
      logsCopied = true;
      setTimeout(() => logsCopied = false, 2000);
    } catch {
      showError($_('settings_diagnostics.copy_failed'));
    }
  }

  async function shareLogs() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'LiftTrace diagnostic logs',
          text: logsText,
          dialogTitle: 'Share LiftTrace logs',
        });
      } else if (navigator.share) {
        await navigator.share({ title: 'LiftTrace diagnostic logs', text: logsText });
      } else {
        await copyLogs();
      }
    } catch (e) {
      // User cancelled — silent.
    }
  }

  function clearLogs() {
    clearLogBuffer();
    logsText = '(cleared)';
    showSuccess($_('settings_diagnostics.logs_cleared'));
  }

  function toggleVerbose(on) {
    verboseOn = on;
    setVerboseLogging(on);
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">troubleshoot</span></span>
    <span class="section-name">{$_('settings.diagnostics.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>

  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_diagnostics.verbose_logging')}</span>
            <span class="setting-hint">
              {$_('settings_diagnostics.verbose_logging_hint')}
            </span>
          </div>
          <Toggle checked={verboseOn} on:change={e => toggleVerbose(e.detail)} />
        </div>

        <div class="setting-divider"></div>

        <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <span class="setting-label">{$_('settings_diagnostics.view_logs')}</span>
          <p class="setting-hint" style="line-height:1.5;margin:0">
            {$_('settings_diagnostics.view_logs_hint_prefix')}
            <a href="https://github.com/TraceApps/lifttrace/issues" target="_blank" rel="noopener" style="color:var(--accent)">{$_('settings_diagnostics.github_issue')}</a>{$_('settings_diagnostics.view_logs_hint_suffix')}
          </p>
          <button class="btn btn-secondary" style="height:40px;font-size:13px" on:click={openLogsSheet}>
            <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">terminal</span>
            {$_('settings_diagnostics.view_logs_button')}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <Sheet bind:open={logsSheet} title="Diagnostic Logs">
    <div style="padding:0 4px 8px">
      <p class="setting-hint" style="line-height:1.5;margin-bottom:10px">
        Last 500 lines captured. Copy or share into a bug report.
      </p>
      <textarea
        readonly
        style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;
               border:1px solid var(--border);border-radius:8px;background:var(--surface-2);
               color:var(--text-1);resize:vertical;white-space:pre"
      >{logsText}</textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary" style="flex:1;height:40px;font-size:13px" on:click={copyLogs}>
          {#if logsCopied}
            <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">check</span> Copied
          {:else}
            <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">content_copy</span> Copy
          {/if}
        </button>
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={shareLogs}>
          <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">share</span> Share
        </button>
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={clearLogs}>
          <span class="material-symbols-rounded" style="font-size:16px;vertical-align:-3px">delete</span> Clear
        </button>
      </div>
    </div>
  </Sheet>
{/if}
