<script>
  import { location, push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { radioEnabled, radioUrl, radioStationsEnabled } from '../../stores/settings.js';
  import { updateAvailable } from '../../lib/updates.js';
  import { pwaUpdateReady } from '../../lib/pwa-update.js';

  $: BASE_TABS = [
    { path: '/',           icon: 'today',          label: $_('nav.diary')      },
    { path: '/exercises',  icon: 'fitness_center', label: $_('nav.exercises')  },
    { path: '/programs',   icon: 'calendar_month', label: $_('nav.programs')   },
    { path: '/statistics', icon: 'bar_chart',      label: $_('nav.statistics') },
  ];
  $: RADIO_TAB    = { path: '/radio',    icon: 'radio',    label: $_('nav.radio')    };
  $: SETTINGS_TAB = { path: '/settings', icon: 'settings', label: $_('nav.settings') };

  // Show the Radio tab if EITHER self-hosted music is configured OR streaming
  // stations is on. The two features are independent — stations work without
  // any music server configured.
  $: showRadio = ($radioEnabled && $radioUrl) || $radioStationsEnabled;
  $: TABS = showRadio ? [...BASE_TABS, RADIO_TAB, SETTINGS_TAB] : [...BASE_TABS, SETTINGS_TAB];

  $: activeIdx = (() => {
    const base = $location.split('?')[0];
    // Coaching lives under the Programs tab in nav terms
    const normalized = base.startsWith('/coaching') ? '/programs' : base;
    // exact match first
    const exact = TABS.findIndex(t => t.path === normalized);
    if (exact >= 0) return exact;
    // prefix match for sub-pages
    for (let i = TABS.length - 1; i >= 0; i--) {
      if (TABS[i].path !== '/' && normalized.startsWith(TABS[i].path)) return i;
    }
    return 0;
  })();

  function go(path) { push(path); }
</script>

<nav class="bottom-nav" role="navigation" aria-label="Main navigation">
  <div
    class="nav-pill"
    style="left: calc({(activeIdx / TABS.length * 100).toFixed(2)}%); width: calc(100% / {TABS.length})"
  ></div>

  {#each TABS as tab, i}
    <button
      class="nav-tab"
      class:active={i === activeIdx}
      on:click={() => go(tab.path)}
      aria-label={tab.label}
      aria-current={i === activeIdx ? 'page' : undefined}
    >
      <span class="material-symbols-rounded nav-icon">
        {tab.icon}
        {#if tab.path === '/settings' && ($updateAvailable.available || $pwaUpdateReady)}
          <span class="nav-update-dot" aria-label="Update available"></span>
        {/if}
      </span>
      <span class="nav-label">{tab.label}</span>
    </button>
  {/each}
</nav>

<style>
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: calc(var(--nav-h) + var(--safe-bottom));
    padding-bottom: var(--safe-bottom);
    background: var(--glass-surface);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: stretch;
    z-index: 50;
  }

  .nav-pill {
    position: absolute;
    top: 6px;
    height: calc(100% - 12px - var(--safe-bottom));
    background: linear-gradient(135deg, var(--accent-dim), rgba(255,116,51,0.22));
    border-radius: var(--radius-md);
    box-shadow: 0 0 16px var(--accent-dim);
    transition: left var(--dur-base) var(--ease-inout);
    pointer-events: none;
  }

  .nav-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px 0 4px;
    position: relative;
    transition: color var(--dur-fast) var(--ease-out);
    color: var(--text-3);
    -webkit-tap-highlight-color: transparent;
  }
  .nav-tab.active  { color: var(--accent); }
  .nav-tab:active  { transform: scale(0.92); }

  .nav-icon {
    font-size: 22px;
    transition: transform var(--dur-fast) var(--ease-spring);
    position: relative;
  }
  /* Update-available dot, same accent tint as the sidebar/banner. */
  .nav-update-dot {
    position: absolute;
    top: -1px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--surface-1);
  }
  .nav-tab.active .nav-icon { transform: scale(1.1); }

  .nav-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
