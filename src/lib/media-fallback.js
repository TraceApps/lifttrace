// Exercise images that failed to load, so a thumbnail falls back to the next
// image or its icon tile instead of a broken image (#155: a catalog's GIF can
// be gone upstream). Cleared when the device comes back online or the app to
// the foreground, so one that failed for a moment is tried again.
import { writable } from 'svelte/store';

export const failedMedia = writable(new Set());

export function mediaFailed(url) {
  if (url) failedMedia.update((s) => new Set(s).add(url));
}

/** The first of these image addresses that hasn't failed, or null. */
export function workingMedia(failed, ...urls) {
  return urls.find((u) => u && !failed.has(u)) || null;
}

if (typeof window !== 'undefined') {
  const retry = () => failedMedia.set(new Set());
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) retry(); });
}
