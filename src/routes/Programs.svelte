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
          <button class="program-card" class:is-active={p.is_active} on:click={() => push(`/programs/${p.id}`)}>

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

</style>
