/**
 * Shared pieces for the MCP tools that read and change programs and their
 * workout days (issue #154): get_program, create_program, update_program,
 * create_template, update_template, delete_program, delete_template.
 *
 * The writes mirror server/routes/programs.js and server/routes/templates.js:
 * the same access rule (lib/program-access.js: only the account that made a
 * program changes it), the same field-by-field merge (lib/newer-wins.js) and
 * the same per-exercise merge and tombstones for a day's exercises
 * (lib/workout-merge.js). A tool call is an edit made now, so the helpers
 * that read a request's edit time get no request.
 *
 * A day's exercises are stored as the app's editor writes them
 * (target_sets, target_reps, target_weight, ...). The tools take and return
 * a shorter form (sets, reps, weight) and convert here, so a caller never
 * has to know the stored one. Whatever a stored exercise holds that the
 * short form doesn't (a superset, per-set targets, a multi-week plan) is
 * kept as it is when the exercise is sent back with its uuid.
 */
import { z } from 'zod';
import db from '../../db.js';
import { foldText } from '../search-text.js';
import { mergeExercises, ensureExerciseUuids } from '../workout-merge.js';
import { applyToBody, stampMerged } from '../newer-wins.js';
import { syncOf } from '../sync-fields.js';
import { programFor } from '../program-access.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_NOTES_LENGTH = 500;
export const MAX_TARGET_LENGTH = 20;
export const MAX_TEMPLATE_EXERCISES = 40;
export const MAX_TARGET_SETS = 20;
export const MAX_REST_SEC = 3600;
export const MAX_PROGRAM_WEEKS = 52;
// The goals the app's program form offers (src/lib/workout.js GOALS).
export const PROGRAM_GOALS = ['general', 'strength', 'endurance', 'cutting', 'bulking', 'maintenance'];

const target = z.union([z.string().max(MAX_TARGET_LENGTH), z.number().nonnegative()]);

/** One exercise of a workout day, as the tools take it. */
export const EXERCISE_INPUT = z.object({
  uuid: z.string().min(1).max(64).optional(),
  exercise_id: z.number().int().positive().optional(),
  exercise_name: z.string().min(1).max(200).optional(),
  sets: z.number().int().min(1).max(MAX_TARGET_SETS).optional(),
  reps: target.optional(),
  weight: target.optional(),
  rest_sec: z.number().int().min(0).max(MAX_REST_SEC).optional(),
  notes: z.string().max(MAX_NOTES_LENGTH).optional(),
});

export const EXERCISES_INPUT = z.array(EXERCISE_INPUT).max(MAX_TEMPLATE_EXERCISES);

const EXERCISE_HELP =
  'Each exercise: exercise_id (from search_exercises) or exercise_name, sets ' +
  `(1-${MAX_TARGET_SETS}, default 3), reps (a number or text such as "8-12"), weight ` +
  "(optional, in the user's weight unit), rest_sec and notes (both optional).";
export { EXERCISE_HELP };

/** An exercise this account can use: the shared library or one it made. */
function _libraryExercise(userId, { id, name }) {
  if (id != null) {
    return db.prepare(
      'SELECT id, name FROM exercises WHERE id = ? AND deleted_at IS NULL AND (is_global = 1 OR created_by = ?)'
    ).get(id, userId) || null;
  }
  return db.prepare(
    `SELECT id, name FROM exercises
      WHERE deleted_at IS NULL AND fold(name) = ? AND (is_global = 1 OR created_by = ?)
      ORDER BY id ASC LIMIT 1`
  ).get(foldText(name), userId) || null;
}

/**
 * The stored form of one exercise. `existing` is the stored exercise with
 * the same uuid, when there is one: it is the base, and only what the caller
 * sent is changed on it. Throws on an exercise_id the account can't use and
 * on a new exercise that names nothing.
 */
export function toStoredExercise(userId, input, existing = null) {
  const out = existing ? { ...existing } : { target_sets: 3, target_reps: '', target_weight: '', notes: '', sets: [] };
  if (input.exercise_id != null) {
    const found = _libraryExercise(userId, { id: input.exercise_id });
    if (!found) throw new Error(`Exercise ${input.exercise_id} not found. search_exercises returns the exercise_id to use.`);
    out.exercise_id = found.id;
    out.exercise_name = found.name;
  } else if (input.exercise_name != null) {
    // A name alone: the library exercise of that name when there is one, so
    // its history and records follow; else a free-text exercise, as a
    // program imported from a spreadsheet has.
    const found = _libraryExercise(userId, { name: input.exercise_name });
    if (found) { out.exercise_id = found.id; out.exercise_name = found.name; }
    else { delete out.exercise_id; out.exercise_name = input.exercise_name.trim(); }
  } else if (!existing) {
    throw new Error('Each new exercise needs an exercise_id or an exercise_name.');
  }
  if (input.sets != null) out.target_sets = input.sets;
  if (input.reps != null) out.target_reps = String(input.reps);
  if (input.weight != null) out.target_weight = String(input.weight);
  if (input.rest_sec != null) out.rest_sec = input.rest_sec;
  if (input.notes != null) out.notes = input.notes;
  return out;
}

/** One stored exercise, as the tools return it. */
export function publicExercise(ex) {
  return {
    uuid: ex.uuid || null,
    exercise_id: ex.exercise_id ?? null,
    exercise_name: ex.exercise_name || null,
    sets: ex.target_sets ?? null,
    reps: ex.target_reps ?? null,
    weight: ex.target_weight ?? null,
    rest_sec: ex.rest_sec ?? null,
    notes: ex.notes || null,
    set_type: ex.set_type || null,
    superset_id: ex.superset_id ?? null,
    // Weeks 2 and later of a multi-week program, set in the app's editor.
    // The tools change week 1 only and leave these as they are.
    has_weekly_plan: Array.isArray(ex.weeks) && ex.weeks.some(Boolean),
  };
}

export function publicTemplate(row) {
  // As stored: an exercise saved without a uuid (a starter program's) shows
  // uuid null. Stamping one here without saving it would hand out an id that
  // is gone on the next read, and saving it would break the app's own first
  // save of that day (issue #85, routes/templates.js).
  const exercises = JSON.parse(row.exercises || '[]').filter(e => e && typeof e === 'object');
  return {
    template_id: row.id,
    program_id: row.program_id,
    name: row.name,
    day_label: row.day_label || null,
    exercises: exercises.map(publicExercise),
  };
}

export function publicProgram(row) {
  return {
    program_id: row.id,
    name: row.name,
    description: row.description || null,
    goal: row.goal || 'general',
    duration_weeks: row.duration_weeks || 1,
    advance_mode: row.advance_mode || 'sessions',
    on_complete: row.on_complete || 'hold',
  };
}

/**
 * A program the account may change, or an Error saying why not. One it
 * can't see and one deleted read the same, as the routes answer them.
 */
export function changeableProgram(userId, programId) {
  const access = programFor(programId, userId);
  if (!access.canSee || access.program.deleted_at) throw new Error(`Program ${programId} not found.`);
  if (!access.canChange) {
    throw new Error(`Program ${programId} can't be changed: it was made by someone else (a coach, or a starter program).`);
  }
  return access.program;
}

/** A live workout day of a program the account may change. */
export function changeableTemplate(userId, templateId) {
  const row = db.prepare('SELECT * FROM workout_templates WHERE id = ? AND deleted_at IS NULL').get(templateId);
  const access = row ? programFor(row.program_id, userId) : null;
  if (!row || !access.canSee || access.program.deleted_at) throw new Error(`Template ${templateId} not found.`);
  if (!access.canChange) {
    throw new Error(`Template ${templateId} can't be changed: its program was made by someone else (a coach, or a starter program).`);
  }
  return row;
}

/** The newer-wins merge of the named fields of a row, for an edit made now. */
export function mergeFields(table, existing, body) {
  return applyToBody(null, existing, body, { ...syncOf(table), current: f => existing[f] });
}

/**
 * Replace a day's exercise list with `inputs`, the way PUT /api/templates/:id
 * saves one: stored exercises the list leaves out are deleted with a
 * tombstone (so a device that still has them doesn't bring them back), ones
 * it names by uuid are changed in place, and the rest are added. Runs inside
 * the caller's transaction. Returns { exercisesJson, times }.
 *
 * A day none of whose exercises has a uuid yet (a starter program's) is
 * replaced as a whole, which is what the merge does for the app's first save
 * of such a day too (issue #85).
 */
export function replaceTemplateExercises(userId, template, inputs, timesJson) {
  const stored = JSON.parse(template.exercises || '[]').filter(e => e && typeof e === 'object');
  const noIds = stored.length > 0 && stored.every(e => !e.uuid);
  const serverExs = noIds ? stored : ensureExerciseUuids(stored);
  const byUuid = new Map(noIds ? [] : serverExs.map(e => [e.uuid, e]));
  const next = ensureExerciseUuids(inputs.map(input => {
    const existing = input.uuid ? byUuid.get(input.uuid) : null;
    if (input.uuid && !existing) throw new Error(`No exercise with uuid ${input.uuid} in template ${template.id}. get_program returns the uuids.`);
    return toStoredExercise(userId, input, existing);
  }));
  const kept = new Set(next.map(e => e.uuid));
  const deletedUuids = noIds ? [] : serverExs.map(e => e.uuid).filter(u => !kept.has(u));

  const tsKey = `template:${template.id}`;
  const priorExTs = db.prepare(
    `SELECT uuid FROM workout_tombstones WHERE user_id IS NULL AND date = ? AND kind = 'template_exercise'`
  ).all(tsKey).map(r => r.uuid);
  const priorSetTsByEx = {};
  for (const r of db.prepare(
    `SELECT ex_uuid, uuid FROM workout_tombstones WHERE user_id IS NULL AND date = ? AND kind = 'template_set'`
  ).all(tsKey)) (priorSetTsByEx[r.ex_uuid] = priorSetTsByEx[r.ex_uuid] || []).push(r.uuid);

  const r = mergeExercises(serverExs, next, deletedUuids, priorExTs, {}, priorSetTsByEx);
  const insertTombstone = db.prepare(
    `INSERT OR IGNORE INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at)
     VALUES (NULL, ?, 'template_exercise', '', ?, datetime('now'))`
  );
  for (const uuid of r.newTombstoneExerciseUuids) insertTombstone.run(tsKey, uuid);
  return { exercisesJson: JSON.stringify(r.merged), times: stampMerged(null, timesJson, ['exercises']) };
}
