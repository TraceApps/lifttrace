<script>
  import { createEventDispatcher } from 'svelte';
  import { trackRpe } from '../../stores/settings.js';
  import { haptic as _haptic } from '../../lib/haptics.js';
  import { portal } from '../../lib/portal.js';

  export let set;
  export let setNum;
  export let unit = 'lbs';
  /** When true, set numbering gets a "W" prefix and the row is styled muted. */
  export let showAsWarmup = false;
  /** The "next up" row — the first incomplete working set. Gets a subtle
   *  accent-colored left edge + tint so the lifter knows where to focus. */
  export let isNext = false;
  /** When the current logged values for this set beat the user's previous
   *  best (top weight or top e1RM). Diary computes this; we just render a
   *  small "🔥 PR" badge with a brief sparkle when it lights up. */
  export let isPR = false;
  /** Load type of the parent exercise. Drives:
   *    - Weight column unit suffix: 'lbs' (bilateral), 'lbs each' (paired),
   *      'lbs/side' (unilateral)
   *    - Whether the reps cell offers an L/R split (unilateral only).
   */
  export let loadType = 'bilateral';

  $: weightHint = loadType === 'paired' ? `${unit} ea`
                : loadType === 'unilateral' ? `${unit}`
                : unit;
  // L/R split is only meaningful for unilateral exercises. When the user
  // taps the split icon we flip into split-mode where reps_l + reps_r are
  // edited separately; clearing both falls back to the single `reps` value.
  $: isSplit = loadType === 'unilateral' && (set.reps_l != null || set.reps_r != null);
  function toggleSplit() {
    if (isSplit) {
      // Collapse split → keep the higher of the two as the single rep count.
      const r = Math.max(Number(set.reps_l) || 0, Number(set.reps_r) || 0);
      dispatch('update', { ...set, reps: r, reps_l: null, reps_r: null });
    } else {
      const r = Number(set.reps) || 0;
      dispatch('update', { ...set, reps_l: r, reps_r: r });
    }
  }

  const dispatch = createEventDispatcher();

  // Plate-aware increment: 5 lb / 2.5 kg (matches the smallest common plate pair).
  $: step = unit === 'kg' ? 2.5 : 5;

  // RPE picker
  let rpeOpen = false;
  let rpeTriggerEl;
  let rpePickerPos = { top: 0, left: 0 };
  const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10];
  // Open-lock (350ms) prevents a stray backdrop dismissal from silently
  // closing the picker before a slightly-slipped tap on an option button
  // registers. Same pattern used in ActionSheet.svelte and TemplateSpecRow.
  let rpeLocked = false;
  let rpeLockTimer;
  function openRpePicker() {
    if (!rpeTriggerEl) { rpeOpen = true; return; }
    const r = rpeTriggerEl.getBoundingClientRect();
    rpePickerPos = { top: r.bottom + 4, left: Math.max(4, r.right - 200) };
    rpeOpen = true;
    clearTimeout(rpeLockTimer);
    rpeLocked = true;
    rpeLockTimer = setTimeout(() => { rpeLocked = false; }, 350);
  }
  function closeRpeIfUnlocked() { if (!rpeLocked) rpeOpen = false; }
  function pickRpe(v) { update('rpe', v); rpeOpen = false; }
  function clearRpe() { update('rpe', null); rpeOpen = false; }

  // Set-number picker (asymmetric supersets — addon sets, etc.).
  // The displayed number is `set.number` when explicitly set, otherwise the
  // parent's auto-computed `setNum` (1..N by position). A user-edited number
  // identifies the round in a superset: round N is done across the group
  // when every exercise that has a set numbered N has it completed.
  let numOpen = false;
  let numTriggerEl;
  let numPickerPos = { top: 0, left: 0 };
  $: displayNum = set.number != null ? set.number : setNum;
  const NUM_VALUES = [1, 2, 3, 4, 5, 6, 7, 8];
  let numLocked = false;
  let numLockTimer;
  function openNumPicker() {
    if (!numTriggerEl) { numOpen = true; return; }
    const r = numTriggerEl.getBoundingClientRect();
    numPickerPos = { top: r.bottom + 4, left: r.left };
    numOpen = true;
    clearTimeout(numLockTimer);
    numLocked = true;
    numLockTimer = setTimeout(() => { numLocked = false; }, 350);
  }
  function closeNumIfUnlocked() { if (!numLocked) numOpen = false; }
  function pickNum(n) {
    // Picking the same value as the auto default clears the override so
    // the row goes back to position-based numbering.
    update('number', n === setNum ? null : n);
    numOpen = false;
  }
  function clearNum() { update('number', null); numOpen = false; }

  let pulseOn = false;
  let _pulseTimer;

  function update(field, value) {
    dispatch('update', { ...set, [field]: value });
  }

  function bumpWeight(delta) {
    const current = parseFloat(set.weight) || 0;
    const next = Math.max(0, Math.round((current + delta) * 100) / 100);
    update('weight', next);
  }

  function toggleComplete() {
    const nowComplete = !set.completed;
    // Haptic + green flash on the "done" transition
    if (nowComplete) {
      _haptic(12);
      pulseOn = true;
      clearTimeout(_pulseTimer);
      _pulseTimer = setTimeout(() => pulseOn = false, 600);
    }
    dispatch('update', { ...set, completed: nowComplete });
  }

  /** Select the whole value on focus so a single tap overwrites it. */
  function selectOnFocus(e) { e.target?.select?.(); }

  // ── Input clobber guard ──────────────────────────────────────────────
  // Each numeric input keeps a local string bound with bind:value. The
  // parent's set prop only writes back into these locals when the
  // corresponding input is NOT focused, so a fast keystroke on Android
  // WebView + a synchronous parent round-trip can't overwrite the digit
  // the user is currently typing (nor reformat a partial "1." to "1"
  // mid-decimal). On blur we normalise, force-commit, and let the
  // parent's value flow back in.
  let weightFocused = false;
  let repsFocused = false;
  let repsLFocused = false;
  let repsRFocused = false;

  let weightStr = _fmt(set.weight);
  let repsStr = _fmt(set.reps);
  let repsLStr = _fmt(set.reps_l);
  let repsRStr = _fmt(set.reps_r);

  function _fmt(v) { return v == null || Number.isNaN(v) ? '' : String(v); }

  // Sync the LOCAL string from the parent's set prop only when the
  // input isn't the current source of change. When focused we let the
  // user's typing win until they blur.
  $: if (!weightFocused) weightStr = _fmt(set.weight);
  $: if (!repsFocused)   repsStr   = _fmt(set.reps);
  $: if (!repsLFocused)  repsLStr  = _fmt(set.reps_l);
  $: if (!repsRFocused)  repsRStr  = _fmt(set.reps_r);

  function commitNumber(field, raw, parser) {
    // Empty string commits as 0 (matches the old behaviour). Otherwise
    // parse — if the parse is NaN (mid-typing like "-" or "."), skip
    // the dispatch and let the input keep showing what the user typed.
    if (raw === '' || raw == null) { update(field, 0); return; }
    const n = parser(raw);
    if (Number.isNaN(n)) return;
    if (n !== set[field]) update(field, n);
  }
</script>

<div class="set-row" class:done={set.completed} class:pulse={pulseOn} class:warmup={showAsWarmup} class:is-next={isNext} class:pr={isPR}>
  {#if isPR}
    <span class="pr-badge" title="New personal record!">🔥 PR</span>
  {/if}
  {#if showAsWarmup}
    <span class="set-num">W</span>
  {:else}
    <div class="set-num-wrap">
      <button class="set-num set-num-btn" class:custom={set.number != null}
        bind:this={numTriggerEl}
        on:click={() => numOpen ? (numOpen = false) : openNumPicker()}
        title="Set number — tap to reassign for asymmetric supersets" aria-label="Edit set number">
        <span class="set-num-value">{displayNum}</span>
        <span class="material-symbols-rounded set-num-caret" aria-hidden="true">arrow_drop_down</span>
      </button>
      {#if numOpen}
        <!-- Portaled to <body> so the picker escapes the ExerciseCard's
             overflow: hidden clip and any native-input stacking quirks
             on the weight column. -->
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div use:portal class="num-backdrop" on:click={closeNumIfUnlocked}></div>
        <div use:portal class="num-picker" style="top:{numPickerPos.top}px; left:{numPickerPos.left}px">
          {#each NUM_VALUES as n}
            <button class="num-opt" class:active={displayNum === n} on:click|stopPropagation={() => pickNum(n)}>{n}</button>
          {/each}
          {#if set.number != null}
            <button class="num-opt clear" on:click|stopPropagation={clearNum}>Auto</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="set-field weight-field">
    <button class="step-btn" on:click={() => bumpWeight(-step)} aria-label="Decrease weight" tabindex="-1">−</button>
    <input
      type="number"
      class="set-input"
      bind:value={weightStr}
      on:input={() => commitNumber('weight', weightStr, parseFloat)}
      on:focus={(e) => { weightFocused = true; selectOnFocus(e); }}
      on:blur={() => { weightFocused = false; commitNumber('weight', weightStr, parseFloat); }}
      placeholder="0"
      inputmode="decimal"
    />
    <button class="step-btn" on:click={() => bumpWeight(step)} aria-label="Increase weight" tabindex="-1">+</button>
    <span class="set-unit">{weightHint}</span>
  </div>

  {#if isSplit}
    <!-- Unilateral L/R split — each side gets its own input. Tap the
         chain icon to collapse back to a single shared reps value. -->
    <div class="set-field reps-split">
      <span class="lr-label">L</span>
      <input
        type="number"
        class="set-input"
        bind:value={repsLStr}
        on:input={() => commitNumber('reps_l', repsLStr, parseInt)}
        on:focus={(e) => { repsLFocused = true; selectOnFocus(e); }}
        on:blur={() => { repsLFocused = false; commitNumber('reps_l', repsLStr, parseInt); }}
        placeholder="0"
        inputmode="numeric"
      />
      <span class="lr-label">R</span>
      <input
        type="number"
        class="set-input"
        bind:value={repsRStr}
        on:input={() => commitNumber('reps_r', repsRStr, parseInt)}
        on:focus={(e) => { repsRFocused = true; selectOnFocus(e); }}
        on:blur={() => { repsRFocused = false; commitNumber('reps_r', repsRStr, parseInt); }}
        placeholder="0"
        inputmode="numeric"
      />
      <button class="split-btn active" on:click={toggleSplit} title="Merge L/R" aria-label="Merge L/R">
        <span class="material-symbols-rounded">link_off</span>
      </button>
    </div>
  {:else}
    <div class="set-field">
      <input
        type="number"
        class="set-input"
        bind:value={repsStr}
        on:input={() => commitNumber('reps', repsStr, parseInt)}
        on:focus={(e) => { repsFocused = true; selectOnFocus(e); }}
        on:blur={() => { repsFocused = false; commitNumber('reps', repsStr, parseInt); }}
        placeholder="0"
        inputmode="numeric"
      />
      <!-- No "reps" unit label here — the sets-header column above
           every SetRow already reads REPS (ExerciseCard.svelte), so
           the per-row label was purely redundant. Removing it matters
           in practice: at narrow phone widths with RPE tracking on,
           the reps input's flex track has almost no slack left after
           the RPE chip's auto column, and the label's own width +
           gap was routinely eating the entire input (issue #75). -->
      {#if loadType === 'unilateral'}
        <button class="split-btn" on:click={toggleSplit} title="Split L/R reps" aria-label="Split L/R reps">
          <span class="material-symbols-rounded">add_link</span>
        </button>
      {/if}
    </div>
  {/if}

  <button class="check-btn" class:checked={set.completed} on:click={toggleComplete} aria-label={set.completed ? 'Mark incomplete' : 'Mark complete'}>
    <span class="material-symbols-rounded">
      {set.completed ? 'check_circle' : 'radio_button_unchecked'}
    </span>
  </button>

  {#if $trackRpe && !showAsWarmup}
    <div class="rpe-wrap">
      <button class="rpe-chip" class:set={set.rpe != null}
        bind:this={rpeTriggerEl}
        on:click={() => rpeOpen ? (rpeOpen = false) : openRpePicker()}
        title="Rate of Perceived Exertion">
        {set.rpe != null ? `@${set.rpe}` : 'RPE'}
      </button>
      {#if rpeOpen}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div use:portal class="rpe-backdrop" on:click={closeRpeIfUnlocked}></div>
        <div use:portal class="rpe-picker" style="top:{rpePickerPos.top}px; left:{rpePickerPos.left}px">
          {#each RPE_VALUES as v}
            <button class="rpe-opt" class:active={set.rpe === v} on:click|stopPropagation={() => pickRpe(v)}>@{v}</button>
          {/each}
          {#if set.rpe != null}
            <button class="rpe-opt clear" on:click|stopPropagation={clearRpe}>Clear</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <button class="remove-btn" on:click={() => dispatch('remove')} title="Remove set" aria-label="Remove set">
    <span class="material-symbols-rounded">close</span>
  </button>
</div>

<style>
  .set-row {
    display: grid;
    /* minmax(0, _fr) lets the columns actually shrink on narrow viewports —
       default 1fr won't go below the intrinsic width of a <input type=number>,
       clipping multi-digit values.
       Weight gets more flex than reps (1.4 vs 0.7) since weight has step
       buttons + unit + 3-4 digit values, while reps is a plain input that's
       almost always 1-2 digits. */
    grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 0.7fr) 36px 32px;
    gap: 6px;
    align-items: center;
    padding: 6px 0;
    transition: opacity var(--dur-fast), background var(--dur-base);
    border-radius: var(--radius-sm);
  }
  /* Only inject the RPE column when the feature is on — otherwise the empty
     `auto` track still adds a 6px gap. Toggled via :has() on the child. */
  .set-row:has(.rpe-wrap) {
    grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 0.7fr) 36px auto 32px;
  }
  /* Widen the reps column whenever the split-toggle button appears in it.
     Two cases both trip the same problem:
       - unilateral + split mode: two <input>s + L/R labels + chain-off
       - unilateral + non-split:  <input> + 'reps' unit + add-link button
     Either way the default 0.7fr reps column plus the button eats enough
     width that a 360dp phone clips digits (~12px left for the actual input
     in non-split; ~15px per cell in split). Rebalancing to 1fr/1fr when a
     .split-btn is present covers both. Bilateral / paired stay at
     1.4fr/0.7fr since they have no split button. */
  .set-row:has(.split-btn) {
    grid-template-columns: 28px minmax(0, 1fr) minmax(0, 1fr) 36px 32px;
  }
  .set-row:has(.split-btn):has(.rpe-wrap) {
    grid-template-columns: 28px minmax(0, 1fr) minmax(0, 1fr) 36px auto 32px;
  }
  .set-row.done { opacity: 0.6; }
  /* PR set: keep the row full-opacity (override .done) + accent ring so
     the celebration doesn't get washed out by the post-completion fade. */
  .set-row.pr,
  .set-row.pr.done {
    opacity: 1;
    position: relative;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .pr-badge {
    position: absolute;
    top: -10px; right: 6px;
    z-index: 1;
    background: var(--accent);
    color: var(--accent-text, white);
    font-size: 10px; font-weight: 800;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.04em;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 40%, transparent);
    animation: pr-pop 0.5s ease-out;
    white-space: nowrap;
  }
  @keyframes pr-pop {
    0%   { transform: scale(0) rotate(-15deg); }
    60%  { transform: scale(1.15) rotate(2deg); }
    100% { transform: scale(1) rotate(0); }
  }
  .set-row.warmup { opacity: 0.72; }
  .set-row.warmup .set-num {
    color: var(--accent);
    font-size: 11px;
  }
  /* "You are here" — the first incomplete working set gets a subtle
     left-edge accent bar + tint so the lifter can find where to focus
     at a glance. Intentionally very soft; doesn't shout. */
  .set-row.is-next {
    position: relative;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    padding-left: 8px;
  }
  .set-row.is-next::before {
    content: '';
    position: absolute; left: 0; top: 4px; bottom: 4px;
    width: 3px; border-radius: 2px;
    background: var(--accent);
  }
  .set-row.is-next .set-num { color: var(--accent); }
  .set-row.pulse { animation: set-complete-pulse 0.6s ease-out; }
  @keyframes set-complete-pulse {
    0%   { background: color-mix(in srgb, var(--success) 45%, transparent); }
    100% { background: transparent; }
  }

  .set-num {
    text-align: center;
    font-size: 13px; font-weight: 700;
    color: var(--text-3);
  }
  .set-num-wrap { position: relative; }
  /* Compact chip so touch users can tell the number is tappable —
     matches the TemplateSpecRow chip pattern, scaled to the diary's
     tight 28px first-column budget by shrinking the caret and
     removing left/right padding. Custom overrides get an accent-dim
     background so re-assigned rows in an asymmetric superset stand
     out from the default sequential numbering. */
  .set-num-btn {
    min-width: 26px; height: 24px;
    padding: 0 1px;
    display: inline-flex; align-items: center; justify-content: center; gap: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-2);
    font: inherit; font-size: 12px; font-weight: 700;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast);
  }
  .set-num-btn:hover { background: var(--surface-3); color: var(--text-1); }
  .set-num-btn.custom {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .set-num-value { line-height: 1; }
  .set-num-caret {
    font-size: 12px;
    opacity: 0.7;
    margin-left: -3px;
  }
  /* Portaled to document.body so viewport coords apply. The z-index
     stack here is above the sticky diary header (z:10) and the rest
     bar (z:100) so the picker always wins. */
  :global(.num-backdrop) { position: fixed; inset: 0; z-index: 200; }
  :global(.num-picker) {
    position: fixed;
    z-index: 201; padding: 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    min-width: 200px;
  }
  /* 40px min-height meets Android's 44dp tap-target guidance close
     enough that real-world thumb slop stops missing. Previously 28px
     high; a slightly-slipped tap would land on the backdrop and close
     without picking, matching the "doesn't take, have to redo" report. */
  .num-opt {
    min-height: 40px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 14px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .num-opt:hover { background: var(--surface-3); }
  .num-opt.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .num-opt.clear {
    grid-column: span 4; color: var(--text-3); background: transparent;
    border: 1px dashed var(--border); margin-top: 2px;
  }

  .set-field {
    display: flex; align-items: center; gap: 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 8px;
    min-width: 0;
  }
  .weight-field { padding: 0 4px; gap: 2px; }
  .step-btn {
    width: 22px; height: 26px; padding: 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-2); font-size: 15px; font-weight: 700;
    border-radius: var(--radius-xs);
    display: flex; align-items: center; justify-content: center;
    transition: background var(--dur-fast), color var(--dur-fast);
    flex-shrink: 0;
  }
  .step-btn:hover { background: var(--surface-3); color: var(--accent); }
  .step-btn:active { transform: scale(0.9); }
  .set-input {
    width: 100%;
    min-width: 0;               /* ← allow the input to shrink inside the flex field */
    background: none; border: none; outline: none;
    color: var(--text-1); font-size: 15px; font-weight: 600;
    padding: 8px 0; font-family: inherit;
    text-align: center;
    -moz-appearance: textfield;
  }
  .set-input::-webkit-inner-spin-button,
  .set-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .set-unit { font-size: 11px; color: var(--text-3); white-space: nowrap; }

  /* Unilateral L/R split — two inputs in the reps slot with tiny L/R
     labels. The chain icon at the end toggles split-mode on/off. */
  .set-field.reps-split { gap: 4px; padding: 0 2px; }
  .lr-label {
    font-size: 10px; font-weight: 800; color: var(--accent);
    letter-spacing: 0.04em;
    padding-right: 2px;
  }
  .split-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 2px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .split-btn:hover { color: var(--accent); background: var(--surface-2); }
  .split-btn .material-symbols-rounded { font-size: 16px; }
  .split-btn.active { color: var(--accent); }

  .check-btn {
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    transition: color var(--dur-fast);
  }
  .check-btn.checked { color: var(--success); }
  .check-btn:active { transform: scale(0.9); }

  .remove-btn {
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast);
  }
  .remove-btn:hover { color: var(--danger); background: var(--surface-2); }
  .remove-btn .material-symbols-rounded { font-size: 18px; }

  /* RPE chip + picker popover */
  .rpe-wrap { position: relative; }
  .rpe-chip {
    padding: 3px 8px; border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-3);
    font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
    font-family: inherit; cursor: pointer;
    min-width: 34px; text-align: center;
  }
  .rpe-chip.set { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
  .rpe-chip:hover { border-color: var(--text-2); }
  /* Portaled to document.body — matches .num-picker treatment. */
  :global(.rpe-backdrop) { position: fixed; inset: 0; z-index: 200; }
  :global(.rpe-picker) {
    position: fixed;
    z-index: 201; padding: 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    min-width: 200px;
  }
  .rpe-opt {
    min-height: 40px;
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 14px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .rpe-opt:hover { background: var(--surface-3); }
  .rpe-opt.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .rpe-opt.clear { grid-column: span 4; color: var(--danger); background: transparent; border: 1px dashed var(--border); margin-top: 2px; }
</style>
