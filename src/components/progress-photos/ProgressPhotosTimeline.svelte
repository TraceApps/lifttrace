<script>
  /**
   * ProgressPhotosTimeline.svelte
   *
   * The Progress page's default view: every progress photo in the chosen
   * window, newest first, grouped by month, with the weight logged that
   * day shown alongside when there is one (both come from the same range
   * fetch, so that context is free).
   *
   * Mobile is a single column; desktop fills the extra width with a grid
   * rather than a different layout language. Compare mode turns the tiles
   * into a two-pick selection, and "first and latest" jumps straight to
   * the comparison the feature exists for without making someone scroll
   * to both ends to set it up.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../../lib/api.js';
  import { weightUnit } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { uploadAndAttachPhoto } from '../../lib/progress-photo-upload.js';
  import Spinner from '../ui/Spinner.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import DatePicker from '../ui/DatePicker.svelte';
  import WeightQuickLog from './WeightQuickLog.svelte';
  import PhotoImage from './PhotoImage.svelte';

  const dispatch = createEventDispatcher();

  export let months = 12;

  let photos = [];
  let statsByDate = new Map();
  let loading = true;
  let uploading = false;
  let compareMode = false;
  let picked = [];
  let fileInput;

  function todayStr() {
    return new Date().toLocaleDateString('sv-SE');
  }

  // The date the next capture attaches to. Defaults to today, which is the
  // overwhelmingly common case, but is settable so a camera roll of older
  // photos can be backfilled without walking the diary date by date.
  let targetDate = todayStr();
  let showDatePicker = false;
  $: targetIsToday = targetDate === todayStr();

  // Shown after a capture when that date has no weight logged. The number is
  // only free to collect while you are standing there.
  let weightPromptDate = null;
  function startStr() {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toLocaleDateString('sv-SE');
  }

  async function load() {
    loading = true;
    try {
      const start = startStr();
      const end = todayStr();
      const [photoRes, statsRes] = await Promise.all([
        LtApi.getProgressPhotos(start, end),
        LtApi.getBodyStatsRange(start, end).catch(() => []),
      ]);
      photos = photoRes?.photos || [];
      statsByDate = new Map((statsRes || []).map(r => [r.date, r.stats || {}]));
    } catch (e) {
      showError(e.message || $_('progress.toast.load_failed'));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // Weight can be logged from the diary, the desktop widget, or the prompt
  // below, so follow the signal the app already broadcasts rather than
  // assuming this component is the only writer.
  function onStatsChanged() { if (!loading) load(); }
  onMount(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('lt:body-stats-saved', onStatsChanged);
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('lt:body-stats-saved', onStatsChanged);
  });

  // Newest first from the server; group into month buckets in that order.
  $: groups = (() => {
    const out = [];
    let currentKey = null;
    for (const p of photos) {
      const key = (p.date || '').slice(0, 7);
      if (key !== currentKey) {
        out.push({ key, label: monthLabel(p.date), items: [] });
        currentKey = key;
      }
      out[out.length - 1].items.push(p);
    }
    return out;
  })();

  function monthLabel(date) {
    const d = new Date(`${date}T00:00:00`);
    if (isNaN(d)) return date || '';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function dayLabel(date) {
    const d = new Date(`${date}T00:00:00`);
    return isNaN(d) ? date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function weightFor(date) {
    const s = statsByDate.get(date);
    const w = s?.weight;
    return (w === undefined || w === null || w === '') ? null : w;
  }

  function onPick(photo) {
    // The viewer scrubs through the whole set, so it needs the list and the
    // weights, not just the tile that was tapped. Both are already loaded
    // here, so passing them costs nothing and saves the viewer a refetch.
    if (!compareMode) { dispatch('view', { photo, photos, statsByDate }); return; }
    if (picked.find(p => p.id === photo.id)) {
      picked = picked.filter(p => p.id !== photo.id);
      return;
    }
    picked = [...picked, photo].slice(-2);
    if (picked.length === 2) openCompare(picked[1], picked[0]);
  }

  // photos[] is newest-first, so the older of any pair is the "before".
  function openCompare(a, b) {
    const [before, after] = [a, b].sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    dispatch('compare', { before, after });
    compareMode = false;
    picked = [];
  }

  function compareEnds() {
    if (photos.length < 2) return;
    openCompare(photos[photos.length - 1], photos[0]);
  }

  function toggleCompare() {
    compareMode = !compareMode;
    picked = [];
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (fileInput) fileInput.value = '';
    if (!file) return;
    const day = targetDate;
    uploading = true;
    try {
      await uploadAndAttachPhoto(file, day);
      showSuccess($_('progress.toast.added'));
      await load();
      // Offer the missing number rather than nagging about one already there.
      if (weightFor(day) == null) weightPromptDate = day;
    } catch (err) {
      showError(err.message || $_('progress.toast.add_failed'));
    } finally {
      uploading = false;
    }
  }

  function onWeightSaved(e) {
    const { date, weight } = e.detail;
    statsByDate.set(date, { ...(statsByDate.get(date) || {}), weight });
    statsByDate = statsByDate;        // Map mutation needs the reassignment
    weightPromptDate = null;
    showSuccess($_('progress.weight.saved'));
  }

  async function remove(photo) {
    const ok = await confirmDialog({
      title: $_('progress.confirm.delete_title'),
      message: $_('progress.confirm.delete_msg'),
      confirmText: $_('progress.confirm.delete_confirm'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await LtApi.deleteProgressPhoto(photo.id);
      photos = photos.filter(p => p.id !== photo.id);
      showSuccess($_('progress.toast.deleted'));
    } catch (e) {
      showError(e.message || $_('progress.toast.delete_failed'));
    }
  }
</script>

<input
  type="file"
  accept="image/*"
  bind:this={fileInput}
  on:change={onFile}
  style="display:none"
/>

<div class="pp-wrap">
  {#if loading}
    <Spinner block />
  {:else if photos.length === 0}
    <div class="pp-empty">
      <span class="material-symbols-rounded pp-empty-icon">photo_camera</span>
      <h3>{$_('progress.empty.title')}</h3>
      <p>{$_('progress.empty.desc')}</p>
      <button class="btn btn-primary" disabled={uploading} on:click={() => fileInput?.click()}>
        {uploading ? $_('progress.adding') : $_('progress.add_photo')}
      </button>
    </div>
  {:else}
    <div class="pp-toolbar">
      <div class="pp-actions">
        <button class="btn btn-secondary" disabled={uploading} on:click={() => fileInput?.click()}>
          <span class="material-symbols-rounded">add_a_photo</span>
          {uploading ? $_('progress.adding') : $_('progress.add_photo')}
        </button>
        <!-- Muted while it says Today, accented once it does not, so
             backfilling a date is never something you do by accident. -->
        <button
          class="pp-datechip"
          class:changed={!targetIsToday}
          on:click={() => showDatePicker = true}
          title={$_('progress.date_for_next')}
        >
          <span class="material-symbols-rounded">event</span>
          {targetIsToday ? $_('progress.date_today') : dayLabel(targetDate)}
        </button>
        {#if photos.length >= 3}
          <button class="btn btn-secondary" on:click={compareEnds}>
            <span class="material-symbols-rounded">compare</span>
            {$_('progress.compare_ends')}
          </button>
        {/if}
        {#if photos.length >= 2}
          <button class="btn" class:btn-primary={compareMode} class:btn-secondary={!compareMode} on:click={toggleCompare}>
            {compareMode ? $_('progress.compare_cancel') : $_('progress.compare_pick')}
          </button>
        {/if}
      </div>
      {#if compareMode}
        <p class="pp-hint">{$_('progress.compare_hint', { values: { n: picked.length } })}</p>
      {/if}

      {#if weightPromptDate}
        <div class="pp-weight-prompt">
          <span class="pp-wp-text">
            {$_('progress.weight.prompt', { values: { date: dayLabel(weightPromptDate) } })}
          </span>
          <WeightQuickLog
            date={weightPromptDate}
            on:saved={onWeightSaved}
            on:cancel={() => weightPromptDate = null}
          />
        </div>
      {/if}
    </div>

    {#each groups as g (g.key)}
      <section class="pp-group">
        <h4 class="pp-month">{g.label}</h4>
        <div class="pp-grid">
          {#each g.items as p (p.id)}
            <div class="pp-tile" class:picked={compareMode && picked.some(x => x.id === p.id)}>
              <button class="pp-thumb" on:click={() => onPick(p)}>
                <PhotoImage photo={p} alt={dayLabel(p.date)} />
                {#if compareMode && picked.some(x => x.id === p.id)}
                  <span class="pp-check material-symbols-rounded">check_circle</span>
                {/if}
              </button>
              <div class="pp-meta">
                <span class="pp-date">{dayLabel(p.date)}</span>
                {#if weightFor(p.date) != null}
                  <span class="pp-weight">{weightFor(p.date)} {$weightUnit}</span>
                {/if}
                {#if !compareMode}
                  <button class="pp-del btn-icon" title={$_('progress.delete_title')} on:click={() => remove(p)}>
                    <span class="material-symbols-rounded">delete</span>
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<Sheet bind:open={showDatePicker} title={$_('progress.date_for_next')}>
  <div class="pp-datesheet">
    <DatePicker
      bind:value={targetDate}
      max={todayStr()}
      on:select={(e) => { targetDate = e.detail; showDatePicker = false; }}
    />
  </div>
</Sheet>

<style>
  .pp-wrap { padding: 8px 0 24px; }

  .pp-empty {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    text-align: center; padding: 48px 24px;
  }
  .pp-empty-icon { font-size: 44px; color: var(--text-3); }
  .pp-empty h3 { margin: 4px 0 0; font-size: 16px; color: var(--text-1); }
  .pp-empty p { margin: 0 0 12px; font-size: 13px; color: var(--text-3); max-width: 40ch; }

  .pp-toolbar { padding: 0 4px 12px; }
  .pp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .pp-hint { margin: 8px 0 0; font-size: 12px; color: var(--text-3); }

  .pp-datechip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .pp-datechip .material-symbols-rounded { font-size: 18px; }
  .pp-datechip.changed {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
  }

  .pp-weight-prompt {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-top: 10px; padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .pp-wp-text { font-size: 12px; color: var(--text-2); }

  .pp-datesheet { max-width: 360px; margin: 0 auto; }

  .pp-group { margin-bottom: 20px; }
  .pp-month {
    margin: 0 0 8px; padding: 0 4px;
    font-size: 13px; font-weight: 600; color: var(--text-2);
    text-transform: capitalize;
  }

  /* One column on a phone; fill the width with more tiles as it grows,
     rather than stretching a single column across a desktop monitor. */
  .pp-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }
  @media (min-width: 560px)  { .pp-grid { grid-template-columns: repeat(2, 1fr); } }
  /* Three across on the room available rather than a 900px viewport, which a
     foldable open flat missed by 48px. minmax(0, 1fr), never a bare 1fr, so a
     wide tile cannot stretch the track. */
  :global(html.wide-content) .pp-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (min-width: 1280px) { :global(html.wide-content) .pp-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

  .pp-tile {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--surface-1);
  }
  .pp-tile.picked { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }

  .pp-thumb {
    position: relative;
    display: block; width: 100%;
    padding: 0; border: none; background: var(--surface-2);
    aspect-ratio: 3 / 4;
    cursor: pointer;
  }
  /* Sizing and object-fit: contain now live in PhotoImage, which every
     progress-photo <img> goes through. Contain rather than cover because a
     9:16 phone photo cropped into this 3:4 tile loses the head and feet,
     which is the part being compared. */
  .pp-check {
    position: absolute; top: 8px; right: 8px;
    color: var(--accent); font-size: 24px;
    background: var(--surface-1); border-radius: var(--radius-full);
  }

  .pp-meta {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    font-size: 12px; color: var(--text-2);
  }
  .pp-date { font-weight: 600; }
  .pp-weight { color: var(--text-3); }
  .pp-del { margin-left: auto; }
  .pp-del .material-symbols-rounded { font-size: 18px; color: var(--danger); }
</style>
