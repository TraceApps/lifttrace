<script>
  // Add Client: a name list (id and name only, like any picker of people)
  // and an optional note. Nothing of theirs is visible until they accept.
  // On a server from before consent the same sheet adds them at once, as it
  // always did, and says so.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { foldText } from '../../lib/search-text.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { coachingSupported, coachingFetch } from '../../stores/coaching.js';
  import { coachingErrorText } from '../../lib/coaching-view.js';

  export let open = false;
  const dispatch = createEventDispatcher();
  const NOTE_MAX = 500;

  let people = null, loadErr = '';
  let query = '', picked = null, note = '', sending = false;

  $: if (open) load();
  async function load() {
    people = null; loadErr = ''; picked = null; note = ''; query = '';
    try { people = await coachingFetch('GET', '/api/trainer/unassigned-members'); }
    catch (e) { loadErr = coachingErrorText(e, $_); people = []; }
  }

  // An older server sends whole account rows: the same name either way.
  const nameOf = (p) => p.name || p.full_name || p.nickname || p.username || '';
  $: shown = (people || []).filter(p => !query.trim() || foldText(nameOf(p)).includes(foldText(query.trim())));

  async function send() {
    if (!picked || sending) return;
    sending = true;
    const name = nameOf(picked);
    try {
      const r = await coachingFetch('POST', `/api/trainer/members/${picked.id}`, $coachingSupported && note.trim() ? { note: note.trim() } : {});
      showSuccess(r?.status === 'pending'
        ? $_('coaching.request.sent', { values: { name } })
        : $_('coaching.request.added', { values: { name } }));
      open = false;
      dispatch('sent', picked);
    } catch (e) { showError(coachingErrorText(e, $_)); }
    sending = false;
  }
</script>

<Sheet bind:open title={$_('coaching.request.title')} on:close>
  <div class="rq">
    <p class="rq-intro">{$coachingSupported ? $_('coaching.request.intro') : $_('coaching.request.intro_old')}</p>
    <input class="input" type="search" bind:value={query} placeholder={$_('coaching.request.search')} aria-label={$_('coaching.request.search')} />
    {#if people === null}
      <p class="rq-msg">{$_('coaching.loading')}</p>
    {:else if loadErr}
      <p class="rq-msg">{loadErr}</p>
    {:else if shown.length === 0}
      <p class="rq-msg">{$_('coaching.request.nobody')}</p>
    {:else}
      <ul class="rq-list" aria-label={$_('coaching.request.people')}>
        {#each shown as p (p.id)}
          <li>
            <button class="rq-person" class:picked={picked?.id === p.id} aria-pressed={picked?.id === p.id} on:click={() => picked = p}>
              <span class="rq-avatar" aria-hidden="true">{nameOf(p).slice(0, 1).toUpperCase()}</span>
              <span class="rq-name">{nameOf(p)}</span>
              {#if picked?.id === p.id}<span class="material-symbols-rounded rq-check" aria-hidden="true">check_circle</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if $coachingSupported}
      <label class="rq-label" for="rq-note">{$_('coaching.request.note_label')}</label>
      <textarea id="rq-note" class="input rq-note" rows="3" maxlength={NOTE_MAX} bind:value={note} placeholder={$_('coaching.request.note_placeholder')}></textarea>
    {/if}
    <button class="btn btn-primary rq-send" disabled={!picked || sending} on:click={send}>
      {#if $coachingSupported}
        {picked ? $_('coaching.request.send_to', { values: { name: nameOf(picked) } }) : $_('coaching.request.send')}
      {:else}
        {$_('coaching.request.add')}
      {/if}
    </button>
  </div>
</Sheet>

<style>
  .rq { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
  .rq-intro { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .rq-msg { color: var(--text-3); text-align: center; margin: 16px 0; }
  .rq-list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .rq-person {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    background: none; border: none; border-top: 1px solid var(--border); font: inherit; color: inherit; text-align: left; cursor: pointer;
  }
  .rq-list li:first-child .rq-person { border-top: none; }
  .rq-person.picked { background: var(--accent-dim); }
  .rq-avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-3); font-weight: 700; flex-shrink: 0; }
  .rq-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .rq-check { color: var(--accent); }
  .rq-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .rq-note { resize: vertical; min-height: 72px; font: inherit; }
  .rq-send { width: 100%; }
</style>
