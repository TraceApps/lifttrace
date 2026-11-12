/**
 * MCP tool: update_template (write)
 *
 * Change a workout day of a program the caller made (issue #154), as PUT
 * /api/templates/:id does. The name and label merge by the newer-wins rule
 * (lib/newer-wins.js). `exercises`, when sent, is the day's whole new list,
 * in order: see replaceTemplateExercises in ../_program-write.js.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  EXERCISE_HELP, EXERCISES_INPUT, MAX_NAME_LENGTH,
  changeableTemplate, mergeFields, publicTemplate, replaceTemplateExercises,
} from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

export function updateTemplateCore(userId, templateId, args = {}) {
  const body = {};
  if (args.name !== undefined) body.name = String(args.name).trim();
  if (args.day_label !== undefined) body.day_label = args.day_label;
  if (body.name === '') throw new Error("name can't be empty.");
  if (!Object.keys(body).length && !Array.isArray(args.exercises)) {
    throw new Error('Nothing to change: send name, day_label or exercises.');
  }
  const row = db.transaction(() => {
    const existing = changeableTemplate(userId, templateId);
    let times = mergeFields('workout_templates', existing, body);
    let exercisesJson = null;
    if (Array.isArray(args.exercises)) {
      ({ exercisesJson, times } = replaceTemplateExercises(userId, existing, args.exercises, times));
    }
    db.prepare(
      'UPDATE workout_templates SET name=COALESCE(?,name), day_label=COALESCE(?,day_label), exercises=COALESCE(?,exercises), field_times=? WHERE id=?'
    ).run(body.name ?? null, body.day_label ?? null, exercisesJson, times, templateId);
    return db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(templateId);
  })();
  return { ok: true, template: publicTemplate(row) };
}

export function registerUpdateTemplate(server, { userId }) {
  server.registerTool(
    'update_template',
    {
      title: 'Update Template',
      description:
        'Change a workout day (template): its name, day_label or exercises. ' +
        'Only what is sent changes. exercises, when sent, is the whole new ' +
        'list in order: an exercise sent with the uuid get_program returned ' +
        'is changed in place (fields left out keep their value), one sent ' +
        'without a uuid is added, and one left out of the list is removed. ' +
        EXERCISE_HELP + ' Works on a program the caller made, not on one a ' +
        'coach assigned or a starter program.',
      inputSchema: {
        template_id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
        day_label: z.string().max(MAX_NAME_LENGTH).optional(),
        exercises: EXERCISES_INPUT.optional(),
      },
    },
    async ({ template_id, ...args }) => {
      try { return toolResult(updateTemplateCore(userId, template_id, args)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
