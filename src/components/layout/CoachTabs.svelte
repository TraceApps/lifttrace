<script>
  // Programs | Coach | Coaching. Coach is for someone with a coach or a
  // request to answer; Coaching is for trainers and admins, as before.
  // Everyone else gets nothing here, so Programs looks exactly as it did.
  import { _ } from 'svelte-i18n';
  import { currentUser } from '../../stores/auth.js';
  import { location, push } from 'svelte-spa-router';
  import { coachTab } from '../../stores/coaching.js';

  // Shown on the Coach page even while the state is still loading, so
  // arriving there by link never strands anyone.
  export let force = false;

  $: isCoach = $currentUser?.role === 'trainer' || $currentUser?.role === 'admin';
  $: current = $location.startsWith('/coaching') ? 'coaching' : $location.startsWith('/coach') ? 'coach' : 'programs';
  $: tabs = [
    { key: 'programs', path: '/programs', icon: 'calendar_month', label: $_('nav.programs') },
    ...($coachTab || (force && current === 'coach') ? [{ key: 'coach', path: '/coach', icon: 'sports', label: $_('coaching.tabs.coach') }] : []),
    ...(isCoach ? [{ key: 'coaching', path: '/coaching', icon: 'supervisor_account', label: $_('coaching.tabs.coaching') }] : []),
  ];
</script>

{#if tabs.length > 1}
  <div class="coach-tabs" role="tablist" aria-label={$_('coaching.tabs.aria')}>
    {#each tabs as t (t.key)}
      <button class="tab" class:active={current === t.key} role="tab" aria-selected={current === t.key}
        on:click={() => { if (current !== t.key) push(t.path); }}>
        <span class="material-symbols-rounded icon">{t.icon}</span>
        <span>{t.label}</span>
      </button>
    {/each}
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
