<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError, showSuccess } from '../../stores/toast.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  // ── Workout import (Strong / Hevy / FitNotes / Jefit) ────────────────────
  let importSource = 'strong';   // 'strong' | 'hevy' | 'fitnotes' | 'jefit' | 'garmin-fit'

  // fileKind is what the file-picker + button copy read to describe the
  // artifact the user is looking for (CSV vs FIT etc.). Hints and steps are
  // i18n keys, read at render so they follow the language.
  const SOURCES = [
    { id: 'strong',     name: 'Strong',    hint: 'settings_workout_import.sources.strong',   fileKind: 'CSV', accept: '.csv,text/csv' },
    { id: 'hevy',       name: 'Hevy',      hint: 'settings_workout_import.sources.hevy',     fileKind: 'CSV', accept: '.csv,text/csv' },
    { id: 'fitnotes',   name: 'FitNotes',  hint: 'settings_workout_import.sources.fitnotes', fileKind: 'CSV', accept: '.csv,text/csv' },
    { id: 'jefit',      name: 'Jefit',     hint: 'settings_workout_import.sources.jefit',    fileKind: 'CSV', accept: '.csv,text/csv' },
    { id: 'garmin-fit', name: 'Garmin',    hint: 'settings_workout_import.sources.garmin',   fileKind: 'FIT', accept: '.fit,application/octet-stream' },
  ];
  const INSTRUCTIONS = {
    strong: [
      'settings_workout_import.steps.strong_open',
      'settings_workout_import.steps.strong_export',
      'settings_workout_import.steps.pick_file',
    ],
    hevy: [
      'settings_workout_import.steps.hevy_open',
      'settings_workout_import.steps.hevy_download',
      'settings_workout_import.steps.pick_file',
    ],
    fitnotes: [
      'settings_workout_import.steps.fitnotes_open',
      'settings_workout_import.steps.fitnotes_share',
      'settings_workout_import.steps.pick_file',
    ],
    jefit: [
      'settings_workout_import.steps.jefit_open',
      'settings_workout_import.steps.jefit_download',
      'settings_workout_import.steps.pick_file',
    ],
    'garmin-fit': [
      'settings_workout_import.steps.garmin_open',
      'settings_workout_import.steps.garmin_export',
      'settings_workout_import.steps.garmin_pick',
    ],
  };
  let importFileInput;
  let importFile = null;
  let importBusy = false;
  let importPreview = null;      // from /preview endpoint
  let importResult  = null;      // from /commit endpoint

  async function onPickFile(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    importFile = file;
    importPreview = null;
    importResult = null;
    await runPreview();
    e.target.value = '';
  }

  async function runPreview() {
    if (!importFile) return;
    importBusy = true;
    try {
      const form = new FormData();
      form.append('file', importFile);
      form.append('source', importSource);
      const res = await fetch('/api/workout-import/preview', { method: 'POST', credentials: 'include', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || $_('settings_workout_import.preview_failed'));
      importPreview = data;
    } catch(e) { showError(e.message); importPreview = null; importFile = null; }
    importBusy = false;
  }

  async function runCommit() {
    if (!importFile || !importPreview) return;
    let onDuplicate = 'skip';
    if (importPreview.duplicateDates > 0) {
      const replace = await confirmDialog({
        title: $_('settings_workout_import.confirm.duplicate_dates_title', { values: { count: importPreview.duplicateDates } }),
        message: $_('settings_workout_import.confirm.duplicate_dates_msg'),
        confirmText: $_('settings_workout_import.confirm.replace_existing'),
        cancelText: $_('settings_workout_import.confirm.skip_duplicates'),
        dangerous: true,
      });
      onDuplicate = replace ? 'replace' : 'skip';
    }
    importBusy = true;
    try {
      const form = new FormData();
      form.append('file', importFile);
      form.append('source', importSource);
      form.append('onDuplicate', onDuplicate);
      const res = await fetch('/api/workout-import/commit', { method: 'POST', credentials: 'include', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || $_('settings_workout_import.import_failed'));
      importResult = data;
      showSuccess($_('settings_workout_import.imported', { values: { count: data.imported } }));
    } catch(e) { showError(e.message); }
    importBusy = false;
  }

  function resetImport() {
    importFile = null; importPreview = null; importResult = null;
  }

  $: currentSource = SOURCES.find(s => s.id === importSource) || SOURCES[0];
  $: sourceLabel = currentSource.name;
  $: sourceFileKind = currentSource.fileKind;
  $: sourceAccept = currentSource.accept;
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">download</span></span>
    <span class="section-name">{$_('settings.workout_import.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        <div class="card-body">
          <p class="setting-desc">{$_('settings_workout_import.intro')}</p>

          <div class="source-picker">
            {#each SOURCES as s}
              <button class="source-btn" class:active={importSource === s.id} on:click={() => { importSource = s.id; resetImport(); }}>
                <span class="source-name">{s.name}</span>
                <span class="source-hint">{$_(s.hint)}</span>
              </button>
            {/each}
          </div>

          {#if !importFile}
            <button class="btn btn-primary import-btn" on:click={() => importFileInput.click()} disabled={importBusy}>
              <span class="material-symbols-rounded">upload_file</span>
              {importBusy ? $_('settings_workout_import.reading') : $_('settings_workout_import.choose_file', { values: { source: sourceLabel, kind: sourceFileKind } })}
            </button>
            <input bind:this={importFileInput} type="file" accept={sourceAccept} style="display:none" on:change={onPickFile} />

            <p class="help-title">{$_('settings_workout_import.how_to_export')}</p>
            <ol class="help-list">
              {#each INSTRUCTIONS[importSource] as step}
                <li>{$_(step)}</li>
              {/each}
            </ol>
          {:else if importResult}
            <div class="result-card ok">
              <span class="material-symbols-rounded" style="font-size:28px;color:var(--success)">check_circle</span>
              <div>
                <div class="result-title">{$_('settings_workout_import.imported', { values: { count: importResult.imported } })}</div>
                <div class="result-sub">
                  {#if importResult.skipped > 0}{$_('settings_workout_import.skipped_existing', { values: { count: importResult.skipped } })}{#if importResult.replaced > 0}, {/if}{/if}
                  {#if importResult.replaced > 0}{$_('settings_workout_import.replaced', { values: { count: importResult.replaced } })}{/if}
                </div>
              </div>
            </div>
            <button class="btn btn-secondary" on:click={resetImport}>{$_('settings_workout_import.import_another_file')}</button>
          {:else if importPreview}
            <div class="preview">
              <div class="preview-head">
                <div class="preview-title">{$_('settings_workout_import.ready_to_import')}</div>
                <button class="preview-reset" on:click={resetImport} title={$_('settings_workout_import.start_over')}>
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
              <div class="stats">
                <div class="stat"><span class="stat-num">{importPreview.workouts}</span><span class="stat-lbl">{$_('settings_workout_import.stat_workouts')}</span></div>
                <div class="stat"><span class="stat-num">{importPreview.sets}</span><span class="stat-lbl">{$_('settings_workout_import.stat_sets')}</span></div>
                <div class="stat"><span class="stat-num">{importPreview.matchedExercises}<span class="stat-sub">/{importPreview.uniqueExercises}</span></span><span class="stat-lbl">{$_('settings_workout_import.stat_matched')}</span></div>
              </div>
              <div class="preview-range">{importPreview.dateRange.from} → {importPreview.dateRange.to}</div>
              {#if importPreview.duplicateDates > 0}
                <div class="warn-inline">
                  <span class="material-symbols-rounded">error_outline</span>
                  <span>{$_('settings_workout_import.duplicate_dates', { values: { count: importPreview.duplicateDates } })}</span>
                </div>
              {/if}
              {#if importPreview.unmatchedExercises?.length > 0}
                <details class="unmatched">
                  <summary>{$_('settings_workout_import.unmatched_summary', { values: { count: importPreview.unmatchedExercises.length } })}</summary>
                  <ul>
                    {#each importPreview.unmatchedExercises as ex}
                      <li>{ex.name} <span class="unmatched-count">×{ex.count}</span></li>
                    {/each}
                  </ul>
                  <p class="unmatched-hint">{$_('settings_workout_import.unmatched_hint')}</p>
                </details>
              {/if}
              <div class="preview-actions">
                <button class="btn btn-secondary" on:click={resetImport} disabled={importBusy}>{$_('settings_workout_import.cancel')}</button>
                <button class="btn btn-primary" on:click={runCommit} disabled={importBusy}>
                  {importBusy ? $_('settings_workout_import.importing') : $_('settings_workout_import.import_count', { values: { count: importPreview.workouts } })}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .card-body { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin: 0; line-height: 1.5; }

  /* 5 sources: 2 columns on narrow phones (3rd row wraps the 5th),
     up to 5-wide on desktop so each button gets equal share. Auto-fill
     with a min-width lets the grid re-flow gracefully at any width. */
  .source-picker {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  @media (min-width: 640px) {
    .source-picker { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  }
  .source-btn {
    display: flex; flex-direction: column; gap: 4px;
    padding: 12px 14px; border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    cursor: pointer; text-align: left; font-family: inherit;
    transition: all var(--dur-fast);
  }
  .source-btn:hover { border-color: var(--text-2); }
  .source-btn.active {
    background: var(--accent-dim);
    border-color: var(--accent);
  }
  .source-name { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .source-btn.active .source-name { color: var(--accent); }
  .source-hint { font-size: 11px; color: var(--text-3); }

  .import-btn { display: inline-flex; align-items: center; gap: 8px; justify-content: center; }
  .import-btn .material-symbols-rounded { font-size: 18px; }

  .help-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin: 4px 0 0; }
  .help-list  { margin: 0; padding-left: 20px; font-size: 12px; color: var(--text-2); line-height: 1.6; }
  .help-list strong { color: var(--text-1); }

  .preview { display: flex; flex-direction: column; gap: 12px; }
  .preview-head { display: flex; align-items: center; justify-content: space-between; }
  .preview-title { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .preview-reset {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--surface-2); color: var(--text-3);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .preview-reset:hover { background: var(--surface-3); color: var(--text-1); }
  .preview-reset .material-symbols-rounded { font-size: 16px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat {
    display: flex; flex-direction: column; align-items: center;
    padding: 10px; border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .stat-num { font-size: 20px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .stat-sub { font-size: 12px; color: var(--text-3); font-weight: 600; }
  .stat-lbl { font-size: 11px; color: var(--text-3); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  .preview-range {
    font-size: 12px; color: var(--text-3); text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .warn-inline {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--warning, #FFB020) 12%, transparent);
    color: var(--text-2); font-size: 12px; line-height: 1.4;
  }
  .warn-inline .material-symbols-rounded { color: var(--warning, #FFB020); font-size: 18px; flex-shrink: 0; }

  .unmatched { font-size: 12px; }
  .unmatched summary { cursor: pointer; color: var(--text-2); font-weight: 600; padding: 6px 0; }
  .unmatched ul { list-style: none; padding: 4px 0; margin: 0; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .unmatched li { padding: 4px 10px; color: var(--text-2); border-bottom: 1px solid var(--border); }
  .unmatched li:last-child { border-bottom: none; }
  .unmatched-count { font-size: 10px; color: var(--text-3); margin-left: 6px; font-weight: 700; }
  .unmatched-hint { margin: 6px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }

  .preview-actions { display: flex; gap: 8px; }
  .preview-actions .btn { flex: 1; }

  .result-card {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .result-card.ok { background: color-mix(in srgb, var(--success, #2FD66F) 10%, var(--surface-2)); border: 1px solid color-mix(in srgb, var(--success, #2FD66F) 30%, transparent); }
  .result-title { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .result-sub { font-size: 12px; color: var(--text-3); }
</style>
