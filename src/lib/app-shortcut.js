/**
 * app-shortcut.js (from TraceApps/nutritrace#278): the app icon's shortcuts.
 *
 * Long-press the app icon (Android, or the installed web app) for Start
 * Workout or Log Weight. Android opens lifttrace://new/<kind>
 * (res/xml/shortcuts.xml), which App.svelte sends to /?new=<kind>; the web
 * app's manifest opens ./#/?new=<kind> directly. The Diary reads it there
 * (shortcutFromQuery) and opens it on today:
 *
 *   workout  the workout under way today (the latest session); when every one
 *            is finished, Load Workout for a new session; an empty day opens
 *            Load Workout
 *   weight   the Body Stats sheet
 *
 * Signed out, the address waits under the sign-in screen and the Diary
 * opens it once signed in (Login.svelte leaves it in place).
 */

export const SHORTCUT_KINDS = ['workout', 'weight'];

/** The kind a /?new=<kind> query asks for, or null. */
export function shortcutFromQuery(qs) {
  const kind = new URLSearchParams(String(qs || '').replace(/^\?/, '')).get('new');
  return SHORTCUT_KINDS.includes(kind) ? kind : null;
}

/** The kind a lifttrace://new/<kind> link (from parseAppLink) asks for, or null. */
export function shortcutFromAppLink(link) {
  if (!link || link.scheme !== 'lifttrace' || link.host !== 'new') return null;
  const kind = String(link.path || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return SHORTCUT_KINDS.includes(kind) ? kind : null;
}

/** True for a page address (location.hash) that is a shortcut waiting to open. */
export function isShortcutHash(hash) {
  const m = /^#?\/?(\?.*)?$/.exec(String(hash || ''));
  return !!m && !!shortcutFromQuery(m[1] || '');
}

/**
 * How to go to a shortcut's route from the page address (location.hash):
 * 'replace' on the first page with nothing else asked for (the app just
 * started), so Back from the first page doesn't stop on a copy of it;
 * 'push' anywhere else, so Back returns there.
 */
export function shortcutNav(hash) {
  return /^#?\/?$/.test(String(hash || '')) ? 'replace' : 'push';
}

// The launch URL stays the same for as long as the app runs, through every
// page reload (signing out, restoring a backup): only the first page that
// reads it opens it. sessionStorage lasts through a reload and starts empty
// in a new start of the app; a fresh start brings the link again anyway.
const LAUNCH_KEY = 'lt:launchShortcutRead';
/** True the first time this page session reads the launch URL's shortcut. */
export function firstLaunchRead(store = globalThis.sessionStorage) {
  try {
    if (store?.getItem(LAUNCH_KEY)) return false;
    store?.setItem(LAUNCH_KEY, '1');
  } catch {}
  return true;
}

// A shortcut that starts the app arrives twice on Android: as the launch URL
// and as appUrlOpen. The second within a few seconds is the same tap.
let _last = null;
/** The route for a shortcut's kind, or null for a repeat of the one just sent. */
export function shortcutRoute(kind, now = Date.now()) {
  if (!SHORTCUT_KINDS.includes(kind)) return null;
  if (_last && _last.kind === kind && now - _last.at < 3000) return null;
  _last = { kind, at: now };
  return `/?new=${kind}`;
}

/**
 * What Start Workout does with today's workouts (a day can have several
 * sessions, listed oldest first):
 *   { action: 'resume' }            the open one is under way: show it
 *   { action: 'switch', id }        another one is under way: open that one
 *   { action: 'new_session' }       every one is finished: Load Workout, for a new session
 *   { action: 'load' }              nothing logged yet: Load Workout
 * A workout under way has exercises and isn't finished; the latest one wins.
 * Without the list (it couldn't be read), the open workout decides alone.
 */
export function startWorkoutPlan(sessions, open) {
  const logged = w => Array.isArray(w?.exercises) && w.exercises.length > 0;
  const list = (Array.isArray(sessions) && sessions.length ? sessions : [open]).filter(logged);
  if (!list.length) return { action: 'load' };
  const going = list.filter(w => !w.completed);
  if (!going.length) return { action: 'new_session' };
  const latest = going[going.length - 1];
  if (open && latest.id === open.id) return { action: 'resume' };
  if (latest.id == null) return { action: 'resume' };
  return { action: 'switch', id: latest.id };
}
