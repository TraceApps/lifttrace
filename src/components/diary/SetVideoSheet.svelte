<script>
  /**
   * SetVideoSheet.svelte: film a set, or pick a clip you already have, and
   * attach it to one set (issue #57).
   *
   * Filming happens here rather than in the camera app for one practical
   * reason: recording through MediaRecorder lets us ask for a modest bitrate,
   * so a set lands around 10 to 20 MB instead of the 150 MB a phone camera
   * produces at default settings. That is the whole size story. Nothing is
   * re-encoded on the server, and a clip picked from the camera roll is
   * uploaded as it is, which is why the 200 MB ceiling still exists and says
   * so plainly when it is hit.
   *
   * The flow is three steps and never more: choose the set, get a clip
   * (record or pick), then confirm it. Recording shows a live preview with a
   * countdown, because filming blind and hoping is how you end up with a clip
   * of the ceiling.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { LtApi } from '../../lib/api.js';
  import { showError } from '../../stores/toast.js';

  export let open = false;
  export let exercise = null;      // the exercise the clip belongs to
  export let workoutId = null;
  export let online = true;

  const dispatch = createEventDispatcher();
  const MAX_SECONDS = 60;
  const MAX_BYTES = 200 * 1024 * 1024;

  // 2.5 Mbps at 720p is plenty to see a bar path and a knee angle, and keeps
  // a minute under about 20 MB.
  const RECORD_BITRATE = 2_500_000;

  let stage = 'choose';            // choose | recording | review | uploading
  let setUuid = null;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let elapsed = 0;
  let tick = null;
  let clipBlob = null;
  let clipUrl = null;
  let previewEl;
  let progress = 0;
  let canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';

  $: sets = exercise?.sets || [];
  // Default to the set you are most likely filming: the first one not done.
  $: if (open && setUuid == null && sets.length) {
    setUuid = (sets.find(s => !s.completed) || sets[sets.length - 1])?.uuid ?? null;
  }
  $: sizeMb = clipBlob ? (clipBlob.size / 1024 / 1024).toFixed(1) : null;

  function reset() {
    stopStream();
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = null; clipBlob = null; chunks = []; elapsed = 0;
    progress = 0; stage = 'choose'; setUuid = null;
  }

  function close() {
    reset();
    open = false;
    dispatch('close');
  }

  function stopStream() {
    if (tick) { clearInterval(tick); tick = null; }
    try { recorder?.state === 'recording' && recorder.stop(); } catch {}
    recorder = null;
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
  }

  onDestroy(stopStream);

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch {
      showError($_('set_video.no_camera'));
      return;
    }
    stage = 'recording';
    await new Promise(r => setTimeout(r, 0));          // let the <video> mount
    if (previewEl) { previewEl.srcObject = stream; previewEl.play?.().catch(() => {}); }

    const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    chunks = [];
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: RECORD_BITRATE });
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clipBlob = new Blob(chunks, { type: chunks[0]?.type || mime || 'video/mp4' });
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      clipUrl = URL.createObjectURL(clipBlob);
      stopStream();
      stage = 'review';
    };
    recorder.start();
    elapsed = 0;
    tick = setInterval(() => {
      elapsed += 1;
      if (elapsed >= MAX_SECONDS) stopRecording();
    }, 1000);
  }

  function stopRecording() {
    if (tick) { clearInterval(tick); tick = null; }
    try { recorder?.stop(); } catch { stage = 'choose'; }
  }

  function pickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showError($_('set_video.too_large'));
      e.target.value = '';
      return;
    }
    clipBlob = file;
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = URL.createObjectURL(file);
    stage = 'review';
  }

  async function attach() {
    if (!clipBlob || !workoutId) return;
    stage = 'uploading';
    progress = 10;
    try {
      const ext = (clipBlob.type || '').includes('webm') ? 'webm' : 'mp4';
      const file = clipBlob instanceof File
        ? clipBlob
        : new File([clipBlob], `set-${Date.now()}.${ext}`, { type: clipBlob.type || 'video/mp4' });
      const up = await LtApi.uploadSetVideo(file);
      progress = 70;
      const row = await LtApi.attachSetVideo({
        workout_id: workoutId,
        exercise_uuid: exercise?.uuid,
        set_uuid: setUuid,
        url: up.url,
        mime: up.mimeType,
        size_bytes: up.sizeBytes ?? file.size,
        duration_sec: elapsed || null,
      });
      progress = 100;
      dispatch('attached', row);
      close();
    } catch (e) {
      stage = 'review';
      progress = 0;
      showError(e?.message || $_('set_video.upload_failed'));
    }
  }

  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
</script>

<Sheet bind:open title={$_('set_video.title')} height="auto" on:close={close}>
  <div class="sv">
    {#if !online}
      <p class="sv-offline">
        <span class="material-symbols-rounded">cloud_off</span>
        {$_('set_video.needs_connection')}
      </p>
    {:else}
      {#if sets.length > 1 && stage !== 'uploading'}
        <div class="sv-sets" role="radiogroup" aria-label={$_('set_video.which_set')}>
          <span class="sv-label">{$_('set_video.which_set')}</span>
          <div class="sv-chips">
            {#each sets as s, i (s.uuid || i)}
              <button type="button" class="sv-chip" class:on={setUuid === s.uuid}
                role="radio" aria-checked={setUuid === s.uuid}
                on:click={() => (setUuid = s.uuid)}>
                {i + 1}
                {#if s.completed}<span class="material-symbols-rounded tick">check</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if stage === 'choose'}
        <div class="sv-actions">
          {#if canRecord}
            <button type="button" class="sv-big" on:click={startRecording}>
              <span class="material-symbols-rounded">videocam</span>
              <span class="sv-big-label">{$_('set_video.record')}</span>
              <span class="sv-big-sub">{$_('set_video.record_hint', { values: { seconds: MAX_SECONDS } })}</span>
            </button>
          {/if}
          <label class="sv-big secondary">
            <span class="material-symbols-rounded">video_library</span>
            <span class="sv-big-label">{$_('set_video.choose')}</span>
            <span class="sv-big-sub">{$_('set_video.choose_hint')}</span>
            <input type="file" accept="video/*" on:change={pickFile} hidden />
          </label>
        </div>
      {:else if stage === 'recording'}
        <div class="sv-stage">
          <!-- svelte-ignore a11y-media-has-caption -->
          <video class="sv-video" bind:this={previewEl} muted playsinline autoplay></video>
          <div class="sv-rec-bar">
            <span class="sv-dot" aria-hidden="true"></span>
            <span class="sv-time">{clock(elapsed)}</span>
            <span class="sv-left">{$_('set_video.seconds_left', { values: { seconds: MAX_SECONDS - elapsed } })}</span>
          </div>
          <button type="button" class="sv-stop" on:click={stopRecording}>
            <span class="material-symbols-rounded">stop_circle</span>{$_('set_video.stop')}
          </button>
        </div>
      {:else if stage === 'review'}
        <div class="sv-stage">
          <!-- svelte-ignore a11y-media-has-caption -->
          <video class="sv-video" src={clipUrl} controls playsinline></video>
          <p class="sv-meta">
            {#if elapsed}{clock(elapsed)} · {/if}{sizeMb} MB
          </p>
          <div class="sv-confirm">
            <button type="button" class="btn-ghost" on:click={() => { stage = 'choose'; clipBlob = null; }}>
              {$_('set_video.retake')}
            </button>
            <button type="button" class="btn-primary" on:click={attach}>
              {$_('set_video.attach')}
            </button>
          </div>
        </div>
      {:else}
        <div class="sv-stage">
          <p class="sv-uploading">{$_('set_video.uploading')}</p>
          <div class="sv-progress"><div class="sv-progress-fill" style="width:{progress}%"></div></div>
        </div>
      {/if}
    {/if}
  </div>
</Sheet>

<style>
  .sv { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }
  .sv-offline {
    display: flex; align-items: center; gap: 10px; margin: 0;
    padding: 14px; border-radius: var(--radius-md);
    background: var(--surface-2); color: var(--text-2); font-size: 14px;
  }
  .sv-label { font-size: 12px; color: var(--text-3); }
  .sv-sets { display: flex; flex-direction: column; gap: 8px; }
  .sv-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .sv-chip {
    min-width: 44px; height: 40px; padding: 0 12px;
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    border-radius: var(--radius-md); border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-1); font-size: 15px; font-weight: 600;
  }
  .sv-chip.on { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
  .sv-chip .tick { font-size: 14px; opacity: 0.7; }

  .sv-actions { display: flex; flex-direction: column; gap: 10px; }
  .sv-big {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 18px; border-radius: var(--radius-lg);
    border: 1px solid var(--accent); background: var(--accent-dim); color: var(--text-1);
    cursor: pointer;
  }
  .sv-big.secondary { border-color: var(--border); background: var(--surface-2); }
  .sv-big .material-symbols-rounded { font-size: 28px; color: var(--accent); }
  .sv-big-label { font-size: 16px; font-weight: 600; }
  .sv-big-sub { font-size: 12px; color: var(--text-3); }

  .sv-stage { display: flex; flex-direction: column; gap: 12px; }
  .sv-video {
    width: 100%; max-height: 46vh; border-radius: var(--radius-md);
    background: #000; display: block;
  }
  .sv-rec-bar { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .sv-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: rec 1s infinite alternate; }
  @keyframes rec { to { opacity: 0.25; } }
  .sv-time { font-variant-numeric: tabular-nums; font-weight: 700; }
  .sv-left { margin-left: auto; color: var(--text-3); font-size: 12px; }
  .sv-stop {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 14px; border-radius: var(--radius-md);
    background: var(--danger); color: #fff; font-size: 16px; font-weight: 600;
  }
  .sv-meta { margin: 0; font-size: 12px; color: var(--text-3); text-align: center; }
  .sv-confirm { display: flex; gap: 10px; }
  .sv-confirm button { flex: 1; padding: 14px; border-radius: var(--radius-md); font-size: 15px; font-weight: 600; }
  .sv-uploading { margin: 0; text-align: center; color: var(--text-2); font-size: 14px; }
  .sv-progress { height: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
  .sv-progress-fill { height: 100%; background: var(--accent); transition: width 240ms ease; }
</style>
