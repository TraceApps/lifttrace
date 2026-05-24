<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut }  from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';

  export let open   = false;
  export let title  = '';
  export let height = 'auto';  // 'auto' | 'full' | '60vh' etc.

  const dispatch = createEventDispatcher();
  let _locked = false;
  let _lockTimer;
  $: if (open) {
    clearTimeout(_lockTimer);
    _locked = true;
    _lockTimer = setTimeout(() => _locked = false, 400);
  }

  function close() {
    open = false;
    dispatch('close');
  }

  function onBackdropClick(e) {
    if (_locked) return;
    if (e.target === e.currentTarget) close();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={onBackdropClick}
    in:fade={{ duration: 200 }} out:fade={{ duration: 160 }}>
    <div
      class="sheet-panel"
      class:sheet-full={height === 'full'}
      style={height !== 'auto' && height !== 'full' ? `height:${height}` : ''}
      in:fly={{ y: 80, duration: 280, easing: cubicOut }}
      out:fly={{ y: 80, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <!-- Handle bar -->
      <div class="sheet-handle"></div>

      <!-- Header. Always renders so the close X is reachable on every
           sheet (NutriTrace pattern). When no title is set, the header
           collapses to just the close button anchored to the right. -->
      <div class="sheet-header" class:title-only-close={!title}>
        {#if title}<h3 class="sheet-title">{title}</h3>{/if}
        <button class="btn-icon sheet-close" on:click={close}
                aria-label={$_('common.close')} title={$_('common.close')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>

      <div class="sheet-body">
        <slot />
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    /* Center the panel horizontally so on a wide viewport (desktop PWA)
       it doesn't stretch edge-to-edge. Phones stay full-width because
       the panel's max-width is wider than the viewport. */
    justify-content: center;
  }
  .sheet-panel {
    width: 100%;
    /* Cap the panel width on desktop. Phone viewports (≤480px) stay
       full-width because they fall under the cap; desktop / tablet PWA
       gets a centered 720px sheet instead of edge-to-edge content with
       a sea of empty space on the right. */
    max-width: 720px;
    max-height: 90dvh;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-top: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-bottom: var(--safe-bottom);
  }
  .sheet-full { height: 90dvh; }
  .sheet-handle {
    width: 36px; height: 4px;
    background: var(--border-strong);
    border-radius: var(--radius-full);
    margin: 12px auto 0;
    flex-shrink: 0;
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 8px;
    flex-shrink: 0;
  }
  /* No-title variant — the header collapses to just the close X, anchored
     right. Stays small so it doesn't add visual weight to sheets that
     don't want a header bar (e.g. ExercisePicker which manages its own
     internal layout). */
  .sheet-header.title-only-close {
    padding: 4px 8px 0;
    justify-content: flex-end;
  }
  .sheet-title { font-size: 17px; font-weight: 600; }
  .sheet-close { color: var(--text-3); }
  .sheet-close:hover { color: var(--text-1); }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 20px 20px;
  }
</style>
