<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { LtApi } from '../lib/api.js';
  import { weightUnit } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import ExerciseInfo from '../components/exercises/ExerciseInfo.svelte';
  import ExerciseEditor from '../components/exercises/ExerciseEditor.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { findSimilarExercises } from '../lib/exerciseSimilarity.js';
  import { exportExercise } from '../lib/exerciseShare.js';

  let exporting = false;
  async function handleExport() {
    if (!exercise || exporting) return;
    exporting = true;
    try { await exportExercise(exercise); }
    catch (e) { showError(e.message || 'Export failed'); }
    exporting = false;
  }

  let showEditor = false;

  $: isCustom = exercise && !exercise.is_global;

  async function onEditorSaved() {
    // Refresh the exercise after a save so changes are visible immediately.
    try { exercise = await LtApi.getExercise(params.id); } catch {}
  }

  async function removeExercise() {
    if (!await confirmDialog({
      title: $_('exercise_detail.confirm.delete_title', { values: { name: exercise.name } }),
      message: $_('exercise_detail.confirm.delete_msg'),
      confirmText: $_('common.delete'), dangerous: true,
    })) return;
    try {
      await LtApi.deleteExercise(exercise.id);
      showSuccess($_('exercise_detail.deleted'));
      push('/exercises');
    } catch(e) { showError(e.message); }
  }

  export let params = {};

  let exercise = null;
  let history = [];
  let loading = true;
  let loadError = '';

  let similar = [];

  async function loadSimilar() {
    if (!exercise || !(exercise.primary_muscles || []).length) { similar = []; return; }
    try {
      const library = await LtApi.getExercises();
      similar = findSimilarExercises(exercise, library, 8);
    } catch { similar = []; }
  }
  $: if (exercise) loadSimilar();

  async function load() {
    loading = true; loadError = '';
    try {
      exercise = await LtApi.getExercise(params.id);
      // History is best-effort \u2014 if it fails, the exercise still renders.
      try { history = await LtApi.getWorkoutHistory(params.id); }
      catch { history = []; }
    } catch(e) {
      loadError = e.message || 'Could not load exercise';
      showError(loadError);
    }
    loading = false;
  }

  onMount(load);

  $: pr = (() => {
    let max = 0, prDate = '';
    for (const h of history) {
      for (const s of h.sets || []) {
        if (s.completed && s.weight > max) { max = s.weight; prDate = h.date; }
      }
    }
    return max > 0 ? { weight: max, date: prDate, unit: $weightUnit } : null;
  })();

  // Per-session top set for the inline progress chart. Oldest first so the
  // chart reads left-to-right chronologically. Limited to the last 24
  // sessions so the SVG stays readable on small phones.
  $: progressPoints = (() => {
    const arr = [];
    for (const h of [...history].reverse()) {  // oldest first
      let top = 0, topReps = 0;
      for (const s of (h.sets || [])) {
        if (!s.completed || s.warmup) continue;
        if ((s.weight || 0) > top) { top = s.weight; topReps = s.reps || 0; }
      }
      if (top > 0) arr.push({ date: h.date, weight: top, reps: topReps });
    }
    return arr.slice(-24);
  })();
  $: progressSvg = (() => {
    if (progressPoints.length < 2) return null;
    const W = Math.max(progressPoints.length * 24, 200);
    const H = 100;
    const PAD_Y = 12;
    const min = Math.min(...progressPoints.map(p => p.weight));
    const max = Math.max(...progressPoints.map(p => p.weight));
    const range = Math.max(1, max - min);
    const pts = progressPoints.map((p, i) => {
      const x = (i / Math.max(1, progressPoints.length - 1)) * (W - 16) + 8;
      const y = H - PAD_Y - ((p.weight - min) / range) * (H - PAD_Y * 2);
      return { x, y, ...p };
    });
    return { W, H, pts, min, max };
  })();

  function logToday() {
    if (!exercise) return;
    // Stash a minimal payload for Diary's onMount to pick up; full picker
    // data shape isn't required since addExercise reads only id / name /
    // category / equipment / muscles for display + history lookup.
    try {
      sessionStorage.setItem('lt:diary-add-exercise', JSON.stringify({
        id: exercise.id,
        name: exercise.name,
        category: exercise.category,
        equipment: exercise.equipment,
        primary_muscles: exercise.primary_muscles,
        secondary_muscles: exercise.secondary_muscles,
        img_url: exercise.img_url,
        gif_url: exercise.gif_url,
      }));
    } catch {}
    push('/');
  }
</script>

<div class="page">
  <header class="page-header">
    <button class="back-btn" on:click={() => window.history.length > 1 ? window.history.back() : push('/exercises')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h1>{exercise?.name || 'Exercise'}</h1>
    {#if exercise}
      <button class="header-btn" on:click={handleExport} disabled={exporting} title="Share exercise as JSON" aria-label="Share exercise as JSON">
        <span class="material-symbols-rounded">{exporting ? 'hourglass_top' : 'share'}</span>
      </button>
    {/if}
    {#if isCustom}
      <button class="header-btn" on:click={() => showEditor = true} title="Edit" aria-label="Edit exercise">
        <span class="material-symbols-rounded">edit</span>
      </button>
      <button class="header-btn danger" on:click={removeExercise} title="Delete" aria-label="Delete exercise">
        <span class="material-symbols-rounded">delete</span>
      </button>
    {/if}
  </header>

  <ExerciseEditor bind:open={showEditor} {exercise} on:saved={onEditorSaved} />

  {#if loading}
    <Spinner block label="Loading exercise…" />
  {:else if exercise}
    <div class="content">
      <button class="log-today-btn" on:click={logToday}>
        <span class="material-symbols-rounded">add_circle</span>
        Log this in today's workout
      </button>

      <ExerciseInfo {exercise} {pr} {history} />

      {#if progressSvg}
        <div class="progress-card">
          <div class="progress-head">
            <h3 class="progress-title">{$_('exercise_detail.top_set_over_time')}</h3>
            <span class="progress-meta">{progressPoints.length} sessions</span>
          </div>
          <svg class="progress-svg" viewBox="0 0 {progressSvg.W} {progressSvg.H}" preserveAspectRatio="none">
            <polyline fill="none" stroke="var(--accent)" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"
              points={progressSvg.pts.map(p => `${p.x},${p.y}`).join(' ')} />
            {#each progressSvg.pts as p}
              <circle cx={p.x} cy={p.y} r="3" fill="var(--accent)" />
            {/each}
          </svg>
          <div class="progress-footer">
            <span>{progressSvg.pts[0].date} · {progressSvg.pts[0].weight} {$weightUnit}</span>
            <span>{progressSvg.pts.at(-1).date} · {progressSvg.pts.at(-1).weight} {$weightUnit}</span>
          </div>
        </div>
      {/if}

      {#if similar.length > 0}
        <div class="similar-section">
          <h3 class="similar-title">{$_('exercise_detail.similar_exercises')}</h3>
          <p class="similar-sub">Alternatives that train the same primary muscles — useful when equipment is taken or you're training somewhere new.</p>
          <div class="similar-grid">
            {#each similar as s (s.id)}
              <button class="similar-card" on:click={() => push(`/exercise/${s.id}`)}>
                {#if s.gif_url || s.img_url}
                  <img class="similar-img" src={s.gif_url || s.img_url} alt="" loading="lazy" />
                {:else}
                  <span class="similar-img-fallback material-symbols-rounded">fitness_center</span>
                {/if}
                <div class="similar-info">
                  <span class="similar-name">{s.name}</span>
                  {#if (s.equipment || []).length}
                    <span class="similar-equip">{(s.equipment || []).slice(0, 2).join(', ')}</span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="load-error">
      <span class="material-symbols-rounded">error_outline</span>
      <p>Couldn't load this exercise.</p>
      {#if loadError}<p class="err-detail">{loadError}</p>{/if}
      <div class="err-actions">
        <button class="btn btn-primary" on:click={load}>{$_('exercise_detail.try_again')}</button>
        <button class="btn btn-secondary" on:click={() => push('/exercises')}>{$_('exercise_detail.back_to_exercises')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .page { min-height: 100dvh; background: var(--bg); padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }
  .back-btn {
    background: none; border: none; cursor: pointer; color: var(--text-2);
    padding: 6px; border-radius: var(--radius-sm); display: flex;
  }
  .header-btn {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 6px; border-radius: var(--radius-sm); display: flex;
  }
  .header-btn:hover { color: var(--text-1); background: var(--surface-2); }
  .header-btn.danger:hover { color: var(--danger); background: rgba(255,92,92,0.1); }
  .content { padding: 16px var(--page-px); }

  /* Log Today shortcut — direct path from this exercise to today's diary.
     Saves a member from having to nav → Diary → Add Exercise → search. */
  .log-today-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 12px 16px;
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
    margin-bottom: 16px;
    transition: background var(--dur-fast), transform var(--dur-fast);
  }
  .log-today-btn:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .log-today-btn:active { transform: scale(0.98); }
  .log-today-btn .material-symbols-rounded { font-size: 20px; }

  /* Inline progress chart — top set over time, sourced from the existing
     history list. Same SVG pattern as Stats > Exercise Progress but smaller
     and embedded here so the user doesn't have to nav for a quick glance. */
  .progress-card {
    margin-top: 24px;
    padding: 14px 16px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .progress-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .progress-title { font-size: 14px; font-weight: 700; color: var(--text-1); margin: 0; }
  .progress-meta  { font-size: 12px; color: var(--text-3); }
  .progress-svg   { width: 100%; height: 100px; display: block; }
  .progress-footer {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--text-3); margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  .loading { text-align: center; padding: 48px; color: var(--text-3); }
  .load-error { text-align: center; padding: 48px 24px; color: var(--text-3); }
  .load-error .material-symbols-rounded { font-size: 48px; color: var(--danger); margin-bottom: 12px; }
  .err-detail { font-size: 12px; opacity: 0.7; margin: 4px 0 16px; }
  .err-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }

  /* Similar exercises section */
  .similar-section { margin-top: 32px; }
  .similar-title { font-size: 18px; font-weight: 700; color: var(--text-1); margin: 0 0 4px; }
  .similar-sub   { font-size: 12px; color: var(--text-3); margin: 0 0 14px; line-height: 1.5; }
  .similar-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .similar-card {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px; border-radius: var(--radius-md);
    background: var(--surface-1); border: 1px solid var(--border);
    color: var(--text-1); font-family: inherit; text-align: left;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .similar-card:hover { background: var(--surface-2); border-color: var(--accent); }
  .similar-img {
    width: 100%; aspect-ratio: 4 / 3; object-fit: cover;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .similar-img-fallback {
    width: 100%; aspect-ratio: 4 / 3; display: flex;
    align-items: center; justify-content: center;
    background: var(--surface-2); border-radius: var(--radius-sm);
    color: var(--text-3); font-size: 28px;
  }
  .similar-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .similar-name {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .similar-equip { font-size: 11px; color: var(--text-3); }
</style>
