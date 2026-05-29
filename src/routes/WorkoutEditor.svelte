<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { LtApi } from '../lib/api.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { exerciseLoadTypes } from '../stores/settings.js';
  import ExercisePicker from '../components/exercises/ExercisePicker.svelte';
  import ExerciseInfoSheet from '../components/exercises/ExerciseInfoSheet.svelte';
  import Sheet from '../components/ui/Sheet.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';

  export let params = {};

  let template = null;
  let loading = true;
  let showPicker = false;
  let saving = false;

  $: exercises = template?.exercises || [];

  // ── Superset grouping ──────────────────────────────────────────────
  $: groups = (() => {
    const out = [];
    let i = 0;
    while (i < exercises.length) {
      const ex = exercises[i];
      const ssId = ex.superset_id;
      if (ssId != null && ex.superset_size > 1) {
        const members = [];
        const startI = i;
        while (i < exercises.length && exercises[i].superset_id === ssId) {
          members.push({ ...exercises[i], _globalIdx: i });
          i++;
        }
        out.push({ type: 'superset', id: ssId, targetSets: members[0]?.target_sets || 1, exercises: members });
      } else {
        out.push({ type: 'single', id: `s${i}`, exercises: [{ ...ex, _globalIdx: i }] });
        i++;
      }
    }
    return out;
  })();

  // Existing superset list for "add to" picker
  $: existingSupersets = (() => {
    const map = new Map();
    for (const ex of exercises) {
      if (ex.superset_id != null && ex.superset_size > 1) {
        if (!map.has(ex.superset_id)) map.set(ex.superset_id, []);
        map.get(ex.superset_id).push(ex.exercise_name);
      }
    }
    return [...map.entries()].map(([id, names]) => ({ id, names }));
  })();

  // ── ActionSheet state ──────────────────────────────────────────────
  let asOpen = false;
  let asTitle = '';
  let asActions = [];
  let asTargetIdx = -1;

  // Superset picker
  let ssPickerOpen = false;
  let ssPickerMode = ''; // 'join' | 'new'
  let newSsPicks = [];

  // (set count is per-exercise now, no shared editor needed)

  // Superset-level action sheet
  let ssAsOpen = false;
  let ssAsActions = [];
  let ssAsTargetId = null;

  // ── Lifecycle ──────────────────────────────────────────────────────
  onMount(async () => {
    try { template = await LtApi.getTemplate(params.templateId); }
    catch(e) { showError(e.message); }
    loading = false;
  });

  // ── Helpers ────────────────────────────────────────────────────────
  function newSsId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function commit(arr) {
    template.exercises = [...arr];
  }

  function recalcSuperset(arr, ssId) {
    const members = arr.filter(e => e.superset_id === ssId);
    if (members.length < 2) {
      // Dissolve — not enough members
      for (const m of members) {
        m.superset_id = undefined;
        m.superset_size = undefined;
        m.superset_position = undefined;
      }
    } else {
      for (let i = 0; i < members.length; i++) {
        members[i].superset_size = members.length;
        members[i].superset_position = i;
      }
    }
    return arr;
  }

  // ── Core mutations ─────────────────────────────────────────────────
  function moveUp(idx) {
    if (idx <= 0) return;
    const arr = [...exercises];
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    commit(arr);
  }

  function moveDown(idx) {
    if (idx >= exercises.length - 1) return;
    const arr = [...exercises];
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    commit(arr);
  }

  function removeExercise(idx) {
    const arr = [...exercises];
    const removed = arr.splice(idx, 1)[0];
    if (removed.superset_id) recalcSuperset(arr, removed.superset_id);
    commit(arr);
  }

  function removeFromSuperset(idx) {
    const arr = [...exercises];
    const ssId = arr[idx].superset_id;
    arr[idx] = { ...arr[idx], superset_id: undefined, superset_size: undefined, superset_position: undefined };
    if (ssId) recalcSuperset(arr, ssId);
    commit(arr);
    showSuccess('Removed from superset');
  }

  function addToSuperset(idx, targetSsId) {
    const arr = [...exercises];
    const ex = arr.splice(idx, 1)[0];
    // Find last member of target superset and insert after
    let insertAt = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].superset_id === targetSsId) { insertAt = i + 1; break; }
    }
    if (insertAt < 0) insertAt = arr.length;
    ex.superset_id = targetSsId;
    arr.splice(insertAt, 0, ex);
    recalcSuperset(arr, targetSsId);
    // Copy target_sets from the group
    const groupSets = arr.find(e => e.superset_id === targetSsId)?.target_sets;
    if (groupSets) ex.target_sets = groupSets;
    commit(arr);
    showSuccess('Added to superset');
  }

  function createSuperset(indices) {
    // indices = array of globalIdx values to group
    if (indices.length < 2) return;
    const ssId = newSsId();
    const arr = [...exercises];
    // Extract exercises, assign superset metadata
    const extracted = indices.sort((a, b) => b - a).map(i => arr.splice(i, 1)[0]);
    extracted.reverse();
    for (let i = 0; i < extracted.length; i++) {
      extracted[i].superset_id = ssId;
      extracted[i].superset_size = extracted.length;
      extracted[i].superset_position = i;
      extracted[i].target_sets = extracted[0].target_sets || 3;
    }
    // Insert group where the first exercise was
    const insertAt = Math.min(...indices.map(i => Math.min(i, arr.length)));
    arr.splice(insertAt, 0, ...extracted);
    commit(arr);
    showSuccess('Superset created');
  }

  function dissolveSuperset(ssId) {
    const arr = [...exercises];
    for (const ex of arr) {
      if (ex.superset_id === ssId) {
        ex.superset_id = undefined;
        ex.superset_size = undefined;
        ex.superset_position = undefined;
      }
    }
    commit(arr);
    showSuccess('Superset dissolved');
  }


  // ── ActionSheet handlers ───────────────────────────────────────────
  // Load-type chip state — which exercise (by idx) has its load-type
  // menu open, and whether the "Remember for this exercise" checkbox
  // is ticked. Same UX as ExerciseCard in the Diary so the template
  // editor and live logging feel consistent.
  let loadMenuIdx = null;
  let rememberLoadType = false;
  function exLoadType(ex) {
    return ex.load_type
        || ($exerciseLoadTypes && ex.exercise_id != null
              ? $exerciseLoadTypes[ex.exercise_id] : null)
        || 'bilateral';
  }
  function pickLoadType(idx, next) {
    const ex = exercises[idx];
    const updated = [...exercises];
    updated[idx] = { ...ex, load_type: next };
    exercises = updated;
    loadMenuIdx = null;
    if (rememberLoadType && ex.exercise_id != null) {
      exerciseLoadTypes.update(curr => ({ ...(curr || {}), [ex.exercise_id]: next }));
    }
  }

  function openExActions(idx) {
    const ex = exercises[idx];
    const inSs = ex.superset_id != null && ex.superset_size > 1;
    asTargetIdx = idx;
    asTitle = ex.exercise_name;

    const actions = [];
    if (idx > 0) actions.push({ label: 'Move up', icon: 'keyboard_double_arrow_up', value: 'move_up' });
    if (idx < exercises.length - 1) actions.push({ label: 'Move down', icon: 'keyboard_double_arrow_down', value: 'move_down' });

    actions.push({ label: 'Replace exercise', icon: 'swap_horiz', value: 'replace' });

    if (inSs) {
      actions.push({ label: 'Remove from superset', icon: 'link_off', value: 'leave_ss' });
    } else {
      if (existingSupersets.length > 0) {
        actions.push({ label: 'Add to existing superset', icon: 'link', value: 'join_ss' });
      }
      actions.push({ label: 'Start new superset...', icon: 'add_link', value: 'new_ss' });
    }

    actions.push({ label: 'Delete exercise', icon: 'delete', value: 'delete', danger: true });
    asActions = actions;
    asOpen = true;
  }

  function handleExAction(e) {
    const val = e.detail.value;
    const idx = asTargetIdx;
    asOpen = false;
    switch (val) {
      case 'move_up':  moveUp(idx); break;
      case 'move_down': moveDown(idx); break;
      case 'leave_ss': removeFromSuperset(idx); break;
      case 'join_ss':
        ssPickerMode = 'join';
        ssPickerOpen = true;
        break;
      case 'new_ss':
        ssPickerMode = 'new';
        newSsPicks = [];
        ssPickerOpen = true;
        break;
      case 'replace':
        replacingIdx = idx;
        showPicker = true;
        break;
      case 'delete': removeExercise(idx); break;
    }
  }

  function replaceExercise(idx, newEx) {
    const arr = [...exercises];
    // Preserve everything except exercise identity — sets, reps, weight,
    // target_sets/reps/weight, notes, superset membership all stay
    arr[idx] = {
      ...arr[idx],
      exercise_id: newEx.id,
      exercise_name: newEx.name,
    };
    commit(arr);
    showSuccess(`Replaced with ${newEx.name}`);
  }

  function handleJoinSuperset(ssId) {
    ssPickerOpen = false;
    addToSuperset(asTargetIdx, ssId);
  }

  function handleCreateSuperset() {
    ssPickerOpen = false;
    if (newSsPicks.length === 0) return;
    createSuperset([asTargetIdx, ...newSsPicks]);
    newSsPicks = [];
  }

  function mergeSupersets(sourceSsId, targetSsId) {
    const arr = [...exercises];
    // Move all source exercises into target superset
    for (const ex of arr) {
      if (ex.superset_id === sourceSsId) {
        ex.superset_id = targetSsId;
      }
    }
    // Gather all target members, move them to be consecutive
    const members = arr.filter(e => e.superset_id === targetSsId);
    const nonMembers = arr.filter(e => e.superset_id !== targetSsId);
    // Find first member's original position
    const firstIdx = arr.findIndex(e => e.superset_id === targetSsId);
    // Rebuild array: everything before first member, then all members, then rest
    const before = [];
    const after = [];
    let placed = false;
    for (const ex of nonMembers) {
      const origIdx = arr.indexOf(ex);
      if (!placed && origIdx >= firstIdx) { placed = true; }
      if (placed) after.push(ex);
      else before.push(ex);
    }
    const result = [...before, ...members, ...after];
    recalcSuperset(result, targetSsId);
    commit(result);
    showSuccess('Supersets merged');
  }

  // Superset-level actions
  function openSsActions(ssId) {
    ssAsTargetId = ssId;
    const members = exercises.filter(e => e.superset_id === ssId);
    const otherSupersets = existingSupersets.filter(ss => ss.id !== ssId);
    const actions = [
      { label: 'Add exercise to superset', icon: 'add', value: 'add_ex' },
    ];
    if (otherSupersets.length > 0) {
      actions.push({ label: 'Merge into another superset', icon: 'merge', value: 'merge_ss' });
    }
    actions.push({ label: 'Dissolve superset', icon: 'link_off', value: 'dissolve', danger: true });
    ssAsActions = actions;
    ssAsOpen = true;
  }

  // Merge picker
  let ssMergePickerOpen = false;

  function handleSsAction(e) {
    const val = e.detail.value;
    ssAsOpen = false;
    switch (val) {
      case 'add_ex':
        addingToSsId = ssAsTargetId;
        showPicker = true;
        break;
      case 'merge_ss':
        ssMergePickerOpen = true;
        break;
      case 'dissolve':
        dissolveSuperset(ssAsTargetId);
        break;
    }
  }

  function handleMerge(targetSsId) {
    ssMergePickerOpen = false;
    mergeSupersets(ssAsTargetId, targetSsId);
  }

  let addingToSsId = null; // when adding exercise directly into a superset
  let replacingIdx = null; // when using the picker to swap an existing exercise

  // Exercise info sheet
  let infoSheetOpen = false;
  let infoSheetExerciseId = null;
  let infoSheetExerciseName = null;
  let infoSheetIdx = -1;
  function openExInfo(idx) {
    const ex = exercises[idx];
    if (!ex) return;
    infoSheetIdx = idx;
    infoSheetExerciseId = ex.exercise_id || null;
    infoSheetExerciseName = ex.exercise_id ? null : (ex.exercise_name || null);
    infoSheetOpen = true;
  }
  function handleInfoReplace() {
    if (infoSheetIdx < 0) return;
    replacingIdx = infoSheetIdx;
    showPicker = true;
  }

  // ── Add exercise ───────────────────────────────────────────────────
  function addExercise(ex) {
    showPicker = false;

    // Replace mode: swap identity of the targeted exercise, keep everything else
    if (replacingIdx != null) {
      replaceExercise(replacingIdx, ex);
      replacingIdx = null;
      return;
    }

    // Pre-fill load_type from the user's per-exercise preference so a
    // template that uses DB Curl picks up "Per side" automatically when
    // the user has chosen Remember once. The template stores it so that
    // when loaded into a diary, the convention travels with the workout.
    const savedLoadType = ex.id != null && $exerciseLoadTypes
      ? $exerciseLoadTypes[ex.id] : null;
    const newEx = {
      exercise_id: ex.id,
      exercise_name: ex.name,
      target_sets: 3,
      target_reps: '10',
      target_weight: '',
      notes: '',
      sets: [],
      ...(savedLoadType && savedLoadType !== 'bilateral' ? { load_type: savedLoadType } : {}),
    };

    if (addingToSsId) {
      // Add directly into a superset
      const arr = [...exercises, newEx];
      const idx = arr.length - 1;
      addToSuperset.call ? null : null; // can't call directly, need to inline
      // Find last member and insert after
      let insertAt = arr.length - 1;
      for (let i = arr.length - 2; i >= 0; i--) {
        if (arr[i].superset_id === addingToSsId) { insertAt = i + 1; break; }
      }
      // Move the new exercise to the right spot
      const moved = arr.splice(arr.length - 1, 1)[0];
      moved.superset_id = addingToSsId;
      arr.splice(insertAt, 0, moved);
      recalcSuperset(arr, addingToSsId);
      const groupSets = arr.find(e => e.superset_id === addingToSsId)?.target_sets;
      if (groupSets) moved.target_sets = groupSets;
      commit(arr);
      addingToSsId = null;
      showSuccess('Added to superset');
    } else {
      template.exercises = [...exercises, newEx];
    }
  }

  function updateExercise(idx, field, value) {
    const updated = [...exercises];
    updated[idx] = { ...updated[idx], [field]: value };
    template.exercises = updated;
  }

  // ── Per-set targets (e.g. pyramid sets) ─────────────────────────────
  // When ex.set_specs is an array, each set has its own {weight, reps}.
  // When absent, the uniform target_sets × target_reps @ target_weight is used.

  function enablePerSet(idx) {
    const ex = exercises[idx];
    const count = ex.target_sets || 3;
    // Seed specs from current uniform targets
    const specs = Array.from({ length: count }, () => ({
      weight: ex.target_weight || '',
      reps: ex.target_reps || '',
    }));
    const updated = [...exercises];
    updated[idx] = { ...ex, set_specs: specs };
    template.exercises = updated;
  }

  function disablePerSet(idx) {
    const ex = exercises[idx];
    const updated = [...exercises];
    const { set_specs, ...rest } = ex;
    updated[idx] = rest;
    template.exercises = updated;
  }

  function updateSpec(idx, setIdx, field, value) {
    const updated = [...exercises];
    const ex = { ...updated[idx] };
    const specs = [...(ex.set_specs || [])];
    specs[setIdx] = { ...specs[setIdx], [field]: value };
    ex.set_specs = specs;
    ex.target_sets = specs.length;
    updated[idx] = ex;
    template.exercises = updated;
  }

  /** Set or clear the round-number override on a spec.
   *  Asymmetric supersets (addons, drop sets, partial pairings) work by
   *  pinning a spec to a specific round so the diary's round-gate fires
   *  correctly. A null/undefined value falls back to position+1.
   *
   *  When the user types a number on one row, the same delta cascades
   *  forward to every subsequent spec in this exercise (matching the
   *  behavior in Diary's ExerciseCard.updateSet). Saves the lifter from
   *  re-typing every following round number when they shift the start. */
  function updateSpecNumber(idx, setIdx, raw) {
    const updated = [...exercises];
    const ex = { ...updated[idx] };
    const specs = [...(ex.set_specs || [])];
    const n = parseInt(raw, 10);

    if (!Number.isFinite(n) || n === setIdx + 1) {
      // Cleared on this row — also clear every later override since the
      // shift is no longer well-defined.
      const { number, ...rest } = specs[setIdx] || {};
      specs[setIdx] = rest;
      for (let i = setIdx + 1; i < specs.length; i++) {
        if (specs[i]?.number != null) {
          const { number: _drop, ...rest2 } = specs[i];
          specs[i] = rest2;
        }
      }
    } else {
      specs[setIdx] = { ...specs[setIdx], number: n };
      const delta = n - (setIdx + 1);
      if (delta !== 0) {
        for (let i = setIdx + 1; i < specs.length; i++) {
          const auto = i + 1;
          const newNum = auto + delta;
          if (newNum >= 1 && newNum <= 99) {
            specs[i] = { ...specs[i], number: newNum };
          }
        }
      }
    }

    ex.set_specs = specs;
    ex.target_sets = specs.length;
    updated[idx] = ex;
    template.exercises = updated;
  }

  function addSpecSet(idx) {
    const updated = [...exercises];
    const ex = { ...updated[idx] };
    const specs = [...(ex.set_specs || [])];
    const last = specs[specs.length - 1] || { weight: '', reps: '' };
    specs.push({ weight: last.weight, reps: last.reps });
    ex.set_specs = specs;
    ex.target_sets = specs.length;
    updated[idx] = ex;
    template.exercises = updated;
  }

  function removeSpecSet(idx, setIdx) {
    const updated = [...exercises];
    const ex = { ...updated[idx] };
    const specs = (ex.set_specs || []).filter((_, i) => i !== setIdx);
    if (specs.length === 0) {
      const { set_specs, ...rest } = ex;
      updated[idx] = rest;
    } else {
      ex.set_specs = specs;
      ex.target_sets = specs.length;
      updated[idx] = ex;
    }
    template.exercises = updated;
  }

  async function save() {
    saving = true;
    try {
      await LtApi.updateTemplate(params.templateId, { name: template.name, exercises: template.exercises });
      showSuccess('Workout saved');
      push(`/programs/${params.programId}`);
    } catch(e) { showError(e.message); }
    saving = false;
  }

</script>

<div class="page">
  <header class="page-header">
    <button class="back-btn" on:click={() => push(`/programs/${params.programId}`)}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    {#if template}
      <input class="title-input" type="text" bind:value={template.name} placeholder="Workout name" />
      <button class="btn btn-primary save-btn" on:click={save} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    {:else}
      <span class="title-input" style="flex:1"></span>
    {/if}
  </header>

  {#if loading}
    <Spinner block label="Loading template…" />
  {:else if template}
    <div class="content">
      {#if exercises.length === 0}
        <div class="empty">
          <span class="material-symbols-rounded">playlist_add</span>
          <p>Add exercises to this workout template</p>
        </div>
      {:else}
        {#each groups as group (group.id)}
          {#if group.type === 'superset'}
            <!-- Superset block -->
            <div class="superset-block">
              <div class="ss-header">
                <span class="material-symbols-rounded ss-icon">link</span>
                <span class="ss-label">Superset</span>
                <span class="ss-count">{group.exercises.length} exercises</span>
                <button class="btn-icon-xs ss-menu" on:click={() => openSsActions(group.id)} title="Superset options">
                  <span class="material-symbols-rounded">more_horiz</span>
                </button>
              </div>

              <div class="ss-body">
                {#each group.exercises as ex, i}
                  {@const idx = ex._globalIdx}
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div class="exercise-item ss-item"
                    on:contextmenu|preventDefault={() => openExActions(idx)}
                  >
                    <div class="ss-connector-wrap">
                      <div class="ss-dot"></div>
                      {#if i < group.exercises.length - 1}
                        <div class="ss-line"></div>
                      {/if}
                    </div>
                    <div class="ex-content">
                      <div class="ex-header">
                        <div class="reorder-btns">
                          {#if idx > 0}
                            <button class="btn-icon-xs" on:click|stopPropagation={() => moveUp(idx)} title="Move up">
                              <span class="material-symbols-rounded">keyboard_double_arrow_up</span>
                            </button>
                          {/if}
                          {#if idx < exercises.length - 1}
                            <button class="btn-icon-xs" on:click|stopPropagation={() => moveDown(idx)} title="Move down">
                              <span class="material-symbols-rounded">keyboard_double_arrow_down</span>
                            </button>
                          {/if}
                        </div>
                        <span class="ex-name">{ex.exercise_name}</span>
                        {#each [exLoadType(ex)] as lt}
                          <button type="button" class="load-chip" class:non-default={lt !== 'bilateral'}
                                  on:click|stopPropagation={() => loadMenuIdx = (loadMenuIdx === idx ? null : idx)}
                                  title="Load type">
                            {#if lt === 'paired'}<span class="material-symbols-rounded">compare_arrows</span>Per side
                            {:else if lt === 'unilateral'}<span class="material-symbols-rounded">swap_horiz</span>Alternating
                            {:else}<span class="material-symbols-rounded">straighten</span>{/if}
                          </button>
                        {/each}
                        <button type="button" class="btn-icon-sm" on:click|stopPropagation={() => openExInfo(idx)} title="View exercise details" aria-label="View exercise details">
                          <span class="material-symbols-rounded">info</span>
                        </button>
                        <button type="button" class="btn-icon-sm" on:click|stopPropagation={() => openExActions(idx)} title="Options">
                          <span class="material-symbols-rounded">more_vert</span>
                        </button>
                      </div>
                      {#if loadMenuIdx === idx}
                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                        <div class="load-menu-backdrop" on:click|stopPropagation={() => loadMenuIdx = null}></div>
                        <div class="load-menu" on:click|stopPropagation>
                          <div class="load-menu-head">Load type</div>
                          {#each [['bilateral','Bilateral','single load — barbell, machine, both arms move one thing'],
                                  ['paired','Per side','both arms work together with separate equal loads'],
                                  ['unilateral','Alternating','one side at a time']] as [val, label, hint]}
                            <button class="load-menu-item" class:active={exLoadType(ex) === val} type="button"
                                    on:click={() => pickLoadType(idx, val)}>
                              <div class="lm-text">
                                <span class="lm-label">{label}</span>
                                <span class="lm-hint">{hint}</span>
                              </div>
                              {#if exLoadType(ex) === val}<span class="material-symbols-rounded lm-check">check</span>{/if}
                            </button>
                          {/each}
                          <label class="load-menu-remember">
                            <input type="checkbox" bind:checked={rememberLoadType} />
                            <span>Remember for this exercise</span>
                          </label>
                        </div>
                      {/if}
                      {#if ex.set_specs && ex.set_specs.length > 0}
                        <div class="per-set-rows">
                          {#each ex.set_specs as spec, setIdx}
                            <div class="per-set-row">
                              <input
                                class="per-set-num-input"
                                class:custom={spec.number != null && spec.number !== setIdx + 1}
                                type="number" min="1" max="99" inputmode="numeric"
                                value={spec.number != null ? spec.number : setIdx + 1}
                                title="Set number / round (override for asymmetric supersets)"
                                on:input={e => updateSpecNumber(idx, setIdx, e.target.value)}
                              />
                              <input class="ps-input" type="text" value={spec.weight || ''} on:input={e => updateSpec(idx, setIdx, 'weight', e.target.value)} placeholder="Weight" />
                              <span class="ps-x">×</span>
                              <input class="ps-input" type="text" value={spec.reps || ''} on:input={e => updateSpec(idx, setIdx, 'reps', e.target.value)} placeholder="Reps" />
                              <button class="btn-icon-xs" on:click={() => removeSpecSet(idx, setIdx)} title="Remove set" aria-label="Remove set">
                                <span class="material-symbols-rounded">close</span>
                              </button>
                            </div>
                          {/each}
                          <div class="per-set-actions">
                            <button class="per-set-add" on:click={() => addSpecSet(idx)}>
                              <span class="material-symbols-rounded">add</span> Add set
                            </button>
                            <button class="per-set-link" on:click={() => disablePerSet(idx)}>Use uniform targets</button>
                          </div>
                        </div>
                      {:else}
                        <div class="ex-fields three-col">
                          <div class="field">
                            <label>Sets</label>
                            <input type="number" value={ex.target_sets || ''} on:input={e => updateExercise(idx, 'target_sets', parseInt(e.target.value) || 0)} placeholder="—" />
                          </div>
                          <div class="field">
                            <label>Reps</label>
                            <input type="text" value={ex.target_reps || ''} on:input={e => updateExercise(idx, 'target_reps', e.target.value)} placeholder="e.g. 8-12" />
                          </div>
                          <div class="field">
                            <label>Weight</label>
                            <input type="text" value={ex.target_weight || ''} on:input={e => updateExercise(idx, 'target_weight', e.target.value)} placeholder="e.g. 135" />
                          </div>
                        </div>
                        <button class="per-set-link" on:click={() => enablePerSet(idx)}>
                          <span class="material-symbols-rounded" style="font-size:14px">tune</span>
                          Different weight or reps per set…
                        </button>
                      {/if}
                      <input class="notes-input" type="text" value={ex.notes || ''} on:input={e => updateExercise(idx, 'notes', e.target.value)} placeholder="Notes..." />
                    </div>
                  </div>
                {/each}
              </div>
            </div>

          {:else}
            <!-- Single exercise -->
            {@const ex = group.exercises[0]}
            {@const idx = ex._globalIdx}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="exercise-item single-item"
              on:contextmenu|preventDefault={() => openExActions(idx)}
            >
              <div class="ex-header">
                <div class="reorder-btns">
                  {#if idx > 0}
                    <button class="btn-icon-xs" on:click|stopPropagation={() => moveUp(idx)} title="Move up">
                      <span class="material-symbols-rounded">keyboard_double_arrow_up</span>
                    </button>
                  {/if}
                  {#if idx < exercises.length - 1}
                    <button class="btn-icon-xs" on:click|stopPropagation={() => moveDown(idx)} title="Move down">
                      <span class="material-symbols-rounded">keyboard_double_arrow_down</span>
                    </button>
                  {/if}
                </div>
                <span class="ex-sets-badge">{ex.target_sets || 1}×</span>
                <span class="ex-name">{ex.exercise_name}</span>
                {#each [exLoadType(ex)] as lt}
                  <button type="button" class="load-chip" class:non-default={lt !== 'bilateral'}
                          on:click|stopPropagation={() => loadMenuIdx = (loadMenuIdx === idx ? null : idx)}
                          title="Load type">
                    {#if lt === 'paired'}<span class="material-symbols-rounded">compare_arrows</span>Per side
                    {:else if lt === 'unilateral'}<span class="material-symbols-rounded">swap_horiz</span>Alternating
                    {:else}<span class="material-symbols-rounded">straighten</span>{/if}
                  </button>
                {/each}
                <button type="button" class="btn-icon-sm" on:click|stopPropagation={() => openExInfo(idx)} title="View exercise details" aria-label="View exercise details">
                  <span class="material-symbols-rounded">info</span>
                </button>
                <button type="button" class="btn-icon-sm" on:click|stopPropagation={() => openExActions(idx)} title="Options">
                  <span class="material-symbols-rounded">more_vert</span>
                </button>
              </div>
              {#if loadMenuIdx === idx}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <div class="load-menu-backdrop" on:click|stopPropagation={() => loadMenuIdx = null}></div>
                <div class="load-menu" on:click|stopPropagation>
                  <div class="load-menu-head">Load type</div>
                  {#each [['bilateral','Bilateral','single load — barbell, machine, both arms move one thing'],
                          ['paired','Per side','both arms work together with separate equal loads'],
                          ['unilateral','Alternating','one side at a time']] as [val, label, hint]}
                    <button class="load-menu-item" class:active={exLoadType(ex) === val} type="button"
                            on:click={() => pickLoadType(idx, val)}>
                      <div class="lm-text">
                        <span class="lm-label">{label}</span>
                        <span class="lm-hint">{hint}</span>
                      </div>
                      {#if exLoadType(ex) === val}<span class="material-symbols-rounded lm-check">check</span>{/if}
                    </button>
                  {/each}
                  <label class="load-menu-remember">
                    <input type="checkbox" bind:checked={rememberLoadType} />
                    <span>Remember for this exercise</span>
                  </label>
                </div>
              {/if}
              {#if ex.set_specs && ex.set_specs.length > 0}
                <div class="per-set-rows">
                  {#each ex.set_specs as spec, setIdx}
                    <div class="per-set-row">
                      <span class="per-set-num">#{setIdx + 1}</span>
                      <input class="ps-input" type="text" value={spec.weight || ''} on:input={e => updateSpec(idx, setIdx, 'weight', e.target.value)} placeholder="Weight" />
                      <span class="ps-x">×</span>
                      <input class="ps-input" type="text" value={spec.reps || ''} on:input={e => updateSpec(idx, setIdx, 'reps', e.target.value)} placeholder="Reps" />
                      <button class="btn-icon-xs" on:click={() => removeSpecSet(idx, setIdx)} title="Remove set" aria-label="Remove set">
                        <span class="material-symbols-rounded">close</span>
                      </button>
                    </div>
                  {/each}
                  <div class="per-set-actions">
                    <button class="per-set-add" on:click={() => addSpecSet(idx)}>
                      <span class="material-symbols-rounded">add</span> Add set
                    </button>
                    <button class="per-set-link" on:click={() => disablePerSet(idx)}>Use uniform targets</button>
                  </div>
                </div>
              {:else}
                <div class="ex-fields three-col">
                  <div class="field">
                    <label>Sets</label>
                    <input type="number" value={ex.target_sets || 3} on:input={e => updateExercise(idx, 'target_sets', parseInt(e.target.value) || 1)} />
                  </div>
                  <div class="field">
                    <label>Reps</label>
                    <input type="text" value={ex.target_reps || ''} on:input={e => updateExercise(idx, 'target_reps', e.target.value)} placeholder="e.g. 8-12" />
                  </div>
                  <div class="field">
                    <label>Weight</label>
                    <input type="text" value={ex.target_weight || ''} on:input={e => updateExercise(idx, 'target_weight', e.target.value)} placeholder="e.g. 135" />
                  </div>
                </div>
                <button class="per-set-link" on:click={() => enablePerSet(idx)}>
                  <span class="material-symbols-rounded" style="font-size:14px">tune</span>
                  Different weight or reps per set…
                </button>
              {/if}
              <input class="notes-input" type="text" value={ex.notes || ''} on:input={e => updateExercise(idx, 'notes', e.target.value)} placeholder="Notes..." />
            </div>
          {/if}
        {/each}
      {/if}

      <button class="add-btn" on:click={() => { addingToSsId = null; showPicker = true; }}>
        <span class="material-symbols-rounded">add</span>
        Add Exercise
      </button>
    </div>
  {/if}
</div>

<!-- Exercise picker -->
<Sheet open={showPicker} on:close={() => { showPicker = false; addingToSsId = null; replacingIdx = null; }} height="full">
  <ExercisePicker on:select={e => addExercise(e.detail)} />
</Sheet>

<!-- Exercise info sheet -->
<ExerciseInfoSheet bind:open={infoSheetOpen} exerciseId={infoSheetExerciseId} exerciseName={infoSheetExerciseName} on:replace={handleInfoReplace} />

<!-- Exercise action sheet -->
<ActionSheet
  bind:open={asOpen}
  title={asTitle}
  actions={asActions}
  on:select={handleExAction}
  on:cancel={() => asOpen = false}
/>

<!-- Superset action sheet -->
<ActionSheet
  bind:open={ssAsOpen}
  title="Superset Options"
  actions={ssAsActions}
  on:select={handleSsAction}
  on:cancel={() => ssAsOpen = false}
/>

<!-- Superset picker: join existing or create new -->
<Sheet open={ssPickerOpen} on:close={() => ssPickerOpen = false}>
  <div class="ss-picker">
    {#if ssPickerMode === 'join'}
      <h3 class="picker-title">Add to Superset</h3>
      <p class="picker-hint">Choose which superset to join:</p>
      {#each existingSupersets as ss}
        <button class="ss-option" on:click={() => handleJoinSuperset(ss.id)}>
          <span class="material-symbols-rounded" style="color:var(--accent)">link</span>
          <div class="ss-option-info">
            {#each ss.names as name, i}
              <span class="ss-option-name">{name}{i < ss.names.length - 1 ? ' + ' : ''}</span>
            {/each}
          </div>
          <span class="material-symbols-rounded" style="color:var(--text-3)">chevron_right</span>
        </button>
      {/each}
    {:else if ssPickerMode === 'new'}
      <h3 class="picker-title">Create Superset</h3>
      <p class="picker-hint">Select exercises to group with <strong>{exercises[asTargetIdx]?.exercise_name}</strong>:</p>
      <div class="pick-list">
        {#each exercises as ex, i}
          {#if i !== asTargetIdx && !(ex.superset_id != null && ex.superset_size > 1)}
            <label class="pick-row">
              <input type="checkbox" bind:group={newSsPicks} value={i} />
              <span class="pick-name">{ex.exercise_name}</span>
            </label>
          {/if}
        {/each}
      </div>
      <button class="btn btn-primary pick-confirm" disabled={newSsPicks.length === 0} on:click={handleCreateSuperset}>
        Create Superset ({newSsPicks.length + 1} exercises)
      </button>
    {/if}
  </div>
</Sheet>

<!-- Merge superset picker -->
<Sheet open={ssMergePickerOpen} on:close={() => ssMergePickerOpen = false}>
  <div class="ss-picker">
    <h3 class="picker-title">Merge Into Superset</h3>
    <p class="picker-hint">All exercises from both supersets will be combined:</p>
    {#each existingSupersets.filter(s => String(s.id) !== String(ssAsTargetId)) as ss}
      <button class="ss-option" on:click={() => handleMerge(ss.id)}>
        <span class="material-symbols-rounded" style="color:var(--accent)">merge</span>
        <div class="ss-option-info">
          {#each ss.names as name, i}
            <span class="ss-option-name">{name}{i < ss.names.length - 1 ? ' + ' : ''}</span>
          {/each}
        </div>
        <span class="material-symbols-rounded" style="color:var(--text-3)">chevron_right</span>
      </button>
    {/each}
  </div>
</Sheet>

<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }

  /* page-header styled globally in base.css */
  .back-btn { background: none; border: none; cursor: pointer; color: var(--text-2); padding: 6px; display: flex; border-radius: var(--radius-sm); }
  .back-btn:hover { background: var(--surface-2); }
  .title-input { flex: 1; background: none; border: none; outline: none; font-size: 18px; font-weight: 700; color: var(--text-1); font-family: inherit; }
  .save-btn { padding: 8px 16px; font-size: 13px; border-radius: var(--radius-md); }

  .content { padding: 16px var(--page-px); display: flex; flex-direction: column; gap: 12px; }

  /* ── Superset ─────────────────────────────────────────────────── */
  .superset-block { border: 2px solid var(--accent); border-radius: var(--radius-xl); overflow: hidden; background: var(--bg); }
  .ss-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border-bottom: 1px solid var(--border);
  }
  .ss-icon { font-size: 16px; color: var(--accent); }
  .ss-label { font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em; }
  .ss-count { font-size: 11px; color: var(--text-3); flex: 1; }
  .ss-menu { margin-left: auto; }

  .ss-body { padding: 4px 0 8px; }
  .ss-item { display: flex; gap: 0; padding: 0 !important; border: none !important; border-radius: 0 !important; background: none !important; }
  .ss-connector-wrap { display: flex; flex-direction: column; align-items: center; width: 32px; flex-shrink: 0; padding-top: 18px; position: relative; }
  .ss-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); z-index: 1; flex-shrink: 0; box-shadow: 0 0 8px var(--accent-dim); }
  .ss-line { width: 2px; flex: 1; background: var(--accent-dim); margin-top: -1px; }
  .ex-content { flex: 1; min-width: 0; padding: 8px 14px 8px 4px; }

  /* ── Exercise items ───────────────────────────────────────────── */
  .exercise-item { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 14px; }

  .ex-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; position: relative; }

  /* Load-type chip + menu — same affordance as the Diary's ExerciseCard
     so the template author can pin the convention (Per side / Alternating)
     and it travels into the diary when the template is loaded. */
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
  .load-menu-backdrop {
    position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,0.2);
  }
  .load-menu {
    position: absolute; top: 36px; left: 14px; right: 14px;
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
  .reorder-btns { display: flex; flex-direction: column; gap: 0; flex-shrink: 0; }
  .btn-icon-xs {
    width: 26px; height: 20px;
    background: none; border: none; cursor: pointer; color: var(--text-3);
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-xs); padding: 0;
    transition: color var(--dur-fast);
  }
  .btn-icon-xs:hover { color: var(--accent); }
  .btn-icon-xs .material-symbols-rounded { font-size: 20px; }

  .ex-sets-badge {
    font-size: 13px; font-weight: 800; color: var(--accent);
    background: var(--accent-dim); padding: 2px 8px; border-radius: var(--radius-sm);
    font-variant-numeric: tabular-nums; flex-shrink: 0;
  }
  .ex-name { flex: 1; font-size: 14px; font-weight: 600; color: var(--text-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-icon-sm { background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px; display: flex; border-radius: var(--radius-xs); flex-shrink: 0; }
  .btn-icon-sm:hover { color: var(--text-1); background: var(--surface-2); }

  .ex-fields { display: grid; gap: 8px; margin-bottom: 4px; }
  .two-col { grid-template-columns: 1fr 1fr; }
  .three-col { grid-template-columns: 1fr 1fr 1fr; }
  .field label { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 3px; font-weight: 600; text-transform: uppercase; }
  .field input {
    width: 100%; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 8px; color: var(--text-1);
    font-size: 13px; font-family: inherit; outline: none;
  }
  .field input:focus { border-color: var(--accent); }

  .notes-input {
    width: 100%; margin-top: 6px; padding: 7px 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-2);
    font-size: 12px; font-family: inherit; outline: none; font-style: italic;
  }
  .notes-input:focus { border-color: var(--accent); color: var(--text-1); font-style: normal; }
  .notes-input::placeholder { color: var(--text-3); font-style: italic; }

  .add-btn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 14px; background: var(--surface-1); border: 2px dashed var(--border);
    border-radius: var(--radius-lg); color: var(--text-2); font-size: 14px; font-weight: 600;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .empty { text-align: center; padding: 40px 24px; color: var(--text-3); }
  .empty .material-symbols-rounded { font-size: 48px; display: block; margin-bottom: 12px; }
  .loading { text-align: center; padding: 48px; color: var(--text-3); }

  /* ── Superset picker ──────────────────────────────────────────── */
  .ss-picker { padding: 4px 0 8px; }
  .picker-title { font-size: 20px; font-weight: 700; color: var(--text-1); margin: 0 0 8px; }
  .picker-hint { font-size: 14px; color: var(--text-2); margin: 0 0 16px; line-height: 1.5; }

  .ss-option {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 14px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); cursor: pointer; text-align: left;
    margin-bottom: 8px; transition: background var(--dur-fast);
  }
  .ss-option:hover { background: var(--surface-3); }
  .ss-option-info { flex: 1; }
  .ss-option-name { font-size: 14px; color: var(--text-1); }

  .pick-list { max-height: 40dvh; overflow-y: auto; margin-bottom: 16px; }
  .pick-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer;
  }
  .pick-row input[type="checkbox"] {
    width: 20px; height: 20px; accent-color: var(--accent); cursor: pointer;
  }
  .pick-name { font-size: 14px; color: var(--text-1); }
  .pick-confirm { width: 100%; padding: 14px; font-size: 15px; border-radius: var(--radius-md); }

  /* Per-set spec editor */
  .per-set-link {
    display: inline-flex; align-items: center; gap: 4px;
    background: none; border: none; cursor: pointer;
    color: var(--accent); font-size: 12px; font-weight: 600;
    padding: 4px 0; margin-top: 6px;
    text-decoration: none;
  }
  .per-set-link:hover { text-decoration: underline; }

  .per-set-rows {
    display: flex; flex-direction: column; gap: 6px;
    padding: 6px 0;
  }
  .per-set-row {
    display: grid;
    grid-template-columns: 28px 1fr 12px 1fr 28px;
    gap: 6px;
    align-items: center;
  }
  .per-set-num {
    font-size: 11px; font-weight: 700; color: var(--text-3);
    text-align: center;
  }
  .per-set-num-input {
    width: 36px; padding: 4px 0; text-align: center;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 11px; font-weight: 700;
    font-family: inherit; outline: none;
    -moz-appearance: textfield;
  }
  .per-set-num-input::-webkit-outer-spin-button,
  .per-set-num-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .per-set-num-input.custom { color: var(--accent); border-color: var(--accent); }
  .ps-input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text-1); font-size: 13px; font-family: inherit;
    outline: none; width: 100%;
  }
  .ps-input:focus { border-color: var(--accent); }
  .ps-x { color: var(--text-3); text-align: center; font-size: 12px; }
  .per-set-actions {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0 0; margin-top: 4px;
    border-top: 1px dashed var(--border);
  }
  .per-set-add {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface-2); border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    padding: 6px 12px;
    color: var(--text-2); font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .per-set-add:hover { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
  .per-set-add .material-symbols-rounded { font-size: 14px; }
</style>
