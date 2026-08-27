<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { LtApi } from '../../lib/api.js';
  import { weightUnit } from '../../stores/settings.js';
  import { CATEGORIES } from '../../lib/workout.js';
  import { normalizeEquipment, sortByBucket } from '../../lib/equipment.js';
  import ExerciseInfoSheet from './ExerciseInfoSheet.svelte';
  import ExerciseInfo from './ExerciseInfo.svelte';
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
  // Inline info-pane state used at wide widths instead of the modal
  // ExerciseInfoSheet — two overlapping modals on a spacious desktop
  // reads like a bug. The pane lives in the picker's own layout.
  let _infoSelected = null;   // full exercise object
  let _infoHistory  = [];
  let _infoLoading  = false;
  async function _loadInlineInfo(ex) {
    _infoSelected = ex;
    _infoLoading = true;
    try { _infoHistory = await LtApi.getWorkoutHistory(ex.id); }
    catch { _infoHistory = []; }
    _infoLoading = false;
  }
  // PR derivation matches ExerciseInfoSheet so the inline pane shows
  // the same top weight/date chip.
  $: _infoPr = (() => {
    let max = 0, prDate = '';
    for (const h of _infoHistory || []) {
      for (const s of h.sets || []) {
        if (s.completed && s.weight > max) { max = s.weight; prDate = h.date; }
      }
    }
    return max > 0 ? { weight: max, date: prDate, unit: $weightUnit } : null;
  })();

  // Wide-mode gate — tracks the same media query the desktop shell
  // uses (>=1280px + not html.force-mobile-layout). Kept as a reactive
  // flag so a mid-session viewport rotation flips both the info-mode
  // choice and the row-cap simultaneously.
  let _wideMode = false;
  let _wideMq;
  function _syncWide() {
    if (typeof document === 'undefined') return;
    _wideMode = !!_wideMq?.matches
      && !document.documentElement.classList.contains('force-mobile-layout');
  }
  if (typeof window !== 'undefined') {
    _wideMq = window.matchMedia('(min-width: 1280px)');
    _syncWide();
    _wideMq.addEventListener?.('change', _syncWide);
  }
  onDestroy(() => { _wideMq?.removeEventListener?.('change', _syncWide); });

  function openInfo(ex) {
    if (_wideMode) {
      _loadInlineInfo(ex);
    } else {
      infoExerciseId = ex.id;
      infoOpen = true;
    }
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
  // Persistent per-session tally — every ID the user has added stays
  // here until the picker closes. Rows carry a quieter styling so a
  // user scanning the list at wide widths can see at a glance what
  // they've already logged. Separate from recentlyAddedIds so the
  // green flash still fades after 1.5s.
  let addedThisSessionIds = new Set();

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

  // Cap: 100 rows on mobile (perf on cheap phones), 300 at wide
  // widths where scan density is higher and the 2-col card grid
  // makes 300 rows one plausible screen of scrolling.
  $: _rowLimit = _wideMode ? 300 : 100;
  $: filtered = exercises.filter(ex => {
    const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
    const matchCat = !selectedCategory || ex.category === selectedCategory;
    const matchEq = !selectedEquipment
      || (ex.equipment || []).some(e => normalizeEquipment(e) === selectedEquipment);
    return matchSearch && matchCat && matchEq;
  }).slice(0, _rowLimit);

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
    addedThisSessionIds.add(id);
    addedThisSessionIds = addedThisSessionIds;
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

  <!-- .picker-body wraps the list + inline info pane so at wide widths
       we can grid-split them (list left, info right) without touching
       the header/chips above. On mobile this is a plain block. -->
  <div class="picker-body">
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
          {@const alreadyAdded = addedThisSessionIds.has(ex.id) && !justAdded}
          <div class="exercise-row"
               class:just-added={justAdded}
               class:already-added={alreadyAdded}
               class:selected-for-info={_wideMode && _infoSelected?.id === ex.id}>
            <button class="exercise-tap" on:click={() => select(ex)}>
              <!-- Thumbnail (visible only in wide/grid layout via CSS).
                   Same fallback ladder Exercises.svelte uses: gif → img →
                   fitness_center icon. Lazy-loaded so a big library
                   doesn't prefetch every demo. -->
              <div class="picker-thumb">
                {#if ex.gif_url || ex.img_url}
                  <img src={ex.gif_url || ex.img_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded">fitness_center</span>
                {/if}
              </div>
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
              {:else if alreadyAdded}
                <span class="material-symbols-rounded already-added-icon" title="Already added this session">check_circle</span>
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

    <!-- Inline info pane — visible only at wide widths via CSS. Shows
         the selected exercise's ExerciseInfo (thumbnail, muscles,
         instructions, history/PR) plus an Add button so the user
         doesn't have to close the pane to log it. -->
    <aside class="picker-info-pane">
      {#if _infoSelected}
        <div class="pip-head">
          <h3 class="pip-title">{_infoSelected.name}</h3>
          <button class="pip-close" on:click={() => { _infoSelected = null; _infoHistory = []; }}
                  aria-label="Close preview" title="Close preview">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        {#if _infoLoading}
          <div class="loading">Loading…</div>
        {:else}
          <ExerciseInfo exercise={_infoSelected} pr={_infoPr} history={_infoHistory} />
          <button class="btn btn-primary pip-add-btn" on:click={() => select(_infoSelected)}>
            <span class="material-symbols-rounded">add_circle</span>
            Add to workout
          </button>
        {/if}
      {:else}
        <div class="pip-empty">
          <span class="material-symbols-rounded pip-empty-icon">info</span>
          <p class="pip-empty-title">Preview any exercise</p>
          <p class="pip-empty-desc">Tap the info icon on any row to see its details, history, and PRs here without closing the picker.</p>
        </div>
      {/if}
    </aside>
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

  /* Thumbnail — only rendered visually at wide widths via CSS below.
     Kept in mobile DOM so the wide-mode class flip doesn't require a
     re-mount. Same shape / fallback ladder as Exercises.svelte. */
  .picker-thumb { display: none; }

  /* Already-added-this-session styling. Persistent across the picker
     session (unlike the 1.5s .just-added green flash), so a user
     scanning the list at wide widths knows what they've already
     logged. Kept subtle: tinted background + solid check-icon in
     accent, no border tint that would compete with .selected-for-info
     or .just-added. */
  .exercise-row.already-added {
    background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
  }
  .exercise-row.already-added:hover {
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
  }
  .already-added-icon {
    font-size: 22px;
    color: var(--accent);
    flex-shrink: 0;
    margin-left: 8px;
    opacity: 0.7;
  }

  /* Mobile default — .picker-body is a plain flex container so the
     exercise-list scrolls inside it; the inline info pane is hidden
     (info opens in the modal ExerciseInfoSheet on mobile). */
  .picker-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .picker-info-pane { display: none; }

  /* Wide-layout: three-pane picker.
       - Header + chip rows: unchanged, span the top full width.
       - Body: 2-col grid — the exercise list (fluid) + an inline
         info pane on the right that replaces the stacked
         ExerciseInfoSheet modal.
       - Exercise list itself becomes a 2-col card grid so the
         wider sheet earns its width instead of showing a single
         column of very-wide rows.
     Gated by html:not(.force-mobile-layout) + width so mobile is
     untouched even at large viewport widths. */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .picker-header h3 {
      font-size: 22px;
    }
    :global(html:not(.force-mobile-layout)) .category-chips,
    :global(html:not(.force-mobile-layout)) .equipment-chips {
      flex-wrap: wrap;
      overflow-x: visible;
    }
    :global(html:not(.force-mobile-layout)) .picker-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 16px;
      padding: 0 16px 16px;
      min-height: 0;
    }
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list {
      padding: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      align-content: start;
      overflow-y: auto;
      min-height: 0;
    }
    /* The "create from search" affordance spans both columns so it
       stays as one visually-distinct row above the results. */
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .create-from-search {
      grid-column: 1 / -1;
      margin-bottom: 0;
    }
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .empty-picker,
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .loading {
      grid-column: 1 / -1;
    }
    /* Selected-for-info row gets an accent border so the user can
       see which card is being previewed in the right pane. */
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row.selected-for-info {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
    }
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row {
      margin-bottom: 0;
    }
    /* Thumbnail slot at wide widths — 44px square with the same
       gradient background Exercises.svelte uses so pre-loaded gifs
       and the icon fallback both land on a neutral surface. */
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row .picker-thumb {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
      background: linear-gradient(135deg, var(--surface-2), var(--surface-1));
      flex-shrink: 0;
      overflow: hidden;
    }
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row .picker-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row .picker-thumb .material-symbols-rounded {
      font-size: 22px;
      color: var(--text-3);
    }
    /* Give the tap-button breathing room for the new thumbnail. */
    :global(html:not(.force-mobile-layout)) .picker-body > .exercise-list > .exercise-row > .exercise-tap {
      gap: 12px;
      padding: 10px 12px;
    }
    /* Inline info pane — sticky within the sheet body. Same surface
       + border tokens as any other card. */
    :global(html:not(.force-mobile-layout)) .picker-body > .picker-info-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px;
      align-self: start;
      max-height: 100%;
      overflow-y: auto;
    }
    .pip-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 4px;
    }
    .pip-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .pip-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-3);
      cursor: pointer;
      transition: background var(--dur-fast), color var(--dur-fast);
    }
    .pip-close:hover { background: var(--surface-2); color: var(--text-1); }
    .pip-close .material-symbols-rounded { font-size: 18px; }
    .pip-add-btn {
      width: 100%;
      height: 44px;
      justify-content: center;
      margin-top: 6px;
    }
    .pip-add-btn .material-symbols-rounded { font-size: 18px; }
    .pip-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 6px;
      padding: 40px 16px;
      color: var(--text-3);
    }
    .pip-empty-icon { font-size: 32px; opacity: 0.6; }
    .pip-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
    .pip-empty-desc { margin: 0; font-size: 12px; line-height: 1.5; max-width: 260px; }
  }
</style>
