<script>
  /**
   * PhotoScrubber.svelte
   *
   * The "watch the whole arc" view: one photo full-frame with a draggable
   * date track under it, so you can sweep across months instead of opening
   * one photo at a time. This is what the compare slider cannot do. Compare
   * answers "how do these two dates differ", the grid answers "find me a
   * particular photo", and neither shows the shape of the change over the
   * whole record, which is the part that actually motivates anyone: any two
   * adjacent photos look identical, so progress is only visible in the sweep.
   *
   * It replaces the old tap-to-enlarge sheet rather than adding a fourth
   * mode. Tapping a tile already meant "show me this one big"; now you can
   * also travel in time from wherever you landed, with no extra toggle and
   * no closing the sheet to reach the next date.
   *
   * The track is a true date axis, not one tick per photo: a three-month
   * gap in the record is itself worth seeing, and evenly spacing the photos
   * would quietly hide it.
   */
  import { onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { prefetchPhoto } from '../../lib/photo-blobs.js';
  import PhotoImage from './PhotoImage.svelte';
  import { weightUnit } from '../../stores/settings.js';
  import WeightQuickLog from './WeightQuickLog.svelte';

  /** @type {Array<{id:number, date:string, url:string}>} newest-first, as the timeline holds them */
  export let photos = [];
  /** Which photo to open on (the tile that was tapped). */
  export let startId = null;
  /** Optional lookup so the weight logged that day can ride along. */
  export let weightFor = () => null;

  const MS_PER_DAY = 86400000;
  const PLAY_MS = 450;
  const PRELOAD_RADIUS = 3;

  // Oldest first: dragging left to right should move forward in time.
  $: ordered = [...photos].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  let idx = -1;
  $: if (idx < 0 && ordered.length) {
    const found = ordered.findIndex((p) => p.id === startId);
    idx = found >= 0 ? found : ordered.length - 1;
  }
  $: current = ordered[idx] || null;

  // Positions along the axis, as a percentage of the full date span. If every
  // photo shares one date there is no span to divide by, so fall back to even
  // spacing rather than stacking every tick on top of itself.
  $: times = ordered.map((p) => {
    const t = new Date(`${p.date}T00:00:00`).getTime();
    return isNaN(t) ? 0 : t;
  });
  $: spanStart = times[0] ?? 0;
  $: spanEnd = times[times.length - 1] ?? 0;
  $: degenerate = !(spanEnd > spanStart);
  $: positions = ordered.map((_p, i) => {
    if (degenerate) return ordered.length === 1 ? 50 : (i / (ordered.length - 1)) * 100;
    return ((times[i] - spanStart) / (spanEnd - spanStart)) * 100;
  });
  $: thumbPct = positions[idx] ?? 0;

  // Decoding a year of weekly photos mid-drag would stutter, so keep a window
  // around the cursor warm (plus both ends, which the arrow keys jump to)
  // rather than loading the whole set up front on someone's mobile data.
  function preloadAround(i) {
    const wanted = [];
    for (let d = -PRELOAD_RADIUS; d <= PRELOAD_RADIUS; d++) {
      if (ordered[i + d]) wanted.push(ordered[i + d]);
    }
    if (ordered[0]) wanted.push(ordered[0]);
    if (ordered[ordered.length - 1]) wanted.push(ordered[ordered.length - 1]);
    // prefetchPhoto dedupes in-flight requests, caches successes AND
    // failures, and skips rows that need no fetch, so repeated calls while
    // dragging cost nothing after the first.
    for (const p of wanted) prefetchPhoto(p);
  }
  $: if (idx >= 0 && ordered.length) preloadAround(idx);

  let trackEl;
  let dragging = false;

  // Snap to the nearest photo rather than letting the thumb rest between two:
  // there is nothing to show at an empty point on the axis.
  function setFromClientX(clientX) {
    if (!trackEl || !ordered.length) return;
    const r = trackEl.getBoundingClientRect();
    if (!r.width) return;
    const pct = Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < positions.length; i++) {
      const d = Math.abs(positions[i] - pct);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    idx = best;
  }

  function onPointerDown(e) {
    stop();
    dragging = true;
    trackEl?.setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    setFromClientX(e.clientX);
  }
  function onPointerUp(e) {
    dragging = false;
    trackEl?.releasePointerCapture?.(e.pointerId);
  }

  function step(delta) {
    if (!ordered.length) return;
    idx = Math.min(ordered.length - 1, Math.max(0, idx + delta));
  }
  function onKeyDown(e) {
    const jump = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft')  { stop(); step(-jump); e.preventDefault(); }
    if (e.key === 'ArrowRight') { stop(); step(jump);  e.preventDefault(); }
    if (e.key === 'Home')       { stop(); idx = 0; e.preventDefault(); }
    if (e.key === 'End')        { stop(); idx = ordered.length - 1; e.preventDefault(); }
  }

  // Play is the point of a time axis: the change is gradual enough that
  // dragging by hand tends to undersell it.
  let timer = null;
  $: playing = timer !== null;
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function togglePlay() {
    if (playing) { stop(); return; }
    if (ordered.length < 2) return;
    if (idx >= ordered.length - 1) idx = 0;   // replay from the start
    timer = setInterval(() => {
      if (idx >= ordered.length - 1) { stop(); return; }
      idx += 1;
    }, PLAY_MS);
  }
  onDestroy(stop);

  function fmtDate(d) {
    if (!d) return '';
    const parsed = new Date(`${d}T00:00:00`);
    return isNaN(parsed) ? d : parsed.toLocaleDateString();
  }

  // Weights logged from here before the parent has refetched. Without this
  // the number you just typed would vanish until the sheet is reopened.
  //
  // `overrides` is threaded through as an argument rather than read from the
  // closure on purpose: Svelte tracks only what a reactive statement mentions
  // by name, so a bare weightAt(date) helper would leave `baseline` and
  // `delta` stale after a save, showing the new weight beside a delta still
  // computed from the old one.
  let localWeights = new Map();
  let logging = false;
  function weightAt(date, overrides) {
    if (overrides.has(date)) return overrides.get(date);
    return weightFor(date);
  }
  function onWeightSaved(e) {
    localWeights.set(e.detail.date, e.detail.weight);
    localWeights = localWeights;
    logging = false;
  }

  // Scrubbing away closes an open editor, so it cannot be left hanging over
  // a photo it no longer belongs to.
  let lastSeenDate = null;
  $: if (current && current.date !== lastSeenDate) {
    lastSeenDate = current.date;
    logging = false;
  }

  $: currentWeight = current ? weightAt(current.date, localWeights) : null;

  // The bare number is close to meaningless while scrubbing; the change since
  // the first weighed photo is the thing worth reading. Baseline is the
  // earliest photo that actually has a weight, not simply the earliest photo.
  $: baseline = (() => {
    for (const p of ordered) {
      const w = weightAt(p.date, localWeights);
      if (w != null && Number.isFinite(parseFloat(w))) {
        return { date: p.date, weight: parseFloat(w) };
      }
    }
    return null;
  })();
  $: delta = (() => {
    if (!current || !baseline || current.date === baseline.date) return null;
    const w = parseFloat(weightAt(current.date, localWeights));
    if (!Number.isFinite(w)) return null;
    const diff = w - baseline.weight;
    if (Math.abs(diff) < 0.05) return null;
    // Rounded to one decimal: scale precision beyond that is noise.
    const rounded = Math.round(Math.abs(diff) * 10) / 10;
    return { text: `${diff > 0 ? '+' : '-'}${rounded}`, since: baseline.date };
  })();
  // "Day 0" is the first photo, which is the number someone actually wants
  // while scrubbing: how long this took, not the calendar date.
  $: dayOffset = (() => {
    if (degenerate || idx < 0) return null;
    const days = Math.round((times[idx] - spanStart) / MS_PER_DAY);
    return days > 0 ? days : null;
  })();
</script>

<div class="scrub">
  {#if current}
    <div class="frame">
      <PhotoImage photo={current} alt={fmtDate(current.date)} lazy={false} />
      <div class="stamp">
        <span class="stamp-date">{fmtDate(current.date)}</span>
        {#if currentWeight != null}
          <span class="stamp-sub">{currentWeight} {$weightUnit}</span>
          {#if delta}
            <span class="stamp-delta">
              {$_('progress.scrub.since', {
                values: { delta: delta.text, unit: $weightUnit, date: fmtDate(delta.since) },
              })}
            </span>
          {/if}
        {:else if logging}
          <WeightQuickLog
            date={current.date}
            onDark
            on:saved={onWeightSaved}
            on:cancel={() => logging = false}
          />
        {:else}
          <button class="stamp-add" on:click={() => logging = true}>
            {$_('progress.weight.add')}
          </button>
        {/if}
        {#if dayOffset != null}
          <span class="stamp-sub">{$_('progress.scrub.day_n', { values: { n: dayOffset } })}</span>
        {/if}
      </div>
    </div>

    <div class="controls">
      <button
        type="button"
        class="play btn-icon"
        disabled={ordered.length < 2}
        title={playing ? $_('progress.scrub.pause') : $_('progress.scrub.play')}
        aria-label={playing ? $_('progress.scrub.pause') : $_('progress.scrub.play')}
        on:click={togglePlay}
      >
        <span class="material-symbols-rounded">{playing ? 'pause' : 'play_arrow'}</span>
      </button>

      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div
        class="track"
        bind:this={trackEl}
        data-no-pull-sync
        on:pointerdown={onPointerDown}
        on:pointermove={onPointerMove}
        on:pointerup={onPointerUp}
        on:pointercancel={onPointerUp}
      >
        <div class="rail"></div>
        {#each positions as pos, i}
          <span class="tick" class:active={i === idx} style="left: {pos}%"></span>
        {/each}
        <button
          type="button"
          class="thumb"
          class:dragging
          style="left: {thumbPct}%"
          role="slider"
          aria-label={$_('progress.scrub.handle_label')}
          aria-valuemin="0"
          aria-valuemax={Math.max(0, ordered.length - 1)}
          aria-valuenow={idx}
          aria-valuetext={fmtDate(current.date)}
          on:keydown={onKeyDown}
        ></button>
      </div>
    </div>

    <div class="ends">
      <span>{fmtDate(ordered[0]?.date)}</span>
      <span>{fmtDate(ordered[ordered.length - 1]?.date)}</span>
    </div>
  {/if}
</div>

<style>
  .scrub {
    display: flex; flex-direction: column;
    width: 100%; height: 100%;
    padding: 8px;
    gap: 8px;
  }

  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    overflow: hidden;
  }

  .stamp {
    position: absolute; bottom: 10px; left: 10px;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    max-width: calc(100% - 20px);
    padding: 5px 10px; border-radius: var(--radius-lg);
    background: rgba(0, 0, 0, 0.55);
    /* Not pointer-events:none any more: the weight control lives in here. */
  }
  .stamp-date { font-size: 12px; font-weight: 700; color: #fff; }
  .stamp-sub  { font-size: 11px; color: rgba(255, 255, 255, 0.75); }
  .stamp-delta {
    font-size: 11px; font-weight: 600;
    color: var(--accent);
  }
  .stamp-add {
    background: none; border: none; padding: 0;
    font-size: 11px; font-weight: 600; font-family: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  .controls { display: flex; align-items: center; gap: 10px; padding: 0 4px; }
  .play { flex-shrink: 0; }
  .play .material-symbols-rounded { font-size: 26px; color: var(--accent); }
  .play:disabled { opacity: 0.4; cursor: default; }

  /* The rail is thin but the grab area is not: a 2px line is an unusable
     touch target, so the padding around it belongs to the drag. */
  .track {
    position: relative;
    flex: 1;
    height: 44px;
    touch-action: none;
    cursor: pointer;
  }
  .rail {
    position: absolute; top: 50%; left: 0; right: 0;
    height: 3px; margin-top: -1.5px;
    border-radius: var(--radius-full);
    background: var(--surface-3, var(--border));
  }
  .tick {
    position: absolute; top: 50%;
    width: 2px; height: 10px; margin-top: -5px;
    transform: translateX(-1px);
    border-radius: 1px;
    background: var(--text-3);
    opacity: 0.55;
    pointer-events: none;
  }
  .tick.active { opacity: 0; }

  .thumb {
    position: absolute; top: 50%;
    width: 22px; height: 22px;
    margin: -11px 0 0 -11px;
    padding: 0;
    border: 2px solid var(--surface-1);
    border-radius: var(--radius-full);
    background: var(--accent);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    cursor: grab;
    transition: left var(--dur-fast) var(--ease-out);
  }
  .thumb.dragging { cursor: grabbing; transition: none; }
  .thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

  .ends {
    display: flex; justify-content: space-between;
    padding: 0 4px 4px;
    font-size: 11px; color: var(--text-3);
  }
</style>
