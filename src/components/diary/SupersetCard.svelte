<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { slide, fade } from 'svelte/transition';
  import ExerciseCard from './ExerciseCard.svelte';
  import { getCollapseState, setCollapsed } from '../../lib/cardCollapse.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let exercises = [];
  export let startIdx = 0;
  export let supersetId = null;
  export let targetSets = 1;
  export let unit = 'lbs';
  export let autoCollapse = false;
  export let date = '';
  // Workout-level coach feedback array (all rows for the workout). The
  // card filters down to per-exercise notes keyed by exercise_idx so each
  // superset member shows its own notes directly below its ExerciseCard.
  export let feedback = [];
  // PR flags map keyed by global exercise position (startIdx + offset).
  // SupersetCard slices it per member when rendering each ExerciseCard.
  export let prFlagsByIdx = {};
  // Reply state passed through from Diary so the same single-source state
  // drives both the inline reply boxes inside the SupersetCard and the
  // ones outside it. Diary owns the state + functions; we just render.
  export let replyOpenId = null;
  export let replyDrafts = {};
  export let replySaving = null;
  export let onOpenReply = () => {};
  export let onSaveReply = () => {};
  export let onCancelReply = () => {};
  export let onDeleteReply = () => {};
  export let replySavedFlash = null;
  // Relative-time formatter (shared from Diary so superset members get the
  // same "3h ago" labeling on coach notes / replies that single-exercise
  // cards do). Default is a thin shim so the component still renders if
  // the prop is missed.
  function autofocus(node) { setTimeout(() => node.focus(), 0); return {}; }
  export let relTime = (t) => {
    if (!t) return '';
    const diff = Date.now() - new Date(t).getTime();
    const m = Math.round(diff / 60000);
    if (m < 60) return m <= 1 ? 'just now' : `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return d < 7 ? `${d}d ago` : new Date(t).toLocaleDateString();
  };

  $: rowKey = `ss:${supersetId}`;

  const dispatch = createEventDispatcher();

  $: isSingle = exercises.length <= 1;
  $: allDone = exercises.every(ex =>
    (ex.sets || []).length > 0 && (ex.sets || []).every(s => s.completed)
  );
  $: totalSets = exercises.reduce((sum, ex) => sum + (ex.sets?.length || 0), 0);
  $: completedSets = exercises.reduce((sum, ex) => sum + (ex.sets?.filter(s => s.completed).length || 0), 0);
  $: progress = totalSets === 0 ? 'none' : allDone ? 'done' : completedSets > 0 ? 'partial' : 'none';

  // Auto-collapse when the whole superset round is done. Signature-gated so
  // re-expanding by tap doesn't snap back closed on the next save tick,
  // and respects an explicit "expanded" state from storage so leaving and
  // returning to the page doesn't re-close a card the user deliberately
  // reopened.
  let expanded = true;
  let _autoCollapsedSignature = '';
  $: {
    if (autoCollapse && !isSingle && allDone && totalSets > 0) {
      const sig = exercises.map(e => (e.sets || []).map(s => s.completed ? '1' : '0').join('')).join('|');
      if (_autoCollapsedSignature !== sig) {
        _autoCollapsedSignature = sig;
        if (getCollapseState(date, rowKey) !== 'expanded') {
          _setExpanded(false);
        }
      }
    }
  }

  // Persisted collapse (survives page navigation). Three-state:
  //   'collapsed' → apply closed
  //   'expanded'  → apply open (explicit user intent — no auto-collapse)
  //   null        → keep default (open)
  let _initialExpandedApplied = false;
  $: if (date && rowKey && !_initialExpandedApplied) {
    _initialExpandedApplied = true;
    const state = getCollapseState(date, rowKey);
    if (state === 'collapsed') expanded = false;
    else if (state === 'expanded') expanded = true;
  }
  function _setExpanded(next) {
    expanded = next;
    setCollapsed(date, rowKey, !next);
  }
</script>

{#if isSingle}
  <ExerciseCard
    exercise={exercises[0]}
    idx={startIdx}
    {unit}
    {date}
    {autoCollapse}
    on:update={e => dispatch('update', { idx: startIdx, exercise: e.detail })}
    on:remove={() => dispatch('remove', { idx: startIdx })}
  />
{:else}
  <div class="superset-card" class:all-done={allDone} data-progress={progress}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="superset-header" on:click={() => _setExpanded(!expanded)} role="button" tabindex="0">
      <div class="superset-badge">
        <span class="material-symbols-rounded ss-icon">link</span>
        <span class="ss-label">{$_('superset_card.superset')}</span>
        <span class="ss-count">{exercises.length} exercises</span>
      </div>
      <div class="ss-meta">
        <span class="ss-progress">{completedSets}/{totalSets} sets</span>
        <button class="ss-remove-btn" on:click|stopPropagation={() => dispatch('removeSuperset', supersetId)} title="Remove entire superset">
          <span class="material-symbols-rounded">close</span>
        </button>
        <span class="material-symbols-rounded ss-chevron" class:rotated={!expanded}>expand_more</span>
      </div>
    </div>

    {#if expanded}
      <div class="superset-exercises" transition:slide={{ duration: 180 }}>
        {#each exercises as ex, i (ex.exercise_id || i)}
          <div class="ss-exercise">
            <div class="ss-connector">
              {#if i < exercises.length - 1}
                <div class="connector-line"></div>
              {/if}
              <div class="connector-dot"></div>
            </div>
            <div class="ss-exercise-content">
              <ExerciseCard
                exercise={ex}
                idx={startIdx + i}
                {unit}
                {date}
                {autoCollapse}
                canMoveUp={i > 0}
                canMoveDown={i < exercises.length - 1}
                prSetIndices={prFlagsByIdx[startIdx + i]}
                on:update={e => dispatch('update', { idx: startIdx + i, exercise: e.detail })}
                on:remove={() => dispatch('remove', { idx: startIdx + i })}
                on:menu={() => dispatch('menu', { idx: startIdx + i })}
                on:info={() => dispatch('info', { idx: startIdx + i })}
                on:moveUp={() => dispatch('moveWithinSuperset', { supersetId, fromIdx: i, toIdx: i - 1 })}
                on:moveDown={() => dispatch('moveWithinSuperset', { supersetId, fromIdx: i, toIdx: i + 1 })}
              />
              <!-- Per-exercise coach feedback for THIS superset member,
                   keyed by position in the workout's exercises array. -->
              {#each (feedback || []).filter(f => f.exercise_idx === startIdx + i) as f (f.id)}
                <div class="ss-ex-feedback" in:fade={{ duration: 180 }}>
                  <div class="avatar-chip coach sm">
                    {#if f.trainer_avatar_url}
                      <img src={resolveAssetUrl(f.trainer_avatar_url)} alt="" />
                    {:else}
                      {(f.trainer_name || 'C')[0].toUpperCase()}
                    {/if}
                  </div>
                  <div class="ss-ex-feedback-body">
                    <span class="ss-ex-feedback-text">
                      <strong>{f.trainer_name || 'Coach'}:</strong> {f.note}
                    </span>
                    {#if f.updated_at}
                      <span class="ex-feedback-time">{relTime(f.updated_at)}</span>
                    {/if}
                    {#if replyOpenId === f.id}
                      <div class="reply-edit">
                        <textarea class="reply-input" rows="2"
                          use:autofocus
                          bind:value={replyDrafts[f.id]}
                          placeholder="Reply to your coach…"></textarea>
                        <div class="reply-actions">
                          {#if f.member_reply}
                            <button class="reply-link danger" on:click={() => onDeleteReply(f.id)}>{$_('superset_card.delete')}</button>
                          {/if}
                          <button class="reply-link" on:click={onCancelReply}>{$_('superset_card.cancel')}</button>
                          <button class="reply-save" class:flashed={replySavedFlash === f.id}
                                  on:click={() => onSaveReply(f.id)}
                                  disabled={replySaving === f.id || !(replyDrafts[f.id] || '').trim()}>
                            {#if replySavedFlash === f.id}<span class="material-symbols-rounded" style="font-size:14px">check</span>{:else}{replySaving === f.id ? 'Saving…' : 'Reply'}{/if}
                          </button>
                        </div>
                      </div>
                    {:else if f.member_reply}
                      <button class="my-reply" on:click={() => onOpenReply(f)}>
                        <span class="my-reply-label">
                          You{#if f.member_replied_at} · {relTime(f.member_replied_at)}{/if}
                        </span>
                        <span class="my-reply-text">{f.member_reply}</span>
                        <span class="material-symbols-rounded my-reply-edit-icon">edit</span>
                      </button>
                    {:else}
                      <button class="reply-add" on:click={() => onOpenReply(f)}>
                        <span class="material-symbols-rounded" style="font-size:14px">reply</span>
                        Reply
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}

        <button class="ss-add-exercise" on:click={() => dispatch('addToSuperset', supersetId)}>
          <span class="material-symbols-rounded">add</span>
          Add exercise to superset
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .superset-card {
    border: 2px solid var(--border);
    border-radius: var(--radius-xl);
    overflow: hidden;
    background: var(--bg);
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .superset-card[data-progress='partial'] {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-dim);
  }
  .superset-card.all-done { border-color: var(--success); box-shadow: 0 0 0 1px color-mix(in srgb, var(--success) 20%, transparent); }

  .superset-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; width: 100%;
    background: linear-gradient(135deg, var(--accent-dim), transparent);
    border: none; border-bottom: 1px solid var(--border);
    color: inherit; font-family: inherit; cursor: pointer;
    transition: background var(--dur-fast);
  }
  .superset-header:hover { background: linear-gradient(135deg, var(--accent-dim), var(--surface-2)); }
  .superset-badge { display: flex; align-items: center; gap: 6px; }
  .ss-icon { font-size: 16px; color: var(--accent); }
  .ss-label { font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em; }
  .ss-count { font-size: 11px; color: var(--text-3); }

  .ss-meta { display: flex; align-items: center; gap: 8px; }
  .ss-progress { font-size: 12px; color: var(--text-3); }
  .ss-chevron {
    color: var(--text-3); font-size: 20px;
    transition: transform 0.2s ease;
  }
  .ss-chevron.rotated { transform: rotate(-90deg); }
  .ss-remove-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 2px;
    border-radius: var(--radius-xs);
    display: flex; align-items: center;
    transition: color var(--dur-fast);
  }
  .ss-remove-btn:hover { color: var(--danger); }
  .ss-remove-btn .material-symbols-rounded { font-size: 18px; }

  .superset-exercises { padding: 8px 8px 8px 0; }

  /* Per-exercise coach feedback within a superset — sits right under the
     specific exercise's card so the reader doesn't have to look at the
     bottom of the whole block and figure out which member it's for. */
  .ss-ex-feedback {
    display: flex; align-items: flex-start; gap: 6px;
    margin: 6px 0 4px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
  }
  .ss-ex-feedback-text {
    flex: 1; min-width: 0;
    font-size: 13px; color: var(--text-1); line-height: 1.4;
    white-space: pre-wrap;
  }
  .ss-ex-feedback-text strong { color: var(--accent); font-weight: 700; margin-right: 2px; }
  .ss-ex-feedback-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  /* Reply controls re-use the global classes defined in Diary.svelte so
     styles stay consistent without re-declaring them here. */

  .ss-exercise { display: flex; gap: 0; }

  .ss-connector {
    display: flex; flex-direction: column; align-items: center;
    width: 28px; flex-shrink: 0; position: relative; padding-top: 20px;
  }
  .connector-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); z-index: 1; flex-shrink: 0;
  }
  .connector-line {
    position: absolute; top: 28px; width: 2px;
    height: calc(100% - 8px); background: var(--accent-dim);
  }

  .ss-exercise-content { flex: 1; min-width: 0; padding: 4px 8px 4px 0; }

  .ss-add-exercise {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    width: calc(100% - 36px); margin: 6px 8px 6px 28px; padding: 10px;
    background: var(--surface-2); border: 1px dashed var(--accent-dim);
    border-radius: var(--radius-md);
    color: var(--accent); font-size: 13px; font-weight: 600;
    cursor: pointer; transition: all var(--dur-fast);
  }
  .ss-add-exercise:hover { background: var(--accent-dim); border-color: var(--accent); }
  .ss-add-exercise .material-symbols-rounded { font-size: 18px; }
</style>
