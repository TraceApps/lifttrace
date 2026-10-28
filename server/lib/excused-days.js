/**
 * Excused days (issue #121): one row per account and date, with a reason
 * (injury, illness, appointment, other) and an optional note. The app's
 * routes (routes/excused-days.js), the sync pull, the coaching view, the
 * weekly summary, MCP and /api/v1 all read and write through here.
 *
 * Writes follow the newer edit (lib/newer-wins.js) like every other row a
 * device can change offline: a queued edit made before a later one made
 * elsewhere doesn't overwrite it, and a removal made before a later edit
 * loses to it. Removing keeps the row (deleted_at) so the removal reaches
 * the account's other devices on their next pull.
 */
import db from '../db.js';
import { applyToBody, createdTimes, deleteLoses, editedAt, fieldTimes } from './newer-wins.js';
import { cleanExcuse, isCalendarDate } from '../../src/lib/trained-day.js';

const FIELDS = ['reason', 'note'];

// A coach already told that a prescribed day was missed hears it as
// excused once the client excuses it, and as missed again if the excuse is
// removed: the feed and the prescription list then agree (issue #121).
function _relabelPrescriptions(userId, date, from, to) {
  if (userId == null) return;
  db.prepare(
    `UPDATE OR IGNORE coach_activity SET kind = ?
      WHERE kind = ? AND member_id = ?
        AND prescription_id IN (SELECT id FROM coach_prescriptions WHERE member_id = ? AND date = ?)`
  ).run(to, from, userId, userId, date);
}
const _who = (userId) => (userId == null ? 'user_id IS NULL' : 'user_id = ?');
const _args = (userId, ...rest) => (userId == null ? rest : [userId, ...rest]);

/** What a client sees of a row. */
export function excusedOut(row) {
  if (!row) return null;
  return { id: row.id, date: row.date, reason: row.reason, note: row.note ?? null, updated_at: row.updated_at };
}

function _row(userId, date) {
  return db.prepare(`SELECT * FROM excused_days WHERE ${_who(userId)} AND date = ?`).get(..._args(userId, date));
}

/** The account's excused days, oldest first, optionally from `start` to `end`. */
export function listExcusedDays(userId, { start = null, end = null } = {}) {
  const where = [_who(userId), 'deleted_at IS NULL'];
  const params = _args(userId);
  if (start) { where.push('date >= ?'); params.push(start); }
  if (end) { where.push('date <= ?'); params.push(end); }
  return db.prepare(`SELECT * FROM excused_days WHERE ${where.join(' AND ')} ORDER BY date ASC`).all(...params).map(excusedOut);
}

/** One date's excused day, or null. */
export function getExcusedDay(userId, date) {
  const row = _row(userId, date);
  return row && !row.deleted_at ? excusedOut(row) : null;
}

/** A Map date -> excused day for a range, for code that looks dates up. */
export function excusedByDate(userId, range = {}) {
  return new Map(listExcusedDays(userId, range).map(r => [r.date, r]));
}

/** Throws an Error with a message fit to show for a date that isn't one. */
export function checkDate(date) {
  if (!isCalendarDate(date)) throw new Error('date must be a calendar date, YYYY-MM-DD');
  return date;
}

const _noHeaders = { headers: {} };

/**
 * Excuse `date`, or change its reason or note. `req` carries the edit's time
 * and changed fields when a device queued it (X-Edited-At,
 * X-Changed-Fields); without them it was made now. Throws on a bad date,
 * reason or note. Returns { excused, created }.
 */
export function saveExcusedDay(userId, date, input, req = _noHeaders) {
  checkDate(date);
  const clean = cleanExcuse(input || {});
  const existing = _row(userId, date);
  const live = existing && !existing.deleted_at ? existing : null;
  if (!live) {
    // New, or excused again after it was removed: everything in it is this
    // edit's. A removal made later than this edit (elsewhere, while this
    // one waited offline) stands.
    if (existing?.deleted_at && fieldTimes(existing)._removed && Date.parse(fieldTimes(existing)._removed) > editedAt(req)) {
      return { excused: null, created: false, removedLater: true };
    }
    const times = createdTimes(req) || JSON.stringify(Object.fromEntries(FIELDS.map(f => [f, new Date(editedAt(req)).toISOString()])));
    if (existing) {
      db.prepare(`UPDATE excused_days SET reason = ?, note = ?, deleted_at = NULL, field_times = ? WHERE id = ?`)
        .run(clean.reason, clean.note, times, existing.id);
    } else {
      db.prepare(`INSERT INTO excused_days (user_id, date, reason, note, field_times) VALUES (?, ?, ?, ?, ?)`)
        .run(userId, date, clean.reason, clean.note, times);
    }
    _relabelPrescriptions(userId, date, 'prescription_missed', 'prescription_excused');
    return { excused: excusedOut(_row(userId, date)), created: true };
  }
  // Only the fields the request sent: a note left out stays as it is.
  const body = { reason: clean.reason };
  if (input && Object.prototype.hasOwnProperty.call(input, 'note')) body.note = clean.note;
  const times = applyToBody(req, live, body, { fields: FIELDS, current: f => live[f] });
  db.prepare(`UPDATE excused_days SET reason = ?, note = ?, field_times = ? WHERE id = ?`)
    .run(body.reason, body.note === undefined ? live.note : body.note, times, live.id);
  return { excused: excusedOut(_row(userId, date)), created: false };
}

/**
 * Remove `date`'s excused day. Returns { ok, removed } or, when the day was
 * changed elsewhere after this removal was made, { refused: true, changedAt,
 * excused } and the day stays.
 */
export function removeExcusedDay(userId, date, req = _noHeaders) {
  checkDate(date);
  const existing = _row(userId, date);
  if (!existing || existing.deleted_at) return { ok: true, removed: false };
  const later = deleteLoses(req, existing);
  if (later) return { refused: true, changedAt: later, excused: excusedOut(existing) };
  const times = { ...fieldTimes(existing), _removed: new Date(editedAt(req)).toISOString() };
  db.prepare(`UPDATE excused_days SET deleted_at = datetime('now'), field_times = ? WHERE id = ?`)
    .run(JSON.stringify(times), existing.id);
  _relabelPrescriptions(userId, date, 'prescription_excused', 'prescription_missed');
  return { ok: true, removed: true };
}
