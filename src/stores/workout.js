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

/** Save/update workout log for current date.
 *  Optimistically updates todayLog immediately, then debounces the server
 *  save so rapid typing doesn't overwrite the input mid-keystroke. */
let _saveTimer;
let _latestEntry = null;
export function saveWorkout(dateStr, entry) {
  // Optimistic local update — keeps UI in sync with user input instantly
  todayLog.set(entry);
  _latestEntry = entry;

  return new Promise((resolve, reject) => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      const toSave = _latestEntry;
      try {
        const saved = await LtApi.saveWorkout(dateStr, toSave);
        // Only sync from server if no newer edits are queued
        if (_latestEntry === toSave) {
          todayLog.set(saved.workout);
        }
        resolve(saved.workout);
      } catch (e) { reject(e); }
    }, 350);
  });
}

/** Force-flush any pending save immediately (for navigation away, etc.) */
export async function flushWorkoutSave(dateStr) {
  if (!_latestEntry) return;
  clearTimeout(_saveTimer);
  const toSave = _latestEntry;
  try {
    const saved = await LtApi.saveWorkout(dateStr, toSave);
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
