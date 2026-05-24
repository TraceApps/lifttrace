<script>
  import { LtApi } from '../../lib/api.js';
  import { showError } from '../../stores/toast.js';

  // Three separate URL columns on the exercises table. Bound two-way so
  // parent can read/write without additional plumbing.
  export let img_url   = '';
  export let gif_url   = '';
  export let video_url = '';

  let fileInput;
  let uploading = false;
  let urlInput = '';

  // ── Derived preview state ────────────────────────────────────────────────
  $: previewUrl   = video_url || gif_url || img_url;
  $: previewKind  = video_url ? 'video' : (gif_url ? 'gif' : (img_url ? 'img' : ''));
  $: youtubeId    = video_url ? _extractYouTubeId(video_url) : '';

  function _extractYouTubeId(url) {
    if (!url) return '';
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([^&?/\s]{11})/i);
    return m ? m[1] : '';
  }

  function _clearAll() {
    img_url = ''; gif_url = ''; video_url = '';
  }

  // Set exactly one of the three URL columns, clearing the others.
  function _setSingle(kind, url) {
    _clearAll();
    if (kind === 'video') video_url = url;
    else if (kind === 'gif') gif_url = url;
    else img_url = url;
  }

  async function handleFile(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    uploading = true;
    try {
      const res = await LtApi.uploadExerciseMedia(file);
      _setSingle(res.kind, res.url);
    } catch(err) { showError(err.message); }
    uploading = false;
    e.target.value = '';
  }

  function applyUrl() {
    const url = urlInput.trim();
    if (!url) return;
    // YouTube → video, .gif → gif, .mp4/.webm → video, anything else → img
    if (_extractYouTubeId(url) || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) _setSingle('video', url);
    else if (/\.gif(\?|$)/i.test(url)) _setSingle('gif', url);
    else _setSingle('img', url);
    urlInput = '';
  }

  function onUrlKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); applyUrl(); }
  }
</script>

<div class="media-input">
  {#if previewUrl}
    <div class="preview">
      {#if youtubeId}
        <div class="preview-frame">
          <iframe
            src={`https://www.youtube.com/embed/${youtubeId}`}
            title="YouTube preview"
            frameborder="0"
            allowfullscreen
          ></iframe>
        </div>
      {:else if previewKind === 'video'}
        <video class="preview-frame" src={previewUrl} controls preload="metadata"></video>
      {:else}
        <img class="preview-frame" src={previewUrl} alt="Exercise media preview" />
      {/if}
      <button type="button" class="clear-btn" on:click={_clearAll} aria-label="Remove media">
        <span class="material-symbols-rounded">close</span>
      </button>
      <span class="kind-pill">{previewKind.toUpperCase()}</span>
    </div>
  {/if}

  <div class="controls">
    <input bind:this={fileInput} type="file" accept="image/*,video/*" style="display:none" on:change={handleFile} />
    <button type="button" class="ctrl-btn" on:click={() => fileInput.click()} disabled={uploading}>
      <span class="material-symbols-rounded">{uploading ? 'progress_activity' : 'upload'}</span>
      {uploading ? 'Uploading…' : 'Upload'}
    </button>
    <div class="or-divider">or</div>
    <div class="url-row">
      <input
        class="url-input"
        type="url"
        placeholder="Paste image, GIF, or YouTube URL"
        bind:value={urlInput}
        on:keydown={onUrlKey}
      />
      <button type="button" class="apply-btn" on:click={applyUrl} disabled={!urlInput.trim()}>
        <span class="material-symbols-rounded">check</span>
      </button>
    </div>
  </div>
  <p class="media-hint">Images (JPG/PNG), GIFs, videos (MP4/WebM, up to 100 MB), or YouTube links. Only one media per exercise.</p>
</div>

<style>
  .media-input { display: flex; flex-direction: column; gap: 10px; }

  .preview {
    position: relative;
    width: 100%;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .preview-frame {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: contain;
    background: #000;
  }
  iframe.preview-frame { aspect-ratio: 16 / 9; }
  .clear-btn {
    position: absolute; top: 8px; right: 8px;
    width: 28px; height: 28px; border-radius: 50%;
    background: rgba(0,0,0,0.6); color: #fff;
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .clear-btn:hover { background: rgba(0,0,0,0.85); }
  .clear-btn .material-symbols-rounded { font-size: 18px; }
  .kind-pill {
    position: absolute; top: 8px; left: 8px;
    padding: 2px 8px; border-radius: var(--radius-full);
    background: var(--accent); color: var(--accent-text, #fff);
    font-size: 10px; font-weight: 800; letter-spacing: 0.05em;
  }

  .controls {
    display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap;
  }
  .ctrl-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .ctrl-btn:hover:not(:disabled) { background: var(--surface-3); }
  .ctrl-btn:disabled { opacity: 0.5; cursor: default; }
  .ctrl-btn .material-symbols-rounded { font-size: 17px; }

  .or-divider {
    font-size: 11px; color: var(--text-3); text-transform: uppercase;
    letter-spacing: 0.08em; padding: 0 2px;
  }

  .url-row { flex: 1; min-width: 200px; display: flex; gap: 6px; }
  .url-input {
    flex: 1; min-width: 0;
    padding: 8px 12px; border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    font-size: 13px; font-family: inherit;
    outline: none;
  }
  .url-input:focus { border-color: var(--accent); }
  .apply-btn {
    width: 36px; height: 36px; border-radius: var(--radius-md);
    background: var(--accent);
    color: var(--accent-text, #fff);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .apply-btn:disabled { opacity: 0.4; cursor: default; }
  .apply-btn .material-symbols-rounded { font-size: 18px; }

  .media-hint {
    margin: 0; font-size: 11px; color: var(--text-3); line-height: 1.4;
  }
</style>
