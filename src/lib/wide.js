/**
 * Is there room for a two-pane layout?
 *
 * Mirrors `html.wide-content`, which App.svelte sets from the content width
 * minus whatever sidebar is pinned, rather than from the raw viewport. A
 * media query cannot see the sidebar, and a foldable open flat is only about
 * 852px, so the routes that asked `matchMedia('(min-width: 1280px)')` stayed
 * on the phone layout on the largest screen the app ever gets.
 *
 * The class already accounts for Force Mobile Layout, so callers do not need
 * to check it separately.
 */
import { readable } from 'svelte/store';

export const wideContent = readable(false, (set) => {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const read = () => set(root.classList.contains('wide-content'));
  read();
  const obs = new MutationObserver(read);
  obs.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
});
