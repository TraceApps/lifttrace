/**
 * MCP tool: get_active_program
 *
 * The caller's active program, its current week (same resolver
 * GET /api/programs uses), and its list of weekly templates so an
 * agent can answer "what should I do today" without a separate
 * search_exercises round-trip per exercise.
 */
import db from '../../../db.js';
import { currentPlanWeek } from '../../programWeek.js';
import { toolResult } from '../_util.js';

export function registerGetActiveProgram(server, { userId }) {
  server.registerTool(
    'get_active_program',
    {
      title: 'Get Active Program',
      description:
        "The caller's currently active program: name, duration, current " +
        'week, and every weekly template (name, day label, exercise list). ' +
        'Returns active: false if no program is active.',
      inputSchema: {},
    },
    async () => {
      const assignment = db.prepare(
        `SELECT pa.*, p.* FROM program_assignments pa
           JOIN programs p ON p.id = pa.program_id
          WHERE pa.assigned_to = ? AND pa.active = 1`
      ).get(userId);
      if (!assignment) return toolResult({ active: false });

      const templates = db.prepare(
        'SELECT id, name, day_label, exercises FROM workout_templates WHERE program_id = ? ORDER BY order_index ASC'
      ).all(assignment.program_id);
      const templateCount = templates.length;

      const sessionsInProgram = db.prepare(`
        SELECT COUNT(*) as c FROM workout_log wl
          WHERE wl.user_id = ? AND wl.completed = 1
            AND wl.template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
            ${assignment.assigned_at ? 'AND date >= date(?)' : ''}
      `).get(...(assignment.assigned_at ? [userId, assignment.program_id, assignment.assigned_at] : [userId, assignment.program_id]))?.c || 0;

      const currentWeek = currentPlanWeek(assignment, assignment, {
        sessionsInProgram,
        sessionsPerWeek: templateCount,
      });

      return toolResult({
        active: true,
        program_id: assignment.program_id,
        name: assignment.name,
        duration_weeks: assignment.duration_weeks,
        current_week: currentWeek,
        templates: templates.map(t => ({
          template_id: t.id,
          name: t.name,
          day_label: t.day_label || null,
          exercises: JSON.parse(t.exercises || '[]').map(ex => ({
            exercise_id: ex.exercise_id,
            exercise_name: ex.exercise_name,
            target_sets: ex.target_sets ?? null,
          })),
        })),
      });
    }
  );
}
