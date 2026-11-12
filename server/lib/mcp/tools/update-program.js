/**
 * MCP tool: update_program (write)
 *
 * Change a program's own fields (issue #154), as PUT /api/programs/:id
 * does: only the fields sent change, each one merged by the newer-wins rule
 * the app's own edits follow (lib/newer-wins.js). Only a program the caller
 * made can be changed (lib/program-access.js).
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_PROGRAM_WEEKS, PROGRAM_GOALS,
  changeableProgram, mergeFields, publicProgram,
} from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

const FIELDS = ['name', 'description', 'goal', 'duration_weeks', 'advance_mode', 'on_complete'];

export function updateProgramCore(userId, programId, args = {}) {
  const body = {};
  for (const f of FIELDS) if (args[f] !== undefined) body[f] = f === 'name' ? String(args[f]).trim() : args[f];
  if (body.name === '') throw new Error("name can't be empty.");
  if (!Object.keys(body).length) throw new Error('Nothing to change: send at least one field.');
  const row = db.transaction(() => {
    const existing = changeableProgram(userId, programId);
    const times = mergeFields('programs', existing, body);
    db.prepare(
      `UPDATE programs SET name=COALESCE(?,name), description=COALESCE(?,description),
              goal=COALESCE(?,goal), duration_weeks=COALESCE(?,duration_weeks),
              advance_mode=COALESCE(?,advance_mode), on_complete=COALESCE(?,on_complete),
              field_times=? WHERE id=?`
    ).run(
      body.name ?? null, body.description ?? null, body.goal ?? null, body.duration_weeks ?? null,
      body.advance_mode ?? null, body.on_complete ?? null, times, programId
    );
    return db.prepare('SELECT * FROM programs WHERE id = ?').get(programId);
  })();
  return { ok: true, program: publicProgram(row) };
}

export function registerUpdateProgram(server, { userId }) {
  server.registerTool(
    'update_program',
    {
      title: 'Update Program',
      description:
        "Change a program's name, description, goal, duration_weeks, " +
        'advance_mode or on_complete. Only the fields sent change. Works on a ' +
        'program the caller made (get_program can_edit: true), not on one a ' +
        'coach assigned or a starter program. Its workout days are changed ' +
        'with create_template, update_template and delete_template.',
      inputSchema: {
        program_id: z.number().int().positive(),
        name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
        description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
        goal: z.enum(PROGRAM_GOALS).optional(),
        duration_weeks: z.number().int().min(1).max(MAX_PROGRAM_WEEKS).optional(),
        advance_mode: z.enum(['sessions', 'calendar']).optional(),
        on_complete: z.enum(['hold', 'repeat']).optional(),
      },
    },
    async ({ program_id, ...args }) => {
      try { return toolResult(updateProgramCore(userId, program_id, args)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
