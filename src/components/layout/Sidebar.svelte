<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { location, push } from 'svelte-spa-router';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { currentUser, userMgmtActive, logout } from '../../stores/auth.js';
  import { APP_VERSION } from '../../lib/version.js';
  import { resolveAssetUrl, iconUrl } from '../../lib/platform.js';
  import { radioEnabled, radioUrl, radioStationsEnabled } from '../../stores/settings.js';

  export let open = false;
  export let persistent = false;
  const dispatch = createEventDispatcher();

  async function handleLogout() {
    await logout();
    open = false;
    dispatch('close');
  }

  function getInitial(user) {
    return (user?.full_name || user?.username || '?')[0].toUpperCase();
  }

  $: NAV = [
    { path: '/',           icon: 'today',          label: $_('nav.diary')      },
    { path: '/exercises',  icon: 'fitness_center', label: $_('nav.exercises')  },
    { path: '/programs',   icon: 'calendar_month', label: $_('nav.programs')   },
    { path: '/statistics', icon: 'bar_chart',      label: $_('routes.statistics.title') },
    ...((($radioEnabled && $radioUrl) || $radioStationsEnabled) ? [{ path: '/radio', icon: 'radio', label: $_('nav.radio') }] : []),
    { path: '/settings',   icon: 'settings',       label: $_('nav.settings')   },
  ];

  function go(path) {
    push(path);
    if (!persistent) { open = false; dispatch('close'); }
  }
  function close() {
    if (!persistent) { open = false; dispatch('close'); }
  }

  // Coaching routes should keep the Programs entry active
  $: activePath = (() => {
    const base = $location.split('?')[0];
    return base.startsWith('/coaching') ? '/programs' : base;
  })();
</script>

{#if open}
  {#if !persistent}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="sidebar-backdrop"
      in:fade={{ duration: 200 }}
      out:fade={{ duration: 160 }}
      on:click={close}
    ></div>
  {/if}

  <aside
    class="sidebar-panel"
    class:sidebar-persistent={persistent}
    in:fly={{ x: -280, duration: persistent ? 0 : 280, easing: cubicOut }}
    out:fly={{ x: -280, duration: persistent ? 0 : 200 }}
    aria-label="Navigation menu"
  >
    <div class="sidebar-brand">
      <img class="brand-icon" src={iconUrl('/icons/icon-192.png')} alt="LiftTrace" />
      <div class="brand-text">
        <span class="brand-name">LiftTrace</span>
        <span class="brand-tagline">Track Every Rep — Personal Weightlifting Tracker</span>
      </div>
    </div>

    <div class="sidebar-divider"></div>

    <nav class="sidebar-nav">
      {#each NAV as item}
        <button
          class="sidebar-item"
          class:active={activePath === item.path || (item.path !== '/' && activePath.startsWith(item.path))}
          on:click={() => go(item.path)}
        >
          <span class="material-symbols-rounded sidebar-icon">{item.icon}</span>
          <span class="sidebar-label">{item.label}</span>
          {#if activePath === item.path || (item.path !== '/' && activePath.startsWith(item.path))}
            <div class="active-indicator"></div>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="sidebar-footer">
      {#if $userMgmtActive && $currentUser}
        <div class="sidebar-user">
          <div class="user-avatar">
            {#if $currentUser.avatar_url}
              <img src={resolveAssetUrl($currentUser.avatar_url)} alt="" class="user-avatar-img" />
            {:else}
              {getInitial($currentUser)}
            {/if}
          </div>
          <div class="user-info">
            <span class="user-name">{$currentUser.full_name || $currentUser.username}</span>
            <span class="user-role">{$currentUser.role}</span>
          </div>
          <button class="logout-btn" on:click={handleLogout} title={$_('common.sign_out')} aria-label={$_('common.sign_out')}>
            <span class="material-symbols-rounded">logout</span>
          </button>
        </div>
      {:else}
        <span class="sidebar-version">LiftTrace v{APP_VERSION}</span>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .sidebar-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 100;
  }

  .sidebar-panel {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 280px;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    z-index: 101;
    display: flex;
    flex-direction: column;
    padding: var(--safe-top) 0 var(--safe-bottom);
    box-shadow: var(--shadow-lg);
  }
  .sidebar-persistent { box-shadow: none; z-index: 40; }

  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 20px 16px;
  }
  .brand-icon {
    width: 44px; height: 44px;
    border-radius: 10px;
    flex-shrink: 0;
    filter: drop-shadow(0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent));
  }
  .brand-text { display: flex; flex-direction: column; gap: 2px; }
  .brand-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .brand-tagline { font-size: 12px; color: var(--text-3); }

  .sidebar-divider { height: 1px; background: var(--border); margin: 0 16px 8px; }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 10px;
    overflow-y: auto;
  }

  .sidebar-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 14px;
    border-radius: var(--radius-md);
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 15px;
    font-weight: 500;
    text-align: left;
    width: 100%;
    position: relative;
    transition: background var(--dur-fast), color var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .sidebar-item:hover  { background: var(--surface-2); color: var(--text-1); }
  .sidebar-item.active { background: var(--accent-dim); color: var(--accent); }
  .sidebar-item:active { transform: scale(0.98); }

  .sidebar-icon { font-size: 22px; flex-shrink: 0; }
  .sidebar-label { flex: 1; }

  .active-indicator {
    width: 4px;
    height: 20px;
    border-radius: var(--radius-full);
    background: var(--accent);
    position: absolute;
    right: -10px;
    top: 50%;
    transform: translateY(-50%);
  }

  .sidebar-footer {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .sidebar-version { font-size: 11px; color: var(--text-3); }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
  }
  .user-avatar {
    width: 34px; height: 34px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 14px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .user-avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .user-info { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .user-name {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .user-role { font-size: 11px; color: var(--text-3); text-transform: capitalize; }
  .logout-btn {
    flex-shrink: 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 6px;
    border-radius: var(--radius-sm);
    display: flex; align-items: center;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .logout-btn:hover { color: var(--danger); background: rgba(255,92,92,0.1); }
</style>
