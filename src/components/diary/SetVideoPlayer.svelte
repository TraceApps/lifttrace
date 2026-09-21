<script>
  /**
   * SetVideoPlayer.svelte: watch a set back, read what the coach said about
   * it, and jump to the moment they meant (issue #57).
   *
   * The note carries a timestamp, so it renders as a chip you can tap:
   * seeking is one line either way, and it is the difference between "your
   * knee caves" and "your knee caves, here".
   *
   * Two ways to get the bytes, because the two platforms differ:
   *   - Browser: point <video> straight at the route. The cookie goes with
   *     the request, the server answers byte ranges, so seeking streams
   *     rather than downloading the whole clip first.
   *   - Android: the WebView cannot put a bearer token on a <video> request,
   *     so fetch it once with auth and play from an object URL. Heavier, but
   *     a clip is capped at 200 MB and an in-app recording is far smaller.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { isNative } from '../../lib/platform.js';
  import { LtApi } from '../../lib/api.js';
  import { showError } from '../../stores/toast.js';

  export let open = false;
  export let media = null;         // row from /api/set-media
  export let canDelete = true;
  /** "Bench Press, set 2", so a clip opened from a collapsed card has context. */
  export let subtitle = '';
  /**
   * Coach mode: the same player, plus a composer that stamps the note with
   * wherever the video is paused. One component rather than two, so the
   * member and the coach are always looking at the same thing.
   */
  export let coach = false;
  export let workoutId = null;
  export let exerciseIdx = null;
  export let exerciseUuid = null;

  const dispatch = createEventDispatcher();

  let videoEl;
  let objectUrl = null;
  let loading = false;
  let replyText = '';
  let sending = false;

  $: note = media?.note || null;
  $: src = media ? (isNative ? objectUrl : media.file_url) : null;

  // On Android the bytes need an authenticated fetch before they can play.
  $: if (open && media && isNative && !objectUrl && !loading) loadNative();

  async function loadNative() {
    loading = true;
    try {
      const res = await fetch(media.file_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      objectUrl = URL.createObjectURL(await res.blob());
    } catch (e) {
      showError($_('set_video.playback_failed'));
    } finally {
      loading = false;
    }
  }

  function seekTo(seconds) {
    if (!videoEl || !Number.isFinite(seconds)) return;
    videoEl.currentTime = Math.max(0, seconds);
    videoEl.play?.().catch(() => {});
  }

  async function remove() {
    if (!media) return;
    try {
      await LtApi.deleteSetVideo(media.id);
      dispatch('deleted', { id: media.id });
      close();
    } catch (e) {
      showError(e?.message || $_('set_video.delete_failed'));
    }
  }

  async function sendReply() {
    if (!note?.id || !replyText.trim() || sending) return;
    sending = true;
    try {
      await LtApi.replyToCoachFeedback(note.id, replyText.trim());
      note.member_reply = replyText.trim();
      replyText = '';
      dispatch('replied');
    } catch (e) {
      showError(e?.message || $_('set_video.reply_failed'));
    } finally {
      sending = false;
    }
  }

  function close() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    open = false;
    dispatch('close');
  }

  onDestroy(() => { if (objectUrl) URL.revokeObjectURL(objectUrl); });

  // What the coach is about to stamp the note with: wherever they paused.
  let noteText = '';
  let noteAt = 0;
  let savingNote = false;

  $: if (open && coach && note?.body && !noteText) {
    noteText = note.body;
    noteAt = note.time_sec ?? 0;
  }

  function markHere() {
    noteAt = videoEl?.currentTime ?? 0;
  }

  async function saveCoachNote() {
    if (!noteText.trim() || savingNote) return;
    savingNote = true;
    try {
      await LtApi.saveCoachFeedback({
        workout_id: workoutId,
        exercise_idx: exerciseIdx,
        exercise_uuid: exerciseUuid,
        note: noteText.trim(),
        media_id: media?.id ?? null,
        media_time_sec: noteAt,
      });
      dispatch('noted', { media_id: media?.id, note: noteText.trim(), time_sec: noteAt });
      close();
    } catch (e) {
      showError(e?.message || $_('set_video.note_failed'));
    } finally {
      savingNote = false;
    }
  }

  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
</script>

<Sheet bind:open title={$_('set_video.player_title')} height="auto" on:close={close}>
  <div class="vp">
    {#if subtitle}<p class="vp-sub">{subtitle}</p>{/if}
    {#if loading}
      <div class="vp-loading">{$_('set_video.loading')}</div>
    {:else if src}
      <!-- svelte-ignore a11y-media-has-caption -->
      <video class="vp-video" bind:this={videoEl} {src} controls playsinline preload="metadata"></video>
    {/if}

    <!-- The member reads the note and answers it; the coach writes it below
         and only needs to see whether it was answered. -->
    {#if note && !coach}
      <div class="vp-note">
        <div class="vp-note-head">
          <span class="material-symbols-rounded">sports</span>
          <span class="vp-note-who">{note.author || $_('set_video.your_coach')}</span>
          {#if note.time_sec != null}
            <button type="button" class="vp-stamp" on:click={() => seekTo(note.time_sec)}
              title={$_('set_video.jump_to', { values: { time: clock(note.time_sec) } })}>
              <span class="material-symbols-rounded">play_arrow</span>{clock(note.time_sec)}
            </button>
          {/if}
        </div>
        <p class="vp-note-body">{note.body}</p>

        {#if note.member_reply}
          <p class="vp-reply"><span class="vp-reply-tag">{$_('set_video.your_reply')}</span>{note.member_reply}</p>
        {:else}
          <div class="vp-reply-box">
            <input class="input" type="text" bind:value={replyText}
              placeholder={$_('set_video.reply_placeholder')}
              on:keydown={(e) => e.key === 'Enter' && sendReply()} />
            <button type="button" class="vp-send" disabled={!replyText.trim() || sending} on:click={sendReply}>
              {$_('set_video.send')}
            </button>
          </div>
        {/if}
      </div>
    {:else if note?.member_reply && coach}
      <p class="vp-reply"><span class="vp-reply-tag">{$_('set_video.their_reply')}</span>{note.member_reply}</p>
    {:else if !coach}
      <p class="vp-nonote">{$_('set_video.no_note')}</p>
    {/if}

    {#if coach}
      <div class="vp-compose">
        <div class="vp-compose-head">
          <span class="vp-compose-label">{$_('set_video.note_at')}</span>
          <button type="button" class="vp-stamp" on:click={markHere}
            title={$_('set_video.mark_here')}>
            <span class="material-symbols-rounded">my_location</span>{clock(noteAt)}
          </button>
        </div>
        <textarea class="input" rows="2" bind:value={noteText}
          placeholder={$_('set_video.note_placeholder')}></textarea>
        <button type="button" class="vp-send wide" disabled={!noteText.trim() || savingNote}
          on:click={saveCoachNote}>
          {savingNote ? $_('common.saving') : $_('set_video.save_note')}
        </button>
      </div>
    {/if}

    {#if canDelete}
      <button type="button" class="vp-delete" on:click={remove}>
        <span class="material-symbols-rounded">delete</span>{$_('set_video.delete')}
      </button>
    {/if}
  </div>
</Sheet>

<style>
  .vp { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .vp-sub { margin: 0; font-size: 13px; color: var(--text-3); }
  .vp-video { width: 100%; max-height: 52vh; border-radius: var(--radius-md); background: #000; display: block; }
  .vp-loading { padding: 40px; text-align: center; color: var(--text-3); font-size: 14px; }

  .vp-note {
    padding: 14px; border-radius: var(--radius-md);
    background: var(--surface-2); border: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .vp-note-head { display: flex; align-items: center; gap: 8px; }
  .vp-note-head .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .vp-note-who { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .vp-stamp {
    margin-left: auto; display: inline-flex; align-items: center; gap: 2px;
    padding: 4px 10px 4px 6px; border-radius: 999px;
    background: var(--accent-dim); color: var(--accent);
    font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .vp-stamp .material-symbols-rounded { font-size: 16px; color: inherit; }
  .vp-note-body { margin: 0; font-size: 15px; line-height: 1.45; color: var(--text-1); }
  .vp-reply { margin: 0; font-size: 14px; color: var(--text-2); }
  .vp-reply-tag { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
  /* The send button sizes to its label and the field takes the rest, so a
     longer word in another language cannot squeeze it off the edge. */
  .vp-reply-box { display: flex; gap: 8px; align-items: stretch; }
  .vp-reply-box .input { flex: 1 1 auto; min-width: 0; }
  .vp-send {
    flex: 0 0 auto; padding: 0 16px;
    border-radius: var(--radius-md);
    background: var(--accent); color: var(--accent-text);
    font-size: 14px; font-weight: 600; white-space: nowrap;
  }
  .vp-send:disabled { opacity: 0.45; }
  .vp-nonote { margin: 0; text-align: center; font-size: 13px; color: var(--text-3); }

  .vp-compose { display: flex; flex-direction: column; gap: 8px; }
  .vp-compose-head { display: flex; align-items: center; gap: 8px; }
  .vp-compose-label { font-size: 12px; color: var(--text-3); }
  .vp-compose .vp-stamp { margin-left: 0; }
  .vp-send.wide { width: 100%; padding: 12px 16px; }

  .vp-delete {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 12px; border-radius: var(--radius-md);
    background: transparent; color: var(--danger); font-size: 14px; font-weight: 600;
  }
  .vp-delete .material-symbols-rounded { font-size: 18px; }
</style>
