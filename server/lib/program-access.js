/**
 * program-access.js: who may see a program (and its workout days), and who
 * may change it.
 *
 * Change: the account that made it. The routes used to check nothing, so any
 * signed-in member could rename or delete someone else's program, or add,
 * rewrite and delete its days, by knowing an id; and every pull handed every
 * account's days to every device. The app only offers Rename, Settings,
 * Delete and day editing to the program's maker (ProgramDetail isOwner), so
 * this refuses nothing the app itself does.
 *
 * See: the maker, anyone it's assigned to (a coach's athlete), and the
 * starter programs (no maker, visibility 'shared'). A program whose maker's
 * account was deleted also has no maker, but stays private.
 *
 * With user management off (uid() null) there is no one else, and every
 * program stays open, as before. Admins get no exception, the same as
 * exercises (exercise-owner.js).
 */
import db from '../db.js';

export function canChangeProgram(program, userId) {
  if (!program) return false;
  if (userId == null) return true;
  return program.created_by != null && Number(program.created_by) === Number(userId);
}

export function canSeeProgram(program, userId) {
  if (!program) return false;
  if (canChangeProgram(program, userId)) return true;
  if (program.created_by == null && program.visibility === 'shared') return true;
  return !!db.prepare(
    'SELECT 1 FROM program_assignments WHERE program_id = ? AND assigned_to = ?'
  ).get(program.id, userId);
}

/** An id from a request as a positive whole number, or null. Checked and
 *  stored as this one value: SQLite stores "4.0e1" as 40 where parseInt
 *  reads 4, so checking one form and storing another let a write through
 *  to a program the check never looked at. */
export function toId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v)) return Number(v);
  return null;
}

/** A workout day: seen with its program, or by the athlete a coach
 *  prescribed it to (the Diary opens a prescription's day without the
 *  program being assigned). Changed only with its program. */
export function templateFor(templateId, userId) {
  const t = db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(templateId);
  if (!t) return { template: null, canSee: false, canChange: false };
  const access = programFor(t.program_id, userId);
  const prescribed = userId != null && !!db.prepare(
    'SELECT 1 FROM coach_prescriptions WHERE template_id = ? AND member_id = ?'
  ).get(templateId, userId);
  return { template: t, canSee: access.canSee || prescribed, canChange: access.canChange };
}

/** The program a request names, with the caller's access to it. */
export function programFor(id, userId) {
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  return { program, canSee: canSeeProgram(program, userId), canChange: canChangeProgram(program, userId) };
}

/** SQL (aliases t and p) for "workout days this account may see". */
export function visibleTemplatesSql(userId) {
  const v = visibleProgramsSql(userId);
  if (userId == null) return v;
  return {
    sql: `(${v.sql} OR EXISTS (SELECT 1 FROM coach_prescriptions cp WHERE cp.template_id = t.id AND cp.member_id = ?))`,
    args: [...v.args, userId],
  };
}

/** SQL (alias p) for "programs this account may see", plus its arguments. */
export function visibleProgramsSql(userId) {
  if (userId == null) return { sql: '1 = 1', args: [] };
  return {
    sql: `(p.created_by = ? OR (p.created_by IS NULL AND p.visibility = 'shared')
           OR EXISTS (SELECT 1 FROM program_assignments a WHERE a.program_id = p.id AND a.assigned_to = ?))`,
    args: [userId, userId],
  };
}

/**
 * The program, workout day and exercises a saved workout points at, kept
 * only where this account has business with them. A workout made offline on
 * a phone used to go up carrying the phone's own ids, which name whatever
 * row the server has under that number, often another account's; and anyone
 * could name any program to read its plan length back. A reference the
 * workout already had stays, so editing an old session never strips it.
 * Anything else becomes null, as an unknown id would (the columns are
 * foreign keys, so it could not be stored anyway).
 */
export function cleanWorkoutRefs(userId, body, existing = null) {
  const out = {};
  const same = (col, v) => existing && existing[col] != null && Number(existing[col]) === Number(v);
  const tid = toId(body.template_id);
  out.template_id = tid && (same('template_id', tid) || templateFor(tid, userId).canSee) ? tid : null;
  const pid = toId(body.program_id);
  out.program_id = pid && (same('program_id', pid) || workoutProgramVisible(userId, pid, out.template_id)) ? pid : null;
  if (Array.isArray(body.exercises)) {
    const had = new Set();
    try {
      for (const e of JSON.parse(existing?.exercises || '[]')) if (e?.exercise_id != null) had.add(Number(e.exercise_id));
    } catch { /* unreadable: nothing kept on trust */ }
    const seen = new Map();
    const ok = (id) => {
      if (!seen.has(id)) seen.set(id, had.has(id) || exerciseUsable(id, userId));
      return seen.get(id);
    };
    out.exercises = body.exercises.map(e => {
      if (!e || typeof e !== 'object' || e.exercise_id == null) return e;
      const id = toId(e.exercise_id);
      return { ...e, exercise_id: id && ok(id) ? id : null };
    });
  }
  return out;
}

/**
 * A program a workout may be filed under: one this account sees, or the
 * program of the day it was done from when that day is the account's to
 * see (a coach's prescription from a program the athlete doesn't follow:
 * the Diary files it under that program, for its week and plan length).
 */
export function workoutProgramVisible(userId, programId, templateId) {
  if (!programId) return false;
  if (programFor(programId, userId).canSee) return true;
  if (!templateId) return false;
  const t = templateFor(templateId, userId);
  return t.canSee && Number(t.template.program_id) === Number(programId);
}

/**
 * An exercise this account may log: the shared catalog, its own, or one
 * that reached it through a coach (in a workout day it can see, or a
 * prescription made out to it), or one already in its own history (a
 * workout repeated from the past). One deleted since is still a fair
 * reference (history keeps its id); a number the server never handed out
 * is not.
 */
function exerciseUsable(id, userId) {
  const row = db.prepare('SELECT is_global, created_by FROM exercises WHERE id = ?').get(id);
  if (!row) {
    const seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'exercises'`).get()?.seq ?? 0;
    return id <= seq;
  }
  if (userId == null || Number(row.is_global) === 1) return true;
  if (row.created_by != null && Number(row.created_by) === Number(userId)) return true;
  const named = (col) => `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) AND json_type(${col}) = 'array' THEN ${col} ELSE '[]' END) je
                                  WHERE CAST(json_extract(je.value, '$.exercise_id') AS INTEGER) = ?)`;
  const days = visibleTemplatesSql(userId);
  if (db.prepare(
    `SELECT 1 FROM workout_templates t JOIN programs p ON p.id = t.program_id
      WHERE ${days.sql} AND ${named('t.exercises')} LIMIT 1`
  ).get(...days.args, id)) return true;
  if (db.prepare(
    `SELECT 1 FROM coach_prescriptions cp WHERE cp.member_id = ? AND ${named('cp.exercises')} LIMIT 1`
  ).get(userId, id)) return true;
  return !!db.prepare(
    `SELECT 1 FROM workout_log w WHERE w.user_id = ? AND ${named('w.exercises')} LIMIT 1`
  ).get(userId, id);
}
