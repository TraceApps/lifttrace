/**
 * deleted-rows.js: an edit meeting a workout, exercise, program or workout
 * day that was deleted elsewhere. The app deletes programs, days and
 * exercises outright; a third-party client's POST /api/sync/push with
 * deleted_at, or a restored backup that holds one, leaves the row there with
 * deleted_at set. An edit then brings it back or finds it gone, as a body-
 * stats day does (lib/newer-wins.js editBringsBack): made before the delete
 * (or in its own second) it is dropped, made after it (or now) the row is
 * back, and its fields are decided against the row as it was deleted.
 *
 * A day belongs to its program. A deleted day is brought back only by an
 * edit later than its own delete and, when its program is deleted too, than
 * the program's delete, and then the program comes back with it: a day
 * brought back under a deleted program would be an orphan no device shows.
 * A new day in a deleted program is met the same way. A day that is alive
 * keeps taking edits whatever its program (a pushed delete of a program
 * leaves its days as they are, as it always did); one made after the
 * program's delete brings the program back. A program brought back by an
 * edit of its own brings back nothing else: its days keep their own state.
 */
import db from '../db.js';
import { editBringsBack, fieldTimes, stampMerged, toMs } from './newer-wins.js';
import { isoTime } from './field-sync.js';

/**
 * What an edit of `day` (null: a new day) in `program` meets.
 * { ok: false } when it was made before a delete it has to beat (or in the
 * same second): nothing is written. Otherwise `day` and `program` say which
 * of the two rows it brings back.
 */
export function dayEditMeets(req, day, program) {
  const dayGone = !!day?.deleted_at;
  const progGone = !!program?.deleted_at;
  if (!dayGone && !progGone) return { ok: true, day: false, program: false };
  const beatsProgram = !progGone || editBringsBack(req, program);
  // A live day keeps its edits; only a later one brings its program back.
  if (day && !dayGone) return { ok: true, day: false, program: progGone && beatsProgram };
  const ok = (!dayGone || editBringsBack(req, day)) && beatsProgram;
  return { ok, day: ok && dayGone, program: ok && progGone };
}

/**
 * A row's field_times with every field counted from somewhere: a row with
 * none yet counts them from its updated_at, one with times but no `_base`
 * from when it was made (routes/sync.js pushTimes, the same).
 */
export function countedTimes(row) {
  const t = fieldTimes(row);
  const at = v => { const ms = toMs(v); return Number.isFinite(ms) ? isoTime(ms) : null; };
  if (!Object.keys(t).length) { if (at(row?.updated_at)) t._base = at(row.updated_at); }
  else if (!t._base && at(row?.created_at ?? row?.updated_at)) t._base = at(row.created_at ?? row.updated_at);
  return t;
}

/**
 * The times an edit that brings back `row` is decided against: its own, with
 * every field not changed since counting from the delete at the latest. A
 * restored backup moves updated_at to the restore, and a row that was
 * touched has a later one still; neither makes an edit made after the delete
 * older than the row's content.
 */
export function timesAtDelete(row) {
  const t = countedTimes(row);
  if (!row?.deleted_at) return t;
  const stamp = toMs(t.deleted_at);
  const del = Number.isFinite(stamp) ? stamp : toMs(row.deleted_at);
  const base = toMs(t._base);
  if (Number.isFinite(del) && (!Number.isFinite(base) || base > del)) t._base = isoTime(del);
  return t;
}

/** Bring a deleted program back for an edit of one of its days: live
 *  again, stamped with the edit's time so a delete made before it loses,
 *  and touched so devices get it. Nothing else of it changes. */
export function bringProgramBack(req, program) {
  db.prepare(`UPDATE programs SET deleted_at = NULL, field_times = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(stampMerged(req, JSON.stringify(timesAtDelete(program)), ['deleted_at']), program.id);
}

/** Touch the rows an edit found deleted (and left deleted), so the device
 *  that sent it gets them as deleted with its next pull. Their times are
 *  kept as they count now: a touch moves updated_at, which a row with no
 *  times would otherwise count its fields from. */
export function touchDeleted(day, program) {
  if (day?.deleted_at) db.prepare(`UPDATE workout_templates SET updated_at = datetime('now'), field_times = ? WHERE id = ?`).run(JSON.stringify(countedTimes(day)), day.id);
  if (program?.deleted_at) db.prepare(`UPDATE programs SET updated_at = datetime('now'), field_times = ? WHERE id = ?`).run(JSON.stringify(countedTimes(program)), program.id);
}

/**
 * Whether an edit of setting `key` meets its reset (Clear All Settings,
 * DELETE /api/settings, kept in sync_deletions by db.js so the account's
 * phones go back to the default too) and loses to it: made before the reset
 * or in its second, or pushed with no readable time. One made after it, or
 * now, sets it again. False when the setting isn't reset.
 */
export function resetWins(req, userId, key) {
  if (userId == null) return false;
  const r = db.prepare(`SELECT deleted_at FROM sync_deletions WHERE tbl = 'user_settings' AND user_id = ? AND row_key = ?`).get(userId, key);
  return !!r && !editBringsBack(req, { deleted_at: r.deleted_at });
}
