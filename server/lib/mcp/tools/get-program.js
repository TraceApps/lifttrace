/**
 * MCP tool: get_program
 *
 * One program with its workout days and every exercise's targets, for a
 * caller that is about to change it (issue #154): list_programs gives the
 * ids, this gives what update_program, update_template and delete_template
 * work on. Reads what GET /api/programs/:id reads: a program the caller
 * made, one a coach assigned, or a starter program.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { programFor } from '../../program-access.js';
import { publicProgram, publicTemplate } from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

export function getProgramCore(userId, programId) {
  const access = programFor(programId, userId);
  if (!access.canSee || access.program.deleted_at) throw new Error(`Program ${programId} not found.`);
  const templates = db.prepare(
    'SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL ORDER BY order_index ASC'
  ).all(programId);
  const active = !!db.prepare(
    'SELECT 1 FROM program_assignments WHERE program_id = ? AND assigned_to = ? AND active = 1'
  ).get(programId, userId);
  return {
    ...publicProgram(access.program),
    is_active: active,
    // false for a coach's program or a starter program: the write tools refuse those.
    can_edit: access.canChange,
    templates: templates.map(publicTemplate),
  };
}

export function registerGetProgram(server, { userId }) {
  server.registerTool(
    'get_program',
    {
      title: 'Get Program',
      description:
        'One program with its workout days (templates) in order and, for each, ' +
        'every exercise with its uuid, exercise_id, sets, reps, weight, rest_sec ' +
        'and notes. can_edit says whether the write tools may change it. ' +
        'list_programs returns the program_id to use.',
      inputSchema: {
        program_id: z.number().int().positive(),
      },
    },
    async ({ program_id }) => {
      try { return toolResult(getProgramCore(userId, program_id)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
