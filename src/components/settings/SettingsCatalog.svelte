<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { LtApi } from '../../lib/api.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import ExerciseEditor from '../exercises/ExerciseEditor.svelte';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  let exerciseSources = [];
  let sourceBusy = {};
  let sourceKeys = {};

  async function loadExerciseSources() {
    try { exerciseSources = await LtApi.listExerciseSources(); }
    catch(e) { showError(e.message); }
  }
  loadExerciseSources();

  async function importSource(src) {
    if (src.requiresKey && !sourceKeys[src.id]) {
      showError(`${src.name} requires an API key`); return;
    }
    sourceBusy = { ...sourceBusy, [src.id]: 'import' };
    try {
      const r = await LtApi.importExerciseSource(src.id, sourceKeys[src.id]);
      showSuccess(`${src.name}: imported ${r.count}`);
      await loadExerciseSources();
    } catch(e) { showError(e.message); }
    sourceBusy = { ...sourceBusy, [src.id]: null };
  }

  // Pre-cache exercise media for offline use
  let precacheBusy = false;
  let precacheProgress = null;

  async function precacheMedia() {
    if (precacheBusy) return;
    precacheBusy = true;
    precacheProgress = { done: 0, total: 0 };
    try {
      const { urls } = await LtApi.listExerciseMediaUrls();
      precacheProgress = { done: 0, total: urls.length };
      const CONCURRENCY = 8;
      let idx = 0;
      async function worker() {
        while (idx < urls.length) {
          const myIdx = idx++;
          try { await fetch(urls[myIdx], { mode: 'no-cors', credentials: 'omit' }); } catch {}
          precacheProgress = { done: precacheProgress.done + 1, total: urls.length };
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      showSuccess(`Cached ${urls.length} exercise media files for offline use`);
    } catch(e) { showError(e.message); }
    precacheBusy = false;
    setTimeout(() => { precacheProgress = null; }, 3000);
  }

  async function clearSource(src) {
    if (!await confirmDialog({
      title: $_('settings_catalog.confirm.clear_imported_title'),
      message: $_('settings_catalog.confirm.clear_imported_msg', { values: { count: src.count, name: src.name } }),
      confirmText: $_('settings_catalog.confirm.clear_confirm'),
      dangerous: true,
    })) return;
    sourceBusy = { ...sourceBusy, [src.id]: 'clear' };
    try {
      const r = await LtApi.clearExerciseSource(src.id);
      showSuccess(`${src.name}: cleared ${r.removed} exercises`);
      await loadExerciseSources();
    } catch(e) { showError(e.message); }
    sourceBusy = { ...sourceBusy, [src.id]: null };
  }

  async function toggleSource(src) {
    const newEnabled = !src.enabled;
    try {
      await fetch('/api/exercises/sources/toggle', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src.id, enabled: newEnabled }),
      });
      await loadExerciseSources();
    } catch(e) { showError(e.message); }
  }

  // Custom catalog (JSON) state. Users can either paste raw JSON or pick
  // a .json file from disk. Catalog name + the array of exercises go to
  // POST /api/exercise-import/import-json, which inserts rows tagged
  // source='import:<name>'. The catalogs/* endpoints below manage the
  // resulting catalogs (toggle on/off in the picker, delete).
  let importedCatalogs = [];
  let customCatalogName = '';
  let customCatalogJson = '';
  let customCatalogFile;
  let customCatalogImporting = false;
  let customCatalogResult = null;
  let customCatalogError = '';

  async function loadImportedCatalogs() {
    try {
      importedCatalogs = await fetch('/api/exercise-import/catalogs', { credentials: 'include' }).then(r => r.json());
      importedCatalogs.sort((a, b) => a.name.localeCompare(b.name));
    } catch {}
  }

  async function _onCatalogFile(e) {
    const file = e.target?.files?.[0];
    e.target.value = '';
    if (!file) return;
    customCatalogError = '';
    try {
      customCatalogJson = await file.text();
      // If the user didn't name the catalog yet, default to the filename.
      if (!customCatalogName.trim()) {
        const base = file.name.replace(/\.json$/i, '').replace(/[_-]+/g, ' ').trim();
        if (base) customCatalogName = base;
      }
    } catch (err) {
      customCatalogError = `Could not read file: ${err?.message || err}`;
    }
  }

  function _parseCatalogJson(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error('Invalid JSON: ' + (e?.message || 'parse error')); }
    // Accept either { exercises: [...] } or a bare array.
    let list = Array.isArray(parsed) ? parsed : parsed?.exercises;
    if (!Array.isArray(list)) throw new Error('JSON must be an array of exercises, or { "exercises": [...] }');
    return list;
  }

  async function importCustomCatalog() {
    customCatalogError = '';
    customCatalogResult = null;
    const name = customCatalogName.trim();
    if (!name) { customCatalogError = 'Catalog name is required'; return; }
    if (!customCatalogJson.trim()) { customCatalogError = 'Paste JSON or pick a file first'; return; }
    let list;
    try { list = _parseCatalogJson(customCatalogJson); }
    catch (e) { customCatalogError = e.message; return; }
    if (!list.length) { customCatalogError = 'JSON contains no exercises'; return; }

    customCatalogImporting = true;
    try {
      const res = await fetch('/api/exercise-import/import-json', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogName: name, exercises: list }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Import failed (${res.status})`);
      customCatalogResult = data;
      showSuccess(`Imported ${data.count} exercises to "${data.catalogName}"`);
      customCatalogJson = ''; customCatalogName = '';
      await loadExerciseSources();
      await loadImportedCatalogs();
    } catch (e) {
      customCatalogError = e?.message || 'Import failed';
      showError(customCatalogError);
    } finally {
      customCatalogImporting = false;
    }
  }

  // ── My Exercises (user-created, source='custom') ──────────────────────────
  let customExercises = [];
  let editorOpen = false;
  let editorTarget = null;

  async function loadCustomExercises() {
    try {
      // Library endpoint returns seeded + own; filter to source='custom'.
      const all = await LtApi.getExercises();
      customExercises = all.filter(e => e.source === 'custom' && !e.is_global);
      customExercises.sort((a, b) => a.name.localeCompare(b.name));
    } catch {}
  }

  function openCreate() { editorTarget = null; editorOpen = true; }
  function openEdit(ex) { editorTarget = ex;   editorOpen = true; }

  async function removeCustom(ex) {
    if (!await confirmDialog({
      title: $_('settings_catalog.confirm.delete_named_title', { values: { name: ex.name } }),
      message: $_('settings_catalog.confirm.delete_exercise_msg'),
      confirmText: $_('common.delete'), dangerous: true,
    })) return;
    try {
      await LtApi.deleteExercise(ex.id);
      showSuccess($_('settings_catalog.deleted'));
      await loadCustomExercises();
    } catch(e) { showError(e.message); }
  }

  async function removeAllCustom() {
    if (customExercises.length === 0) return;
    if (!await confirmDialog({
      title: $_('settings_catalog.confirm.delete_all_title', { values: { count: customExercises.length } }),
      message: $_('settings_catalog.confirm.delete_all_msg'),
      confirmText: $_('settings_catalog.confirm.delete_all_confirm'), dangerous: true,
    })) return;
    try {
      const r = await LtApi.deleteAllCustomExercises();
      showSuccess(`Deleted ${r.removed} custom exercises`);
      await loadCustomExercises();
    } catch(e) { showError(e.message); }
  }

  $: if (expanded) { loadImportedCatalogs(); loadCustomExercises(); }

  async function toggleCatalog(cat) {
    const newEnabled = !cat.enabled;
    try {
      await fetch('/api/exercise-import/catalogs/toggle', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cat.name, enabled: newEnabled }),
      });
      await loadImportedCatalogs();
    } catch(e) { showError(e.message); }
  }

  async function deleteCatalog(cat) {
    if (!await confirmDialog({ title: $_('settings_catalog.confirm.delete_named_title', { values: { name: cat.name } }), message: $_('settings_catalog.confirm.delete_catalog_msg', { values: { count: cat.count } }), confirmText: $_('common.delete'), dangerous: true })) return;
    try {
      await fetch('/api/exercise-import/catalogs/delete', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cat.name }),
      });
      showSuccess(`Deleted "${cat.name}"`);
      await loadExerciseSources();
      await loadImportedCatalogs();
    } catch(e) { showError(e.message); }
  }
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">library_books</span></span>
    <span class="section-name">{$_('settings.catalog.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <div class="card">
        {#each exerciseSources as src (src.id)}
          <div class="src-row">
            <div class="src-info">
              <div class="src-head">
                <span class="src-name">{src.name}</span>
                {#if src.count > 0}<span class="src-count">{src.count}</span>{/if}
              </div>
              <div class="src-desc">{src.description}</div>
              {#if src.requiresKey}
                <input class="form-input-sm src-key" type="password" placeholder={$_('settings_catalog.rapidapi_key_ph')} bind:value={sourceKeys[src.id]} />
                <div class="src-byok-note">
                  Bring your own RapidAPI key. By enabling this source you confirm you have an
                  active subscription (free tier available) and accept RapidAPI's and the API
                  provider's terms. LiftTrace is not affiliated with RapidAPI or ExerciseDB and
                  has no relationship with either; you are the API consumer.
                </div>
              {/if}
            </div>
            <div class="src-actions" style="flex-direction:row;align-items:center;gap:8px">
              {#if src.count > 0}
                <Toggle checked={src.enabled} on:change={() => toggleSource(src)} />
              {/if}
              <button class="btn btn-secondary btn-sm" disabled={sourceBusy[src.id] === 'import'} on:click={() => importSource(src)}>
                {sourceBusy[src.id] === 'import' ? 'Importing\u2026' : (src.count > 0 ? 'Re-import' : 'Import')}
              </button>
              {#if src.count > 0}
                <button class="btn btn-secondary btn-sm src-clear" disabled={sourceBusy[src.id] === 'clear'} on:click={() => clearSource(src)}
                  title="Clear {src.count} imported exercises (source stays available to re-import)">
                  <span class="material-symbols-rounded" style="font-size:16px">delete_sweep</span>
                  {sourceBusy[src.id] === 'clear' ? 'Clearing\u2026' : 'Clear'}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- Offline media pre-cache -->
      <div class="card" style="margin-top:12px">
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_catalog.offline_library')}</span>
            <span class="setting-hint">Pre-download every exercise GIF / image to your device cache. Useful for gyms without signal or before going mobile. Re-run any time after importing a new source.</span>
          </div>
          {#if precacheProgress}
            <div class="precache-progress">
              <div class="pp-bar">
                <div class="pp-fill" style:width={`${precacheProgress.total > 0 ? Math.round(precacheProgress.done / precacheProgress.total * 100) : 0}%`}></div>
              </div>
              <span class="pp-text">{precacheProgress.done} / {precacheProgress.total}</span>
            </div>
          {/if}
          <button class="btn btn-secondary" style="height:36px;font-size:13px;align-self:flex-start" on:click={precacheMedia} disabled={precacheBusy}>
            <span class="material-symbols-rounded" style="font-size:16px">{precacheBusy ? 'downloading' : 'download_for_offline'}</span>
            {precacheBusy ? 'Caching\u2026' : 'Pre-cache media for offline'}
          </button>
        </div>
      </div>

      <p class="sub-label">{$_('settings_catalog.my_exercises')}</p>
      <div class="card">
        <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="font-size:12px;color:var(--text-3)">
            {customExercises.length} exercise{customExercises.length === 1 ? '' : 's'} you've created
          </div>
          <button class="btn btn-primary btn-sm" on:click={openCreate}>
            <span class="material-symbols-rounded" style="font-size:16px">add</span> Create
          </button>
        </div>
        {#if customExercises.length > 0}
          <div class="setting-divider"></div>
          {#each customExercises as ex (ex.id)}
            <div class="my-ex-row">
              {#if ex.img_url || ex.gif_url}
                <img class="my-ex-thumb" src={ex.gif_url || ex.img_url} alt="" />
              {:else if ex.video_url}
                <span class="my-ex-thumb-fallback material-symbols-rounded">play_circle</span>
              {:else}
                <span class="my-ex-thumb-fallback material-symbols-rounded">fitness_center</span>
              {/if}
              <div class="my-ex-info">
                <span class="my-ex-name">{ex.name}</span>
                <span class="my-ex-meta">
                  {ex.category || 'uncategorized'}{#if (ex.primary_muscles || []).length} · {(ex.primary_muscles || []).slice(0, 3).join(', ')}{/if}
                </span>
              </div>
              <button class="my-ex-btn" on:click={() => openEdit(ex)} title="Edit">
                <span class="material-symbols-rounded">edit</span>
              </button>
              <button class="my-ex-btn danger" on:click={() => removeCustom(ex)} title="Delete">
                <span class="material-symbols-rounded">delete</span>
              </button>
            </div>
          {/each}
          <div class="setting-divider"></div>
          <div style="padding:10px 16px">
            <button class="btn btn-secondary btn-sm" style="color:var(--danger);border-color:color-mix(in srgb, var(--danger) 30%, var(--border))" on:click={removeAllCustom}>
              <span class="material-symbols-rounded" style="font-size:16px">delete_sweep</span>
              Delete all my exercises
            </button>
          </div>
        {/if}
      </div>

      <p class="sub-label">{$_('settings_catalog.custom_catalog')}</p>
      <div class="card cc-card">
        <p class="cc-intro">
          Import your own exercises from JSON. Useful for sharing
          curated catalogs between users, migrating from another app,
          or pulling in data from a third-party source. Grab the
          starter template below, fill it in, and pick or paste it
          back in.
        </p>
        <div class="cc-template-row">
          <a class="btn btn-secondary cc-template-btn"
            href={resolveAssetUrl('/lifttrace-catalog-template.json')}
            download="lifttrace-catalog-template.json">
            <span class="material-symbols-rounded" style="font-size:16px">download</span>
            Download template
          </a>
        </div>
        <details class="cc-format">
          <summary>
            <span class="material-symbols-rounded cc-format-chev">expand_more</span>
            Expected JSON format
          </summary>
          <pre class="cc-format-example">{`{
  "exercises": [
    {
      "name": "Bench Press",
      "category": "chest",
      "primary_muscles": ["chest"],
      "secondary_muscles": ["triceps", "front-delts"],
      "equipment": ["barbell"],
      "instructions": "Lie on a flat bench, grip the bar…",
      "img_url": "https://…",
      "gif_url": "https://…",
      "video_url": "https://…"
    }
  ]
}`}</pre>
          <p class="cc-format-note">
            Only <code>name</code> is required. A bare array (no
            wrapper object) is also accepted.
          </p>
        </details>

        <label class="cc-field">
          <span class="cc-field-label">{$_('settings_catalog.catalog_name')}</span>
          <input class="form-input-sm cc-input" type="text" bind:value={customCatalogName}
            placeholder="e.g. My Exercises" maxlength="60" />
        </label>

        <label class="cc-field">
          <span class="cc-field-label">{$_('settings_catalog.json')}</span>
          <textarea class="form-input-sm cc-json" bind:value={customCatalogJson}
            placeholder={$_('settings_catalog.json_ph')}></textarea>
        </label>

        <div class="cc-actions">
          <label class="btn btn-secondary cc-file-btn">
            <span class="material-symbols-rounded" style="font-size:16px">upload_file</span>
            Pick JSON file
            <input type="file" accept=".json,application/json" style="display:none"
              bind:this={customCatalogFile} on:change={_onCatalogFile} />
          </label>
          {#if customCatalogJson}
            <button class="btn btn-secondary cc-clear-btn"
              on:click={() => { customCatalogJson = ''; customCatalogError = ''; customCatalogResult = null; }}>
              Clear
            </button>
          {/if}
          <div class="cc-actions-spacer"></div>
          <button class="btn btn-primary cc-import-btn"
            on:click={importCustomCatalog}
            disabled={customCatalogImporting || !customCatalogName.trim() || !customCatalogJson.trim()}>
            {#if customCatalogImporting}
              <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span>
              Importing…
            {:else}
              Import
            {/if}
          </button>
        </div>

        {#if customCatalogError}
          <p class="cc-error">{customCatalogError}</p>
        {/if}
        {#if customCatalogResult}
          <p class="cc-result">
            <span class="cc-result-count">{customCatalogResult.count}</span>
            imported to "{customCatalogResult.catalogName}"
            {#if customCatalogResult.duplicates > 0}, <span style="color:var(--warning)">{customCatalogResult.duplicates}</span> duplicates skipped{/if}
            {#if customCatalogResult.skipped > 0}, <span style="color:var(--text-3)">{customCatalogResult.skipped}</span> invalid rows skipped{/if}
          </p>
        {/if}
      </div>

      {#if importedCatalogs.length > 0}
        <p class="sub-label">{$_('settings_catalog.imported_catalogs')}</p>
        <div class="card">
          {#each importedCatalogs as cat (cat.id)}
            <div class="src-row">
              <div class="src-info">
                <div class="src-head">
                  <span class="src-name">{cat.name}</span>
                  <span class="src-count">{cat.count}</span>
                </div>
              </div>
              <div class="src-actions" style="flex-direction:row;align-items:center">
                <Toggle checked={cat.enabled} on:change={() => toggleCatalog(cat)} />
                <button class="btn-icon-danger" on:click={() => deleteCatalog(cat)} title="Delete catalog">
                  <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/if}

<ExerciseEditor bind:open={editorOpen} exercise={editorTarget} on:saved={loadCustomExercises} />

<style>
  .src-row { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .src-row:last-child { border-bottom: none; }
  .src-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .src-head { display: flex; align-items: center; gap: 8px; }
  .src-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .src-count {
    font-size: 11px; font-weight: 700; padding: 2px 8px;
    background: var(--accent-dim); color: var(--accent); border-radius: var(--radius-sm);
  }
  .src-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .src-key { margin-top: 6px; width: 100%; }
  .src-byok-note { margin-top: 6px; font-size: 10.5px; color: var(--text-3); line-height: 1.4; }
  .src-actions { display: flex; flex-direction: column; gap: 6px; }
  .src-clear {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--danger) !important;
    border-color: color-mix(in srgb, var(--danger) 30%, var(--border)) !important;
  }
  .src-clear:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface-2)) !important;
    border-color: var(--danger) !important;
  }
  .btn-icon-danger {
    background: none; border: none; cursor: pointer;
    color: var(--danger); padding: 0 4px;
    display: flex; align-items: center;
  }
  .btn-icon-danger:hover { opacity: 0.7; }

  .precache-progress { display: flex; align-items: center; gap: 10px; }
  .pp-bar { flex: 1; height: 6px; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .pp-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
    box-shadow: 0 0 8px var(--accent-dim);
  }
  .pp-text { font-size: 12px; font-weight: 600; color: var(--text-2); font-variant-numeric: tabular-nums; min-width: 80px; text-align: right; }

  .sub-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); padding: 20px 4px 8px; margin: 0; }

  /* Custom-catalog import form — single card with labeled fields, a
     collapsible JSON-format hint, and full-width inputs so it looks
     right at any breakpoint (the previous version had narrow inputs
     floating in a wide card with the JSON example dumped inline). */
  .cc-card {
    padding: 16px;
    display: flex; flex-direction: column;
    gap: 12px;
  }
  .cc-intro {
    margin: 0;
    font-size: 13px; line-height: 1.5;
    color: var(--text-2);
  }
  .cc-template-row { display: flex; }
  .cc-template-btn {
    height: 36px; font-size: 13px;
    display: inline-flex; align-items: center; gap: 6px;
    text-decoration: none;
    cursor: pointer;
  }
  .cc-format {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .cc-format > summary {
    list-style: none;
    cursor: pointer;
    padding: 8px 10px;
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600;
    color: var(--text-2);
    user-select: none;
  }
  .cc-format > summary::-webkit-details-marker { display: none; }
  .cc-format-chev {
    font-size: 16px;
    transition: transform var(--dur-fast);
  }
  .cc-format[open] .cc-format-chev { transform: rotate(0deg); }
  .cc-format:not([open]) .cc-format-chev { transform: rotate(-90deg); }
  .cc-format-example {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-2);
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    overflow-x: auto;
    white-space: pre;
  }
  .cc-format-note {
    margin: 0;
    padding: 8px 12px 10px;
    font-size: 11px; line-height: 1.5;
    color: var(--text-3);
    border-top: 1px solid var(--border);
  }
  .cc-format-note code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    padding: 1px 4px;
    background: var(--surface-1);
    border-radius: 3px;
  }
  .cc-field {
    display: flex; flex-direction: column; gap: 4px;
  }
  .cc-field-label {
    font-size: 11px; font-weight: 600;
    color: var(--text-3);
    letter-spacing: 0.02em;
  }
  .cc-input { width: 100%; }
  .cc-json {
    width: 100%;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    min-height: 140px;
    max-height: 360px;
    resize: vertical;
    line-height: 1.45;
    padding: 10px 12px;
  }
  .cc-actions {
    display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap;
  }
  .cc-actions-spacer { flex: 1; }
  .cc-file-btn, .cc-clear-btn, .cc-import-btn {
    height: 36px; font-size: 13px;
    display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer;
  }
  .cc-clear-btn { color: var(--text-3); }
  .cc-error {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    color: var(--danger, #ef4444);
    background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
    border-radius: var(--radius-sm);
  }
  .cc-result {
    margin: 0;
    font-size: 12px;
    color: var(--text-2);
  }
  .cc-result-count { color: var(--success); font-weight: 600; }

  /* My Exercises rows */
  .my-ex-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
  }
  .my-ex-row:last-child { border-bottom: none; }
  .my-ex-thumb {
    width: 40px; height: 40px; border-radius: var(--radius-sm);
    object-fit: cover; flex-shrink: 0;
    background: var(--surface-2);
  }
  .my-ex-thumb-fallback {
    width: 40px; height: 40px; border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    background: var(--surface-2); color: var(--text-3);
    font-size: 20px; flex-shrink: 0;
  }
  .my-ex-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .my-ex-name {
    font-size: 14px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .my-ex-meta {
    font-size: 11px; color: var(--text-3); text-transform: capitalize;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .my-ex-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 6px; border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .my-ex-btn:hover { background: var(--surface-2); color: var(--text-1); }
  .my-ex-btn.danger:hover { background: rgba(255,92,92,0.1); color: var(--danger); }
  .my-ex-btn .material-symbols-rounded { font-size: 18px; }

  .setting-desc { font-size: 12px; color: var(--text-3); padding: 0 16px; }
</style>
