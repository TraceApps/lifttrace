<script>
  /**
   * Weekly volume bar chart. Shared by Statistics' Overview + Volume views.
   * - Multi-week: renders the bar chart.
   * - Single-week: renders the solo-stat card.
   * - Zero weeks: renders nothing; parent decides the empty state.
   */
  import { fmtVol, fmtWeekLabel } from '../../lib/statsFormat.js';

  export let volume = [];   // [{ week, volume }]
  export let unit = 'lbs';
  /** When true, show the 'Total · Peak' footer and the description line. */
  export let detailed = false;
  /** Total volume across weeks for the footer (caller computes it). */
  export let total = 0;

  $: max = volume.length ? Math.max(...volume.map(v => v.volume)) : 0;
</script>

{#if volume.length >= 2}
  <div class="chart-card">
    <h3 class="chart-title">Weekly Volume</h3>
    {#if detailed}
      <p class="chart-desc">Total weight moved each week (weight × reps across all completed sets).</p>
    {/if}
    <div class="bar-chart">
      {#each volume as v}
        <div class="bar-col">
          <div class="bar" style="height: {max ? (v.volume / max * 100) : 0}%"
            title={`${v.week}: ${fmtVol(v.volume)} ${unit}`}></div>
          <span class="bar-label">{fmtWeekLabel(v.week)}</span>
        </div>
      {/each}
    </div>
    {#if detailed}
      <p class="chart-sub">Total: {fmtVol(total)} {unit} · Peak: {fmtVol(max)} {unit}</p>
    {/if}
  </div>
{:else if volume.length === 1}
  <div class="chart-card">
    <h3 class="chart-title">Weekly Volume</h3>
    {#if detailed}
      <p class="chart-desc">Total weight moved each week (weight × reps across all completed sets).</p>
    {/if}
    <div class="solo-stat">
      <span class="solo-value">{fmtVol(volume[0].volume)} {unit}</span>
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

  .bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding: 0 2px; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; min-width: 0; }
  .bar {
    width: 100%; min-height: 4px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    border-radius: 3px 3px 0 0;
    transition: height var(--dur-slow);
  }
  .bar-label { font-size: 9px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
</style>
