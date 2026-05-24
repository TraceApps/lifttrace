<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { LtApi } from '../../lib/api.js';
  import { CATEGORIES } from '../../lib/workout.js';
  import { normalizeEquipment, sortByBucket } from '../../lib/equipment.js';
  import ExerciseInfoSheet from './ExerciseInfoSheet.svelte';
  import ExerciseEditor from './ExerciseEditor.svelte';

  // Create-custom flow: if the user searches for something that doesn't
  // exist, we show a "Create 'X'" row. Tapping it opens the editor with
  // the name prefilled; on save we auto-select the new exercise so the
  // caller's flow continues (e.g. adding to today's workout).
  let creatorOpen = false;
  let creatorPrefill = '';
  async function handleCreatorSaved(e) {
    const newEx = e.detail;
    exercises = [...exercises, newEx];
    dispatch('select', newEx);
    flashAdded(newEx.id);
  }

  const dispatch = createEventDispatcher();

  let infoOpen = false;
  let infoExerciseId = null;
  function openInfo(ex) {
    console.info('[picker] openInfo', ex.id, ex.name);
    infoExerciseId = ex.id;
    infoOpen = true;
  }
  function handleAddFromInfo(e) {
    // User tapped "Add this exercise" inside the preview sheet
    dispatch('select', e.detail);
  }

  let exercises = [];
  // Filter state persists in sessionStorage so re-opening the picker
  // mid-workout doesn't lose the user's "Chest · Barbell" choices. Cleared
  // when the browser session ends.
  const FS_KEY = 'lt:picker-filters';
  const _initial = (() => {
    try { return JSON.parse(sessionStorage.getItem(FS_KEY) || '{}'); }
    catch { return {}; }
  })();
  let search = _initial.search || '';
  let selectedCategory = _initial.category || '';
  let selectedEquipment = _initial.equipment || '';
  let loading = true;
  // Track which exercise IDs were just added so we can render a brief
  // "✓ Added" badge on the row (1.5s). No toast, no counter — the row
  // itself confirms the tap and the picker stays open for more.
  let recentlyAddedIds = new Set();

  onMount(async () => {
    try {
      exercises = await LtApi.getExercises();
    } catch(e) { console.error(e); }
    loading = false;
  });

  // Persist whenever filters change
  $: try {
    sessionStorage.setItem(FS_KEY, JSON.stringify({
      search, category: selectedCategory, equipment: selectedEquipment,
    }));
  } catch {}

  // Equipment consolidation shared with the Exercises page.

  // Reset equipment sub-filter when category changes, but only on a REAL
  // category change (not on initial hydration from sessionStorage).
  let _prevCategory = selectedCategory;
  $: if (selectedCategory !== _prevCategory) {
    _prevCategory = selectedCategory;
    selectedEquipment = '';
  }

  $: filtered = exercises.filter(ex => {
    const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
    const matchCat = !selectedCategory || ex.category === selectedCategory;
    const matchEq = !selectedEquipment
      || (ex.equipment || []).some(e => normalizeEquipment(e) === selectedEquipment);
    return matchSearch && matchCat && matchEq;
  }).slice(0, 100);

  // Equipment sub-filter options for the current category + search
  $: availableEquipment = (() => {
    const catFiltered = exercises.filter(ex => {
      const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
      const matchCat = !selectedCategory || ex.category === selectedCategory;
      return matchSearch && matchCat;
    });
    const counts = {};
    for (const ex of catFiltered) {
      for (const eq of (ex.equipment || [])) {
        const name = normalizeEquipment(eq);
        if (name) counts[name] = (counts[name] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => sortByBucket(a[0], b[0]))
      .map(([name, count]) => ({ name, count }));
  })();

  function flashAdded(id) {
    if (id == null) return;
    recentlyAddedIds.add(id);
    recentlyAddedIds = recentlyAddedIds;
    setTimeout(() => {
      recentlyAddedIds.delete(id);
      recentlyAddedIds = recentlyAddedIds;
    }, 1500);
  }
  function select(ex) {
    dispatch('select', ex);
    flashAdded(ex.id);
  }
</script>

<div class="picker">
  <div class="picker-header">
    <h3>Add Exercise</h3>
    <div class="search-wrap">
      <span class="material-symbols-rounded search-icon">search</span>
      <input
        class="search-input"
        type="text"
        placeholder="Search exercises..."
        bind:value={search}
        autofocus
      />
    </div>
  </div>

  <!-- Mouse-wheel handlers convert vertical scroll into horizontal so PC
       users can move through the chip rows. Touch + trackpad swipe still
       work natively. Matches the pattern on the Exercises page. -->
  <div class="category-chips"
    on:wheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }}>
    <button class="chip" class:active={!selectedCategory} on:click={() => selectedCategory = ''}>All</button>
    {#each CATEGORIES as cat}
      <button class="chip" class:active={selectedCategory === cat.id} on:click={() => selectedCategory = cat.id}>
        {cat.label}
      </button>
    {/each}
  </div>

  {#if availableEquipment.length > 1}
    <div class="equipment-chips"
      on:wheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }}>
      <button class="eq-chip" class:active={!selectedEquipment} on:click={() => selectedEquipment = ''}>All Equipment</button>
      {#each availableEquipment as eq}
        <button class="eq-chip" class:active={selectedEquipment === eq.name}
          on:click={() => selectedEquipment = selectedEquipment === eq.name ? '' : eq.name}>
          {eq.name} <span class="eq-count">{eq.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="exercise-list">
    {#if loading}
      <div class="loading">Loading exercises...</div>
    {:else if filtered.length === 0}
      <div class="empty-picker">
        <p>No exercises matched{search.trim() ? ` "${search.trim()}"` : ''}.</p>
        {#if search.trim()}
          <button class="btn btn-primary" on:click={() => { creatorPrefill = search.trim(); creatorOpen = true; }}>
            <span class="material-symbols-rounded" style="font-size:16px">add</span>
            Create "{search.trim()}"
          </button>
        {/if}
      </div>
    {:else}
      {#if search.trim() && !filtered.some(ex => ex.name.toLowerCase() === search.trim().toLowerCase())}
        <button class="create-from-search" on:click={() => { creatorPrefill = search.trim(); creatorOpen = true; }}>
          <span class="material-symbols-rounded">add_circle</span>
          <div class="cfs-info">
            <span class="cfs-title">Create "{search.trim()}"</span>
            <span class="cfs-sub">Not finding it? Add as a custom exercise.</span>
          </div>
        </button>
      {/if}
      {#each filtered as ex (ex.id)}
        {@const justAdded = recentlyAddedIds.has(ex.id)}
        <div class="exercise-row" class:just-added={justAdded}>
          <button class="exercise-tap" on:click={() => select(ex)}>
            <div class="ex-info">
              <span class="ex-name">{ex.name}</span>
              <span class="ex-meta">
                {ex.category || 'Uncategorized'}
                {#if ex.equipment?.length} · {ex.equipment.join(', ')}{/if}
              </span>
            </div>
            {#if justAdded}
              <span class="added-badge">
                <span class="material-symbols-rounded">check_circle</span>
                Added
              </span>
            {:else}
              <span class="material-symbols-rounded add-icon">add_circle</span>
            {/if}
          </button>
          <button class="info-btn" on:click|stopPropagation={() => openInfo(ex)} title="View details" aria-label="View details">
            <span class="material-symbols-rounded">info</span>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<ExerciseInfoSheet bind:open={infoOpen} exerciseId={infoExerciseId} showAddButton={true} on:add={handleAddFromInfo} />
<ExerciseEditor bind:open={creatorOpen} prefillName={creatorPrefill} on:saved={handleCreatorSaved} />

<style>
  .picker { display: flex; flex-direction: column; min-height: 0; flex: 1; }

  .picker-header { padding: 20px 16px 12px; }
  .picker-header h3 { margin: 0 0 12px; font-size: 20px; font-weight: 700; color: var(--text-1); }

  .search-wrap {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 0 12px;
  }
  .search-icon { font-size: 20px; color: var(--text-3); }
  .search-input {
    flex: 1; background: none; border: none; outline: none;
    color: var(--text-1); font-size: 15px; padding: 12px 0; font-family: inherit;
  }

  .category-chips {
    display: flex; gap: 6px; padding: 0 16px 8px;
    overflow-x: auto; scrollbar-width: none;
  }
  .category-chips::-webkit-scrollbar { display: none; }
  .chip {
    white-space: nowrap; padding: 6px 14px;
    border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all var(--dur-fast);
    flex-shrink: 0;
  }
  .chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

  .equipment-chips {
    display: flex; gap: 5px; padding: 0 16px 10px;
    overflow-x: auto; scrollbar-width: none;
  }
  .equipment-chips::-webkit-scrollbar { display: none; }
  .eq-chip {
    display: flex; align-items: center; gap: 4px;
    white-space: nowrap; padding: 4px 10px;
    border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-3); font-size: 11px; font-weight: 500;
    cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .eq-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .eq-count { font-size: 10px; opacity: 0.6; }

  .exercise-list { flex: 1; overflow-y: auto; padding: 0 16px 16px; }

  .empty-picker {
    display: flex; flex-direction: column; align-items: center;
    gap: 12px; padding: 40px 24px; text-align: center;
    color: var(--text-3);
  }
  .empty-picker p { margin: 0; font-size: 14px; }

  .create-from-search {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 12px 14px;
    margin-bottom: 8px;
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
    border: 1px dashed var(--accent);
    border-radius: var(--radius-md);
    color: var(--text-1);
    cursor: pointer; font-family: inherit; text-align: left;
    transition: background var(--dur-fast);
  }
  .create-from-search:hover { background: color-mix(in srgb, var(--accent) 18%, var(--surface-1)); }
  .create-from-search .material-symbols-rounded { font-size: 22px; color: var(--accent); flex-shrink: 0; }
  .cfs-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .cfs-title { font-size: 14px; font-weight: 700; color: var(--accent); }
  .cfs-sub   { font-size: 11px; color: var(--text-3); }

  .exercise-row {
    display: flex; align-items: center;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 6px;
    overflow: hidden;
    transition: background var(--dur-fast);
  }
  .exercise-row:hover { background: var(--surface-2); }
  .exercise-row.just-added {
    background: color-mix(in srgb, var(--success, #2FD66F) 14%, var(--surface-1));
    border-color: color-mix(in srgb, var(--success, #2FD66F) 50%, transparent);
    animation: ex-just-added 1.5s ease-out;
  }
  @keyframes ex-just-added {
    0%   { background: color-mix(in srgb, var(--success, #2FD66F) 28%, var(--surface-1)); }
    100% { background: color-mix(in srgb, var(--success, #2FD66F) 14%, var(--surface-1)); }
  }
  .added-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--success, #2FD66F) 22%, transparent);
    color: var(--success, #2FD66F);
    font-size: 11px; font-weight: 700; letter-spacing: 0.03em;
    margin-left: 8px; flex-shrink: 0;
  }
  .added-badge .material-symbols-rounded { font-size: 14px; }
  .exercise-tap {
    flex: 1; min-width: 0;
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px;
    background: none; border: none; cursor: pointer; text-align: left;
    color: inherit;
  }
  .exercise-tap:active { transform: scale(0.98); }

  .ex-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .ex-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .ex-meta { font-size: 12px; color: var(--text-3); text-transform: capitalize; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .add-icon { color: var(--accent); font-size: 24px; flex-shrink: 0; margin-left: 8px; }

  .info-btn {
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    background: none; border: none; border-left: 1px solid var(--border);
    color: var(--text-3); cursor: pointer;
    flex-shrink: 0;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .info-btn:hover { color: var(--accent); background: var(--surface-2); }
  .info-btn .material-symbols-rounded { font-size: 20px; }

  .loading { text-align: center; padding: 32px; color: var(--text-3); }
</style>
