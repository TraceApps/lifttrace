import { writable, derived } from 'svelte/store';
import { localDateStr } from '../lib/db.js';
import { LtApi } from '../lib/api.js';
import { ensureExerciseUuids, diffTombstones } from '../lib/workout-uuid.js';

export const currentDate  = writable(localDateStr());
export const todayLog     = writable(null);    // full workout log entry for currentDate
export const activeProgram = writable(null);   // user's active program
export const todayPrescription = writable(null); // coach's prescription for currentDate
// Issue #76: a date can have more than one session. todaySessions holds
// every session logged that date (for a session-switcher UI);
// currentSessionId is the id of whichever one is currently loaded into
// todayLog — null until a load/save resolves one (matches a brand-new
// day with nothing saved yet).
export const todaySessions = writable([]);
export const currentSessionId = writable(null);

// Option C snapshot: the last server-authoritative exercises array we
// saw for each date. deleted_uuids on the next PUT is computed by
// diffing the client's about-to-send exercises against this snapshot,
// NOT against a fresh GET. Using the load-time snapshot avoids a race
// where a concurrent write from another device (present in the fresh
// GET but never in the client's local state) would get spuriously
// tombstoned by our diff.
//
// Keyed by (date, session id) rather than date alone (issue #76): two
// sessions on the same date must diff independently, or a save to one
// could spuriously tombstone the other's exercises against the wrong
// baseline. sessionId is null for a date with no row yet (brand-new day,
// identical to pre-#76 behavior since only one snapshot slot existed).
const _snapshotByDate = new Map();
function _snapshotKey(dateStr, sessionId) {
  return sessionId != null ? `${dateStr}:${sessionId}` : dateStr;
}
function _snapshotExercises(dateStr, sessionId) {
  return _snapshotByDate.get(_snapshotKey(dateStr, sessionId)) || [];
}
function _setSnapshot(dateStr, sessionId, workout) {
  const key = _snapshotKey(dateStr, sessionId);
  if (workout && Array.isArray(workout.exercises)) {
    _snapshotByDate.set(key, workout.exercises);
  } else {
    _snapshotByDate.set(key, []);
  }
}

/** Load workout log for a specific date — the default session (issue
 *  #76: session 0, or the lowest surviving one). Also pulls the full
 *  session list and any coach prescription. */
export async function loadWorkout(dateStr) {
  const guard = dateStr;
  currentDate.set(dateStr);
  try {
    const data = await LtApi.getWorkout(dateStr);
    if (guard !== dateStr) return; // stale
    todayLog.set(data.workout || null);
    currentSessionId.set(data.workout?.id ?? null);
    _setSnapshot(dateStr, data.workout?.id ?? null, data.workout);
  } catch {
    todayLog.set(null);
    currentSessionId.set(null);
    _setSnapshot(dateStr, null, null);
  }
  // Best-effort, non-blocking — a session-switcher UI wants this, but a
  // failure here shouldn't stop the main diary from rendering.
  loadWorkoutSessions(dateStr).catch(() => {});
  // Pull prescription in parallel (fire-and-forget, fails silently on single-user mode)
  try {
    const px = await LtApi.getMyPrescriptionForDate(dateStr);
    if (guard !== dateStr) return;
    todayPrescription.set(px || null);
  } catch {
    todayPrescription.set(null);
  }
}

/** Refresh the full list of sessions logged on `dateStr` (issue #76). */
export async function loadWorkoutSessions(dateStr) {
  const guard = dateStr;
  try {
    const data = await LtApi.getWorkoutSessions(dateStr);
    if (guard !== dateStr) return; // stale
    todaySessions.set(data.sessions || []);
  } catch {
    if (guard !== dateStr) return;
    todaySessions.set([]);
  }
}

/** Switch the currently-viewed session to `sessionId`. Always fetches
 *  fresh rather than trusting todaySessions' cached snapshot — that
 *  list is only refreshed at specific points (load, after a save,
 *  starting a new session), and a bug found in exactly this spot
 *  (edit a session, switch away, switch back — stale data reappears,
 *  looking exactly like the edit silently reverted) showed relying on
 *  it is too easy to get wrong. A tab switch isn't a hot path, so the
 *  extra round-trip is worth the correctness guarantee. */
export async function switchSession(dateStr, sessionId) {
  try {
    const data = await LtApi.getWorkout(dateStr, sessionId);
    if (!data?.workout) return;
    todayLog.set(data.workout);
    currentSessionId.set(data.workout.id);
    _setSnapshot(dateStr, data.workout.id, data.workout);
  } catch {}
}

/** Permanently delete one session (issue #76). sessionId is optional —
 *  omitted, this deletes the same default session loadWorkout would
 *  return. Only reloads todayLog (jumping the view to whatever's now
 *  the default session) when the DELETED session is the one currently
 *  displayed — deleting a different, inactive tab just refreshes the
 *  tab list so it disappears, without yanking the view away from
 *  whatever the user is actually looking at. */
export async function deleteSession(dateStr, sessionId = null) {
  await LtApi.deleteWorkout(dateStr, sessionId);
  let activeId;
  const unsub = currentSessionId.subscribe(v => { activeId = v; });
  unsub();
  if (sessionId == null || sessionId === activeId) {
    await loadWorkout(dateStr);
  } else {
    await loadWorkoutSessions(dateStr);
  }
}

/** Start a genuinely new session on `dateStr` rather than continuing
 *  whatever's currently loaded into todayLog (issue #76). Bypasses the
 *  debounced saveWorkout/merge machinery — this is a deliberate,
 *  one-off action like loadTemplate, not rapid-fire typing. */
export async function startNewSession(dateStr, seedEntry = {}) {
  const stamped = {
    ...seedEntry,
    exercises: ensureExerciseUuids(seedEntry.exercises || []),
    new_session: true,
  };
  delete stamped.id; // never continue an existing session
  const saved = await LtApi.saveWorkout(dateStr, stamped);
  todayLog.set(saved.workout);
  currentSessionId.set(saved.workout?.id ?? null);
  _setSnapshot(dateStr, saved.workout?.id ?? null, saved.workout);
  await loadWorkoutSessions(dateStr);
  return saved.workout;
}

/** Refetch the server's current workout for `dateStr` and merge the
 *  client's pending edits over it. Same cross-app fix as NutriTrace's
 *  diary stale-cache race (NT #81): if the cached `todayLog` was
 *  loaded before another device wrote, the full-row PUT echoes back
 *  the stale state and wipes whatever the other device added.
 *  Refetching first means metadata fields (name, notes, duration_min,
 *  template_id, program_id) survive when the client didn't explicitly
 *  set them. `exercises[]` is treated as authoritative on the client
 *  side because it's the field the user actively edits in this
 *  session; cross-device exercise editing on the same date in the
 *  same session is rare and gets last-writer-wins as an accepted
 *  tradeoff. `completed` also stays client-authoritative because
 *  the user can legitimately un-complete a workout, and an OR-merge
 *  would block that. Per-set timestamps would be the proper fix for
 *  the exercises array; tracked for a follow-up. */
async function _mergeAndSave(dateStr, clientEntry) {
  // Which session this save actually targets (issue #76) — clientEntry
  // already carries `id` whenever the caller spread an already-loaded
  // $todayLog (every existing call site does this), so this falls out
  // for free; null means "no row yet for this date" (brand-new day,
  // identical to pre-#76 behavior). Refetching and diffing against THIS
  // session specifically matters once a date can have more than one —
  // without it, editing session 2 would refetch/diff against session 1's
  // state instead.
  const sessionId = clientEntry.id ?? null;
  let server = null;
  try {
    const data = await LtApi.getWorkout(dateStr, sessionId);
    server = data?.workout || null;
  } catch {}

  // Option C (2026-08-11): make sure every exercise + set carries a
  // stable uuid before we ship it. Idempotent for entries that already
  // have them (from the load or from a prior add-path). This is the
  // single choke-point that covers every add-path in every component,
  // instead of instrumenting each one individually.
  const nextExercises = ensureExerciseUuids(clientEntry.exercises || []);

  // Compute deleted_uuids by diffing what we're about to send against
  // the LOAD-TIME snapshot (what the server had when this client last
  // read the row). Diffing against the just-refetched server would
  // erroneously tombstone anything a concurrent device added between
  // our load and this save — the whole point of Option C is to
  // preserve those concurrent adds. Snapshot-based diff only reflects
  // deletions the local user actually performed since load.
  const deleted_uuids = diffTombstones(_snapshotExercises(dateStr, sessionId), nextExercises);

  const toSave = server ? {
    ...server,
    ...clientEntry,
    exercises: nextExercises,
    // Where client didn't explicitly set a metadata field, fall back to
    // server's value so a stale-cache write doesn't wipe what another
    // device added. `??` (nullish coalescing) means an explicit empty
    // string or 0 from the client still wins over server.
    name:         clientEntry.name         ?? server.name,
    notes:        clientEntry.notes        ?? server.notes,
    duration_min: clientEntry.duration_min ?? server.duration_min,
    template_id:  clientEntry.template_id  ?? server.template_id,
    program_id:   clientEntry.program_id   ?? server.program_id,
    program_week: clientEntry.program_week ?? server.program_week,
    deleted_uuids,
  } : { ...clientEntry, exercises: nextExercises, deleted_uuids };
  const saved = await LtApi.saveWorkout(dateStr, toSave);
  // Refresh snapshot to the server-authoritative post-merge state so
  // subsequent saves diff against reality (including any concurrent
  // additions the server folded in). Keyed by the saved row's own id —
  // identical to sessionId for an existing session; resolves the very
  // first save's null to the newly-assigned id so the next edit on this
  // date diffs against the right slot.
  _setSnapshot(dateStr, saved?.workout?.id ?? sessionId, saved?.workout);
  return saved;
}

/** Save/update workout log for current date.
 *  Optimistically updates todayLog immediately, then debounces the server
 *  save so rapid typing doesn't overwrite the input mid-keystroke. */
let _saveTimer;
let _latestEntry = null;
// Track the date alongside the entry so flushWorkoutSave can be invoked from
// lifecycle handlers (App.pause / visibilitychange / pagehide) that don't
// have a specific date in scope — without this, a 350ms-debounced save that
// hasn't fired yet when Android kills the app is lost silently.
let _latestDate = null;
export function saveWorkout(dateStr, entry) {
  // Stamp uuids IMMEDIATELY so `_latestEntry` and `todayLog` hold the
  // uuid-carrying shape from the start. Without this, `ensureExerciseUuids`
  // runs again inside `_mergeAndSave` on every save (debounce fire,
  // flushWorkoutSave on visibilitychange / pause / pagehide) and generates
  // fresh random uuids for any set that didn't already have one — e.g. sets
  // just built from a template's set_specs, or sets just added via the "+"
  // button. On the second save the client sends different uuids for the
  // same physical sets; if the tombstone diff ever misses (empty snapshot
  // after a lifecycle roundtrip), the server-side per-uuid merge treats
  // them as new sets and APPENDS them onto the existing ones. That's what
  // "every time I opened the app every exercise had 5 or 10 more sets"
  // was (#XX, 2026-08-15). Stamping once here makes subsequent runs of
  // `ensureExerciseUuids` a no-op, so every replay of the same entry
  // sends the same uuids and merges idempotently.
  const stamped = {
    ...entry,
    exercises: ensureExerciseUuids(entry.exercises || []),
  };
  todayLog.set(stamped);
  _latestEntry = stamped;
  _latestDate  = dateStr;

  return new Promise((resolve, reject) => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      const toSave = _latestEntry;
      try {
        const saved = await _mergeAndSave(dateStr, toSave);
        // Only sync from server if no newer edits are queued
        if (_latestEntry === toSave) {
          todayLog.set(saved.workout);
          // Resolves currentSessionId once a brand-new day's first save
          // gets its id assigned (issue #76) — a no-op for every
          // subsequent save on an already-known session.
          currentSessionId.set(saved.workout?.id ?? null);
          // Keeps the tab strip's own names/checkmarks current — without
          // this, completing or renaming a session wouldn't show up on
          // its tab until a full page reload.
          loadWorkoutSessions(dateStr).catch(() => {});
          // Clear so lifecycle-driven flushes (App.pause / visibilitychange /
          // pagehide) don't re-fire the same already-saved entry. A genuine
          // subsequent edit re-populates via a new `saveWorkout` call.
          _latestEntry = null;
          _latestDate  = null;
        }
        resolve(saved.workout);
      } catch (e) { reject(e); }
    }, 350);
  });
}

/** Force-flush any pending save immediately (for navigation away, App.pause,
 *  visibilitychange, pagehide, etc.). dateStr is optional — falls back to
 *  the date of the most recent saveWorkout call. */
export async function flushWorkoutSave(dateStr) {
  const date = dateStr || _latestDate;
  if (!_latestEntry || !date) return;
  clearTimeout(_saveTimer);
  const toSave = _latestEntry;
  try {
    const saved = await _mergeAndSave(date, toSave);
    if (_latestEntry === toSave) {
      todayLog.set(saved.workout);
      currentSessionId.set(saved.workout?.id ?? null);
      loadWorkoutSessions(date).catch(() => {});
      // Clear so re-firing lifecycle handlers can't re-save the same
      // already-flushed entry. See saveWorkout for the full rationale.
      _latestEntry = null;
      _latestDate  = null;
    }
  } catch {}
}

/** Derived: count of completed sets today */
export const completedSetsToday = derived(todayLog, ($log) => {
  if (!$log?.exercises?.length) return 0;
  return $log.exercises.reduce((sum, ex) =>
    sum + (ex.sets?.filter(s => s.completed).length || 0), 0);
});

/** Load the user's active program */
export async function loadActiveProgram() {
  try {
    const programs = await LtApi.getPrograms();
    const active = programs.find(p => p.is_active);
    activeProgram.set(active || null);
  } catch {
    activeProgram.set(null);
  }
}
