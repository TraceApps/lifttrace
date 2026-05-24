<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { currentTrack, isPlaying, progress, volume, miniPlayerVisible, isBuffering, togglePlay, next, prev, stop, setVolume, streamNowPlaying, streamArtwork } from '../../stores/player.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  // Per-song artwork (iHeart amgArtworkURL) takes precedence over the
  // station icon for radio streams. Empty string → fall back to coverUrl.
  // resolveAssetUrl wraps the URL so on native+server it picks up the
  // image cache, the /api/proxy for external URLs, and the auth-query
  // token needed for our own /api/subsonic getCoverArt endpoint —
  // <img> can't carry Authorization headers.
  $: coverSrc = resolveAssetUrl($streamArtwork || $currentTrack?.coverUrl || '');
</script>

{#if $miniPlayerVisible && $currentTrack}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="mini-player" transition:fly={{ y: 60, duration: 260, easing: cubicOut }}
    on:click={() => dispatch('expand')}>
    <div class="mini-progress" style="width:{$progress * 100}%"></div>
    <div class="mini-art" class:playing={$isPlaying && !$isBuffering}>
      {#if coverSrc}
        <img src={coverSrc} alt="" on:error={() => coverSrc = resolveAssetUrl($currentTrack?.coverUrl || '')} />
      {:else}
        <span class="material-symbols-rounded" style="font-size:20px;color:var(--text-3)">music_note</span>
      {/if}
      {#if $isBuffering}
        <div class="mini-art-loading" title="Loading…">
          <span class="material-symbols-rounded mini-loading-icon">progress_activity</span>
        </div>
      {/if}
    </div>
    <div class="mini-info">
      <span class="mini-title">{$currentTrack.title}</span>
      <span class="mini-artist">{$streamNowPlaying ? `♪ ${$streamNowPlaying}` : $currentTrack.artist}</span>
    </div>
    <div class="mini-controls" on:click|stopPropagation>
      <button class="mini-btn" on:click={prev}>
        <span class="material-symbols-rounded">skip_previous</span>
      </button>
      <button class="mini-btn play" on:click={togglePlay}>
        <span class="material-symbols-rounded">{$isPlaying ? 'pause' : 'play_arrow'}</span>
      </button>
      <button class="mini-btn" on:click={next}>
        <span class="material-symbols-rounded">skip_next</span>
      </button>
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="mini-vol" on:click|stopPropagation>
        <input type="range" min="0" max="1" step="0.05" value={$volume}
          on:input={e => setVolume(parseFloat(e.target.value))} class="mini-vol-slider" />
      </div>
      <button class="mini-btn close" on:click={stop} title="Stop">
        <span class="material-symbols-rounded">close</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .mini-player {
    position: fixed;
    bottom: calc(var(--nav-bar-h, var(--nav-h)) + var(--safe-bottom, 0px));
    left: 0; right: 0;
    height: 56px;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    z-index: 30;
    cursor: pointer;
    overflow: hidden;
  }
  .mini-progress {
    position: absolute;
    top: 0; left: 0;
    height: 2px;
    background: var(--accent);
    transition: width 0.3s linear;
  }
  .mini-art {
    position: relative;
    width: 40px; height: 40px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    flex-shrink: 0;
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .mini-art img { width: 100%; height: 100%; object-fit: cover; }
  /* Subtle pulse when actively playing — makes the player feel alive
     without being distracting. Removed when paused/buffering. Respects
     reduced-motion preference. */
  .mini-art.playing {
    animation: mini-art-pulse 2s ease-in-out infinite;
  }
  @keyframes mini-art-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent); }
    50%      { box-shadow: 0 0 12px 2px color-mix(in srgb, var(--accent) 35%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .mini-art.playing { animation: none; box-shadow: 0 0 8px 1px color-mix(in srgb, var(--accent) 25%, transparent); }
  }
  .mini-art-loading {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center;
  }
  .mini-loading-icon {
    font-size: 22px; color: var(--accent);
    animation: mini-spin 1s linear infinite;
  }
  @keyframes mini-spin { to { transform: rotate(360deg); } }
  .mini-info {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; gap: 1px;
  }
  .mini-title {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .mini-artist {
    font-size: 11px; color: var(--text-3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .mini-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .mini-btn {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: none; border: none;
    color: var(--text-2); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: color var(--dur-fast);
  }
  .mini-btn:hover { color: var(--text-1); }
  .mini-btn.play { color: var(--accent); }
  .mini-btn .material-symbols-rounded { font-size: 24px; }
  .mini-btn.play .material-symbols-rounded { font-size: 28px; }
  .mini-btn.close { color: var(--text-3); }
  .mini-btn.close:hover { color: var(--danger); }
  .mini-btn.close .material-symbols-rounded { font-size: 20px; }

  .mini-vol { display: flex; align-items: center; width: 60px; flex-shrink: 0; }
  .mini-vol-slider {
    width: 100%; height: 3px;
    -webkit-appearance: none; appearance: none;
    background: var(--surface-3); border-radius: 2px; outline: none;
    cursor: pointer;
  }
  .mini-vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--accent); cursor: pointer;
  }
  .mini-vol-slider::-moz-range-thumb {
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--accent); border: none; cursor: pointer;
  }
  @media (max-width: 480px) {
    .mini-vol { display: none; }
  }
</style>
