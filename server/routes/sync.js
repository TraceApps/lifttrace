/**
 * sync.js — Differential sync endpoints for the Capacitor Android app.
 *
 *   GET  /api/sync/pull?since=<ISO>  → all rows changed in any syncable
 *                                       table since that timestamp, plus
 *                                       a fresh server_time the client
 *                                       sends back as `since` next pull.
 *   POST /api/sync/push              → batch upsert of pending writes
 *                                       from the client. Last-write-wins
 *                                       by updated_at. Returns
 *                                       client_id → server_id mappings
 *                                       for newly created rows.
 *
 * Scope (LiftTrace tables): exercises (custom + user), programs,
 * workout_templates, program_assignments, workout_log, body_stats_log,
 * user_settings, ai_chat_history.
 *
 * Schema requirement: every syncable table has updated_at + deleted_at
 * columns auto-touched by the triggers in server/db.js. Soft-deleted
 * rows (deleted_at IS NOT NULL) ARE included in /pull responses so the
 * client can propagate the delete locally.
 *
 * Boundary: WHERE updated_at >= ? (inclusive). SQLite's datetime('now')
 * has 1-second precision; an exclusive `>` would let a row inserted in
 * the same second as the previous pull's serverTime fall through the
 * cracks. The trade-off is one extra second's worth of rows pulled per
 * sync, which the client's UPSERT handles idempotently.
 *
 * Mirrors NutriTrace's server/routes/sync.js — same shape, same write
 * semantics, different table list.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { mergeExercises, ensureExerciseUuids, mergeStatsObject } from '../lib/workout-merge.js';

// ── Tombstone helpers for the sync push/pull loops (Option C) ─────────
// Same shape as workout.js — duplicated here to keep both routes
// self-contained. If we grow more callers, promote to a shared module.
function _tsWhere(u) { return u == null ? 'user_id IS NULL' : 'user_id = ?'; }
function _loadExUuidsForDate(u, date) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT uuid FROM workout_tombstones WHERE ${where} AND date = ? AND kind = 'exercise'`);
  return (u == null ? stmt.all(date) : stmt.all(u, date)).map(r => r.uuid);
}
function _loadSetUuidsByExForDate(u, date) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE ${where} AND date = ? AND kind = 'set'`);
  const rows = u == null ? stmt.all(date) : stmt.all(u, date);
  const out = {};
  for (const r of rows) (out[r.ex_uuid] = out[r.ex_uuid] || []).push(r.uuid);
  return out;
}
function _loadTemplateTombstones(templateId, kind) {
  const key = `template:${templateId}`;
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE user_id IS NULL AND date = ? AND kind = ?`);
  return stmt.all(key, kind);
}
function _loadTombstonesSince(u, sinceSql) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT date, kind, ex_uuid, uuid, deleted_at FROM workout_tombstones WHERE ${where} AND deleted_at >= ? ORDER BY deleted_at`);
  return u == null ? stmt.all(sinceSql) : stmt.all(u, sinceSql);
}

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user?.id : null;

// ── Settings keys that should never be pushed to the client ─────────────
// Mirrors the SERVER_SETTINGS / DEVICE_PREFS split in NT but LT doesn't
// have admin-only keys yet. Kept as a hook for future hardening.
function isServerOnlyKey(_key) { return false; }

function parseRow(row) {
  if (!row) return null;
  for (const key of ['exercises', 'stats', 'primary_muscles', 'secondary_muscles', 'equipment']) {
    if (typeof row[key] === 'string') {
      try { row[key] = JSON.parse(row[key]); } catch {}
    }
  }
  return row;
}

// Convert ISO timestamp → SQLite TEXT format (YYYY-MM-DD HH:MM:SS) for
// comparison against datetime('now') values stored by the triggers.
function toSqlTime(iso) {
  if (!iso) return '1970-01-01 00:00:00';
  return String(iso).replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '');
}

// ── GET /pull ────────────────────────────────────────────────────────────
router.get('/pull', wrap((req, res) => {
  const u = uid(req);
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  const sinceSql = toSqlTime(since);
  const serverTime = new Date().toISOString();

  // Per-user filter — single-user installs (userMgmtActive=false) skip the
  // filter and pull everything. user_id IS NULL legacy rows from before
  // user-management was enabled get pulled too (they're effectively the
  // single user's data in that mode).
  const userFilter = u != null ? 'AND user_id = ?' : '';
  const userParams = u != null ? [u] : [];

  // ── Tables ────────────────────────────────────────────────────────────
  // exercises has no user_id column (created_by + is_global); we pull all
  // global exercises + the current user's custom ones. Soft-deletes
  // included so client clears local rows.
  const exercises = u != null
    ? db.prepare(
        `SELECT * FROM exercises
         WHERE updated_at >= ? AND (is_global = 1 OR created_by = ?)
         ORDER BY updated_at`
      ).all(sinceSql, u).map(parseRow)
    : db.prepare(
        `SELECT * FROM exercises WHERE updated_at >= ? ORDER BY updated_at`
      ).all(sinceSql).map(parseRow);

  // programs has created_by, not user_id. Include programs the user
  // created OR has been assigned (server-side join with program_assignments
  // is overkill here — assignments are pulled separately).
  const programs = u != null
    ? db.prepare(
        `SELECT DISTINCT p.* FROM programs p
         LEFT JOIN program_assignments a ON a.program_id = p.id AND a.assigned_to = ?
         WHERE p.updated_at >= ? AND (p.created_by = ? OR p.created_by IS NULL OR a.id IS NOT NULL)
         ORDER BY p.updated_at`
      ).all(u, sinceSql, u).map(parseRow)
    : db.prepare(
        `SELECT * FROM programs WHERE updated_at >= ? ORDER BY updated_at`
      ).all(sinceSql).map(parseRow);

  const workout_templates = db.prepare(
    `SELECT * FROM workout_templates WHERE updated_at >= ? ORDER BY updated_at`
  ).all(sinceSql).map(parseRow);

  const program_assignments = u != null
    ? db.prepare(
        `SELECT * FROM program_assignments
         WHERE updated_at >= ? AND assigned_to = ?
         ORDER BY updated_at`
      ).all(sinceSql, u).map(parseRow)
    : db.prepare(
        `SELECT * FROM program_assignments WHERE updated_at >= ? ORDER BY updated_at`
      ).all(sinceSql).map(parseRow);

  const workout_log = db.prepare(
    `SELECT * FROM workout_log WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams).map(parseRow);

  const body_stats_log = db.prepare(
    `SELECT * FROM body_stats_log WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams).map(parseRow);

  // user_settings — only the current user's keys; never push admin-only
  // keys (none yet, but the filter is a hook for future).
  const settings = u != null
    ? db.prepare(
        `SELECT * FROM user_settings WHERE updated_at >= ? AND user_id = ? ORDER BY updated_at`
      ).all(sinceSql, u).filter(s => !isServerOnlyKey(s.key))
    : [];

  // ai_chat_history — append-only, sort by created_at since updates aren't
  // a thing for chat messages. Soft-deletes still respected.
  const ai_chat_history = u != null
    ? db.prepare(
        `SELECT * FROM ai_chat_history WHERE updated_at >= ? AND user_id = ? ORDER BY created_at`
      ).all(sinceSql, u)
    : db.prepare(
        `SELECT * FROM ai_chat_history WHERE updated_at >= ? AND user_id IS NULL ORDER BY created_at`
      ).all(sinceSql);

  // Per-entry deletion tombstones for exercises + sets since the same
  // `since` boundary. Clients apply these to drop entries locally that
  // were deleted on another device. See lib/workout-merge.js.
  const workout_tombstones = _loadTombstonesSince(u, sinceSql);

  logger.debug?.(`[sync] pull since=${sinceSql} user=${u ?? '-'}: exercises=${exercises.length} programs=${programs.length} templates=${workout_templates.length} assignments=${program_assignments.length} workouts=${workout_log.length} body=${body_stats_log.length} settings=${settings.length} chat=${ai_chat_history.length} tombstones=${workout_tombstones.length}`);

  res.json({
    exercises,
    programs,
    workout_templates,
    program_assignments,
    workout_log,
    body_stats_log,
    workout_tombstones,
    user_settings: settings,
    ai_chat_history,
    server_time: serverTime,
  });
}));

// ── POST /push ───────────────────────────────────────────────────────────
// Receives changed rows from the client. Each row carries:
//   - client_id : local row id on the device (returned in response so the
//                 client can map to the new server_id for inserts)
//   - server_id : if the row was previously synced from the server, its
//                 server-side id; otherwise null
//   - updated_at: client's last mutation timestamp (ISO)
//   - deleted_at: when set, marks a soft-delete to apply server-side
//   - …field columns…
//
// Returns { exercises: [{ client_id, server_id }, ...], ... } for
// newly inserted rows so the client can stitch its local cache to the
// canonical server ids on the next pull.
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const body = req.body || {};
  const result = {
    exercises: [], programs: [], workout_templates: [], program_assignments: [],
    workout_log: [], body_stats_log: [], user_settings: [], ai_chat_history: [],
  };

  const norm = ts => ts ? toSqlTime(ts) : '';
  const wins = (clientTs, serverTs) => norm(clientTs) >= norm(serverTs || '');

  const run = db.transaction(() => {
    // ── exercises ──────────────────────────────────────────────────────
    for (const e of (body.exercises || [])) {
      const existing = e.server_id
        ? db.prepare('SELECT updated_at FROM exercises WHERE id = ?').get(e.server_id)
        : null;
      if (e.server_id && existing) {
        if (wins(e.updated_at, existing.updated_at)) {
          if (e.deleted_at) {
            db.prepare(`UPDATE exercises SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(e.server_id);
          } else {
            db.prepare(
              `UPDATE exercises SET name=?, category=?, primary_muscles=?, secondary_muscles=?, equipment=?, instructions=?, tips=?, img_url=?, gif_url=?, video_url=?, updated_at=datetime('now') WHERE id=?`
            ).run(
              e.name, e.category || null,
              JSON.stringify(e.primary_muscles || []),
              JSON.stringify(e.secondary_muscles || []),
              JSON.stringify(e.equipment || []),
              e.instructions || null, e.tips || null,
              e.img_url || null, e.gif_url || null, e.video_url || null,
              e.server_id
            );
          }
        }
        result.exercises.push({ client_id: e.client_id, server_id: e.server_id });
      } else if (!e.deleted_at) {
        const r = db.prepare(
          `INSERT INTO exercises (name, category, primary_muscles, secondary_muscles, equipment, instructions, tips, img_url, gif_url, video_url, source, is_global, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', 0, ?, datetime('now'))`
        ).run(
          e.name, e.category || null,
          JSON.stringify(e.primary_muscles || []),
          JSON.stringify(e.secondary_muscles || []),
          JSON.stringify(e.equipment || []),
          e.instructions || null, e.tips || null,
          e.img_url || null, e.gif_url || null, e.video_url || null,
          u
        );
        result.exercises.push({ client_id: e.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── programs ──────────────────────────────────────────────────────
    for (const p of (body.programs || [])) {
      const existing = p.server_id
        ? db.prepare('SELECT updated_at FROM programs WHERE id = ?').get(p.server_id)
        : null;
      if (p.server_id && existing) {
        if (wins(p.updated_at, existing.updated_at)) {
          if (p.deleted_at) {
            db.prepare(`UPDATE programs SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(p.server_id);
          } else {
            db.prepare(
              `UPDATE programs SET name=?, description=?, goal=?, visibility=?, duration_weeks=?, advance_mode=?, on_complete=?, updated_at=datetime('now') WHERE id=?`
            ).run(p.name, p.description || null, p.goal || 'general', p.visibility || 'private', p.duration_weeks ?? 1, p.advance_mode || 'sessions', p.on_complete || 'hold', p.server_id);
          }
        }
        result.programs.push({ client_id: p.client_id, server_id: p.server_id });
      } else if (!p.deleted_at) {
        const r = db.prepare(
          `INSERT INTO programs (name, description, goal, visibility, duration_weeks, advance_mode, on_complete, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(p.name, p.description || null, p.goal || 'general', p.visibility || 'private', p.duration_weeks ?? 1, p.advance_mode || 'sessions', p.on_complete || 'hold', u);
        result.programs.push({ client_id: p.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── workout_templates ─────────────────────────────────────────────
    for (const t of (body.workout_templates || [])) {
      const existing = t.server_id
        ? db.prepare('SELECT * FROM workout_templates WHERE id = ?').get(t.server_id)
        : null;

      // Option C: parse deleted_uuids per-template.
      const dr = t.deleted_uuids;
      const delExUuids = Array.isArray(dr?.exercises) ? dr.exercises : (Array.isArray(dr) ? dr : []);
      const delSetsByEx = (dr && typeof dr.sets === 'object' && !Array.isArray(dr.sets)) ? dr.sets : {};

      if (t.server_id && existing) {
        if (wins(t.updated_at, existing.updated_at)) {
          if (t.deleted_at) {
            db.prepare(`UPDATE workout_templates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(t.server_id);
          } else {
            // Per-uuid merge instead of wholesale replace.
            const serverExs = JSON.parse(existing.exercises || '[]');
            const priorExTs = _loadTemplateTombstones(t.server_id, 'template_exercise').map(r => r.uuid);
            const priorSetTsByEx = {};
            for (const r of _loadTemplateTombstones(t.server_id, 'template_set')) {
              (priorSetTsByEx[r.ex_uuid] = priorSetTsByEx[r.ex_uuid] || []).push(r.uuid);
            }
            const {
              merged, newTombstoneExerciseUuids, newTombstoneSetUuidsByExercise,
            } = mergeExercises(
              serverExs, ensureExerciseUuids(t.exercises || []),
              delExUuids, priorExTs,
              delSetsByEx, priorSetTsByEx
            );
            db.prepare(
              `UPDATE workout_templates SET name=?, day_label=?, order_index=?, exercises=?, updated_at=datetime('now') WHERE id=?`
            ).run(t.name, t.day_label || null, t.order_index ?? 0, JSON.stringify(merged), t.server_id);
            const tsKey = `template:${t.server_id}`;
            const insertTs = db.prepare(
              `INSERT OR IGNORE INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at)
               VALUES (NULL, ?, ?, ?, ?, datetime('now'))`
            );
            for (const uuid of newTombstoneExerciseUuids) insertTs.run(tsKey, 'template_exercise', '', uuid);
            for (const [exUuid, uuids] of Object.entries(newTombstoneSetUuidsByExercise)) {
              for (const uuid of uuids) insertTs.run(tsKey, 'template_set', exUuid, uuid);
            }
          }
        }
        result.workout_templates.push({ client_id: t.client_id, server_id: t.server_id });
      } else if (!t.deleted_at && t.program_id) {
        // Fresh insert: uuids ensured up-front so subsequent merges have identity.
        const exs = ensureExerciseUuids(t.exercises || []);
        const r = db.prepare(
          `INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).run(t.program_id, t.name, t.day_label || null, t.order_index ?? 0, JSON.stringify(exs));
        result.workout_templates.push({ client_id: t.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── workout_log (UNIQUE(user_id, date) — date is the natural key) ─
    //
    // Option C: exercises + sets merge per-uuid instead of wholesale
    // replace. See project_traceapps_diary_merge_port. Removed the
    // silent-DELETE-on-empty behavior that used to live in the PUT
    // route; day-level deletion is now solely driven by explicit
    // `deleted_at` (soft delete) on the pushed row.
    for (const w of (body.workout_log || [])) {
      const existing = db.prepare(
        `SELECT * FROM workout_log WHERE user_id ${u != null ? '= ?' : 'IS NULL'} AND date = ?`
      ).get(...(u != null ? [u, w.date] : [w.date]));

      const dr = w.deleted_uuids;
      const delExUuids = Array.isArray(dr?.exercises) ? dr.exercises : (Array.isArray(dr) ? dr : []);
      const delSetsByEx = (dr && typeof dr.sets === 'object' && !Array.isArray(dr.sets)) ? dr.sets : {};

      const insertTs = db.prepare(
        `INSERT OR IGNORE INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      );

      if (existing) {
        if (wins(w.updated_at, existing.updated_at)) {
          if (w.deleted_at) {
            db.prepare(`UPDATE workout_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
          } else {
            const serverExs = JSON.parse(existing.exercises || '[]');
            const priorExTs = _loadExUuidsForDate(u, w.date);
            const priorSetTsByEx = _loadSetUuidsByExForDate(u, w.date);
            const {
              merged, newTombstoneExerciseUuids, newTombstoneSetUuidsByExercise,
            } = mergeExercises(
              serverExs, ensureExerciseUuids(w.exercises || []),
              delExUuids, priorExTs,
              delSetsByEx, priorSetTsByEx
            );
            db.prepare(
              `UPDATE workout_log SET name=?, exercises=?, notes=?, duration_min=?, completed=?, template_id=?, program_id=?, program_week=?, updated_at=datetime('now') WHERE id=?`
            ).run(w.name || null, JSON.stringify(merged), w.notes || null, w.duration_min ?? null, w.completed ? 1 : 0, w.template_id || null, w.program_id || null, w.program_week ?? null, existing.id);
            for (const uuid of newTombstoneExerciseUuids) insertTs.run(u, w.date, 'exercise', '', uuid);
            for (const [exUuid, uuids] of Object.entries(newTombstoneSetUuidsByExercise)) {
              for (const uuid of uuids) insertTs.run(u, w.date, 'set', exUuid, uuid);
            }
          }
        }
        result.workout_log.push({ client_id: w.client_id, server_id: existing.id });
      } else if (!w.deleted_at) {
        // Fresh insert: ensure uuids so subsequent merges have identity.
        const exs = ensureExerciseUuids(w.exercises || []);
        const r = db.prepare(
          `INSERT INTO workout_log (user_id, date, name, exercises, notes, duration_min, completed, template_id, program_id, program_week, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, w.date, w.name || null, JSON.stringify(exs), w.notes || null, w.duration_min ?? null, w.completed ? 1 : 0, w.template_id || null, w.program_id || null, w.program_week ?? null);
        result.workout_log.push({ client_id: w.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── body_stats_log (UNIQUE(user_id, date)) ─────────────────────────
    //
    // Option C: per-key merge of the stats object. Empty push preserves
    // every existing key; incoming values overwrite; explicit nulls clear.
    for (const b of (body.body_stats_log || [])) {
      const existing = db.prepare(
        `SELECT * FROM body_stats_log WHERE user_id ${u != null ? '= ?' : 'IS NULL'} AND date = ?`
      ).get(...(u != null ? [u, b.date] : [b.date]));
      if (existing) {
        if (wins(b.updated_at, existing.updated_at)) {
          if (b.deleted_at) {
            db.prepare(`UPDATE body_stats_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
          } else {
            const serverStats = JSON.parse(existing.stats || '{}');
            const merged = mergeStatsObject(serverStats, b.stats);
            db.prepare(
              `UPDATE body_stats_log SET stats=?, updated_at=datetime('now') WHERE id=?`
            ).run(JSON.stringify(merged), existing.id);
          }
        }
        result.body_stats_log.push({ client_id: b.client_id, server_id: existing.id });
      } else if (!b.deleted_at) {
        const r = db.prepare(
          `INSERT INTO body_stats_log (user_id, date, stats, updated_at) VALUES (?, ?, ?, datetime('now'))`
        ).run(u, b.date, JSON.stringify(b.stats || {}));
        result.body_stats_log.push({ client_id: b.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── user_settings — keyed by (user_id, key), no surrogate id ───────
    for (const s of (body.user_settings || [])) {
      if (!s.key || isServerOnlyKey(s.key)) continue;
      const existing = u != null
        ? db.prepare('SELECT updated_at FROM user_settings WHERE user_id = ? AND key = ?').get(u, s.key)
        : null;
      if (existing) {
        if (wins(s.updated_at, existing.updated_at)) {
          db.prepare(
            `UPDATE user_settings SET value=?, updated_at=datetime('now') WHERE user_id=? AND key=?`
          ).run(s.value ?? null, u, s.key);
        }
      } else if (u != null) {
        db.prepare(
          `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))`
        ).run(u, s.key, s.value ?? null);
      }
      result.user_settings.push({ key: s.key });
    }

    // ── ai_chat_history — append-only on push ──────────────────────────
    for (const c of (body.ai_chat_history || [])) {
      if (c.deleted_at && c.server_id) {
        db.prepare(`UPDATE ai_chat_history SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(c.server_id);
        result.ai_chat_history.push({ client_id: c.client_id, server_id: c.server_id });
      } else if (!c.server_id && !c.deleted_at && c.role && c.content) {
        const r = db.prepare(
          `INSERT INTO ai_chat_history (user_id, role, content, created_at, updated_at)
           VALUES (?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))`
        ).run(u, c.role, c.content, c.created_at || null);
        result.ai_chat_history.push({ client_id: c.client_id, server_id: r.lastInsertRowid });
      }
    }
  });
  run();

  res.json(result);
}));

export default router;
