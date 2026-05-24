<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import SetRow from './SetRow.svelte';
  import { LtApi } from '../../lib/api.js';
  import { getCollapseState, setCollapsed } from '../../lib/cardCollapse.js';
  import { generateWarmupSets, exerciseVolume } from '../../lib/workout.js';
  import { exerciseLoadTypes } from '../../stores/settings.js';

  export let exercise;
  export let idx;
  export let unit = 'lbs';
  export let canMoveUp = false;
  export let canMoveDown = false;
  export let autoCollapse = false;
  export let date = '';
  // Set indices flagged as PRs for this exercise's current logging.
  // Diary computes this once per save based on cached previous bests.
  export let prSetIndices = null;

  // Per-card collapse key: stable per workout-day + position. Reorders will
  // shift collapse state with the position rather than with the exercise
  // itself, which is acceptable for the cases we've seen.
  $: rowKey = `ex:${idx}:${exercise?.exercise_id ?? exercise?.exercise_name ?? ''}`;

  const dispatch = createEventDispatcher();

  $: sets = exercise.sets || [];
  // Warm-up sets don't count toward the "N/M sets" header, volume,
  // PRs, or the "all done" auto-collapse signal.
  $: workingSets = sets.filter(s => !s.warmup);
  $: completedCount = workingSets.filter(s => s.completed).length;
  $: inSuperset = exercise.superset_id != null && exercise.superset_size > 1;

  // "Last time" ghost row — previous completed session for this exercise.
  let lastSession = null;
  let _lastSessionFetched = null;
  $: if (exercise.exercise_id && exercise.exercise_id !== _lastSessionFetched) {
    _lastSessionFetched = exercise.exercise_id;
    loadLastSession();
  }
  async function loadLastSession() {
    lastSession = null;
    try {
      const history = await LtApi.getWorkoutHistory(exercise.exercise_id);
      if (!history || !history.length) return;
      // Skip the current-day log if it happens to be in history (avoid showing today as "last time")
      const recent = history.find(h => (h.sets || []).some(s => s.completed));
      if (!recent) return;
      const completed = recent.sets.filter(s => s.completed);
      if (completed.length) lastSession = { date: recent.date, sets: completed };
    } catch {}
  }

  // Load type for this exercise instance. Stored on the exercise object
  // itself so it's saved with the workout; falls back to the user's
  // per-exercise preference (when they ticked "Remember"), then bilateral.
  $: loadType = exercise.load_type
                  || ($exerciseLoadTypes && exercise.exercise_id != null
                      ? $exerciseLoadTypes[exercise.exercise_id]
                      : null)
                  || 'bilateral';
  $: loadTypeLabel = loadType === 'paired' ? 'Per side'
                   : loadType === 'unilateral' ? 'Alternating'
                   : 'Bilateral';

  let loadMenuOpen = false;
  let rememberLoad = false;
  function pickLoadType(nextType) {
    loadMenuOpen = false;
    // Always store the chosen type on the exercise instance so it survives
    // route remounts. If "Remember" is ticked, also update the user's
    // per-exercise default so the next time they add this lift it
    // pre-fills with the same mode.
    dispatch('update', { ...exercise, load_type: nextType });
    if (rememberLoad && exercise.exercise_id != null) {
      exerciseLoadTypes.update(curr => ({ ...(curr || {}), [exercise.exercise_id]: nextType }));
    }
  }

  // Volume of this exercise's completed sets (current + last session for delta)
  // Uses the load-type-aware helper so per-side / alternating sets get the
  // correct multiplier (×2, or sum of L+R when split).
  $: currentVolume = exerciseVolume({ ...exercise, load_type: loadType });
  $: lastVolume = lastSession ? exerciseVolume({ load_type: loadType, sets: lastSession.sets.map(s => ({ ...s, completed: true })) }) : 0;
  $: volumeDeltaPct = lastVolume > 0 && currentVolume > 0 ? Math.round((currentVolume - lastVolume) / lastVolume * 100) : null;

  // Progression nudge: if last session hit target reps across the board at a given weight,
  // suggest +5 (or +2.5 for kg) on today's target weight.
  $: progressionSuggestion = (() => {
    if (!lastSession || !exercise.target_reps) return null;
    const tgtReps = parseInt(String(exercise.target_reps).split(/[-\u2013]/)[0]);
    if (!Number.isFinite(tgtReps)) return null;
    const hitAll = lastSession.sets.length > 0 && lastSession.sets.every(s => (parseInt(s.reps) || 0) >= tgtReps);
    if (!hitAll) return null;
    const lastWeight = Math.max(...lastSession.sets.map(s => parseFloat(s.weight) || 0));
    if (!lastWeight) return null;
    const step = unit === 'kg' ? 2.5 : 5;
    return { weight: lastWeight + step, step };
  })();

  // Auto-collapse when all sets complete. Signature-gated within a session,
  // AND respects an explicit "expanded" state the user set earlier so it
  // won't re-close a card the user deliberately re-opened.
  let _autoCollapsedSignature = '';
  $: {
    if (autoCollapse && workingSets.length > 0 && completedCount === workingSets.length) {
      const sig = `${exercise.exercise_id}|${workingSets.length}`;
      if (_autoCollapsedSignature !== sig) {
        _autoCollapsedSignature = sig;
        // Don't auto-collapse if the user has explicitly expanded this card.
        if (getCollapseState(date, rowKey) !== 'expanded') {
          _setExpanded(false);
        }
      }
    }
  }

  // Persist collapse state across navigation. Initial read on mount — then
  // whenever the user toggles, write through. Three-state model:
  //   'collapsed' → apply closed
  //   'expanded'  → apply open (explicit user intent — no auto-collapse)
  //   null        → keep default (open)
  let _initialExpandedApplied = false;
  $: if (date && rowKey && !_initialExpandedApplied) {
    _initialExpandedApplied = true;
    const state = getCollapseState(date, rowKey);
    if (state === 'collapsed') expanded = false;
    else if (state === 'expanded') expanded = true;
  }
  function _setExpanded(next) {
    expanded = next;
    setCollapsed(date, rowKey, !next);
  }

  function fmtRelDate(d) {
    if (!d) return '';
    const date = new Date(d + 'T12:00:00'); date.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((today - date) / 86400000);
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff}d ago`;
    if (diff < 30) return `${Math.round(diff/7)}w ago`;
    return `${Math.round(diff/30)}mo ago`;
  }
  // Progress state for left-edge strip: 'none' | 'partial' | 'done'
  $: progress = workingSets.length === 0
    ? 'none'
    : completedCount === 0
      ? 'none'
      : completedCount === workingSets.length
        ? 'done'
        : 'partial';
  let expanded = true;

  function addSet() {
    const lastSet = sets[sets.length - 1] || { reps: 0, weight: 0 };
    const updated = {
      ...exercise,
      sets: [...sets, { reps: lastSet.reps, weight: lastSet.weight, completed: false, notes: '' }],
    };
    dispatch('update', updated);
  }

  // Index of the first uncompleted WORKING set — the one the lifter should
  // do next. Used by SetRow to render a subtle highlight. -1 when the
  // exercise has no incomplete working sets (all done, or warm-ups only).
  $: nextSetIdx = (() => {
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      if (!s.warmup && !s.completed) return i;
    }
    return -1;
  })();

  // Warm-up handling
  $: hasWarmups    = sets.some(s => s.warmup);
  $: firstWorking  = sets.find(s => !s.warmup);
  $: workingWeight = parseFloat(firstWorking?.weight ?? exercise.target_weight ?? 0) || 0;
  // Working-set numbering skips warm-ups: W / W / W / 1 / 2 / 3
  function _workingSetNum(i) {
    let n = 0;
    for (let k = 0; k <= i; k++) if (!sets[k]?.warmup) n++;
    return n;
  }
  function addWarmups() {
    const generated = generateWarmupSets(workingWeight, unit);
    if (generated.length === 0) return;
    dispatch('update', { ...exercise, sets: [...generated, ...sets] });
  }

  function updateSet(setIdx, set) {
    const updatedSets = [...sets];
    const old = sets[setIdx];
    updatedSets[setIdx] = set;

    // When the user explicitly picks a round number on this set, propagate
    // the same delta to every subsequent working set in this exercise.
    // The lifter is saying "I'm actually on round N, not the auto-computed
    // M" — the sets after this should follow the same shift so they don't
    // have to be retyped one-by-one.
    const numberChanged = old?.number !== set.number && !old?.warmup;
    if (numberChanged && set.number != null) {
      // Compute the working-set position of set[setIdx] (skipping warmups).
      let pos = 0;
      for (let i = 0; i < setIdx; i++) {
        if (!sets[i].warmup) pos++;
      }
      const delta = set.number - (pos + 1);
      if (delta !== 0) {
        let workPos = pos;
        for (let i = setIdx + 1; i < updatedSets.length; i++) {
          if (updatedSets[i].warmup) continue;
          workPos++;
          const newNum = workPos + 1 + delta;
          if (newNum >= 1 && newNum <= 8) {
            updatedSets[i] = { ...updatedSets[i], number: newNum };
          }
        }
      }
    } else if (numberChanged && set.number == null) {
      // Cleared the override on this set — also clear every subsequent
      // working set's override, since we no longer have a basis for the
      // shift and the user almost certainly wants the chain reset.
      for (let i = setIdx + 1; i < updatedSets.length; i++) {
        if (updatedSets[i].warmup) continue;
        if (updatedSets[i].number != null) {
          const { number, ...rest } = updatedSets[i];
          updatedSets[i] = rest;
        }
      }
    }

    dispatch('update', { ...exercise, sets: updatedSets });
  }

  function removeSet(setIdx) {
    dispatch('update', { ...exercise, sets: sets.filter((_, i) => i !== setIdx) });
  }

  function remove() { dispatch('remove'); }
</script>

<div class="ex-card" class:all-done={completedCount === workingSets.length && workingSets.length > 0} class:standalone={!inSuperset} data-progress={progress}>
  {#if loadMenuOpen}
    <!-- Load-type chooser. Tap outside the menu (backdrop) to close. -->
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="load-menu-backdrop" on:click={() => loadMenuOpen = false}></div>
    <div class="load-menu" role="menu" on:click|stopPropagation>
      <div class="load-menu-head">Load type</div>
      {#each [['bilateral','Bilateral','single load — barbell, machine, both arms move one thing'],
              ['paired','Per side','both arms work together with separate equal loads — dumbbells, paired cables'],
              ['unilateral','Alternating','one side at a time — single-arm cable row, single-arm DB row']] as [val, label, hint]}
        <button class="load-menu-item" class:active={loadType === val} role="menuitem"
                on:click={() => pickLoadType(val)}>
          <div class="lm-text">
            <span class="lm-label">{label}</span>
            <span class="lm-hint">{hint}</span>
          </div>
          {#if loadType === val}
            <span class="material-symbols-rounded lm-check">check</span>
          {/if}
        </button>
      {/each}
      <label class="load-menu-remember">
        <input type="checkbox" bind:checked={rememberLoad} />
        <span>Remember for this exercise</span>
      </label>
    </div>
  {/if}
  <div class="ex-header"
    on:click={() => _setExpanded(!expanded)}
    on:contextmenu|preventDefault={() => dispatch('menu')}>
    <div class="ex-info">
      <div class="ex-name-row">
        <span class="ex-name">{exercise.exercise_name}</span>
        <button class="load-chip" class:non-default={loadType !== 'bilateral'}
                on:click|stopPropagation={() => loadMenuOpen = !loadMenuOpen}
                title="Load type">
          {#if loadType === 'paired'}<span class="material-symbols-rounded">compare_arrows</span>{loadTypeLabel}
          {:else if loadType === 'unilateral'}<span class="material-symbols-rounded">swap_horiz</span>{loadTypeLabel}
          {:else}<span class="material-symbols-rounded">straighten</span>{/if}
        </button>
      </div>
      <span class="ex-meta">{completedCount}/{workingSets.length} sets</span>
    </div>
    <div class="ex-actions">
      {#if canMoveUp}
        <button class="btn-icon-sm" on:click|stopPropagation={() => dispatch('moveUp')} title="Move up">
          <span class="material-symbols-rounded">keyboard_double_arrow_up</span>
        </button>
      {/if}
      {#if canMoveDown}
        <button class="btn-icon-sm" on:click|stopPropagation={() => dispatch('moveDown')} title="Move down">
          <span class="material-symbols-rounded">keyboard_double_arrow_down</span>
        </button>
      {/if}
      <button class="btn-icon-sm" on:click|stopPropagation={() => dispatch('info')} title="View exercise details" aria-label="View exercise details">
        <span class="material-symbols-rounded">info</span>
      </button>
      <button class="btn-icon-sm" on:click|stopPropagation={() => dispatch('menu')} title="More options">
        <span class="material-symbols-rounded">more_vert</span>
      </button>
      <button class="btn-icon" on:click|stopPropagation={remove} title="Remove exercise">
        <span class="material-symbols-rounded">close</span>
      </button>
      <span class="material-symbols-rounded expand-icon" class:rotated={!expanded}>expand_more</span>
    </div>
  </div>

  {#if expanded}
    {#if lastSession}
      <div class="last-row" title="Last completed session">
        <span class="last-label">Last ({fmtRelDate(lastSession.date)})</span>
        <span class="last-sets">
          {#each lastSession.sets as s, i}
            <span class="last-set">{s.weight || 0}×{s.reps || 0}</span>{#if i < lastSession.sets.length - 1}<span class="last-sep">·</span>{/if}
          {/each}
        </span>
        {#if volumeDeltaPct !== null && volumeDeltaPct !== 0}
          <span class="vol-delta" class:up={volumeDeltaPct > 0} class:down={volumeDeltaPct < 0}
                title="Volume vs last session">
            {volumeDeltaPct > 0 ? '+' : ''}{volumeDeltaPct}%
          </span>
        {/if}
      </div>
    {/if}
    <div class="sets-wrap">
      <div class="sets-header">
        <span class="sh-set">Set</span>
        <span class="sh-weight">Weight</span>
        <span class="sh-reps">Reps</span>
        <span class="sh-done"></span>
        <!-- placeholder over the remove-set column so the right edge of the
             header lines up with the right edge of every SetRow -->
        <span class="sh-spacer"></span>
      </div>

      {#each sets as set, setIdx (setIdx)}
        <SetRow
          {set}
          setNum={_workingSetNum(setIdx)}
          showAsWarmup={!!set.warmup}
          isNext={setIdx === nextSetIdx}
          isPR={prSetIndices?.has(setIdx)}
          {unit}
          {loadType}
          on:update={e => updateSet(setIdx, e.detail)}
          on:remove={() => removeSet(setIdx)}
        />
      {/each}

      <div class="add-set-actions">
        <button class="add-set-btn" on:click={addSet}>
          <span class="material-symbols-rounded">add</span>
          Add Set
        </button>
        {#if !hasWarmups && workingWeight > 0}
          <button class="add-warmup-btn" on:click={addWarmups} title="Add warm-up progression based on working weight">
            <span class="material-symbols-rounded">bolt</span>
            Warm-ups
          </button>
        {/if}
      </div>
    </div>

    {#if exercise.target_weight || exercise.target_reps || exercise.notes || progressionSuggestion}
      <div class="target-info">
        {#if exercise.target_weight}<span class="target-chip">Target: {exercise.target_weight}</span>{/if}
        {#if exercise.target_reps}<span class="target-chip">{exercise.target_reps} reps</span>{/if}
        {#if progressionSuggestion}
          <span class="progression-chip" title="Last session hit target reps — try going up">
            <span class="material-symbols-rounded">trending_up</span>
            Try {progressionSuggestion.weight} ({unit === 'kg' ? '+2.5' : '+5'})
          </span>
        {/if}
        {#if exercise.notes}<span class="target-note">{exercise.notes}</span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .ex-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    position: relative;
    transition: border-color var(--dur-fast);
  }
  .ex-card.all-done { border-color: var(--success); }

  /* Left-edge progress strip for standalone (non-superset) cards */
  .ex-card.standalone::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    background: var(--border);
    transition: background var(--dur-fast);
  }
  .ex-card.standalone[data-progress='partial']::before {
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
    box-shadow: 0 0 8px var(--accent-dim);
  }
  .ex-card.standalone[data-progress='done']::before {
    background: var(--success);
    box-shadow: 0 0 8px color-mix(in srgb, var(--success) 40%, transparent);
  }

  .ex-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 14px 10px;
    cursor: pointer;
  }
  .ex-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .ex-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .ex-name {
    font-size: 15px; font-weight: 700; color: var(--text-1);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .ex-meta { font-size: 12px; color: var(--text-3); }

  /* Load-type chip — tiny pill next to the exercise name. Quiet (dashed
     border, muted color) when bilateral (the default); accent-styled
     when on a non-default mode so the override is visible at a glance. */
  .load-chip {
    display: inline-flex; align-items: center; gap: 3px;
    background: none; border: 1px dashed var(--border);
    color: var(--text-3); cursor: pointer; font-family: inherit;
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 7px; border-radius: var(--radius-full);
    flex-shrink: 0;
  }
  .load-chip:hover { color: var(--text-1); border-color: var(--text-2); }
  .load-chip .material-symbols-rounded { font-size: 12px; }
  .load-chip.non-default {
    background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent);
    border-style: solid;
  }

  /* Load-type menu — small popover anchored to the card */
  .load-menu-backdrop {
    position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,0.2);
  }
  .load-menu {
    position: absolute; top: 56px; left: 14px; right: 14px;
    z-index: 31;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
    padding: 8px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .load-menu-head {
    font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 6px 6px;
  }
  .load-menu-item {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 8px; padding: 8px 10px;
    background: none; border: none; cursor: pointer;
    text-align: left; font-family: inherit;
    color: var(--text-1); border-radius: var(--radius-md);
  }
  .load-menu-item:hover { background: var(--surface-2); }
  .load-menu-item.active { background: var(--accent-dim); }
  .lm-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .lm-label { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .lm-hint  { font-size: 11px; color: var(--text-3); line-height: 1.35; }
  .lm-check { font-size: 18px; color: var(--accent); flex-shrink: 0; margin-top: 2px; }
  .load-menu-remember {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 10px;
    font-size: 12px; color: var(--text-2); cursor: pointer;
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .load-menu-remember input { accent-color: var(--accent); }

  .ex-actions { display: flex; align-items: center; gap: 4px; }
  .btn-icon {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
  }
  .btn-icon:hover { color: var(--danger); }

  .expand-icon { color: var(--text-3); transition: transform var(--dur-fast); }
  .expand-icon.rotated { transform: rotate(-90deg); }

  /* Last-time ghost row */
  .last-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 14px 8px;
    font-size: 11px;
    color: var(--text-3);
    border-top: 1px dashed var(--border);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent-dim) 50%, transparent), transparent);
  }
  .last-label { font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; flex-shrink: 0; }
  .last-sets { display: inline-flex; gap: 4px; flex-wrap: wrap; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .last-set { font-weight: 600; }
  .last-sep { color: var(--text-3); opacity: 0.5; }
  .vol-delta {
    margin-left: auto;
    font-size: 10px; font-weight: 700;
    padding: 2px 7px; border-radius: var(--radius-full);
    background: var(--surface-2);
    font-variant-numeric: tabular-nums;
  }
  .vol-delta.up { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
  .vol-delta.down { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }

  .progression-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 700; color: var(--accent);
    background: var(--accent-dim);
    padding: 3px 9px; border-radius: var(--radius-full);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .progression-chip .material-symbols-rounded { font-size: 12px; }

  .sets-wrap { padding: 0 14px 12px; }
  /* Mirror the SetRow grid exactly so the "Set / Weight / Reps / ✓" labels
     line up over their inputs. Weight gets more flex than reps because
     weights are typically 3-4 digits + step buttons + unit, while reps are
     usually 1-2 digits in a plain input. */
  .sets-header {
    display: grid;
    grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 0.7fr) 36px 32px;
    gap: 6px;
    padding: 0 0 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  /* When RPE is on, SetRow injects an extra `auto` column. The header has
     no RPE label (the RPE chip in each row is content-sized + sits where
     it lands), so we add a placeholder column with auto width to keep the
     ✓ column right-anchored over its actual cell. */
  .sets-wrap:has(.rpe-wrap) .sets-header {
    grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 0.7fr) 36px auto 32px;
  }
  .sets-header span { font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase; }
  .sh-set { text-align: center; }
  .sh-done { text-align: center; }
  /* Indent each label so it sits over the LEFT edge of its input box,
     not the column boundary. The set-field has `padding: 0 8px` and the
     weight-field overrides to `padding: 0 4px` with a 22px step button +
     2px gap before the input — so the input's left edge is at:
        weight: 4px + 22px + 2px = 28px
        reps:   8px (no step button on this field)
     Matches the user's mental model of "the label lines up with where
     the number begins". */
  .sh-weight { padding-left: 28px; }
  .sh-reps   { padding-left: 8px; }

  .add-set-actions { display: flex; gap: 6px; margin-top: 6px; }
  .add-set-btn {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    flex: 1; padding: 10px;
    background: var(--surface-2); border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-2); font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit;
    transition: all var(--dur-fast);
  }
  .add-set-btn:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
  .add-warmup-btn {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    padding: 10px 14px;
    background: var(--surface-2); border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--accent); font-size: 12px; font-weight: 700;
    cursor: pointer; font-family: inherit; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .add-warmup-btn:hover { background: var(--accent-dim); border-color: var(--accent); }
  .add-warmup-btn .material-symbols-rounded { font-size: 16px; }
  .add-set-btn .material-symbols-rounded { font-size: 18px; }

  .target-info {
    display: flex; flex-wrap: wrap; gap: 6px;
    padding: 8px 14px 12px;
    border-top: 1px solid var(--border);
  }
  .target-chip {
    font-size: 11px; padding: 3px 8px;
    background: var(--surface-2); border-radius: var(--radius-full);
    color: var(--text-2);
  }
  .target-note { font-size: 12px; color: var(--text-3); font-style: italic; }
  .btn-icon-sm {
    width: 28px; height: 28px; padding: 0;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon-sm:hover { color: var(--accent); background: var(--surface-2); }
  .btn-icon-sm .material-symbols-rounded { font-size: 20px; }
</style>
