<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import { CATEGORIES } from '../lib/workout.js';
  import { normalizeEquipment, sortByBucket } from '../lib/equipment.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import ExercisesBanner from '../components/banners/ExercisesBanner.svelte';
  import ExerciseEditor from '../components/exercises/ExerciseEditor.svelte';
  import { pageBanners, bannerStyle, favoriteExercises } from '../stores/settings.js';

  let showEditor = false;

  async function onEditorSaved(e) {
    // Re-fetch the library so the new / updated exercise appears immediately.
    try { exercises = await LtApi.getExercises(); } catch {}
  }

  let exercises = [];
  let usage = {};  // { [exerciseId]: { count, last_date } } — drives recency tag + Most Used sort
  let search = '';
  let selectedCategory = '';
  let selectedEquipment = '';
  let sortMode = 'alpha';  // 'alpha' | 'used' | 'recent' — persisted across visits
  let loading = true;
  let viewMode = 'list'; // 'list' | 'grid'

  // Restore the last chosen sort so power users don't have to set it every
  // time the route remounts. Persisted in sessionStorage so it survives nav
  // but resets cleanly across app sessions.
  try { sortMode = sessionStorage.getItem('lt:exSort') || 'alpha'; } catch {}
  function setSort(m) {
    sortMode = m;
    try { sessionStorage.setItem('lt:exSort', m); } catch {}
  }

  // Sort dropdown anchored inside the search bar (cleaner than a third
  // chip row). Opens on icon tap, closes on outside-click or selection.
  let sortMenuOpen = false;
  function clickOutside(node, onOutside) {
    const handler = (e) => { if (!node.contains(e.target)) onOutside(); };
    document.addEventListener('click', handler);
    return { destroy() { document.removeEventListener('click', handler); } };
  }

  // Relative-time helper for the "3d ago" tag on each exercise row.
  function relUsed(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    const diff = Math.round((Date.now() - d.getTime()) / 86400000);
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff}d ago`;
    if (diff < 30) return `${Math.round(diff / 7)}w ago`;
    if (diff < 365) return `${Math.round(diff / 30)}mo ago`;
    return `${Math.round(diff / 365)}y ago`;
  }

  // Re-fetch when a sync brings new data (native+server mode only). The
  // initial load returns from local cache instantly; this listener picks up
  // server-side changes when the next pullSnapshot lands.
  let _onSyncComplete = null;
  async function loadUsage() {
    try { usage = await LtApi.getExerciseUsage() || {}; }
    catch { usage = {}; }
  }
  onMount(async () => {
    try { exercises = await LtApi.getExercises(); }
    catch(e) { showError(e.message); }
    loadUsage();
    loading = false;
    if (isNative && getServerUrl()) {
      _onSyncComplete = async () => {
        try { exercises = await LtApi.getExercises(); } catch {}
        loadUsage();
      };
      window.addEventListener('lt:sync-complete', _onSyncComplete);
    }
  });
  onDestroy(() => {
    if (_onSyncComplete) window.removeEventListener('lt:sync-complete', _onSyncComplete);
  });

  // Count exercises per category. Filters stack: selecting equipment narrows
  // the visible categories, and search further narrows both. Matches the
  // AND-able filter behaviour in Diary's picker.
  $: categoryCounts = (() => {
    const counts = {};
    for (const ex of exercises) {
      if (search && !ex.name.toLowerCase().includes(search.toLowerCase())) continue;
      if (selectedEquipment && !(ex.equipment || []).some(e => normalizeEquipment(e) === selectedEquipment)) continue;
      const cat = ex.category || 'other';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  })();

  function toggleFavorite(id) {
    const favs = $favoriteExercises || [];
    if (favs.includes(id)) {
      $favoriteExercises = favs.filter(f => f !== id);
    } else {
      $favoriteExercises = [...favs, id];
    }
  }

  $: isFav = (id) => ($favoriteExercises || []).includes(id);

  $: filtered = exercises.filter(ex => {
    const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
    const matchCat = !selectedCategory || ex.category === selectedCategory;
    const matchEq = !selectedEquipment || (ex.equipment || []).some(e => normalizeEquipment(e) === selectedEquipment);
    return matchSearch && matchCat && matchEq;
  });

  // Equipment is consolidated into 6 major buckets so the filter row
  // stays readable across sources. Logic shared with ExercisePicker via
  // lib/equipment.js.

  // Available equipment for current category (dynamic sub-filter)
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

  // Sort comparator factory keyed by sortMode. Favorites always rise to
  // the top within each group regardless of mode.
  function _sortFn() {
    const favSet = new Set($favoriteExercises || []);
    return (a, b) => {
      const favDiff = (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0);
      if (favDiff) return favDiff;
      if (sortMode === 'used') {
        const cb = usage[b.id]?.count || 0;
        const ca = usage[a.id]?.count || 0;
        if (cb !== ca) return cb - ca;
      } else if (sortMode === 'recent') {
        const lb = usage[b.id]?.last_date || '';
        const la = usage[a.id]?.last_date || '';
        if (lb !== la) return lb < la ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    };
  }

  $: grouped = (() => {
    // "Most used" + "Recent" sort flatten into a single section so the
    // ordering is global, not per-category. Alpha keeps the category
    // grouping the user has had since day one.
    if (sortMode === 'used' || sortMode === 'recent') {
      const sorted = [...filtered].sort(_sortFn());
      return { '': sorted };
    }
    if (selectedCategory) return { [selectedCategory]: filtered };
    const g = {};
    for (const ex of filtered) {
      const cat = ex.category || 'other';
      if (!g[cat]) g[cat] = [];
      g[cat].push(ex);
    }
    return g;
  })();

  async function syncWger() {
    loading = true;
    try {
      const result = await LtApi.syncWger();
      showSuccess(`Synced ${result.count} exercises from wger`);
      exercises = await LtApi.getExercises();
    } catch(e) { showError(e.message); }
    loading = false;
  }
</script>

<div class="page">
  <!-- Sticky-top wrapper — pins the page header AND the filter bar
       (search + chips + sort) together as one block so the filters stay
       reachable while scrolling. Single sticky parent is more reliable
       than two separately-sticky siblings with computed top offsets. -->
  <div class="ex-sticky-top">
    <header class="page-header" class:has-banner={$pageBanners} class:banner-gradient={$bannerStyle === 'gradient'}>
      {#if $bannerStyle === 'animated'}<ExercisesBanner />{/if}
      <h1>{$_('routes.exercises.title')}</h1>
      <span class="exercise-count" title="Filtered / total">
        {filtered.length}{#if filtered.length !== exercises.length} <span class="exercise-count-total">/ {exercises.length}</span>{/if}
      </span>
      <button class="create-btn" on:click={() => showEditor = true} aria-label="Create custom exercise" title="Create custom exercise">
        <span class="material-symbols-rounded">add</span>
      </button>
    </header>

  <div class="filter-bar" class:has-banner={$pageBanners}>
    <div class="search-bar">
      <span class="material-symbols-rounded search-icon">search</span>
      <input class="search-input" type="text" placeholder="Search exercises..." bind:value={search} />
      <!-- Sort menu lives inside the search bar so the chip rows below
           stay focused on filters (Category / Equipment). Most users only
           touch sort occasionally; tucking it behind an icon keeps the
           filter bar light. -->
      <div class="sort-menu-wrap" use:clickOutside={() => sortMenuOpen = false}>
        <button class="sort-icon-btn" class:active={sortMode !== 'alpha'}
                on:click|stopPropagation={() => sortMenuOpen = !sortMenuOpen}
                title="Sort"
                aria-label="Sort exercises"
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}>
          <span class="material-symbols-rounded">sort</span>
        </button>
        {#if sortMenuOpen}
          <div class="sort-menu" role="menu">
            {#each [['alpha','A→Z'],['used','Most used'],['recent','Recent']] as [val, label]}
              <button class="sort-menu-item" class:active={sortMode === val}
                      role="menuitem"
                      on:click={() => { setSort(val); sortMenuOpen = false; }}>
                <span class="sort-menu-label">{label}</span>
                {#if sortMode === val}
                  <span class="material-symbols-rounded sort-check">check</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <div class="category-chips">
      <button class="chip" class:active={!selectedCategory} on:click={() => selectedCategory = ''}>All</button>
      {#each CATEGORIES.filter(c => categoryCounts[c.id]) as cat}
        <button class="chip" class:active={selectedCategory === cat.id} on:click={() => selectedCategory = cat.id}>
          <span class="material-symbols-rounded chip-icon">{cat.icon}</span>
          {cat.label}
        </button>
      {/each}
    </div>

    {#if availableEquipment.length > 1}
      <div class="equipment-chips-wrap">
        <div class="equipment-chips"
          on:wheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }}
        >
          <button class="eq-chip" class:active={!selectedEquipment} on:click={() => selectedEquipment = ''}>All Equipment</button>
          {#each availableEquipment as eq}
            <button class="eq-chip" class:active={selectedEquipment === eq.name} on:click={() => selectedEquipment = selectedEquipment === eq.name ? '' : eq.name}>
              {eq.name} <span class="eq-count">{eq.count}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

  </div>
  </div>

  <div class="content">
    {#if loading}
      <div class="loading">Loading exercises...</div>
    {:else if filtered.length === 0}
      <div class="empty">
        <span class="material-symbols-rounded">search_off</span>
        {#if exercises.length === 0}
          <p>Your library is empty. Import a source from Settings to get started.</p>
          <button class="btn btn-primary" on:click={() => push('/settings')}>Go to Settings</button>
        {:else}
          <p>No exercises match the current filters.</p>
          <button class="btn btn-secondary" on:click={() => { search = ''; selectedCategory = ''; selectedEquipment = ''; }}>
            <span class="material-symbols-rounded" style="font-size:16px">filter_alt_off</span>
            Clear filters
          </button>
        {/if}
      </div>
    {:else}
      {#each Object.entries(grouped) as [category, exs]}
        <div class="group">
          {#if category}<h3 class="group-title">{category}</h3>{/if}
          <div class="group-list">
            {#each exs.sort(_sortFn()) as ex}
              {@const u = usage[ex.id]}
              <div class="exercise-row">
                <button class="fav-btn" on:click|stopPropagation={() => toggleFavorite(ex.id)} title={isFav(ex.id) ? 'Remove from favorites' : 'Add to favorites'}>
                  <span class="material-symbols-rounded" class:fav-active={isFav(ex.id)}>{isFav(ex.id) ? 'star' : 'star_outline'}</span>
                </button>
                <button class="ex-row-main" on:click={() => push(`/exercise/${ex.id}`)}>
                  <!-- Thumbnail: gif preferred (animated form demo), falls back
                       to img, then to a fitness_center icon. lazy-loaded so a
                       1500-exercise library doesn't pre-fetch every demo. -->
                  <div class="ex-thumb">
                    {#if ex.gif_url || ex.img_url}
                      <img src={ex.gif_url || ex.img_url} alt="" loading="lazy" />
                    {:else}
                      <span class="material-symbols-rounded">fitness_center</span>
                    {/if}
                  </div>
                  <div class="ex-info">
                    <div class="ex-name-row">
                      <span class="ex-name">{ex.name}</span>
                      {#if ex.source === 'custom' && !ex.is_global}
                        <span class="custom-chip" title="Custom exercise you created">Custom</span>
                      {/if}
                    </div>
                    <span class="ex-meta">
                      {#if ex.equipment?.length}{ex.equipment.join(', ')}{/if}
                      {#if ex.primary_muscles?.length} · {ex.primary_muscles.slice(0,2).join(', ')}{/if}
                      {#if u?.last_date} · {relUsed(u.last_date)}{/if}
                    </span>
                  </div>
                  <span class="material-symbols-rounded arrow">chevron_right</span>
                </button>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<ExerciseEditor bind:open={showEditor} on:saved={onEditorSaved} />

<style>
  /* overflow-x: clip (NOT hidden) is the load-bearing rule here. The
     chip rows below can push .page wider than the viewport on small
     phones; without a clip, .page extends past the viewport's right
     edge, which traps the global position:fixed BottomNav so it scrolls
     with the page (see feedback_lifttrace_exercises_overflow_x.md).

     `clip` clips overflow the same way `hidden` does BUT does NOT make
     .page a scroll container — so .ex-sticky-top inside still resolves
     to the viewport and stays pinned to the top of the screen during
     scroll. `hidden` would break that. Don't change this without
     re-confirming BOTH: BottomNav stays at the screen bottom AND the
     sticky header + filter bar stay at the top during scroll. */
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); overflow-x: clip; }

  /* page-header styled globally in base.css */
  .exercise-count { font-size: 14px; color: var(--text-3); background: var(--surface-2); padding: 4px 10px; border-radius: var(--radius-full); font-variant-numeric: tabular-nums; }
  .exercise-count-total { opacity: 0.6; font-size: 12px; }
  .create-btn {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent); color: var(--accent-text, #fff);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 8px var(--accent-dim);
    transition: transform var(--dur-fast);
  }
  .create-btn:hover  { transform: scale(1.08); }
  .create-btn:active { transform: scale(0.92); }
  .create-btn .material-symbols-rounded { font-size: 22px; }

  /* Sticky-top wrapper holds the page-header + the filter bar pinned at
     the top during scroll. The inner page-header is forced static
     (!important to beat base.css's `.page-header { position: sticky }`)
     so it doesn't double-stick inside the already-sticky parent — that
     nested-sticky was the cause of the budge on Settings + Diary. */
  .ex-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  :global(.ex-sticky-top .page-header) {
    position: static !important;
    top: auto !important;
    z-index: auto !important;
  }
  .filter-bar {
    background: var(--bg);
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .search-bar {
    display: flex; align-items: center; gap: 8px;
    margin: 12px var(--page-px) 0;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 0 12px;
  }
  .search-icon { font-size: 20px; color: var(--text-3); }
  .search-input { flex: 1; background: none; border: none; outline: none; color: var(--text-1); font-size: 15px; padding: 12px 0; font-family: inherit; }

  .category-chips {
    display: flex; gap: 6px; padding: 12px var(--page-px);
    overflow-x: auto; scrollbar-width: none;
    /* Cap the row at viewport width so chips can't push the page wide. */
    max-width: 100%; min-width: 0;
  }
  .category-chips::-webkit-scrollbar { display: none; }
  .chip {
    display: flex; align-items: center; gap: 4px;
    white-space: nowrap; padding: 6px 14px;
    border-radius: var(--radius-full); background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-2); font-size: 13px; font-weight: 500; cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .chip-icon { font-size: 16px; }

  /* Wrapper exists so the fade gradients can sit outside the scrolling
     area — otherwise they'd move with the content. */
  .equipment-chips-wrap {
    position: relative;
    padding-bottom: 10px;
    max-width: 100%; min-width: 0;
  }
  /* Left + right fade indicators suggest horizontal scrollability */
  .equipment-chips-wrap::before,
  .equipment-chips-wrap::after {
    content: '';
    position: absolute;
    top: 0; bottom: 10px;
    width: 24px;
    pointer-events: none;
    z-index: 1;
    transition: opacity var(--dur-fast);
  }
  .equipment-chips-wrap::before {
    left: 0;
    background: linear-gradient(to right, var(--glass-surface), transparent);
  }
  .equipment-chips-wrap::after {
    right: 0;
    background: linear-gradient(to left, var(--glass-surface), transparent);
  }
  .equipment-chips {
    display: flex; gap: 5px; padding: 0 var(--page-px);
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
  }
  .equipment-chips::-webkit-scrollbar { display: none; }
  .eq-chip { scroll-snap-align: start; }
  .eq-chip {
    display: flex; align-items: center; gap: 4px;
    white-space: nowrap; padding: 4px 10px;
    border-radius: var(--radius-full); background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-3); font-size: 11px; font-weight: 500; cursor: pointer; flex-shrink: 0;
    transition: all var(--dur-fast);
  }
  .eq-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .eq-count { font-size: 10px; opacity: 0.6; }

  .content { padding: 0 var(--page-px) 16px; }
  .group { margin-bottom: 20px; }
  .group-title { font-size: 13px; font-weight: 700; color: var(--accent); text-transform: capitalize; margin: 0 0 8px; letter-spacing: 0.04em; }
  .group-list { display: flex; flex-direction: column; gap: 4px; }

  .exercise-row { display: flex; align-items: center; gap: 0; border-bottom: 1px solid var(--border); }
  .exercise-row:last-child { border-bottom: none; }
  .fav-btn {
    background: none; border: none; cursor: pointer; padding: 10px 8px;
    color: var(--text-3); display: flex; flex-shrink: 0;
  }
  .fav-btn .fav-active { color: var(--lift-pr, #FFD54F); }
  .fav-btn .material-symbols-rounded { font-size: 20px; }
  .ex-row-main {
    flex: 1; display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px 10px 0;
    background: none; border: none; cursor: pointer; text-align: left;
    gap: 10px;
  }
  /* Inline thumbnail — 40px square with rounded corners, lazy-loaded so a
     large library doesn't pre-fetch every demo. Falls back to an icon when
     no media url is set on the exercise row. */
  .ex-thumb {
    width: 40px; height: 40px; border-radius: var(--radius-sm);
    overflow: hidden; flex-shrink: 0;
    background: var(--surface-2);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
  }
  .ex-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .ex-thumb .material-symbols-rounded { font-size: 22px; }

  /* Sort menu — anchored inside the search bar via a small icon button.
     Replaces the old chip-row so the filter bar stays focused on
     Category + Equipment. Most users keep the default (A→Z); power
     users open the menu on demand. */
  .sort-menu-wrap { position: relative; flex-shrink: 0; }
  .sort-icon-btn {
    background: none; border: none; cursor: pointer;
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--text-3); border-radius: var(--radius-sm);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .sort-icon-btn:hover { color: var(--text-1); background: var(--surface-2); }
  .sort-icon-btn.active { color: var(--accent); }
  .sort-icon-btn .material-symbols-rounded { font-size: 20px; }
  .sort-menu {
    position: absolute; top: calc(100% + 6px); right: 0;
    z-index: 20;
    min-width: 160px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    padding: 4px;
  }
  .sort-menu-item {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; padding: 8px 10px;
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font-size: 13px; font-weight: 500;
    font-family: inherit;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .sort-menu-item:hover { background: var(--surface-2); }
  .sort-menu-item.active { color: var(--accent); font-weight: 700; }
  .sort-menu-item.active .sort-check { color: var(--accent); }
  .sort-check { font-size: 18px; }
  .exercise-row:hover { background: var(--surface-2); }
  .ex-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .ex-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ex-name { font-size: 14px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .custom-chip {
    flex-shrink: 0;
    font-size: 9px; font-weight: 800; letter-spacing: 0.05em;
    padding: 2px 7px; border-radius: var(--radius-full);
    background: var(--accent-dim); color: var(--accent);
    text-transform: uppercase;
  }
  .ex-meta { font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .arrow { color: var(--text-3); }

  .loading, .empty { text-align: center; padding: 48px 24px; color: var(--text-3); }
  .empty .material-symbols-rounded { font-size: 48px; display: block; margin-bottom: 12px; }
  .empty .btn-primary { margin-top: 16px; }
</style>
