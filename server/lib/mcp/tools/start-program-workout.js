/**
 * MCP tool: start_program_workout (write), and POST /api/v1/workouts/:date/start
 * (issue #140).
 *
 * Starts a program's workout day on a date, as the Diary's Load Workout
 * does: the day's exercises with this week's planned sets, nothing ticked,
 * filed under the program and its plan week, so log_set then fills those
 * sets and finishing the workout counts toward the program. It never marks
 * the workout finished.
 *
 * Which day: template_id when sent (a workout day of a program this account
 * may see), else the active program's next one, the day after the last one
 * finished (by the program's order, back to the first after the last); the
 * first when none was.
 *
 * Safe to send again: a date that already has a workout from that day (or,
 * with no template_id, from the active program) gets that one back, not a
 * second. Where it goes: into the date's first empty workout, else a new
 * workout of the day, as Trace's start_workout_from_template and the Diary's
 * new-session choice do, so nothing already logged that day is touched.
 *
 * Planned the way the Diary plans it (lib/planned-workout.js, the Diary's own
 * copy is src/lib/planned-workout.js): this week's targets, last session's
 * weights when Auto-Fill Last Weights is on, Auto Warm-Ups, from the
 * account's synced settings (their defaults when never changed).
 *
 * Sends no webhook, as the app's own save of a loaded day sends none:
 * nothing in it is done yet.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, isCalendarDate, todayLocal, toolResult, toolError } from '../_util.js';
import { formatWorkoutRow } from './get-workout.js';
import { getActiveProgramCore } from './get-active-program.js';
import { cleanWorkoutRefs, programFor, templateFor, toId } from '../../program-access.js';
import { ensureExerciseUuids } from '../../workout-merge.js';
import { exerciseHistory } from '../../exercise-history.js';
import { fieldTimes } from '../../newer-wins.js';
import { buildPlannedExercises, lastCompletedSession, PLAN_SETTING_DEFAULTS } from '../../planned-workout.js';

/** A synced setting as the account has it, else what every device starts with. */
function _setting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return PLAN_SETTING_DEFAULTS[key];
  try {
    const v = JSON.parse(row.value);
    return v ?? PLAN_SETTING_DEFAULTS[key];
  } catch { return row.value ?? PLAN_SETTING_DEFAULTS[key]; }
}

/** New ids for every exercise and set, as the Diary's withFreshIds (issue #99). */
function _freshIds(exercises) {
  return ensureExerciseUuids(exercises.map(ex => {
    const { uuid: _e, ...rest } = ex;
    return { ...rest, sets: (rest.sets || []).map(s => { const { uuid: _s, ...set } = s; return set; }) };
  }));
}

const _exercisesOf = (row) => { try { return JSON.parse(row.exercises || '[]') || []; } catch { return []; } };

/** The account's active program (its assignment and program row), or null. */
function _activeAssignment(userId) {
  return db.prepare(
    `SELECT pa.program_id, pa.assigned_at, p.name, p.duration_weeks FROM program_assignments pa
       JOIN programs p ON p.id = pa.program_id
      WHERE pa.assigned_to = ? AND pa.active = 1 AND p.deleted_at IS NULL`
  ).get(userId) || null;
}

/**
 * The active program's next workout day for `day`: the one after the last
 * one finished before that date since the program was started (the same
 * workouts that move its week on), wrapping to the first; the first when
 * none was.
 */
function _nextDay(userId, assignment, templates, day) {
  const ids = templates.map(t => t.id);
  const last = db.prepare(
    `SELECT template_id FROM workout_log
      WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL AND date < ?
        AND template_id IN (${ids.map(() => '?').join(',')})
        ${assignment.assigned_at ? 'AND date >= date(?)' : ''}
      ORDER BY date DESC, session_seq DESC, id DESC LIMIT 1`
  ).get(userId, day, ...ids, ...(assignment.assigned_at ? [assignment.assigned_at] : []));
  const at = last ? ids.indexOf(last.template_id) : -1;
  return templates[at < 0 ? 0 : (at + 1) % templates.length];
}

/** The answer: the workout, with what it was started from. The program's
 *  name only for a program this account sees (a coach's prescribed day can
 *  come from one it doesn't). */
function _answer(userId, row, { started, newSession, template, program }) {
  const w = formatWorkoutRow(row);
  if (program && !programFor(program.id, userId).canSee) program = null;
  return {
    ok: true,
    started,
    new_session: newSession,
    workout_id: row.id,
    date: row.date,
    name: w.name,
    template_id: row.template_id ?? null,
    template_name: template?.name ?? null,
    day_label: template?.day_label ?? null,
    program_id: row.program_id ?? null,
    program_name: program?.name ?? null,
    program_week: row.program_week ?? null,
    duration_weeks: program?.duration_weeks ?? null,
    completed: w.completed,
    exercises: w.exercises,
  };
}

export function startProgramWorkoutCore(userId, { date, template_id } = {}) {
  const day = date || todayLocal();
  if (!isCalendarDate(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);
  const sentTemplate = template_id != null && template_id !== '';
  const templateId = sentTemplate ? toId(template_id) : null;
  if (sentTemplate && templateId == null) throw new Error('template_id must be a workout day id, as get_active_program lists them.');

  return db.transaction(() => {
    const assignment = _activeAssignment(userId);
    let template, programTemplates = null;
    if (templateId != null) {
      const access = templateFor(templateId, userId);
      if (!access.template || !access.canSee || access.template.deleted_at) {
        throw new Error(`No workout day ${templateId} that you can see. get_active_program lists your active program's days.`);
      }
      template = access.template;
    } else {
      if (!assignment) throw new Error('No active program. Activate one in the app, or send template_id.');
      programTemplates = db.prepare(
        'SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL ORDER BY order_index ASC, id ASC'
      ).all(assignment.program_id);
      if (!programTemplates.length) throw new Error(`Your active program, ${assignment.name}, has no workout days yet.`);
    }

    const live = db.prepare(
      'SELECT * FROM workout_log WHERE date = ? AND user_id = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC'
    ).all(day, userId);

    // Already started that day: that workout, unfinished first.
    const ofDay = templateId != null
      ? live.filter(r => Number(r.template_id) === templateId)
      : live.filter(r => programTemplates.some(t => t.id === Number(r.template_id)));
    const already = ofDay.find(r => !r.completed) || ofDay[0];
    if (already) {
      const t = templateId != null ? template : programTemplates.find(x => x.id === Number(already.template_id));
      const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(already.program_id ?? t?.program_id);
      return _answer(userId, already, { started: false, newSession: false, template: t, program });
    }

    if (!template) template = _nextDay(userId, assignment, programTemplates, day);
    const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(template.program_id);
    // The plan week, as the Diary stamps it: only for the program being
    // followed, its current week (the same resolver as get_active_program,
    // in the account's own zone).
    const isActive = !!assignment && Number(assignment.program_id) === Number(template.program_id);
    const planWeek = isActive ? (getActiveProgramCore(userId).current_week || null) : null;

    const autoFill = !!_setting(userId, 'autoFillLastWeights');
    const tplExercises = (() => { try { return JSON.parse(template.exercises || '[]') || []; } catch { return []; } })();
    const planned = buildPlannedExercises(tplExercises, {
      planWeek,
      lastSets: (ex) => {
        const id = parseInt(ex?.exercise_id);
        if (!autoFill || !id) return null;
        return lastCompletedSession(exerciseHistory(userId, id), { before: day })?.completed || null;
      },
      autoWarmups: !!_setting(userId, 'autoGenerateWarmups'),
      weightUnit: _setting(userId, 'weightUnit'),
    });
    // The exercise ids as the app's own save keeps them (numbers, and only
    // exercises this account may log: cleanWorkoutRefs, as PUT /api/workout
    // does for the Diary's Load Workout), then new ids for every entry.
    const exercises = _freshIds(cleanWorkoutRefs(userId, { exercises: planned }).exercises);
    const exercisesJson = JSON.stringify(exercises);

    // Into the date's first empty workout, keeping its notes and time as
    // Load Workout does; else a new workout of the day. Never one marked
    // finished: a started workout isn't.
    const empty = live.find(r => !r.completed && _exercisesOf(r).length === 0);
    let id;
    if (empty) {
      // Stamped as changed now, so an older edit queued on a phone can't
      // put the empty workout back over it (lib/newer-wins.js).
      const times = fieldTimes(empty);
      const now = new Date().toISOString();
      for (const f of ['name', 'template_id', 'program_id', 'program_week', 'exercises']) times[f] = now;
      db.prepare(
        'UPDATE workout_log SET name = ?, template_id = ?, program_id = ?, program_week = ?, exercises = ?, field_times = ? WHERE id = ?'
      ).run(template.name, template.id, template.program_id, planWeek, exercisesJson, JSON.stringify(times), empty.id);
      id = empty.id;
    } else {
      const seq = db.prepare(
        'SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE date = ? AND user_id = ?'
      ).get(day, userId).n;
      // Made now: an edit queued on a phone before this (an older app's save
      // to the date's first workout, say) can't wipe its program and week.
      id = db.prepare(
        `INSERT INTO workout_log (user_id, date, template_id, program_id, name, exercises, completed, program_week, session_seq, field_times)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(userId, day, template.id, template.program_id, template.name, exercisesJson, planWeek, seq,
        JSON.stringify({ _base: new Date().toISOString() })).lastInsertRowid;
    }
    const row = db.prepare('SELECT * FROM workout_log WHERE id = ?').get(id);
    return _answer(userId, row, { started: true, newSession: !empty && live.length > 0, template, program });
  })();
}

export function registerStartProgramWorkout(server, { userId }) {
  server.registerTool(
    'start_program_workout',
    {
      title: 'Start Program Workout',
      description:
        "Start a program's workout day on a date, as loading it in the app's " +
        'diary does: its exercises with this week\'s planned sets, nothing ' +
        'ticked, filed under the program and its week. Then log_set fills ' +
        'those planned sets, and finishing the workout in the app counts it ' +
        'toward the program. Without template_id it starts the active ' +
        "program's next day (the one after the last finished). Sending it " +
        'again returns the workout already started (started: false). It goes ' +
        "into the date's empty workout, or else becomes a new workout of the " +
        'day; it never changes one already logged. Date defaults to today in ' +
        "the server's timezone.",
      inputSchema: {
        template_id: z.number().int().positive().optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ template_id, date }) => {
      try {
        return toolResult(startProgramWorkoutCore(userId, { template_id, date }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
