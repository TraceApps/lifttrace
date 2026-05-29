<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import MediaInput from './MediaInput.svelte';
  import { LtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { CATEGORIES, EQUIPMENT, MUSCLES } from '../../lib/workout.js';

  /** If null, editor is in "create" mode. Otherwise edits the given exercise. */
  export let exercise = null;
  export let open = false;
  /** Pre-fill the name field (used when creating from an empty picker search). */
  export let prefillName = '';

  const dispatch = createEventDispatcher();

  let name = '';
  let category = '';
  let primaryMuscles = [];
  let secondaryMuscles = [];
  let equipment = [];
  let instructions = '';
  let tips = '';
  let img_url = '';
  let gif_url = '';
  let video_url = '';
  let saving = false;

  // Reset fields whenever the modal opens.
  $: if (open) _hydrate(exercise);

  function _hydrate(ex) {
    if (ex) {
      name = ex.name || '';
      category = ex.category || '';
      primaryMuscles = Array.isArray(ex.primary_muscles) ? [...ex.primary_muscles] : [];
      secondaryMuscles = Array.isArray(ex.secondary_muscles) ? [...ex.secondary_muscles] : [];
      equipment = Array.isArray(ex.equipment) ? [...ex.equipment] : [];
      instructions = ex.instructions || '';
      tips = ex.tips || '';
      img_url = ex.img_url || '';
      gif_url = ex.gif_url || '';
      video_url = ex.video_url || '';
    } else {
      name = prefillName || '';
      category = '';
      primaryMuscles = [];
      secondaryMuscles = [];
      equipment = [];
      instructions = '';
      tips = '';
      img_url = ''; gif_url = ''; video_url = '';
    }
  }

  function toggleIn(arr, value) {
    return arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value];
  }
  function togglePrimary(m)   { primaryMuscles   = toggleIn(primaryMuscles, m);   if (primaryMuscles.includes(m))   secondaryMuscles = secondaryMuscles.filter(x => x !== m); }
  function toggleSecondary(m) { secondaryMuscles = toggleIn(secondaryMuscles, m); if (secondaryMuscles.includes(m)) primaryMuscles   = primaryMuscles.filter(x => x !== m); }
  function toggleEquip(e)     { equipment        = toggleIn(equipment, e); }

  async function save() {
    if (!name.trim()) { showError($_('common.errors.name_required')); return; }
    if (saving) return;
    saving = true;
    const payload = {
      name: name.trim(),
      category: category || null,
      primary_muscles: primaryMuscles,
      secondary_muscles: secondaryMuscles,
      equipment,
      instructions: instructions.trim() || null,
      tips: tips.trim() || null,
      img_url: img_url || null,
      gif_url: gif_url || null,
      video_url: video_url || null,
    };
    try {
      const result = exercise
        ? await LtApi.updateExercise(exercise.id, payload)
        : await LtApi.createExercise(payload);
      showSuccess(exercise ? 'Exercise updated' : `Added "${result.name}"`);
      dispatch('saved', result);
      open = false;
    } catch(e) { showError(e.message); }
    saving = false;
  }

  function cancel() { open = false; dispatch('cancel'); }
</script>

<Sheet {open} on:close={cancel} title={exercise ? 'Edit exercise' : 'Create exercise'}>
  <div class="editor">
    <!-- Name -->
    <div class="field">
      <label class="label" for="ex-name">Name <span class="required">*</span></label>
      <input id="ex-name" class="input" type="text" bind:value={name} placeholder="e.g. Romanian Deadlift" autofocus />
    </div>

    <!-- Category -->
    <div class="field">
      <label class="label" for="ex-cat">Category</label>
      <select id="ex-cat" class="input" bind:value={category}>
        <option value="">— pick one —</option>
        {#each CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
      </select>
    </div>

    <!-- Media -->
    <div class="field">
      <label class="label">Media</label>
      <MediaInput bind:img_url bind:gif_url bind:video_url />
    </div>

    <!-- Equipment -->
    <div class="field">
      <label class="label">Equipment</label>
      <div class="chips">
        {#each EQUIPMENT as e}
          <button type="button" class="chip" class:active={equipment.includes(e)} on:click={() => toggleEquip(e)}>
            {e}
          </button>
        {/each}
      </div>
    </div>

    <!-- Primary muscles -->
    <div class="field">
      <label class="label">Primary muscles <span class="sub">(tap to toggle)</span></label>
      <div class="chips">
        {#each MUSCLES as m}
          <button type="button" class="chip primary" class:active={primaryMuscles.includes(m)} on:click={() => togglePrimary(m)}>
            {m}
          </button>
        {/each}
      </div>
    </div>

    <!-- Secondary muscles -->
    <div class="field">
      <label class="label">Secondary muscles</label>
      <div class="chips">
        {#each MUSCLES as m}
          <button type="button" class="chip secondary" class:active={secondaryMuscles.includes(m)} on:click={() => toggleSecondary(m)}>
            {m}
          </button>
        {/each}
      </div>
    </div>

    <!-- Instructions -->
    <div class="field">
      <label class="label" for="ex-instr">Instructions</label>
      <textarea id="ex-instr" class="input area" rows="4" bind:value={instructions} placeholder="Step-by-step form cues, setup, execution…"></textarea>
    </div>

    <!-- Tips -->
    <div class="field">
      <label class="label" for="ex-tips">Tips <span class="sub">(optional)</span></label>
      <textarea id="ex-tips" class="input area" rows="2" bind:value={tips} placeholder="Common mistakes, breathing, progression notes…"></textarea>
    </div>

    <div class="actions">
      <button class="btn btn-secondary" on:click={cancel}>Cancel</button>
      <button class="btn btn-primary" on:click={save} disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : (exercise ? 'Save changes' : 'Create exercise')}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .editor { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .label .required { color: var(--danger, #FF5C5C); }
  .label .sub { font-weight: 400; color: var(--text-3); font-size: 11px; }

  .input {
    width: 100%; padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-size: 15px; font-family: inherit;
    outline: none;
  }
  .input:focus { border-color: var(--accent); }
  .input.area { resize: vertical; min-height: 60px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 6px 12px; border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer;
    text-transform: capitalize;
    transition: all var(--dur-fast);
  }
  .chip:hover { border-color: var(--text-2); }
  .chip.primary.active {
    background: var(--accent);
    color: var(--accent-text, #fff);
    border-color: var(--accent);
  }
  .chip.secondary.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .chip.active:not(.primary):not(.secondary) {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }

  .actions {
    display: flex; gap: 10px; margin-top: 8px;
    position: sticky; bottom: 0;
    padding-top: 8px;
    background: linear-gradient(to top, var(--surface-1), transparent);
  }
  .actions .btn { flex: 1; padding: 13px; font-size: 15px; }
</style>
