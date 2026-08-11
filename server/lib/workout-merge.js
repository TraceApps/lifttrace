import { randomUUID } from 'crypto';

// Per-entry merge for workout exercises + sets, program templates, and
// body-stat keys. Mirrors NutriTrace's server/lib/diary-merge.js
// (landed 2026-08-11 as commit 33dd812 on nutritrace dev) — same class
// of bug, same fix: prior implementation of PUT /api/workout/:date and
// POST /api/sync/push blob-replaced the exercises array wholesale, so
// any stale client push could silently wipe a full workout session.
// Worse in LT than NT: an empty exercises array on the workout PUT
// used to DELETE the row outright. New behavior preserves everything
// the client didn't address explicitly.
//
// See project_traceapps_diary_merge_port memory + project_nutritrace_
// diary_persist_gap for the incident history that motivated this.

function _tsOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.updatedAt || entry.updated_at || entry.completedAt || entry.addedAt || '');
}

function _dedupe(entries, tombstoneSet) {
  const byUuid = new Map();
  for (let entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    let uuid = entry.uuid;
    if (!uuid || typeof uuid !== 'string') {
      uuid = randomUUID();
      entry = { ...entry, uuid };
    }
    if (tombstoneSet.has(uuid)) continue;
    const existing = byUuid.get(uuid);
    if (!existing || _tsOf(entry) >= _tsOf(existing)) {
      byUuid.set(uuid, entry);
    }
  }
  return Array.from(byUuid.values());
}

/**
 * Core merge routine. Given a server-side entry list and a client-side
 * entry list plus explicit deletions and prior tombstones, produce a
 * merged output that never accidentally loses server-side entries the
 * client didn't address.
 *
 *   - Anything in tombstoneSet (prior tombstones + this-write's
 *     deleted_uuids) is dropped.
 *   - Server entries survive by default; only leave via a tombstone.
 *   - Client entries: new uuid → add; existing uuid → later-timestamp
 *     wins; tombstoned uuid → dropped (do not resurrect).
 *
 * @returns {{merged: Array, newTombstoneUuids: string[]}}
 */
export function mergeEntries(serverEntries, clientEntries, deletedUuids, tombstoneUuids) {
  const server = Array.isArray(serverEntries) ? serverEntries : [];
  const client = Array.isArray(clientEntries) ? clientEntries : [];
  const deleted = Array.isArray(deletedUuids) ? deletedUuids.filter(x => typeof x === 'string' && x) : [];
  const priorTombstones = Array.isArray(tombstoneUuids) ? tombstoneUuids : [];

  const tombstoneSet = new Set([...priorTombstones, ...deleted]);

  const serverDeduped = _dedupe(server, tombstoneSet);
  const serverByUuid = new Map(serverDeduped.map(e => [e.uuid, e]));

  for (let entry of client) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.uuid || typeof entry.uuid !== 'string') {
      entry = { ...entry, uuid: randomUUID() };
    }
    if (tombstoneSet.has(entry.uuid)) continue;
    const existing = serverByUuid.get(entry.uuid);
    if (!existing || _tsOf(entry) >= _tsOf(existing)) {
      serverByUuid.set(entry.uuid, entry);
    }
  }

  return {
    merged: Array.from(serverByUuid.values()),
    newTombstoneUuids: deleted.filter(u => !priorTombstones.includes(u)),
  };
}

/**
 * Two-level merge for the exercises→sets shape specific to LT. Applies
 * mergeEntries at the exercise layer, then for each surviving exercise
 * that also appears on the client side, applies mergeEntries to its
 * sets[] using the exercise-level tombstones for that exercise.
 *
 * @param {Array} serverExercises
 * @param {Array} clientExercises
 * @param {string[]} deletedExerciseUuids
 * @param {string[]} tombstonedExerciseUuids
 * @param {Object.<string, string[]>} deletedSetUuidsByExercise - keyed by exercise uuid
 * @param {Object.<string, string[]>} tombstonedSetUuidsByExercise
 */
export function mergeExercises(
  serverExercises, clientExercises,
  deletedExerciseUuids, tombstonedExerciseUuids,
  deletedSetUuidsByExercise = {}, tombstonedSetUuidsByExercise = {}
) {
  // Exercise-level merge first — decides who's in the workout.
  const exResult = mergeEntries(
    serverExercises, clientExercises,
    deletedExerciseUuids, tombstonedExerciseUuids
  );

  // For each surviving exercise: if the client also had this exercise,
  // merge its sets. Otherwise it's server-only or client-only and its
  // sets pass through unchanged.
  const clientByUuid = new Map();
  for (const ex of (clientExercises || [])) {
    if (ex?.uuid) clientByUuid.set(ex.uuid, ex);
  }
  const serverByUuid = new Map();
  for (const ex of (serverExercises || [])) {
    if (ex?.uuid) serverByUuid.set(ex.uuid, ex);
  }

  const newSetTombstonesByExercise = {};
  const mergedExercises = exResult.merged.map(ex => {
    const clientEx = clientByUuid.get(ex.uuid);
    const serverEx = serverByUuid.get(ex.uuid);
    if (!clientEx || !serverEx) {
      // Server-only or client-only: keep the sets as-is; ensure uuids.
      const sets = Array.isArray(ex.sets) ? ex.sets.map(s =>
        (s && typeof s === 'object' && !s.uuid) ? { ...s, uuid: randomUUID() } : s
      ) : [];
      return { ...ex, sets };
    }
    // Both sides have this exercise: merge its sets.
    const deletedSetUuids = deletedSetUuidsByExercise[ex.uuid] || [];
    const priorSetTombstones = tombstonedSetUuidsByExercise[ex.uuid] || [];
    const setResult = mergeEntries(
      serverEx.sets || [], clientEx.sets || [],
      deletedSetUuids, priorSetTombstones
    );
    if (setResult.newTombstoneUuids.length) {
      newSetTombstonesByExercise[ex.uuid] = setResult.newTombstoneUuids;
    }
    return { ...ex, sets: setResult.merged };
  });

  return {
    merged: mergedExercises,
    newTombstoneExerciseUuids: exResult.newTombstoneUuids,
    newTombstoneSetUuidsByExercise: newSetTombstonesByExercise,
  };
}

/**
 * Per-key merge for a flat object (used for body_stats_log.stats).
 * Empty incoming object preserves everything; incoming keys with
 * defined values overwrite; incoming keys explicitly set to null are
 * treated as deletions (user cleared that stat).
 *
 * Simpler than the array merge because keys ARE the identity — no
 * uuids needed.
 */
export function mergeStatsObject(serverStats, clientStats) {
  const server = (serverStats && typeof serverStats === 'object') ? serverStats : {};
  const client = (clientStats && typeof clientStats === 'object') ? clientStats : {};
  const out = { ...server };
  for (const [k, v] of Object.entries(client)) {
    if (v === null) delete out[k];   // explicit clear
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Ensure every entry in `list` has a uuid, mutating a copy (not the
 * caller's array). Idempotent. Recursive for exercises (also stamps
 * uuid on each set).
 */
export function ensureExerciseUuids(list) {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out = list.map(ex => {
    if (!ex || typeof ex !== 'object') return ex;
    let next = ex;
    if (!ex.uuid || typeof ex.uuid !== 'string') {
      next = { ...ex, uuid: randomUUID() };
      changed = true;
    }
    if (Array.isArray(ex.sets)) {
      let setsChanged = false;
      const sets = ex.sets.map(s => {
        if (!s || typeof s !== 'object') return s;
        if (s.uuid && typeof s.uuid === 'string') return s;
        setsChanged = true;
        return { ...s, uuid: randomUUID() };
      });
      if (setsChanged) {
        next = { ...next, sets };
        changed = true;
      }
    }
    return next;
  });
  return changed ? out : list;
}

export function ensureUuids(list) {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out = list.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.uuid && typeof entry.uuid === 'string') return entry;
    changed = true;
    return { ...entry, uuid: randomUUID() };
  });
  return changed ? out : list;
}
