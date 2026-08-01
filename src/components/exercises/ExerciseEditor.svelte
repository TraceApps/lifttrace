<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import MediaInput from './MediaInput.svelte';
  import { LtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { CATEGORIES, EQUIPMENT, MUSCLES } from '../../lib/workout.js';
  import { customEquipment } from '../../stores/settings.js';

  // Combined picker list = built-in buckets + user-defined kit.
  $: equipmentOptions = [...EQUIPMENT, ...(Array.isArray($customEquipment) ? $customEquipment : []).filter(e => !EQUIPMENT.includes(e))];

  let addingCustomEq = false;
  let newCustomEq = '';
  function addCustomEquipment() {
    const v = newCustomEq.trim();
    if (!v) { addingCustomEq = false; return; }
    const existing = Array.isArray($customEquipment) ? $customEquipment : [];
    if (!existing.includes(v) && !EQUIPMENT.includes(v)) {
      $customEquipment = [...existing, v];
    }
    if (!equipment.includes(v)) equipment = [...equipment, v];
    newCustomEq = '';
    addingCustomEq = false;
  }

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
  // Library-level load_type default (issue #24). null = unset — the app
  // falls back through the client-side per-user preference and finally
  // to 'bilateral' at render time. Setting this here overrides the
  // client-pref tier for everyone reading the catalog entry.
  let load_type = null;
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
      load_type = ex.load_type || null;
    } else {
      name = prefillName || '';
      category = '';
      primaryMuscles = [];
      secondaryMuscles = [];
      equipment = [];
      instructions = '';
      tips = '';
      img_url = ''; gif_url = ''; video_url = '';
      load_type = null;
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
      load_type,
    };
    try {
      const result = exercise
        ? await LtApi.updateExercise(exercise.id, payload)
        : await LtApi.createExercise(payload);
      showSuccess(exercise ? $_('exercise_editor.toast.updated') : $_('exercise_editor.toast.added', { values: { name: result.name } }));
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
      <label class="label" for="ex-name">{$_('exercise_editor.name')} <span class="required">{$_('exercise_editor.required')}</span></label>
      <input id="ex-name" class="input" type="text" bind:value={name} placeholder="e.g. Romanian Deadlift" autofocus />
    </div>

    <!-- Category -->
    <div class="field">
      <label class="label" for="ex-cat">{$_('exercise_editor.category')}</label>
      <select id="ex-cat" class="input" bind:value={category}>
        <option value="">— pick one —</option>
        {#each CATEGORIES as c}<option value={c.id}>{c.label}</option>{/each}
      </select>
    </div>

    <!-- Media -->
    <div class="field">
      <label class="label">{$_('exercise_editor.media')}</label>
      <MediaInput bind:img_url bind:gif_url bind:video_url />
    </div>

    <!-- Load type — library-level default. Falls through the resolver's
         four-tier chain at render time (see src/lib/workout.js
         resolveLoadType): per-instance override → library value here →
         client-side per-user pref → 'bilateral'. Leaving this unset
         means "no library opinion" so any existing personal Diary
         preferences keep working. -->
    <div class="field">
      <label class="label">Load type</label>
      <div class="chips">
        <button type="button" class="chip" class:active={!load_type} on:click={() => load_type = null}>Unset</button>
        <button type="button" class="chip" class:active={load_type === 'bilateral'} on:click={() => load_type = 'bilateral'}>Bilateral</button>
        <button type="button" class="chip" class:active={load_type === 'paired'} on:click={() => load_type = 'paired'}>Per side</button>
        <button type="button" class="chip" class:active={load_type === 'unilateral'} on:click={() => load_type = 'unilateral'}>Alternating</button>
      </div>
    </div>

    <!-- Equipment -->
    <div class="field">
      <label class="label">{$_('exercise_editor.equipment')}</label>
      <div class="chips">
        {#each equipmentOptions as e}
          <button type="button" class="chip" class:active={equipment.includes(e)} on:click={() => toggleEquip(e)}>
            {e}
          </button>
        {/each}
        {#if addingCustomEq}
          <input
            class="custom-eq-input"
            type="text"
            placeholder="e.g. Slackboard"
            bind:value={newCustomEq}
            on:blur={addCustomEquipment}
            on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomEquipment(); } if (e.key === 'Escape') { newCustomEq = ''; addingCustomEq = false; } }}
            autofocus
          />
        {:else}
          <button type="button" class="chip chip-add" on:click={() => { newCustomEq = ''; addingCustomEq = true; }} title="Add custom equipment">
            <span class="material-symbols-rounded chip-add-icon">add</span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Primary muscles -->
    <div class="field">
      <label class="label">{$_('exercise_editor.primary_muscles')} <span class="sub">{$_('exercise_editor.primary_hint')}</span></label>
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
      <label class="label">{$_('exercise_editor.secondary_muscles')}</label>
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
      <label class="label" for="ex-instr">{$_('exercise_editor.instructions')}</label>
      <textarea id="ex-instr" class="input area" rows="4" bind:value={instructions} placeholder={$_('exercise_editor.instructions_ph')}></textarea>
    </div>

    <!-- Tips -->
    <div class="field">
      <label class="label" for="ex-tips">{$_('exercise_editor.tips')} <span class="sub">{$_('exercise_editor.tips_optional')}</span></label>
      <textarea id="ex-tips" class="input area" rows="2" bind:value={tips} placeholder={$_('exercise_editor.tips_ph')}></textarea>
    </div>

    <div class="actions">
      <button class="btn btn-secondary" on:click={cancel}>{$_('exercise_editor.cancel')}</button>
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
  .chip-add { padding: 6px 10px; }
  .chip-add-icon { font-size: 16px; vertical-align: middle; }
  .custom-eq-input {
    padding: 6px 10px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px dashed var(--accent);
    color: var(--text-1);
    font-size: 12px; font-family: inherit;
    outline: none;
    min-width: 120px;
  }

  .actions {
    display: flex; gap: 10px; margin-top: 8px;
    position: sticky; bottom: 0;
    padding-top: 8px;
    background: linear-gradient(to top, var(--surface-1), transparent);
  }
  .actions .btn { flex: 1; padding: 13px; font-size: 15px; }
</style>
