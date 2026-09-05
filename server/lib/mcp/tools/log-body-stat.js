/**
 * MCP tool: log_body_stat (write)
 *
 * Set one or more body-stat values on a day. Merges into any existing
 * stats for that date via mergeStatsObject (same allowlist-guarded
 * primitive PUT /api/body-stats/:date uses — see issue #80), so setting
 * weight never clears bodyFat or a measurement logged separately.
 *
 * Units are canonical: weight in kg (or lb — see the weight_unit
 * argument), waist/hips/neck/chest/biceps/thighs/calves in cm,
 * bodyFat as percent (0-100). Keys must match the app exactly
 * (bodyFat, not body_fat; plural forms hips/thighs/calves/biceps).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { mergeStatsObject } from '../../workout-merge.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';

const LB_PER_KG = 0.45359237;

// Sanity ranges in canonical units (kg / cm / percent). Generous —
// clinically implausible but physically plausible — because this tool
// is a data pipe, not a validator; the app UI catches finer mistakes.
const STAT_RANGES = {
  weight:  { min: 0.5, max: 500 },
  bodyFat: { min: 0,   max: 80 },
  waist:   { min: 30,  max: 250 },
  hips:    { min: 30,  max: 250 },
  neck:    { min: 15,  max: 100 },
  chest:   { min: 40,  max: 250 },
  biceps:  { min: 10,  max: 100 },
  thighs:  { min: 20,  max: 150 },
  calves:  { min: 15,  max: 100 },
};

export function registerLogBodyStat(server, { userId }) {
  server.registerTool(
    'log_body_stat',
    {
      title: 'Log Body Stat',
      description:
        'Set one or more body-stat values on a day. Merges into existing ' +
        'stats for that date (setting weight does not clear bodyFat). Units: ' +
        'weight in kg by default (pass weight_unit: "lb" to convert from ' +
        'pounds), waist/hips/neck/chest/biceps/thighs/calves in cm, bodyFat ' +
        "as percent 0-100. Date defaults to today in the server's timezone.",
      inputSchema: {
        weight: z.number().positive().optional(),
        weight_unit: z.enum(['kg', 'lb']).optional(),
        bodyFat: z.number().min(0).max(100).optional(),
        waist: z.number().positive().optional(),
        hips: z.number().positive().optional(),
        neck: z.number().positive().optional(),
        chest: z.number().positive().optional(),
        biceps: z.number().positive().optional(),
        thighs: z.number().positive().optional(),
        calves: z.number().positive().optional(),
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async (args) => {
      const { weight_unit, date, ...rawStats } = args;
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);

      const stats = { ...rawStats };
      if (stats.weight != null && weight_unit === 'lb') {
        stats.weight = Math.round(stats.weight * LB_PER_KG * 100) / 100;
      }

      const keys = Object.keys(stats).filter(k => stats[k] != null);
      if (keys.length === 0) return toolError('At least one stat value is required.');
      for (const k of keys) {
        const range = STAT_RANGES[k];
        if (range && (stats[k] < range.min || stats[k] > range.max)) {
          return toolError(`${k}=${stats[k]} is outside the plausible range (${range.min}-${range.max}).`);
        }
      }

      const tx = db.transaction(() => {
        const existing = db.prepare('SELECT * FROM body_stats_log WHERE date = ? AND user_id = ?').get(day, userId);
        const serverStats = existing ? JSON.parse(existing.stats || '{}') : {};
        const merged = mergeStatsObject(serverStats, stats);
        const mergedJson = JSON.stringify(merged);
        if (existing) {
          db.prepare('UPDATE body_stats_log SET stats = ? WHERE id = ?').run(mergedJson, existing.id);
        } else {
          db.prepare('INSERT INTO body_stats_log (user_id, date, stats) VALUES (?, ?, ?)').run(userId, day, mergedJson);
        }
        return merged;
      });
      const merged = tx();

      return toolResult({ ok: true, date: day, logged: stats, stats: merged });
    }
  );
}
