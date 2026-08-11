// Stable per-entry identity for the client side of the Option C merge
// (2026-08-11 port from NutriTrace). Every new exercise and every new
// set logged from the LT client gets a uuid at creation time, so the
// server-side merge in server/lib/workout-merge.js can tell "add this
// new one" from "update the existing one" from "preserve the one the
// client didn't mention". crypto.randomUUID is present on all modern
// browsers and Node ≥14; the fallback covers ancient WebViews.

export function newUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const rnd = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rnd()}${rnd()}-${rnd()}-${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

/**
 * Ensure every exercise (and each of its sets) has a uuid. Idempotent:
 * entries with existing uuids pass through untouched. Used defensively
 * in the store so an older cached entry that predates uuids doesn't
 * lose identity when it hits the server merge.
 */
export function ensureExerciseUuids(exercises) {
  if (!Array.isArray(exercises)) return exercises;
  let changed = false;
  const out = exercises.map(ex => {
    if (!ex || typeof ex !== 'object') return ex;
    let next = ex;
    if (!ex.uuid || typeof ex.uuid !== 'string') {
      next = { ...ex, uuid: newUuid() };
      changed = true;
    }
    if (Array.isArray(ex.sets)) {
      let setsChanged = false;
      const sets = ex.sets.map(s => {
        if (!s || typeof s !== 'object') return s;
        if (s.uuid && typeof s.uuid === 'string') return s;
        setsChanged = true;
        return { ...s, uuid: newUuid() };
      });
      if (setsChanged) { next = { ...next, sets }; changed = true; }
    }
    return next;
  });
  return changed ? out : exercises;
}

/**
 * Compute the deleted_uuids payload by diffing `nextExercises` (what
 * the client is about to push) against `snapshotExercises` (the last
 * known server-authoritative copy). Exercises present in the snapshot
 * but absent from next → tombstoned. Sets present on a shared exercise
 * in snapshot but absent from next → tombstoned under that exercise's
 * uuid.
 *
 * Callers pass this alongside the exercises array to the API. Without
 * it, the server-side merge preserves the "missing" entries (that's the
 * safe default that fixes the wipe bug — but it means genuine deletes
 * also silently fail to sync unless we address them explicitly).
 */
export function diffTombstones(snapshotExercises, nextExercises) {
  const snap = Array.isArray(snapshotExercises) ? snapshotExercises : [];
  const next = Array.isArray(nextExercises) ? nextExercises : [];

  const nextExUuids = new Set(next.filter(e => e?.uuid).map(e => e.uuid));
  const nextByUuid = new Map(next.filter(e => e?.uuid).map(e => [e.uuid, e]));

  const deletedExUuids = [];
  const deletedSetsByEx = {};

  for (const ex of snap) {
    if (!ex?.uuid) continue;
    if (!nextExUuids.has(ex.uuid)) {
      deletedExUuids.push(ex.uuid);
      // (Sets under a deleted exercise don't need their own tombstones —
      // the exercise tombstone already drops the whole thing.)
      continue;
    }
    // Exercise survived — diff sets.
    const nextEx = nextByUuid.get(ex.uuid);
    const nextSetUuids = new Set(
      (Array.isArray(nextEx?.sets) ? nextEx.sets : [])
        .filter(s => s?.uuid).map(s => s.uuid)
    );
    const removedSets = [];
    for (const s of (Array.isArray(ex.sets) ? ex.sets : [])) {
      if (s?.uuid && !nextSetUuids.has(s.uuid)) removedSets.push(s.uuid);
    }
    if (removedSets.length) deletedSetsByEx[ex.uuid] = removedSets;
  }

  return { exercises: deletedExUuids, sets: deletedSetsByEx };
}
