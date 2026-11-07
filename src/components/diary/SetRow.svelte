<script>
  import { closeOnBack } from '../../lib/back-stack.js';
  import { get } from 'svelte/store';
  import { fold } from '../../lib/fold.js';
  import { placeAnchoredMenu } from '../../lib/fold-core.js';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { trackRpe } from '../../stores/settings.js';
  import { haptic as _haptic } from '../../lib/haptics.js';
  import { portal } from '../../lib/portal.js';
  import { replaceOnType } from '../../lib/replaceOnType.js';
  import { parseDuration, fmtSetDuration, maskDurationInput, toMeters, fromMeters, rowShape, holdSides, sideHoldSec } from '../../lib/workout.js';

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
  /** A clip attached to this set (issue #57); the chip opens it. */
  export let media = null;
  /** Load type of the parent exercise. Drives:
   *    - Weight column unit suffix: 'lbs' (bilateral), 'lbs each' (paired),
   *      'lbs/side' (unilateral)
   *    - Whether the reps cell offers an L/R split (unilateral only).
   */
  export let loadType = 'bilateral';
  /** 'reps' (default) or 'time' (issue #89). A timed set logs a duration
   *  in place of reps; weight stays, for weighted holds and carries. */
  export let setType = 'reps';
  $: timed = setType === 'time';
  $: shape = rowShape(setType, loadType);
  // Distance and calorie sets (issue #119): the amount takes the reps
  // column, weight stays for a loaded sled or carry. Distance is stored in
  // meters and typed in the exercise's unit.
  $: distance = setType === 'distance';
  $: cals = setType === 'calories';
  export let distanceUnit = 'm';
  /** True while the hold timer is running for this set (issue #89). The
   *  parent card decides, since only it knows which exercise this row is. */
  export let holdRunning = false;

  $: weightHint = loadType === 'paired' ? `${unit} ea`
                : loadType === 'unilateral' ? `${unit}`
                : unit;
  // L/R split is only meaningful for unilateral exercises. When the user
  // taps the split icon we flip into split-mode where reps_l + reps_r are
  // edited separately; clearing both falls back to the single `reps` value.
  $: isSplit = setType === 'reps' && loadType === 'unilateral' && (set.reps_l != null || set.reps_r != null);
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

  // A timed Alternating exercise is held per side (issue #143): the same
  // L/R split, of times. duration_sec stays the shorter side, so records,
  // charts and an older app read the weaker side. A set an older app or the
  // watch changed to a single time reads as that time (holdSides).
  $: perSide = timed && loadType === 'unilateral';
  $: sides = perSide ? holdSides(set) : null;
  $: isTimeSplit = !!sides;
  function toggleTimeSplit() {
    if (isTimeSplit) {
      // Back to one time: the shorter side, which duration_sec already is.
      dispatch('update', { ...set, duration_l_sec: null, duration_r_sec: null });
    } else {
      const d = Math.round(Number(set.duration_sec)) || 0;
      dispatch('update', { ...set, duration_l_sec: d, duration_r_sec: d, duration_sec: d });
    }
  }
  function commitSideDuration(field, raw) {
    const sec = raw === '' || raw == null ? 0 : parseDuration(raw);
    if (sec == null) return;
    const cur = sides || { l: 0, r: 0 };
    const l = field === 'duration_l_sec' ? sec : cur.l;
    const r = field === 'duration_r_sec' ? sec : cur.r;
    if (sides && l === sides.l && r === sides.r) return;
    dispatch('update', { ...set, duration_l_sec: l, duration_r_sec: r, duration_sec: sideHoldSec(l, r) });
  }

  const dispatch = createEventDispatcher();

  // Plate-aware increment: 5 lb / 2.5 kg (matches the smallest common plate pair).
  $: step = unit === 'kg' ? 2.5 : 5;

  // RPE picker
  let rpeOpen = false;
  let rpeTriggerEl;
  let rpePickerPos = { edge: 'top:0px;', left: 0 };
  const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10];
  // Open-lock (350ms) prevents a stray backdrop dismissal from silently
  // closing the picker before a slightly-slipped tap on an option button
  // registers. Same pattern used in ActionSheet.svelte and TemplateSpecRow.
  let rpeLocked = false;
  let rpeLockTimer;
  function openRpePicker() {
    if (!rpeTriggerEl) { rpeOpen = true; return; }
    const r = rpeTriggerEl.getBoundingClientRect();
    rpePickerPos = pickerAt(r, Math.max(4, r.right - 200));
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
  let numPickerPos = { edge: 'top:0px;', left: 0 };
  $: displayNum = set.number != null ? set.number : setNum;
  const NUM_VALUES = [1, 2, 3, 4, 5, 6, 7, 8];
  let numLocked = false;
  let numLockTimer;
  function openNumPicker() {
    if (!numTriggerEl) { numOpen = true; return; }
    const r = numTriggerEl.getBoundingClientRect();
    numPickerPos = pickerAt(r, r.left);
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
  let durationFocused = false;
  let durationLFocused = false;
  let durationRFocused = false;
  let distanceFocused = false;
  let caloriesFocused = false;

  let weightStr = _fmt(set.weight);
  let repsStr = _fmt(set.reps);
  let repsLStr = _fmt(set.reps_l);
  let repsRStr = _fmt(set.reps_r);
  let durationStr = fmtSetDuration(set.duration_sec);
  let durationLStr = fmtSetDuration(set.duration_l_sec);
  let durationRStr = fmtSetDuration(set.duration_r_sec);
  let distanceStr = _fmt(fromMeters(set.distance_m, distanceUnit));
  let caloriesStr = _fmt(set.calories);

  function _fmt(v) { return v == null || Number.isNaN(v) ? '' : String(v); }

  // Sync the LOCAL string from the parent's set prop only when the
  // input isn't the current source of change. When focused we let the
  // user's typing win until they blur.
  $: if (!weightFocused) weightStr = _fmt(set.weight);
  $: if (!repsFocused)   repsStr   = _fmt(set.reps);
  $: if (!repsLFocused)  repsLStr  = _fmt(set.reps_l);
  $: if (!repsRFocused)  repsRStr  = _fmt(set.reps_r);
  $: if (!durationFocused) durationStr = fmtSetDuration(set.duration_sec);
  $: if (!durationLFocused) durationLStr = fmtSetDuration(sides?.l);
  $: if (!durationRFocused) durationRStr = fmtSetDuration(sides?.r);
  $: if (!distanceFocused) distanceStr = _fmt(fromMeters(set.distance_m, distanceUnit));
  $: if (!caloriesFocused) caloriesStr = _fmt(set.calories);

  // Typed in the exercise's unit, kept in meters. A value that converts back
  // to what is already stored is left alone, so focusing and leaving a field
  // never nudges a stored distance by a rounding step.
  function commitDistance(raw) {
    if (raw === '' || raw == null) {
      if (set.distance_m) update('distance_m', 0);
      return;
    }
    const m = toMeters(raw, distanceUnit);
    if (m == null) return;
    if (fromMeters(set.distance_m, distanceUnit) === fromMeters(m, distanceUnit)) return;
    update('distance_m', m);
  }

  // Duration entry, timer style: digits fill from the right on the number
  // pad ("130" reads 1:30), shown live as m:ss so nothing is left to guess.
  // Commits on every keystroke, like reps, so tapping the tick straight
  // after typing can never complete the set with a stale duration. On blur
  // an overflowing value such as 0:90 tidies to 1:30.
  function commitDuration(raw) {
    if (raw === '' || raw == null) {
      if (set.duration_sec) update('duration_sec', 0);
      return;
    }
    const sec = parseDuration(raw);
    if (sec == null) return;
    if (sec !== set.duration_sec) update('duration_sec', sec);
  }

  function commitNumber(field, raw, parser) {
    // Empty string commits as 0 (matches the old behaviour). Otherwise
    // parse — if the parse is NaN (mid-typing like "-" or "."), skip
    // the dispatch and let the input keep showing what the user typed.
    if (raw === '' || raw == null) { update(field, 0); return; }
    const n = parser(raw);
    if (Number.isNaN(n)) return;
    if (n !== set[field]) update(field, n);
  }

  // These pickers are four buttons wide and two or three rows tall, and they
  // only ever opened downwards, so near the bottom of a screen they ran off
  // it. They now take the roomier side, and on a foldable lying open the
  // crease is the end of the room rather than a line to straddle.
  const PICKER_H = 120;
  function pickerAt(rect, left) {
    const place = placeAnchoredMenu({
      anchorTop: rect.top, anchorBottom: rect.bottom,
      viewportHeight: document.documentElement.clientHeight || window.innerHeight,
      maxHeight: PICKER_H, gap: 4, margin: 4, fold: get(fold),
    });
    // Above the field it hangs from its bottom edge, so a picker shorter
    // than the room still sits against the field.
    return { edge: place.edge, left };
  }
</script>

<!-- The grid is chosen by the exercise (rowShape), not by what this row
     happens to hold, so every row of a card and its heading line up. -->
<div class="set-row" class:done={set.completed} class:pulse={pulseOn} class:warmup={showAsWarmup} class:is-next={isNext} class:pr={isPR}
  class:rpe={$trackRpe} class:wide={shape.wide} class:hold={shape.hold} class:uni={shape.uni} class:sides={shape.sides}>
  {#if media}
    <button type="button" class="clip-badge" on:click|stopPropagation={() => dispatch('openMedia', media)}
      title="Watch this set" aria-label="Watch this set">
      <span class="material-symbols-rounded">play_circle</span>
    </button>
  {/if}
  {#if isPR}
    <span class="pr-badge" title="New personal record!">🔥 PR</span>
  {/if}
  {#if showAsWarmup}
    <span class="set-num">W</span>
  {:else}
    <div class="set-num-wrap">
      <button class="set-num set-num-btn tap" class:custom={set.number != null}
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
        <div use:portal class="num-backdrop" on:click={closeNumIfUnlocked} use:closeOnBack={() => numOpen = false}></div>
        <div use:portal class="num-picker" style="{numPickerPos.edge} left:{numPickerPos.left}px">
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
    <button class="step-btn tap" on:click={() => bumpWeight(-step)} aria-label="Decrease weight" tabindex="-1">−</button>
    <input
      type="number"
      class="set-input"
      bind:value={weightStr}
      on:input={() => commitNumber('weight', weightStr, parseFloat)}
      use:replaceOnType
        on:focus={() => { weightFocused = true; }}
      on:blur={() => { weightFocused = false; commitNumber('weight', weightStr, parseFloat); }}
      placeholder="0"
      inputmode="decimal"
    />
    <button class="step-btn tap" on:click={() => bumpWeight(step)} aria-label="Increase weight" tabindex="-1">+</button>
    <!-- Per hand: "lbs ea". In the narrowest field the unit goes and "ea"
         stays, since a weight per hand is not the same number. -->
    <span class="set-unit" class:each={loadType === 'paired'}>{#if loadType === 'paired'}<span class="unit-word">{unit}</span> ea{:else}{weightHint}{/if}</span>
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
        use:replaceOnType
        on:focus={() => { repsLFocused = true; }}
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
        use:replaceOnType
        on:focus={() => { repsRFocused = true; }}
        on:blur={() => { repsRFocused = false; commitNumber('reps_r', repsRStr, parseInt); }}
        placeholder="0"
        inputmode="numeric"
      />
      <button class="split-btn tap active" on:click={toggleSplit} title="Merge L/R" aria-label="Merge L/R">
        <span class="material-symbols-rounded">link_off</span>
      </button>
    </div>
  {:else if isTimeSplit}
    <!-- An Alternating hold timed per side (issue #143): a time for each
         side, typed as the single time is, with the hold timer (it times
         left, then right) and the button back to one time. -->
    <div class="set-field reps-split time-split">
      <span class="lr-label">L</span>
      <input
        type="text"
        class="set-input duration-input"
        bind:value={durationLStr}
        on:input={() => { durationLStr = maskDurationInput(durationLStr); commitSideDuration('duration_l_sec', durationLStr); }}
        use:replaceOnType
        on:focus={() => { durationLFocused = true; }}
        on:blur={() => { durationLFocused = false; commitSideDuration('duration_l_sec', durationLStr); durationLStr = fmtSetDuration(holdSides(set)?.l); }}
        on:keydown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        placeholder="0:00"
        inputmode="numeric"
        autocomplete="off"
        aria-label={$_('hold_timer.left_time')}
      />
      <span class="lr-label">R</span>
      <input
        type="text"
        class="set-input duration-input"
        bind:value={durationRStr}
        on:input={() => { durationRStr = maskDurationInput(durationRStr); commitSideDuration('duration_r_sec', durationRStr); }}
        use:replaceOnType
        on:focus={() => { durationRFocused = true; }}
        on:blur={() => { durationRFocused = false; commitSideDuration('duration_r_sec', durationRStr); durationRStr = fmtSetDuration(holdSides(set)?.r); }}
        on:keydown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        placeholder="0:00"
        inputmode="numeric"
        autocomplete="off"
        aria-label={$_('hold_timer.right_time')}
      />
      {#if !set.completed || holdRunning}
        <button class="split-btn hold-btn tap" class:active={holdRunning}
          on:click={() => dispatch(holdRunning ? 'stopHold' : 'startHold')}
          title={holdRunning ? $_('hold_timer.stop') : $_('hold_timer.start')}
          aria-label={holdRunning ? $_('hold_timer.stop') : $_('hold_timer.start')}>
          <span class="material-symbols-rounded">{holdRunning ? 'stop_circle' : 'timer'}</span>
        </button>
      {:else}
        <!-- One button fits beside two times on a 320px phone: the timer
             while the set is open, the way back to one time once done. -->
        <button class="split-btn tap active" on:click={toggleTimeSplit} title={$_('hold_timer.merge_sides')} aria-label={$_('hold_timer.merge_sides')}>
          <span class="material-symbols-rounded">link_off</span>
        </button>
      {/if}
    </div>
  {:else if timed}
    <div class="set-field">
      <input
        type="text"
        class="set-input duration-input"
        class:hours={durationStr.split(':').length > 2}
        bind:value={durationStr}
        on:input={() => { durationStr = maskDurationInput(durationStr); commitDuration(durationStr); }}
        use:replaceOnType
        on:focus={() => { durationFocused = true; }}
        on:blur={() => { durationFocused = false; commitDuration(durationStr); durationStr = fmtSetDuration(set.duration_sec); }}
        on:keydown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        placeholder="0:00"
        inputmode="numeric"
        autocomplete="off"
        aria-label="Duration"
      />
      <!-- An Alternating exercise can be timed per side by hand too. -->
      {#if perSide && !holdRunning}
        <button class="split-btn tap" on:click={toggleTimeSplit} title={$_('hold_timer.split_sides')} aria-label={$_('hold_timer.split_sides')}>
          <span class="material-symbols-rounded">add_link</span>
        </button>
      {/if}
      <!-- Hold timer: sits inside the field like the L/R split button does
           in the reps field, so the row gets no wider on a narrow phone. -->
      {#if !set.completed || holdRunning}
        <button class="split-btn hold-btn tap" class:active={holdRunning}
          on:click={() => dispatch(holdRunning ? 'stopHold' : 'startHold')}
          title={holdRunning ? $_('hold_timer.stop') : $_('hold_timer.start')}
          aria-label={holdRunning ? $_('hold_timer.stop') : $_('hold_timer.start')}>
          <span class="material-symbols-rounded">{holdRunning ? 'stop_circle' : 'timer'}</span>
        </button>
      {/if}
    </div>
  {:else if distance}
    <div class="set-field">
      <input
        type="text"
        class="set-input amount-input"
        bind:value={distanceStr}
        on:input={() => commitDistance(distanceStr)}
        use:replaceOnType
        on:focus={() => { distanceFocused = true; }}
        on:blur={() => { distanceFocused = false; commitDistance(distanceStr); distanceStr = _fmt(fromMeters(set.distance_m, distanceUnit)); }}
        on:keydown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        placeholder="0"
        inputmode="decimal"
        autocomplete="off"
        aria-label={$_('exercise_card.distance')}
      />
      <!-- The unit, as the weight field shows "kg": the column header only
           says Distance, so it fits on one line at phone widths. -->
      <span class="set-unit">{distanceUnit}</span>
    </div>
  {:else if cals}
    <div class="set-field">
      <input
        type="number"
        class="set-input amount-input"
        bind:value={caloriesStr}
        on:input={() => commitNumber('calories', caloriesStr, parseInt)}
        use:replaceOnType
        on:focus={() => { caloriesFocused = true; }}
        on:blur={() => { caloriesFocused = false; commitNumber('calories', caloriesStr, parseInt); }}
        placeholder="0"
        inputmode="numeric"
        aria-label={$_('exercise_card.calories')}
      />
    </div>
  {:else}
    <div class="set-field">
      <input
        type="number"
        class="set-input"
        bind:value={repsStr}
        on:input={() => commitNumber('reps', repsStr, parseInt)}
        use:replaceOnType
        on:focus={() => { repsFocused = true; }}
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
        <button class="split-btn tap" on:click={toggleSplit} title="Split L/R reps" aria-label="Split L/R reps">
          <span class="material-symbols-rounded">add_link</span>
        </button>
      {/if}
    </div>
  {/if}

  <button class="check-btn tap" class:checked={set.completed} on:click={toggleComplete} aria-label={set.completed ? 'Mark incomplete' : 'Mark complete'}>
    <span class="material-symbols-rounded">
      {set.completed ? 'check_circle' : 'radio_button_unchecked'}
    </span>
  </button>

  {#if $trackRpe && !showAsWarmup}
    <div class="rpe-wrap">
      <button class="rpe-chip tap" class:set={set.rpe != null}
        bind:this={rpeTriggerEl}
        on:click={() => rpeOpen ? (rpeOpen = false) : openRpePicker()}
        title="Rate of Perceived Exertion">
        {set.rpe != null ? `@${set.rpe}` : 'RPE'}
      </button>
      {#if rpeOpen}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div use:portal class="rpe-backdrop" on:click={closeRpeIfUnlocked} use:closeOnBack={() => rpeOpen = false}></div>
        <div use:portal class="rpe-picker" style="{rpePickerPos.edge} left:{rpePickerPos.left}px">
          {#each RPE_VALUES as v}
            <button class="rpe-opt" class:active={set.rpe === v} on:click|stopPropagation={() => pickRpe(v)}>@{v}</button>
          {/each}
          {#if set.rpe != null}
            <button class="rpe-opt clear" on:click|stopPropagation={clearRpe}>Clear</button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if $trackRpe}
    <!-- A warm-up has no RPE, but keeps the column so it lines up. -->
    <span class="rpe-slot" aria-hidden="true"></span>
  {/if}

  <button class="remove-btn tap" on:click={() => dispatch('remove')} title="Remove set" aria-label="Remove set">
    <span class="material-symbols-rounded">close</span>
  </button>
</div>

<style>
  /* Tap areas on a touch screen (.tap, styles/buttons.css): 44px tall, the
     rows are 49px apart. Across, no control's area reaches past half the
     6px gap to its neighbor's box: the set number leans into the card's
     left edge, and check and remove share the gap between them unevenly
     with remove leaning into the card's right edge, so these reach 44.
     − reaches over the field's edge; + sits between the input and the unit
     (a tap on the unit must not change the weight), and the L/R and hold
     buttons against their input, so they keep less across. Kept above the
     phone layout below (@container sets), whose tighter values must come
     later to win: the selectors weigh the same. */
  .set-num-btn { --tap-w: 44px; --tap-dx: -6px; }
  .rpe-chip { --tap-w: calc(100% + 8px); }
  .step-btn { --tap-w: 32px; --tap-dx: -5px; }
  .step-btn + .set-input + .step-btn { --tap-w: 100%; --tap-dx: 0px; }
  .split-btn { --tap-w: 100%; }
  .check-btn { --tap-w: 44px; --tap-dx: 1px; }
  .remove-btn { --tap-w: 44px; --tap-dx: 5px; }
  .set-row.rpe .check-btn { --tap-w: calc(100% + 6px); --tap-dx: 0px; }
  .set-row.rpe .remove-btn { --tap-dx: 3px; }
  /* The columns: set number, weight, the second column (reps, a time, a
     distance, calories, or L/R reps), done, RPE when it is tracked, remove.
     minmax(0, _fr) lets the columns actually shrink on narrow viewports;
     default 1fr won't go below the intrinsic width of an <input>.
     Weight gets more flex than reps (1.4 vs 0.7) since weight has step
     buttons + unit + 3-4 digit values, while reps is a plain input that's
     almost always 1-2 digits. A time, a distance, calories, and an
     alternating exercise's reps (an L/R split, or the button for one) need
     more, so those exercises split evenly (`wide`). The same variables
     shape the heading row (ExerciseCard.svelte), which carries the same
     classes, so every label sits over its column. */
  .set-row {
    --c-num: 28px; --c-w: 1.4fr; --c-s: 0.7fr; --c-check: 36px; --c-rpe: 40px; --c-rm: 32px; --row-gap: 6px;
    display: grid;
    grid-template-columns: var(--c-num) minmax(0, var(--c-w)) minmax(0, var(--c-s)) var(--c-check) var(--c-rm);
    gap: var(--row-gap);
    align-items: center;
    padding: 6px 0;
    transition: opacity var(--dur-fast), background var(--dur-base);
    border-radius: var(--radius-sm);
  }
  /* RPE gets a fixed column on every row (a warm-up keeps it empty), so the
     rows and the heading share one grid. */
  .set-row.rpe {
    grid-template-columns: var(--c-num) minmax(0, var(--c-w)) minmax(0, var(--c-s)) var(--c-check) var(--c-rpe) var(--c-rm);
  }
  .set-row.wide { --c-w: 1fr; --c-s: 1fr; }
  /* A phone (the card's set list under 340px, `sets` in ExerciseCard): at
     320px with RPE on, the fixed columns and gaps left 86px for weight and
     the second column together, and reps, an L/R split, a 2000 m distance
     and a 1:30 hold all showed cut or empty. The fixed columns and gaps
     tighten, the second column's padding halves, and a hold or an L/R
     split gets the larger share (its field also holds a button). */
  @container sets (max-width: 340px) {
    .set-row { --c-num: 24px; --c-check: 30px; --c-rpe: 34px; --c-rm: 26px; --row-gap: 4px; }
    .set-row.hold, .set-row.uni { --c-w: 0.8fr; --c-s: 1.2fr; }
    .set-row.sides { --c-w: 0.65fr; --c-s: 1.35fr; }
    .set-field:not(.weight-field) { padding: 0 4px; }
    .set-row .set-field.reps-split { padding: 0 2px; gap: 2px; }
    .set-row .set-field.time-split { gap: 1px; }
    .set-row .set-num-btn { min-width: 22px; }
    .set-row .rpe-chip { padding: 3px 2px; min-width: 0; }
    /* Tap areas with 4px gaps: none reaches more than 2px into a gap. The
       remove button leans right, into the card's padding; done and the RPE
       chip keep to their own column plus 2px. */
    .set-row .remove-btn, .set-row.rpe .remove-btn { --tap-dx: 8px; }
    .set-row .set-num-btn { --tap-dx: -8px; }
    .set-row .check-btn, .set-row.rpe .check-btn { --tap-w: calc(100% + 4px); --tap-dx: 0px; }
    .set-row .rpe-chip { --tap-w: calc(100% + 4px); }
  }
  /* The narrowest phones (a 320px screen; 360px stays above this): the
     fixed columns give a little more, the L and R letters go (left is still
     first), and a hold gets the room for an hour-long time (1:02:05) beside
     its timer button while its weight keeps room for "22.5 ea". */
  @container sets (max-width: 280px) {
    .set-row { --c-check: 28px; --c-rpe: 30px; --c-rm: 24px; --row-gap: 3px; }
    .set-row .lr-label { display: none; }
    /* 3px gaps: no tap area reaches more than 1px into one. */
    .set-row .remove-btn, .set-row.rpe .remove-btn { --tap-dx: 9px; }
    .set-row .set-num-btn { --tap-dx: -9px; }
    .set-row .check-btn, .set-row.rpe .check-btn, .set-row .rpe-chip { --tap-w: calc(100% + 2px); }
    .set-row.hold { --c-w: 0.9fr; --c-s: 1.1fr; }
    .set-row.sides { --c-w: 0.65fr; --c-s: 1.35fr; }
    .set-row .duration-input.hours { font-size: 11px; }
    .set-row.hold .set-field:not(.weight-field) { padding: 0 2px; gap: 2px; }
  }
  .set-row.done { opacity: 0.6; }
  /* A clip on this set. Sits opposite the PR badge so the two never fight
     for the same corner, and stays small: it marks the row, the player is
     where the clip actually lives. */
  .clip-badge {
    position: absolute; top: -9px; left: 10px; z-index: 2;
    width: 24px; height: 24px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid var(--accent);
    background: var(--surface-1); color: var(--accent);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .clip-badge .material-symbols-rounded { font-size: 18px; }
  .clip-badge:active { transform: scale(0.92); }

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
  .weight-field { padding: 0 4px; gap: 2px; container-type: inline-size; }
  /* The weight itself comes first. The ± buttons and the unit take about
     70px of a field that, with RPE on or beside an L/R split, a timer or a
     distance, can be under 100px wide on a phone, and the number was what
     gave: a 102.5 showed as nothing at 360px with RPE on. So when the field
     is too narrow for the buttons and a five-digit weight, the buttons go
     (the weight is still typed, as in a superset, issue #75), and when it
     is narrower still, the unit goes too (the column heading says Weight),
     unless it says "ea": a weight per hand is not the same number. */
  @container (max-width: 124px) {
    .weight-field .step-btn { display: none; }
  }
  @container (max-width: 72px) {
    .weight-field .set-unit:not(.each), .weight-field .unit-word { display: none; }
  }
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
  /* Tapped and not typed in yet: the next digit replaces this value. Dimmed
     so that is visible without selecting the text, which on Android brings
     up the system text toolbar over the row (issue #95). */
  .set-input:global(.replace-pending) { color: var(--text-3); }
  .set-input::-webkit-inner-spin-button,
  .set-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .set-unit { font-size: 11px; color: var(--text-3); white-space: nowrap; }
  /* Durations change width as they tick up (0:45 -> 1:00); tabular figures
     stop the column shifting while typing. */
  .duration-input, .amount-input { font-variant-numeric: tabular-nums; }
  /* With RPE on, the distance field is too narrow for "10000" and a unit
     beside it at 360px; the column header names the unit instead. */
  .set-row.rpe .amount-input + .set-unit { display: none; }
  .hold-btn.active { color: var(--danger, #FF5C5C); animation: hold-blink 1s ease-in-out infinite; }
  @keyframes hold-blink { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .hold-btn.active { animation: none; } }

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
  /* Two times side by side (issue #143): a little smaller than one, so
     0:45 and 0:40 both show beside the button on a 320px phone. */
  .time-split .duration-input { font-size: 13px; }
  .time-split .lr-label { padding-right: 0; }
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
    width: 100%;
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
