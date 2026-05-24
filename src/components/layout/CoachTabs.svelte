<script>
  import { currentUser } from '../../stores/auth.js';
  import { location, push } from 'svelte-spa-router';

  $: isCoach = $currentUser?.role === 'trainer' || $currentUser?.role === 'admin';
  $: current = $location.startsWith('/coaching') ? 'coaching' : 'programs';
</script>

{#if isCoach}
  <div class="coach-tabs">
    <button class="tab" class:active={current === 'programs'} on:click={() => push('/programs')}>
      <span class="material-symbols-rounded icon">calendar_month</span>
      <span>Programs</span>
    </button>
    <button class="tab" class:active={current === 'coaching'} on:click={() => push('/coaching')}>
      <span class="material-symbols-rounded icon">supervisor_account</span>
      <span>Coaching</span>
    </button>
  </div>
{/if}

<style>
  .coach-tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    /* 12px top margin to match the breathing room the Exercises search bar
       has under its page header — keeps the pill from kissing the title. */
    margin: 12px var(--page-px);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 12px;
    background: none;
    border: none;
    border-radius: var(--radius-md);
    color: var(--text-3);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), transform var(--dur-fast);
    font-family: inherit;
  }
  .tab:hover:not(.active) { color: var(--text-1); }
  .tab:active { transform: scale(0.98); }
  .tab.active {
    background: var(--surface-1);
    color: var(--accent);
    box-shadow: 0 1px 3px rgba(0,0,0,0.25), inset 0 0 0 1px var(--border);
  }
  .icon { font-size: 18px; }
</style>
