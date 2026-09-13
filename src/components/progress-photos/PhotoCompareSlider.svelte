<script>
  /**
   * PhotoCompareSlider.svelte
   *
   * Before/after comparison of two progress photos: both images stacked
   * in one frame, the top one clipped to a draggable divider, so dragging
   * wipes between them in place rather than showing them side by side.
   * Side-by-side halves each photo's width; this keeps both at full size
   * and lets small changes actually register.
   *
   * Hand-rolled on pointer events (no library): this codebase has no
   * carousel or slider dependency and draws its own charts, and pointer
   * events cover mouse, touch and pen in one path, so there is no
   * separate mobile branch to keep in sync.
   */
  import { _ } from 'svelte-i18n';
  import { resolveAssetUrl } from '../../lib/platform.js';

  /** @type {{id:number, date:string, url:string}} */
  export let before;
  /** @type {{id:number, date:string, url:string}} */
  export let after;

  let frameEl;
  // Divider position as a percentage of frame width.
  let pct = 50;
  let dragging = false;

  function setFromClientX(clientX) {
    if (!frameEl) return;
    const r = frameEl.getBoundingClientRect();
    if (!r.width) return;
    pct = Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
  }

  function onPointerDown(e) {
    dragging = true;
    frameEl?.setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    setFromClientX(e.clientX);
  }
  function onPointerUp(e) {
    dragging = false;
    frameEl?.releasePointerCapture?.(e.pointerId);
  }

  // Keyboard parity for desktop: the handle is focusable and the arrow
  // keys nudge it, so this is not mouse-only.
  function onKeyDown(e) {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft')  { pct = Math.max(0, pct - step);   e.preventDefault(); }
    if (e.key === 'ArrowRight') { pct = Math.min(100, pct + step); e.preventDefault(); }
    if (e.key === 'Home')       { pct = 0;   e.preventDefault(); }
    if (e.key === 'End')        { pct = 100; e.preventDefault(); }
  }

  function fmtDate(d) {
    if (!d) return '';
    const parsed = new Date(`${d}T00:00:00`);
    return isNaN(parsed) ? d : parsed.toLocaleDateString();
  }
</script>

<div class="compare">
  <div
    class="frame"
    bind:this={frameEl}
    on:pointerdown={onPointerDown}
    on:pointermove={onPointerMove}
    on:pointerup={onPointerUp}
    on:pointercancel={onPointerUp}
    style="--x: {pct}%"
  >
    <img class="layer" src={resolveAssetUrl(after.url)} alt={$_('progress.compare.after_alt')} draggable="false" />
    <img class="layer clipped" src={resolveAssetUrl(before.url)} alt={$_('progress.compare.before_alt')} draggable="false" />

    <div class="divider" class:dragging>
      <button
        type="button"
        class="handle"
        aria-label={$_('progress.compare.handle_label')}
        aria-valuenow={Math.round(pct)}
        aria-valuemin="0"
        aria-valuemax="100"
        role="slider"
        on:keydown={onKeyDown}
      >
        <span class="material-symbols-rounded">code</span>
      </button>
    </div>

    <span class="stamp left">{fmtDate(before.date)}</span>
    <span class="stamp right">{fmtDate(after.date)}</span>
  </div>
</div>

<style>
  .compare {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; padding: 8px;
  }
  .frame {
    position: relative;
    width: 100%;
    max-width: 900px;
    aspect-ratio: 3 / 4;
    max-height: 100%;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    touch-action: none;       /* the drag owns the gesture, not the scroller */
    cursor: ew-resize;
    user-select: none;
  }
  .layer {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: contain;
    pointer-events: none;
    -webkit-user-drag: none;
  }
  /* Only the "before" layer is clipped; revealing more of it as the
     divider moves right. */
  .clipped { clip-path: inset(0 calc(100% - var(--x)) 0 0); }

  .divider {
    position: absolute; top: 0; bottom: 0;
    left: var(--x);
    width: 2px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
    transform: translateX(-1px);
  }
  .handle {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: var(--radius-full);
    background: rgba(255, 255, 255, 0.95);
    color: #222;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    cursor: ew-resize;
  }
  .handle .material-symbols-rounded { font-size: 20px; }
  .handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .stamp {
    position: absolute; bottom: 10px;
    font-size: 11px; font-weight: 600;
    padding: 3px 8px; border-radius: var(--radius-full);
    background: rgba(0, 0, 0, 0.55); color: #fff;
    pointer-events: none;
  }
  .stamp.left  { left: 10px; }
  .stamp.right { right: 10px; }

  @media (max-width: 600px) {
    .frame { aspect-ratio: 3 / 4; }
    .handle { width: 44px; height: 44px; }  /* comfortable touch target */
  }
</style>
