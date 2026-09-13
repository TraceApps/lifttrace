<script>
  /**
   * PhotoImage.svelte
   *
   * Renders one progress photo. Every progress-photo <img> in the app goes
   * through here, because the bytes come from an authenticated API route
   * rather than a public URL and so have to be fetched rather than linked.
   *
   * Rows that are renderable directly (a file:// URI in Capacitor standalone,
   * an externally hosted http(s) image attached over MCP or REST, or one the
   * native offline cache already holds) skip the fetch entirely.
   */
  import { onDestroy } from 'svelte';
  import { directUrlFor, photoBlobUrl, invalidatePhoto } from '../../lib/photo-blobs.js';

  /** @type {{id:number, url:string, date:string}} */
  export let photo;
  export let alt = '';
  /** Defer the fetch until the image scrolls into view. */
  export let lazy = true;

  let wrapEl;
  let resolved = null;
  let failed = false;
  let observer = null;
  let wanted = false;
  let retried = false;

  $: direct = directUrlFor(photo?.url);

  // Keyed on the id, not on `photo` itself. Svelte's dependency for a prop
  // object is a deep read, so a refetch that produces equal-but-new objects
  // (which the timeline does after an add, a delete, or a sync signal) would
  // otherwise blank `resolved` on every mounted tile at once and flash the
  // whole grid to skeletons for a frame.
  let lastId = null;
  $: if (photo && photo.id !== lastId) {
    lastId = photo.id;
    resolved = null;
    failed = false;
    retried = false;
    wanted = !lazy || wanted;
  }
  $: if (photo && !direct && wanted) load(photo.id);

  async function load(id) {
    try {
      const url = await photoBlobUrl(id);
      // Guard against a slow fetch landing after the photo has changed.
      if (photo?.id === id) resolved = url;
    } catch {
      if (photo?.id === id) failed = true;
    }
  }

  // The browser's own loading="lazy" cannot help here: there is no src to
  // defer, the fetch is ours. Without this a year of photos would all be
  // requested the moment the timeline mounts.
  function watch(node) {
    wrapEl = node;
    if (!lazy || typeof IntersectionObserver === 'undefined') { wanted = true; return; }
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        wanted = true;
        observer?.disconnect();
        observer = null;
      }
    }, { rootMargin: '300px' });
    observer.observe(node);
    return { destroy() { observer?.disconnect(); observer = null; } };
  }

  onDestroy(() => observer?.disconnect());

  // An object URL can stop resolving even though the fetch succeeded: the
  // shared cache evicts entries under pressure, and a blob can be dropped by
  // the browser. Rather than leave a permanently broken tile, invalidate the
  // entry and try once more, then give up and show the placeholder.
  function onImgError() {
    if (retried || !photo) { failed = true; return; }
    retried = true;
    invalidatePhoto(photo.id);
    resolved = null;
    load(photo.id);
  }

  // Object URLs are owned by the shared cache in photo-blobs.js, which
  // releases them on sign-out. Revoking here would break any other
  // component showing the same photo.
</script>

<div class="pi" use:watch>
  {#if direct}
    <img src={direct} {alt} draggable="false" />
  {:else if resolved}
    <img src={resolved} {alt} draggable="false" on:error={onImgError} />
  {:else if failed}
    <span class="pi-fail material-symbols-rounded" title={alt}>broken_image</span>
  {:else}
    <span class="pi-skel" aria-hidden="true"></span>
  {/if}
</div>

<style>
  .pi {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .pi img {
    max-width: 100%; max-height: 100%;
    width: 100%; height: 100%;
    object-fit: contain;
    -webkit-user-drag: none;
  }
  .pi-skel {
    width: 100%; height: 100%;
    background: linear-gradient(90deg,
      var(--surface-2) 25%,
      color-mix(in srgb, var(--text-3) 12%, var(--surface-2)) 37%,
      var(--surface-2) 63%);
    background-size: 400% 100%;
    animation: pi-shimmer 1.4s ease infinite;
  }
  @keyframes pi-shimmer {
    0%   { background-position: 100% 0; }
    100% { background-position: 0 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pi-skel { animation: none; }
  }
  .pi-fail { font-size: 28px; color: var(--text-3); }
</style>
