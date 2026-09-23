<!--
  MuscleRecovery — body diagram showing per-muscle freshness based on
  hours since each muscle was last trained (completed non-warmup set).

  Two stylized silhouettes side by side (front + back) with each muscle
  group as a discrete <path>. Path fill is driven by `freshnessFor()` so
  the same color scheme is reused if/when we surface freshness elsewhere.
  Tooltip on hover / tap shows "Chest · 36h ago · 12 sets".
-->
<script>
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import {
    applyRecoveryAdjustments,
    computeMuscleRecovery,
    freshnessFor,
    RECOVERY_ADJUSTMENT_HOURS,
  } from '../../lib/muscle-recovery.js';
  import { LtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import BodyFigure, { SOLID, CUT, FRONT, BACK } from './BodyFigure.svelte';
  import Sheet from '../ui/Sheet.svelte';

  export let workouts = [];
  export let exercises = [];
  export let adjustments = [];
  export let windowDays = 7;

  const dispatch = createEventDispatcher();
  const OPTIONS = ['Fatigued', 'Recovering', 'Ready', 'Fresh'];
  $: estimatedRecovery = computeMuscleRecovery(workouts, exercises, windowDays);
  $: recovery = applyRecoveryAdjustments(estimatedRecovery, adjustments);

  // Currently-hovered/tapped muscle for the small caption beneath the diagram.
  let focused = null;
  let selected = null;
  let showAdjustment = false;
  let saving = false;
  function onFocus(e) { focused = e.detail; }
  function clearInfo() { focused = null; }
  function selectMuscle(e) {
    selected = e.detail;
    focused = e.detail;
    showAdjustment = true;
  }

  $: selectedAdjustment = selected
    ? adjustments.find(row => row.muscle === selected && !row.deleted_at)
    : null;

  async function saveState(state) {
    if (!selected || saving) return;
    saving = true;
    try {
      const data = await LtApi.saveMuscleRecoveryAdjustment(
        selected,
        state,
        estimatedRecovery[selected]?.basisWorkoutTimestamp ?? null,
        new Date().toISOString(),
      );
      dispatch('adjustment', { muscle: selected, adjustment: data.adjustment });
      showSuccess($_('muscle_recovery.toast_saved'));
      showAdjustment = false;
    } catch (e) {
      showError(e.message || $_('muscle_recovery.toast_failed'));
    } finally {
      saving = false;
    }
  }

  async function resetAdjustment() {
    if (!selected || saving) return;
    saving = true;
    try {
      await LtApi.resetMuscleRecoveryAdjustment(selected);
      dispatch('adjustment', { muscle: selected, adjustment: null });
      showSuccess($_('muscle_recovery.toast_reset'));
      showAdjustment = false;
    } catch (e) {
      showError(e.message || $_('muscle_recovery.toast_failed'));
    } finally {
      saving = false;
    }
  }

  function fillFor(key) { return freshnessFor(recovery[key]?.hoursAgo).color; }
  function labelFor(key) {
    const label = freshnessFor(recovery[key]?.hoursAgo).label;
    return label === 'Untrained' ? $_('muscle_recovery.untrained') : stateLabel(label);
  }
  function hoursLabel(key) {
    const h = recovery[key]?.hoursAgo;
    if (h == null) return $_('muscle_recovery.no_recent_work');
    if (h < 1) return $_('muscle_recovery.just_now');
    if (h < 24) return $_('muscle_recovery.hours_ago', { values: { n: Math.round(h) } });
    const d = Math.round(h / 24);
    return $_('muscle_recovery.days_ago', { values: { n: d } });
  }
  function setsLabel(key) {
    const n = recovery[key]?.sets || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }
  function muscleName(key) { return $_(`muscle_recovery.muscles.${key}`); }
  function stateLabel(state) { return $_(`muscle_recovery.${state.toLowerCase()}`); }
</script>

<div class="card recovery-card">
  <div class="recovery-head">
    <div>
      <span class="recovery-title">{$_('muscle_recovery.title')}</span>
      <span class="recovery-sub">{$_('muscle_recovery.description', { values: { days: windowDays } })}</span>
    </div>
    <div class="recovery-legend">
      <span class="legend-dot" style="background:#ef4444"></span><span class="legend-lbl">{$_('muscle_recovery.fatigued')}</span>
      <span class="legend-dot" style="background:#f97316"></span><span class="legend-lbl">{$_('muscle_recovery.recovering')}</span>
      <span class="legend-dot" style="background:#f59e0b"></span><span class="legend-lbl">{$_('muscle_recovery.ready')}</span>
      <span class="legend-dot" style="background:#10b981"></span><span class="legend-lbl">{$_('muscle_recovery.fresh')}</span>
    </div>
  </div>

  <div class="recovery-body">
    <!-- Two-figure SVG: anterior (front) on the left, posterior (back)
         on the right. Each muscle region is its own <path> so the fill
         can be set per region. Stroke + opacity tuned for both light
         and dark themes via accent-text variables. -->
    <svg viewBox="0 0 240 285" xmlns="http://www.w3.org/2000/svg" class="body-svg"
      role="group" aria-label={$_('muscle_recovery.diagram_label')}>
      <!-- One clipPath serves both figures: clip-path resolves in the
           referencing element's user space, so it travels with the
           translate() on the posterior group. -->
      <defs>
        <clipPath id="mr-body">
          {#each SOLID as s}
            {#if s.t === 'ellipse'}
              <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />
            {:else}
              <path d={s.d} />
            {/if}
          {/each}
          {#each CUT as d}<path {d} />{/each}
        </clipPath>
      </defs>

      <BodyFigure regions={FRONT} {fillFor} dx={0}   on:focus={onFocus} on:blur={clearInfo} on:select={selectMuscle} />
      <BodyFigure regions={BACK}  {fillFor} dx={120} on:focus={onFocus} on:blur={clearInfo} on:select={selectMuscle} />

      <text x="60" y="281" text-anchor="middle" class="figure-label">{$_('muscle_recovery.front')}</text>
      <text x="180" y="281" text-anchor="middle" class="figure-label">{$_('muscle_recovery.back')}</text>
    </svg>

    <!-- Selected-muscle caption. Shows when the user hovers a region. -->
    <div class="recovery-caption" class:hidden={!focused}>
      {#if focused}
        <span class="cap-name">{muscleName(focused)}</span>
        <span class="cap-state" style="color:{fillFor(focused)}">{labelFor(focused)}</span>
        {#if recovery[focused]?.adjusted}<span class="adjusted-badge">{$_('muscle_recovery.adjusted')}</span>{/if}
        <span class="cap-meta">· {hoursLabel(focused)} · {$_('muscle_recovery.effective_sets', { values: { n: setsLabel(focused) } })}</span>
      {/if}
    </div>
    <span class="adjust-hint">{$_('muscle_recovery.tap_to_adjust')}</span>
  </div>
</div>

<Sheet bind:open={showAdjustment} title={selected ? $_('muscle_recovery.adjust_title', { values: { muscle: muscleName(selected) } }) : ''}>
  {#if selected}
    <div class="adjust-sheet">
      <p>{$_('muscle_recovery.adjust_help')}</p>
      <div class="state-options">
        {#each OPTIONS as state}
          <button type="button" class="state-option"
            class:active={recovery[selected]?.adjusted && freshnessFor(recovery[selected]?.hoursAgo).label === state}
            aria-pressed={recovery[selected]?.adjusted && freshnessFor(recovery[selected]?.hoursAgo).label === state}
            disabled={saving} on:click={() => saveState(state)}>
            <span class="legend-dot" style="background:{freshnessFor(RECOVERY_ADJUSTMENT_HOURS[state]).color}"></span>
            <span>{stateLabel(state)}</span>
          </button>
        {/each}
      </div>
      {#if selectedAdjustment}
        <button type="button" class="reset-adjustment" disabled={saving} on:click={resetAdjustment}>
          {$_('muscle_recovery.reset_estimate')}
        </button>
      {/if}
    </div>
  {/if}
</Sheet>

<style>
  .recovery-card {
    padding: 14px 16px 12px;
    display: flex; flex-direction: column;
    gap: 10px;
  }
  .recovery-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .recovery-title {
    font-size: 13px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-2);
    display: block;
  }
  .recovery-sub {
    font-size: 11px; color: var(--text-3); margin-top: 2px;
    display: block;
  }
  .recovery-legend {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
    font-size: 10px; color: var(--text-3);
  }
  .legend-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 2px;
  }
  .legend-lbl { margin-right: 4px; }
  .recovery-body {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
  }
  .body-svg {
    width: 100%; max-width: 320px; height: auto;
    color: var(--text-2);
  }
  /* Head, neck and torso are one mass, so no separation stroke: one drawn
     between them reads as a collar and cuts a band across the jaw. */
  :global(.body-solid) {
    fill: color-mix(in srgb, var(--text-3) 18%, transparent);
    stroke: none;
  }
  /* Limbs are cut out of the card colour so they read as in front of the
     torso without needing an outline that also traces every other seam. */
  :global(.body-cut) {
    fill: color-mix(in srgb, var(--text-3) 18%, transparent);
    stroke: var(--surface-1);
    stroke-width: 1.1;
  }
  :global(.muscle) {
    cursor: pointer;
    stroke: none;
    transition: opacity var(--dur-fast);
  }
  :global(.muscle:hover) { opacity: 0.82; }
  :global(.muscle:focus-visible) { outline: none; stroke: var(--accent); stroke-width: 1.4; }
  .figure-label {
    font-size: 9px;
    fill: var(--text-3);
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .recovery-caption {
    min-height: 18px;
    font-size: 12px;
    color: var(--text-2);
    text-align: center;
    transition: opacity var(--dur-fast);
  }
  .recovery-caption.hidden { opacity: 0.35; }
  .cap-name { font-weight: 700; margin-right: 4px; }
  .cap-state { font-weight: 600; }
  .cap-meta { color: var(--text-3); }
  .adjusted-badge {
    margin-left: 6px; padding: 1px 5px; border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent); font-size: 10px; font-weight: 700;
  }
  .adjust-hint { font-size: 11px; color: var(--text-3); }
  .adjust-sheet { display: flex; flex-direction: column; gap: 14px; }
  .adjust-sheet p { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.45; }
  .state-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .state-option {
    min-height: 46px; border: 1px solid var(--border); border-radius: var(--radius-lg);
    background: var(--surface-2); color: var(--text-1); font: inherit; font-weight: 600;
    display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer;
  }
  .state-option:hover { border-color: var(--accent); }
  .state-option.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }
  .state-option:disabled, .reset-adjustment:disabled { opacity: 0.55; cursor: wait; }
  .reset-adjustment {
    min-height: 42px; border: 0; background: transparent; color: var(--accent);
    font: inherit; font-weight: 600; cursor: pointer;
  }
</style>
