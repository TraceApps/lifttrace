<script>
  /**
   * LoadTypeMenu.svelte: the Load Type / Tracked By chooser, in one place.
   *
   * It used to exist three times: once in the Diary's ExerciseCard and twice
   * in the workout editor, once for a standalone exercise and once for one
   * inside a superset. The editor's two copies positioned themselves with
   * `position: absolute; top: 36px` on an element that was a sibling of the
   * header rather than a child of it, so nothing near the exercise
   * established a containing block and the menu resolved against the page
   * instead. The first exercise looked right by coincidence; every exercise
   * below it opened the menu further from the chip, often above the top of
   * the screen (issue #116, found by @kgenerozov).
   *
   * So the menu is portaled to <body> and positioned in viewport
   * coordinates from the trigger's own rect, which is also how it escapes
   * `.superset-block { overflow: hidden }` and the Diary card's own
   * overflow. It opens below the chip when there is room, flips above when
   * there is not, and when neither side fits it takes the taller side and
   * scrolls inside itself, so it is always reachable without scrolling the
   * page to find it.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { closeOnBack } from '../../lib/back-stack.js';
  import { portal } from '../../lib/portal.js';

  /** The trigger's bounding rect, in viewport coordinates. */
  export let anchor = null;
  export let loadType = 'bilateral';
  export let setType = 'reps';
  /** Bound: "Remember for this exercise". */
  export let remember = false;

  const dispatch = createEventDispatcher();

  const LOAD_TYPES = [
    ['bilateral',  'workout_editor.load_bilateral',  'workout_editor.load_hint_bilateral'],
    ['paired',     'workout_editor.load_paired',     'workout_editor.load_hint_paired'],
    ['unilateral', 'workout_editor.load_unilateral', 'workout_editor.load_hint_unilateral'],
  ];
  const SET_TYPES = [
    ['reps', 'exercise_card.set_type_reps', 'exercise_card.set_type_reps_hint'],
    ['time', 'exercise_card.set_type_time', 'exercise_card.set_type_time_hint'],
  ];

  const GAP = 6;      // between the chip and the menu
  const MARGIN = 14;  // smallest distance kept from any screen edge

  let menuEl;
  let pos = { top: 0, left: 0, width: 260, maxHeight: null };
  // The menu has to be in the DOM to be measured, so it is laid out once
  // invisibly and only shown once it knows where it belongs.
  let placed = false;

  $: if (anchor) place(anchor);

  async function place(rect) {
    // clientWidth, not innerWidth: innerWidth counts the scrollbar, and a
    // menu placed against it sits a few pixels past the edge of what the
    // page can actually show. The old Diary copy had the same slip.
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const width = Math.min(320, Math.max(240, vw - MARGIN * 2));
    const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, vw - width - MARGIN));

    placed = false;
    pos = { top: rect.bottom + GAP, left, width, maxHeight: null };
    await tick();

    const height = menuEl?.offsetHeight || 0;
    const below = vh - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;

    if (height <= below) {
      pos = { top: rect.bottom + GAP, left, width, maxHeight: null };
    } else if (height <= above) {
      pos = { top: rect.top - GAP - height, left, width, maxHeight: null };
    } else if (below >= above) {
      pos = { top: rect.bottom + GAP, left, width, maxHeight: below };
    } else {
      pos = { top: MARGIN, left, width, maxHeight: above };
    }
    placed = true;
  }

  const close = () => dispatch('close');
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div use:portal class="ltm-backdrop" on:click|stopPropagation={close} use:closeOnBack={close}></div>
<div use:portal class="ltm" role="menu" bind:this={menuEl} on:click|stopPropagation
     style="top:{pos.top}px; left:{pos.left}px; width:{pos.width}px;
            {pos.maxHeight ? `max-height:${pos.maxHeight}px; overflow-y:auto;` : ''}
            visibility:{placed ? 'visible' : 'hidden'}">
  <div class="ltm-head">{$_('workout_editor.load_type')}</div>
  {#each LOAD_TYPES as [val, labelKey, hintKey]}
    <button class="ltm-item" class:active={loadType === val} type="button" role="menuitem"
            on:click={() => dispatch('pickLoad', val)}>
      <div class="ltm-text">
        <span class="ltm-label">{$_(labelKey)}</span>
        <span class="ltm-hint">{$_(hintKey)}</span>
      </div>
      {#if loadType === val}<span class="material-symbols-rounded ltm-check">check</span>{/if}
    </button>
  {/each}

  <div class="ltm-head">{$_('exercise_card.tracked_by')}</div>
  {#each SET_TYPES as [val, labelKey, hintKey]}
    <button class="ltm-item" class:active={setType === val} type="button" role="menuitem"
            on:click={() => dispatch('pickSetType', val)}>
      <div class="ltm-text">
        <span class="ltm-label">{$_(labelKey)}</span>
        <span class="ltm-hint">{$_(hintKey)}</span>
      </div>
      {#if setType === val}<span class="material-symbols-rounded ltm-check">check</span>{/if}
    </button>
  {/each}

  <label class="ltm-remember">
    <input type="checkbox" bind:checked={remember} />
    <span>{$_('workout_editor.remember_ex')}</span>
  </label>
</div>

<style>
  /* The menu lives on <body> once it is open. Svelte's scoping class rides
     on the element itself, so these stay scoped rather than global. The
     z-index clears the sticky diary header (10) and the rest bar (100). */
  .ltm-backdrop {
    position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, 0.2);
  }
  .ltm {
    position: fixed; z-index: 201;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
    padding: 8px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .ltm-head {
    font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 6px 6px;
  }
  .ltm-item {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8px; padding: 8px 10px;
    background: none; border: none; cursor: pointer;
    text-align: left; font-family: inherit;
    color: var(--text-1); border-radius: var(--radius-md);
  }
  .ltm-item:hover { background: var(--surface-2); }
  .ltm-item.active { background: var(--accent-dim); }
  .ltm-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .ltm-label { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .ltm-hint  { font-size: 11px; color: var(--text-3); line-height: 1.35; }
  .ltm-check { font-size: 18px; color: var(--accent); flex-shrink: 0; margin-top: 2px; }
  .ltm-remember {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px;
    font-size: 12px; color: var(--text-2); cursor: pointer;
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .ltm-remember input { accent-color: var(--accent); }
</style>
