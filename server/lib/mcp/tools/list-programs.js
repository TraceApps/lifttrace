/**
 * MCP tool: list_programs
 *
 * List the caller's programs (owned or assigned by a coach), same
 * source table as GET /api/programs. MCP tokens always belong to a
 * real user account (see server/lib/api-tokens.js), so this skips the
 * single-user-mode app_config branch that route needs.
 */
import db from '../../../db.js';
import { toolResult } from '../_util.js';

export function registerListPrograms(server, { userId }) {
  server.registerTool(
    'list_programs',
    {
      title: 'List Programs',
      description:
        "List the caller's programs — owned or assigned by a coach — with " +
        'which one is currently active and how many workout templates each ' +
        'has. Use get_active_program for the active program\'s current week ' +
        "and today's prescribed template.",
      inputSchema: {},
    },
    async () => {
      const programs = db.prepare(
        `SELECT p.*,
                CASE WHEN pa.active = 1 THEN 1 ELSE 0 END as is_active
           FROM programs p
           LEFT JOIN program_assignments pa ON pa.program_id = p.id AND pa.assigned_to = ?
          WHERE p.created_by = ? OR pa.id IS NOT NULL
          ORDER BY p.created_at DESC`
      ).all(userId, userId);

      const list = programs.map(p => {
        const templateCount = db.prepare(
          'SELECT COUNT(*) as c FROM workout_templates WHERE program_id = ?'
        ).get(p.id)?.c || 0;
        return {
          program_id: p.id,
          name: p.name,
          duration_weeks: p.duration_weeks,
          is_active: !!p.is_active,
          template_count: templateCount,
        };
      });
      return toolResult({ programs: list, count: list.length });
    }
  );
}
