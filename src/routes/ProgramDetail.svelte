<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { LtApi } from '../lib/api.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { currentUser } from '../stores/auth.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import Spinner from '../components/ui/Spinner.svelte';

  export let params = {};

  let program = null;
  let loading = true;

  // Add template form
  let showAddTemplate = false;
  let newTemplateName = '';
  let creating = false;

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
      showSuccess(`Assigned to ${m?.full_name || m?.username || 'member'}`);
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

  async function activate() {
    try {
      await LtApi.setActiveProgram(params.id);
      showSuccess('Program set as active');
      await load();
    } catch(e) { showError(e.message); }
  }

  async function deactivate() {
    try {
      await LtApi.deactivateProgram();
      showSuccess('Program deactivated');
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
      showSuccess('Workout added');
      await load();
    } catch(e) { showError(e.message); }
    creating = false;
  }

  async function deleteTemplate(e, id) {
    e.stopPropagation();
    if (!await confirmDialog({ title: 'Delete workout?', message: 'This removes the workout template from this program.', confirmText: 'Delete', dangerous: true })) return;
    try {
      await LtApi.deleteTemplate(id);
      showSuccess('Workout deleted');
      await load();
    } catch(e) { showError(e.message); }
  }

  async function deleteProgram() {
    if (!await confirmDialog({ title: 'Delete program?', message: 'Deletes the entire program and all of its workouts. This cannot be undone.', confirmText: 'Delete', dangerous: true })) return;
    try {
      await LtApi.deleteProgram(params.id);
      showSuccess('Program deleted');
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

  async function duplicateProgram() {
    try {
      const p = await LtApi.createProgram({
        name: `${program.name} (Copy)`,
        description: program.description,
        goal: program.goal,
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
      showSuccess('Program duplicated');
      push(`/programs/${p.id}`);
    } catch(e) { showError(e.message); }
  }
</script>

<div class="page">
  <header class="page-header">
    <button class="back-btn" on:click={() => push('/programs')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h1>{program?.name || 'Program'}</h1>
    <div class="header-actions">
      {#if isCoach && isOwner}
        <button class="btn-icon" on:click={openAssign} title="Assign to Member">
          <span class="material-symbols-rounded">person_add</span>
        </button>
      {/if}
      <button class="btn-icon" on:click={duplicateProgram} title="Duplicate Program" aria-label="Duplicate program">
        <span class="material-symbols-rounded">content_copy</span>
      </button>
      <button class="btn-icon danger" on:click={deleteProgram} title="Delete Program">
        <span class="material-symbols-rounded">delete</span>
      </button>
    </div>
  </header>

  {#if loading}
    <Spinner block label="Loading program…" />
  {:else if program}
    <div class="content">
      <!-- Info bar -->
      <div class="info-bar">
        <span class="goal-tag">{program.goal}</span>
        <span class="template-count">{program.templates?.length || 0} workouts</span>
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
          <h3 class="section-title">Workouts</h3>
          <button class="btn-primary-sm" on:click={() => showAddTemplate = true}>
            <span class="material-symbols-rounded">add</span>
            Add
          </button>
        </div>

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
                <div class="template-card" on:click={() => openTemplate(t.id)} role="button" tabindex="0">
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
            <button class="btn-primary-sm" on:click={() => showAddTemplate = true}>Add Workout</button>
          </div>
        {/if}
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
      <p class="hint">Pick a member to assign <strong>{program?.name}</strong> to:</p>
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

<!-- Add Workout Sheet -->
<Sheet open={showAddTemplate} on:close={() => showAddTemplate = false}>
  <div class="form-sheet">
    <h3 class="form-title">New Workout</h3>
    <div class="form-group">
      <label class="form-label">Name</label>
      <input class="form-input" type="text" bind:value={newTemplateName} placeholder="e.g. Upper Body A, Leg Day, Push" autofocus
        on:keydown={e => e.key === 'Enter' && addTemplate()} />
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" on:click={() => showAddTemplate = false}>Cancel</button>
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
  .form-input {
    width: 100%; padding: 12px 14px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); color: var(--text-1);
    font-size: 15px; font-family: inherit; outline: none;
  }
  .form-input:focus { border-color: var(--accent); }
  .form-actions { display: flex; gap: 10px; margin-top: 24px; }
  .form-actions button { flex: 1; padding: 13px; font-size: 15px; }
</style>
