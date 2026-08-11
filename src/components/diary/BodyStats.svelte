<script>
  import { onMount } from 'svelte';
  import { portal } from '../../lib/portal.js';
  import { bodyStatsVisible, weightUnit, dateFormat } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { currentDate } from '../../stores/workout.js';

  export let open = false;

  // Title case for the label, unit comes from getUnit() so each label
  // renders as e.g. "Weight (lbs)" or "Body Fat (%)". The previous
  // "Body Fat %" label combined with the appended unit produced the
  // doubled "Body Fat % (%)" caption seen in the sheet.
  const ALL_STATS = [
    { id: 'weight',  label: 'Weight' },
    { id: 'bodyFat', label: 'Body Fat' },
    { id: 'neck',    label: 'Neck' },
    { id: 'chest',   label: 'Chest' },
    { id: 'waist',   label: 'Waist' },
    { id: 'hips',    label: 'Hips' },
    { id: 'biceps',  label: 'Biceps' },
    { id: 'thighs',  label: 'Thighs' },
    { id: 'calves',  label: 'Calves' },
  ];

  $: lengthUnit = $weightUnit === 'kg' ? 'cm' : 'in';
  $: visibleStats = ALL_STATS.filter(s => ($bodyStatsVisible || []).includes(s.id));

  // Format $currentDate (always YYYY-MM-DD) using the user's preferred
  // date format from Settings → Units. Same logic as
  // Diary.svelte#formatDateSub so the diary header and the body-stats
  // sheet show identical-looking dates.
  function _fmtDate(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    if ($dateFormat === 'EU')  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if ($dateFormat === 'ISO') return dateStr;
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  }

  function getUnit(id) {
    if (id === 'weight') return $weightUnit || 'lbs';
    if (id === 'bodyFat') return '%';
    return lengthUnit;
  }

  let stats = {};
  let saving = false;

  $: if (open) loadStats();

  async function loadStats() {
    try {
      const res = await fetch(`/api/body-stats/${$currentDate}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        stats = data.stats ? (typeof data.stats === 'string' ? JSON.parse(data.stats) : data.stats) : {};
      } else {
        stats = {};
      }
    } catch { stats = {}; }
  }

  async function save() {
    saving = true;
    try {
      const res = await fetch(`/api/body-stats/${$currentDate}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats }),
      });
      if (!res.ok) throw new Error('Save failed');
      showSuccess('Body stats saved');
      open = false;
    } catch(e) {
      showError(e.message);
    }
    saving = false;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={() => open = false}>
    <div class="bs-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header-row">
        <h3 class="sheet-title">Body Stats</h3>
        <span class="sheet-date">{_fmtDate($currentDate)}</span>
        <button class="sheet-close" on:click={() => open = false} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
      <div class="bs-sheet-body">
        <div class="bs-grid">
          {#each visibleStats as stat (stat.id)}
            <div>
              <label class="form-label">{stat.label} <span class="unit">({getUnit(stat.id)})</span></label>
              <input class="input" type="number" step="0.1" min="0"
                bind:value={stats[stat.id]} placeholder="—" />
            </div>
          {/each}
        </div>

        {#if visibleStats.length === 0}
          <p class="bs-empty">No measurements enabled. Go to Settings → Workout to choose which stats to track.</p>
        {/if}
      </div>
      <div class="bs-sheet-footer">
        <button class="btn btn-primary w-full" on:click={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .sheet-header-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px 4px; }
  .sheet-title { font-size: 17px; font-weight: 700; margin: 0; flex: 1; }
  .sheet-close {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .sheet-close:hover { color: var(--text-1); background: var(--surface-2); }
  .sheet-close .material-symbols-rounded { font-size: 22px; }
  .sheet-date { font-size: 13px; color: var(--text-3); }

  .bs-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
  }
  .bs-sheet-body { padding: 8px 20px 0; }
  .bs-sheet-footer { padding: 16px 20px; }
  .bs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .form-label {
    font-size: 13px; font-weight: 600; color: var(--text-2);
    margin-bottom: 6px; display: block;
  }
  .input {
    width: 100%;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 14px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    outline: none;
  }
  .input:focus { border-color: var(--accent); }
  .w-full { width: 100%; }
  .bs-empty {
    text-align: center; padding: 24px 0;
    font-size: 13px; color: var(--text-3); line-height: 1.5;
    grid-column: 1 / -1;
  }
</style>
