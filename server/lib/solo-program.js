/**
 * The program being followed without user accounts (single-user mode).
 *
 * There is no program_assignments row then: app_config holds the program
 * (`active_program`), a week chosen by hand (`active_program_cursor`, JSON)
 * and, since issue #121, when it became the one followed
 * (`active_program_start`), so a calendar program moves a week every 7 days
 * from it and excused days pause it, as they do with accounts. Read by
 * routes/programs.js, the phone's pull (routes/sync.js), and the move to
 * and from accounts (claim-anonymous-data.js).
 *
 * The start is a SQLite UTC stamp ("2026-10-28 09:15:00") when the program
 * was started here, or a date ("2026-10-12") when it came from the evidence
 * below. programWeek.js reads either. It is the calendar clock only: how
 * many workouts count toward a program advanced by sessions is unchanged
 * (every one in the program, as before).
 */
import db from '../db.js';

const ACTIVE = 'active_program';
const CURSOR = 'active_program_cursor';
const START = 'active_program_start';

const _get = (key) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null;
const _set = (key, value) => db.prepare(
  'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, value);
const _del = (key) => db.prepare('DELETE FROM app_config WHERE key = ?').run(key);

/** The program followed, as an id, or null. */
export function soloActiveId() {
  const id = parseInt(_get(ACTIVE), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * A start for a program followed from before starts were kept (or restored
 * from a backup made then), by the best evidence there is. No activation
 * time was ever stored anywhere, so: the date of the first completed workout
 * from one of the program's days (it was being followed by then) since the
 * last one from any other program (a program followed again after another
 * counts from its latest run, not its first), else now. Never ahead of
 * today. Stored, so it is chosen once.
 */
function _backfillStart(programId) {
  const mine = 'template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)';
  const done = 'completed = 1 AND deleted_at IS NULL AND user_id IS NULL';
  const lastOther = db.prepare(
    `SELECT MAX(date) AS d FROM workout_log
      WHERE ${done} AND template_id IS NOT NULL AND NOT ${mine}`
  ).get(programId)?.d || '';
  const first = db.prepare(
    `SELECT MIN(date) AS d FROM workout_log WHERE ${done} AND ${mine} AND date > ?`
  ).get(programId, lastOther)?.d;
  const today = db.prepare("SELECT date('now') AS d").get().d;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(first || '') && first <= today
    ? first
    : db.prepare("SELECT datetime('now') AS t").get().t;
  _set(START, start);
  return start;
}

/**
 * When the followed program became the one followed (see the header), or
 * null when none is. One followed from before starts were kept gets one
 * now (_backfillStart): idempotent, so the startup migration and every
 * read can call it.
 */
export function soloStart() {
  const id = soloActiveId();
  if (id == null) return null;
  return _get(START) || _backfillStart(id);
}

/**
 * The startup migration: without accounts, give the followed program a
 * start if it has none (soloStart). Returns the start it chose, or null
 * when there was nothing to do. With accounts the keys are not read, so
 * any left over are left alone.
 */
export function migrateSoloStart() {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
  const id = soloActiveId();
  if (id == null || _get(START)) return null;
  return _backfillStart(id);
}

/**
 * The followed program as an assignment, for programWeek.js: the start as
 * `start_date` (the calendar clock; never `assigned_at`, which would also
 * limit the workouts counted) and the week chosen by hand.
 */
export function readSoloAssignment() {
  const out = { start_date: soloStart() };
  const raw = _get(CURSOR);
  if (!raw) return out;
  try {
    const { week, base, pinnedAt } = JSON.parse(raw);
    return {
      ...out,
      week_cursor: week ?? null,
      week_cursor_session_base: base ?? 0,
      week_cursor_pinned_at: pinnedAt ?? null,
    };
  } catch { return out; }
}

/**
 * Follow `id`. A different program starts now, with no week chosen; the
 * one already followed keeps its start (choosing it again restarts
 * nothing) and, as before, drops a chosen week.
 */
export function activateSolo(id) {
  const same = soloActiveId() === id;
  db.transaction(() => {
    if (!same) {
      _set(ACTIVE, String(id));
      _set(START, db.prepare("SELECT datetime('now') AS t").get().t);
    }
    _del(CURSOR);
  })();
}

/** Follow nothing: the program, its chosen week and its start go. */
export function deactivateSolo() {
  db.transaction(() => { _del(ACTIVE); _del(CURSOR); _del(START); })();
}

/** The followed program's keys, read whole (claim-anonymous-data.js). */
export function readSoloKeys() {
  return { id: soloActiveId(), start: soloActiveId() != null ? soloStart() : null, cursor: _get(CURSOR) };
}

/** Write the followed program's keys whole; a null id clears them. */
export function writeSoloKeys({ id, start, cursor }) {
  if (id == null) return deactivateSolo();
  _set(ACTIVE, String(id));
  _set(START, start || db.prepare("SELECT datetime('now') AS t").get().t);
  if (cursor) _set(CURSOR, cursor); else _del(CURSOR);
}
