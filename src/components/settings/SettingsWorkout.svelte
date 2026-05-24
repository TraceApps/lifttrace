<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import {
    weeklyWorkoutGoal, goalCelebrations, screenKeepAwake, autoFillLastWeights,
    showCompletionSummary, autoCollapseCompleted, autoNameWorkouts,
    exerciseReorderMethod, confirmExerciseRemoval, restTimerEnabled,
    restDuration, restAutoStart, restAlert, restAlertVibrate, restAlertTone,
    bodyStatsVisible, autoGenerateWarmups, trackRpe, restAlertToneId,
    caloriesBurnedEnabled,
  } from '../../stores/settings.js';
  import { REST_TONES } from '../../lib/restTones.js';
  import { previewRestTone } from '../../stores/restTimer.js';

  export let expanded = false;
  export let visible = true;
  export let onToggle = () => {};

  const BODY_STATS = [
    { id: 'weight',  label: 'Weight' },
    { id: 'bodyFat', label: 'Body Fat %' },
    { id: 'neck',    label: 'Neck' },
    { id: 'chest',   label: 'Chest' },
    { id: 'waist',   label: 'Waist' },
    { id: 'hips',    label: 'Hips' },
    { id: 'biceps',  label: 'Biceps' },
    { id: 'thighs',  label: 'Thighs' },
    { id: 'calves',  label: 'Calves' },
  ];
</script>

{#if visible}
  <button class="section-toggle" on:click={onToggle}>
    <span class="si"><span class="material-symbols-rounded">fitness_center</span></span>
    <span class="section-name">{$_('settings.workout.section')}</span>
    <span class="material-symbols-rounded chevron" class:rotated={expanded}>expand_more</span>
  </button>
  {#if expanded}
    <div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label">Goals & Progress</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Weekly Goal</span>
            <span class="setting-hint">Target number of training days per week</span>
          </div>
          <select class="form-select-sm" bind:value={$weeklyWorkoutGoal}>
            {#each [2,3,4,5,6,7] as n}
              <option value={n}>{n} workouts/week</option>
            {/each}
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Goal Celebrations</span>
            <span class="setting-hint">Confetti when you hit a milestone</span>
          </div>
          <Toggle bind:checked={$goalCelebrations} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Screen Keep-Awake</span>
            <span class="setting-hint">Keep the screen on during workouts</span>
          </div>
          <Toggle bind:checked={$screenKeepAwake} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Show Calorie Estimate</span>
            <span class="setting-hint">Approximate kcal per workout (Mifflin-St Jeor BMR + MET). Needs height + weight + date of birth + sex set in Profile. Resistance-training estimates are loose by Â±25% â€” treated as an "~est" badge in the UI, not a hard number.</span>
          </div>
          <Toggle bind:checked={$caloriesBurnedEnabled} />
        </div>
      </div>

      <p class="sub-label">Logging Behavior</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Auto-Fill Last Weights</span>
            <span class="setting-hint">Pre-fill weight and reps from your last session</span>
          </div>
          <Toggle bind:checked={$autoFillLastWeights} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Completion Summary</span>
            <span class="setting-hint">Show stats recap when all sets are done</span>
          </div>
          <Toggle bind:checked={$showCompletionSummary} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Auto-Collapse Completed Exercises</span>
            <span class="setting-hint">Collapse a card once every set is ticked â€” tap to re-expand</span>
          </div>
          <Toggle bind:checked={$autoCollapseCompleted} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Auto-Name Workouts</span>
            <span class="setting-hint">Name empty workouts from exercise categories (Push Day, Pull Day, etc.)</span>
          </div>
          <Toggle bind:checked={$autoNameWorkouts} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Reorder Method</span>
            <span class="setting-hint">How to reorder exercises in the diary</span>
          </div>
          <select class="form-select-sm" bind:value={$exerciseReorderMethod}>
            <option value="both">Drag + buttons</option>
            <option value="drag">Drag only</option>
            <option value="buttons">Buttons only</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Confirm Before Removing</span>
            <span class="setting-hint">Ask before removing an exercise or superset from the diary</span>
          </div>
          <Toggle bind:checked={$confirmExerciseRemoval} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Auto-Generate Warm-Up Sets</span>
            <span class="setting-hint">When a template loads with target weights, prepend bar / 50% / 70% / 85% warm-ups. You can always add or remove them per-exercise.</span>
          </div>
          <Toggle bind:checked={$autoGenerateWarmups} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Track RPE per Set</span>
            <span class="setting-hint">Log Rate of Perceived Exertion (6â€“10 scale) on each completed set. Useful for autoregulated programs.</span>
          </div>
          <Toggle bind:checked={$trackRpe} />
        </div>
      </div>

      <p class="sub-label">Rest Timer</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Rest Timer</span>
            <span class="setting-hint">Countdown between sets</span>
          </div>
          <Toggle bind:checked={$restTimerEnabled} />
        </div>
        {#if $restTimerEnabled}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Rest Duration</span>
              <span class="setting-hint">Default â€” remembered per-exercise after first use</span>
            </div>
            <select class="form-select-sm" bind:value={$restDuration}>
              {#each [30,45,60,75,90,120,150,180,240,300] as s}
                <option value={s}>{s >= 60 ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : `${s}s`}</option>
              {/each}
            </select>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Auto-Start on Set</span>
              <span class="setting-hint">Start rest timer when you check off a set</span>
            </div>
            <Toggle bind:checked={$restAutoStart} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">Alert When Done</span>
              <span class="setting-hint">Get notified when the timer finishes</span>
            </div>
            <Toggle bind:checked={$restAlert} />
          </div>
          {#if $restAlert}
            <div class="setting-row" style="padding-left:28px">
              <div class="setting-label-group">
                <span class="setting-label">Vibrate</span>
                <span class="setting-hint">Short vibration pattern on finish</span>
              </div>
              <Toggle bind:checked={$restAlertVibrate} />
            </div>
            <div class="setting-row" style="padding-left:28px">
              <div class="setting-label-group">
                <span class="setting-label">Play Tone</span>
                <span class="setting-hint">Brief chime when the timer hits zero</span>
              </div>
              <Toggle bind:checked={$restAlertTone} />
            </div>
            {#if $restAlertTone}
              <div class="setting-row" style="padding-left:28px;flex-direction:column;align-items:stretch;gap:6px">
                <div class="setting-label-group">
                  <span class="setting-label">Tone Style</span>
                  <span class="setting-hint">Tap a row to select; tap â–¶ to preview</span>
                </div>
                <div class="tone-list">
                  {#each REST_TONES as tone}
                    <div class="tone-row" class:active={$restAlertToneId === tone.id}>
                      <button class="tone-main" on:click={() => $restAlertToneId = tone.id}>
                        <div class="tone-info">
                          <span class="tone-name">{tone.name}</span>
                          <span class="tone-desc">{tone.desc}</span>
                        </div>
                        {#if $restAlertToneId === tone.id}
                          <span class="material-symbols-rounded tone-selected">check_circle</span>
                        {/if}
                      </button>
                      <button class="tone-preview" on:click={() => previewRestTone(tone.id)} title="Preview">
                        <span class="material-symbols-rounded">play_arrow</span>
                      </button>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        {/if}
      </div>

      <p class="sub-label">Body Measurements</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label" style="font-size:12px;color:var(--text-3)">Toggle which stats appear in the diary body stats sheet</span>
          </div>
        </div>
        {#each BODY_STATS as stat}
          <div class="setting-row">
            <span class="setting-label">{stat.label}</span>
            <Toggle
              checked={($bodyStatsVisible || []).includes(stat.id)}
              on:change={e => {
                const cur = $bodyStatsVisible || [];
                if (e.detail) $bodyStatsVisible = [...cur, stat.id];
                else $bodyStatsVisible = cur.filter(s => s !== stat.id);
              }}
            />
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}

<style>
  .tone-list { display: flex; flex-direction: column; gap: 4px; }
  .tone-row {
    display: flex; align-items: stretch;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .tone-row.active { border-color: var(--accent); background: var(--accent-dim); }
  .tone-main {
    flex: 1; display: flex; align-items: center; gap: 8px;
    padding: 10px 12px;
    background: none; border: none; cursor: pointer;
    font-family: inherit; text-align: left;
    color: var(--text-1);
  }
  .tone-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tone-name { font-size: 13px; font-weight: 700; color: var(--text-1); }
  .tone-row.active .tone-name { color: var(--accent); }
  .tone-desc { font-size: 11px; color: var(--text-3); line-height: 1.35; }
  .tone-selected { font-size: 18px; color: var(--accent); flex-shrink: 0; }
  .tone-preview {
    width: 42px; border: none; border-left: 1px solid var(--border);
    background: none; color: var(--text-2);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .tone-preview:hover { background: var(--surface-3); color: var(--accent); }
  .tone-preview .material-symbols-rounded { font-size: 18px; }
</style>
