import { writable, derived } from 'svelte/store';
import { localDateStr } from '../lib/db.js';
import { LtApi } from '../lib/api.js';

export const currentDate  = writable(localDateStr());
export const todayLog     = writable(null);    // full workout log entry for currentDate
export const activeProgram = writable(null);   // user's active program
export const todayPrescription = writable(null); // coach's prescription for currentDate

/** Load workout log for a specific date. Also pulls any coach prescription. */
export async function loadWorkout(dateStr) {
  const guard = dateStr;
  currentDate.set(dateStr);
  try {
    const data = await LtApi.getWorkout(dateStr);
    if (guard !== dateStr) return; // stale
    todayLog.set(data.workout || null);
  } catch {
    todayLog.set(null);
  }
  // Pull prescription in parallel (fire-and-forget, fails silently on single-user mode)
  try {
    const px = await LtApi.getMyPrescriptionForDate(dateStr);
    if (guard !== dateStr) return;
    todayPrescription.set(px || null);
  } catch {
    todayPrescription.set(null);
  }
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
  let server = null;
  try {
    const data = await LtApi.getWorkout(dateStr);
    server = data?.workout || null;
  } catch {}
  const toSave = server ? {
    ...server,
    ...clientEntry,
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
  } : clientEntry;
  return LtApi.saveWorkout(dateStr, toSave);
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
  // Optimistic local update — keeps UI in sync with user input instantly
  todayLog.set(entry);
  _latestEntry = entry;
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
    if (_latestEntry === toSave) todayLog.set(saved.workout);
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
