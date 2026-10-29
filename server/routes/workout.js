import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { onWorkoutCompleted } from '../lib/coach-activity.js';
import { afterWatchFinish } from '../lib/watch-finish.js';
import { mergeExercises, ensureExerciseUuids, changedUuidsOf } from '../lib/workout-merge.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { exerciseHistory } from '../lib/exercise-history.js';
import { getWorkoutCore } from '../lib/mcp/tools/get-workout.js';
import { isHistoryUpload, recordsBeforeSave, sendNewRecords } from '../lib/log-webhooks.js';
import { getActiveProgramCore } from '../lib/mcp/tools/get-active-program.js';
import { cleanWorkoutRefs, workoutProgramVisible } from '../lib/program-access.js';
import { answerGone, createdBefore, rememberCreated, rowForKey } from '../lib/create-keys.js';
import { applyToBody, deleteLoses, refuseDelete, stampMerged, createdTimes, editBringsBack, deletedTimes } from '../lib/newer-wins.js';
import { syncOf } from '../lib/sync-fields.js';

const router = Router();
router.use(requireAuth);

// Static routes MUST come before parameterized /:date routes

// GET /api/workout/recent — last N workout entries
router.get('/recent', wrap((req, res) => {
  // Up to 20,000: Trace reads that far back for a long range (aiTools.js).
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 30), 20000);
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM workout_log WHERE user_id IS NULL AND deleted_at IS NULL ORDER BY date DESC LIMIT ?').all(limit);
  for (const r of rows) r.exercises = JSON.parse(r.exercises || '[]');
  res.json(rows);
}));

// GET /api/workout/history/:exerciseId — all entries containing this exercise
router.get('/history/:exerciseId', wrap((req, res) => {
  res.json(exerciseHistory(uid(req), parseInt(req.params.exerciseId)));
}));

// Default-session lookup (issue #76): a date can now have multiple
// workout_log rows. Every route that doesn't take an explicit session
// selector picks the lowest session_seq (0 = the original/only session),
// falling back to the lowest id if session 0 was ever deleted — so a
// caller that never asks about sessions keeps hitting the one row that
// exists for anyone who's never created a second session. Mirrors PUT/
// DELETE's pre-#76 behavior of not filtering deleted_at, so a soft-deleted
// row can still be found/resurrected by an explicit save.
function _defaultWorkout(userId, date, { excludeDeleted = false } = {}) {
  const delClause = excludeDeleted ? 'AND deleted_at IS NULL' : '';
  return userId != null
    ? db.prepare(`SELECT * FROM workout_log WHERE date = ? AND user_id = ? ${delClause} ORDER BY session_seq ASC, id ASC LIMIT 1`).get(date, userId)
    : db.prepare(`SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL ${delClause} ORDER BY session_seq ASC, id ASC LIMIT 1`).get(date);
}

// Resolve which row a request targets: explicit ?id=/body.id wins (must
// still belong to this user + date, so a client can't cross-target
// another day's or another user's row), otherwise the default session.
//
// opts.fallbackToDefault (issue #87): an explicit id that does NOT
// resolve to a live row for this user+date -- a stale Android local
// id, a hard-to-refresh cached id after a delete, or a value that
// simply never existed here -- falls back to the live default session
// instead of the caller treating "not found" as "create one". Without
// this, a PUT/push carrying a slightly-stale id silently inserted a
// duplicate live session_seq=0 row: every completed-set tick or reps
// change whose cached id had drifted spawned a brand new workout tab.
// Off by default since a GET for a SPECIFIC unknown id should still
// report "not found" rather than silently substituting another
// session's data.
function _resolveWorkout(userId, date, explicitId, opts = {}) {
  if (explicitId != null) {
    const row = userId != null
      ? db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND date = ?').get(explicitId, userId, date)
      : db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id IS NULL AND date = ?').get(explicitId, date);
    if (row || !opts.fallbackToDefault) return row;
    return _defaultWorkout(userId, date, opts);
  }
  return _defaultWorkout(userId, date, opts);
}

function _enrichWorkout(workout, userId) {
  if (!workout) return workout;
  workout.exercises = JSON.parse(workout.exercises || '[]');
  // Surface the program's plan length alongside the stamped program_week so
  // the diary can render "Week N of M" without a second request. Only for a
  // program this account may see (or the one its prescribed day is from).
  if (workout.program_id) {
    const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(workout.program_id);
    workout.program_duration_weeks = program && workoutProgramVisible(userId, program.id, workout.template_id)
      ? program.duration_weeks ?? null : null;
  }
  // Include any coach feedback left on this workout so the member's diary
  // can render it inline (workout-level banner + per-exercise notes).
  workout.feedback = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.exercise_uuid, cf.note, cf.updated_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(workout.id);
  return workout;
}

// GET /api/workout/:date/feedback — coach notes attached to that day's
// workout. Returned separately from the workout GET because the diary
// workout GET is served local-first in native+server mode (cached in
// local SQLite which doesn't have the coach_feedback table), so feedback
// would be invisible until a cache miss. This path is NOT in the local-
// first pattern list, so the client always reaches the server when
// online and renders feedback fresh. Optional ?id= targets a specific
// session; default is the same session GET /:date would return.
router.get('/:date/feedback', wrap((req, res) => {
  const userId = uid(req);
  if (userId == null) return res.json([]);
  const explicitId = req.query.id != null ? parseInt(req.query.id) : null;
  const workout = _resolveWorkout(userId, req.params.date, explicitId, { excludeDeleted: true });
  if (!workout) return res.json([]);
  const rows = db.prepare(`
    SELECT cf.id, cf.trainer_id, cf.exercise_idx, cf.exercise_uuid, cf.note, cf.updated_at,
           cf.seen_by_member_at, cf.member_reply, cf.member_replied_at,
           COALESCE(u.nickname, u.full_name, u.username) AS trainer_name,
           u.avatar_url AS trainer_avatar_url
      FROM coach_feedback cf
      LEFT JOIN users u ON u.id = cf.trainer_id
     WHERE cf.workout_id = ?
     ORDER BY cf.updated_at DESC
  `).all(workout.id);
  // Intentionally NOT auto-marking seen here. The inbox badge needs to
  // persist until the member acts on it; auto-marking on every diary
  // load (which fires on every date switch + sync tick) cleared the
  // unread count before the user could ever see it.
  res.json(rows);
}));

// GET /api/workout/:date/sessions — every session logged that date
// (issue #76), each enriched exactly like the single-session GET below.
// Excludes soft-deleted rows — a deleted session isn't something a
// session-switcher UI should ever offer to switch to.
router.get('/:date/sessions', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC').all(date, userId)
    : db.prepare('SELECT * FROM workout_log WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC').all(date);
  res.json({ sessions: rows.map(w => _enrichWorkout(w, userId)) });
}));

// GET /api/workout/:date — returns the default session (issue #76: a
// date may have more than one; session-aware callers use the
// /:date/sessions list above, or pass ?id= for a specific one — e.g.
// stores/workout.js's _mergeAndSave safety-refetch, which must re-fetch
// the SAME session it's about to save over, not silently fall back to
// the default when the client is actively editing a non-default one).
// Zero response-shape change for every existing caller when there's
// exactly one session that date and no ?id= is given.
router.get('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const explicitId = req.query.id != null ? parseInt(req.query.id) : null;
  const workout = explicitId != null
    ? _resolveWorkout(userId, date, explicitId, { excludeDeleted: true })
    : _defaultWorkout(userId, date, { excludeDeleted: true });
  res.json({ workout: _enrichWorkout(workout, userId) || null });
}));

// ── Tombstone helpers (Option C) ─────────────────────────────────────────
// Loaded here rather than in a shared module to keep this route file
// self-contained; sync.js and _workout-write.js have their own copies for
// the same reason. Scoped by workout_id (issue #76) so a deletion
// tombstone applies to one session, not every session on that date — 0 is
// the sentinel for tombstone kinds with no specific row (matches the
// column's own NOT NULL DEFAULT 0 in db.js).
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
function _loadTombstones(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT kind, ex_uuid, uuid, deleted_at FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ?`);
  return u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
}

// PUT /api/workout/:date — save/update
//
// Merge semantics (Option C, 2026-08-11 port from NutriTrace): the
// exercises array is now merged per-uuid rather than replaced wholesale,
// and each exercise's sets[] is merged per-uuid too. Prior behavior
// wiped a full workout session when a stale mobile client PUT an empty
// exercises array — that DELETE-on-empty shortcut is removed; day-level
// deletion now requires an explicit `DELETE /api/workout/:date`. See
// project_traceapps_diary_merge_port for the shared design.
router.put('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const { id: bodyId, new_session } = req.body;

  // Parse per-uuid deletions in either shape (per-kind object or a flat
  // exercise-only list from an older client).
  const deletedRaw = req.body.deleted_uuids;
  const deletedExUuids = Array.isArray(deletedRaw?.exercises) ? deletedRaw.exercises
    : Array.isArray(deletedRaw) ? deletedRaw
    : [];
  const deletedSetsByEx = (deletedRaw && typeof deletedRaw.sets === 'object' && !Array.isArray(deletedRaw.sets))
    ? deletedRaw.sets
    : {};

  // Resolve the target row (issue #76). new_session:true always creates a
  // fresh row, bypassing the existing-row lookup entirely, so "start a
  // new session" can never accidentally land on one that already exists.
  // Otherwise an explicit id targets that specific session; absent both,
  // the default-session lookup reproduces pre-#76 single-row behavior
  // exactly (including resurrecting a soft-deleted row on save).
  //
  // fallbackToDefault + excludeDeleted (issue #87): a bodyId that is
  // stale/unknown falls back to the live default session for this date
  // rather than being treated as "create a new one" -- excludeDeleted
  // so a soft-deleted session isn't silently resurrected by a client
  // that no longer has a specific id in mind (that's what the resurrect-
  // on-save behavior just below is for, and it only applies to an EXACT
  // id match, a client that still knows precisely which row it means).
  // A new session sent again after its answer was lost saves into the
  // session it made rather than starting another (create-keys.js).
  const madeBefore = new_session ? createdBefore(req, userId, 'workout_log') : null;
  if (madeBefore?.gone) return answerGone(res);
  const existing = madeBefore && Number(madeBefore.user_id ?? -1) === Number(userId ?? -1) && madeBefore.date === date
    ? madeBefore
    : new_session ? null : _resolveWorkout(userId, date, bodyId ?? null, { fallbackToDefault: true, excludeDeleted: true });
  // The newer edit of each of the session's own fields stays
  // (lib/newer-wins.js); its program, program workout and week go together.
  // The exercises and sets merge one by one, as before. Which details the
  // save changed: X-Changed-Fields, or for a save made just now (no
  // X-Edited-At) the app's own list in the body, `changed_fields` (servers
  // before this one refused that header from the Android app, index.js).
  // A detail it only passed along, from a copy older than the server's
  // (Android reads its own), then doesn't count as changed, so it can't put
  // back a workout just finished on the watch. A queued save says what it
  // changed in the header, or counts everything it sends when it can't
  // (src/lib/offline-edits.js), and its body's list is not used.
  // A save queued before the workout was deleted elsewhere doesn't bring it
  // back (lib/field-sync.js): it's answered as gone, as a create repeated
  // after its row was deleted is, and the device drops it. One made after
  // the delete, or now (online, or an app that doesn't say when), does.
  if (existing?.deleted_at && !editBringsBack(req, existing)) return res.status(410).json({ error: 'Deleted after this change was made', gone: true });
  const body = { ...req.body };
  const listed = !req.get('x-edited-at') && Array.isArray(req.body.changed_fields) ? req.body.changed_fields : null;
  let fieldTimesNext = applyToBody(req, existing, body, {
    ...syncOf('workout_log'),
    current: f => existing[f],
    changed: listed,
  });
  // Brought back: when, so a delete made before this can't win over it.
  if (existing?.deleted_at) fieldTimesNext = stampMerged(req, fieldTimesNext, ['deleted_at']);
  if (Array.isArray(body.exercises) || body.deleted_uuids) fieldTimesNext = stampMerged(req, fieldTimesNext, ['exercises']);
  const { name, notes, duration_min, completed, program_week } = body;
  // Only a program, day and exercises this account may see (program-access.js).
  const { template_id, program_id, exercises } = cleanWorkoutRefs(userId, body, existing);
  // Note (issue #85): serverExercises is intentionally NOT pre-backfilled
  // with ensureExerciseUuids. See templates.js's PUT route and
  // workout-merge.js's mergeEntries() for why -- pre-tagging here would
  // defeat mergeEntries()'s own uuid-less-server bootstrap.
  const serverExercises = existing ? JSON.parse(existing.exercises || '[]') : [];

  const priorExTombstones  = existing ? _loadExerciseTombstoneUuids(userId, date, existing.id) : [];
  const priorSetTombstones = existing ? _loadSetTombstoneUuidsByExercise(userId, date, existing.id) : {};

  const {
    merged: mergedExercises,
    newTombstoneExerciseUuids: newExTombstones,
    newTombstoneSetUuidsByExercise: newSetTombstones,
  } = mergeExercises(
    serverExercises, ensureExerciseUuids(exercises || []),
    deletedExUuids, priorExTombstones,
    deletedSetsByEx, priorSetTombstones,
    changedUuidsOf(req.body.changed_uuids)
  );

  // Insert-if-new; otherwise UPDATE. An empty merged list is still a
  // legitimate state (e.g. new day where the client only pushed
  // metadata); it no longer triggers row deletion. The explicit
  // `DELETE /api/workout/:date` route below handles day-level deletion.
  const wasCompleted = existing ? !!existing.completed : false;
  const exercisesJson = JSON.stringify(mergedExercises);

  // pr.set / program.advanced webhook snapshots (issue #79), taken
  // BEFORE the transaction below so the "before" state genuinely
  // predates this save. pr.set is independent of the day-level
  // `completed` flag: a set can be completed even if the workout as a
  // whole isn't marked done, and that's still a real PR the moment it's
  // saved. Cheap early-exit guard (hasQualifyingSet) so a save that only
  // edits notes or duration never pays for a full-history records scan.
  // The same snapshot and comparison logSetCore (MCP, REST) uses, in
  // lib/log-webhooks.js. The app's Upload of a phone's history sends none
  // of this save's webhooks (isHistoryUpload): it is history, not a log.
  const _historyUpload = isHistoryUpload(req);
  const _recordsBefore = _historyUpload ? null : recordsBeforeSave(userId, exercises);
  // program.advanced only matters when this session belongs to a
  // program at all; the actual week comparison happens after the save,
  // nested in the completed 0-to-1 transition below, since session
  // count (and therefore current week) only changes on a newly-
  // completed session.
  let _programBefore = null;
  if (program_id && !_historyUpload) {
    try { _programBefore = getActiveProgramCore(userId); } catch { _programBefore = null; }
  }

  const insertTombstone = db.prepare(
    `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );

  let targetId;
  db.transaction(() => {
    if (existing) {
      targetId = existing.id;
      // Clear deleted_at on save so an explicit UPDATE resurrects a
      // row that a client had previously soft-deleted (sync-push at
      // sync.js line 368). Without this, GETs would keep filtering it
      // out even after the user re-adds a workout on that date.
      db.prepare(
        `UPDATE workout_log SET template_id=?, program_id=?, name=?, exercises=?, notes=?, duration_min=?, completed=?, program_week=?, deleted_at=NULL, field_times=?
         WHERE id=?`
      ).run(template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null, fieldTimesNext, existing.id);
    } else {
      // A brand-new row: either the very first session for this date
      // (default path, session_seq=0 — identical to pre-#76 behavior) or
      // an explicit additional session (new_session:true, next
      // session_seq for this date).
      const seqRow = new_session
        ? (userId != null
            ? db.prepare('SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE date = ? AND user_id = ?').get(date, userId)
            : db.prepare('SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE date = ? AND user_id IS NULL').get(date))
        : null;
      const nextSeq = seqRow ? seqRow.n : 0;
      const info = db.prepare(
        `INSERT INTO workout_log (user_id, date, template_id, program_id, name, exercises, notes, duration_min, completed, program_week, session_seq, field_times)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, date, template_id || null, program_id || null, name || null, exercisesJson, notes || null, duration_min || null, completed ? 1 : 0, program_week ?? null, nextSeq, createdTimes(req));
      targetId = info.lastInsertRowid;
      if (new_session) rememberCreated(req, userId, 'workout_log', targetId);
    }
    for (const uuid of newExTombstones) insertTombstone.run(userId, date, targetId, 'exercise', '', uuid);
    for (const [exUuid, uuids] of Object.entries(newSetTombstones)) {
      for (const uuid of uuids) insertTombstone.run(userId, date, targetId, 'set', exUuid, uuid);
    }
  })();

  const workout = _enrichWorkout(db.prepare('SELECT * FROM workout_log WHERE id = ?').get(targetId), userId);

  // Fire coach activity / push for prescribed workouts when the save flips
  // the row to completed. Idempotent on the DB side via UNIQUE(prescription_id,
  // kind), so a reopen + refinish still only fires once. The app's Upload of
  // a phone's history still records it for the coach's feed, on its day and
  // already read, without a push.
  if (workout && workout.completed && !wasCompleted) {
    try { onWorkoutCompleted(workout, { history: _historyUpload }); }
    catch (e) { /* never let a notification failure block the save */ }

    // Finished on the watch: the notification and the NutriTrace calories
    // the phone sends when it finishes a workout, sent from here since the
    // watch can't (lib/watch-finish.js). After the answer, never holding it.
    if (req.body.finished_on === 'watch') {
      setImmediate(() => { afterWatchFinish(userId, workout).catch(() => {}); });
    }

    // workout.completed webhook (issue #79). Reuses getWorkoutCore so
    // the payload matches exactly what GET /api/v1/workouts/:date and
    // MCP's get_workout tool already return, one shape everywhere.
    if (!_historyUpload) {
      try { dispatchWebhookEvent(userId, 'workout.completed', getWorkoutCore(userId, { date })); }
      catch (e) { /* never let a webhook failure block the save */ }
    }

    // program.advanced webhook (issue #79). Only meaningful when this
    // session belongs to the program that was active before the save
    // (_programBefore, snapshotted above). Comparing current_week here
    // (not before the save) is deliberate: session count, and therefore
    // current_week, only changes once this save has actually committed. A
    // calendar program can move on here too: training on an excused day
    // gives back the day it paused (issue #121).
    if (_programBefore?.active && _programBefore.program_id === program_id) {
      try {
        const programAfter = getActiveProgramCore(userId);
        if (programAfter?.active && programAfter.current_week !== _programBefore.current_week) {
          dispatchWebhookEvent(userId, 'program.advanced', {
            program_id: programAfter.program_id,
            program_name: programAfter.name,
            previous_week: _programBefore.current_week,
            new_week: programAfter.current_week,
            duration_weeks: programAfter.duration_weeks,
          });
        }
      } catch (e) { /* never let a webhook failure block the save */ }
    }
  }

  // pr.set webhook (issue #79). Independent of the completed 0-to-1
  // transition above, see the _recordsBefore snapshot's own comment for
  // why. Once per exercise whose record improved on this save; never
  // throws, so a webhook failure can't block the save.
  sendNewRecords(userId, date, _recordsBefore);

  res.json({ workout, tombstones: _loadTombstones(userId, date, targetId) });
}));

// DELETE /api/workout/:date — explicit day-level deletion. Optional ?id=
// targets a specific session (issue #76); absent, deletes the same
// default session GET /:date would return — if an old client that has no
// concept of a second session fires this on a date that now has several,
// deleting only the default one (not all of them) is the conservative
// behavior; silently wiping sessions that client doesn't know exist would
// be far worse.
//
// Replaces the old "empty exercises array on PUT deletes the row"
// shortcut, which was the shape that let a stale mobile client wipe an
// entire workout session under the pre-merge behavior. Now day-level
// deletion is an explicit intent, not something the server can infer
// from an accidentally-empty payload.
router.delete('/:date', wrap((req, res) => {
  const { date } = req.params;
  const userId = uid(req);
  const explicitId = req.query.id != null ? parseInt(req.query.id) : null;
  // Without an id, delete the first LIVE session: the first row overall can
  // be one deleted earlier, which left the session on screen untouched.
  const existing = _resolveWorkout(userId, date, explicitId, { excludeDeleted: true });
  return _deleteWorkout(req, res, existing);
}));

// DELETE /api/workout/by-key/:key  the session a new_session save with this
// client_key made, deleted before its maker learned its id (create-keys.js
// rowForKey). Made by no save yet: one arriving later makes nothing.
router.delete('/by-key/:key', wrap((req, res) => {
  const userId = uid(req);
  const found = rowForKey(userId, 'workout_log', req.params.key);
  if (!found) return res.status(400).json({ error: 'client_key required' });
  const existing = found.id == null ? null : userId != null
    ? db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(found.id, userId)
    : db.prepare('SELECT * FROM workout_log WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL').get(found.id);
  return _deleteWorkout(req, res, existing, { by_key: true });
}));

function _deleteWorkout(req, res, existing, extra = {}) {
  if (!existing) return res.json({ ok: true, deleted: false, ...extra });
  // Deleted offline before an edit made elsewhere: the edit is newer, the
  // session stays (lib/newer-wins.js).
  const later = deleteLoses(req, existing);
  if (later) return refuseDelete(res, existing, later);
  // Soft delete (issue #87): a hard DELETE removed the row before any
  // client could ever pull it. /api/sync/pull finds deletions via
  // `WHERE updated_at >= ?`, which requires the row to still exist with
  // deleted_at set -- a hard-deleted row can never match that query, so
  // Android never learned the session was gone, and its next autosave
  // (still holding the now-unknown id) recreated it. Matches the same
  // soft-delete shape sync-push already uses when a client sends
  // deleted_at, and the PUT handler above already knows how to clear
  // deleted_at again on an explicit save to resurrect one.
  // With the delete's own time (an edit made before it can't bring it back).
  db.prepare(`UPDATE workout_log SET deleted_at = datetime('now'), updated_at = datetime('now'), field_times = ? WHERE id = ?`).run(deletedTimes(req, existing), existing.id);
  res.json({ ok: true, deleted: true, ...extra });
}

export default router;
