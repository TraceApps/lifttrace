<script>
  import { onMount, onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { isNative, getServerUrl } from '../lib/platform.js';
  import { CATEGORIES } from '../lib/workout.js';
  import { normalizeEquipment, sortByBucket } from '../lib/equipment.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import ExerciseEditor from '../components/exercises/ExerciseEditor.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import Dialog from '../components/ui/Dialog.svelte';
  import { pageBanners, bannerStyle, favoriteExercises, customEquipment, weightUnit, exerciseBrowserDensity } from '../stores/settings.js';
  import ExerciseInfo from '../components/exercises/ExerciseInfo.svelte';
  import { readSharedExerciseFile, fetchSharedExerciseUrl, importSharedExercise } from '../lib/exerciseShare.js';
  import { portal } from '../lib/portal.js';

  let showEditor = false;
  let addMenuOpen = false;
  let urlPromptOpen = false;
  let urlInput = '';
  let importBusy = false;
  let fileInput;

  async function onEditorSaved(e) {
    // Re-fetch the library so the new / updated exercise appears immediately.
    try { exercises = await LtApi.getExercises(); } catch {}
  }

  function onAddMenuPick(e) {
    const v = e.detail?.value;
    if (v === 'create')      showEditor = true;
    else if (v === 'file')   fileInput?.click();
    else if (v === 'url')  { urlInput = ''; urlPromptOpen = true; }
  }

  async function _doImport(payload, sourceLabel) {
    importBusy = true;
    try {
      const created = await importSharedExercise(payload);
      showSuccess(`Imported "${created?.name || payload.name}"`);
      try { exercises = await LtApi.getExercises(); } catch {}
    } catch(e) {
      showError(`${sourceLabel}: ${e.message || 'Import failed'}`);
    }
    importBusy = false;
  }

  async function onFileChosen(e) {
    const f = e.target?.files?.[0];
    if (f) {
      try {
        const payload = await readSharedExerciseFile(f);
        await _doImport(payload, 'File');
      } catch(err) {
        showError(`File: ${err.message || 'Invalid file'}`);
      }
    }
    // Reset so picking the same file twice still fires `change`.
    if (fileInput) fileInput.value = '';
  }

  async function onUrlConfirm() {
    const url = urlInput.trim();
    if (!url) return;
    try {
      const payload = await fetchSharedExerciseUrl(url);
      await _doImport(payload, 'URL');
    } catch(err) {
      showError(`URL: ${err.message || 'Import failed'}`);
    }
  }

  let exercises = [];
  let usage = {};  // { [exerciseId]: { count, last_date } } — drives recency tag + Most Used sort
  let search = '';
  let selectedCategory = '';
  // Multi-select: empty array = no equipment filter. Each entry is either
  // one of the six normalized buckets (Barbell / Bodyweight / etc.) or
  // a custom equipment string the user added via ExerciseEditor.
  let selectedEquipment = [];
  // Persist across nav so "Available today" picks survive going to an
  // ExerciseDetail and back. Wipes on full app reload (sessionStorage).
  try {
    const saved = JSON.parse(sessionStorage.getItem('lt:exEquip') || '[]');
    if (Array.isArray(saved)) selectedEquipment = saved;
  } catch {}
  function _persistEq() {
    try { sessionStorage.setItem('lt:exEquip', JSON.stringify(selectedEquipment)); } catch {}
  }
  function toggleEq(name) {
    selectedEquipment = selectedEquipment.includes(name)
      ? selectedEquipment.filter(e => e !== name)
      : [...selectedEquipment, name];
    _persistEq();
  }
  function clearEq() {
    selectedEquipment = [];
    _persistEq();
  }

  /** Does this exercise's equipment list intersect the user's selection?
   *  Empty selection always passes. A selected entry matches an exercise's
   *  equipment string either exactly (custom-equipment case) or via the
   *  six-bucket normalization (built-in buckets case). */
  function _eqMatch(ex, selected) {
    if (!selected.length) return true;
    const set = new Set(selected);
    for (const raw of (ex.equipment || [])) {
      if (set.has(raw)) return true;
      const bucket = normalizeEquipment(raw);
      if (bucket && set.has(bucket)) return true;
    }
    return false;
  }
  let sortMode = 'alpha';  // 'alpha' | 'used' | 'recent' — persisted across visits
  let loading = true;
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
    _wideMq?.removeEventListener?.('change', _syncWide);
  });

  // Wide-mode gate (same pattern the picker uses). At >=1280px on
  // non-forced-mobile viewports, the row-tap loads an inline detail
  // pane on the right instead of pushing to /exercise/:id — keeps
  // the browse flow intact for library curation.
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

  // Detail pane positioning. Was plain position:sticky inside the grid,
  // which looked right in isolation but never actually stuck: the route
  // wrapper Svelte's fade transition applies to every page sets
  // will-change:opacity on .page-transition and leaves it there, and
  // that alone is enough to make it establish a new containing block,
  // silently scoping the sticky panel to the wrong ancestor. Confirmed
  // live, by walking the ancestor chain via getComputedStyle in the
  // browser, rather than assumed. Diary.svelte's right rail hit the
  // exact same class of bug already, fixed via use:portal (escapes the
  // problem ancestor entirely) plus position:fixed with JS-measured CSS
  // vars instead of trusting the grid to size or position it, since a
  // portaled element is no longer a grid item and cannot inherit column
  // geometry.
  let _detailStickyTopPx = 0;   // exposed as --ex-detail-top
  let _detailFixedLeftPx = 0;   // exposed as --ex-detail-left
  let _detailFixedWidthPx = 380; // exposed as --ex-detail-width
  let _contentEl = null;
  let _detailResizeObs = null;
  function _measureDetailPane() {
    if (!_contentEl) return;
    const gridRect = _contentEl.getBoundingClientRect();
    const colWidth = _detailFixedWidthPx;
    const leftPx = Math.max(0, Math.round(gridRect.right - colWidth));
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const pad = parseFloat(getComputedStyle(_contentEl).paddingTop || '0') || 0;
    const naturalDocTop = gridRect.top + scrollY + pad;
    const rootCS = getComputedStyle(document.documentElement);
    const pageTop = parseFloat(rootCS.getPropertyValue('--page-top') || rootCS.getPropertyValue('--safe-top') || '0') || 0;
    const hamRow  = parseFloat(rootCS.getPropertyValue('--hamburger-row') || '0') || 0;
    const topPx = Math.max(0, Math.round(naturalDocTop - pageTop - hamRow));
    if (topPx  !== _detailStickyTopPx)  _detailStickyTopPx  = topPx;
    if (leftPx !== _detailFixedLeftPx)  _detailFixedLeftPx  = leftPx;
  }
  onMount(() => {
    requestAnimationFrame(() => requestAnimationFrame(_measureDetailPane));
    try {
      _detailResizeObs = new ResizeObserver(_measureDetailPane);
      if (_contentEl) _detailResizeObs.observe(_contentEl);
    } catch { /* ResizeObserver unavailable, one-shot measurement stands */ }
    const onResize = () => { _syncWide(); _measureDetailPane(); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      try { _detailResizeObs?.disconnect(); } catch { /* ignore */ }
    };
  });

  // Inline detail pane state, mirrors the picker's info-pane setup
  // so the two surfaces feel like one system.
  let _detailSelected = null;
  let _detailHistory = [];
  let _detailLoading = false;
  async function _loadDetail(ex) {
    _detailSelected = ex;
    _detailLoading = true;
    try { _detailHistory = await LtApi.getWorkoutHistory(ex.id); }
    catch { _detailHistory = []; }
    _detailLoading = false;
  }
  $: _detailPr = (() => {
    let max = 0, prDate = '';
    for (const h of _detailHistory || []) {
      for (const s of h.sets || []) {
        if (s.completed && s.weight > max) { max = s.weight; prDate = h.date; }
      }
    }
    return max > 0 ? { weight: max, date: prDate, unit: $weightUnit } : null;
  })();
  function _openExercise(ex) {
    if (_wideMode) _loadDetail(ex);
    else push(`/exercise/${ex.id}`);
  }

  // Count exercises per category. Filters stack: selecting equipment narrows
  // the visible categories, and search further narrows both. Matches the
  // AND-able filter behaviour in Diary's picker.
  $: categoryCounts = (() => {
    const counts = {};
    for (const ex of exercises) {
      if (search && !ex.name.toLowerCase().includes(search.toLowerCase())) continue;
      if (!_eqMatch(ex, selectedEquipment)) continue;
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
    return matchSearch && matchCat && _eqMatch(ex, selectedEquipment);
  });

  // Equipment is consolidated into 6 major buckets so the filter row
  // stays readable across sources. Logic shared with ExercisePicker via
  // lib/equipment.js.

  // Available equipment for the current search + category. Buckets are
  // counted via normalizeEquipment; custom-equipment strings are counted
  // by exact match so user-defined kit (Slackboard, Sandbag, etc.) shows
  // up alongside the built-in buckets when at least one exercise uses it.
  $: availableEquipment = (() => {
    const catFiltered = exercises.filter(ex => {
      const matchSearch = !search || ex.name.toLowerCase().includes(search.toLowerCase());
      const matchCat = !selectedCategory || ex.category === selectedCategory;
      return matchSearch && matchCat;
    });
    const customSet = new Set(Array.isArray($customEquipment) ? $customEquipment : []);
    const bucketCounts = {};
    const customCounts = {};
    for (const ex of catFiltered) {
      const seenBuckets = new Set();
      const seenCustom = new Set();
      for (const eq of (ex.equipment || [])) {
        if (customSet.has(eq)) seenCustom.add(eq);
        const b = normalizeEquipment(eq);
        if (b) seenBuckets.add(b);
      }
      for (const b of seenBuckets) bucketCounts[b] = (bucketCounts[b] || 0) + 1;
      for (const c of seenCustom) customCounts[c] = (customCounts[c] || 0) + 1;
    }
    const out = [];
    for (const [name, count] of Object.entries(bucketCounts)) out.push({ name, count, custom: false });
    out.sort((a, b) => sortByBucket(a.name, b.name));
    const customs = Object.entries(customCounts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count, custom: true }));
    return [...out, ...customs];
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
    <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
      <h1>{$_('routes.exercises.title')}</h1>
      <span class="exercise-count" title="Filtered / total">
        {filtered.length}{#if filtered.length !== exercises.length} <span class="exercise-count-total">/ {exercises.length}</span>{/if}
      </span>
      <button class="create-btn" on:click={() => addMenuOpen = true} aria-label="Add exercise" title="Add exercise" disabled={importBusy}>
        <span class="material-symbols-rounded">{importBusy ? 'hourglass_top' : 'add'}</span>
      </button>
    </header>

    <input type="file" accept="application/json,.json" bind:this={fileInput} on:change={onFileChosen} hidden />

    <ActionSheet
      bind:open={addMenuOpen}
      title="Add exercise"
      actions={[
        { label: 'Create new',       icon: 'add',          value: 'create' },
        { label: 'Import from file', icon: 'upload_file',  value: 'file'   },
        { label: 'Import from URL',  icon: 'link',         value: 'url'    },
      ]}
      on:select={onAddMenuPick}
    />

    <Dialog
      bind:open={urlPromptOpen}
      title="Import exercise from URL"
      message="Paste a link to a LiftTrace exercise JSON file (raw.githubusercontent.com or github.com/blob URLs both work)."
      confirmText="Import"
      on:confirm={onUrlConfirm}
    >
      <input
        class="url-input"
        type="url"
        placeholder="https://raw.githubusercontent.com/..."
        bind:value={urlInput}
        autocomplete="off" spellcheck="false"
      />
    </Dialog>

  <div class="filter-bar">
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

    <!-- Display density (issue #74). Desktop only, its own row right
         below the search bar and above the filter chips -- matches
         CookTrace Pantry's actual layout, which has the toggle in a
         separate row below search (.filter-row), not inside the
         search input's own row. -->
    {#if _wideMode}
      <div class="density-row">
        <div class="density-toggle" role="group" aria-label="Display density">
          <button
            class="density-btn"
            class:active={$exerciseBrowserDensity === 'compact'}
            on:click={() => exerciseBrowserDensity.set('compact')}
            title={$_('exercises_page.density_compact')}
            aria-label={$_('exercises_page.density_compact')}
            aria-pressed={$exerciseBrowserDensity === 'compact'}
          >
            <span class="material-symbols-rounded">view_list</span>
          </button>
          <button
            class="density-btn"
            class:active={$exerciseBrowserDensity === 'comfortable'}
            on:click={() => exerciseBrowserDensity.set('comfortable')}
            title={$_('exercises_page.density_comfortable')}
            aria-label={$_('exercises_page.density_comfortable')}
            aria-pressed={$exerciseBrowserDensity === 'comfortable'}
          >
            <span class="material-symbols-rounded">grid_view</span>
          </button>
        </div>
      </div>
    {/if}

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
          <button class="eq-chip" class:active={selectedEquipment.length === 0} on:click={clearEq}>{$_('exercises_page.all_equipment')}</button>
          {#each availableEquipment as eq}
            <button class="eq-chip" class:custom={eq.custom} class:active={selectedEquipment.includes(eq.name)} on:click={() => toggleEq(eq.name)}>
              {eq.name} <span class="eq-count">{eq.count}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

  </div>
  </div>

  <div class="content" bind:this={_contentEl}>
    <!-- Center list column — at wide widths sits alongside the inline
         detail pane in the grid. On mobile this is a plain block. -->
    <div class="ex-list-col">
    {#if loading}
      <div class="loading">Loading exercises...</div>
    {:else if filtered.length === 0}
      <div class="empty">
        <span class="material-symbols-rounded">search_off</span>
        {#if exercises.length === 0}
          <p>Your library is empty. Import a source from Settings to get started.</p>
          <button class="btn btn-primary" on:click={() => push('/settings')}>{$_('exercises_page.go_to_settings')}</button>
        {:else}
          <p>No exercises match the current filters.</p>
          <button class="btn btn-secondary" on:click={() => { search = ''; selectedCategory = ''; clearEq(); }}>
            <span class="material-symbols-rounded" style="font-size:16px">filter_alt_off</span>
            Clear filters
          </button>
        {/if}
      </div>
    {:else}
      {#each Object.entries(grouped) as [category, exs]}
        <div class="group">
          {#if category}<h3 class="group-title">{category}</h3>{/if}
          <div class="group-list" class:comfortable={_wideMode && $exerciseBrowserDensity === 'comfortable'}>
            {#each exs.sort(_sortFn()) as ex}
              {@const u = usage[ex.id]}
              <div class="exercise-row" class:selected-for-detail={_wideMode && _detailSelected?.id === ex.id}>
                <button class="fav-btn" on:click|stopPropagation={() => toggleFavorite(ex.id)} title={isFav(ex.id) ? 'Remove from Favorites' : 'Add to Favorites'}>
                  <span class="material-symbols-rounded" class:fav-active={isFav(ex.id)}>{isFav(ex.id) ? 'star' : 'star_outline'}</span>
                </button>
                <button class="ex-row-main" on:click={() => _openExercise(ex)}>
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
                        <span class="custom-chip" title="Custom exercise you created">{$_('exercises_page.custom')}</span>
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

    <!-- Inline detail pane — visible only at wide widths. Shows the
         tapped exercise's ExerciseInfo (thumbnail, muscles,
         instructions, history/PR) alongside a Full Details button
         that jumps to the /exercise/:id route for deeper analytics
         (charts, per-session breakdown). Mirrors the picker's info
         pane so the two surfaces feel like one system. -->
    <aside class="ex-detail-pane" use:portal
      style="--ex-detail-top:{_detailStickyTopPx}px; --ex-detail-left:{_detailFixedLeftPx}px; --ex-detail-width:{_detailFixedWidthPx}px">
      {#if _detailSelected}
        <div class="edp-head">
          <h3 class="edp-title">{_detailSelected.name}</h3>
          <button class="edp-close" on:click={() => { _detailSelected = null; _detailHistory = []; }}
                  aria-label="Close preview" title="Close preview">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        {#if _detailLoading}
          <div class="loading">Loading…</div>
        {:else}
          <ExerciseInfo exercise={_detailSelected} pr={_detailPr} history={_detailHistory} />
          <button class="btn btn-primary edp-full-btn" on:click={() => push(`/exercise/${_detailSelected.id}`)}>
            <span class="material-symbols-rounded">open_in_new</span>
            Full details
          </button>
        {/if}
      {:else}
        <div class="edp-empty">
          <span class="material-symbols-rounded edp-empty-icon">info</span>
          <p class="edp-empty-title">Preview any exercise</p>
          <p class="edp-empty-desc">Tap any row to see its thumbnail, muscles, and history here without leaving the library.</p>
        </div>
      {/if}
    </aside>
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

  /* Display density row (issue #74) -- own row between search and the
     filter chips, right-aligned. Matches CookTrace Pantry's actual
     layout, which puts its grid/list toggle in a row below search
     rather than inside the search input's own row. */
  .density-row {
    display: flex; justify-content: flex-end;
    padding: 8px var(--page-px) 0;
  }

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

  /* Display density toggle (issue #74). Icon-only two-up segmented
     control, matching CookTrace Pantry's grid/list toggle exactly:
     lives in the search bar next to sort rather than its own chip
     row, and adjacent buttons share a border so they read as one
     control instead of two separate chips. */
  .density-toggle { display: inline-flex; gap: 0; flex-shrink: 0; }
  .density-btn {
    display: flex; align-items: center; justify-content: center;
    padding: 6px 10px;
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    border-radius: 0;
    transition: all var(--dur-fast);
  }
  .density-btn:first-child { border-top-left-radius: var(--radius-sm); border-bottom-left-radius: var(--radius-sm); }
  .density-btn:last-child { border-top-right-radius: var(--radius-sm); border-bottom-right-radius: var(--radius-sm); border-left: none; }
  .density-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .density-btn .material-symbols-rounded { font-size: 18px; }

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
  /* Custom (user-added) equipment chips read with a dashed border so
     they stand apart from the six normalized buckets — same accent
     when active so the multi-select still feels uniform. */
  .eq-chip.custom { border-style: dashed; }
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

  /* Comfortable density (issue #74). Desktop only, opt-in via the
     toggle next to the filter chips. Same row structure as compact,
     just a bigger thumbnail and more breathing room, rather than a
     full card-grid rebuild: matches the issue's own "taller row or
     card" framing without touching markup structure. */
  .group-list.comfortable { gap: 8px; }
  .group-list.comfortable .ex-row-main { padding: 14px 14px 14px 0; gap: 16px; }
  .group-list.comfortable .ex-thumb { width: 96px; height: 96px; }
  .group-list.comfortable .ex-thumb .material-symbols-rounded { font-size: 36px; }
  .group-list.comfortable .ex-name { font-size: 15px; white-space: normal; }
  .group-list.comfortable .ex-meta { font-size: 13px; white-space: normal; }

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

  /* URL prompt input inside the Dialog slot. Matches editor input look. */
  .url-input {
    width: 100%;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-size: 14px;
    font-family: inherit;
    margin-bottom: 16px;
    outline: none;
  }
  .url-input:focus { border-color: var(--accent); }

  /* Mobile default — the inline detail pane is hidden; tapping a row
     still route-pushes to /exercise/:id. Kept in DOM so a viewport
     resize doesn't require a re-mount. */
  .ex-detail-pane { display: none; }

  /* ────────────────────────────────────────────────────────────
     Wide-layout Exercises library. Same shape as the ExercisePicker
     wide layout so the two surfaces feel like one system:
       - Category + equipment chip rows wrap to multi-line (all
         chips visible at once).
       - Content splits into a 2-col grid — left is the existing
         grouped exercise list (each group's rows becoming a 2-col
         card grid), right is a sticky detail pane that shows
         ExerciseInfo for the selected row instead of route-pushing.
     Everything gated by html:not(.force-mobile-layout) so the
     desktop opt-out toggle delivers the phone-shaped library at
     any width. */
  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .category-chips {
      flex-wrap: wrap;
      overflow-x: visible;
    }
    :global(html:not(.force-mobile-layout)) .equipment-chips-wrap {
      overflow-x: visible;
    }
    :global(html:not(.force-mobile-layout)) .equipment-chips-wrap::before,
    :global(html:not(.force-mobile-layout)) .equipment-chips-wrap::after {
      display: none;
    }
    :global(html:not(.force-mobile-layout)) .equipment-chips {
      flex-wrap: wrap;
      overflow-x: visible;
    }
    :global(html:not(.force-mobile-layout)) .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 24px;
      align-items: start;
    }
    :global(html:not(.force-mobile-layout)) .content > .ex-list-col {
      min-width: 0;
    }
    /* Each category group's list becomes a 2-col card grid so the
       wide screen shows twice as many rows without scrolling. Group
       title still spans full width above its own grid. */
    :global(html:not(.force-mobile-layout)) .content > .ex-list-col :global(.group-list) {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    :global(html:not(.force-mobile-layout)) .content > .ex-list-col :global(.exercise-row) {
      margin-bottom: 0;
    }
    /* Selected-for-detail row gets an accent border so the user
       tracks which card the right pane is previewing. */
    :global(html:not(.force-mobile-layout)) .content > .ex-list-col :global(.exercise-row.selected-for-detail) {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
    }
    /* Right detail pane, fixed below the sticky filter chrome.
       Portaled to body (use:portal on the element) and positioned via
       JS-measured CSS vars rather than plain position:sticky inside
       the grid: .page-transition's will-change:opacity (Svelte's fade
       transition on every route) silently scopes sticky positioning to
       the wrong ancestor, so it never actually held in place. Diary's
       right rail solved the identical problem the same way. No .content
       ancestor in this selector on purpose: once portaled, the aside is
       a direct child of body, not a grid item. Grid still reserves the
       380px column because its track size is explicit, so the list
       column doesn't reflow when the aside leaves flow. */
    :global(html:not(.force-mobile-layout)) .ex-detail-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px;
      position: fixed;
      top: calc(var(--page-top, var(--safe-top)) + var(--ex-detail-top, 220px) + var(--hamburger-row, 0px));
      left: var(--ex-detail-left, auto);
      width: var(--ex-detail-width, 380px);
      z-index: 5;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - var(--ex-detail-top, 220px)
        - 20px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
    }
    .edp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 4px;
    }
    .edp-title {
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
    .edp-close {
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
    .edp-close:hover { background: var(--surface-2); color: var(--text-1); }
    .edp-close .material-symbols-rounded { font-size: 18px; }
    .edp-full-btn {
      width: 100%;
      height: 40px;
      justify-content: center;
      margin-top: 6px;
    }
    .edp-full-btn .material-symbols-rounded { font-size: 18px; }
    .edp-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 6px;
      padding: 40px 16px;
      color: var(--text-3);
    }
    .edp-empty-icon { font-size: 32px; opacity: 0.6; }
    .edp-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
    .edp-empty-desc { margin: 0; font-size: 12px; line-height: 1.5; max-width: 260px; }
  }
</style>
