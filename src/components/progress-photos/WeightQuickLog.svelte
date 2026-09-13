<script>
  /**
   * WeightQuickLog.svelte
   *
   * One inline "log the weight for this date" field, shared by the photo
   * timeline (offered right after a capture) and the scrubber (offered when
   * you notice a gap while looking back). A photo with no weight beside it
   * is much weaker as a record, and the capture moment is the only time that
   * number is free to collect.
   *
   * This writes to body_stats_log through the same PUT every other weight
   * surface uses. It is a second door onto one value, never a second copy of
   * it: the photo row itself stores no weight.
   *
   * It reads the date's existing stats before writing, because that PUT
   * replaces the whole stats blob. Sending { weight } alone would silently
   * erase a waist or body-fat figure already logged that day.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { weightUnit } from '../../stores/settings.js';
  import { showError } from '../../stores/toast.js';

  /** @type {string} YYYY-MM-DD */
  export let date;
  /** Dark-surface variant, for sitting over a photo rather than on a card. */
  export let onDark = false;

  const dispatch = createEventDispatcher();

  let value = '';
  let saving = false;
  let inputEl;

  onMount(() => inputEl?.focus());

  async function commit() {
    const val = parseFloat(value);
    if (!Number.isFinite(val) || val <= 0) { dispatch('cancel'); return; }
    saving = true;
    try {
      // Merge, do not replace. See the header comment.
      let existing = {};
      try {
        const cur = await fetch(`/api/body-stats/${date}`, { credentials: 'include' });
        if (cur.ok) {
          const data = await cur.json();
          const raw = typeof data.stats === 'string' ? JSON.parse(data.stats) : data.stats;
          existing = raw?.stats ?? raw ?? {};
        }
      } catch { existing = {}; }

      const res = await fetch(`/api/body-stats/${date}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats: { ...existing, weight: val } }),
      });
      if (!res.ok) throw new Error($_('progress.weight.save_failed'));

      dispatch('saved', { date, weight: val });
      // The app's existing "body stats changed" signal, so the diary widget
      // and anything else listening refresh without prop drilling.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lt:body-stats-saved'));
      }
    } catch (e) {
      showError(e.message || $_('progress.weight.save_failed'));
    } finally {
      saving = false;
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); dispatch('cancel'); }
  }
</script>

<div class="wql" class:on-dark={onDark}>
  <input
    class="wql-input"
    type="number"
    step="0.1"
    min="0"
    inputmode="decimal"
    bind:this={inputEl}
    bind:value
    on:keydown={onKeyDown}
    placeholder={$weightUnit}
    aria-label={$_('progress.weight.label')}
    disabled={saving}
  />
  <button class="wql-save" on:click={commit} disabled={saving || !value}>
    {saving ? $_('progress.weight.saving') : $_('progress.weight.save')}
  </button>
  <button class="wql-cancel" on:click={() => dispatch('cancel')} aria-label={$_('common.cancel')}>
    <span class="material-symbols-rounded">close</span>
  </button>
</div>

<style>
  .wql { display: flex; align-items: center; gap: 6px; }

  .wql-input {
    width: 88px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 6px 10px;
    color: var(--text-1);
    font-size: 13px; font-family: inherit;
    outline: none;
  }
  .wql-input:focus { border-color: var(--accent); }

  .wql-save {
    background: var(--accent); color: #fff;
    border: none; border-radius: var(--radius-md);
    padding: 7px 12px;
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .wql-save:disabled { opacity: 0.5; cursor: default; }

  .wql-cancel {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 2px;
    display: flex; align-items: center;
  }
  .wql-cancel .material-symbols-rounded { font-size: 18px; }

  /* Over a photo the surface tokens have no contrast to work against, so
     this variant carries its own. */
  .on-dark .wql-input {
    background: rgba(0, 0, 0, 0.55);
    border-color: rgba(255, 255, 255, 0.35);
    color: #fff;
  }
  .on-dark .wql-cancel { color: rgba(255, 255, 255, 0.8); }
</style>
