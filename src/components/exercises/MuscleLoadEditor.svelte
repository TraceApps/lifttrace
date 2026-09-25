<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { LtApi } from '../../lib/api.js';
  import { MUSCLES_18, musclesOf, validateMuscleLoads } from '../../lib/muscle-load.js';
  import { MUSCLE_NAME } from '../../lib/muscles.js';
  import { showError, showSuccess } from '../../stores/toast.js';

  export let exercise = null;
  export let open = false;

  const dispatch = createEventDispatcher();
  let loads = {};
  let saving = false;

  $: if (open && exercise) hydrate(exercise);

  function catalogLoads(ex) {
    return musclesOf({
      primary: ex?.primary_muscles || [],
      secondary: ex?.secondary_muscles || [],
      category: String(ex?.category || '').toLowerCase(),
    });
  }

  function hydrate(ex) {
    loads = { ...(ex.muscle_load || catalogLoads(ex)) };
  }

  function setPercent(muscle, value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    loads = { ...loads, [muscle]: percent / 100 };
  }

  async function save() {
    if (!exercise || saving) return;
    saving = true;
    try {
      const result = await LtApi.saveExerciseMuscleLoad(exercise.id, validateMuscleLoads(loads));
      showSuccess($_('muscle_load.toast_saved'));
      dispatch('saved', result.muscle_load);
      open = false;
    } catch (e) { showError(e.message); }
    saving = false;
  }

  async function reset() {
    if (!exercise || saving) return;
    saving = true;
    try {
      await LtApi.resetExerciseMuscleLoad(exercise.id);
      showSuccess($_('muscle_load.toast_reset'));
      dispatch('saved', null);
      open = false;
    } catch (e) { showError(e.message); }
    saving = false;
  }
</script>

<Sheet bind:open title={$_('muscle_load.title')}>
  <div class="muscle-load-editor">
    <p class="intro">{$_('muscle_load.description')}</p>
    <p class="hint">{$_('muscle_load.independent_hint')}</p>

    <div class="load-list">
      {#each MUSCLES_18 as muscle}
        <label class="load-row">
          <span class="muscle-name">{MUSCLE_NAME[muscle] || muscle}</span>
          <input
            class="load-slider"
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round((loads[muscle] || 0) * 100)}
            on:input={(e) => setPercent(muscle, e.currentTarget.value)}
            aria-label={`${MUSCLE_NAME[muscle] || muscle} relative load`}
          />
          <div class="percent-wrap">
            <input
              class="percent-input"
              type="number"
              min="0"
              max="100"
              step="5"
              value={Math.round((loads[muscle] || 0) * 100)}
              on:change={(e) => setPercent(muscle, e.currentTarget.value)}
              aria-label={`${MUSCLE_NAME[muscle] || muscle} percentage`}
            />
            <span>%</span>
          </div>
        </label>
      {/each}
    </div>

    <div class="actions">
      <button class="btn btn-secondary reset" on:click={reset} disabled={saving || !exercise?.muscle_load}>
        {$_('muscle_load.reset')}
      </button>
      <button class="btn btn-secondary" on:click={() => open = false} disabled={saving}>{$_('common.cancel')}</button>
      <button class="btn btn-primary" on:click={save} disabled={saving}>
        {saving ? $_('common.saving') : $_('common.save')}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .muscle-load-editor { display: flex; flex-direction: column; gap: 12px; padding: 2px 0 8px; }
  .intro, .hint { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.45; }
  .hint { color: var(--text-3); font-size: 12px; }
  .load-list { display: flex; flex-direction: column; gap: 4px; }
  .load-row {
    display: grid; grid-template-columns: minmax(86px, 1fr) minmax(100px, 1.6fr) 66px;
    align-items: center; gap: 10px; min-height: 42px; padding: 5px 8px;
    border-radius: var(--radius-sm); background: var(--surface-2);
  }
  .muscle-name { color: var(--text-1); font-size: 13px; font-weight: 600; }
  .load-slider { width: 100%; accent-color: var(--accent); }
  .percent-wrap { display: flex; align-items: center; gap: 3px; color: var(--text-3); font-size: 12px; }
  .percent-input {
    width: 48px; padding: 6px 4px; text-align: right; color: var(--text-1);
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
  .reset { margin-right: auto; }
  @media (max-width: 420px) {
    .load-row { grid-template-columns: minmax(78px, 1fr) minmax(76px, 1.3fr) 60px; gap: 7px; padding-inline: 6px; }
  }
</style>
