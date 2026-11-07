<script>
  /**
   * HoldTimer.svelte: the on-screen clock for a timed set (issue #89).
   *
   * During a plank the phone is usually on the floor, so the time is large
   * and Stop is a wide target; the small row button starts it, this is what
   * you actually look at. It sits where the rest bar does (starting a hold
   * stops any rest countdown, so the two never overlap) and publishes its
   * height so the workout-mode pill stacks above it.
   *
   * The screen is kept awake for the length of the hold, and released after,
   * unless the user already keeps it awake from Settings.
   *
   * An Alternating exercise is timed per side (issue #143): the label says
   * which side is up, Switch Sides ends the left side and counts the switch
   * down (tap it to start the right side at once), and the right side's
   * clock shows what the left side held.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { get } from 'svelte/store';
  import { _ } from 'svelte-i18n';
  import {
    holdTimer, holdElapsed, holdLeadIn, holdResult,
    stopHold, cancelHold, skipLeadIn, switchHoldSide, consumeHoldResult, resumeHoldTimer,
  } from '../../stores/holdTimer.js';
  import { wantScreenOn, enableWakeLock, disableWakeLock } from '../../stores/wakeLock.js';
  import { currentDate } from '../../stores/workout.js';
  import { fmtSetDuration } from '../../lib/workout.js';
  import { showError } from '../../stores/toast.js';

  // Opening the hold's own date is the Diary's job, not ours: setting
  // currentDate here would move the header without fetching that day, the
  // same bug the This Week strip had (#111). The Diary listens for this and
  // runs its own load.
  const dispatch = createEventDispatcher();

  onMount(resumeHoldTimer);

  $: state = $holdTimer;
  $: active = !!state;
  $: leadIn = $holdLeadIn;
  $: elapsed = $holdElapsed;
  $: target = state?.targetSec || 0;
  $: progress = target > 0 ? Math.min(1, elapsed / target) : 0;
  $: pastTarget = target > 0 && elapsed >= target;
  $: otherDate = active && state.date !== $currentDate;
  // A hold per side: which side is up, and the switch between them.
  $: side = active && state.sides ? (state.side === 'R' ? 'R' : 'L') : null;
  $: switching = side === 'R' && leadIn > 0;
  // Under the clock: the target, and on the right side what the left held.
  $: sub = [
    side === 'R' ? $_('hold_timer.left_held', { values: { time: clock(state.leftSec || 0) } }) : '',
    target > 0 ? (pastTarget ? $_('hold_timer.target_reached', { values: { time: clock(target) } }) : $_('hold_timer.target', { values: { time: clock(target) } })) : '',
  ].filter(Boolean).join(' · ');
  $: label = side === 'L' ? $_('hold_timer.side_left') : side === 'R' ? $_('hold_timer.side_right') : $_('hold_timer.label');

  function clock(sec) { return fmtSetDuration(sec) || '0:00'; }

  // Keep the screen on only for the hold, and only if we were the ones who
  // turned it on; a user who keeps the screen awake anyway is left alone.
  let tookWakeLock = false;
  $: if (active && !tookWakeLock && !get(wantScreenOn)) { tookWakeLock = true; enableWakeLock(); }
  $: if (!active && tookWakeLock) { tookWakeLock = false; disableWakeLock(); }
  onDestroy(() => { if (tookWakeLock) disableWakeLock(); });

  let barHeight = 0;
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--hold-h', active ? `${barHeight}px` : '0px');
  }
  onDestroy(() => {
    if (typeof document !== 'undefined') document.documentElement.style.setProperty('--hold-h', '0px');
  });

  // If no exercise card claims the result (the set was deleted mid-hold, or
  // it belongs to another session), still tell the user what they held so
  // it is not lost; they can type it in.
  let unclaimedTimer = null;
  function heldText(r) {
    if (!r.sideSec) return clock(r.elapsedSec);
    return $_('hold_timer.sides_held', { values: { left: clock(r.sideSec.l || 0), right: clock(r.sideSec.r || 0) } });
  }
  function stop() {
    const r = stopHold();
    if (!r || !r.held) return;
    clearTimeout(unclaimedTimer);
    unclaimedTimer = setTimeout(() => {
      const pending = get(holdResult);
      if (pending && pending.startedAt === r.startedAt) {
        consumeHoldResult();
        showError($_('hold_timer.set_not_found', { values: { time: heldText(r) } }));
      }
    }, 400);
  }
  onDestroy(() => clearTimeout(unclaimedTimer));
</script>

{#if active}
  <div class="hold-card" class:past-target={pastTarget} bind:clientHeight={barHeight}
    transition:fly={{ y: 40, duration: 240, easing: cubicOut }}
    role="timer" aria-live="off">
    {#if target > 0 && leadIn === 0}
      <div class="hold-progress" style="width:{progress * 100}%"></div>
    {/if}
    <div class="hold-content">
      <div class="hold-head">
        <span class="hold-label">{label}</span>
        <span class="hold-exercise">{state.exerciseName}</span>
      </div>

      {#if leadIn > 0}
        <button type="button" class="hold-clock lead" on:click={skipLeadIn}
          aria-label={$_(switching ? 'hold_timer.skip_switch' : 'hold_timer.skip_lead_in')}>{leadIn}</button>
        <span class="hold-sub">{switching ? $_('hold_timer.switch_ready', { values: { time: clock(state.leftSec || 0) } }) : $_('hold_timer.get_ready')}</span>
      {:else}
        <span class="hold-clock">{clock(elapsed)}</span>
        {#if target > 0 || side === 'R'}
          <span class="hold-sub">{sub}</span>
        {/if}
      {/if}

      {#if otherDate}
        <button type="button" class="hold-btn primary" on:click={() => dispatch('goToDate', state.date)}>
          {$_('hold_timer.open_date', { values: { date: state.date } })}
        </button>
      {:else}
        <div class="hold-actions">
          <button type="button" class="hold-btn" on:click={cancelHold}>{$_('hold_timer.cancel')}</button>
          {#if side === 'L' && leadIn === 0}
            <!-- The left side is done: on to the right, after a countdown. -->
            <button type="button" class="hold-btn primary" on:click={switchHoldSide}>
              <span class="material-symbols-rounded">swap_horiz</span>{$_('hold_timer.switch_sides')}
            </button>
          {:else}
            <button type="button" class="hold-btn primary" on:click={stop}>
              <span class="material-symbols-rounded">stop_circle</span>{$_('hold_timer.stop')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hold-card {
    position: fixed;
    left: 12px; right: 12px;
    bottom: calc(var(--nav-bar-h, var(--nav-h)) + var(--safe-bottom, 0px) + var(--mini-player-h, 0px) + 12px);
    max-width: 520px;
    margin: 0 auto;
    z-index: 42;
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
    border-radius: var(--radius-xl, 20px);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    overflow: hidden;
  }
  .hold-card.past-target {
    border-color: color-mix(in srgb, var(--success) 60%, transparent);
    background: color-mix(in srgb, var(--success) 12%, var(--surface-1));
  }
  .hold-progress {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    transition: width 0.3s linear;
    pointer-events: none;
  }
  .past-target .hold-progress { background: color-mix(in srgb, var(--success) 16%, transparent); }

  .hold-content {
    position: relative;
    display: flex; flex-direction: column; align-items: center;
    gap: 4px;
    padding: 12px 16px 14px;
  }
  .hold-head { display: flex; align-items: baseline; gap: 8px; max-width: 100%; }
  .hold-label { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; color: var(--accent); }
  .past-target .hold-label { color: var(--success); }
  .hold-exercise {
    font-size: 12px; color: var(--text-2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Readable from the floor mid-plank. */
  .hold-clock {
    font-size: 56px; line-height: 1.05; font-weight: 800;
    color: var(--text-1);
    font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
    background: none; border: none; padding: 0; font-family: inherit;
  }
  .hold-clock.lead { color: var(--accent); cursor: pointer; }
  .hold-sub { font-size: 12px; color: var(--text-3); }
  .past-target .hold-sub { color: var(--success); font-weight: 600; }

  .hold-actions { display: flex; gap: 8px; width: 100%; margin-top: 8px; }
  .hold-btn {
    flex: 1;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 48px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-1);
    font-size: 15px; font-weight: 700; font-family: inherit;
    cursor: pointer;
  }
  .hold-btn.primary {
    flex: 2;
    background: var(--accent); border-color: var(--accent); color: #fff;
  }
  .hold-content > .hold-btn.primary { width: 100%; margin-top: 8px; }
  .hold-btn .material-symbols-rounded { font-size: 22px; }
</style>
