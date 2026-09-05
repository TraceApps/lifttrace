/**
 * Shared workout-day mutation helper for MCP write tools (issue #78).
 *
 * Mirrors server/routes/workout.js's PUT /:date handler exactly — same
 * Option C per-uuid merge (server/lib/workout-merge.js), same tombstone
 * bookkeeping, same "any write resurrects a soft-deleted row" policy —
 * so an MCP write can't behave differently from a save made in the app.
 * Loaded here rather than exported from workout.js to keep that route
 * file self-contained, matching how server/routes/sync.js already keeps
 * its own copy of the same tombstone helpers.
 *
 * The mutator callback receives the day's CURRENT exercises array
 * (uuid-stamped) and returns the desired next array — most MCP tools
 * find-or-append one exercise/set, not replace the whole thing. Every
 * other workout_log column (name, notes, duration_min, template_id,
 * program_id, program_week, completed) passes through unchanged; no
 * current MCP tool needs to touch them, and narrowing the write surface
 * to exercises-only is the safer default.
 */
import db from '../../db.js';
import { mergeExercises, ensureExerciseUuids } from '../workout-merge.js';

// workoutId scopes a tombstone to one session vs another on the same
// date (issue #76) — matches the column's own NOT NULL DEFAULT 0 in
// db.js.
function _tsWhere(u) { return u == null ? 'user_id IS NULL' : 'user_id = ?'; }
function _loadExerciseTombstoneUuids(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'exercise'`);
  const rows = u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
  return rows.map(r => r.uuid);
}
function _loadSetTombstoneUuidsByExercise(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'set'`);
  const rows = u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
  const out = {};
  for (const r of rows) {
    (out[r.ex_uuid] = out[r.ex_uuid] || []).push(r.uuid);
  }
  return out;
}

/**
 * Load a workout day, hand its current exercises array to `mutator`,
 * and save the merged result back. Runs inside a transaction so a
 * concurrent write (a PWA save landing mid-tool-call, or two MCP calls
 * in flight) serialises cleanly.
 *
 * @param {number|null} userId
 * @param {string}      date     YYYY-MM-DD
 * @param {function}    mutator  (exercises) => nextExercises
 * @returns {object} the final workout_log row, exercises already parsed
 */
export function mutateWorkoutDay(userId, date, mutator) {
  const tx = db.transaction(() => {
    // Default-session lookup (issue #76): a date can now have more than
    // one row. MCP tools don't expose session selection yet (unchanged
    // contract for phase 1), so this picks the same "session 0, or
    // lowest surviving" row GET /:date and the PUT route's default path
    // would — correct-by-default for every user who's never created a
    // second session, and deterministic if one exists.
    const existing = userId != null
      ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ? ORDER BY session_seq ASC, id ASC LIMIT 1').get(date, userId)
      : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1').get(date);
    const serverExercises = existing ? ensureExerciseUuids(JSON.parse(existing.exercises || '[]')) : [];

    const clientExercises = ensureExerciseUuids(mutator(serverExercises) || []);

    const priorExTombstones  = existing ? _loadExerciseTombstoneUuids(userId, date, existing.id) : [];
    const priorSetTombstones = existing ? _loadSetTombstoneUuidsByExercise(userId, date, existing.id) : {};

    const {
      merged: mergedExercises,
      newTombstoneExerciseUuids,
      newTombstoneSetUuidsByExercise,
    } = mergeExercises(
      serverExercises, clientExercises,
      [], priorExTombstones,
      {}, priorSetTombstones
    );

    const exercisesJson = JSON.stringify(mergedExercises);
    const insertTombstone = db.prepare(
      `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    let targetId;
    if (existing) {
      targetId = existing.id;
      // deleted_at=NULL resurrects a soft-deleted row on any write —
      // same policy as PUT /:date (LT v1.2.0, see CHANGELOG).
      db.prepare(
        `UPDATE workout_log SET exercises=?, deleted_at=NULL WHERE id=?`
      ).run(exercisesJson, existing.id);
    } else {
      const info = db.prepare(
        `INSERT INTO workout_log (user_id, date, exercises) VALUES (?, ?, ?)`
      ).run(userId, date, exercisesJson);
      targetId = info.lastInsertRowid;
    }
    for (const uuid of newTombstoneExerciseUuids) insertTombstone.run(userId, date, targetId, 'exercise', '', uuid);
    for (const [exUuid, uuids] of Object.entries(newTombstoneSetUuidsByExercise)) {
      for (const uuid of uuids) insertTombstone.run(userId, date, targetId, 'set', exUuid, uuid);
    }

    const row = db.prepare('SELECT * FROM workout_log WHERE id = ?').get(targetId);
    row.exercises = JSON.parse(row.exercises || '[]');
    return row;
  });
  return tx();
}
