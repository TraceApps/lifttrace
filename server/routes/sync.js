/**
 * sync.js — Differential sync endpoints for the Capacitor Android app.
 *
 *   GET  /api/sync/pull?since=<ISO>  → all rows changed in any syncable
 *                                       table since that timestamp, plus
 *                                       a fresh server_time the client
 *                                       sends back as `since` next pull.
 *   POST /api/sync/push              → batch upsert of pending writes
 *                                       from the client. A row older than
 *                                       the server's (updated_at) changes
 *                                       nothing; a newer one meets the
 *                                       row field by field, as the app's
 *                                       own saves do (lib/newer-wins.js).
 *                                       Returns client_id → server_id
 *                                       mappings for newly created rows.
 *
 * Scope (LiftTrace tables): exercises (custom + user), programs,
 * workout_templates, program_assignments, workout_log, body_stats_log,
 * user_settings, ai_chat_history, excused_days (pull only: the phone sends
 * its changes to them through /api/excused-days, as queued writes).
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
import zlib from 'node:zlib';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { attachAssignedPrograms } from '../lib/assigned-programs.js';
import { mergeExercises, ensureExerciseUuids, mergeStatsObject } from '../lib/workout-merge.js';
import { applyToBody, createdTimes, decide, deleteLoses, stampMerged } from '../lib/newer-wins.js';
import { canChangeExercise } from '../lib/exercise-owner.js';
import { localizeDataUrl } from '../lib/image-localizer.js';
import { canChangeProgram, cleanWorkoutRefs, programFor, toId, visibleProgramsSql, visibleTemplatesSql } from '../lib/program-access.js';
import { readablePairingIds, messageOut } from '../lib/coaching-messages.js';
import { soloStart } from '../lib/solo-program.js';
import { rememberZone } from '../lib/user-zone.js';

// ── Tombstone helpers for the sync push/pull loops (Option C) ─────────
// Same shape as workout.js — duplicated here to keep both routes
// self-contained. If we grow more callers, promote to a shared module.
function _tsWhere(u) { return u == null ? 'user_id IS NULL' : 'user_id = ?'; }
// workoutId scopes a tombstone to one session vs another on the same
// date (issue #76) — matches the column's own NOT NULL DEFAULT 0 in
// db.js; every call site below has a real workout_log row by the time
// these run, so workoutId is always the row's actual id.
function _loadExUuidsForDate(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'exercise'`);
  return (u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId)).map(r => r.uuid);
}
function _loadSetUuidsByExForDate(u, date, workoutId) {
  const where = _tsWhere(u);
  const stmt = db.prepare(`SELECT ex_uuid, uuid FROM workout_tombstones WHERE ${where} AND date = ? AND workout_id = ? AND kind = 'set'`);
  const rows = u == null ? stmt.all(date, workoutId) : stmt.all(u, date, workoutId);
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
  // workout_id included so the client's own local tombstone mirror (also
  // scoped by workout_id post-#76) can apply this to the right session.
  const stmt = db.prepare(`SELECT date, workout_id, kind, ex_uuid, uuid, deleted_at FROM workout_tombstones WHERE ${where} AND deleted_at >= ? ORDER BY deleted_at`);
  return u == null ? stmt.all(sinceSql) : stmt.all(u, sinceSql);
}

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user?.id : null;

// A picture embedded in a pushed row becomes a file, as on the REST routes,
// so no row stores a data URL. One that can't be stored (not an image, too
// large) is left out rather than failing the whole batch, which the client
// would otherwise resend forever: `fallback` goes in instead.
function localizeOr(value, fallback, opts) {
  try {
    const out = localizeDataUrl(value, opts);
    if (typeof out === 'string' && /^data:/i.test(out)) throw new Error('not a supported image type');
    return out;
  } catch (e) {
    logger.warn(`[sync] push: an embedded image was not stored: ${e.message}`);
    return fallback;
  }
}

// A pushed row read as the edit it is, for lib/newer-wins.js: made at the
// row's updated_at (the device's clock, never later than now), changing the
// fields it lists in `changed_fields` (as X-Changed-Fields does for the
// app's own saves), or every field it sends when it lists none. The newer edit of each field then stays, as for
// the app's own saves (PUT /api/workout/:date and friends), so a copy made
// before a change elsewhere (a workout started from Home Assistant, an edit
// on another device) can't put back what it had, and what a push writes is
// stamped, so an older edit queued on a phone can't overwrite it.
function pushedEdit(row) {
  const ms = instantMs(row?.updated_at);
  const at = Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  const changed = Array.isArray(row?.changed_fields) ? row.changed_fields.map(String).join(',') : undefined;
  return {
    get: (h) => {
      const k = String(h).toLowerCase();
      return k === 'x-edited-at' ? at : k === 'x-changed-fields' ? changed : undefined;
    },
  };
}

// A pushed time as an instant: an ISO time with its zone (Z or an offset),
// or the server's own 'YYYY-MM-DD HH:MM:SS', and a time with no zone, read
// as UTC as the server writes them. NaN when it isn't a time.
function instantMs(ts) {
  if (ts == null || ts === '') return NaN;
  if (typeof ts === 'number') return ts;
  let t = String(ts).trim().replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';
  return Date.parse(t);
}

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
  // The phone's zone (?tz=), kept for the account so its "today" is right
  // where the server works one out for it, the coach's view of it included
  // (lib/user-zone.js, issue #121).
  rememberZone(u, req.query.tz);
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

  // programs has created_by, not user_id. The programs this account may
  // see (program-access.js): its own, ones assigned to it, and the
  // starters. A deleted account's programs have no maker either, but stay
  // private. Their workout days follow the same rule; every account's
  // days used to go to every device.
  const visible = visibleProgramsSql(u);
  const programs = db.prepare(
    `SELECT p.* FROM programs p
      WHERE p.updated_at >= ? AND ${visible.sql}
      ORDER BY p.updated_at`
  ).all(sinceSql, ...visible.args).map(parseRow);

  // Days also go to the athlete a coach prescribed one to, and arrive
  // when they are prescribed: the day itself may not have changed in months.
  const visibleDays = visibleTemplatesSql(u);
  const prescribedSince = u != null
    ? 'OR EXISTS (SELECT 1 FROM coach_prescriptions cp WHERE cp.template_id = t.id AND cp.member_id = ? AND cp.created_at >= ?)'
    : '';
  const workout_templates = db.prepare(
    `SELECT t.* FROM workout_templates t JOIN programs p ON p.id = t.program_id
      WHERE (t.updated_at >= ? ${prescribedSince}) AND ${visibleDays.sql}
      ORDER BY t.updated_at`
  ).all(sinceSql, ...(u != null ? [u, sinceSql] : []), ...visibleDays.args).map(parseRow);

  const program_assignments = u != null
    ? db.prepare(
        `SELECT * FROM program_assignments
         WHERE updated_at >= ? AND assigned_to = ?
         ORDER BY updated_at`
      ).all(sinceSql, u).map(parseRow)
    : db.prepare(
        `SELECT * FROM program_assignments WHERE updated_at >= ? ORDER BY updated_at`
      ).all(sinceSql).map(parseRow);

  // An assignment is written without touching the program it points at, so
  // a differential pull would hand the athlete's device an assignment for a
  // plan it has never seen. The plan travels with the assignment instead.
  if (u != null) {
    attachAssignedPrograms(db, {
      assignments: program_assignments,
      programs,
      templates: workout_templates,
      parseRow,
    });
  }

  const workout_log = db.prepare(
    `SELECT * FROM workout_log WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams).map(parseRow);

  const body_stats_log = db.prepare(
    `SELECT * FROM body_stats_log WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams).map(parseRow);

  const body_stat_media = db.prepare(
    `SELECT * FROM body_stat_media WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams).map(parseRow);

  // Excused days (issue #121), removed ones included (deleted_at), so a
  // removal reaches the phone. Keyed by date on the phone.
  const excused_days = db.prepare(
    `SELECT id, date, reason, note, updated_at, deleted_at FROM excused_days WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(sinceSql, ...userParams);

  // Set videos (issue #57). The rows travel; the files do not, they are
  // fetched on demand from /api/set-media/:id/file, which is also why a clip
  // is the one piece of the diary that needs a connection to watch.
  const set_media = db.prepare(
    `SELECT * FROM set_media WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
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

  // Rows deleted on the server since the cursor, as { id, deleted_at } rows
  // the app removes locally (#139): this user's own, and shared ones (whose
  // owner is NULL). Ids only: a device that never had the row deletes
  // nothing. A first, full pull skips them, as the device holds nothing yet;
  // a full pull asked for by a device that holds data (held=1: its copy was
  // reset to be pulled again) gets them, so what's gone leaves it too.
  const fullPull = sinceSql <= '1970-01-01 00:00:00' && req.query.held !== '1';
  const deletedSince = db.prepare(
    `SELECT row_id AS id, deleted_at FROM sync_deletions
      WHERE tbl = ? AND deleted_at >= ? ${u != null ? 'AND (user_id IS NULL OR user_id = ?)' : ''}`
  );
  const gone = (tbl) => (fullPull ? [] : deletedSince.all(tbl, sinceSql, ...userParams));
  programs.push(...gone('programs'));
  workout_templates.push(...gone('workout_templates'));
  program_assignments.push(...gone('program_assignments'));
  exercises.push(...gone('exercises'));
  workout_log.push(...gone('workout_log'));
  body_stats_log.push(...gone('body_stats_log'));
  ai_chat_history.push(...gone('ai_chat_history'));
  excused_days.push(...gone('excused_days'));
  // A setting deleted: { key, deleted_at } in the settings list (db.js keeps
  // the key with the record).
  if (u != null && !fullPull) {
    settings.push(...db.prepare(
      `SELECT row_key AS key, deleted_at FROM sync_deletions WHERE tbl = 'user_settings' AND user_id = ? AND deleted_at >= ? AND row_key IS NOT NULL`
    ).all(u, sinceSql));
  }

  // Every program and workout day this account may keep, in full: a phone
  // drops any it holds that are not listed. That covers ones deleted, a
  // program unassigned from an athlete, and the days of every account that
  // older servers sent to every phone.
  const keep = {
    programs: db.prepare(`SELECT p.id FROM programs p WHERE ${visible.sql}`)
      .all(...visible.args).map(r => r.id),
    workout_templates: db.prepare(
      `SELECT t.id FROM workout_templates t JOIN programs p ON p.id = t.program_id WHERE ${visibleDays.sql}`
    ).all(...visibleDays.args).map(r => r.id),
  };

  // Without user accounts the program being followed lives in app_config,
  // not in program_assignments, so it went nowhere and a phone never learned
  // of a change made on the web. Sent in full every pull: it's one row.
  // `started_at`: when it became the one followed, its calendar clock
  // (lib/solo-program.js, issue #121); a phone from before ignores it.
  let solo_active;
  if (u == null) {
    const cfg = (k) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(k)?.value ?? null;
    const pid = toId(cfg('active_program'));
    let cursor = {};
    try { cursor = JSON.parse(cfg('active_program_cursor') || '{}') || {}; } catch { /* none */ }
    solo_active = pid && db.prepare('SELECT 1 FROM programs WHERE id = ?').get(pid)
      ? { program_id: pid, week_cursor: cursor.week ?? null, week_cursor_session_base: cursor.base ?? null, week_cursor_pinned_at: cursor.pinnedAt ?? null, started_at: soloStart() }
      : null;
  }

  // Coaching conversations, only for an app that asks (?coaching=1): an
  // Android app from before them gets exactly the answer it always did.
  // `coaching.pairings` lists every conversation this person may still read,
  // so the phone drops one a coach no longer has.
  const coachingOut = {};
  if (req.query.coaching === '1' && u != null) {
    const pairings = readablePairingIds(u);
    const msgs = pairings.length
      ? db.prepare(`SELECT * FROM coach_messages WHERE updated_at >= ? AND pairing_id IN (${pairings.map(() => '?').join(',')}) ORDER BY updated_at, id`).all(sinceSql, ...pairings)
      : [];
    coachingOut.coach_messages = msgs.map(messageOut);
    coachingOut.coaching = { pairings };
  }

  logger.debug?.(`[sync] pull since=${sinceSql} user=${u ?? '-'}: exercises=${exercises.length} programs=${programs.length} templates=${workout_templates.length} assignments=${program_assignments.length} workouts=${workout_log.length} body=${body_stats_log.length} settings=${settings.length} chat=${ai_chat_history.length} tombstones=${workout_tombstones.length}`);

  sendMaybeGzipped(req, res, {
    exercises,
    programs,
    workout_templates,
    program_assignments,
    workout_log,
    body_stats_log,
    body_stat_media,
    set_media,
    excused_days,
    workout_tombstones,
    user_settings: settings,
    ai_chat_history,
    keep,
    ...(u == null ? { solo_active } : {}),
    ...coachingOut,
    server_time: serverTime,
  });
}));

// A full pull of a long history is several hundred kilobytes of JSON that
// shrinks about twentyfold; on a phone's slow link that was the difference
// between finishing and timing out on every try. Compressed when the client
// takes it (Android's HTTP stack asks for gzip and unpacks it itself).
function sendMaybeGzipped(req, res, payload) {
  const body = JSON.stringify(payload);
  if (body.length < 2048 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.type('application/json').send(body);
    return;
  }
  zlib.gzip(body, (err, gz) => {
    if (err) { res.type('application/json').send(body); return; }
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.send(gz);
  });
}

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
    workout_log: [], body_stats_log: [], body_stat_media: [], set_media: [], user_settings: [], ai_chat_history: [],
  };

  const norm = ts => ts ? toSqlTime(ts) : '';
  // A pushed row as new as the server's, to the second (the server keeps
  // whole seconds; a tie goes to the device), compared as instants, so a
  // time written with a zone offset counts as the time it is. One that
  // can't be read is compared as text, as before.
  const wins = (clientTs, serverTs) => {
    const c = instantMs(clientTs), sv = instantMs(serverTs);
    if (Number.isFinite(c) && Number.isFinite(sv)) return Math.floor(c / 1000) >= Math.floor(sv / 1000);
    return norm(clientTs) >= norm(serverTs || '');
  };

  const run = db.transaction(() => {
    // ── exercises ──────────────────────────────────────────────────────
    for (const e of (body.exercises || [])) {
      const existing = e.server_id
        ? db.prepare('SELECT * FROM exercises WHERE id = ?').get(e.server_id)
        : null;
      if (e.server_id && existing) {
        // Only a row this user owns is written. A library exercise, or
        // someone else's, used to be overwritten or deleted by whichever
        // phone pushed it; now it is answered as though it lost the
        // timestamp race, so the phone stops sending it and nothing changes
        // underneath anyone else (see lib/exercise-owner.js).
        if (canChangeExercise(existing, u) && wins(e.updated_at, existing.updated_at)) {
          const edit = pushedEdit(e);
          if (e.deleted_at) {
            // Kept when something in it changed after the delete was made
            // (DELETE /api/exercises/:id does the same); touched, so the
            // device gets it back with its next pull.
            if (deleteLoses(edit, existing)) db.prepare(`UPDATE exercises SET updated_at = datetime('now') WHERE id = ?`).run(e.server_id);
            else db.prepare(`UPDATE exercises SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(e.server_id);
          } else {
            // The newer edit of each field stays (PUT /api/exercises/:id).
            const JSON_FIELDS = new Set(['primary_muscles', 'secondary_muscles', 'equipment']);
            const v = { ...e };
            const times = applyToBody(edit, existing, v, {
              fields: ['name', 'category', 'primary_muscles', 'secondary_muscles', 'equipment', 'instructions', 'tips', 'img_url', 'gif_url', 'video_url'],
              groups: [['img_url', 'gif_url', 'video_url']],
              current: f => (JSON_FIELDS.has(f) ? JSON.parse(existing[f] || '[]') : existing[f]),
            });
            db.prepare(
              `UPDATE exercises SET name=?, category=?, primary_muscles=?, secondary_muscles=?, equipment=?, instructions=?, tips=?, img_url=?, gif_url=?, video_url=?, field_times=?, updated_at=datetime('now') WHERE id=?`
            ).run(
              v.name, v.category || null,
              JSON.stringify(v.primary_muscles || []),
              JSON.stringify(v.secondary_muscles || []),
              JSON.stringify(v.equipment || []),
              v.instructions || null, v.tips || null,
              localizeOr(v.img_url, existing.img_url) || null, localizeOr(v.gif_url, existing.gif_url) || null, v.video_url || null,
              times,
              e.server_id
            );
          }
        }
        result.exercises.push({ client_id: e.client_id, server_id: e.server_id });
      } else if (!e.deleted_at) {
        const r = db.prepare(
          `INSERT INTO exercises (name, category, primary_muscles, secondary_muscles, equipment, instructions, tips, img_url, gif_url, video_url, source, is_global, created_by, field_times, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', 0, ?, ?, datetime('now'))`
        ).run(
          e.name, e.category || null,
          JSON.stringify(e.primary_muscles || []),
          JSON.stringify(e.secondary_muscles || []),
          JSON.stringify(e.equipment || []),
          e.instructions || null, e.tips || null,
          localizeOr(e.img_url, null) || null, localizeOr(e.gif_url, null) || null, e.video_url || null,
          u, createdTimes(pushedEdit(e))
        );
        result.exercises.push({ client_id: e.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── programs ──────────────────────────────────────────────────────
    for (const p of (body.programs || [])) {
      const existing = p.server_id
        ? db.prepare('SELECT * FROM programs WHERE id = ?').get(p.server_id)
        : null;
      if (p.server_id && existing) {
        // Only the program's maker changes it (program-access.js); anyone
        // else is answered as if they lost the timestamp race.
        if (canChangeProgram(existing, u) && wins(p.updated_at, existing.updated_at)) {
          const edit = pushedEdit(p);
          if (p.deleted_at) {
            // Kept when it or one of its days changed after the delete was
            // made (DELETE /api/programs/:id does the same).
            const days = db.prepare('SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL').all(p.server_id);
            if ([existing, ...days].some(r => deleteLoses(edit, r))) db.prepare(`UPDATE programs SET updated_at = datetime('now') WHERE id = ?`).run(p.server_id);
            else db.prepare(`UPDATE programs SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(p.server_id);
          } else {
            // The newer edit of each field stays; the length and how a plan
            // moves on go together (PUT /api/programs/:id).
            const v = { ...p };
            const times = applyToBody(edit, existing, v, {
              fields: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete'],
              groups: [['duration_weeks', 'advance_mode', 'on_complete']],
              current: f => existing[f],
            });
            db.prepare(
              `UPDATE programs SET name=?, description=?, goal=?, visibility=?, duration_weeks=?, advance_mode=?, on_complete=?, field_times=?, updated_at=datetime('now') WHERE id=?`
            ).run(v.name, v.description || null, v.goal || 'general', v.visibility || 'private', v.duration_weeks ?? 1, v.advance_mode || 'sessions', v.on_complete || 'hold', times, p.server_id);
          }
        }
        result.programs.push({ client_id: p.client_id, server_id: p.server_id });
      } else if (!p.deleted_at) {
        const r = db.prepare(
          `INSERT INTO programs (name, description, goal, visibility, duration_weeks, advance_mode, on_complete, created_by, field_times, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(p.name, p.description || null, p.goal || 'general', p.visibility || 'private', p.duration_weeks ?? 1, p.advance_mode || 'sessions', p.on_complete || 'hold', u, createdTimes(pushedEdit(p)));
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

      const canChangeDay = id => toId(id) != null && programFor(toId(id), u).canChange;
      if (t.server_id && existing) {
        if (canChangeDay(existing.program_id) && wins(t.updated_at, existing.updated_at)) {
          const edit = pushedEdit(t);
          if (t.deleted_at) {
            // Kept when it changed after the delete was made (DELETE
            // /api/templates/:id does the same).
            if (!existing.deleted_at && deleteLoses(edit, existing)) db.prepare(`UPDATE workout_templates SET updated_at = datetime('now') WHERE id = ?`).run(t.server_id);
            else db.prepare(`UPDATE workout_templates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(t.server_id);
          } else {
            // Per-uuid merge instead of wholesale replace. Note (issue
            // #85): serverExs is intentionally NOT pre-backfilled -- see
            // workout-merge.js's mergeEntries() for the uuid-less-server
            // bootstrap this would otherwise defeat.
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
            // The newer edit of the name and label stays (PUT
            // /api/templates/:id); the exercises merge one by one, above.
            const v = { ...t };
            let times = applyToBody(edit, existing, v, { fields: ['name', 'day_label'], current: f => existing[f] });
            if (Array.isArray(t.exercises) || t.deleted_uuids) times = stampMerged(edit, times, ['exercises']);
            db.prepare(
              `UPDATE workout_templates SET name=?, day_label=?, order_index=?, exercises=?, field_times=?, updated_at=datetime('now') WHERE id=?`
            ).run(v.name, v.day_label || null, t.order_index ?? 0, JSON.stringify(merged), times, t.server_id);
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
      } else if (!t.deleted_at && t.program_id && canChangeDay(t.program_id)) {
        // Fresh insert: uuids ensured up-front so subsequent merges have identity.
        const exs = ensureExerciseUuids(t.exercises || []);
        const r = db.prepare(
          `INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises, field_times, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(toId(t.program_id), t.name, t.day_label || null, t.order_index ?? 0, JSON.stringify(exs), createdTimes(pushedEdit(t)));
        result.workout_templates.push({ client_id: t.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── workout_log (issue #76: no longer UNIQUE(user_id,date) — a date
    // can have multiple sessions, addressed by id like every other
    // entity in this file) ─
    //
    // Option C: exercises + sets merge per-uuid instead of wholesale
    // replace. See project_traceapps_diary_merge_port. Removed the
    // silent-DELETE-on-empty behavior that used to live in the PUT
    // route; day-level deletion is now solely driven by explicit
    // `deleted_at` (soft delete) on the pushed row.
    //
    // Identity: prefer w.server_id (same convention every other entity
    // in this file already uses) so a second session pushes as its own
    // row instead of colliding with the first. Only legacy queued
    // payloads from a pre-#76 client (no server_id yet) fall back to the
    // old (user_id, date) lookup, which now picks the lowest
    // session_seq/id — reproducing exactly what that client already
    // believes is "the" workout for that date.
    for (const w of (body.workout_log || [])) {
      // This account's own workout only: someone else's id falls through
      // to the date lookup below, as an id that doesn't resolve does.
      let existing = w.server_id
        ? db.prepare(`SELECT * FROM workout_log WHERE id = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
            .get(w.server_id, ...(u != null ? [u] : []))
        : null;
      // Issue #87: a server_id that does NOT resolve (stale device-
      // cached id, a row that no longer exists) falls back to the same
      // live-default lookup legacy pre-#76 clients already use, instead
      // of falling through to the insert branch below and creating a
      // duplicate live session_seq=0 row for this date. Excludes soft-
      // deleted rows (a real bug this same pass turned up: without it,
      // a push could resolve onto an already-deleted row and write
      // fresh content into it via the merge branch below, which does
      // not clear deleted_at, silently corrupting a "deleted" session
      // instead of leaving it deleted or starting a fresh one).
      if (!existing) {
        existing = db.prepare(
          `SELECT * FROM workout_log WHERE user_id ${u != null ? '= ?' : 'IS NULL'} AND date = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1`
        ).get(...(u != null ? [u, w.date] : [w.date]));
      }

      // The newer edit of each of the session's own fields stays, its
      // program, program workout and week together, as PUT
      // /api/workout/:date decides it (lib/newer-wins.js); decided on what
      // the row sent, before the refs below are checked, as there.
      const edit = pushedEdit(w);
      let times = null;
      if (existing && !w.deleted_at && wins(w.updated_at, existing.updated_at)) {
        times = applyToBody(edit, existing, w, {
          fields: ['name', 'notes', 'duration_min', 'completed', 'program_week', 'program_id', 'template_id'],
          groups: [['program_id', 'template_id', 'program_week']],
          current: f => existing[f],
        });
        if (Array.isArray(w.exercises) || w.deleted_uuids) times = stampMerged(edit, times, ['exercises']);
      }

      // Only a program, day and exercises this account may see.
      Object.assign(w, cleanWorkoutRefs(u, { ...w, exercises: w.exercises || [] }, existing));

      const dr = w.deleted_uuids;
      const delExUuids = Array.isArray(dr?.exercises) ? dr.exercises : (Array.isArray(dr) ? dr : []);
      const delSetsByEx = (dr && typeof dr.sets === 'object' && !Array.isArray(dr.sets)) ? dr.sets : {};

      const insertTs = db.prepare(
        `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      );

      if (existing) {
        if (wins(w.updated_at, existing.updated_at)) {
          if (w.deleted_at) {
            // Kept when something in it changed after the delete was made
            // (DELETE /api/workout/:date does the same); touched, so the
            // device gets it back with its next pull.
            if (deleteLoses(edit, existing)) db.prepare(`UPDATE workout_log SET updated_at = datetime('now') WHERE id = ?`).run(existing.id);
            else db.prepare(`UPDATE workout_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
          } else {
            // Note (issue #85): serverExs is intentionally NOT
            // pre-backfilled -- see workout-merge.js's mergeEntries()
            // for the uuid-less-server bootstrap this would defeat.
            const serverExs = JSON.parse(existing.exercises || '[]');
            const priorExTs = _loadExUuidsForDate(u, w.date, existing.id);
            const priorSetTsByEx = _loadSetUuidsByExForDate(u, w.date, existing.id);
            const {
              merged, newTombstoneExerciseUuids, newTombstoneSetUuidsByExercise,
            } = mergeExercises(
              serverExs, ensureExerciseUuids(w.exercises || []),
              delExUuids, priorExTs,
              delSetsByEx, priorSetTsByEx
            );
            db.prepare(
              `UPDATE workout_log SET name=?, exercises=?, notes=?, duration_min=?, completed=?, template_id=?, program_id=?, program_week=?, field_times=?, updated_at=datetime('now') WHERE id=?`
            ).run(w.name || null, JSON.stringify(merged), w.notes || null, w.duration_min ?? null, w.completed ? 1 : 0, w.template_id || null, w.program_id || null, w.program_week ?? null, times, existing.id);
            for (const uuid of newTombstoneExerciseUuids) insertTs.run(u, w.date, existing.id, 'exercise', '', uuid);
            for (const [exUuid, uuids] of Object.entries(newTombstoneSetUuidsByExercise)) {
              for (const uuid of uuids) insertTs.run(u, w.date, existing.id, 'set', exUuid, uuid);
            }
          }
        }
        result.workout_log.push({ client_id: w.client_id, server_id: existing.id });
      } else if (!w.deleted_at) {
        // Fresh insert: ensure uuids so subsequent merges have identity.
        // session_seq comes from the pushed row when the client set one
        // (its own local session-creation logic decided it); legacy
        // clients that predate #76 never send it, defaulting to 0 —
        // identical to pre-#76 behavior since that was always the only
        // possible value.
        const exs = ensureExerciseUuids(w.exercises || []);
        const r = db.prepare(
          `INSERT INTO workout_log (user_id, date, name, exercises, notes, duration_min, completed, template_id, program_id, program_week, session_seq, field_times, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, w.date, w.name || null, JSON.stringify(exs), w.notes || null, w.duration_min ?? null, w.completed ? 1 : 0, w.template_id || null, w.program_id || null, w.program_week ?? null, w.session_seq ?? 0, createdTimes(edit));
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
            // The newer edit of each measurement stays (PUT /api/body-stats/:date).
            const serverStats = JSON.parse(existing.stats || '{}');
            const incoming = b.stats && typeof b.stats === 'object' && !Array.isArray(b.stats) ? { ...b.stats } : b.stats;
            let times = null;
            if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
              times = applyToBody(pushedEdit(b), existing, incoming, { fields: Object.keys(incoming), current: f => serverStats[f] });
              for (const k of Object.keys(incoming)) if (incoming[k] === undefined) delete incoming[k];
            }
            const merged = mergeStatsObject(serverStats, incoming);
            db.prepare(
              `UPDATE body_stats_log SET stats=?, field_times=COALESCE(?, field_times), updated_at=datetime('now') WHERE id=?`
            ).run(JSON.stringify(merged), times, existing.id);
          }
        }
        result.body_stats_log.push({ client_id: b.client_id, server_id: existing.id });
      } else if (!b.deleted_at) {
        const stats = b.stats && typeof b.stats === 'object' && !Array.isArray(b.stats) ? b.stats : {};
        const times = applyToBody(pushedEdit(b), null, { ...stats }, { fields: Object.keys(stats), current: () => undefined });
        const r = db.prepare(
          `INSERT INTO body_stats_log (user_id, date, stats, field_times, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`
        ).run(u, b.date, JSON.stringify(b.stats || {}), times);
        result.body_stats_log.push({ client_id: b.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── body_stat_media (progress photos) ──────────────────────────────
    //
    // Keyed by server_id, not (user_id, date) like body_stats_log above:
    // a date can hold several photos, so the date is not an identity.
    // A photo row is immutable once written, the only update that can
    // arrive is a soft-delete, so there is no field merge here.
    for (const p of (body.body_stat_media || [])) {
      const existing = p.server_id
        ? db.prepare(`SELECT * FROM body_stat_media WHERE id = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
            .get(...(u != null ? [p.server_id, u] : [p.server_id]))
        : null;
      if (existing) {
        if (p.deleted_at && !existing.deleted_at && wins(p.updated_at, existing.updated_at)) {
          db.prepare(`UPDATE body_stat_media SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
        }
        result.body_stat_media.push({ client_id: p.client_id, server_id: existing.id });
      } else if (!p.deleted_at && p.url && p.date) {
        // Into body-stats/, served only to its owner, like the REST route.
        const url = localizeOr(p.url, null, { subdir: 'body-stats' });
        if (!url) continue;
        const r = db.prepare(
          `INSERT INTO body_stat_media (user_id, date, kind, url, created_at, updated_at) VALUES (?, ?, 'photo', ?, datetime('now'), datetime('now'))`
        ).run(u, p.date, url);
        result.body_stat_media.push({ client_id: p.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── set_media (set videos) ───────────────────────────
    //
    // Same shape as progress photos above: keyed by server_id, immutable
    // once written, so the only update that can arrive is a soft-delete.
    // A clip is only ever created by the upload route (the file has to exist
    // before a row can point at it), so this never inserts: it carries
    // deletions between devices and nothing else.
    for (const m of (body.set_media || [])) {
      if (!m.server_id) continue;
      const existing = db.prepare(`SELECT * FROM set_media WHERE id = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
        .get(...(u != null ? [m.server_id, u] : [m.server_id]));
      if (!existing) continue;
      if (m.deleted_at && !existing.deleted_at && wins(m.updated_at, existing.updated_at)) {
        db.prepare(`UPDATE set_media SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
        db.prepare('UPDATE coach_feedback SET media_id = NULL, media_time_sec = NULL WHERE media_id = ?').run(existing.id);
      }
      result.set_media.push({ client_id: m.client_id, server_id: existing.id });
    }

    // ── user_settings — keyed by (user_id, key), no surrogate id ───────
    for (const s of (body.user_settings || [])) {
      if (!s.key || isServerOnlyKey(s.key)) continue;
      const existing = u != null
        ? db.prepare('SELECT * FROM user_settings WHERE user_id = ? AND key = ?').get(u, s.key)
        : null;
      if (existing) {
        if (wins(s.updated_at, existing.updated_at)) {
          // The newer edit of a setting stays (PUT /api/settings).
          const { keep, times } = decide(pushedEdit(s), existing, { value: s.value ?? null }, { fields: ['value'] });
          db.prepare(
            `UPDATE user_settings SET value=?, field_times=?, updated_at=datetime('now') WHERE user_id=? AND key=?`
          ).run(keep.has('value') ? existing.value : (s.value ?? null), times, u, s.key);
        }
      } else if (u != null) {
        const { times } = decide(pushedEdit(s), null, { value: s.value ?? null }, { fields: ['value'] });
        db.prepare(
          `INSERT INTO user_settings (user_id, key, value, field_times, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`
        ).run(u, s.key, s.value ?? null, times);
      }
      result.user_settings.push({ key: s.key });
    }

    // ── ai_chat_history — append-only on push ──────────────────────────
    for (const c of (body.ai_chat_history || [])) {
      if (c.deleted_at && c.server_id) {
        db.prepare(`UPDATE ai_chat_history SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
          .run(c.server_id, ...(u != null ? [u] : []));
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
