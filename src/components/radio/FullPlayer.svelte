<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { portal } from '../../lib/portal.js';
  import {
    currentTrack, isPlaying, progress, currentTime, duration,
    volume, shuffle, repeat, queue, queueIndex, showQueue, isBuffering,
    togglePlay, next, prev, seek, setVolume, toggleShuffle, cycleRepeat,
    removeFromQueue, playTrack, stop, streamNowPlaying, streamArtwork,
  } from '../../stores/player.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  export let open = false;

  // Per-song artwork (iHeart amgArtworkURL) takes precedence over the
  // station icon for the full-player hero image. resolveAssetUrl handles
  // the native+server case where the URL is /api/subsonic/... (needs the
  // server origin + auth-query token because <img> can't carry headers).
  $: coverSrc = resolveAssetUrl($streamArtwork || $currentTrack?.coverUrl || '');

  // Cover-art-derived gradient background. Modern music apps (Spotify,
  // Apple Music) tint the full-player backdrop with the dominant color of
  // the album art so the screen visually inherits the track's vibe.
  // Implementation: load the image into a hidden canvas, sample a 32x32
  // downscale, average colors with brightness biased to mid-tones so dark
  // art doesn't produce muddy gradients. Cached per src so re-opening
  // doesn't reprocess.
  let backdropColor = '';
  const _bgCache = (typeof window !== 'undefined' && (window.__LT_BG_CACHE ||= {})) || {};
  async function _extractColor(src) {
    if (!src) { backdropColor = ''; return; }
    if (_bgCache[src]) { backdropColor = _bgCache[src]; return; }
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const loaded = new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject();
      });
      img.src = src;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      // Weighted average — skip near-black + near-white pixels so the
      // gradient picks up the actual character of the art rather than
      // background paper or vignette borders.
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const bright = (R + G + B) / 3;
        if (bright < 20 || bright > 235) continue;
        r += R; g += G; b += B; n++;
      }
      if (n > 0) {
        backdropColor = `rgb(${Math.round(r/n)}, ${Math.round(g/n)}, ${Math.round(b/n)})`;
        _bgCache[src] = backdropColor;
      }
    } catch { /* cross-origin block or load fail — leave default */ }
  }
  $: if (open && coverSrc) _extractColor(coverSrc); else if (!open) backdropColor = '';

  function fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function onSeek(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(fraction);
  }

  function onVolume(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setVolume(v);
  }

  $: repeatIcon = $repeat === 'one' ? 'repeat_one' : 'repeat';
  $: repeatActive = $repeat !== 'off';
</script>

{#if open}
  <div use:portal>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="fp-backdrop" on:click={() => open = false}
      transition:fly={{ y: 0, duration: 200 }}></div>
    <div class="fp-panel" transition:fly={{ y: 600, duration: 320, easing: cubicOut }}
         style:--fp-tint={backdropColor || 'transparent'}>
      <!-- Cover-art-derived gradient backdrop. Sits behind everything;
           fades in once the dominant color is extracted. -->
      {#if backdropColor}
        <div class="fp-tint" aria-hidden="true"></div>
      {/if}
      <div class="fp-handle"></div>

      <!-- Album art with playing-state pulse — same accent glow as the
           mini player but bigger. Scales smoothly when expanded from the
           mini player thanks to the panel fly + the wrap's own transform
           transition. -->
      <div class="fp-art-wrap" class:playing={$isPlaying && !$isBuffering}>
        {#if coverSrc}
          <img class="fp-art" src={coverSrc} alt="" on:error={() => coverSrc = resolveAssetUrl($currentTrack?.coverUrl || '')} />
        {:else}
          <div class="fp-art fp-art-placeholder">
            <span class="material-symbols-rounded" style="font-size:64px;color:var(--text-3)">music_note</span>
          </div>
        {/if}
        {#if $isBuffering}
          <div class="fp-loading">
            <span class="material-symbols-rounded fp-loading-icon">progress_activity</span>
            <span class="fp-loading-text">Loading…</span>
          </div>
        {/if}
      </div>

      <!-- Track info -->
      <div class="fp-info">
        <div class="fp-title">{$currentTrack?.title || 'No track'}</div>
        <div class="fp-artist">{$streamNowPlaying ? `♪ ${$streamNowPlaying}` : ($currentTrack?.artist || '')}</div>
      </div>

      <!-- Progress -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="fp-progress-wrap" on:click={onSeek}>
        <div class="fp-progress-track">
          <div class="fp-progress-fill" style="width:{$progress * 100}%"></div>
        </div>
        <div class="fp-times">
          <span>{fmtTime($currentTime)}</span>
          <span>{fmtTime($duration)}</span>
        </div>
      </div>

      <!-- Controls -->
      <div class="fp-controls">
        <button class="fp-ctrl" class:active={$shuffle} on:click={toggleShuffle}>
          <span class="material-symbols-rounded">shuffle</span>
        </button>
        <button class="fp-ctrl" on:click={prev}>
          <span class="material-symbols-rounded" style="font-size:32px">skip_previous</span>
        </button>
        <button class="fp-play" on:click={togglePlay}>
          <span class="material-symbols-rounded">{$isPlaying ? 'pause' : 'play_arrow'}</span>
        </button>
        <button class="fp-ctrl" on:click={next}>
          <span class="material-symbols-rounded" style="font-size:32px">skip_next</span>
        </button>
        <button class="fp-ctrl" class:active={repeatActive} on:click={cycleRepeat}>
          <span class="material-symbols-rounded">{repeatIcon}</span>
        </button>
      </div>

      <!-- Volume -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="fp-volume" on:click={onVolume}>
        <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">volume_up</span>
        <div class="fp-vol-track">
          <div class="fp-vol-fill" style="width:{$volume * 100}%"></div>
        </div>
      </div>

      <!-- Queue toggle -->
      {#if $queue.length > 1}
        <button class="fp-queue-toggle" on:click={() => $showQueue = !$showQueue}>
          <span class="material-symbols-rounded" style="font-size:18px">queue_music</span>
          Queue · {$queueIndex + 1} of {$queue.length}
          <span class="material-symbols-rounded" style="font-size:16px">{$showQueue ? 'expand_less' : 'expand_more'}</span>
        </button>
      {/if}

      <!-- Queue list -->
      {#if $showQueue && $queue.length > 0}
        <div class="fp-queue-list">
          {#each $queue as track, i (track.id + '-' + i)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="fp-queue-row" class:fp-queue-active={i === $queueIndex}
              on:click={() => { queueIndex.set(i); playTrack(track); }} role="button" tabindex="0">
              <span class="fp-queue-play">
                {#if i === $queueIndex}
                  <span class="material-symbols-rounded" style="font-size:16px;color:var(--accent)">equalizer</span>
                {:else}
                  <span class="fp-queue-num">{i + 1}</span>
                {/if}
              </span>
              <div class="fp-queue-info">
                <span class="fp-queue-title">{track.title}</span>
                <span class="fp-queue-artist">{track.artist}</span>
              </div>
              <button class="fp-queue-remove" on:click|stopPropagation={() => removeFromQueue(i)} title="Remove">
                <span class="material-symbols-rounded" style="font-size:18px">close</span>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .fp-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 500;
  }
  .fp-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: var(--surface-1);
    border-radius: 20px 20px 0 0;
    z-index: 510;
    padding: 0 24px calc(var(--safe-bottom, 0px) + 24px);
    max-height: 92vh;
    overflow-y: auto;
    display: flex; flex-direction: column; align-items: center;
    isolation: isolate;
  }
  /* Cover-art-derived tint overlay — sits behind every panel child as a
     radial gradient fading from the extracted color into transparent
     (the panel's surface-1 shows through). 800ms fade-in keeps the
     transition from being jarring when the panel opens. */
  .fp-tint {
    position: absolute;
    inset: 0;
    background: radial-gradient(120% 60% at 50% 0%, var(--fp-tint) 0%, transparent 65%);
    opacity: 0.4;
    z-index: -1;
    pointer-events: none;
    animation: fp-tint-fade 0.8s ease-out;
  }
  @keyframes fp-tint-fade {
    from { opacity: 0; }
    to   { opacity: 0.4; }
  }
  @media (min-width: 769px) {
    .fp-panel {
      left: 50%; right: auto;
      transform: translateX(-50%);
      width: 420px;
      border-radius: 20px;
      bottom: 40px;
      max-height: 80vh;
    }
  }
  .fp-handle {
    width: 40px; height: 4px;
    border-radius: 2px;
    background: var(--text-3); opacity: 0.4;
    margin: 10px auto 20px;
  }
  @media (min-width: 769px) { .fp-handle { display: none; }
    .fp-art-wrap { margin-top: 24px; }
  }

  .fp-art-wrap {
    position: relative;
    width: min(280px, 70vw);
    height: min(280px, 70vw);
    border-radius: var(--radius-xl);
    overflow: hidden;
    background: var(--surface-2);
    margin-bottom: 24px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.4);
    flex-shrink: 0;
    /* Soft scale-in so the panel opening feels like the art is "growing"
       up from the mini player position. Combined with the panel's own
       y: 600 fly, the eye reads it as a unified expansion. */
    animation: fp-art-grow 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: box-shadow 0.6s ease;
  }
  @keyframes fp-art-grow {
    0%   { transform: scale(0.5); opacity: 0.4; }
    100% { transform: scale(1);   opacity: 1; }
  }
  /* Playing pulse — same accent glow concept as the mini-art but bigger,
     longer cycle. Removed when paused. */
  .fp-art-wrap.playing {
    box-shadow: 0 8px 40px rgba(0,0,0,0.4),
                0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent);
    animation: fp-art-grow 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
               fp-art-pulse 3s ease-in-out 0.4s infinite;
  }
  @keyframes fp-art-pulse {
    0%, 100% { box-shadow: 0 8px 40px rgba(0,0,0,0.4),
                           0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent); }
    50%      { box-shadow: 0 8px 40px rgba(0,0,0,0.4),
                           0 0 30px 6px color-mix(in srgb, var(--accent) 30%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fp-art-wrap { animation: none; }
    .fp-art-wrap.playing { animation: none; }
  }
  .fp-loading {
    position: absolute; inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px;
  }
  .fp-loading-icon {
    font-size: 48px; color: var(--accent);
    animation: fp-spin 1s linear infinite;
  }
  .fp-loading-text {
    font-size: 12px; color: rgba(255,255,255,0.85);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  @keyframes fp-spin { to { transform: rotate(360deg); } }
  .fp-art { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fp-art-placeholder {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%;
  }

  .fp-info { text-align: center; margin-bottom: 20px; width: 100%; }
  .fp-title {
    font-size: 18px; font-weight: 700; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .fp-artist { font-size: 14px; color: var(--text-3); margin-top: 4px; }

  .fp-progress-wrap { width: 100%; margin-bottom: 16px; cursor: pointer; }
  .fp-progress-track {
    height: 4px; border-radius: 2px;
    background: var(--surface-3); overflow: hidden;
  }
  .fp-progress-fill {
    height: 100%; border-radius: 2px;
    background: var(--accent);
    transition: width 0.3s linear;
  }
  .fp-times {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--text-3); margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }

  .fp-controls {
    display: flex; align-items: center; justify-content: center;
    gap: 16px; margin-bottom: 20px; width: 100%;
  }
  .fp-ctrl {
    width: 44px; height: 44px; border-radius: 50%;
    background: none; border: none;
    color: var(--text-2); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .fp-ctrl:hover { color: var(--text-1); }
  .fp-ctrl.active { color: var(--accent); }
  .fp-play {
    width: 64px; height: 64px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: var(--accent-text, #fff);
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  }
  .fp-play .material-symbols-rounded { font-size: 36px; }
  .fp-play:hover { transform: scale(1.05); }
  .fp-play:active { transform: scale(0.95); }

  .fp-volume {
    display: flex; align-items: center; gap: 8px;
    width: 100%; max-width: 200px;
    margin-bottom: 16px; cursor: pointer;
  }
  .fp-vol-track {
    flex: 1; height: 4px; border-radius: 2px;
    background: var(--surface-3); overflow: hidden;
  }
  .fp-vol-fill {
    height: 100%; border-radius: 2px;
    background: var(--accent);
    transition: width 0.1s;
  }

  .fp-queue-toggle {
    display: flex; align-items: center; gap: 6px;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); font-size: 13px; font-weight: 600;
    padding: 8px 0;
  }
  .fp-queue-toggle:hover { color: var(--text-1); }

  .fp-queue-list { width: 100%; max-height: 240px; overflow-y: auto; }
  .fp-queue-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 4px;
    width: 100%;
    border: none; border-bottom: 1px solid var(--border);
    background: none; cursor: pointer; text-align: left;
    color: inherit; font: inherit;
    transition: background var(--dur-fast);
  }
  .fp-queue-row:hover { background: var(--surface-2); }
  .fp-queue-row.fp-queue-active { background: var(--accent-dim); border-radius: var(--radius-sm); }
  .fp-queue-play {
    width: 28px; display: flex; align-items: center; justify-content: center;
    color: var(--text-3); flex-shrink: 0;
  }
  .fp-queue-num { font-size: 12px; font-variant-numeric: tabular-nums; }
  .fp-queue-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .fp-queue-title { font-size: 13px; font-weight: 500; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fp-queue-artist { font-size: 11px; color: var(--text-3); }
  .fp-queue-remove {
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
    display: flex; border-radius: var(--radius-sm);
  }
  .fp-queue-remove:hover { color: var(--danger); }
</style>
