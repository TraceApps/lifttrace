<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { currentUser } from '../stores/auth.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';

  export let params = {};

  let program = null;
  let loading = true;

  // Add template form
  let showAddTemplate = false;
  let newTemplateName = '';
  let creating = false;

  // Program settings sheet — duration + progression mode (issue #13)
  let showSettings = false;
  let settingsDuration = 1;
  let settingsAdvance = 'sessions';
  let settingsOnComplete = 'hold';
  let savingSettings = false;
  function openSettings() {
    settingsDuration = program?.duration_weeks || 1;
    settingsAdvance = program?.advance_mode || 'sessions';
    settingsOnComplete = program?.on_complete || 'hold';
    showSettings = true;
  }
  async function saveSettings() {
    if (savingSettings) return;
    savingSettings = true;
    try {
      const dw = Math.min(52, Math.max(1, parseInt(settingsDuration) || 1));
      const updated = await LtApi.updateProgram(params.id, {
        duration_weeks: dw, advance_mode: settingsAdvance, on_complete: settingsOnComplete,
      });
      program = updated?.id ? { ...program, ...updated } : { ...program, duration_weeks: dw, advance_mode: settingsAdvance, on_complete: settingsOnComplete };
      showSettings = false;
      showSuccess($_('program_detail.toast.settings_saved'));
    } catch(e) { showError(e.message); }
    savingSettings = false;
  }

  // Assign-to-member sheet (trainer/admin)
  let showAssign = false;
  let assignMembers = [];
  let assigning = false;
  $: isCoach = $currentUser?.role === 'trainer' || $currentUser?.role === 'admin';
  $: isOwner = $currentUser && program && program.created_by === $currentUser.id;

  async function openAssign() {
    try { assignMembers = await LtApi.getMyMembers(); }
    catch(e) { showError(e.message); assignMembers = []; }
    showAssign = true;
  }

  async function assignTo(memberId) {
    if (assigning) return;
    assigning = true;
    try {
      await LtApi.assignProgram(params.id, { user_id: memberId });
      const m = assignMembers.find(x => x.id === memberId);
      showSuccess($_('program_detail.toast.assigned_to', { values: { name: m?.full_name || m?.username || $_('program_detail.toast.member_fallback') } }));
      showAssign = false;
    } catch(e) { showError(e.message); }
    assigning = false;
  }

  const SCROLL_KEY = `pd_scroll_${params.id}`;

  onMount(async () => {
    await load();
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      sessionStorage.removeItem(SCROLL_KEY);
      requestAnimationFrame(() => window.scrollTo({ top: parseInt(saved, 10), behavior: 'instant' }));
    }
  });

  async function load() {
    loading = true;
    try { program = await LtApi.getProgram(params.id); }
    catch(e) { showError(e.message); }
    loading = false;
  }

  function openTemplate(templateId) {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    push(`/programs/${params.id}/template/${templateId}`);
  }

  // Wide-mode gate — same pattern the picker / exercises / programs
  // list use. At >=1280px on non-forced-mobile viewports, tapping a
  // template card previews its exercises in the right pane instead
  // of route-pushing to the workout editor. Editing / adding sets
  // still routes through the pane's "Edit" button.
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
  onDestroy(() => { _wideMq?.removeEventListener?.('change', _syncWide); });

  let _previewTemplateId = null;
  $: _previewTemplate = program?.templates?.find(t => t.id === _previewTemplateId) || null;
  // Auto-pick the first template as the initial preview on wide once
  // the program loads, so the pane never sits empty on land.
  $: if (_wideMode && !_previewTemplateId && program?.templates?.length) {
    _previewTemplateId = program.templates[0].id;
  }
  function _tapTemplate(t) {
    if (_wideMode) _previewTemplateId = t.id;
    else openTemplate(t.id);
  }

  async function activate() {
    try {
      await LtApi.setActiveProgram(params.id);
      showSuccess($_('program_detail.toast.set_active'));
      await load();
    } catch(e) { showError(e.message); }
  }

  async function deactivate() {
    try {
      await LtApi.deactivateProgram();
      showSuccess($_('program_detail.toast.deactivated'));
      await load();
    } catch(e) { showError(e.message); }
  }

  async function addTemplate() {
    if (!newTemplateName.trim() || creating) return;
    creating = true;
    try {
      await LtApi.createTemplate({ program_id: parseInt(params.id), name: newTemplateName.trim() });
      showAddTemplate = false;
      newTemplateName = '';
      showSuccess($_('program_detail.toast.workout_added'));
      await load();
    } catch(e) { showError(e.message); }
    creating = false;
  }

  async function deleteTemplate(e, id) {
    e.stopPropagation();
    if (!await confirmDialog({ title: $_('program_detail.confirm.delete_workout_title'), message: $_('program_detail.confirm.delete_workout_msg'), confirmText: $_('common.delete'), dangerous: true })) return;
    try {
      await LtApi.deleteTemplate(id);
      showSuccess($_('program_detail.toast.workout_deleted'));
      await load();
    } catch(e) { showError(e.message); }
  }

  async function deleteProgram() {
    if (!await confirmDialog({ title: $_('program_detail.confirm.delete_program_title'), message: $_('program_detail.confirm.delete_program_msg'), confirmText: $_('common.delete'), dangerous: true })) return;
    try {
      await LtApi.deleteProgram(params.id);
      showSuccess($_('program_detail.toast.program_deleted'));
      push('/programs');
    } catch(e) { showError(e.message); }
  }

  // ── Drag-to-reorder templates (desktop HTML5 drag) ─────────────
  let draggedTplIdx = -1;
  let dragOverTplIdx = -1;

  function onTplDragStart(e, i) {
    draggedTplIdx = i;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch {}
  }
  function onTplDragOver(e, i) {
    if (draggedTplIdx < 0 || draggedTplIdx === i) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    dragOverTplIdx = i;
  }
  function onTplDragEnd() { draggedTplIdx = -1; dragOverTplIdx = -1; }
  async function onTplDrop(e, i) {
    e.preventDefault();
    const from = draggedTplIdx;
    draggedTplIdx = -1; dragOverTplIdx = -1;
    if (from < 0 || from === i || !program?.templates) return;
    const tpls = [...program.templates];
    const [moved] = tpls.splice(from, 1);
    tpls.splice(i, 0, moved);
    // Optimistic local update so the UI feels responsive
    program.templates = tpls;
    try {
      await LtApi.reorderTemplates(params.id, tpls.map(t => t.id));
    } catch(e) {
      showError(e.message);
      await load();
    }
  }

  /** Build a non-colliding "(Copy)" name for a duplicate.
   *  Strips any trailing `(Copy)` / `(Copy 2)` etc. from the source name so
   *  duplicating a duplicate doesn't chain suffixes ("X (Copy) (Copy)").
   *  Then picks the lowest unused `(Copy)` / `(Copy N)` given the current
   *  program library, so bulk-duplicating a base program produces
   *  `X (Copy)`, `X (Copy 2)`, `X (Copy 3)`, etc. */
  function _nextCopyName(sourceName, existingNames) {
    const base = String(sourceName || '').replace(/\s*\(Copy(?:\s+\d+)?\)\s*$/, '').trim() || 'Program';
    const taken = new Set(existingNames);
    if (!taken.has(`${base} (Copy)`)) return `${base} (Copy)`;
    let n = 2;
    while (taken.has(`${base} (Copy ${n})`)) n++;
    return `${base} (Copy ${n})`;
  }

  async function duplicateProgram() {
    try {
      // Fetch the library so the new name doesn't collide.
      let existingNames = [];
      try { existingNames = (await LtApi.getPrograms()).map(p => p.name); } catch {}
      const p = await LtApi.createProgram({
        name: _nextCopyName(program.name, existingNames),
        description: program.description,
        goal: program.goal,
        duration_weeks: program.duration_weeks,
        advance_mode: program.advance_mode,
        on_complete: program.on_complete,
      });
      // Copy all templates
      for (const t of program.templates || []) {
        await LtApi.createTemplate({
          program_id: p.id,
          name: t.name,
          day_label: t.day_label,
          exercises: t.exercises,
        });
      }
      showSuccess($_('program_detail.toast.duplicated'));
      push(`/programs/${p.id}`);
    } catch(e) { showError(e.message); }
  }

  // ── Rename ───────────────────────────────────────────────────────────
  // Menu-triggered (not tap-title): keeps the title unclickable so a
  // stray thumb near the header doesn't accidentally open an editor.
  // Once triggered, the H1 flips to an inline input so the edit still
  // happens in-place; commit on blur / Enter, revert on Escape.
  let editingName = false;
  let nameInput = '';
  let nameEl;
  let savingName = false;
  function startRename() {
    if (!isOwner) return;
    nameInput = program?.name || '';
    editingName = true;
    requestAnimationFrame(() => { nameEl?.focus(); nameEl?.select?.(); });
  }
  async function commitRename() {
    if (!editingName || savingName) return;
    const next = nameInput.trim();
    if (!next || next === program.name) { editingName = false; return; }
    savingName = true;
    try {
      const updated = await LtApi.updateProgram(params.id, { name: next });
      program = updated?.id ? { ...program, ...updated } : { ...program, name: next };
      showSuccess('Program renamed');
    } catch(e) {
      showError(e.message || 'Rename failed');
    }
    savingName = false;
    editingName = false;
  }
  function onNameKey(e) {
    if (e.key === 'Enter')   { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape')  { e.preventDefault(); editingName = false; }
  }

  // ── Overflow menu ────────────────────────────────────────────────────
  // Single ⋮ button in the header opens an ActionSheet with every
  // program-level action, gated by role/ownership. Replaces the earlier
  // row of individual icon buttons (Assign / Duplicate / Delete) so
  // adding future actions doesn't keep widening the header.
  let programMenuOpen = false;
  $: programMenuActions = (() => {
    const items = [];
    if (isOwner)                items.push({ label: 'Rename',           icon: 'edit',           value: 'rename' });
    if (isOwner)                items.push({ label: 'Duration & progression', icon: 'tune',     value: 'settings' });
    /* Duplicate is available to anyone viewing the program (matches
       the previous unconditional Duplicate icon behaviour). */
                                items.push({ label: 'Duplicate',        icon: 'content_copy',   value: 'duplicate' });
    if (isCoach && isOwner)     items.push({ label: 'Assign to Member', icon: 'person_add',     value: 'assign' });
    if (isOwner)                items.push({ label: 'Delete Program',   icon: 'delete',         value: 'delete',    danger: true });
    return items;
  })();
  function onProgramMenuSelect(e) {
    const v = e.detail?.value;
    if      (v === 'rename')    startRename();
    else if (v === 'settings')  openSettings();
    else if (v === 'duplicate') duplicateProgram();
    else if (v === 'assign')    openAssign();
    else if (v === 'delete')    deleteProgram();
  }
</script>

<div class="page">
  <header class="page-header">
    <button class="back-btn" on:click={() => push('/programs')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    {#if editingName}
      <input
        class="name-input"
        type="text"
        bind:this={nameEl}
        bind:value={nameInput}
        on:blur={commitRename}
        on:keydown={onNameKey}
        disabled={savingName}
        maxlength="120"
        aria-label="Program name"
      />
    {:else}
      <h1>{program?.name || 'Program'}</h1>
    {/if}
    <div class="header-actions">
      {#if programMenuActions.length}
        <button class="btn-icon" on:click={() => programMenuOpen = true} title="Program actions" aria-label="Program actions" aria-haspopup="menu">
          <span class="material-symbols-rounded">more_vert</span>
        </button>
      {/if}
    </div>
  </header>

  <ActionSheet
    bind:open={programMenuOpen}
    title={program?.name || 'Program'}
    actions={programMenuActions}
    on:select={onProgramMenuSelect}
  />

  {#if loading}
    <Spinner block label="Loading program…" />
  {:else if program}
    <div class="content">
      <!-- Info bar -->
      <div class="info-bar">
        <span class="goal-tag">{program.goal}</span>
        <span class="template-count">{program.templates?.length || 0} workouts</span>
        {#if program.duration_weeks > 1}
          <span class="goal-tag">
            {program.is_active && program.current_week ? `Week ${program.current_week} of ${program.duration_weeks}` : `${program.duration_weeks} weeks`}
          </span>
        {/if}
        {#if program.is_active}
          <button class="active-badge" on:click={deactivate} title="Tap to Deactivate">
            <span class="material-symbols-rounded" style="font-size:14px">check_circle</span>
            Active
          </button>
        {:else}
          <button class="activate-btn" on:click={activate}>
            <span class="material-symbols-rounded" style="font-size:16px">play_arrow</span>
            Set Active
          </button>
        {/if}
      </div>

      {#if program.description}
        <p class="description">{program.description}</p>
      {/if}

      <!-- Workout Templates -->
      <div class="section">
        <div class="section-header">
          <h3 class="section-title">{$_('program_detail.workouts')}</h3>
          <button class="btn-primary-sm" on:click={() => showAddTemplate = true}>
            <span class="material-symbols-rounded">add</span>
            Add
          </button>
        </div>

        <!-- .pd-body — plain block on mobile; at >=1280px becomes a
             2-col grid so the template list sits alongside an inline
             exercise-preview pane on the right. -->
        <div class="pd-body">

        {#if program.templates?.length}
          <div class="template-list">
            {#each program.templates as t, idx (t.id)}
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div class="tpl-drag"
                class:dragging={draggedTplIdx === idx}
                class:drag-over={dragOverTplIdx === idx && draggedTplIdx !== idx}
                draggable="true"
                on:dragstart={e => onTplDragStart(e, idx)}
                on:dragover={e => onTplDragOver(e, idx)}
                on:drop={e => onTplDrop(e, idx)}
                on:dragend={onTplDragEnd}
              >
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div class="template-card"
                     class:selected-for-preview={_wideMode && _previewTemplateId === t.id}
                     on:click={() => _tapTemplate(t)}
                     role="button"
                     tabindex="0">
                  <div class="tpl-left">
                    <span class="material-symbols-rounded tpl-drag-handle" title="Drag to reorder">drag_indicator</span>
                    <span class="tpl-num">{idx + 1}</span>
                    <div class="tpl-info">
                      <span class="tpl-name">{t.name}</span>
                      <span class="tpl-meta">{(t.exercises || []).length} exercises</span>
                    </div>
                  </div>
                  <div class="tpl-right">
                    <button class="btn-icon-sm" on:click={e => deleteTemplate(e, t.id)} title="Delete">
                      <span class="material-symbols-rounded">close</span>
                    </button>
                    <span class="material-symbols-rounded tpl-arrow">chevron_right</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-templates">
            <span class="material-symbols-rounded">playlist_add</span>
            <p>No workouts in this program yet.</p>
            <button class="btn-primary-sm" on:click={() => showAddTemplate = true}>{$_('program_detail.add_workout')}</button>
          </div>
        {/if}

        <!-- Inline template exercise-preview pane — visible only at
             wide widths (CSS-gated). Shows the selected template's
             exercises so a lifter can see what's in each day
             without route-pushing into the WorkoutEditor. "Edit"
             still opens the full editor for changing sets/reps. -->
        <aside class="pd-template-pane">
          {#if _previewTemplate}
            {@const t = _previewTemplate}
            <div class="ptp-head">
              <div class="ptp-title-block">
                <h3 class="ptp-title">{t.name}</h3>
                <span class="ptp-meta">{(t.exercises || []).length} {(t.exercises || []).length === 1 ? 'exercise' : 'exercises'}</span>
              </div>
            </div>
            {#if !(t.exercises || []).length}
              <div class="ptp-empty-body">This workout has no exercises yet.</div>
            {:else}
              <ol class="ptp-exercises">
                {#each t.exercises as ex, i (ex.id || i)}
                  <li class="ptp-exercise">
                    <span class="ptp-ex-num">{i + 1}</span>
                    <div class="ptp-ex-body">
                      <span class="ptp-ex-name">{ex.name || ex.exercise_name || 'Exercise'}</span>
                      {#if ex.target_sets || ex.target_reps || ex.target_weight}
                        <span class="ptp-ex-spec">
                          {#if ex.target_sets}{ex.target_sets} × {/if}{#if ex.target_reps}{ex.target_reps}{/if}{#if ex.target_weight}{' @ '}{ex.target_weight}{/if}
                        </span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
            <button class="btn btn-primary ptp-edit-btn" on:click={() => openTemplate(t.id)}>
              <span class="material-symbols-rounded">edit</span>
              Edit workout
            </button>
          {:else}
            <div class="ptp-empty">
              <span class="material-symbols-rounded ptp-empty-icon">list_alt</span>
              <p class="ptp-empty-title">Select a workout</p>
              <p class="ptp-empty-desc">Tap any workout on the left to see its exercises here.</p>
            </div>
          {/if}
        </aside>

        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Assign to Member Sheet -->
<Sheet open={showAssign} on:close={() => showAssign = false} title="Assign to Member">
  <div class="assign-sheet">
    {#if assignMembers.length === 0}
      <div class="empty-inline">
        <p>You don't have any members assigned yet.</p>
        <p class="hint">An admin can assign members to you from Settings → User Management.</p>
      </div>
    {:else}
      <p class="hint">{@html $_('program_detail.assign_hint', { values: { name: `<strong>${program?.name ?? ''}</strong>` } })}</p>
      {#each assignMembers as m (m.id)}
        <button class="assign-row" on:click={() => assignTo(m.id)} disabled={assigning}>
          <div class="avatar">{(m.full_name || m.username || '?')[0].toUpperCase()}</div>
          <div class="info">
            <span class="name">{m.full_name || m.username}</span>
            <span class="sub">{m.active_program ? `Current: ${m.active_program}` : 'No active program'}</span>
          </div>
          <span class="material-symbols-rounded chev">chevron_right</span>
        </button>
      {/each}
    {/if}
  </div>
</Sheet>

<!-- Duration & progression settings (issue #13) -->
<Sheet open={showSettings} on:close={() => showSettings = false}>
  <div class="form-sheet">
    <h3 class="form-title">Duration & progression</h3>
    <div class="form-group">
      <label class="form-label">Duration (weeks)</label>
      <input class="form-input" type="number" min="1" max="52" bind:value={settingsDuration} placeholder="1" />
      <p class="form-hint">More than 1 enables a per-week progression matrix in the workout editor.</p>
    </div>
    {#if settingsDuration > 1}
      <div class="form-group">
        <label class="form-label">{$_('program_detail.advance_week_by')}</label>
        <select class="form-select" bind:value={settingsAdvance}>
          <option value="sessions">{$_('program_detail.option_sessions')}</option>
          <option value="calendar">Calendar (7 days per week)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">{$_('program_detail.past_final_week')}</label>
        <select class="form-select" bind:value={settingsOnComplete}>
          <option value="hold">{$_('program_detail.option_hold')}</option>
          <option value="repeat">Repeat from week 1</option>
        </select>
      </div>
    {/if}
    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showSettings = false}>{$_('program_detail.cancel')}</button>
      <button class="btn btn-primary" on:click={saveSettings} disabled={savingSettings}>
        {savingSettings ? 'Saving...' : 'Save'}
      </button>
    </div>
  </div>
</Sheet>

<!-- Add Workout Sheet -->
<Sheet open={showAddTemplate} on:close={() => showAddTemplate = false}>
  <div class="form-sheet">
    <h3 class="form-title">{$_('program_detail.new_workout')}</h3>
    <div class="form-group">
      <label class="form-label">{$_('program_detail.name')}</label>
      <input class="form-input" type="text" bind:value={newTemplateName} placeholder="e.g. Upper Body A, Leg Day, Push" autofocus
        on:keydown={e => e.key === 'Enter' && addTemplate()} />
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showAddTemplate = false}>{$_('program_detail.cancel')}</button>
      <button class="btn btn-primary" on:click={addTemplate} disabled={creating || !newTemplateName.trim()}>
        {creating ? 'Adding...' : 'Add Workout'}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  /* page-header styled globally in base.css */
  .back-btn { background: none; border: none; cursor: pointer; color: var(--text-2); padding: 6px; display: flex; border-radius: var(--radius-sm); }
  .back-btn:hover { background: var(--surface-2); }
  .header-actions { display: flex; gap: 4px; }
  .btn-icon { background: none; border: none; cursor: pointer; color: var(--text-3); padding: 6px 10px; display: flex; align-items: center; gap: 6px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; font-family: inherit; }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .btn-icon.danger:hover { color: var(--danger); background: rgba(255,92,92,0.1); }

  /* Assign-to-member sheet */
  .assign-sheet { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 8px; }
  .assign-sheet .hint { font-size: 13px; color: var(--text-3); margin: 0 0 8px; }
  .empty-inline { text-align: center; padding: 16px 8px; color: var(--text-3); font-size: 13px; }
  .empty-inline .hint { font-size: 12px; margin-top: 6px; }
  .assign-row {
    display: flex; align-items: center; gap: 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 12px;
    cursor: pointer; text-align: left;
    transition: background var(--dur-fast);
  }
  .assign-row:hover:not(:disabled) { background: var(--surface-3); }
  .assign-row:disabled { opacity: 0.5; cursor: not-allowed; }
  .assign-row .avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-dim); color: var(--accent);
    font-size: 15px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .assign-row .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .assign-row .name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .assign-row .sub { font-size: 12px; color: var(--text-3); }
  .assign-row .chev { color: var(--text-3); }

  .content { padding: 16px var(--page-px); }

  .info-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .goal-tag { padding: 4px 12px; border-radius: var(--radius-full); background: var(--surface-2); font-size: 13px; color: var(--text-2); text-transform: capitalize; }
  .template-count { font-size: 13px; color: var(--text-3); }
  .active-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 12px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid var(--accent);
    font-size: 12px; font-weight: 700;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .active-badge:hover { background: var(--accent); color: var(--accent-text); }
  .activate-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 14px; border-radius: var(--radius-full);
    background: var(--accent); color: var(--accent-text);
    border: none; font-size: 12px; font-weight: 700; cursor: pointer;
    transition: opacity var(--dur-fast);
  }
  .activate-btn:active { opacity: 0.8; }

  .description { font-size: 14px; color: var(--text-2); line-height: 1.6; margin: 0 0 20px; }

  .section { margin-bottom: 20px; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 16px; font-weight: 700; color: var(--text-1); margin: 0; }
  .btn-primary-sm {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 12px; font-size: 12px; font-weight: 600;
    background: var(--accent); color: var(--accent-text);
    border: none; border-radius: var(--radius-md); cursor: pointer;
  }
  .btn-primary-sm .material-symbols-rounded { font-size: 16px; }

  .template-list { display: flex; flex-direction: column; gap: 6px; }

  /* Drag wrapper for template reordering */
  .tpl-drag { transition: opacity var(--dur-fast), transform var(--dur-fast); position: relative; }
  .tpl-drag.dragging { opacity: 0.5; transform: scale(0.98); }
  .tpl-drag.drag-over::before {
    content: '';
    position: absolute; left: 0; right: 0; top: -4px;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: var(--radius-full);
    box-shadow: 0 0 10px var(--accent-dim);
  }
  .tpl-drag-handle {
    color: var(--text-3); font-size: 18px; opacity: 0.5;
    cursor: grab;
    transition: opacity var(--dur-fast);
    flex-shrink: 0;
  }
  .tpl-drag:hover .tpl-drag-handle { opacity: 0.9; }
  .template-card {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer; width: 100%; text-align: left;
    transition: background var(--dur-fast);
  }
  .template-card:hover { background: var(--surface-2); }
  .template-card:active { transform: scale(0.99); }
  .tpl-left { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
  .tpl-num {
    width: 28px; height: 28px; border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
    font-size: 13px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .tpl-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tpl-name { font-size: 14px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tpl-meta { font-size: 12px; color: var(--text-3); }
  .tpl-right { display: flex; align-items: center; gap: 4px; }
  .btn-icon-sm { background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px; display: flex; border-radius: var(--radius-xs); }
  .btn-icon-sm:hover { color: var(--danger); }
  .tpl-arrow { color: var(--text-3); font-size: 20px; }

  .empty-templates { text-align: center; padding: 32px; color: var(--text-3); }
  .empty-templates .material-symbols-rounded { font-size: 40px; display: block; margin: 0 auto 8px; }
  .empty-templates p { font-size: 14px; margin: 0 0 12px; }

  .loading { text-align: center; padding: 48px; color: var(--text-3); }

  /* Form sheet */
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

  /* Inline rename input styled to match the H1 exactly so the swap
     doesn't cause a font-weight / height / colour jump. Rename is
     triggered from the ⋮ menu; the H1 itself stays non-interactive
     to avoid accidental thumb-taps near the header on mobile. */
  .name-input {
    flex: 1; min-width: 0;
    background: var(--surface-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    font: inherit;
    font-size: 22px;
    font-weight: 800;
    line-height: 1.2;
    color: var(--text-1);
    outline: none;
    height: 40px;
  }
  .name-input:disabled { opacity: 0.6; }

  /* Mobile default — preview pane hidden. Template list still routes
     to /programs/:id/template/:tid on tap. */
  .pd-template-pane { display: none; }

  /* Wide-layout: template list + inline exercise preview pane.
     Section header + description stay above the split. The .pd-body
     wrapper becomes a 2-col grid at >=1280px on non-forced-mobile
     viewports so a lifter can scan the whole program's day-by-day
     structure without opening WorkoutEditor for each day. */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .pd-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 400px;
      gap: 20px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .pd-body > .template-list {
      min-width: 0;
    }
    :global(html:not(.force-mobile-layout)) .pd-body :global(.template-card.selected-for-preview) {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    :global(html:not(.force-mobile-layout)) .pd-body > .pd-template-pane {
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
    .ptp-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .ptp-title-block { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .ptp-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-1);
      line-height: 1.25;
    }
    .ptp-meta { font-size: 12px; color: var(--text-3); }
    .ptp-exercises {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ptp-exercise {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
    }
    .ptp-ex-num {
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
    .ptp-ex-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .ptp-ex-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ptp-ex-spec { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
    .ptp-edit-btn {
      width: 100%;
      padding: 8px 12px;
      justify-content: center;
      margin-top: 6px;
    }
    .ptp-edit-btn .material-symbols-rounded { font-size: 18px; }
    .ptp-empty-body {
      font-size: 12px;
      color: var(--text-3);
      font-style: italic;
      padding: 8px 2px;
    }
    .ptp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 6px;
      padding: 40px 16px;
      color: var(--text-3);
    }
    .ptp-empty-icon { font-size: 32px; opacity: 0.6; }
    .ptp-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
    .ptp-empty-desc { margin: 0; font-size: 12px; line-height: 1.5; max-width: 260px; }
  }
</style>
