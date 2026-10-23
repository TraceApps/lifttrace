<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { restTimer, restRemaining, addRestTime, stopRest, pauseRest, resumeRest } from '../../stores/restTimer.js';
  import { REST_ADD_SEC } from '../../lib/rest-state.js';

  $: state     = $restTimer;
  $: remaining = $restRemaining;
  $: active    = !!state;
  $: paused    = !!state?.paused;
  $: displayMin = Math.floor(Math.max(remaining, 0) / 60);
  $: displaySec = Math.floor(Math.max(remaining, 0) % 60);
  $: progress   = state && state.total > 0 ? Math.min(1, 1 - remaining / state.total) : 0;
  $: nearDone   = !paused && remaining <= 5;

  // Publish the bar height to :root so WorkoutModeBar can stack above it.
  function _setHeightVar(on) {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--rest-h', on ? '68px' : '0px');
  }
  $: _setHeightVar(active);
</script>

{#if active}
  <div class="rest-sticky" class:near-done={nearDone} class:paused
    transition:fly={{ y: 40, duration: 240, easing: cubicOut }}>
    <div class="rest-progress" style="width:{progress * 100}%"></div>
    <div class="rest-content">
      <div class="rest-label-col">
        <span class="rest-label">{paused ? $_('rest_bar.paused_label') : $_('rest_bar.label')}</span>
        {#if state.exerciseName}<span class="rest-exercise">{$_('rest_bar.next', { values: { name: state.exerciseName } })}</span>{/if}
      </div>
      <div class="rest-time-col">
        <span class="rest-time">{displayMin}:{String(displaySec).padStart(2, '0')}</span>
      </div>
      <div class="rest-actions">
        <button class="rest-btn" on:click={() => addRestTime(REST_ADD_SEC)} title={$_('rest_bar.add_title', { values: { s: REST_ADD_SEC } })}>{$_('rest_bar.add', { values: { s: REST_ADD_SEC } })}</button>
        <button class="rest-btn icon" on:click={() => (paused ? resumeRest() : pauseRest())}
          title={paused ? $_('rest_bar.resume') : $_('rest_bar.pause')}
          aria-label={paused ? $_('rest_bar.resume') : $_('rest_bar.pause')}>
          <span class="material-symbols-rounded">{paused ? 'play_arrow' : 'pause'}</span>
        </button>
        <button class="rest-btn icon" on:click={() => stopRest(false)} title={$_('rest_bar.skip')} aria-label={$_('rest_bar.skip')}>
          <span class="material-symbols-rounded">skip_next</span>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rest-sticky {
    position: fixed;
    left: 12px; right: 12px;
    /* Sit directly above the mini-player. The workout-mode pill floats
       above us via `--rest-h` (published by this component). */
    bottom: calc(var(--nav-bar-h, var(--nav-h)) + var(--safe-bottom, 0px) + var(--mini-player-h, 0px) + 12px);
    max-width: 520px;
    margin: 0 auto;
    z-index: 41;
    background: color-mix(in srgb, var(--danger, #FF5C5C) 14%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--danger, #FF5C5C) 55%, transparent);
    border-radius: var(--radius-full);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 0 32px color-mix(in srgb, var(--danger, #FF5C5C) 18%, transparent);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    overflow: hidden;
  }
  .rest-sticky.near-done { animation: rest-pulse 0.6s ease-in-out infinite alternate; }
  @keyframes rest-pulse {
    to { box-shadow: 0 10px 28px rgba(0,0,0,0.45), 0 0 48px color-mix(in srgb, var(--danger, #FF5C5C) 45%, transparent); }
  }
  .rest-progress {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: color-mix(in srgb, var(--danger, #FF5C5C) 22%, transparent);
    transition: width 0.3s linear;
    pointer-events: none;
  }
  .rest-content { position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
  .rest-label-col { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .rest-label { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; color: var(--danger, #FF5C5C); }
  .rest-exercise { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rest-time-col { display: flex; align-items: center; }
  .rest-time { font-size: 26px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .rest-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .rest-btn {
    padding: 5px 12px; border-radius: var(--radius-full);
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.14);
    color: var(--text-1);
    font-size: 11px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background var(--dur-fast);
  }
  .rest-btn:hover { background: rgba(255,255,255,0.14); }
  .rest-btn.icon { padding: 5px 8px; }
  /* Held: the bar and the number stop, and the time reads as waiting. */
  .rest-sticky.paused .rest-label { color: var(--text-3); }
  .rest-sticky.paused .rest-time { color: var(--text-2); }
  .rest-btn .material-symbols-rounded { font-size: 18px; }
</style>
