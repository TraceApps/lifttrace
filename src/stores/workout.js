import { writable, derived, get } from 'svelte/store';
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

// What this Diary changed and hasn't seen saved yet, per workout: each
// exercise, set and detail, by when it was last changed. A save sends the
// whole workout as shown, so one shown from before another change (the watch
// ticking a set, Trace naming the workout) put the old values back: only what
// was changed here is the save's to say. Noted as each change is made,
// against what was on screen just before it, so a refresh landing in
// between, or a change undone while the save before it was still on its way,
// can't make someone else's change look like this Diary's, or this Diary's
// look like none.
const _editsByKey = new Map();
let _editSeq = 0;
// What the Diary was showing, as a copy: an edit made in place on screen
// would otherwise change this too and read as no change at all.
let _shown = null;
todayLog.subscribe(v => { _shown = v ? JSON.parse(JSON.stringify(v)) : null; });
const _DETAILS = ['name', 'notes', 'duration_min', 'completed', 'template_id', 'program_id', 'program_week'];
// The program, its workout and the week go together, as on the server.
const _PROGRAM = ['template_id', 'program_id', 'program_week'];
const _same = (a, b) => {
  const n = (v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  return String(n(a)) === String(n(b));
};
// One exercise or set against another: the same, leaving out what only the
// screen keeps (fields starting with _) and, for an exercise, its sets.
function _sameEntry(a, b, skip = null) {
  const norm = (o) => JSON.stringify(Object.keys(o || {}).filter(k => !k.startsWith('_') && k !== skip).sort().map(k => [k, o[k]]));
  return norm(a) === norm(b);
}

/** The exercises and sets in `next` that are new or different from `before`. */
export function changedUuids(before, next) {
  const was = new Map((before || []).filter(e => e?.uuid).map(e => [e.uuid, e]));
  const exercises = [];
  const sets = {};
  for (const ex of next || []) {
    if (!ex?.uuid) continue;
    const old = was.get(ex.uuid);
    if (!old || !_sameEntry(ex, old, 'sets')) exercises.push(ex.uuid);
    const oldSets = new Map((old?.sets || []).filter(x => x?.uuid).map(x => [x.uuid, x]));
    const changed = (ex.sets || []).filter(x => x?.uuid && (!oldSets.has(x.uuid) || !_sameEntry(x, oldSets.get(x.uuid))));
    if (changed.length) sets[ex.uuid] = changed.map(x => x.uuid);
  }
  return { exercises, sets };
}

/** Note what an edit changed: `before` is what was on screen (null: all of it). */
function _noteEdits(key, before, next) {
  const ch = changedUuids(before?.exercises || [], next?.exercises || []);
  const fields = before ? _DETAILS.filter(f => !_same(next?.[f], before?.[f])) : _DETAILS;
  if (!ch.exercises.length && !Object.keys(ch.sets).length && !fields.length) return;
  const m = _editsByKey.get(key) || new Map();
  const at = ++_editSeq;
  for (const u of ch.exercises) m.set(`e ${u}`, at);
  for (const [ex, list] of Object.entries(ch.sets)) for (const u of list) m.set(`s ${ex} ${u}`, at);
  for (const f of fields) m.set(`f ${f}`, at);
  _editsByKey.set(key, m);
}

/** What a save of `key` carries: everything changed here so far. */
function _editsOf(key) {
  const out = { exercises: [], sets: {}, fields: new Set(), upTo: _editSeq };
  for (const k of (_editsByKey.get(key) || new Map()).keys()) {
    const [kind, a, b] = k.split(' ');
    if (kind === 'e') out.exercises.push(a);
    else if (kind === 's') (out.sets[a] ||= []).push(b);
    else out.fields.add(a);
  }
  return out;
}

/** Saved: what was changed by then is the server's now. A change made while
 *  the save was on its way stays, for the next one. */
function _editsSaved(key, upTo) {
  const m = _editsByKey.get(key);
  if (!m) return;
  for (const [k, at] of m) if (at <= upTo) m.delete(k);
  if (!m.size) _editsByKey.delete(key);
}

/** The details a save sends: this Diary's where it changed them (`edited`),
 *  the current copy's for the rest. With nothing to go by, as before. */
export function detailsToSave(client, current, edited) {
  if (!edited) {
    return {
      name: client.name ?? current.name,
      notes: client.notes ?? current.notes,
      duration_min: client.duration_min ?? current.duration_min,
      template_id: client.template_id ?? current.template_id,
      program_id: client.program_id ?? current.program_id,
      program_week: client.program_week ?? current.program_week,
    };
  }
  const program = _PROGRAM.some(f => edited.has(f));
  const out = {};
  for (const f of _DETAILS) out[f] = (_PROGRAM.includes(f) ? program : edited.has(f)) ? client[f] : current[f];
  return out;
}

/** Load workout log for a specific date — the default session (issue
 *  #76: session 0, or the lowest surviving one). Also pulls the full
 *  session list and any coach prescription. */
// updated_at comes as "2026-09-19 12:00:00" from the server and as
// "2026-09-19T12:00:00.000Z" from the device's own writes. Compared as text
// the server's form always sorts first, so a newer server copy looked older.
function _tsMs(v) {
  if (!v) return 0;
  const s = String(v);
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export async function loadWorkout(dateStr, { preferFresher = false, sessionId } = {}) {
  // See the _epoch declaration below saveWorkout (issue #86): bumping it
  // stops a save still pending for whatever date/session the user is
  // navigating away from from landing later and overwriting the date
  // being navigated TO, without disturbing that save's own promise.
  // Skipped for a preferFresher background refresh (see below): that
  // call is for the SAME date the user is already on, not a real
  // navigation, and bumping the epoch there would invalidate any edit
  // the user is actively mid-debounce on.
  if (!preferFresher) _epoch++;
  // A background refresh started before a tab switch, a new workout or a
  // date change is dropped when it lands: it would put back the workout
  // that was open when it started.
  const startEpoch = _epoch;
  const startOpen = get(currentSessionId);
  // The workout to show: the one asked for, else, for a background refresh,
  // the one already on screen (issue #142). By date alone a refresh got the
  // date's first workout, so a second one logged in the evening switched
  // back to the morning's every time a set synced. Gone (deleted on another
  // device), the date's first workout shows, as before.
  const keepId = sessionId !== undefined ? sessionId
    : (preferFresher && dateStr === get(currentDate) ? get(currentSessionId) : null);
  currentDate.set(dateStr);
  try {
    let data = await LtApi.getWorkout(dateStr, keepId ?? null);
    // Only that workout, still there: the server answers a deleted one by id,
    // and the web's offline copy can answer with another. One made on this
    // device offline comes back under the server's id once it's there.
    const w = data?.workout;
    if (keepId != null && (!w || w.deleted_at || (w.id !== keepId && !(keepId < 0)))) {
      data = await LtApi.getWorkout(dateStr);
    }
    if (preferFresher && (startEpoch !== _epoch || get(currentSessionId) !== startOpen)) {
      // The tab list still catches up: this was its refresh after the sync.
      if (dateStr === get(currentDate)) loadWorkoutSessions(dateStr).catch(() => {});
      return;
    }
    // Stale check against the CURRENT value of currentDate, not a local
    // copy of the argument (which can never differ from itself). Matters
    // most for preferFresher: a background refresh captures $currentDate
    // at the moment it's kicked off, and under a slow connection (the
    // exact condition that motivated preferFresher) the user has plenty
    // of time to navigate to a different date before it resolves. Without
    // this, its session-id check below would see a mismatched id, assume
    // a session was created elsewhere, and apply anyway, overwriting the
    // date the user actually navigated to with stale data for the one
    // they left.
    if (dateStr !== get(currentDate)) return;
    if (preferFresher) {
      // A background sync-complete refresh (issue reported 2026-09-07:
      // set/weight edits reverting on every change). The `/api/workout/
      // :date` GET is local-first (apiFetch.js), unconditionally served
      // from the on-device SQLite cache; that cache is only updated by
      // a PULL applying the server's copy, never by this device's own
      // saves (those update todayLog directly from the save's network
      // response). Under a flaky connection the cache can lag well
      // behind an edit that already succeeded, so blindly applying it
      // here reverted the user's own just-made change mid-typing. Skip
      // applying anything strictly OLDER than what's already showing
      // for this same session; equal timestamps still apply, since a
      // tombstone-driven cross-device deletion patches `exercises`
      // in place without bumping `updated_at`.
      // A change made here still waiting to save, or on its way: its answer
      // brings the merged copy. Shown now, the next edit would be built on
      // this one and put back what that change did.
      // Only while one is actually waiting or on its way (both always end):
      // a save the server refused stays recorded, and must not shut out
      // every refresh after it.
      if ((_armed && _latestDate === dateStr) || _inFlight) {
        loadWorkoutSessions(dateStr).catch(() => {});
        return;
      }
      const current = get(todayLog);
      const sameSession = current?.id != null && current.id === (data.workout?.id ?? null);
      if (sameSession && _tsMs(data.workout?.updated_at) < _tsMs(current.updated_at)) {
        loadWorkoutSessions(dateStr).catch(() => {});
        return;
      }
    }
    todayLog.set(data.workout || null);
    currentSessionId.set(data.workout?.id ?? null);
    _setSnapshot(dateStr, data.workout?.id ?? null, data.workout);
  } catch {
    if (!preferFresher) {
      todayLog.set(null);
      currentSessionId.set(null);
      _setSnapshot(dateStr, null, null);
    }
  }
  // Best-effort, non-blocking — a session-switcher UI wants this, but a
  // failure here shouldn't stop the main diary from rendering.
  loadWorkoutSessions(dateStr).catch(() => {});
  // Pull prescription in parallel (fire-and-forget, fails silently on single-user mode)
  try {
    const px = await LtApi.getMyPrescriptionForDate(dateStr);
    if (dateStr !== get(currentDate)) return;
    todayPrescription.set(px || null);
  } catch {
    todayPrescription.set(null);
  }
}

// A workout created offline shows under a device-side id until its first save
// reaches the server, which stores it under its own id. sync.js announces the
// swap; follow it, so later saves go to that session and not to the date's
// first one (issue #102).
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('lt:workout-ids', (e) => {
    const map = new Map(e?.detail?.map || []);
    if (!map.size) return;
    const swap = (w) => (w && map.has(w.id) ? { ...w, id: map.get(w.id) } : w);
    const cur = get(currentSessionId);
    if (cur != null && map.has(cur)) currentSessionId.set(map.get(cur));
    todayLog.update(swap);
    // The tabs too, in place. Not fetched again here: this fires mid-sync,
    // while the phone's copy of the date is being brought back in line with
    // the server, and a list read then came back without the workout, so
    // its tab vanished for seconds. The refresh after the sync reads it.
    todaySessions.update(list => (Array.isArray(list) ? list.map(swap) : list));
    if (_latestEntry) _latestEntry = swap(_latestEntry);
    for (const [oldId, newId] of map) {
      for (const [key, ex] of [..._snapshotByDate]) {
        if (key.endsWith(`:${oldId}`)) {
          const moved = key.slice(0, -String(oldId).length) + newId;
          _snapshotByDate.set(moved, ex);
          _snapshotByDate.delete(key);
          if (_editsByKey.has(key)) { _editsByKey.set(moved, _editsByKey.get(key)); _editsByKey.delete(key); }
        }
      }
    }
  });
  // In the browser, the day's tabs are read again once the queue has gone up:
  // a workout started while it waited is on the server now.
  window.addEventListener('lt:offline-synced', () => {
    const d = get(currentDate);
    if (d) loadWorkoutSessions(d).catch(() => {});
  });
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
  // See the _epoch declaration below saveWorkout (issue #86): its own
  // network call still completes and persists normally, but without
  // this its late-arriving completion would unconditionally overwrite
  // todayLog with whatever it saved for the session the user just
  // switched AWAY from, undoing the switch a moment later. See the
  // matching note on startNewSession for the full symptom.
  _epoch++;
  try {
    const data = await LtApi.getWorkout(dateStr, sessionId);
    if (!data?.workout) return;
    _open(dateStr, data.workout);
  } catch {}
}

function _open(dateStr, workout) {
  const another = get(currentSessionId) !== workout.id;
  todayLog.set(workout);
  currentSessionId.set(workout.id);
  _setSnapshot(dateStr, workout.id, workout);
  // Another workout opened: the Diary's notes box follows (it keeps its own
  // copy while typing, so the same one again leaves it alone).
  if (another && typeof window !== 'undefined') window.dispatchEvent?.(new CustomEvent('lt:workout-opened', { detail: { date: dateStr, id: workout.id } }));
}

/** Show a workout just saved from outside the Diary (Trace) as the open one,
 *  as the save answered it. Not read back: with changes waiting to sync, the
 *  server doesn't have it yet. */
export function showWorkout(dateStr, workout) {
  if (!workout || workout.id == null || dateStr !== get(currentDate)) return;
  // A Diary change of this workout made while the tool ran, still waiting to
  // save: left to save as it is. Shown over, it would go up later measured
  // against what is shown, and remove what was just added.
  if (_pendingSave(dateStr) && _latestEntry.id === workout.id) return;
  _epoch++;
  _open(dateStr, workout);
}

const _pendingSave = (dateStr) => !!_latestEntry && _latestDate === dateStr && _latestEntryEpoch === _epoch;

/** Send a Diary change of `dateStr` still waiting to save, before something
 *  outside the Diary (Trace) reads the workout and saves over it. Built on a
 *  copy without it, that save replaced it. */
export async function settlePendingSave(dateStr) {
  if (_armed && _pendingSave(dateStr)) await flushWorkoutSave(dateStr);
  // Already on its way: waited for, not sent a second time.
  else if (_inFlight && _latestDate === dateStr) await _inFlight.catch(() => {});
}

/** Permanently delete one session (issue #76). sessionId is optional —
 *  omitted, this deletes the same default session loadWorkout would
 *  return. Only reloads todayLog (jumping the view to whatever's now
 *  the default session) when the DELETED session is the one currently
 *  displayed — deleting a different, inactive tab just refreshes the
 *  tab list so it disappears, without yanking the view away from
 *  whatever the user is actually looking at. */
export async function deleteSession(dateStr, sessionId = null) {
  // See switchSession's note (issue #86): bump _epoch so a still-pending
  // debounced save's late completion can't resurrect stale state into
  // todayLog after the session it was saving is gone.
  _epoch++;
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
  // Bump _epoch first (issue #86, see the declaration below saveWorkout).
  // Symptom without this: Clear Workout (or any edit) schedules a save
  // 350ms out and returns control to the UI immediately; if the user
  // starts a new session inside that window, this function's own save
  // resolves first and todayLog briefly shows the new session, then the
  // earlier debounced save finally fires and unconditionally overwrites
  // todayLog with what IT saved (the old, now-abandoned session): "the
  // new workout shows for a second and vanishes again". The old save's
  // own network write still completes and persists correctly against
  // its own session; only applying its result to the NOW-current
  // todayLog is what needs to be skipped.
  _epoch++;
  const stamped = {
    ...seedEntry,
    exercises: ensureExerciseUuids(seedEntry.exercises || []),
    new_session: true,
  };
  delete stamped.id; // never continue an existing session
  const saved = await LtApi.saveWorkout(dateStr, stamped);
  // A reply without the saved workout must never blank the Diary (#102).
  const workout = saved?.workout || stamped;
  todayLog.set(workout);
  currentSessionId.set(saved?.workout?.id ?? null);
  if (saved?.workout) _setSnapshot(dateStr, saved.workout.id ?? null, saved.workout);
  await loadWorkoutSessions(dateStr);
  return workout;
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

  // Only what this Diary changed is its to say (see _editsByKey): the rest of
  // the workout, as shown here, may be older than the copy just read.
  const key = _snapshotKey(dateStr, sessionId);
  const edits = _editsOf(key);
  const toSave = server ? {
    ...server,
    ...clientEntry,
    exercises: nextExercises,
    ...detailsToSave(clientEntry, server, edits.fields),
    deleted_uuids,
    changed_uuids: { exercises: edits.exercises, sets: edits.sets },
    // And the details it changed. On Android the copy read above is the
    // device's own, which can be a moment behind the server (a workout just
    // finished on the watch); the details this Diary didn't change are sent
    // from it, and counted as changed they'd put the server's back.
    changed_fields: [...edits.fields],
  } : { ...clientEntry, exercises: nextExercises, deleted_uuids };
  if (!server) { delete toSave.changed_uuids; delete toSave.changed_fields; }
  const saved = await LtApi.saveWorkout(dateStr, toSave);
  // Only once it reached the server: a queued save can still be refused, and
  // a later one sent straight up must still say what this one changed.
  if (saved?.workout && !saved.queued) {
    _editsSaved(key, edits.upTo);
    // Under its server id too, where a new workout's or a swapped id's are now.
    const savedKey = _snapshotKey(dateStr, saved.workout.id ?? null);
    if (savedKey !== key) _editsSaved(savedKey, edits.upTo);
  }
  // On the server now: a watch in use reads the day again at once.
  if (saved?.workout && !saved.queued) {
    import('../lib/wear-pairing.js').then(({ tellWatchDaySaved }) => tellWatchDaySaved(dateStr)).catch(() => {});
  }
  // Refresh snapshot to the server-authoritative post-merge state so
  // subsequent saves diff against reality (including any concurrent
  // additions the server folded in). Keyed by the saved row's own id —
  // identical to sessionId for an existing session; resolves the very
  // first save's null to the newly-assigned id so the next edit on this
  // date diffs against the right slot.
  // The details it was measured against move only once the Diary shows what
  // came back (saveWorkout / flushWorkoutSave): with a newer edit waiting,
  // the screen keeps its own, and moved here a detail changed elsewhere would
  // read as the Diary's own change on the next save, and be put back.
  if (saved?.workout) _setSnapshot(dateStr, saved.workout.id ?? sessionId, saved.workout);
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
// Bumped by loadWorkout/switchSession/startNewSession/deleteSession
// (issue #86): each captures the epoch at the moment saveWorkout() is
// called, and only applies its debounced result to todayLog if the
// epoch hasn't moved on since. Without this, a save still in its 350ms
// debounce (or its own network round trip) when the user switches to a
// different session/date resolves later and unconditionally overwrites
// todayLog with whatever IT saved (the session/date the user switched
// away from), undoing the switch a moment after it visibly happened:
// "the new workout shows for a second then vanishes again". Not done
// via clearTimeout() or nulling _latestEntry: either would stop that
// save's own setTimeout callback from ever running, leaving any
// `await saveWorkout()` caller (e.g. handleWorkoutAction('clear')
// awaiting its toast/reset) hanging forever, since nothing would ever
// resolve that promise. The epoch check only gates whether the RESULT
// gets applied locally; the save itself, and its promise, always
// complete normally.
let _epoch = 0;
// Moved when the account changes (resetWorkoutState): a save made under
// the previous one that fires afterwards is dropped, never sent under the
// next.
let _accountEpoch = 0;
// The epoch _latestEntry was stamped in, checked by BOTH the debounced
// timer callback below AND flushWorkoutSave (issue #86) -- a plain
// per-call closure variable would only guard the timer path, leaving
// flushWorkoutSave (App.pause / visibilitychange / pagehide) free to
// apply a stale result if it fires inside the same race window before
// the original 350ms timer does.
let _latestEntryEpoch = 0;
// A save waiting on its timer (what to answer its caller with), and one on
// its way to the server.
let _armed = null;
let _inFlight = null;
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
  // What this edit changed, against what was on screen just before it.
  const before = _shown && (_shown.id ?? null) === (stamped.id ?? null) ? _shown : null;
  _noteEdits(_snapshotKey(dateStr, stamped.id ?? null), before, stamped);
  todayLog.set(stamped);
  _latestEntry = stamped;
  _latestDate  = dateStr;
  _latestEntryEpoch = _epoch; // see the _epoch declaration above (issue #86)

  const account = _accountEpoch;
  return new Promise((resolve, reject) => {
    clearTimeout(_saveTimer);
    _armed = { resolve };
    _saveTimer = setTimeout(async () => {
      _armed = null;
      if (account !== _accountEpoch) { resolve(stamped); return; }
      const toSave = _latestEntry;
      const toSaveEpoch = _latestEntryEpoch;
      try {
        const sending = _mergeAndSave(dateStr, toSave);
        _inFlight = sending;
        const saved = await sending.finally(() => { if (_inFlight === sending) _inFlight = null; });
        // Only sync from server if no newer edits are queued, and the
        // user hasn't since switched to a different session/date.
        // A reply without the saved workout keeps what is on screen rather
        // than blanking the Diary (issue #102).
        if (_latestEntry === toSave && toSaveEpoch === _epoch && saved?.workout) {
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
        resolve(saved?.workout ?? toSave);
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
  // The save whose timer this replaces still answers whoever is waiting on it.
  const armed = _armed;
  _armed = null;
  const toSave = _latestEntry;
  const toSaveEpoch = _latestEntryEpoch; // see the _epoch declaration above (issue #86)
  let saved = null;
  try {
    saved = await _mergeAndSave(date, toSave);
    if (_latestEntry === toSave && toSaveEpoch === _epoch && saved?.workout) {
      todayLog.set(saved.workout);
      currentSessionId.set(saved.workout?.id ?? null);
      loadWorkoutSessions(date).catch(() => {});
      // Clear so re-firing lifecycle handlers can't re-save the same
      // already-flushed entry. See saveWorkout for the full rationale.
      _latestEntry = null;
      _latestDate  = null;
    }
  } catch {}
  armed?.resolve(saved?.workout ?? toSave);
}

/** The account changed: nothing of the last one's workout stays on show,
 *  and a save of it still waiting is dropped (its promise still resolves). */
export function resetWorkoutState() {
  _accountEpoch++;
  _epoch++;
  _latestEntry = null;
  _latestDate = null;
  _snapshotByDate.clear();
  _editsByKey.clear();
  todayLog.set(null);
  todaySessions.set([]);
  currentSessionId.set(null);
  activeProgram.set(null);
  todayPrescription.set(null);
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
