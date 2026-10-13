<script>
  // The Coach tab in Programs, for the person being coached: their coach and
  // Leave Coach, then requests to answer. Nothing about the client is visible
  // to a coach before Accept.
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { replace } from 'svelte-spa-router';
  import { bannerStyle } from '../stores/settings.js';
  import {
    coachingState, coachingNeedsServer, refreshCoaching, setCoachingFromServer, coachTab, coachingFetch, coachingVersion,
  } from '../stores/coaching.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { coachingErrorText, formatServerDay } from '../lib/coaching-view.js';
  import CoachTabs from '../components/layout/CoachTabs.svelte';
  import CoachingNeedsServer from '../components/coaching/CoachingNeedsServer.svelte';
  import Conversation from '../components/coaching/Conversation.svelte';

  const needsServer = coachingNeedsServer();
  let loaded = false;
  let busy = false;

  // The coach, once accepted; requests waiting for an answer (one per coach).
  $: pairing = $coachingState?.as_client || null;
  $: coachName = pairing?.coach?.name || '';
  $: requests = $coachingState?.requests || [];
  // Coaching that ended: its conversation stays readable here.
  $: past = $coachingState?.past || [];
  let pastId = null;
  $: if (!past.some(p => p.id === pastId)) pastId = past[0]?.id ?? null;
  $: shownPast = past.find(p => p.id === pastId) || null;

  onMount(async () => {
    if (!needsServer) await refreshCoaching();
    loaded = true;
  });

  // Nothing to show here any more (left, declined, or ended by the coach):
  // back to Programs rather than an empty page.
  $: if (loaded && !needsServer && !$coachTab) replace('/programs');

  async function answer(req, kind) {
    if (busy) return;
    const name = req.coach.name;
    if (kind === 'decline' && !await confirmDialog({
      title: $_('coaching.client.decline_title', { values: { name } }),
      message: $_('coaching.client.decline_message', { values: { name } }),
      confirmText: $_('coaching.client.decline'),
      cancelText: $_('common.cancel'),
    })) return;
    busy = true;
    try {
      const state = await coachingFetch('POST', `/api/coaching/pairings/${req.id}/${kind}`, {});
      setCoachingFromServer({ state, userId: localStorage.getItem('wl:userId') });
      showSuccess(kind === 'accept'
        ? $_('coaching.client.accepted', { values: { name } })
        : $_('coaching.client.declined'));
    } catch (e) {
      showError(coachingErrorText(e, $_));
      await refreshCoaching();
    }
    busy = false;
  }

  async function leave() {
    if (busy || !pairing) return;
    if (!await confirmDialog({
      title: $_('coaching.client.leave_title', { values: { name: coachName } }),
      message: $_('coaching.client.leave_message', { values: { name: coachName } }),
      confirmText: $_('coaching.client.leave'),
      cancelText: $_('common.cancel'),
      dangerous: true,
    })) return;
    busy = true;
    try {
      const state = await coachingFetch('POST', `/api/coaching/pairings/${pairing.id}/end`, {});
      setCoachingFromServer({ state, userId: localStorage.getItem('wl:userId') });
      showSuccess($_('coaching.client.left', { values: { name: coachName } }));
    } catch (e) {
      showError(coachingErrorText(e, $_));
      await refreshCoaching();
    }
    busy = false;
  }
</script>

<div class="page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.programs.title')}</h1>
  </header>

  <CoachTabs force />

  <div class="content coach-page">
    {#if needsServer}
      <CoachingNeedsServer />
    {:else}
      {#if pairing}
        <section class="card coach-card">
          <div class="coach-avatar" aria-hidden="true">{coachName.slice(0, 1).toUpperCase()}</div>
          <div class="coach-info">
            <div class="coach-label">{$_('coaching.client.your_coach')}</div>
            <div class="coach-name">{coachName}</div>
            {#if pairing.responded_at}
              <div class="coach-since">{$_('coaching.client.since', { values: { date: formatServerDay(pairing.responded_at) } })}</div>
            {/if}
          </div>
          <button class="btn btn-ghost leave-btn" disabled={busy} on:click={leave}>
            <span class="material-symbols-rounded" aria-hidden="true">logout</span>
            {$_('coaching.client.leave')}
          </button>
        </section>
      {/if}

      <!-- Requests waiting for an answer, pinned on top. -->
      {#each requests as req (req.id)}
        <section class="card consent-card" aria-labelledby="consent-title-{req.id}">
          <div class="consent-head">
            <span class="material-symbols-rounded consent-icon" aria-hidden="true">sports</span>
            <h2 id="consent-title-{req.id}" class="consent-title">{$_('coaching.client.request_title', { values: { name: req.coach.name } })}</h2>
          </div>
          <p class="consent-body">{$_('coaching.client.request_body', { values: { name: req.coach.name } })}</p>
          {#if req.note}
            <blockquote class="consent-note">{req.note}</blockquote>
          {/if}
          {#if pairing}
            <p class="consent-blocked">
              <span class="material-symbols-rounded" aria-hidden="true">info</span>
              {$_('coaching.client.leave_first', { values: { coach: coachName, name: req.coach.name } })}
            </p>
          {/if}
          <div class="consent-actions">
            <button class="btn btn-secondary" disabled={busy} on:click={() => answer(req, 'decline')}>{$_('coaching.client.decline')}</button>
            <button class="btn btn-primary" disabled={busy || !!pairing} on:click={() => answer(req, 'accept')}>{$_('coaching.client.accept')}</button>
          </div>
        </section>
      {/each}

      {#if pairing}
        <p class="coach-sees">{$_('coaching.client.coach_sees', { values: { name: coachName } })}</p>
        {#if $coachingVersion >= 2}<Conversation conv={{ pairingId: pairing.id, side: 'client' }} otherName={coachName} />{/if}
      {/if}
      {#if shownPast}
        <section class="past">
          <h2 class="past-title">{$_('coaching.client.past_title')}</h2>
          {#if past.length > 1}
            <div class="past-pick" role="tablist">
              {#each past as p (p.id)}
                <button class="past-chip" class:active={p.id === pastId} role="tab" aria-selected={p.id === pastId} on:click={() => pastId = p.id}>
                  {p.coach.name}{#if p.unread} <span class="unread-pill">{p.unread}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
          <p class="coach-sees">{$_('coaching.client.past_body', { values: { name: shownPast.coach.name, date: formatServerDay(shownPast.ended_at) } })}</p>
          <Conversation conv={{ pairingId: shownPast.id, side: 'client' }} otherName={shownPast.coach.name} readOnly />
        </section>
      {:else if loaded && !requests.length && !pairing}
        <p class="coach-empty">{$_('coaching.client.none')}</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .page { padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + var(--mini-player-h, 0px) + 16px); }
  .content { padding: 4px var(--page-px) 16px; display: flex; flex-direction: column; gap: 12px; }
  .coach-page { max-width: 720px; }
  .card { border-left: 3px solid var(--accent); padding: 16px; }
  .consent-head { display: flex; align-items: center; gap: 12px; }
  .consent-icon { font-size: 28px; color: var(--accent); flex-shrink: 0; }
  .consent-title { font-size: 17px; font-weight: 700; margin: 0; }
  .consent-body { margin: 12px 0 0; color: var(--text-2); line-height: 1.45; }
  .consent-note {
    margin: 12px 0 0; padding: 10px 12px; border-left: 3px solid var(--border-strong, var(--border));
    background: var(--surface-2); border-radius: var(--radius-sm); color: var(--text-1);
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .consent-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 16px; }
  .coach-card { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; }
  .coach-avatar {
    width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0;
    display: grid; place-items: center; font-size: 20px; font-weight: 700;
    background: var(--accent-dim); color: var(--accent);
  }
  .coach-info { min-width: 0; flex: 1 1 160px; }
  .coach-label { font-size: 12px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .coach-name { font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
  .coach-since { font-size: 13px; color: var(--text-3); margin-top: 2px; }
  .coach-sees { color: var(--text-3); font-size: 13px; line-height: 1.45; margin: 0 4px; }
  .leave-btn { margin-left: auto; color: var(--danger); display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .leave-btn .material-symbols-rounded { font-size: 18px; }
  .consent-blocked { display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-2); font-size: 13px; line-height: 1.45; }
  .consent-blocked .material-symbols-rounded { font-size: 18px; color: var(--accent); flex-shrink: 0; }
  .coach-empty { color: var(--text-3); margin-top: 24px; text-align: center; }
  .past { margin-top: 8px; }
  .past-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); margin: 0 0 8px; font-weight: 700; }
  .past-pick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
  .past-chip { border: 1px solid var(--border); background: var(--surface-1); color: var(--text-2); border-radius: var(--radius-full); padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .past-chip.active { border-color: var(--accent); color: var(--accent); }
  .unread-pill { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--accent-text, #fff); font-size: 11px; font-weight: 700; text-align: center; }
</style>
