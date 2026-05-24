<script>
  /**
   * Compact inline trend visualizer. Two modes:
   *   type="bars"  — tiny bar-per-value, auto-scaled to the max.
   *   type="dots"  — one dot per value; dot is "filled" if the value is truthy.
   *                  Useful for binary time series (workout / no workout).
   *
   * Values is a plain array of numbers (bars) or booleans / 0-or-1 (dots).
   * Width + height are fixed so the SVG renders crisp at small sizes.
   */
  export let values = [];
  export let type = 'bars';          // 'bars' | 'dots'
  export let width = 80;
  export let height = 22;
  export let color = 'currentColor'; // defaults to text color — caller overrides with var(--accent)

  $: _values = Array.isArray(values) ? values : [];
  $: _max   = _values.length ? Math.max(1, ...(_values.map(v => +v || 0))) : 1;

  // For dots: pack evenly across width with fixed radius. Inset by _dotR
  // on each side so the first/last dots aren't half-clipped at the
  // viewBox boundary (the SVG itself can also be visually clipped by a
  // narrower parent — see .sparkline CSS for the responsive shrink).
  $: _dotR     = Math.max(2, Math.min(3, Math.floor(height / 6)));
  $: _dotInner = Math.max(0, width - 2 * _dotR);
  $: _dotStep  = _values.length > 1 ? _dotInner / (_values.length - 1) : 0;

  // For bars: narrow bar with a small gap
  $: _barGap   = Math.max(1, Math.floor(width / (_values.length || 1) / 6));
  $: _barWidth = _values.length ? Math.max(1, width / _values.length - _barGap) : 0;
</script>

<svg class="sparkline" viewBox="0 0 {width} {height}" width={width} height={height} preserveAspectRatio="none" aria-hidden="true">
  {#if type === 'bars'}
    {#each _values as v, i}
      {@const h = Math.max(1, ((+v || 0) / _max) * (height - 2))}
      <rect
        x={i * (width / _values.length) + _barGap / 2}
        y={height - h}
        width={_barWidth}
        height={h}
        rx={Math.min(1.5, _barWidth / 2)}
        fill={color}
        opacity={v ? 1 : 0.25}
      />
    {/each}
  {:else}
    {#each _values as v, i}
      <circle
        cx={_values.length > 1 ? _dotR + i * _dotStep : width / 2}
        cy={height / 2}
        r={_dotR}
        fill={v ? color : 'transparent'}
        stroke={color}
        stroke-width="1"
        opacity={v ? 1 : 0.35}
      />
    {/each}
  {/if}
</svg>

<style>
  /* Allow the sparkline to shrink inside narrow cards (the 4-up summary
     row on mobile compresses each card below the SVG's intrinsic width).
     viewBox + preserveAspectRatio="none" handles the actual scaling. */
  .sparkline { display: block; color: inherit; max-width: 100%; height: auto; }
</style>
