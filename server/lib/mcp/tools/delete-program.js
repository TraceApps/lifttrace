/**
 * MCP tools: delete_program and delete_template (destroy)
 *
 * Delete a program with all its workout days, or one workout day (issue
 * #154), as DELETE /api/programs/:id and DELETE /api/templates/:id do: the
 * same row delete, which synced devices learn about the way they learn about
 * the app's own. Neither can be undone, so both need confirm: true on top of
 * the server flag and the token scope (see routes/mcp.js). Workouts already
 * logged from the program stay in the diary.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { changeableProgram, changeableTemplate } from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

export function deleteProgramCore(userId, programId) {
  return db.transaction(() => {
    const program = changeableProgram(userId, programId);
    db.prepare('DELETE FROM programs WHERE id = ?').run(program.id);
    return { ok: true, deleted: true, program_id: program.id, name: program.name };
  })();
}

export function deleteTemplateCore(userId, templateId) {
  return db.transaction(() => {
    const template = changeableTemplate(userId, templateId);
    db.prepare('DELETE FROM workout_templates WHERE id = ?').run(template.id);
    return { ok: true, deleted: true, template_id: template.id, program_id: template.program_id, name: template.name };
  })();
}

export function registerDeleteProgram(server, { userId }) {
  server.registerTool(
    'delete_program',
    {
      title: 'Delete Program',
      description:
        'Permanently delete a program the caller made, with all its workout ' +
        'days. Workouts already logged from it stay. Cannot be undone. ' +
        'Requires confirm: true.',
      inputSchema: {
        program_id: z.number().int().positive(),
        confirm: z.boolean(),
      },
    },
    async ({ program_id, confirm }) => {
      if (!confirm) return toolError('Refusing to delete without confirm: true. This cannot be undone.');
      try { return toolResult(deleteProgramCore(userId, program_id)); }
      catch (e) { return toolError(e.message); }
    }
  );
}

export function registerDeleteTemplate(server, { userId }) {
  server.registerTool(
    'delete_template',
    {
      title: 'Delete Template',
      description:
        'Permanently delete one workout day (template) of a program the ' +
        'caller made. Workouts already logged from it stay. Cannot be undone. ' +
        'Requires confirm: true.',
      inputSchema: {
        template_id: z.number().int().positive(),
        confirm: z.boolean(),
      },
    },
    async ({ template_id, confirm }) => {
      if (!confirm) return toolError('Refusing to delete without confirm: true. This cannot be undone.');
      try { return toolResult(deleteTemplateCore(userId, template_id)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
