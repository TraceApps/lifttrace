<script>
  /**
   * TemplateSpecRow — one row of a template exercise's per-set spec grid,
   * used inside WorkoutEditor.svelte. Feature-parity target: Diary's
   * SetRow.svelte, minus the runtime-only bits (completed toggle, PR
   * badge, active-set highlight).
   *
   * Fields exposed per spec (all optional, all persisted verbatim onto
   * the workout when the template loads):
   *   number    — round-number override for supersets (picker menu)
   *   weight    — target weight (free text; supports ranges like "8-12")
   *   reps      — target reps
   *   reps_l    — left-side reps (unilateral split)
   *   reps_r    — right-side reps (unilateral split)
   *   warmup    — mark this set as a warmup so it pre-flags in the diary
   *   rpe       — target RPE (gated by trackRpe setting)
   *
   * Portaled pickers (number, RPE) escape the WorkoutEditor's overflow-
   * hidden ancestors so they render above the row on any card height,
   * matching the fix pattern established in commits a242319 (SetRow) and
   * 2425696 (ExerciseCard load menu).
   */
  import { portal } from '../../lib/portal.js';

  export let spec = {};
  export let setIdx = 0;
  export let loadType = 'bilateral';
  export let trackRpe = false;
  /** True on supersets — enables the round-number picker. Single-exercise
   *  templates hide the picker (no rounds to number). */
  export let showNumberPicker = false;
  /** Field updater: called with (field, value) — parent runs it through
   *  the usual updateSpec / updateSpecNumber flow. */
  export let onUpdate = (_field, _value) => {};
  /** Special updater for the round-number field so the parent's cascade
   *  logic runs (setting a number shifts subsequent rows). */
  export let onUpdateNumber = (_rawInputStr) => {};
  export let onRemove = () => {};

  import { _ } from 'svelte-i18n';

  $: displayNum = spec?.number != null ? spec.number : setIdx + 1;
  $: isSplit = loadType === 'unilateral'
            && (spec?.reps_l != null || spec?.reps_r != null);

  // Number picker
  let numOpen = false;
  let numTriggerEl;
  let numPos = { top: 0, left: 0 };
  const NUM_VALUES = [1, 2, 3, 4, 5, 6, 7, 8];
  // Open-lock: after the picker mounts, ignore backdrop dismissals for
  // ~350ms so a slightly-slipped finger tap on a number button can't
  // land on the backdrop instead and silently close without picking.
  // Mirrors ActionSheet.svelte's cancel-lock pattern. Without this,
  // real-world thumb slop on Android WebView drops ~1 in 4 picker taps.
  let numLocked = false;
  let numLockTimer;
  function openNumPicker() {
    if (!numTriggerEl) { numOpen = true; return; }
    const r = numTriggerEl.getBoundingClientRect();
    numPos = { top: r.bottom + 4, left: r.left };
    numOpen = true;
    clearTimeout(numLockTimer);
    numLocked = true;
    numLockTimer = setTimeout(() => { numLocked = false; }, 350);
  }
  function closeNumIfUnlocked() { if (!numLocked) numOpen = false; }
  function pickNum(n) {
    // Passing the raw number-as-string to the parent lets its
    // updateSpecNumber cascade helper handle the shift-forward logic.
    onUpdateNumber(String(n));
    numOpen = false;
  }
  function clearNum() {
    onUpdateNumber('');   // empty string clears the override in parent's helper
    numOpen = false;
  }

  // RPE picker
  let rpeOpen = false;
  let rpeTriggerEl;
  let rpePos = { top: 0, left: 0 };
  const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10];
  let rpeLocked = false;
  let rpeLockTimer;
  function openRpePicker() {
    if (!rpeTriggerEl) { rpeOpen = true; return; }
    const r = rpeTriggerEl.getBoundingClientRect();
    rpePos = { top: r.bottom + 4, left: Math.max(4, r.right - 200) };
    rpeOpen = true;
    clearTimeout(rpeLockTimer);
    rpeLocked = true;
    rpeLockTimer = setTimeout(() => { rpeLocked = false; }, 350);
  }
  function closeRpeIfUnlocked() { if (!rpeLocked) rpeOpen = false; }
  function pickRpe(v) { onUpdate('rpe', v); rpeOpen = false; }
  function clearRpe() { onUpdate('rpe', null); rpeOpen = false; }

  function toggleWarmup() { onUpdate('warmup', !spec?.warmup); }

  function toggleSplit() {
    if (isSplit) {
      // Collapse split → keep the higher of the two as the shared value.
      const l = parseFloat(spec?.reps_l) || 0;
      const r = parseFloat(spec?.reps_r) || 0;
      const kept = Math.max(l, r) || spec?.reps || '';
      onUpdate('reps_l', null);
      onUpdate('reps_r', null);
      onUpdate('reps', kept);
    } else {
      const v = spec?.reps || '';
      onUpdate('reps_l', v);
      onUpdate('reps_r', v);
    }
  }
</script>

<div class="spec-row" class:warmup={spec?.warmup}>
  {#if showNumberPicker && !spec?.warmup}
    <button type="button" class="spec-num-btn"
      class:custom={spec?.number != null && spec.number !== setIdx + 1}
      bind:this={numTriggerEl}
      on:click={() => numOpen ? (numOpen = false) : openNumPicker()}
      title="Round number (tap to reassign for asymmetric supersets)"
      aria-label="Edit round number"
    >
      <span class="spec-num-value">{displayNum}</span>
      <span class="material-symbols-rounded spec-num-caret" aria-hidden="true">arrow_drop_down</span>
    </button>
    {#if numOpen}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div use:portal class="num-backdrop" on:click={closeNumIfUnlocked}></div>
      <div use:portal class="num-picker" style="top:{numPos.top}px; left:{numPos.left}px">
        {#each NUM_VALUES as n}
          <button class="num-opt" class:active={displayNum === n} on:click|stopPropagation={() => pickNum(n)}>{n}</button>
        {/each}
        {#if spec?.number != null}
          <button class="num-opt clear" on:click|stopPropagation={clearNum}>{$_('template_spec.auto')}</button>
        {/if}
      </div>
    {/if}
  {:else if spec?.warmup}
    <span class="spec-num warmup-badge" title="Warmup set">W</span>
  {:else}
    <span class="spec-num">#{setIdx + 1}</span>
  {/if}

  <input class="ps-input" type="text"
    value={spec?.weight ?? ''}
    on:input={e => onUpdate('weight', e.target.value)}
    placeholder={$_('template_spec.weight')} />

  <span class="ps-x">×</span>

  {#if isSplit}
    <div class="ps-reps-split">
      <span class="lr-label">L</span>
      <input class="ps-input ps-input-narrow" type="text"
        value={spec?.reps_l ?? ''}
        on:input={e => onUpdate('reps_l', e.target.value)}
        placeholder="0" aria-label="Left reps" />
      <span class="lr-label">R</span>
      <input class="ps-input ps-input-narrow" type="text"
        value={spec?.reps_r ?? ''}
        on:input={e => onUpdate('reps_r', e.target.value)}
        placeholder="0" aria-label="Right reps" />
    </div>
  {:else}
    <input class="ps-input" type="text"
      value={spec?.reps ?? ''}
      on:input={e => onUpdate('reps', e.target.value)}
      placeholder={$_('template_spec.reps')} />
  {/if}

  {#if loadType === 'unilateral'}
    <button type="button" class="spec-icon-btn" class:active={isSplit}
      on:click={toggleSplit}
      title={isSplit ? 'Merge L/R reps' : 'Split L/R reps'}
      aria-label={isSplit ? 'Merge L/R reps' : 'Split L/R reps'}
    >
      <span class="material-symbols-rounded">{isSplit ? 'link_off' : 'add_link'}</span>
    </button>
  {/if}

  {#if trackRpe}
    <button type="button" class="rpe-chip" class:set={spec?.rpe != null}
      bind:this={rpeTriggerEl}
      on:click={() => rpeOpen ? (rpeOpen = false) : openRpePicker()}
      title="Rate of Perceived Exertion target"
    >{spec?.rpe != null ? `@${spec.rpe}` : 'RPE'}</button>
    {#if rpeOpen}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div use:portal class="rpe-backdrop" on:click={closeRpeIfUnlocked}></div>
      <div use:portal class="rpe-picker" style="top:{rpePos.top}px; left:{rpePos.left}px">
        {#each RPE_VALUES as v}
          <button class="rpe-opt" class:active={spec?.rpe === v} on:click|stopPropagation={() => pickRpe(v)}>@{v}</button>
        {/each}
        {#if spec?.rpe != null}
          <button class="rpe-opt clear" on:click|stopPropagation={clearRpe}>{$_('template_spec.clear')}</button>
        {/if}
      </div>
    {/if}
  {/if}

  <button type="button" class="spec-icon-btn" class:warmup-on={spec?.warmup}
    on:click={toggleWarmup}
    title={spec?.warmup ? 'Unmark as warmup' : 'Mark as warmup'}
    aria-label={spec?.warmup ? 'Unmark as warmup' : 'Mark as warmup'}
  >
    <span class="material-symbols-rounded">local_fire_department</span>
  </button>

  <button type="button" class="spec-icon-btn" on:click={onRemove}
    title="Remove set" aria-label="Remove set"
  >
    <span class="material-symbols-rounded">close</span>
  </button>
</div>

<style>
  .spec-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 0;
  }
  .spec-row.warmup { opacity: 0.85; }

  .spec-num, .spec-num-btn, .warmup-badge {
    min-width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
    color: var(--text-3);
    text-align: center;
    flex-shrink: 0;
  }
  /* Always-visible pill so touch users can tell the round-number is
     tappable. Rewrites what used to be plain text into a chip with a
     small caret — matches the interaction affordance the Diary's
     SetRow lacked and had to be worked around. */
  .spec-num-btn {
    min-width: 40px; height: 26px;
    padding: 0 4px 0 6px;
    display: inline-flex; align-items: center; justify-content: space-between; gap: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 12px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast);
  }
  .spec-num-btn:hover { background: var(--surface-3); color: var(--text-1); }
  .spec-num-btn.custom {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .spec-num-value { line-height: 1; }
  .spec-num-caret {
    font-size: 16px;
    opacity: 0.7;
    margin-left: -2px;
  }
  .warmup-badge { color: var(--accent); }

  .ps-input {
    flex: 1 1 0; min-width: 0;
    padding: 6px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font-size: 13px; font-family: inherit;
    outline: none;
  }
  .ps-input:focus { border-color: var(--accent); }
  .ps-input-narrow { flex: 1 1 40px; text-align: center; padding: 6px 4px; }
  .ps-x { color: var(--text-3); font-size: 12px; flex-shrink: 0; }

  .ps-reps-split {
    display: flex; align-items: center; gap: 3px;
    flex: 1 1 0; min-width: 0;
  }
  .lr-label {
    font-size: 10px; font-weight: 800; color: var(--accent);
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .spec-icon-btn {
    width: 26px; height: 26px; padding: 0;
    background: none; border: none;
    color: var(--text-3); cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .spec-icon-btn:hover { background: var(--surface-2); color: var(--text-1); }
  .spec-icon-btn.active { color: var(--accent); }
  .spec-icon-btn.warmup-on { color: var(--accent); }
  .spec-icon-btn .material-symbols-rounded { font-size: 16px; }

  .rpe-chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 3px 8px;
    font-size: 11px; font-weight: 700; font-family: inherit;
    color: var(--text-3);
    cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .rpe-chip:hover { border-color: var(--text-2); }
  .rpe-chip.set { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }

  /* Portaled pickers — same z-index tier used by SetRow's set-number
     and RPE pickers so they sit above sticky headers + rest bar. */
  :global(.num-backdrop) { position: fixed; inset: 0; z-index: 200; }
  :global(.num-picker) {
    position: fixed; z-index: 201; padding: 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    min-width: 200px;
  }
  /* Larger tap target — the previous 28px height was below Material's
     44px recommendation and, with real-world thumb slop, missed enough
     that changes appeared not to take. Same treatment on .rpe-opt. */
  :global(.num-picker .num-opt) {
    min-height: 40px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 14px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  :global(.num-picker .num-opt:hover) { background: var(--surface-3); }
  :global(.num-picker .num-opt.active) { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  :global(.num-picker .num-opt.clear) {
    grid-column: span 4; color: var(--text-3); background: transparent;
    border: 1px dashed var(--border); margin-top: 2px;
  }

  :global(.rpe-backdrop) { position: fixed; inset: 0; z-index: 200; }
  :global(.rpe-picker) {
    position: fixed; z-index: 201; padding: 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    min-width: 200px;
  }
  :global(.rpe-picker .rpe-opt) {
    min-height: 40px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 14px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  :global(.rpe-picker .rpe-opt:hover) { background: var(--surface-3); }
  :global(.rpe-picker .rpe-opt.active) { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  :global(.rpe-picker .rpe-opt.clear) {
    grid-column: span 4; color: var(--danger); background: transparent;
    border: 1px dashed var(--border); margin-top: 2px;
  }
</style>
