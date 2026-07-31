<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import {
    weeklyWorkoutGoal, weeklyCardioMinutesGoal, screenKeepAwake, autoFillLastWeights,
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

  $: BODY_STATS = [
    { id: 'weight',  label: $_('settings_workout.body_stats.weight') },
    { id: 'bodyFat', label: $_('settings_workout.body_stats.body_fat') },
    { id: 'neck',    label: $_('settings_workout.body_stats.neck') },
    { id: 'chest',   label: $_('settings_workout.body_stats.chest') },
    { id: 'waist',   label: $_('settings_workout.body_stats.waist') },
    { id: 'hips',    label: $_('settings_workout.body_stats.hips') },
    { id: 'biceps',  label: $_('settings_workout.body_stats.biceps') },
    { id: 'thighs',  label: $_('settings_workout.body_stats.thighs') },
    { id: 'calves',  label: $_('settings_workout.body_stats.calves') },
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
      <p class="sub-label">{$_('settings_workout.sections.goals')}</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.goals.weekly')}</span>
            <span class="setting-hint">{$_('settings_workout.goals.weekly_desc')}</span>
          </div>
          <select class="form-select-sm" bind:value={$weeklyWorkoutGoal}>
            {#each [2,3,4,5,6,7] as n}
              <option value={n}>{$_('settings_workout.goals.weekly_option', { values: { n } })}</option>
            {/each}
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">Weekly Cardio Minutes</span>
            <span class="setting-hint">Target line on the Statistics Cardio chart. Set to 0 to hide the target.</span>
          </div>
          <input class="form-input-sm" type="number" min="0" step="15" style="width:90px"
            bind:value={$weeklyCardioMinutesGoal} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.goals.keep_awake')}</span>
            <span class="setting-hint">{$_('settings_workout.goals.keep_awake_desc')}</span>
          </div>
          <Toggle bind:checked={$screenKeepAwake} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.goals.calorie_est')}</span>
            <span class="setting-hint">{$_('settings_workout.goals.calorie_est_desc')}</span>
          </div>
          <Toggle bind:checked={$caloriesBurnedEnabled} />
        </div>
      </div>

      <p class="sub-label">{$_('settings_workout.sections.logging')}</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.autofill')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.autofill_desc')}</span>
          </div>
          <Toggle bind:checked={$autoFillLastWeights} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.summary')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.summary_desc')}</span>
          </div>
          <Toggle bind:checked={$showCompletionSummary} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.auto_collapse')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.auto_collapse_desc')}</span>
          </div>
          <Toggle bind:checked={$autoCollapseCompleted} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.auto_name')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.auto_name_desc')}</span>
          </div>
          <Toggle bind:checked={$autoNameWorkouts} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.reorder')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.reorder_desc')}</span>
          </div>
          <select class="form-select-sm" bind:value={$exerciseReorderMethod}>
            <option value="both">{$_('settings_workout.logging.reorder_both')}</option>
            <option value="drag">{$_('settings_workout.logging.reorder_drag')}</option>
            <option value="buttons">{$_('settings_workout.logging.reorder_buttons')}</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.confirm_remove')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.confirm_remove_desc')}</span>
          </div>
          <Toggle bind:checked={$confirmExerciseRemoval} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.warmups')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.warmups_desc')}</span>
          </div>
          <Toggle bind:checked={$autoGenerateWarmups} />
        </div>
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.logging.rpe')}</span>
            <span class="setting-hint">{$_('settings_workout.logging.rpe_desc')}</span>
          </div>
          <Toggle bind:checked={$trackRpe} />
        </div>
      </div>

      <p class="sub-label">{$_('settings_workout.sections.rest_timer')}</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label">{$_('settings_workout.rest.enabled')}</span>
            <span class="setting-hint">{$_('settings_workout.rest.enabled_desc')}</span>
          </div>
          <Toggle bind:checked={$restTimerEnabled} />
        </div>
        {#if $restTimerEnabled}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_workout.rest.duration')}</span>
              <span class="setting-hint">{$_('settings_workout.rest.duration_desc')}</span>
            </div>
            <select class="form-select-sm" bind:value={$restDuration}>
              {#each [30,45,60,75,90,120,150,180,240,300] as s}
                <option value={s}>{s >= 60 ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : $_('settings_workout.rest.duration_seconds', { values: { s } })}</option>
              {/each}
            </select>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_workout.rest.auto_start')}</span>
              <span class="setting-hint">{$_('settings_workout.rest.auto_start_desc')}</span>
            </div>
            <Toggle bind:checked={$restAutoStart} />
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$_('settings_workout.rest.alert')}</span>
              <span class="setting-hint">{$_('settings_workout.rest.alert_desc')}</span>
            </div>
            <Toggle bind:checked={$restAlert} />
          </div>
          {#if $restAlert}
            <div class="setting-row" style="padding-left:28px">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings_workout.rest.vibrate')}</span>
                <span class="setting-hint">{$_('settings_workout.rest.vibrate_desc')}</span>
              </div>
              <Toggle bind:checked={$restAlertVibrate} />
            </div>
            <div class="setting-row" style="padding-left:28px">
              <div class="setting-label-group">
                <span class="setting-label">{$_('settings_workout.rest.tone')}</span>
                <span class="setting-hint">{$_('settings_workout.rest.tone_desc')}</span>
              </div>
              <Toggle bind:checked={$restAlertTone} />
            </div>
            {#if $restAlertTone}
              <div class="setting-row" style="padding-left:28px;flex-direction:column;align-items:stretch;gap:6px">
                <div class="setting-label-group">
                  <span class="setting-label">{$_('settings_workout.rest.tone_style')}</span>
                  <span class="setting-hint">{$_('settings_workout.rest.tone_style_desc')}</span>
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
                      <button class="tone-preview" on:click={() => previewRestTone(tone.id)} title={$_('settings_workout.rest.preview')}>
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

      <p class="sub-label">{$_('settings_workout.sections.body_measurements')}</p>
      <div class="card">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label" style="font-size:12px;color:var(--text-3)">{$_('settings_workout.body_stats.toggle_desc')}</span>
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
