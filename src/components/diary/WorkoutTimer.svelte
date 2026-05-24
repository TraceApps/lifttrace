<script>
  import { createEventDispatcher } from 'svelte';
  import { currentDate } from '../../stores/workout.js';
  import { timerState, timerMs, startTimer, pauseTimer, resumeTimer, formatTimerMs } from '../../stores/workoutTimer.js';

  export let minutes = 0;

  const dispatch = createEventDispatcher();

  $: active = $timerState && $timerState.date === $currentDate;
  $: running = active && !$timerState.paused;
  $: paused = active && $timerState.paused;

  function toggle() {
    if (running) {
      pauseTimer();
    } else if (paused) {
      resumeTimer();
    } else {
      startTimer($currentDate, minutes || 0);
    }
  }

  $: displayTime = active
    ? formatTimerMs($timerMs, { centi: true })
    : formatTimerMs((minutes || 0) * 60000, { centi: false });
</script>

<div class="timer" class:running class:paused>
  <button class="timer-btn" on:click={toggle}
    title={running ? 'Pause workout timer' : paused ? 'Resume workout timer' : 'Start workout timer'}
    aria-label={running ? 'Pause workout timer' : paused ? 'Resume workout timer' : 'Start workout timer'}>
    <span class="material-symbols-rounded timer-icon">
      {running ? 'pause' : 'play_arrow'}
    </span>
    <span class="timer-val">{displayTime}</span>
  </button>
</div>

<style>
  .timer { display: flex; align-items: center; gap: 4px; }
  .timer-btn {
    display: flex; align-items: center; gap: 4px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 6px 12px;
    color: var(--text-2); font-size: 13px; font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .timer.running .timer-btn {
    background: var(--accent-dim); border-color: var(--accent); color: var(--accent);
    min-width: 100px; justify-content: center;
  }
  .timer.paused .timer-btn {
    background: var(--surface-2); border-color: var(--accent); color: var(--text-2);
    min-width: 100px; justify-content: center;
  }
  .timer-icon { font-size: 16px; }
  .timer-val { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
</style>
