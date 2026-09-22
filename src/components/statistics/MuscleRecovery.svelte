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
  import { computeMuscleRecovery, freshnessFor, MUSCLE_BUCKETS } from '../../lib/muscle-recovery.js';
  import BodyFigure, { SOLID, CUT, FRONT, BACK } from './BodyFigure.svelte';

  export let workouts = [];
  export let exercises = [];
  export let windowDays = 7;

  $: recovery = computeMuscleRecovery(workouts, exercises, windowDays);

  // Currently-hovered/tapped muscle for the small caption beneath the diagram.
  let focused = null;
  function showInfo(key) { focused = key; }
  function onFocus(e) { focused = e.detail; }
  function clearInfo() { focused = null; }

  function fillFor(key) { return freshnessFor(recovery[key]?.hoursAgo).color; }
  function labelFor(key) { return freshnessFor(recovery[key]?.hoursAgo).label; }
  function hoursLabel(key) {
    const h = recovery[key]?.hoursAgo;
    if (h == null) return 'no recent work';
    if (h < 1) return 'just now';
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  function setsLabel(key) {
    const n = recovery[key]?.sets || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }
  // Friendly key → display name.
  const NAMES = {
    chest: 'Chest', back: 'Back', shoulders: 'Shoulders',
    biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms',
    core: 'Core', quads: 'Quads', hamstrings: 'Hamstrings',
    glutes: 'Glutes', calves: 'Calves',
  };
</script>

<div class="card recovery-card">
  <div class="recovery-head">
    <div>
      <span class="recovery-title">{$_('muscle_recovery.title')}</span>
      <span class="recovery-sub">Hours since last completed set, past {windowDays} days</span>
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
    <svg viewBox="0 0 240 285" xmlns="http://www.w3.org/2000/svg" class="body-svg" aria-hidden="true">
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

      <BodyFigure regions={FRONT} {fillFor} dx={0}   on:focus={onFocus} on:blur={clearInfo} />
      <BodyFigure regions={BACK}  {fillFor} dx={120} on:focus={onFocus} on:blur={clearInfo} />

      <text x="60" y="281" text-anchor="middle" class="figure-label">{$_('muscle_recovery.front')}</text>
      <text x="180" y="281" text-anchor="middle" class="figure-label">{$_('muscle_recovery.back')}</text>
    </svg>

    <!-- Selected-muscle caption. Shows when the user hovers a region. -->
    <div class="recovery-caption" class:hidden={!focused}>
      {#if focused}
        <span class="cap-name">{NAMES[focused] || focused}</span>
        <span class="cap-state" style="color:{fillFor(focused)}">{labelFor(focused)}</span>
        <span class="cap-meta">·  {hoursLabel(focused)}  ·  {setsLabel(focused)} effective sets</span>
      {/if}
    </div>
  </div>
</div>

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
</style>
