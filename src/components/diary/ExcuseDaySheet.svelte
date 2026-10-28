<script>
  // Excuse a day you couldn't train (issue #121): a reason, an optional
  // note, Save. Editing an excused day offers Remove too. The Diary owns
  // the saving; this only gathers the answer.
  import { createEventDispatcher, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { EXCUSE_REASONS, EXCUSE_NOTE_MAX } from '../../lib/trained-day.js';
  import { EXCUSE_ICONS } from '../../lib/excused-view.js';

  export let open = false;
  /** YYYY-MM-DD of the day being excused. */
  export let date = '';
  /** The day's excused record when editing one, else null. */
  export let current = null;
  /** The day shown in words ("Tuesday, October 20"). */
  export let dateLabel = '';
  export let saving = false;
  /** The person has a coach, who sees the reason and the note. */
  export let coachSees = false;

  const dispatch = createEventDispatcher();
  let reason = null;
  let note = '';
  let chips = [];
  let wasOpen = false;

  // Filled from the record each time the sheet opens, so an edit starts
  // from what's saved and a new one starts empty.
  $: if (open && !wasOpen) {
    wasOpen = true;
    reason = current?.reason || null;
    note = current?.note || '';
    tick().then(() => {
      const i = Math.max(0, EXCUSE_REASONS.indexOf(reason));
      chips[i]?.focus();
    });
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  function pick(r) { reason = r; }

  // A radio group: arrow keys move the choice, as a native one does.
  function onChipKey(e, i) {
    const n = EXCUSE_REASONS.length;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next == null) return;
    e.preventDefault();
    reason = EXCUSE_REASONS[next];
    chips[next]?.focus();
  }

  function save() {
    if (!reason || saving) return;
    dispatch('save', { date, reason, note: note.trim() || null });
  }
  function remove() {
    if (saving) return;
    dispatch('remove', { date });
  }
  function close() {
    open = false;
    dispatch('close');
  }
</script>

<Sheet bind:open title={current ? $_('excused.edit_title') : $_('excused.sheet_title')} on:close={() => dispatch('close')}>
  <form class="excuse-sheet" on:submit|preventDefault={save}>
    {#if dateLabel}<p class="excuse-date">{dateLabel}</p>{/if}
    <p class="excuse-hint">{$_('excused.sheet_hint')}</p>

    <div class="excuse-field">
      <span class="excuse-label" id="excuse-reason-label">{$_('excused.reason_label')}</span>
      <div class="excuse-chips" role="radiogroup" aria-labelledby="excuse-reason-label">
        {#each EXCUSE_REASONS as r, i (r)}
          <button
            type="button"
            class="excuse-chip"
            class:on={reason === r}
            role="radio"
            aria-checked={reason === r}
            tabindex={reason === r || (!reason && i === 0) ? 0 : -1}
            bind:this={chips[i]}
            on:click={() => pick(r)}
            on:keydown={(e) => onChipKey(e, i)}
          >
            <span class="material-symbols-rounded" aria-hidden="true">{reason === r ? 'check' : EXCUSE_ICONS[r]}</span>
            {$_(`excused.reason.${r}`)}
          </button>
        {/each}
      </div>
    </div>

    <label class="excuse-field" for="excuse-note">
      <span class="excuse-label">{$_('excused.note_label')}</span>
      <textarea
        id="excuse-note"
        class="input textarea excuse-note"
        rows="3"
        maxlength={EXCUSE_NOTE_MAX}
        placeholder={$_('excused.note_placeholder')}
        bind:value={note}
      ></textarea>
      {#if coachSees}<span class="excuse-coach">{$_('excused.coach_sees')}</span>{/if}
    </label>

    <div class="excuse-actions">
      {#if current}
        <button type="button" class="btn btn-ghost excuse-remove" on:click={remove} disabled={saving}>
          <span class="material-symbols-rounded" aria-hidden="true">event_available</span>
          {$_('excused.remove')}
        </button>
      {/if}
      <span class="excuse-spacer"></span>
      <button type="button" class="btn btn-secondary" on:click={close} disabled={saving}>{$_('common.cancel')}</button>
      <button type="submit" class="btn btn-primary" disabled={!reason || saving}>
        {saving ? $_('common.saving') : $_('common.save')}
      </button>
    </div>
  </form>
</Sheet>

<style>
  .excuse-sheet { display: flex; flex-direction: column; gap: 16px; padding-top: 2px; }
  .excuse-date { margin: -6px 0 0; font-size: 14px; font-weight: 600; color: var(--text-2); }
  .excuse-hint { margin: -8px 0 0; font-size: 13px; line-height: 1.45; color: var(--text-3); }
  .excuse-field { display: flex; flex-direction: column; gap: 8px; }
  .excuse-label {
    font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--text-3);
  }
  .excuse-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .excuse-chip {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px; padding: 0 14px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .excuse-chip .material-symbols-rounded { font-size: 18px; }
  .excuse-chip:hover { background: var(--surface-3); color: var(--text-1); }
  .excuse-chip.on {
    background: color-mix(in srgb, var(--excused) 30%, var(--surface-1));
    border-color: var(--excused);
    box-shadow: inset 0 0 0 1px var(--excused);
    color: var(--text-1);
  }
  .excuse-chip.on .material-symbols-rounded { color: var(--excused); }
  .excuse-chip:focus-visible { outline: 2px solid var(--excused); outline-offset: 2px; }
  .excuse-note { min-height: 84px; font-size: 15px; }
  .excuse-coach { font-size: 12px; color: var(--text-3); }
  .excuse-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
  .excuse-spacer { flex: 1; }
  .excuse-remove { padding: 0 12px; color: var(--text-2); }
  .excuse-remove:hover { color: var(--text-1); background: var(--surface-2); }
  .excuse-remove .material-symbols-rounded { font-size: 18px; }
  @media (max-width: 380px) {
    .excuse-actions .btn { padding: 0 14px; }
  }
</style>
