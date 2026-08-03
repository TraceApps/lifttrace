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

  export let workouts = [];
  export let exercises = [];
  export let windowDays = 7;

  $: recovery = computeMuscleRecovery(workouts, exercises, windowDays);

  // Currently-hovered/tapped muscle for the small caption beneath the diagram.
  let focused = null;
  function showInfo(key) { focused = key; }
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
    <svg viewBox="0 0 240 280" xmlns="http://www.w3.org/2000/svg" class="body-svg" aria-hidden="true">
      <!-- ── Anterior figure ───────────────────────────────────────── -->
      <g class="figure" transform="translate(0,0)">
        <!-- Head -->
        <ellipse class="body-base" cx="60" cy="22" rx="13" ry="15"/>
        <!-- Neck -->
        <rect class="body-base" x="55" y="34" width="10" height="7" rx="2"/>
        <!-- Torso silhouette (drawn first; muscle paths overlay it) -->
        <path class="body-base"
          d="M40 44 Q45 41 60 41 Q75 41 80 44 L85 80 Q86 110 80 138 L72 175 L48 175 L40 138 Q34 110 35 80 Z"/>
        <!-- Arms (upper + lower) -->
        <path class="body-base" d="M85 50 Q92 60 92 90 L88 120 L80 120 L82 95 Q83 70 80 55 Z"/>
        <path class="body-base" d="M35 50 Q28 60 28 90 L32 120 L40 120 L38 95 Q37 70 40 55 Z"/>
        <path class="body-base" d="M88 120 L91 155 L84 155 L80 120 Z"/>
        <path class="body-base" d="M32 120 L29 155 L36 155 L40 120 Z"/>
        <!-- Hips -->
        <path class="body-base" d="M44 175 Q60 178 76 175 L78 192 L42 192 Z"/>
        <!-- Legs -->
        <path class="body-base" d="M44 192 Q42 230 47 268 L57 268 Q58 230 59 192 Z"/>
        <path class="body-base" d="M76 192 Q78 230 73 268 L63 268 Q62 230 61 192 Z"/>

        <!-- Muscle overlays (anterior). Each is a separate path so it
             gets its own fill via freshnessFor(). -->
        <path class="muscle"
          d="M43 50 Q60 47 77 50 L78 75 Q60 78 42 75 Z"
          fill={fillFor('chest')}
          on:mouseenter={() => showInfo('chest')} on:mouseleave={clearInfo}
          on:click={() => showInfo('chest')} role="button" tabindex="0"
          aria-label="Chest"/>
        <path class="muscle"
          d="M40 44 Q45 41 60 41 Q75 41 80 44 L82 50 Q72 47 60 47 Q48 47 38 50 Z"
          fill={fillFor('shoulders')}
          on:mouseenter={() => showInfo('shoulders')} on:mouseleave={clearInfo}
          on:click={() => showInfo('shoulders')} role="button" tabindex="0"
          aria-label="Shoulders (front delts)"/>
        <path class="muscle"
          d="M82 75 Q86 90 82 110 L78 110 Q80 95 80 78 Z"
          fill={fillFor('biceps')}
          on:mouseenter={() => showInfo('biceps')} on:mouseleave={clearInfo}
          on:click={() => showInfo('biceps')} role="button" tabindex="0"
          aria-label="Right biceps"/>
        <path class="muscle"
          d="M38 75 Q34 90 38 110 L42 110 Q40 95 40 78 Z"
          fill={fillFor('biceps')}
          on:mouseenter={() => showInfo('biceps')} on:mouseleave={clearInfo}
          on:click={() => showInfo('biceps')} role="button" tabindex="0"
          aria-label="Left biceps"/>
        <path class="muscle"
          d="M88 122 L91 152 L84 152 L82 122 Z"
          fill={fillFor('forearms')}
          on:mouseenter={() => showInfo('forearms')} on:mouseleave={clearInfo}
          on:click={() => showInfo('forearms')} role="button" tabindex="0"
          aria-label="Right forearm"/>
        <path class="muscle"
          d="M32 122 L29 152 L36 152 L38 122 Z"
          fill={fillFor('forearms')}
          on:mouseenter={() => showInfo('forearms')} on:mouseleave={clearInfo}
          on:click={() => showInfo('forearms')} role="button" tabindex="0"
          aria-label="Left forearm"/>
        <path class="muscle"
          d="M48 80 Q60 78 72 80 L74 138 Q60 140 46 138 Z"
          fill={fillFor('core')}
          on:mouseenter={() => showInfo('core')} on:mouseleave={clearInfo}
          on:click={() => showInfo('core')} role="button" tabindex="0"
          aria-label="Core"/>
        <path class="muscle"
          d="M45 196 Q42 232 46 262 L56 262 Q57 232 57 196 Z"
          fill={fillFor('quads')}
          on:mouseenter={() => showInfo('quads')} on:mouseleave={clearInfo}
          on:click={() => showInfo('quads')} role="button" tabindex="0"
          aria-label="Left quad"/>
        <path class="muscle"
          d="M75 196 Q78 232 74 262 L64 262 Q63 232 63 196 Z"
          fill={fillFor('quads')}
          on:mouseenter={() => showInfo('quads')} on:mouseleave={clearInfo}
          on:click={() => showInfo('quads')} role="button" tabindex="0"
          aria-label="Right quad"/>
      </g>

      <!-- ── Posterior figure ──────────────────────────────────────── -->
      <g class="figure" transform="translate(120,0)">
        <ellipse class="body-base" cx="60" cy="22" rx="13" ry="15"/>
        <rect class="body-base" x="55" y="34" width="10" height="7" rx="2"/>
        <path class="body-base"
          d="M40 44 Q45 41 60 41 Q75 41 80 44 L85 80 Q86 110 80 138 L72 175 L48 175 L40 138 Q34 110 35 80 Z"/>
        <path class="body-base" d="M85 50 Q92 60 92 90 L88 120 L80 120 L82 95 Q83 70 80 55 Z"/>
        <path class="body-base" d="M35 50 Q28 60 28 90 L32 120 L40 120 L38 95 Q37 70 40 55 Z"/>
        <path class="body-base" d="M88 120 L91 155 L84 155 L80 120 Z"/>
        <path class="body-base" d="M32 120 L29 155 L36 155 L40 120 Z"/>
        <path class="body-base" d="M44 175 Q60 178 76 175 L78 192 L42 192 Z"/>
        <path class="body-base" d="M44 192 Q42 230 47 268 L57 268 Q58 230 59 192 Z"/>
        <path class="body-base" d="M76 192 Q78 230 73 268 L63 268 Q62 230 61 192 Z"/>

        <!-- Back (full upper-back area: lats + traps + rhomboids) -->
        <path class="muscle"
          d="M40 50 Q60 45 80 50 L83 110 Q60 115 37 110 Z"
          fill={fillFor('back')}
          on:mouseenter={() => showInfo('back')} on:mouseleave={clearInfo}
          on:click={() => showInfo('back')} role="button" tabindex="0"
          aria-label="Back"/>
        <!-- Rear delts -->
        <path class="muscle"
          d="M40 44 Q45 41 60 41 Q75 41 80 44 L82 52 Q72 49 60 49 Q48 49 38 52 Z"
          fill={fillFor('shoulders')}
          on:mouseenter={() => showInfo('shoulders')} on:mouseleave={clearInfo}
          on:click={() => showInfo('shoulders')} role="button" tabindex="0"
          aria-label="Shoulders (rear delts)"/>
        <!-- Triceps (back of upper arm) -->
        <path class="muscle"
          d="M82 75 Q86 90 82 110 L78 110 Q80 95 80 78 Z"
          fill={fillFor('triceps')}
          on:mouseenter={() => showInfo('triceps')} on:mouseleave={clearInfo}
          on:click={() => showInfo('triceps')} role="button" tabindex="0"
          aria-label="Right triceps"/>
        <path class="muscle"
          d="M38 75 Q34 90 38 110 L42 110 Q40 95 40 78 Z"
          fill={fillFor('triceps')}
          on:mouseenter={() => showInfo('triceps')} on:mouseleave={clearInfo}
          on:click={() => showInfo('triceps')} role="button" tabindex="0"
          aria-label="Left triceps"/>
        <!-- Glutes -->
        <path class="muscle"
          d="M44 178 Q60 175 76 178 L78 198 Q60 202 42 198 Z"
          fill={fillFor('glutes')}
          on:mouseenter={() => showInfo('glutes')} on:mouseleave={clearInfo}
          on:click={() => showInfo('glutes')} role="button" tabindex="0"
          aria-label="Glutes"/>
        <!-- Hamstrings -->
        <path class="muscle"
          d="M45 200 Q43 222 46 240 L56 240 Q57 222 57 200 Z"
          fill={fillFor('hamstrings')}
          on:mouseenter={() => showInfo('hamstrings')} on:mouseleave={clearInfo}
          on:click={() => showInfo('hamstrings')} role="button" tabindex="0"
          aria-label="Left hamstring"/>
        <path class="muscle"
          d="M75 200 Q77 222 74 240 L64 240 Q63 222 63 200 Z"
          fill={fillFor('hamstrings')}
          on:mouseenter={() => showInfo('hamstrings')} on:mouseleave={clearInfo}
          on:click={() => showInfo('hamstrings')} role="button" tabindex="0"
          aria-label="Right hamstring"/>
        <!-- Calves -->
        <path class="muscle"
          d="M46 244 Q44 260 47 266 L56 266 Q57 260 56 244 Z"
          fill={fillFor('calves')}
          on:mouseenter={() => showInfo('calves')} on:mouseleave={clearInfo}
          on:click={() => showInfo('calves')} role="button" tabindex="0"
          aria-label="Left calf"/>
        <path class="muscle"
          d="M64 244 Q63 260 64 266 L73 266 Q76 260 74 244 Z"
          fill={fillFor('calves')}
          on:mouseenter={() => showInfo('calves')} on:mouseleave={clearInfo}
          on:click={() => showInfo('calves')} role="button" tabindex="0"
          aria-label="Right calf"/>
      </g>

      <!-- Labels under each figure -->
      <text x="60" y="278" text-anchor="middle" class="figure-label">{$_('muscle_recovery.front')}</text>
      <text x="180" y="278" text-anchor="middle" class="figure-label">{$_('muscle_recovery.back')}</text>
    </svg>

    <!-- Selected-muscle caption. Shows when the user hovers a region. -->
    <div class="recovery-caption" class:hidden={!focused}>
      {#if focused}
        <span class="cap-name">{NAMES[focused] || focused}</span>
        <span class="cap-state" style="color:{fillFor(focused)}">{labelFor(focused)}</span>
        <span class="cap-meta">·  {hoursLabel(focused)}  ·  {recovery[focused]?.sets || 0} sets</span>
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
  .body-base {
    fill: color-mix(in srgb, var(--text-3) 14%, transparent);
    stroke: var(--border);
    stroke-width: 0.6;
  }
  .muscle {
    cursor: pointer;
    stroke: rgba(0,0,0,0.18);
    stroke-width: 0.6;
    transition: opacity var(--dur-fast);
  }
  .muscle:hover { opacity: 0.82; }
  .muscle:focus { outline: none; stroke: var(--accent); stroke-width: 1.2; }
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
