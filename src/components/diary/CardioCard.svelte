<script>
  // Cardio session card for the Diary. Self-contained: loads its own data
  // for the current date, exposes an add form + inline delete, doesn't
  // touch $todayLog or any set-based state. Deliberately keeps cardio
  // separate from workout_log so volume totals, PRs, and rest-timer
  // firing never have to filter it out.
  //
  // Manual entry only. See feedback_lifttrace_cardio_scope.md for the
  // hard line against device sync in LT.

  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../../lib/api.js';
  import { currentDate } from '../../stores/workout.js';
  import { weightUnit } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';

  let sessions = [];
  let templates = [];
  let loading = false;
  let showForm = false;
  // Non-null when editing an existing session. The form is a single UI
  // that serves both create and update flows; editingId flips which
  // API call save() dispatches.
  let editingId = null;

  // Form state
  let f_activity = '';
  let f_duration = '';
  let f_distance = '';
  let f_hr = '';
  let f_notes = '';
  // Needed to tell an empty numeric field from one holding unparseable text:
  // both bind to null, only validity.badInput distinguishes them.
  let distanceEl, hrEl;
  let saving = false;

  $: distanceUnit = $weightUnit === 'lbs' ? 'mi' : 'km';

  // Reload whenever the diary date changes.
  $: $currentDate, load();

  async function load() {
    loading = true;
    try {
      sessions = await LtApi.getCardioByDate($currentDate);
    } catch (e) {
      // Silent fail — cardio just doesn't render, doesn't block the diary
      sessions = [];
    }
    loading = false;
    loadTemplates();
  }
  async function loadTemplates() {
    try {
      templates = await LtApi.getCardioTemplates();
    } catch {
      templates = [];
    }
  }

  async function logFromTemplate(t) {
    try {
      const created = await LtApi.createCardio({
        date: $currentDate,
        activity: t.activity,
        duration_min: t.duration_min,
        distance: t.distance,
        distance_unit: t.distance_unit || distanceUnit,
        avg_hr: t.avg_hr,
        notes: t.notes,
      });
      sessions = [created, ...sessions];
      showSuccess($_('diary.cardio.toast.logged'));
    } catch (e) {
      showError(e?.message || $_('diary.cardio.toast.log_failed'));
    }
  }

  async function toggleTemplate(session) {
    const next = session.is_template ? 0 : 1;
    try {
      const updated = await LtApi.toggleCardioTemplate(session.id, next);
      sessions = sessions.map(s => s.id === session.id ? updated : s);
      showSuccess(next ? $_('diary.cardio.toast.pinned') : $_('diary.cardio.toast.unpinned'));
      loadTemplates();
    } catch (e) {
      showError(e?.message || $_('diary.cardio.toast.update_failed'));
    }
  }

  function openForm() {
    showForm = true;
    editingId = null;
    f_activity = '';
    f_duration = '';
    f_distance = '';
    f_hr = '';
    f_notes = '';
  }
  function openEdit(session) {
    showForm = true;
    editingId = session.id;
    f_activity = session.activity || '';
    f_duration = String(session.duration_min ?? '');
    f_distance = session.distance != null ? String(session.distance) : '';
    f_hr = session.avg_hr != null ? String(session.avg_hr) : '';
    f_notes = session.notes || '';
  }
  function cancelForm() { showForm = false; editingId = null; }

  async function save() {
    const activity = f_activity.trim();
    const duration = parseInt(f_duration, 10);
    if (!activity) { showError($_('diary.cardio.toast.activity_required')); return; }
    if (!Number.isFinite(duration) || duration <= 0) { showError($_('diary.cardio.toast.duration_invalid')); return; }
    // A number input the browser cannot parse reports its value as empty, so
    // without this an entry like "11ax" would be dropped silently instead of
    // telling the user. badInput is the only thing that separates "left blank"
    // from "typed something that isn't a number".
    if (distanceEl?.validity?.badInput) { showError($_('diary.cardio.toast.distance_invalid')); return; }
    if (hrEl?.validity?.badInput) { showError($_('diary.cardio.toast.hr_invalid')); return; }
    saving = true;
    try {
      const payload = {
        date: $currentDate,
        activity,
        duration_min: duration,
        // Distance and heart rate bind to <input type="number">, so Svelte
        // replaces the initial '' with a number once the field is touched and
        // with null once it is cleared. Testing emptiness, not stringness.
        distance: f_distance == null || f_distance === '' ? null : Number(f_distance),
        distance_unit: distanceUnit,
        avg_hr: f_hr == null || f_hr === '' ? null : parseInt(f_hr, 10),
        notes: f_notes.trim() || null,
      };
      if (editingId != null) {
        const updated = await LtApi.updateCardio(editingId, payload);
        sessions = sessions.map(s => s.id === editingId ? updated : s);
        showSuccess($_('diary.cardio.toast.updated'));
      } else {
        const created = await LtApi.createCardio(payload);
        sessions = [created, ...sessions];
        showSuccess($_('diary.cardio.toast.logged'));
      }
      showForm = false;
      editingId = null;
    } catch (e) {
      showError(e?.message || $_('common.errors.save_failed'));
    }
    saving = false;
  }

  async function remove(session) {
    const ok = await confirmDialog({
      title: $_('diary.confirm.delete_cardio_title'),
      message: $_('diary.confirm.delete_cardio_msg', { values: { activity: session.activity, duration: session.duration_min } }),
      confirmText: $_('common.delete'),
      cancelText: $_('common.cancel'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await LtApi.deleteCardio(session.id);
      sessions = sessions.filter(s => s.id !== session.id);
    } catch (e) {
      showError(e?.message || $_('common.errors.delete_failed'));
    }
  }

  $: totalMinutes = sessions.reduce((s, x) => s + (x.duration_min || 0), 0);
</script>

<section class="cardio-card">
  <header class="cardio-head">
    <div class="cardio-title">
      <span class="material-symbols-rounded cardio-icon">directions_run</span>
      <span>{$_('diary.cardio.title')}</span>
      {#if sessions.length > 0}
        <span class="cardio-total">{$_('diary.cardio.total_today', { values: { minutes: totalMinutes } })}</span>
      {/if}
    </div>
    {#if !showForm}
      <button class="cardio-add" on:click={openForm} aria-label={$_('diary.cardio.add_aria')}>
        <span class="material-symbols-rounded">add</span>
      </button>
    {/if}
  </header>

  {#if !showForm && templates.length > 0}
    <div class="cardio-templates" aria-label={$_('diary.cardio.templates_aria')}>
      {#each templates as t (t.id)}
        <button class="tpl-chip" on:click={() => logFromTemplate(t)} title={$_('diary.cardio.tpl_title', { values: { activity: t.activity, minutes: t.duration_min } })}>
          <span class="material-symbols-rounded">bolt</span>
          <span class="tpl-label">{t.activity}</span>
          <span class="tpl-meta">{t.duration_min}m</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if showForm}
    <div class="cardio-form">
      <div class="row">
        <input class="input" placeholder={$_('diary.cardio.activity_placeholder')} bind:value={f_activity} />
        <input class="input input-narrow" type="number" min="1" placeholder={$_('diary.cardio.duration_placeholder')} bind:value={f_duration} />
      </div>
      <div class="row">
        <input class="input" type="number" step="0.1" placeholder={$_('diary.cardio.distance_placeholder', { values: { distanceUnit } })} bind:this={distanceEl} bind:value={f_distance} />
        <input class="input input-narrow" type="number" min="30" max="230" placeholder={$_('diary.cardio.hr_placeholder')} bind:this={hrEl} bind:value={f_hr} />
      </div>
      <input class="input" placeholder={$_('diary.cardio.notes_placeholder')} bind:value={f_notes} />
      <div class="row row-actions">
        <button class="btn btn-secondary btn-sm" on:click={cancelForm} disabled={saving}>{$_('common.cancel')}</button>
        <button class="btn btn-primary btn-sm" on:click={save} disabled={saving}>{saving ? $_('common.saving') : (editingId != null ? $_('common.save') : $_('diary.cardio.log_submit'))}</button>
      </div>
    </div>
  {/if}

  {#if !loading && sessions.length > 0}
    <ul class="cardio-list">
      {#each sessions as s (s.id)}
        <li class="cardio-row">
          <button class="cardio-row-main" on:click={() => openEdit(s)} title={$_('diary.cardio.edit_title')}>
            <span class="cardio-activity">{s.activity}</span>
            <span class="cardio-meta">
              {s.duration_min} min
              {#if s.distance != null}· {s.distance} {s.distance_unit || 'km'}{/if}
              {#if s.avg_hr != null}· {s.avg_hr} bpm{/if}
            </span>
            {#if s.notes}
              <span class="cardio-notes">{s.notes}</span>
            {/if}
          </button>
          <button
            class="cardio-pin"
            class:pinned={s.is_template}
            on:click={() => toggleTemplate(s)}
            aria-label={s.is_template ? $_('diary.cardio.unpin_template') : $_('diary.cardio.pin_template')}
            title={s.is_template ? $_('diary.cardio.unpin_template') : $_('diary.cardio.pin_template')}
          >
            <span class="material-symbols-rounded">{s.is_template ? 'keep' : 'keep_off'}</span>
          </button>
          <button class="cardio-del" on:click={() => remove(s)} aria-label={$_('diary.cardio.delete_aria')}>
            <span class="material-symbols-rounded">close</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if !loading && !showForm}
    <p class="cardio-empty">{$_('diary.cardio.empty')}</p>
  {/if}
</section>

<style>
  .cardio-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 12px 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .cardio-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
  }
  .cardio-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px; font-weight: 700; color: var(--text-1);
  }
  .cardio-icon { font-size: 18px; color: var(--accent); }
  .cardio-total {
    font-size: 11px; font-weight: 700; color: var(--text-3);
    margin-left: 4px; font-variant-numeric: tabular-nums;
  }
  .cardio-add {
    width: 32px; height: 32px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .cardio-add:hover { background: var(--surface-3); color: var(--text-1); }
  .cardio-add .material-symbols-rounded { font-size: 18px; }

  .cardio-form { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; }
  .row-actions { justify-content: flex-end; }
  .input {
    flex: 1; min-width: 0;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1); font-family: inherit; font-size: 13px;
  }
  .input:focus { border-color: var(--accent); outline: none; }
  .input-narrow { flex: 0 0 80px; }

  .cardio-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .cardio-row {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  /* Row body is a button so the whole thing is one big tap target
     that opens the edit form. Reset default button chrome so it looks
     the same as the old plain <div>. */
  .cardio-row-main {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; gap: 2px;
    background: none; border: none; padding: 0;
    text-align: left; color: inherit; font: inherit; cursor: pointer;
  }
  .cardio-row-main:hover .cardio-activity { color: var(--accent); }
  .cardio-activity { font-size: 13px; font-weight: 700; color: var(--text-1); }
  .cardio-meta { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .cardio-notes { font-size: 11px; color: var(--text-3); font-style: italic; }
  .cardio-del {
    width: 26px; height: 26px; padding: 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .cardio-del:hover { color: var(--danger); background: var(--surface-3); }
  .cardio-del .material-symbols-rounded { font-size: 14px; }

  .cardio-empty { margin: 0; font-size: 12px; color: var(--text-3); }

  .cardio-templates {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .tpl-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-1); font-size: 12px; font-weight: 600;
    cursor: pointer;
  }
  .tpl-chip:hover { background: var(--surface-3); border-color: var(--accent); }
  .tpl-chip .material-symbols-rounded { font-size: 15px; color: var(--accent); }
  .tpl-label { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tpl-meta { color: var(--text-3); font-variant-numeric: tabular-nums; }

  .cardio-pin {
    width: 26px; height: 26px; padding: 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .cardio-pin:hover { color: var(--text-1); background: var(--surface-3); }
  .cardio-pin.pinned { color: var(--accent); }
  .cardio-pin .material-symbols-rounded { font-size: 15px; }
</style>
