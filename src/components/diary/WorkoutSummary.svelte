<script>
  import { portal } from '../../lib/portal.js';
  import { weightUnit, caloriesBurnedEnabled, heightCm, currentWeightKg } from '../../stores/settings.js';
  import { currentUser } from '../../stores/auth.js';
  import { DB } from '../../lib/db.js';
  import { shareWorkoutCard } from '../../lib/workoutCard.js';
  import { exportWorkoutCsv } from '../../lib/workoutCsv.js';
  import { showError } from '../../stores/toast.js';
  import { estimateWorkoutCalories, toKg, ageFromDob, exerciseVolume } from '../../lib/workout.js';
  import { timerState, timerMs } from '../../stores/workoutTimer.js';

  export let open = false;
  export let workout = null;  // { name, exercises, duration_min, date }
  // Diary computes these once at finish-time and passes them in so the
  // summary can celebrate concretely instead of just "Workout Complete!".
  export let prCount = 0;
  export let streak = 0;
  // Parent owns the workout row; we let it know when the user adjusts
  // duration on the summary so it can persist + re-trigger downstream
  // hooks (calorie display, NutriTrace federation push, etc.).
  export let onDurationChange = (_newMin) => {};

  // Tap-to-edit state for the duration tile.
  let durationEditing = false;
  let durationCustomMin = '';
  const DURATION_PRESETS = [30, 45, 60, 75, 90, 120];

  // Use the saved duration when present, otherwise fall back to the live
  // workout timer's elapsed time if it's tracking this workout's date.
  // Without this fallback, finishing a workout without ever toggling the
  // timer wrote duration_min=0, which then rendered as "—" on the sheet
  // (and as null kcal, since the calorie estimator returns null when
  // duration <= 0). Reading the timer here lets the sheet show real
  // numbers any time the user navigated the diary with the timer running,
  // even if it was never explicitly stopped/saved.
  $: effectiveDurationMin = (() => {
    const saved = workout?.duration_min;
    if (saved && saved > 0) return saved;
    if ($timerState && workout?.date && $timerState.date === workout.date) {
      return Math.round($timerMs / 60000 * 10) / 10;
    }
    return saved || 0;
  })();

  // Calorie estimate — shown when the user opted in and the body profile
  // is filled out. Reads currentWeightKg from the reactive store so a
  // freshly synced value (or one set via Profile while the app is open)
  // takes effect without a reload.
  $: calorieEstimate = (() => {
    if (!$caloriesBurnedEnabled || !workout) return null;
    const dob = $currentUser?.birthday || DB.getSetting('dob', null);
    const sex = $currentUser?.gender   || DB.getSetting('gender', null);
    const age = ageFromDob(dob);
    return estimateWorkoutCalories(
      { ...workout, duration_min: effectiveDurationMin },
      { weight_kg: $currentWeightKg, height_cm: $heightCm, age, sex },
    );
  })();

  let sharing = false;
  async function handleShare() {
    if (!workout || sharing) return;
    sharing = true;
    try { await shareWorkoutCard({ ...workout, duration_min: effectiveDurationMin }, $weightUnit); }
    catch (e) { showError(e.message || 'Share failed'); }
    sharing = false;
  }

  let exportingCsv = false;
  async function handleExportCsv() {
    if (!workout || exportingCsv) return;
    exportingCsv = true;
    try { await exportWorkoutCsv({ ...workout, duration_min: effectiveDurationMin }, $weightUnit); }
    catch (e) { showError(e.message || 'Export failed'); }
    exportingCsv = false;
  }

  $: stats = (() => {
    if (!workout) return { volume: 0, sets: 0, exercises: 0, prs: 0 };
    let volume = 0, sets = 0, exercisesWithCompletedSets = 0;
    for (const ex of workout.exercises || []) {
      const completedSets = (ex.sets || []).filter(s => s.completed && !s.warmup);
      if (completedSets.length > 0) exercisesWithCompletedSets++;
      sets += completedSets.length;
      // exerciseVolume honors ex.load_type — per-side / alternating sets
      // contribute the correct multiplier (×2, or sum L+R when split).
      volume += exerciseVolume(ex);
    }
    return { volume: Math.round(volume), sets, exercises: exercisesWithCompletedSets };
  })();

  // Group consecutive exercises that share a superset_id into a single
  // visual block so the summary preserves the training structure (an A1/A2
  // pair reads as a unit, not as two unrelated rows). Filters out
  // exercises with zero completed sets up-front so the grouping doesn't
  // include drafts.
  $: exerciseGroups = (() => {
    const out = [];
    const exs = (workout?.exercises || []).filter(ex =>
      (ex.sets || []).some(s => s.completed)
    );
    let i = 0;
    while (i < exs.length) {
      const ex = exs[i];
      if (ex.superset_id) {
        const ssId = ex.superset_id;
        const members = [];
        while (i < exs.length && exs[i].superset_id === ssId) {
          members.push(exs[i]);
          i++;
        }
        out.push({ type: 'superset', members });
      } else {
        out.push({ type: 'single', exercise: ex });
        i++;
      }
    }
    return out;
  })();

  function fmtDuration(min) {
    if (!min) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtVolume(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  }

  function pickDuration(min) {
    const n = Number(min);
    if (!Number.isFinite(n) || n <= 0 || n > 1440) return;
    durationEditing = false;
    durationCustomMin = '';
    onDurationChange(n);
  }
  function openDurationEditor() {
    durationCustomMin = effectiveDurationMin > 0 ? String(Math.round(effectiveDurationMin)) : '';
    durationEditing = true;
  }
  function submitCustomDuration() {
    pickDuration(durationCustomMin);
  }
</script>

{#if open && workout}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={() => open = false}>
    <div class="ws-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <button class="ws-close-btn" on:click={() => open = false}
              aria-label="Close" title="Close">
        <span class="material-symbols-rounded">close</span>
      </button>

      <div class="ws-hero">
        <!-- CSS confetti — 14 absolutely positioned dots that drop + drift
             on open. Pure CSS, no library. Hidden when reduced-motion. -->
        <div class="confetti" aria-hidden="true">
          {#each Array(14) as _, i}<span class="conf c{i % 7}" style:--i={i}></span>{/each}
        </div>
        <span class="material-symbols-rounded ws-hero-icon">emoji_events</span>
        <h3 class="ws-title">Workout Complete!</h3>
        {#if workout.name}
          <span class="ws-name">{workout.name}</span>
        {/if}
        {#if prCount > 0 || streak >= 2}
          <div class="ws-celebration-row">
            {#if prCount > 0}
              <span class="ws-celeb-chip pr">🔥 {prCount} new {prCount === 1 ? 'PR' : 'PRs'}</span>
            {/if}
            {#if streak >= 2}
              <span class="ws-celeb-chip streak">🔥 {streak}-day streak</span>
            {/if}
          </div>
        {/if}
      </div>

      <div class="ws-stats-grid">
        <div class="ws-stat">
          <span class="ws-stat-val">{fmtVolume(stats.volume)}</span>
          <span class="ws-stat-label">Volume ({$weightUnit})</span>
        </div>
        <div class="ws-stat">
          <span class="ws-stat-val">{stats.sets}</span>
          <span class="ws-stat-label">Sets</span>
        </div>
        <div class="ws-stat">
          <span class="ws-stat-val">{stats.exercises}</span>
          <span class="ws-stat-label">Exercises</span>
        </div>
        <button class="ws-stat ws-stat-edit" on:click={openDurationEditor}
                title="Tap to edit duration" type="button">
          {#if effectiveDurationMin > 0}
            <span class="ws-stat-val">{fmtDuration(effectiveDurationMin)}</span>
            <span class="ws-stat-label">Duration</span>
          {:else}
            <span class="ws-stat-val ws-stat-placeholder">Add</span>
            <span class="ws-stat-label">Duration</span>
          {/if}
          <span class="material-symbols-rounded ws-stat-edit-icon">edit</span>
        </button>
      </div>

      {#if durationEditing}
        <div class="ws-duration-editor">
          <div class="ws-duration-chips">
            {#each DURATION_PRESETS as p}
              <button class="ws-duration-chip" class:active={Math.round(effectiveDurationMin) === p}
                      on:click={() => pickDuration(p)} type="button">
                {p}m
              </button>
            {/each}
          </div>
          <div class="ws-duration-custom">
            <input class="ws-duration-input" type="number" inputmode="numeric"
                   min="1" max="1440" step="1" placeholder="Custom"
                   bind:value={durationCustomMin}
                   on:keydown={(e) => { if (e.key === 'Enter') submitCustomDuration(); }} />
            <span class="ws-duration-unit">min</span>
            <button class="btn btn-primary ws-duration-save" on:click={submitCustomDuration}
                    disabled={!durationCustomMin || Number(durationCustomMin) <= 0} type="button">
              Set
            </button>
            <button class="btn btn-ghost ws-duration-cancel" on:click={() => durationEditing = false}
                    type="button">
              Cancel
            </button>
          </div>
        </div>
      {/if}

      {#if calorieEstimate != null}
        <div class="ws-calorie-row" title={effectiveDurationMin > 0 ? 'MET-based estimate from BMR + duration' : 'Rough estimate based on set count — add a duration for a better number'}>
          <span class="material-symbols-rounded ws-calorie-icon">local_fire_department</span>
          <span class="ws-calorie-val">~{calorieEstimate} kcal</span>
          <span class="ws-calorie-badge" class:rough={effectiveDurationMin <= 0}>
            {effectiveDurationMin > 0 ? 'est' : 'rough'}
          </span>
        </div>
      {/if}

      <div class="ws-exercise-list">
        {#each exerciseGroups as group, gi}
          {#if group.type === 'superset'}
            <div class="ws-superset">
              <div class="ws-superset-label">
                <span class="material-symbols-rounded ss-icon">link</span>
                Superset
              </div>
              {#each group.members as ex}
                {@const completed = (ex.sets || []).filter(s => s.completed)}
                <div class="ws-ex-row ss-member">
                  <span class="ws-ex-name">{ex.exercise_name}</span>
                  <span class="ws-ex-sets">
                    {completed.map(s => `${s.weight}×${s.reps}`).join(' · ')}
                  </span>
                </div>
              {/each}
            </div>
          {:else}
            {@const completed = (group.exercise.sets || []).filter(s => s.completed)}
            <div class="ws-ex-row">
              <span class="ws-ex-name">{group.exercise.exercise_name}</span>
              <span class="ws-ex-sets">
                {completed.map(s => `${s.weight}×${s.reps}`).join(' · ')}
              </span>
            </div>
          {/if}
        {/each}
      </div>

      <div class="ws-footer">
        <button class="btn btn-secondary ws-icon-btn" on:click={handleExportCsv} disabled={exportingCsv} title="Export CSV" aria-label="Export workout as CSV">
          <span class="material-symbols-rounded">{exportingCsv ? 'hourglass_top' : 'download'}</span>
        </button>
        <button class="btn btn-secondary ws-share-btn" on:click={handleShare} disabled={sharing}>
          <span class="material-symbols-rounded" style="font-size:18px">share</span>
          {sharing ? 'Preparing…' : 'Share'}
        </button>
        <button class="btn btn-primary ws-done-btn" on:click={() => open = false}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  /* Floating close on the completion sheet — sits in the top-right corner
     above the confetti hero, accent-tinted so it's reachable without
     visually competing with the celebration. */
  .ws-close-btn {
    position: absolute; top: 10px; right: 10px;
    z-index: 2;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-3); cursor: pointer;
    width: 32px; height: 32px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
  }
  .ws-close-btn:hover { color: var(--text-1); }
  .ws-close-btn .material-symbols-rounded { font-size: 18px; }

  .ws-sheet {
    position: relative;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
    max-height: 85vh; overflow-y: auto;
  }

  .ws-hero {
    position: relative;
    text-align: center; padding: 20px 20px 12px;
    overflow: hidden;
  }
  .ws-hero-icon { font-size: 48px; color: var(--lift-pr, #FFD54F); display: block; margin-bottom: 8px; }
  .ws-title { font-size: 22px; font-weight: 800; color: var(--text-1); margin: 0; }
  .ws-name { font-size: 14px; color: var(--accent); font-weight: 600; margin-top: 4px; display: block; }

  .ws-celebration-row {
    display: inline-flex; gap: 6px; flex-wrap: wrap; justify-content: center;
    margin-top: 10px;
  }
  .ws-celeb-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: var(--radius-full);
    font-size: 12px; font-weight: 700;
    border: 1px solid color-mix(in srgb, #ff7a00 35%, transparent);
    background: color-mix(in srgb, #ff7a00 12%, transparent);
    color: #ff7a00;
    animation: chip-pop 0.5s ease-out both;
    animation-delay: 0.2s;
  }
  @keyframes chip-pop {
    0% { transform: scale(0); opacity: 0; }
    60% { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }

  /* Confetti — 14 spans drop from above the title row with slight x-drift,
     gravity-style. Pure CSS, ~1.4s duration; honors reduced-motion. */
  .confetti {
    position: absolute; inset: 0;
    pointer-events: none; overflow: hidden;
  }
  .conf {
    position: absolute; top: -10px;
    width: 8px; height: 14px; border-radius: 1px;
    left: calc(var(--i) * 7%);
    transform: translateY(-20px) rotate(0);
    animation: conf-fall 1.4s cubic-bezier(0.4, 0, 0.6, 1) forwards;
    animation-delay: calc(var(--i) * 40ms);
  }
  .conf.c0 { background: #ff7a00; --drift: -10px; }
  .conf.c1 { background: #ffd54f; --drift: 8px; }
  .conf.c2 { background: var(--accent); --drift: 0; }
  .conf.c3 { background: #4fc3f7; --drift: -6px; }
  .conf.c4 { background: #81c784; --drift: 6px; }
  .conf.c5 { background: #f06292; --drift: -4px; }
  .conf.c6 { background: #ba68c8; --drift: 4px; }
  @keyframes conf-fall {
    0%   { transform: translate(0, -20px) rotate(0); opacity: 1; }
    100% { transform: translate(var(--drift, 0), 180px) rotate(720deg); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .confetti { display: none; }
    .ws-celeb-chip { animation: none; }
  }

  .ws-stats-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 8px; padding: 12px 20px 16px;
  }
  .ws-stat {
    text-align: center;
    background: var(--surface-2); border-radius: var(--radius-md);
    padding: 12px 4px;
  }
  .ws-stat-val { display: block; font-size: 20px; font-weight: 800; color: var(--text-1); }
  .ws-stat-label { display: block; font-size: 11px; color: var(--text-3); margin-top: 2px; }
  /* Duration tile — looks like a tappable button (accent-tinted background
     + solid accent border), distinct from the three plain read-only stat
     tiles next to it. The pencil icon sits in the top-right with a
     filled accent dot behind it so it reads as an action button rather
     than a decorative icon. Placeholder "Add" uses muted italic to read
     as an invitation. */
  .ws-stat-edit {
    position: relative;
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
    border: 1.5px solid var(--accent);
    cursor: pointer;
    transition: background var(--dur-fast), transform var(--dur-fast);
  }
  .ws-stat-edit:hover,
  .ws-stat-edit:active {
    background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
  }
  .ws-stat-edit:active { transform: scale(0.97); }
  .ws-stat-edit-icon {
    position: absolute; top: 6px; right: 6px;
    font-size: 14px;
    color: var(--accent-text, #0A0B0F);
    background: var(--accent);
    border-radius: 50%;
    padding: 3px;
    line-height: 1;
    box-shadow: 0 1px 4px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .ws-stat-placeholder { color: var(--text-3); font-style: italic; font-weight: 600; }

  .ws-duration-editor {
    display: flex; flex-direction: column; gap: 10px;
    margin: 0 20px 12px; padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .ws-duration-chips {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .ws-duration-chip {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 6px 14px; font-size: 13px; font-weight: 600;
    color: var(--text-1); cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .ws-duration-chip:hover { background: var(--surface-2); border-color: var(--accent); }
  .ws-duration-chip.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: var(--accent);
    color: var(--accent);
  }
  .ws-duration-custom {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .ws-duration-input {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 8px 10px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    width: 80px;
  }
  .ws-duration-input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .ws-duration-unit { font-size: 13px; color: var(--text-3); }
  .ws-duration-save, .ws-duration-cancel { height: 36px; font-size: 13px; padding: 0 14px; }
  .ws-duration-cancel { margin-left: auto; }

  .ws-calorie-row {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin: 0 20px 12px; padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: var(--radius-md);
  }
  .ws-calorie-icon { font-size: 20px; color: var(--accent); }
  .ws-calorie-val  { font-size: 16px; font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .ws-calorie-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 6px; border-radius: var(--radius-full);
  }
  .ws-calorie-badge.rough {
    color: var(--warning, #f59e0b);
    background: color-mix(in srgb, var(--warning, #f59e0b) 12%, transparent);
  }

  .ws-exercise-list { padding: 0 20px 12px; display: flex; flex-direction: column; gap: 4px; }
  .ws-ex-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--border);
  }
  .ws-ex-row:last-child { border-bottom: none; }
  .ws-ex-name { font-size: 14px; font-weight: 600; color: var(--text-1); flex: 1; min-width: 0; }
  .ws-ex-sets { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; text-align: right; }

  /* Superset group — preserves the "these were done as a unit" intent.
     Accent left rail + small label header so a glance at the summary
     (and the shared image card) reads supersets as one block instead
     of two unrelated exercise rows. */
  .ws-superset {
    border-left: 3px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    padding: 6px 10px 6px 8px;
    margin: 4px 0;
  }
  .ws-superset-label {
    display: flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent);
    margin-bottom: 4px;
  }
  .ws-superset-label .ss-icon { font-size: 14px; }
  /* Member rows inside a superset shed their bottom border (the rail
     already groups them) and tighten vertical padding. */
  .ws-superset .ws-ex-row { padding: 4px 0; border-bottom: none; }
  .ws-superset .ws-ex-row + .ws-ex-row { border-top: 1px dashed color-mix(in srgb, var(--accent) 25%, transparent); }

  .ws-footer {
    padding: 12px 20px;
    display: flex; gap: 8px;
  }
  .ws-share-btn {
    flex: 0 0 auto;
    display: flex; align-items: center; gap: 6px;
    height: 42px;
  }
  /* CSV export is an icon-only square so the footer stays balanced
     with the wider Share + Done buttons. Same height as Share so the
     two secondaries align visually. */
  .ws-icon-btn {
    flex: 0 0 auto;
    width: 42px; height: 42px; padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .ws-icon-btn .material-symbols-rounded { font-size: 20px; }
  .ws-done-btn { flex: 1; }
</style>
