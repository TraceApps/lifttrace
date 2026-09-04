<script>
  /**
   * Diary → right column → Body Stats summary widget. Ported 1:1
   * from NT's BodyStatsWidget so the two apps read as one system:
   *   Header (icon + title + open-full)
   *   Weight row — value + inline edit, OR "Weight not logged" + Log
   *   Divider
   *   Measurements list, OR "No measurements logged today"
   *   Log Stats CTA — opens the full BodyStats sheet
   *
   * LT-specific: loads via GET /api/body-stats/:date and reads
   * back the same JSON stats blob the sheet writes. Only exposes
   * measurement fields the user has enabled in Settings → Workout
   * (bodyStatsVisible store), matching the modal's visibleStats
   * gate so the two entry points show the same set of fields.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { bodyStatsVisible, weightUnit } from '../../stores/settings.js';
  import { currentDate } from '../../stores/workout.js';
  import { showError } from '../../stores/toast.js';

  export let onOpen = () => {};

  const ROWS = [
    { key: 'bodyFat', label: 'Body Fat', unit: '%'  },
    { key: 'waist',   label: 'Waist',    unit: null },
    { key: 'hips',    label: 'Hips',     unit: null },
    { key: 'chest',   label: 'Chest',    unit: null },
    { key: 'neck',    label: 'Neck',     unit: null },
    { key: 'thighs',  label: 'Thighs',   unit: null },
    { key: 'biceps',  label: 'Biceps',   unit: null },
    { key: 'calves',  label: 'Calves',   unit: null },
  ];

  $: lengthUnit = $weightUnit === 'kg' ? 'cm' : 'in';

  let stats = {};
  let loaded = false;

  async function load() {
    try {
      const res = await fetch(`/api/body-stats/${$currentDate}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        // GET /api/body-stats/:date responds with { stats: row | null },
        // and the row itself carries the measurements one level deeper at
        // row.stats (id/user_id/date sit alongside it) — the wire shape is
        // { stats: { id, user_id, date, stats: { weight, bodyFat, ... } } }.
        // data.stats?.stats reaches the actual measurements; the ?? data.stats
        // fallback keeps this working if a future response ever comes back
        // already flat (issue #80).
        const raw = typeof data.stats === 'string' ? JSON.parse(data.stats) : data.stats;
        stats = raw?.stats ?? raw ?? {};
      } else {
        stats = {};
      }
    } catch { stats = {}; }
    loaded = true;
  }
  onMount(load);
  $: if ($currentDate) load();
  // Also reload when the modal saves (mobile flow) so the widget
  // stays in sync without a page nav.
  if (typeof window !== 'undefined') {
    window.addEventListener('lt:body-stats-saved', load);
  }

  $: currentWeight = stats.weight != null && stats.weight !== '' ? stats.weight : null;

  $: measurementRows = ROWS
    .filter(r => ($bodyStatsVisible || []).includes(r.key))
    .filter(r => stats[r.key] != null && stats[r.key] !== '')
    .map(r => ({ ...r, value: stats[r.key] }));
  $: hasMeasurements = measurementRows.length > 0;

  let editing = false;
  let inputVal = '';
  let inputEl;
  let saving = false;

  async function startEditWeight() {
    editing = true;
    inputVal = currentWeight != null ? String(currentWeight) : '';
    await Promise.resolve();
    inputEl?.focus();
    inputEl?.select();
  }
  async function commitWeight() {
    const val = parseFloat(inputVal);
    if (!Number.isFinite(val) || val <= 0) { cancelWeight(); return; }
    saving = true;
    try {
      const next = { ...stats, weight: val };
      const res = await fetch(`/api/body-stats/${$currentDate}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats: next }),
      });
      if (!res.ok) throw new Error('Save failed');
      stats = next;
      editing = false;
    } catch (e) {
      showError(e.message || 'Save failed');
    } finally {
      saving = false;
    }
  }
  function cancelWeight() { editing = false; inputVal = ''; }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitWeight(); }
    else if (e.key === 'Escape') { cancelWeight(); }
  }
</script>

<section class="bs-widget">
  <header class="bs-header">
    <span class="material-symbols-rounded bs-icon">monitor_weight</span>
    <span class="bs-title">Body Stats</span>
    <button class="bs-open" on:click={onOpen} title="Open Body Stats sheet" aria-label="Open Body Stats sheet">
      <span class="material-symbols-rounded">open_in_full</span>
    </button>
  </header>

  <div class="bs-weight-row">
    {#if !editing}
      {#if currentWeight != null}
        <div class="bs-weight-value">
          <span class="bs-w-num">{currentWeight}</span>
          <span class="bs-w-unit">{$weightUnit}</span>
        </div>
        <button class="bs-edit-inline" on:click={startEditWeight} title="Edit today's weight" aria-label="Edit today's weight">
          <span class="material-symbols-rounded">edit</span>
        </button>
      {:else}
        <span class="bs-weight-empty">Weight not logged</span>
        <button class="bs-quick-log" on:click={startEditWeight}>Log</button>
      {/if}
    {:else}
      <div class="bs-edit-form" transition:slide={{ duration: 160 }}>
        <input
          bind:this={inputEl}
          bind:value={inputVal}
          on:keydown={onKey}
          type="number"
          step="0.1"
          min="0"
          placeholder={$weightUnit}
          class="bs-edit-input"
          disabled={saving}
        />
        <button class="btn btn-primary bs-save" on:click={commitWeight} disabled={saving}>
          {saving ? '…' : 'Save'}
        </button>
        <button class="btn btn-ghost bs-cancel" on:click={cancelWeight} disabled={saving}>
          Cancel
        </button>
      </div>
    {/if}
  </div>

  <div class="bs-divider"></div>

  {#if hasMeasurements}
    <ul class="bs-list">
      {#each measurementRows as row (row.key)}
        <li class="bs-row">
          <span class="bs-label">{row.label}</span>
          <span class="bs-value">{row.value} <span class="bs-unit">{row.unit || lengthUnit}</span></span>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="bs-empty">No measurements logged today</div>
  {/if}

  <button class="btn btn-primary bs-log-btn" on:click={onOpen}>
    Log Stats
  </button>
</section>

<style>
  .bs-widget {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bs-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bs-icon { color: var(--accent); font-size: 20px; }
  .bs-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
    flex: 1;
  }
  .bs-open {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .bs-open:hover { color: var(--text-1); background: var(--surface-2); }
  .bs-open .material-symbols-rounded { font-size: 16px; }

  .bs-weight-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 34px;
  }
  .bs-weight-value {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  .bs-w-num {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .bs-w-unit {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
  }
  .bs-weight-empty {
    font-size: 13px;
    color: var(--text-3);
    font-style: italic;
  }
  .bs-edit-inline {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .bs-edit-inline:hover { color: var(--text-1); background: var(--surface-2); }
  .bs-edit-inline .material-symbols-rounded { font-size: 14px; }
  .bs-quick-log {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .bs-quick-log:hover { background: var(--accent); color: var(--surface-1); }

  .bs-edit-form {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 6px;
    width: 100%;
    align-items: center;
  }
  .bs-edit-input {
    padding: 6px 10px;
    font-size: 14px;
    font-weight: 600;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    width: 100%;
    outline: none;
    font-family: inherit;
  }
  .bs-edit-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .bs-save, .bs-cancel {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .bs-divider {
    height: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  .bs-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .bs-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 5px 10px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .bs-label { color: var(--text-2); font-weight: 500; }
  .bs-value {
    color: var(--text-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bs-unit {
    color: var(--text-3);
    font-weight: 500;
    font-size: 11px;
    margin-left: 2px;
  }

  .bs-empty {
    font-size: 12px;
    color: var(--text-3);
    font-style: italic;
    padding: 4px 2px;
  }

  .bs-log-btn {
    width: 100%;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
</style>
