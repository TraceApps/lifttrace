<!--
  Smart Log modal — natural-language / voice workout logging.

  Phase 1 (input):  type or speak → Parse
  Phase 2 (review): tweak matched exercises / sets / weights → Save
  Phase 3 (saving): writes to workout_log

  Voice input uses the Web Speech API (PWA only for now). On native, the
  button is hidden — text input still works.
-->
<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { fly, fade } from 'svelte/transition';
  import { portal } from '../../lib/portal.js';
  import { weightUnit } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { parseInput, matchExercises, mergeIntoWorkout } from '../../lib/smartLogWorkout.js';

  export let open = false;
  export let date = '';            // YYYY-MM-DD
  export let existingLog = null;   // $todayLog
  export let onSave = null;        // (mergedExercises) => saveWorkout call
  // Pre-parsed mode: caller already ran parseInput + matchExercises (e.g. via
  // Trace hold-to-record). Skip the input phase and jump to review.
  export let preParsedMatches = null;  // [{ raw, sets, superset_group, candidates, best, ... }]
  export let preParsedSourceText = ''; // what the user said — shown above the review list

  const dispatch = createEventDispatcher();

  let phase = 'input';              // 'input' | 'parsing' | 'review' | 'saving'
  let inputText = '';
  let inputEl;
  let listening = false;
  let voiceAvailable = false;
  let webRecognition = null;
  let matched = [];                 // resolved items from matchExercises
  let errorMsg = '';

  onMount(() => {
    // Pre-parsed mode: caller handed us matched items — jump straight to review
    if (preParsedMatches && preParsedMatches.length > 0) {
      matched = preParsedMatches;
      inputText = preParsedSourceText || '';
      phase = 'review';
      return;
    }
    setTimeout(() => inputEl?.focus(), 80);
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      webRecognition = new SR();
      webRecognition.continuous = false;
      webRecognition.interimResults = false;
      webRecognition.lang = navigator.language || 'en-US';
      webRecognition.onresult = (e) => {
        const t = e.results[0]?.[0]?.transcript || '';
        if (t) inputText = (inputText ? inputText + ' ' : '') + t;
        listening = false;
      };
      webRecognition.onerror = (e) => {
        listening = false;
        showError('Voice input failed: ' + (e.error || 'unknown'));
      };
      webRecognition.onend = () => { listening = false; };
      voiceAvailable = true;
    }
  });

  onDestroy(() => {
    try { webRecognition?.stop(); } catch {}
  });

  function toggleMic() {
    if (!webRecognition) return;
    if (listening) { try { webRecognition.stop(); } catch {} listening = false; return; }
    try { webRecognition.start(); listening = true; } catch (e) { showError($_('common.errors.cant_start_mic')); }
  }

  async function runParse() {
    const t = inputText.trim();
    if (!t) return;
    phase = 'parsing';
    errorMsg = '';
    try {
      const parsed = await parseInput(t);
      if (!parsed.exercises?.length) {
        errorMsg = "Couldn't find any exercises in that. Try something like \"bench 3x5 at 225\".";
        phase = 'input';
        return;
      }
      matched = await matchExercises(parsed);
      phase = 'review';
    } catch (e) {
      errorMsg = e.message || 'Parse failed';
      phase = 'input';
    }
  }

  function pickCandidate(itemIdx, libEx) {
    matched[itemIdx].best = libEx;
    matched = [...matched];  // trigger reactivity
  }

  function removeItem(itemIdx) {
    matched.splice(itemIdx, 1);
    matched = [...matched];
  }

  function addSetTo(itemIdx) {
    const sets = matched[itemIdx].sets;
    const last = sets[sets.length - 1] || { reps: 0, weight: 0 };
    matched[itemIdx].sets = [...sets, { reps: last.reps, weight: last.weight }];
    matched = [...matched];
  }

  function removeSetFrom(itemIdx, setIdx) {
    const sets = matched[itemIdx].sets.filter((_, i) => i !== setIdx);
    matched[itemIdx].sets = sets;
    matched = [...matched];
  }

  async function runSave() {
    phase = 'saving';
    try {
      const merged = mergeIntoWorkout(matched, existingLog);
      if (onSave) await onSave(merged);
      showSuccess(`Added ${matched.length} exercise${matched.length > 1 ? 's' : ''}`);
      open = false;
      phase = 'input';
      inputText = '';
      matched = [];
    } catch (e) {
      errorMsg = e.message || 'Save failed';
      phase = 'review';
    }
  }

  function closeAndReset() {
    open = false;
    phase = 'input';
    inputText = '';
    matched = [];
    errorMsg = '';
  }

  $: exampleHint = '"bench 3x5 @ 225, squat 5x5 @ 315, curls 3x12 @ 30"';
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sl-backdrop" on:click={closeAndReset}
    in:fade={{ duration: 180 }} out:fade={{ duration: 140 }}>
    <div class="sl-sheet" on:click|stopPropagation
      in:fly={{ y: 40, duration: 240 }} out:fly={{ y: 20, duration: 160 }}>
      <div class="sl-handle"></div>

      <div class="sl-header">
        <span class="material-symbols-rounded sl-header-icon">auto_awesome</span>
        <h3 class="sl-title">Smart Add</h3>
        <button class="sl-close" on:click={closeAndReset} title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>

      {#if phase === 'input'}
        <div class="sl-body">
          <p class="sl-desc">Type or speak your workout. Example: {exampleHint}</p>
          <div class="sl-input-wrap">
            <textarea
              bind:this={inputEl}
              bind:value={inputText}
              class="sl-input"
              rows="4"
              placeholder="bench 3x5 at 225, squat 5x5 at 315…"
              on:keydown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runParse(); }}
            ></textarea>
            {#if voiceAvailable}
              <button class="sl-mic" class:listening on:click={toggleMic}
                title={listening ? 'Stop' : 'Speak'}>
                <span class="material-symbols-rounded">{listening ? 'stop_circle' : 'mic'}</span>
              </button>
            {/if}
          </div>
          {#if errorMsg}
            <p class="sl-error">{errorMsg}</p>
          {/if}
          <div class="sl-actions">
            <button class="btn btn-secondary" on:click={closeAndReset}>Cancel</button>
            <button class="btn btn-primary" on:click={runParse} disabled={!inputText.trim()}>
              <span class="material-symbols-rounded" style="font-size:18px">arrow_forward</span>
              Parse
            </button>
          </div>
        </div>

      {:else if phase === 'parsing'}
        <div class="sl-body sl-center">
          <span class="material-symbols-rounded sl-spin">autorenew</span>
          <p class="sl-center-msg">Reading your workout…</p>
        </div>

      {:else if phase === 'review'}
        <div class="sl-body sl-review">
          <p class="sl-desc">Review and tweak, then save.</p>
          {#each matched as item, i (i)}
            <div class="sl-item" class:unmatched={!item.best}>
              <div class="sl-item-head">
                {#if item.best}
                  <span class="sl-item-name">{item.best.name}</span>
                  {#if item.superset_group}
                    <span class="sl-ss-badge">Superset {item.superset_group}</span>
                  {/if}
                {:else}
                  <span class="sl-item-name sl-unmatched">"{item.raw}"</span>
                  <span class="sl-unmatched-badge">not in library</span>
                {/if}
                <button class="sl-item-remove" on:click={() => removeItem(i)} title="Remove">
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
              {#if item.candidates.length > 1}
                <div class="sl-candidates">
                  <span class="sl-candidates-label">Match:</span>
                  {#each item.candidates.slice(0, 4) as c}
                    <button
                      class="sl-chip"
                      class:active={item.best?.id === c.exercise.id}
                      on:click={() => pickCandidate(i, c.exercise)}>
                      {c.exercise.name}
                    </button>
                  {/each}
                </div>
              {/if}
              <div class="sl-sets-list">
                {#each item.sets as set, si (si)}
                  <div class="sl-set-row">
                    <span class="sl-set-idx">#{si + 1}</span>
                    <input
                      class="sl-set-input" type="number" min="0" step="any"
                      bind:value={set.weight} placeholder="0" />
                    <span class="sl-set-unit">{$weightUnit}</span>
                    <span class="sl-set-x">×</span>
                    <input
                      class="sl-set-input" type="number" min="0"
                      bind:value={set.reps} placeholder="0" />
                    <span class="sl-set-unit">reps</span>
                    {#if set.amrap}<span class="sl-tag">AMRAP</span>{/if}
                    {#if set.bodyweight}<span class="sl-tag">BW</span>{/if}
                    {#if set.rpe != null}<span class="sl-tag">RPE {set.rpe}</span>{/if}
                    {#if item.sets.length > 1}
                      <button class="sl-set-remove" on:click={() => removeSetFrom(i, si)} title="Remove set">
                        <span class="material-symbols-rounded" style="font-size:16px">close</span>
                      </button>
                    {/if}
                  </div>
                {/each}
                <button class="sl-add-set" on:click={() => addSetTo(i)}>
                  <span class="material-symbols-rounded" style="font-size:16px">add</span>
                  Add set
                </button>
              </div>
            </div>
          {/each}
          {#if matched.length === 0}
            <p class="sl-desc" style="text-align:center;padding:20px">All items removed. Go back to add more.</p>
          {/if}
          {#if errorMsg}
            <p class="sl-error">{errorMsg}</p>
          {/if}
          <div class="sl-actions">
            <button class="btn btn-secondary" on:click={() => phase = 'input'}>Back</button>
            <button class="btn btn-primary" on:click={runSave} disabled={matched.length === 0}>
              <span class="material-symbols-rounded" style="font-size:18px">check</span>
              Add to workout
            </button>
          </div>
        </div>

      {:else if phase === 'saving'}
        <div class="sl-body sl-center">
          <span class="material-symbols-rounded sl-spin">autorenew</span>
          <p class="sl-center-msg">Saving…</p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sl-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
    display: flex; align-items: flex-end; justify-content: center;
  }
  .sl-sheet {
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 640px;
    max-height: 90vh; overflow-y: auto;
    padding-bottom: calc(var(--safe-bottom) + 12px);
  }
  .sl-handle {
    width: 36px; height: 4px; background: var(--border); border-radius: 2px;
    margin: 10px auto 4px;
  }
  .sl-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 20px 8px;
    position: sticky; top: 0; background: var(--surface-1); z-index: 1;
  }
  .sl-header-icon { font-size: 22px; color: var(--accent); }
  .sl-title { flex: 1; font-size: 18px; font-weight: 800; color: var(--text-1); margin: 0; }
  .sl-close {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
  }
  .sl-close:hover { color: var(--text-1); background: var(--surface-2); }

  .sl-body { padding: 4px 20px 20px; }
  .sl-desc { font-size: 13px; color: var(--text-3); margin: 0 0 12px; }
  .sl-error {
    color: var(--danger); font-size: 13px; margin: 10px 0;
    padding: 10px 12px; background: rgba(255,92,92,0.08);
    border-radius: var(--radius-md);
  }

  .sl-input-wrap { position: relative; }
  .sl-input {
    width: 100%; padding: 12px 14px; padding-right: 52px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); color: var(--text-1); font-size: 15px;
    font-family: inherit; resize: vertical; outline: none;
    transition: border-color var(--dur-fast);
  }
  .sl-input:focus { border-color: var(--accent); }
  .sl-mic {
    position: absolute; bottom: 10px; right: 10px;
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-dim); border: 1px solid var(--accent);
    color: var(--accent); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all var(--dur-fast);
  }
  .sl-mic:hover { background: var(--accent); color: var(--accent-text); }
  .sl-mic.listening {
    background: var(--danger); border-color: var(--danger); color: #fff;
    animation: sl-pulse 1.2s ease-in-out infinite;
  }
  @keyframes sl-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.08)} }
  .sl-mic .material-symbols-rounded { font-size: 20px; }

  .sl-actions {
    display: flex; gap: 8px; margin-top: 14px;
  }
  .sl-actions .btn { flex: 1; height: 44px; }
  .sl-actions .btn-primary { display: flex; align-items: center; justify-content: center; gap: 6px; }

  .sl-center { text-align: center; padding: 48px 20px; }
  .sl-spin { font-size: 48px; color: var(--accent); animation: sl-rot 0.8s linear infinite; display: inline-block; }
  @keyframes sl-rot { to { transform: rotate(360deg); } }
  .sl-center-msg { font-size: 14px; color: var(--text-2); margin: 12px 0 0; }

  .sl-review { display: flex; flex-direction: column; gap: 10px; }
  .sl-item {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 12px;
  }
  .sl-item.unmatched { border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); }
  .sl-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .sl-item-name { flex: 1; font-size: 15px; font-weight: 700; color: var(--text-1); min-width: 0; }
  .sl-item-name.sl-unmatched { color: var(--warning); font-style: italic; }
  .sl-unmatched-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    background: color-mix(in srgb, var(--warning) 20%, transparent);
    color: var(--warning); padding: 2px 6px; border-radius: var(--radius-sm);
  }
  .sl-ss-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--accent-dim); color: var(--accent);
    padding: 2px 6px; border-radius: var(--radius-sm);
  }
  .sl-item-remove {
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
  }
  .sl-item-remove:hover { color: var(--danger); }
  .sl-item-remove .material-symbols-rounded { font-size: 18px; }

  .sl-candidates {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    margin: 4px 0 10px;
  }
  .sl-candidates-label { font-size: 11px; color: var(--text-3); font-weight: 600; text-transform: uppercase; }
  .sl-chip {
    font-size: 12px; padding: 4px 10px; border-radius: var(--radius-full);
    background: var(--surface-3, var(--surface-1)); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    transition: all var(--dur-fast);
  }
  .sl-chip:hover { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .sl-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 700; }

  .sl-sets-list { display: flex; flex-direction: column; gap: 4px; }
  .sl-set-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 0;
  }
  .sl-set-idx { font-size: 11px; color: var(--text-3); width: 22px; font-weight: 700; }
  .sl-set-input {
    width: 72px; padding: 6px 8px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-1);
    font-size: 13px; font-family: inherit; text-align: center;
    font-variant-numeric: tabular-nums; outline: none;
  }
  .sl-set-input:focus { border-color: var(--accent); }
  .sl-set-unit { font-size: 11px; color: var(--text-3); }
  .sl-set-x { font-size: 13px; color: var(--text-3); }
  .sl-tag {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    background: var(--surface-3, var(--surface-1)); color: var(--text-3);
    padding: 2px 5px; border-radius: var(--radius-sm);
  }
  .sl-set-remove {
    margin-left: auto;
    background: none; border: none; cursor: pointer; color: var(--text-3);
    padding: 2px; display: flex; align-items: center;
  }
  .sl-set-remove:hover { color: var(--danger); }
  .sl-add-set {
    display: flex; align-items: center; gap: 4px;
    background: none; border: 1px dashed var(--border); cursor: pointer;
    color: var(--text-3); padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px; font-family: inherit;
    align-self: flex-start; margin-top: 4px;
  }
  .sl-add-set:hover { color: var(--accent); border-color: var(--accent); }
</style>
