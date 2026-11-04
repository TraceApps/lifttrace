/**
 * sync-refresh.js: what a sync changed on this phone, and a page asking to
 * hear of it (Android, server mode).
 *
 * A page reads its lists from the phone's database when it opens, and again
 * only when told. A sync that brings a row in, changes one or takes one away
 * (a program deleted on the web) changes the database under a page that is
 * open, so sync.js ends every pull with 'lt:sync-complete' and says which
 * kinds of rows it touched (detail.kinds). A page calls onSyncChanges with
 * the kinds it shows and reads its data again when one of them is touched.
 * A pull that touched nothing has no kinds, and no such page reads anything.
 */

// What each count in a pull's result (sync.js result.tables) touched. A pull
// that dropped a program or a day this account may no longer keep, or fetched
// one it was missing, changed programs and days.
const KINDS_OF = {
  exercises: ['exercises'],
  programs: ['programs'],
  templates: ['templates'],
  assignments: ['assignments'],
  workouts: ['workouts'],
  workoutTombstones: ['workouts'],
  bodyStats: ['bodyStats'],
  excusedDays: ['excusedDays'],
  settings: ['settings'],
  chat: ['chat'],
  dropped: ['programs', 'templates'],
  programsHealed: ['programs', 'templates'],
  templatesHealed: ['templates'],
};

/** The kinds a pull changed: `tables` is its result.tables, rows per kind. */
export function pullKinds(tables) {
  const kinds = new Set();
  for (const [name, n] of Object.entries(tables || {})) {
    if (Number(n) > 0) for (const k of KINDS_OF[name] || [name]) kinds.add(k);
  }
  return [...kinds];
}

/**
 * Whether a 'lt:sync-complete' event touched any of `kinds` (any at all when
 * none are given). An event that doesn't say what it touched counts when it
 * says it brought rows.
 */
export function syncTouched(detail, kinds) {
  if (!detail) return false;
  if (Array.isArray(detail.kinds)) {
    if (!detail.kinds.length) return false;
    return !kinds || kinds.some(k => detail.kinds.includes(k));
  }
  return detail.changed === true;
}

/**
 * Calls `fn(detail)` after a sync that touched any of `kinds`. Returns the
 * function that stops listening, so a page can hand it to onMount (a
 * non-async one: an async onMount's return is never run).
 */
export function onSyncChanges(fn, kinds) {
  if (typeof window === 'undefined') return () => {};
  const handler = e => { if (syncTouched(e?.detail, kinds)) fn(e.detail); };
  window.addEventListener('lt:sync-complete', handler);
  return () => window.removeEventListener('lt:sync-complete', handler);
}

/**
 * Two reads at once (a page opening while a sync ends, or two syncs): only
 * the newest one's answer stands. A page makes `const newest = newestRead();`
 * once, then `const isNewest = newest();` before each read and
 * `if (!isNewest()) return;` after it.
 */
export function newestRead() {
  let latest = 0;
  return () => { const mine = ++latest; return () => mine === latest; };
}
