/**
 * pull-sync.js: which touches may start the Android pull-to-refresh.
 *
 * Pull-to-refresh listens to every touch on the page (so it also works over
 * the fixed top bar). Anything that uses a downward drag for its own purpose
 * must be left out, or dragging it down while the page is at the top reads
 * as a pull and syncs. Same fix as NutriTrace #225, where moving the Trace
 * button toward the bottom of the screen refreshed the page.
 *
 *   dialogs, sheets, sidebar, bottom bar: their own touch handling
 *   .drag-handle          reorder handles
 *   [data-no-pull-sync]   anything else draggable: the Trace button, the
 *                         Diary add button, the progress-photo compare
 *                         slider and scrubber
 */
export const PULL_SYNC_EXEMPT = [
  '[role="dialog"]', '.sheet-backdrop', '.sidebar-panel', '.sidebar-backdrop', '.bottom-nav',
  '.drag-handle', '[data-no-pull-sync]',
].join(', ');

/** True when a touch on `target` must not start a pull-to-refresh. */
export function isPullSyncExempt(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(PULL_SYNC_EXEMPT));
}
