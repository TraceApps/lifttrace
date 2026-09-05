/**
 * MCP tool: delete_workout (destroy)
 *
 * Delete a day's entire workout. Mirrors DELETE /api/workout/:date —
 * a hard delete of the whole row, matching that route's existing
 * semantics exactly (LT has no soft-delete-then-purge step here). This
 * cannot be undone, which is why it requires confirm: true — the
 * gating comment in routes/mcp.js explains the layered requirement
 * (server flag + token scope + explicit confirm, all three).
 *
 * A date can have more than one session (issue #76); this tool doesn't
 * expose session selection yet (unchanged contract for phase 1), so it
 * deletes the same default session GET /:date would return — session 0,
 * or the lowest surviving session_seq/id — never every session on that
 * date.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, toolResult, toolError } from '../_util.js';

export function registerDeleteWorkout(server, { userId }) {
  server.registerTool(
    'delete_workout',
    {
      title: 'Delete Workout',
      description:
        "Permanently delete a day's entire workout — every exercise and " +
        'set. Cannot be undone. Requires confirm: true.',
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD'),
        confirm: z.boolean(),
      },
    },
    async ({ date, confirm }) => {
      if (!confirm) return toolError('Refusing to delete without confirm: true. This cannot be undone.');
      const existing = db.prepare('SELECT id FROM workout_log WHERE date = ? AND user_id = ? ORDER BY session_seq ASC, id ASC LIMIT 1').get(date, userId);
      if (!existing) return toolResult({ ok: true, deleted: false, date });
      db.prepare('DELETE FROM workout_log WHERE id = ?').run(existing.id);
      return toolResult({ ok: true, deleted: true, date });
    }
  );
}
