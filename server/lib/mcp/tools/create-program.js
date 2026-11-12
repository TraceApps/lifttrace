/**
 * MCP tool: create_program (write)
 *
 * Make a new, empty program owned by the caller (issue #154), as POST
 * /api/programs does. Workout days are added with create_template. The
 * program is not made active: the user picks that in the app.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, MAX_PROGRAM_WEEKS, PROGRAM_GOALS, publicProgram,
} from '../_program-write.js';
import { toolResult, toolError } from '../_util.js';

export function createProgramCore(userId, args = {}) {
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name is required.');
  const info = db.prepare(
    `INSERT INTO programs (name, description, goal, created_by, visibility, duration_weeks, advance_mode, on_complete)
     VALUES (?, ?, ?, ?, 'private', ?, ?, ?)`
  ).run(
    name, args.description || null, args.goal || 'general', userId,
    args.duration_weeks || 1, args.advance_mode || 'sessions', args.on_complete || 'hold'
  );
  const row = db.prepare('SELECT * FROM programs WHERE id = ?').get(info.lastInsertRowid);
  return { ok: true, program: publicProgram(row) };
}

export function registerCreateProgram(server, { userId }) {
  server.registerTool(
    'create_program',
    {
      title: 'Create Program',
      description:
        'Create a new, empty program for the caller. Add its workout days with ' +
        'create_template. duration_weeks (1 by default) is how many weeks the ' +
        "plan runs; advance_mode is how it moves to the next week ('sessions': " +
        "after each week's workouts are done, the default; 'calendar': every 7 " +
        "days); on_complete is what happens after the last week ('hold', the " +
        "default, or 'repeat'). The program is not made active.",
      inputSchema: {
        name: z.string().min(1).max(MAX_NAME_LENGTH),
        description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
        goal: z.enum(PROGRAM_GOALS).optional(),
        duration_weeks: z.number().int().min(1).max(MAX_PROGRAM_WEEKS).optional(),
        advance_mode: z.enum(['sessions', 'calendar']).optional(),
        on_complete: z.enum(['hold', 'repeat']).optional(),
      },
    },
    async (args) => {
      try { return toolResult(createProgramCore(userId, args)); }
      catch (e) { return toolError(e.message); }
    }
  );
}
