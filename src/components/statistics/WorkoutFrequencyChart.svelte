<script>
  /**
   * Workouts-per-week chart. Shared by Statistics' Overview + Frequency views.
   * Mirrors WeeklyVolumeChart.svelte — same multi-week / solo / empty behaviour.
   */
  import { fmtWeekLabel } from '../../lib/statsFormat.js';

  export let frequency = [];   // [{ week, count }]
  export let detailed = false;
  export let avg = 0;
  /** Weekly workout goal (from settings). When > 0 AND ≤ max bar, we
   *  render a dashed horizontal line across the chart at that y-position
   *  so the user can see which weeks hit target at a glance. */
  export let goal = 0;

  $: max = frequency.length ? Math.max(...frequency.map(f => f.count)) : 0;
  // Height % from the bottom of the chart. Using the SAME max as the bars,
  // so an uncapped goal that exceeds max renders at the top edge.
  $: goalHeightPct = goal > 0 && max > 0 ? Math.min(100, (goal / max) * 100) : 0;
</script>

{#if frequency.length >= 2}
  <div class="chart-card">
    <h3 class="chart-title">Workouts per Week</h3>
    {#if detailed}
      <p class="chart-desc">Training days logged each week in this range.</p>
    {/if}
    <div class="bar-chart">
      {#if goalHeightPct > 0}
        <div class="goal-line" style="bottom: {goalHeightPct}%" title="Weekly goal: {goal}">
          <span class="goal-label">Goal {goal}</span>
        </div>
      {/if}
      {#each frequency as f}
        <div class="bar-col">
          <div class="bar freq" class:hit-goal={goal > 0 && f.count >= goal} style="height: {max ? (f.count / max * 100) : 0}%"
            title={`${f.week}: ${f.count} workouts${goal > 0 ? (f.count >= goal ? ' (hit goal)' : '') : ''}`}></div>
          <span class="bar-label">{fmtWeekLabel(f.week)}</span>
        </div>
      {/each}
    </div>
    {#if detailed}
      <p class="chart-sub">Average: {avg} workouts/week</p>
    {/if}
  </div>
{:else if frequency.length === 1}
  <div class="chart-card">
    <h3 class="chart-title">Workouts per Week</h3>
    {#if detailed}
      <p class="chart-desc">Training days logged each week in this range.</p>
    {/if}
    <div class="solo-stat">
      <span class="solo-value">{frequency[0].count}</span>
      <span class="solo-label">This week</span>
    </div>
    {#if detailed}
      <p class="chart-sub">Log another week to see trends.</p>
    {/if}
  </div>
{/if}

<style>
  .chart-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 16px;
  }
  .chart-title { font-size: 14px; font-weight: 700; color: var(--text-1); margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
  .chart-sub  { font-size: 12px; color: var(--text-3); margin: 10px 0 0; text-align: center; }
  .chart-desc { font-size: 12px; color: var(--text-3); margin: -8px 0 12px; line-height: 1.4; }

  .solo-stat {
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 16px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border-radius: var(--radius-md); gap: 6px;
  }
  .solo-value { font-size: 28px; font-weight: 800; color: var(--accent); line-height: 1; font-variant-numeric: tabular-nums; }
  .solo-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); font-weight: 600; }

  .bar-chart { position: relative; display: flex; align-items: flex-end; gap: 4px; height: 120px; padding: 0 2px; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; min-width: 0; }
  .bar {
    width: 100%; min-height: 4px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    border-radius: 3px 3px 0 0;
    transition: height var(--dur-slow);
  }
  .bar.freq { background: linear-gradient(180deg, var(--info), var(--accent-2)); }
  .bar.freq.hit-goal {
    background: linear-gradient(180deg, var(--success, #2FD66F), var(--accent-2));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--success, #2FD66F) 40%, transparent);
  }
  .bar-label { font-size: 9px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  /* Horizontal goal reference line */
  .goal-line {
    position: absolute; left: 2px; right: 2px;
    height: 0;
    border-top: 1.5px dashed color-mix(in srgb, var(--success, #2FD66F) 70%, transparent);
    pointer-events: none;
    z-index: 1;
  }
  .goal-label {
    position: absolute; right: 0; top: -7px;
    background: var(--surface-1);
    color: var(--success, #2FD66F);
    font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
    padding: 0 6px;
    border-radius: var(--radius-sm);
  }
</style>
