<script>
  import { push } from 'svelte-spa-router';
  import { timerState, timerMs, formatTimerMs, pauseTimer, resumeTimer, resetTimer } from '../stores/workoutTimer.js';
  import { wantScreenOn, screenOn, toggleWakeLock } from '../stores/wakeLock.js';
  import { miniPlayerVisible } from '../stores/player.js';

  $: active = !!$timerState;              // running OR paused
  $: running = $timerState && !$timerState.paused;
  $: paused = $timerState && $timerState.paused;
  $: visible = active || $wantScreenOn;
  $: display = active ? formatTimerMs($timerMs) : '';

  function goToDiary() { push('/'); }
  function toggle() { paused ? resumeTimer() : pauseTimer(); }

  // × is a SAFE dismiss — it only clears the floating pill. It does NOT
  // wipe `duration_min` on the workout. If a user has finished a workout
  // they can tap × and the saved duration stays intact. Previously this
  // zero-ed out duration_min which meant tapping × cancelled a completed
  // workout's time — scary and confusing.
  function dismiss() { resetTimer(); }
</script>

{#if visible}
  <div class="wm-bar" class:above-miniplayer={$miniPlayerVisible}>
    {#if active}
      <button class="wm-toggle" class:paused on:click={toggle}
        title={paused ? 'Resume timer' : 'Pause timer'}
        aria-label={paused ? 'Resume timer' : 'Pause timer'}>
        <span class="material-symbols-rounded">{paused ? 'play_arrow' : 'pause'}</span>
      </button>
      <button class="wm-timer" class:paused on:click={goToDiary} title="Open diary">
        {#if running}<span class="wm-dot"></span>{/if}
        <span class="wm-time">{display}</span>
      </button>
      <button class="wm-reset" on:click={dismiss} title="Dismiss timer (saved duration kept)" aria-label="Dismiss timer">
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
    <button class="wm-wake" class:on={$screenOn} on:click={toggleWakeLock}
      title={$screenOn ? 'Screen keep-awake on — tap to disable' : 'Screen keep-awake off — tap to enable'}
      aria-label="Toggle screen keep-awake">
      <span class="material-symbols-rounded">
        {$screenOn ? 'stay_current_portrait' : 'screen_lock_portrait'}
      </span>
    </button>
  </div>
{/if}

<style>
  .wm-bar {
    position: fixed;
    /* Add --rest-h (set by RestTimer when active, 0 otherwise) so the pill
       floats above the rest bar when resting. Smoothly animated. */
    transition: bottom 0.26s cubic-bezier(0.22, 1, 0.36, 1);
    bottom: calc(var(--nav-bar-h, var(--nav-h)) + var(--safe-bottom, 0px) + var(--rest-h, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(10, 11, 15, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-full);
    padding: 4px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
    backdrop-filter: blur(28px) saturate(200%);
    -webkit-backdrop-filter: blur(28px) saturate(200%);
  }
  .wm-bar.above-miniplayer {
    bottom: calc(var(--nav-bar-h, var(--nav-h)) + var(--safe-bottom, 0px) + var(--mini-player-h, 0px) + var(--rest-h, 0px) + 12px);
  }

  .wm-toggle {
    display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: 50%;
    width: 36px; height: 36px;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .wm-toggle.paused {
    background: var(--surface-2); color: var(--accent);
    border-color: var(--accent);
  }
  .wm-toggle:hover { transform: scale(1.05); }
  .wm-toggle:active { transform: scale(0.95); }
  .wm-toggle .material-symbols-rounded { font-size: 20px; }

  .wm-timer {
    display: flex; align-items: center; gap: 6px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-full);
    padding: 6px 14px 6px 12px;
    color: var(--accent);
    font-size: 14px; font-weight: 700;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    transition: transform var(--dur-fast);
  }
  .wm-timer.paused {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text-2);
  }
  .wm-timer:hover { transform: scale(1.03); }
  .wm-timer:active { transform: scale(0.97); }

  .wm-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
    animation: wm-pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes wm-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.4; transform: scale(0.75); }
  }
  .wm-time { letter-spacing: 0.02em; }

  .wm-reset {
    display: flex; align-items: center; justify-content: center;
    background: none; border: none;
    border-radius: 50%;
    width: 28px; height: 28px;
    color: var(--text-3);
    cursor: pointer;
    transition: all var(--dur-fast);
    margin-left: -2px;
  }
  .wm-reset:hover { color: var(--danger); }
  .wm-reset:active { transform: scale(0.9); }
  .wm-reset .material-symbols-rounded { font-size: 16px; }

  .wm-wake {
    display: flex; align-items: center; justify-content: center;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 50%;
    width: 36px; height: 36px;
    color: var(--text-3);
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .wm-wake.on {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }
  .wm-wake:hover { transform: scale(1.05); }
  .wm-wake:active { transform: scale(0.95); }
  .wm-wake .material-symbols-rounded { font-size: 18px; }
</style>
