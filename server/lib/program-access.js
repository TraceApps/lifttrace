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
