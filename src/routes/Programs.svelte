<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { GOALS } from '../lib/workout.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import CoachTabs from '../components/layout/CoachTabs.svelte';
  import { pageBanners, bannerStyle } from '../stores/settings.js';

  let programs = [];
  let loading = true;

  // New program form
  let showCreate = false;
  let newName = '';
  let newGoal = 'general';
  let newDurationWeeks = 1;
  let creating = false;

  // Re-fetch when a background sync brings updates (native+server mode).
  let _onSyncComplete = null;
  onMount(() => {
    load();
    if (isNative && getServerUrl()) {
      _onSyncComplete = () => { load(); };
      window.addEventListener('lt:sync-complete', _onSyncComplete);
    }
  });
  onDestroy(() => {
    if (_onSyncComplete) window.removeEventListener('lt:sync-complete', _onSyncComplete);
  });

  async function load() {
    loading = true;
    try { programs = await LtApi.getPrograms(); }
    catch(e) { showError(e.message); }
    loading = false;
  }

  async function createProgram() {
    if (!newName.trim() || creating) return;
    creating = true;
    try {
      const p = await LtApi.createProgram({ name: newName.trim(), goal: newGoal, duration_weeks: newDurationWeeks });
      showCreate = false;
      newName = '';
      newGoal = 'general';
      newDurationWeeks = 1;
      push(`/programs/${p.id}`);
    } catch(e) { showError(e.message); }
    creating = false;
  }

  async function deleteProgram(e, id) {
    e.stopPropagation();
    if (!await confirmDialog({ title: $_('programs.delete_title'), message: $_('programs.delete_message'), confirmText: $_('programs.delete_confirm'), dangerous: true })) return;
    try {
      await LtApi.deleteProgram(id);
      showSuccess($_('programs.toast_deleted'));
      await load();
    } catch(err) { showError(err.message); }
  }

  // Wide-mode gate — same pattern the picker + exercises route use.
  // At >=1280px on non-forced-mobile viewports, tapping a program card
  // loads its templates into an inline preview pane instead of
  // route-pushing to /programs/:id — the "compare programs before
  // committing" flow becomes one glance instead of an in-and-out.
  let _wideMode = false;
  let _wideMq;
  function _syncWide() {
    if (typeof document === 'undefined') return;
    _wideMode = !!_wideMq?.matches
      && !document.documentElement.classList.contains('force-mobile-layout');
  }
  if (typeof window !== 'undefined') {
    _wideMq = window.matchMedia('(min-width: 1280px)');
    _syncWide();
    _wideMq.addEventListener?.('change', _syncWide);
  }
  // Svelte allows multiple onDestroy() registrations — they run in
  // reverse order — so this second call composes cleanly with the
  // sync-listener cleanup above.
  onDestroy(() => { _wideMq?.removeEventListener?.('change', _syncWide); });

  // Inline preview pane state — mirrors the Exercises route detail
  // pane so the two library surfaces feel like one system.
  let _previewSelected = null;   // full program object with templates[]
  let _previewLoading = false;
  async function _loadPreview(program) {
    _previewSelected = program;  // show the card metadata immediately
    _previewLoading = true;
    try {
      const full = await LtApi.getProgram(program.id);
      // Only update if the user hasn't tapped another card mid-fetch.
      if (_previewSelected?.id === program.id) _previewSelected = full;
    } catch (e) {
      showError(e.message || 'Failed to load program');
    }
    _previewLoading = false;
  }
  function _openProgram(p) {
    if (_wideMode) _loadPreview(p);
    else push(`/programs/${p.id}`);
  }
</script>

<div class="page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.programs.title')}</h1>
    <div class="header-actions">
      <button class="btn-primary-sm" on:click={() => showCreate = true}>
        <span class="material-symbols-rounded">add</span>
        New
      </button>
    </div>
  </header>

  <CoachTabs />

  <div class="content">
    <!-- Body wrapper — at wide widths becomes a 2-col grid holding
         the tile-grid program list on the left and the inline
         preview pane on the right. On mobile this is a plain block. -->
    <div class="programs-body">
    {#if loading}
      <div class="loading">Loading programs...</div>
    {:else if programs.length === 0}
      <div class="empty">
        <span class="material-symbols-rounded">calendar_month</span>
        <h3>{$_('programs.empty_title')}</h3>
        <p>Create a training program to organize your workout templates.</p>
        <button class="btn btn-primary" on:click={() => showCreate = true}>{$_('programs.create_program')}</button>
      </div>
    {:else}
      <div class="program-list">
        {#each programs as p}
          <button class="program-card"
                  class:is-active={p.is_active}
                  class:selected-for-preview={_wideMode && _previewSelected?.id === p.id}
                  on:click={() => _openProgram(p)}>

            <div class="card-top">
              <span class="program-name">{p.name}</span>
              {#if p.is_active}
                <span class="active-badge">{$_('programs.active')}</span>
              {/if}
            </div>
            <div class="card-meta">
              <span class="goal-tag">{p.goal}</span>
              <span class="template-count">{p.template_count} workouts</span>
              {#if p.is_assigned && p.assigned_by_name}
                <span class="coach-badge" title="Assigned by your coach">
                  <span class="material-symbols-rounded" style="font-size:12px">supervisor_account</span>
                  Coach: {p.assigned_by_name}
                </span>
              {/if}
            </div>

            <!-- Progress chip for the active program — week-since-assign +
                 sessions logged from this program. Skips when both are 0
                 (just-assigned, never run). The template preview pills
                 lived here previously but were dropped: users already
                 know what's in their own programs and the cards were
                 getting too tall. Program detail page has the full list. -->
            {#if p.is_active && (p.weeks_active > 0 || p.sessions_in_program > 0)}
              <div class="card-progress">
                {#if p.duration_weeks > 1 && p.current_week}
                  <span class="progress-stat">Week {p.current_week} of {p.duration_weeks}</span>
                {:else if p.weeks_active > 0}
                  <span class="progress-stat">Week {p.weeks_active}</span>
                {/if}
                {#if p.sessions_in_program > 0}
                  <span class="progress-sep">·</span>
                  <span class="progress-stat">{p.sessions_in_program} {p.sessions_in_program === 1 ? 'session' : 'sessions'}</span>
                {/if}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    </div>

    <!-- Inline preview pane — visible only at wide widths (CSS-gated).
         Shows the tapped program's day-by-day template list so a
         lifter comparing programs can see the structure without
         route-pushing into each one. "Full details" button jumps to
         the standalone ProgramDetail route for editing / assign /
         duration controls. Prompts on empty state. -->
    <aside class="programs-preview-pane">
      {#if _previewSelected}
        {@const p = _previewSelected}
        <div class="ppp-head">
          <div class="ppp-title-block">
            <h3 class="ppp-title">{p.name}</h3>
            <div class="ppp-meta">
              <span class="goal-tag">{p.goal}</span>
              {#if p.duration_weeks && p.duration_weeks > 1}
                <span class="ppp-meta-item">{p.duration_weeks} weeks</span>
              {/if}
              {#if p.is_active}
                <span class="active-badge">{$_('programs.active')}</span>
              {/if}
            </div>
          </div>
          <button class="ppp-close" on:click={() => { _previewSelected = null; }}
                  aria-label="Close preview" title="Close preview">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        {#if p.description}
          <p class="ppp-desc">{p.description}</p>
        {/if}
        <div class="ppp-templates-head">Workouts</div>
        {#if _previewLoading && !p.templates}
          <div class="ppp-loading">Loading…</div>
        {:else if !p.templates || p.templates.length === 0}
          <div class="ppp-empty-templates">No workouts yet in this program.</div>
        {:else}
          <ol class="ppp-templates">
            {#each p.templates as t, i}
              <li class="ppp-template">
                <span class="ppp-template-num">{i + 1}</span>
                <div class="ppp-template-body">
                  <span class="ppp-template-name">{t.name || `Day ${i + 1}`}</span>
                  {#if t.exercises && t.exercises.length}
                    <span class="ppp-template-meta">{t.exercises.length} {t.exercises.length === 1 ? 'exercise' : 'exercises'}</span>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
        {/if}
        <button class="btn btn-primary ppp-full-btn" on:click={() => push(`/programs/${p.id}`)}>
          <span class="material-symbols-rounded">open_in_new</span>
          Full details
        </button>
      {:else}
        <div class="ppp-empty">
          <span class="material-symbols-rounded ppp-empty-icon">calendar_month</span>
          <p class="ppp-empty-title">Preview any program</p>
          <p class="ppp-empty-desc">Tap any card to see its day-by-day workout structure here without opening it.</p>
        </div>
      {/if}
    </aside>
  </div>
</div>

<!-- New Program Sheet -->
<Sheet open={showCreate} on:close={() => showCreate = false}>
  <div class="form-sheet">
    <h3 class="form-title">{$_('programs.new_program')}</h3>
    <div class="form-group">
      <label class="form-label">{$_('programs.name')}</label>
      <input class="form-input" type="text" bind:value={newName} placeholder="e.g. Cutting 2026" autofocus
        on:keydown={e => e.key === 'Enter' && createProgram()} />
    </div>
    <div class="form-group">
      <label class="form-label">{$_('programs.goal')}</label>
      <select class="form-select" bind:value={newGoal}>
        {#each GOALS as g}<option value={g.id}>{g.label}</option>{/each}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Duration (weeks)</label>
      <input class="form-input" type="number" min="1" max="52" bind:value={newDurationWeeks}
        placeholder="1" />
      <p class="form-hint">Weeks in this training block. More than 1 enables per-week progression (different sets/reps/tempo/rest each week).</p>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showCreate = false}>{$_('programs.cancel')}</button>
      <button class="btn btn-primary" on:click={createProgram} disabled={creating || !newName.trim()}>
        {creating ? 'Creating...' : 'Create'}
      </button>
    </div>
  </div>
</Sheet>


<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  /* page-header styled globally in base.css */
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .btn-icon { background: none; border: none; cursor: pointer; color: var(--text-2); padding: 6px; border-radius: var(--radius-sm); display: flex; }
  .btn-icon:hover { background: var(--surface-2); }
  .btn-primary-sm {
    display: flex; align-items: center; gap: 4px;
    padding: 8px 14px; font-size: 13px; font-weight: 600;
    background: var(--accent); color: var(--accent-text);
    border: none; border-radius: var(--radius-md); cursor: pointer;
  }
  .btn-primary-sm .material-symbols-rounded { font-size: 18px; }

  .content { padding: 16px var(--page-px); }

  .program-list { display: flex; flex-direction: column; gap: 10px; }
  .program-card {
    display: flex; flex-direction: column; gap: 8px;
    padding: 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer; width: 100%; text-align: left;
    transition: all var(--dur-fast);
  }
  .program-card:hover { background: var(--surface-2); }
  .program-card:active { transform: scale(0.98); }
  .card-top { display: flex; align-items: center; justify-content: space-between; }
  .program-name { font-size: 16px; font-weight: 700; color: var(--text-1); }
  .active-badge {
    padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 700; text-transform: uppercase;
  }
  .card-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .coach-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 600;
  }
  .goal-tag {
    padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-2); font-size: 12px; color: var(--text-2); text-transform: capitalize;
  }
  .template-count { font-size: 12px; color: var(--text-3); }
  .program-card.is-active {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--accent) 3%, var(--surface-1));
  }

  /* Active-program progress chip — Week 3 · 12 sessions */
  .card-progress {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; color: var(--accent);
    margin-top: 2px;
  }
  .progress-sep { color: var(--text-3); font-weight: 500; }

  .empty { text-align: center; padding: 48px 24px; color: var(--text-3); }
  .empty .material-symbols-rounded { font-size: 48px; display: block; margin-bottom: 12px; color: var(--text-3); }
  .empty h3 { font-size: 20px; color: var(--text-2); margin: 0 0 8px; }
  .empty p { margin: 0 0 16px; font-size: 14px; }

  .loading { text-align: center; padding: 48px; color: var(--text-3); }

  /* Form sheet styles */
  .form-sheet { padding: 4px 0 8px; }
  .form-title { font-size: 20px; font-weight: 700; color: var(--text-1); margin: 0 0 20px; }
  .form-group { margin-bottom: 16px; }
  .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .form-input, .form-select {
    width: 100%; padding: 12px 14px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); color: var(--text-1);
    font-size: 15px; font-family: inherit; outline: none;
  }
  .form-input:focus, .form-select:focus { border-color: var(--accent); }
  .form-hint { margin: 6px 0 0; font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .form-actions { display: flex; gap: 10px; margin-top: 24px; }
  .form-actions button { flex: 1; padding: 13px; font-size: 15px; }

  /* Mobile default — preview pane hidden. Programs body flows as a
     plain block so the existing single-column card list is unchanged
     on phones and force-mobile-layout viewports. */
  .programs-preview-pane { display: none; }

  /* ────────────────────────────────────────────────────────────
     Wide-layout Programs library. Same shape idiom as Exercises:
       - .content becomes a 2-col grid — the tile-grid card wall on
         the left, sticky inline preview pane on the right.
       - .program-list flips from a vertical stack to a tile grid
         (auto-fill / minmax 320px) so a lifter comparing programs
         sees the whole library at once.
       - Tapping a card loads the program's templates into the
         preview pane instead of route-pushing — one glance vs.
         open/back/open/back.
     Gated by html:not(.force-mobile-layout) so the desktop opt-out
     toggle in Settings still delivers the phone-shaped list at
     any width. */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 24px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .content > .programs-body {
      min-width: 0;
    }
    :global(html:not(.force-mobile-layout)) .content > .programs-body > .program-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }
    /* Selected card carries an accent border so the user tracks
       which program the preview pane is showing. */
    :global(html:not(.force-mobile-layout)) .content > .programs-body :global(.program-card.selected-for-preview) {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    /* Preview pane — sticky in the right column. Same surface
       tokens as the rest of the library preview panes. */
    :global(html:not(.force-mobile-layout)) .content > .programs-preview-pane {
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px;
      position: sticky;
      top: calc(var(--page-top, var(--safe-top)) + 130px + var(--hamburger-row, 0px));
      align-self: start;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - 150px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    .ppp-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .ppp-title-block { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .ppp-title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: var(--text-1);
      line-height: 1.25;
    }
    .ppp-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .ppp-meta-item {
      font-size: 11px;
      color: var(--text-3);
      padding: 2px 8px;
      background: var(--surface-2);
      border-radius: var(--radius-full);
    }
    .ppp-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-3);
      cursor: pointer;
      transition: background var(--dur-fast), color var(--dur-fast);
      flex-shrink: 0;
    }
    .ppp-close:hover { background: var(--surface-2); color: var(--text-1); }
    .ppp-close .material-symbols-rounded { font-size: 18px; }
    .ppp-desc {
      margin: 0;
      font-size: 12px;
      color: var(--text-3);
      line-height: 1.5;
    }
    .ppp-templates-head {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-3);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 4px;
    }
    .ppp-templates {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ppp-template {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
    }
    .ppp-template-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--accent-dim);
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .ppp-template-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .ppp-template-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ppp-template-meta { font-size: 11px; color: var(--text-3); }
    .ppp-full-btn {
      width: 100%;
      padding: 8px 12px;
      justify-content: center;
      margin-top: 6px;
    }
    .ppp-full-btn .material-symbols-rounded { font-size: 18px; }
    .ppp-loading,
    .ppp-empty-templates {
      font-size: 12px;
      color: var(--text-3);
      font-style: italic;
      padding: 8px 2px;
    }
    .ppp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 6px;
      padding: 40px 16px;
      color: var(--text-3);
    }
    .ppp-empty-icon { font-size: 32px; opacity: 0.6; }
    .ppp-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
    .ppp-empty-desc { margin: 0; font-size: 12px; line-height: 1.5; max-width: 260px; }
  }
</style>
