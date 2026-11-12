/**
 * MCP tool: create_template (write)
 *
 * Add a workout day to a program the caller made (issue #154), as POST
 * /api/templates does: it goes after the program's last day.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { ensureExerciseUuids } from '../../workout-merge.js';
import {
  EXERCISE_HELP, EXERCISES_INPUT, MAX_NAME_LENGTH,
  changeableProgram, publicTemplate, toStoredExercise,
} from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

export function createTemplateCore(userId, args = {}) {
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name is required.');
  const row = db.transaction(() => {
    const program = changeableProgram(userId, args.program_id);
    const exercises = ensureExerciseUuids((args.exercises || []).map(input => {
      if (input.uuid) throw new Error("A new template's exercises take no uuid: they get one when saved.");
      return toStoredExercise(userId, input);
    }));
    const maxIdx = db.prepare('SELECT MAX(order_index) as m FROM workout_templates WHERE program_id = ?').get(program.id);
    const info = db.prepare(
      'INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises) VALUES (?, ?, ?, ?, ?)'
    ).run(program.id, name, args.day_label || null, (maxIdx?.m ?? -1) + 1, JSON.stringify(exercises));
    return db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(info.lastInsertRowid);
  })();
  return { ok: true, template: publicTemplate(row) };
}

export function registerCreateTemplate(server, { userId }) {
  server.registerTool(
    'create_template',
    {
      title: 'Create Template',
      description:
        'Add a workout day (template) to a program the caller made, after its ' +
        'last day. day_label is optional text shown with the name, such as ' +
        '"Monday". ' + EXERCISE_HELP + ' Exercises can be left out and added ' +
        'later with update_template.',
      inputSchema: {
        program_id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        day_label: z.string().max(MAX_NAME_LENGTH).optional(),
        exercises: EXERCISES_INPUT.optional(),
      },
    },
    async (args) => {
      try { return toolResult(createTemplateCore(userId, args)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
