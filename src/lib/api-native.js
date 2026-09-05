/**
 * api-native.js — Local SQLite-backed implementation of LiftTrace's HTTP API.
 *
 * Used in Capacitor standalone mode (isNative + no server URL configured).
 * Exposes the same JSON shapes as the server so the existing fetch-based
 * frontend code works unchanged when routed here by `apiFetch.js`.
 *
 * Single-user model: all rows carry user_id = 1. There's no auth, no invites,
 * no trainer relationships, and no multi-user features. Endpoints that
 * require a server (sync-wger, image proxy, full-backup ZIP, push test) throw
 * a friendly error so the UI can render an "offline / standalone" hint.
 */

import {
  dbQuery,
  dbRun,
  enqueueSync,
  getSyncMeta,
  setSyncMeta,
} from './db-native.js';
import { currentPlanWeek } from './programWeek.js';

const ME = 1; // single-user id in standalone mode

// Load-type whitelist matches server/routes/exercises.js. Unknown values
// become NULL (unset) at the library level rather than corrupting the
// column. See src/lib/workout.js resolveLoadType.
const _KNOWN_LOAD_TYPES = new Set(['bilateral', 'paired', 'unilateral']);
function _cleanLoadType(v) {
  if (v == null || v === '') return null;
  return _KNOWN_LOAD_TYPES.has(v) ? v : null;
}

// ── helpers ───────────────────────────────────────────────────────────────

const _now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

const _parseJson = (s, fallback) => {
  try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
};

const _stringify = v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Convert a row out of the exercises table back into the shape the client
 * expects: JSON columns as arrays, image URLs unchanged.
 */
function _exerciseFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    primary_muscles:   _parseJson(r.primary_muscles, []),
    secondary_muscles: _parseJson(r.secondary_muscles, []),
    equipment:         _parseJson(r.equipment, []),
    is_global:         !!r.is_global,
  };
}

function _programFromRow(r) {
  return r ? { ...r, deleted_at: undefined, sync_state: undefined } : null;
}

// Sanitise the multi-week progression fields on write — mirror of the server's
// clampDuration / advanceMode / onComplete in server/routes/programs.js so a
// program created offline resolves weeks identically once synced.
function _clampDuration(v) {
  const n = parseInt(v);
  return Number.isFinite(n) ? Math.min(52, Math.max(1, n)) : 1;
}
const _advanceMode = v => (v === 'calendar' ? 'calendar' : 'sessions');
const _onComplete  = v => (v === 'repeat' ? 'repeat' : 'hold');

// Completed program-attributed sessions for a program (single-user: user_id=1).
// Mirrors server/routes/programs.js sessionsInProgram.
async function _sessionsInProgram(programId, assignedAt) {
  const sinceFilter = assignedAt ? 'AND date >= date(?)' : '';
  const args = [ME, programId];
  if (assignedAt) args.push(assignedAt);
  const row = (await dbQuery(
    `SELECT COUNT(*) AS c FROM workout_log wl
       WHERE wl.user_id = ? AND wl.completed = 1
         AND wl.template_id IN (SELECT id FROM workout_templates WHERE program_id = ?)
         ${sinceFilter}`,
    args
  ))[0];
  return row?.c || 0;
}

// Resolve current_week for an active program row + its assignment, so the
// Diary's week bar and week-aware prefill work offline. Returns { current_week,
// sessions_in_program } or null when the program isn't progressed/active.
async function _resolveCurrentWeek(program, assignment) {
  if (!program || (program.duration_weeks || 1) <= 1) return null;
  const tplCount = (await dbQuery(
    `SELECT COUNT(*) AS c FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL`,
    [program.id]
  ))[0]?.c || 0;
  const sessions = await _sessionsInProgram(program.id, assignment?.assigned_at);
  return {
    sessions_in_program: sessions,
    current_week: currentPlanWeek(program, assignment, {
      sessionsInProgram: sessions,
      sessionsPerWeek: tplCount,
    }),
  };
}

function _templateFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    exercises: _parseJson(r.exercises, []),
    deleted_at: undefined,
    sync_state: undefined,
  };
}

function _workoutFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    exercises: _parseJson(r.exercises, []),
    deleted_at: undefined,
    sync_state: undefined,
  };
}

function _bodyStatsFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    stats: _parseJson(r.stats, {}),
    deleted_at: undefined,
    sync_state: undefined,
  };
}

class _Unsupported extends Error {
  constructor(msg) { super(msg); this.status = 501; }
}

// ── handlers grouped by resource ─────────────────────────────────────────

const Auth = {
  async me() {
    const rows = await dbQuery(`SELECT id, username, full_name, nickname, email, birthday, gender, avatar_url, role FROM users WHERE id = ?`, [ME]);
    return rows[0] || { id: ME, username: 'me', role: 'admin' };
  },
  status() {
    return { setupComplete: true, userManagementActive: false, mode: 'standalone' };
  },
  users() {
    return Auth.me().then(u => [u]);
  },
  noopOk() { return { ok: true }; },
  loginOffline() {
    return { ok: true, user: { id: ME, username: 'me', role: 'admin' } };
  },
  async updateProfile(body) {
    const fields = ['full_name', 'nickname', 'email', 'birthday', 'gender', 'avatar_url'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(body[f]); }
    }
    if (sets.length) {
      sets.push(`updated_at = ?`); vals.push(_now());
      vals.push(ME);
      await dbRun(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
    return Auth.me();
  },
};

const AppConfig = {
  async get() {
    const rows = await dbQuery(`SELECT key, value FROM app_config`, []);
    const out = { mode: 'standalone' };
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
  envLocks() { return {}; },
  async set(body) {
    for (const [k, v] of Object.entries(body || {})) {
      await dbRun(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [k, _stringify(v), _now()]
      );
    }
    return AppConfig.get();
  },
};

const Settings = {
  async get() {
    const rows = await dbQuery(`SELECT key, value FROM user_settings WHERE user_id = ?`, [ME]);
    const out = {};
    for (const r of rows) out[r.key] = _parseJson(r.value, r.value);
    return out;
  },
  async put(body) {
    if (!body) return { ok: true };
    const writeOne = async (k, raw) => {
      const v = _stringify(raw);
      await dbRun(
        `INSERT INTO user_settings (user_id, key, value, updated_at, sync_state)
         VALUES (?, ?, ?, ?, 'pending')
         ON CONFLICT(user_id, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_state = 'pending'`,
        [ME, k, v, _now()]
      );
    };
    // scheduleSave (the only client-side caller in the running app) sends
    // a single-setting shape: { key, value }. Mirror what the server's
    // PUT /api/settings does — store one row for that key. Iterating
    // Object.entries() on this shape would write garbage rows like
    // (key='key', value='appearance') + (key='value', value='system'),
    // which is exactly the corruption seen on Android before this guard.
    if (typeof body.key === 'string' && 'value' in body) {
      await writeOne(body.key, body.value);
      return { ok: true };
    }
    // Bulk shape: { settingA: valA, settingB: valB } — used by the
    // wizard's finish() flow + any future bulkSet caller.
    for (const [k, raw] of Object.entries(body)) await writeOne(k, raw);
    return { ok: true };
  },
  async clearData() {
    await dbRun(`DELETE FROM workout_log WHERE user_id = ?`, [ME]);
    await dbRun(`DELETE FROM body_stats_log WHERE user_id = ?`, [ME]);
    await dbRun(`DELETE FROM ai_chat_history WHERE user_id = ?`, [ME]);
    return { ok: true };
  },
};

const Exercises = {
  async list(params = {}) {
    const where = [`deleted_at IS NULL`];
    const args = [];
    if (params.category) { where.push(`LOWER(category) = LOWER(?)`); args.push(params.category); }
    if (params.search)   { where.push(`LOWER(name) LIKE LOWER(?)`); args.push(`%${params.search}%`); }
    const rows = await dbQuery(
      `SELECT * FROM exercises WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE LIMIT 5000`,
      args
    );
    return rows.map(_exerciseFromRow);
  },
  async get(id) {
    // Intentionally does NOT filter deleted_at (mirrors server behavior,
    // #49). A tap on a Records row for an exercise the user has cleared
    // from their library should still resolve to that exercise's detail
    // page rather than a bare 404.
    const rows = await dbQuery(`SELECT * FROM exercises WHERE id = ?`, [id]);
    return _exerciseFromRow(rows[0]);
  },
  async create(body) {
    const r = await dbRun(
      `INSERT INTO exercises
        (name, category, primary_muscles, secondary_muscles, equipment, instructions, tips,
         img_url, gif_url, video_url, load_type, source, is_global, created_by, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        body.name,
        body.category || null,
        _stringify(body.primary_muscles || []),
        _stringify(body.secondary_muscles || []),
        _stringify(body.equipment || []),
        body.instructions || null,
        body.tips || null,
        body.img_url || null,
        body.gif_url || null,
        body.video_url || null,
        _cleanLoadType(body.load_type),
        body.source || 'custom',
        body.is_global ? 1 : 0,
        ME,
        _now(),
        _now(),
      ]
    );
    return Exercises.get(r.lastId);
  },
  async update(id, body) {
    const sets = [];
    const args = [];
    const cols = ['name', 'category', 'instructions', 'tips', 'img_url', 'gif_url', 'video_url'];
    for (const c of cols) {
      if (body[c] !== undefined) { sets.push(`${c} = ?`); args.push(body[c]); }
    }
    if (body.primary_muscles !== undefined)   { sets.push(`primary_muscles = ?`);   args.push(_stringify(body.primary_muscles)); }
    if (body.secondary_muscles !== undefined) { sets.push(`secondary_muscles = ?`); args.push(_stringify(body.secondary_muscles)); }
    if (body.equipment !== undefined)         { sets.push(`equipment = ?`);         args.push(_stringify(body.equipment)); }
    // load_type: undefined means "leave alone"; explicit null clears back
    // to unset; anything else gets whitelisted through _cleanLoadType.
    if (body.load_type !== undefined) {
      sets.push(`load_type = ?`);
      args.push(body.load_type === null ? null : _cleanLoadType(body.load_type));
    }
    sets.push(`updated_at = ?`); args.push(_now());
    sets.push(`sync_state = 'pending'`);
    args.push(id);
    await dbRun(`UPDATE exercises SET ${sets.join(', ')} WHERE id = ?`, args);
    return Exercises.get(id);
  },
  async del(id) {
    await dbRun(`UPDATE exercises SET deleted_at = ?, sync_state = 'pending' WHERE id = ?`, [_now(), id]);
    return { ok: true };
  },
  async deleteAllCustom() {
    await dbRun(`UPDATE exercises SET deleted_at = ?, sync_state = 'pending' WHERE created_by = ? AND is_global = 0`, [_now(), ME]);
    return { ok: true };
  },
  async sourcesList() {
    // Same 4 sources the server exposes, with per-source counts from the
    // local SQLite mirror. Enabled state is a user-scoped toggle stored
    // under user_settings (key `catalog_disabled_<id>`).
    const counts = await dbQuery(
      `SELECT source, COUNT(*) as c FROM exercises
       WHERE deleted_at IS NULL AND source IN ('wger','free-db','exercisedb','exercisedb-oss')
       GROUP BY source`
    );
    const countMap = Object.fromEntries(counts.map(r => [r.source, r.c]));
    const disabledRows = await dbQuery(
      `SELECT key, value FROM user_settings WHERE user_id = ? AND key LIKE 'catalog_disabled_%'`,
      [ME]
    );
    const isDisabled = (id) => {
      const row = disabledRows.find(r => r.key === `catalog_disabled_${id}`);
      return row && row.value && row.value !== 'false';
    };
    return SOURCES_META.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      requiresKey: s.requiresKey,
      count: countMap[s.id] || 0,
      enabled: countMap[s.id] > 0 ? !isDisabled(s.id) : true,
    })).sort((a, b) => a.name.localeCompare(b.name));
  },
  async sourcesImport(sourceId, apiKey) {
    if (!sourceId) throw new Error('source required');
    const meta = SOURCES_META.find(s => s.id === sourceId);
    if (!meta) throw new Error(`Unknown source: ${sourceId}`);
    if (meta.requiresKey && !apiKey) throw new Error(`${meta.name} requires an API key`);

    // Live external_ids only — feeds the oss cursor-loop detector and
    // the no-op skip below. Soft-deleted rows are excluded here so they
    // fall into the resurrect-in-place branch further down (#49).
    const existing = await dbQuery(
      `SELECT external_id FROM exercises
       WHERE source = ? AND external_id IS NOT NULL AND deleted_at IS NULL`,
      [sourceId]
    );
    const existingIds = new Set(existing.map(r => String(r.external_id)));

    let rows;
    if (sourceId === 'wger') {
      const { fetchWgerRows } = await import('./exercise-sources/wger.js');
      rows = await fetchWgerRows({ fetchFn: nativeFetch });
    } else if (sourceId === 'free-db') {
      const { fetchFreeDbRows } = await import('./exercise-sources/free-db.js');
      rows = await fetchFreeDbRows({ fetchFn: nativeFetch });
    } else if (sourceId === 'exercisedb-oss') {
      const { fetchExerciseDbOssRows } = await import('./exercise-sources/exercisedb-oss.js');
      rows = await fetchExerciseDbOssRows({ fetchFn: nativeFetch, existingIds });
    } else {
      throw new _Unsupported(`${meta.name} imports aren't available offline yet.`);
    }

    // Insert loop. Three branches per row:
    //   - live row already present with this (source, external_id | name) → skip
    //   - soft-deleted row present → resurrect in place (preserves id, so
    //     past workout_log JSON blobs keep resolving — #49)
    //   - otherwise → INSERT a fresh row
    let count = 0, resurrected = 0;
    for (const r of rows) {
      const existsRow = r.external_id
        ? await dbQuery(`SELECT id, deleted_at FROM exercises WHERE source = ? AND external_id = ? LIMIT 1`, [sourceId, r.external_id])
        : await dbQuery(`SELECT id, deleted_at FROM exercises WHERE source = ? AND name = ? LIMIT 1`, [sourceId, r.name]);
      if (existsRow.length > 0) {
        if (existsRow[0].deleted_at) {
          await dbRun(
            `UPDATE exercises SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
            [_now(), existsRow[0].id]
          );
          resurrected++;
        }
        continue;
      }
      await dbRun(
        `INSERT INTO exercises
         (name, category, primary_muscles, secondary_muscles, equipment,
          instructions, img_url, gif_url, video_url, external_id, source,
          is_global, created_at, updated_at, sync_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'synced')`,
        [
          r.name, r.category,
          _stringify(r.primary_muscles || []),
          _stringify(r.secondary_muscles || []),
          _stringify(r.equipment || []),
          r.instructions || null,
          r.img_url || null, r.gif_url || null, r.video_url || null,
          r.external_id != null ? String(r.external_id) : null,
          sourceId,
          _now(), _now(),
        ]
      );
      count++;
    }
    count += resurrected;
    return { ok: true, count };
  },
  async sourcesToggle(sourceId, enabled) {
    if (!sourceId) throw new Error('source required');
    const key = `catalog_disabled_${sourceId}`;
    if (enabled) {
      await dbRun(`DELETE FROM user_settings WHERE user_id = ? AND key = ?`, [ME, key]);
    } else {
      await dbRun(
        `INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)`,
        [ME, key, 'true']
      );
    }
    return { ok: true };
  },
  async sourcesClear(sourceId) {
    if (!sourceId) throw new Error('source required');
    // Soft-delete so past workout_log references keep resolving; the
    // next matching re-import resurrects the row in place instead of
    // minting a new id (#49). Reads elsewhere filter by deleted_at.
    const r = await dbRun(
      `UPDATE exercises
         SET deleted_at = ?, updated_at = ?
       WHERE source = ? AND created_by IS NULL AND deleted_at IS NULL`,
      [_now(), _now(), sourceId]
    );
    return { ok: true, cleared: r.changes || 0 };
  },
  unsupported() { throw new _Unsupported('That catalog action requires a server connection.'); },
};

// Mirrors server/exercise-sources/index.js SOURCES (id + descriptive
// metadata only). Kept here rather than imported from a shared file so
// standalone can render the Catalog UI without pulling a server module.
const SOURCES_META = [
  {
    id: 'wger',
    name: 'wger',
    description: 'Free open-source exercise database (~600 exercises, sparse images, no GIFs)',
    requiresKey: false,
  },
  {
    id: 'free-db',
    name: 'Free Exercise DB',
    description: 'Public-domain catalog (~870 exercises) with start/end position images for every entry',
    requiresKey: false,
  },
  {
    id: 'exercisedb',
    name: 'ExerciseDB (RapidAPI)',
    description: '~1,300 exercises with animated GIFs. Requires a RapidAPI key (paid). Note: not available in standalone yet — connect to a server to import.',
    requiresKey: true,
  },
  {
    id: 'exercisedb-oss',
    name: 'ExerciseDB (open-source)',
    description: '~1,500 exercises with animated GIFs. AGPL-3.0. Free, no key — uses oss.exercisedb.dev (community-hosted, no SLA).',
    requiresKey: false,
  },
];

// Isomorphic fetch adapter for the shared exercise-source modules.
// Browser fetch inside the WebView hits CORS on wger/free-db/oss, so on
// native we route via CapacitorHttp which bypasses CORS entirely. Response
// is normalised to look like a Fetch Response so the shared modules see
// the same shape as node.
async function nativeFetch(url, init = {}) {
  const { CapacitorHttp } = await import('@capacitor/core');
  const method = (init.method || 'GET').toUpperCase();
  const opts = { url, headers: init.headers || {} };
  if (init.body != null) opts.data = init.body;
  const fn = method === 'GET' ? CapacitorHttp.get
          : method === 'POST' ? CapacitorHttp.post
          : method === 'PUT' ? CapacitorHttp.put
          : method === 'DELETE' ? CapacitorHttp.delete
          : CapacitorHttp.request;
  const res = await fn.call(CapacitorHttp, opts);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: {
      get: (name) => res.headers?.[name] ?? res.headers?.[name?.toLowerCase?.()],
    },
    json: async () => typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
    text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
  };
}

const Programs = {
  async list() {
    // Match server shape: each row gets is_active / is_assigned /
    // assigned_by_name / template_count alongside the core program fields.
    // Programs.svelte renders `p.is_active` directly; the previous
    // `active` key showed as undefined → the active badge never lit up.
    const rows = await dbQuery(
      `SELECT p.*, pa.active AS _active
         FROM programs p
         LEFT JOIN program_assignments pa ON pa.program_id = p.id AND pa.assigned_to = ?
        WHERE p.deleted_at IS NULL
        ORDER BY p.created_at DESC`,
      [ME]
    );
    const out = [];
    for (const r of rows) {
      const tplCount = (await dbQuery(
        `SELECT COUNT(*) AS c FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL`,
        [r.id]
      ))[0]?.c || 0;
      const prog = _programFromRow(r);
      const entry = {
        ...prog,
        is_active: r._active ? 1 : 0,
        is_assigned: 0,
        assigned_by_name: null,
        template_count: tplCount,
      };
      // Resolve the current plan week for the active progressed program so the
      // list card can show "Week N" (matches the server's GET /api/programs).
      if (entry.is_active) {
        const assignment = (await dbQuery(
          `SELECT assigned_at, start_date, week_cursor, week_cursor_session_base, week_cursor_pinned_at
             FROM program_assignments WHERE program_id = ? AND assigned_to = ? AND active = 1`,
          [r.id, ME]
        ))[0];
        const wk = await _resolveCurrentWeek(prog, assignment);
        if (wk) Object.assign(entry, wk);
      }
      out.push(entry);
    }
    return out;
  },
  async get(id) {
    // Match server shape: single program with `is_active` and `templates`.
    const rows = await dbQuery(`SELECT * FROM programs WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!rows[0]) return null;
    const tpls = await dbQuery(
      `SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL ORDER BY order_index, id`,
      [id]
    );
    const assignment = (await dbQuery(
      `SELECT active, assigned_at, start_date, week_cursor, week_cursor_session_base, week_cursor_pinned_at
         FROM program_assignments WHERE program_id = ? AND assigned_to = ?`,
      [id, ME]
    ))[0];
    const isActive = assignment?.active === 1;
    const prog = _programFromRow(rows[0]);
    const out = { ...prog, is_active: isActive, templates: tpls.map(_templateFromRow) };
    if (isActive) {
      const wk = await _resolveCurrentWeek(prog, assignment);
      if (wk) Object.assign(out, wk);
    }
    return out;
  },
  async create(body) {
    const r = await dbRun(
      `INSERT INTO programs (name, description, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        body.name, body.description || null, body.goal || 'general', ME, body.visibility || 'private',
        _clampDuration(body.duration_weeks), _advanceMode(body.advance_mode), _onComplete(body.on_complete),
        _now(), _now(),
      ]
    );
    return Programs.get(r.lastId);
  },
  async update(id, body) {
    const sets = [];
    const args = [];
    for (const c of ['name', 'description', 'goal', 'visibility']) {
      if (body[c] !== undefined) { sets.push(`${c} = ?`); args.push(body[c]); }
    }
    // Multi-week progression fields — sanitised the same way the server does.
    if (body.duration_weeks !== undefined) { sets.push(`duration_weeks = ?`); args.push(_clampDuration(body.duration_weeks)); }
    if (body.advance_mode   !== undefined) { sets.push(`advance_mode = ?`);   args.push(_advanceMode(body.advance_mode)); }
    if (body.on_complete    !== undefined) { sets.push(`on_complete = ?`);    args.push(_onComplete(body.on_complete)); }
    sets.push(`updated_at = ?`); args.push(_now());
    sets.push(`sync_state = 'pending'`);
    args.push(id);
    await dbRun(`UPDATE programs SET ${sets.join(', ')} WHERE id = ?`, args);
    return Programs.get(id);
  },
  async del(id) {
    await dbRun(`UPDATE programs SET deleted_at = ?, sync_state = 'pending' WHERE id = ?`, [_now(), id]);
    return { ok: true };
  },
  async activate(id) {
    await dbRun(`UPDATE program_assignments SET active = 0 WHERE assigned_to = ?`, [ME]);
    await dbRun(
      `INSERT INTO program_assignments (program_id, assigned_to, active, assigned_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(program_id, assigned_to)
       DO UPDATE SET active = 1, assigned_at = excluded.assigned_at`,
      [id, ME, _now()]
    );
    return { ok: true };
  },
  async deactivate() {
    await dbRun(`UPDATE program_assignments SET active = 0 WHERE assigned_to = ?`, [ME]);
    return { ok: true };
  },
  // Manually pin the current plan week so the athlete can repeat/regress
  // (issue #13). Mirrors the server's POST /:id/week-cursor: clamp to
  // [1, duration], capture the session base + pin timestamp so auto-advance
  // resumes relative to the pin. { week: null } clears the pin.
  async setWeekCursor(id, body) {
    const prog = (await dbQuery(`SELECT * FROM programs WHERE id = ? AND deleted_at IS NULL`, [id]))[0];
    if (!prog) throw new _Unsupported('Program not found');
    let week = body?.week;
    if (week != null) {
      week = parseInt(week);
      if (!Number.isFinite(week)) throw new _Unsupported('week must be a number or null');
      week = Math.min(Math.max(1, prog.duration_weeks || 1), Math.max(1, week));
    }
    const assigned = (await dbQuery(
      `SELECT assigned_at FROM program_assignments WHERE program_id = ? AND assigned_to = ? AND active = 1`,
      [id, ME]
    ))[0];
    if (!assigned) throw new _Unsupported('Program is not active');
    const base = week != null ? await _sessionsInProgram(id, assigned.assigned_at) : null;
    const pinnedAt = week != null ? _now() : null;
    await dbRun(
      `UPDATE program_assignments
          SET week_cursor = ?, week_cursor_session_base = ?, week_cursor_pinned_at = ?, updated_at = ?
        WHERE program_id = ? AND assigned_to = ?`,
      [week ?? null, base, pinnedAt, _now(), id, ME]
    );
    return { ok: true, week: week ?? null };
  },
  async reorder(id, body) {
    const order = Array.isArray(body?.order) ? body.order : [];
    for (let i = 0; i < order.length; i++) {
      await dbRun(
        `UPDATE workout_templates SET order_index = ?, updated_at = ?, sync_state = 'pending' WHERE id = ? AND program_id = ?`,
        [i, _now(), order[i], id]
      );
    }
    return { ok: true };
  },
};

const Templates = {
  async list(programId) {
    const rows = await dbQuery(
      `SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL ORDER BY order_index, id`,
      [programId]
    );
    return rows.map(_templateFromRow);
  },
  async get(id) {
    // Join the parent program's duration_weeks so the WorkoutEditor renders the
    // right number of week tabs (matches the server's GET /api/templates/:id).
    const rows = await dbQuery(
      `SELECT wt.*, p.duration_weeks
         FROM workout_templates wt
         JOIN programs p ON p.id = wt.program_id
        WHERE wt.id = ? AND wt.deleted_at IS NULL`,
      [id]
    );
    return _templateFromRow(rows[0]);
  },
  async create(body) {
    const max = (await dbQuery(
      `SELECT COALESCE(MAX(order_index), -1) AS m FROM workout_templates WHERE program_id = ?`, [body.program_id]
    ))[0]?.m ?? -1;
    const r = await dbRun(
      `INSERT INTO workout_templates (program_id, name, day_label, order_index, exercises, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        body.program_id, body.name, body.day_label || null,
        body.order_index != null ? body.order_index : max + 1,
        _stringify(body.exercises || []), _now(), _now(),
      ]
    );
    return Templates.get(r.lastId);
  },
  async update(id, body) {
    const sets = [];
    const args = [];
    for (const c of ['name', 'day_label']) {
      if (body[c] !== undefined) { sets.push(`${c} = ?`); args.push(body[c]); }
    }
    if (body.order_index !== undefined) { sets.push(`order_index = ?`); args.push(body.order_index); }
    if (body.exercises !== undefined)   { sets.push(`exercises = ?`); args.push(_stringify(body.exercises)); }
    sets.push(`updated_at = ?`); args.push(_now());
    sets.push(`sync_state = 'pending'`);
    args.push(id);
    await dbRun(`UPDATE workout_templates SET ${sets.join(', ')} WHERE id = ?`, args);
    return Templates.get(id);
  },
  async del(id) {
    await dbRun(`UPDATE workout_templates SET deleted_at = ?, sync_state = 'pending' WHERE id = ?`, [_now(), id]);
    return { ok: true };
  },
};

const Workout = {
  // Default-session lookup (issue #76): a date can now have more than one
  // row. Picks the lowest session_seq (0 = the original/only session),
  // falling back to the lowest id if session 0 was ever deleted — matches
  // the server's GET /:date exactly, so a caller that never asks about
  // sessions keeps hitting the one row that exists for anyone who's never
  // created a second session.
  async _defaultRow(date) {
    const rows = await dbQuery(
      `SELECT * FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL
        ORDER BY session_seq ASC, id ASC LIMIT 1`,
      [ME, date]
    );
    return rows[0] || null;
  },
  // Resolve which row a request targets: explicit id wins (must still
  // belong to this user + date), otherwise the default session.
  async _resolve(date, explicitId) {
    if (explicitId != null) {
      const rows = await dbQuery(
        `SELECT * FROM workout_log WHERE id = ? AND user_id = ? AND date = ?`,
        [explicitId, ME, date]
      );
      return rows[0] || null;
    }
    return Workout._defaultRow(date);
  },
  async _enrich(row) {
    const w = _workoutFromRow(row);
    if (!w) return null;
    // Surface the program's plan length alongside the stamped program_week so
    // the diary can render "Week N of M" (matches the server's GET /:date).
    if (w.program_id) {
      w.program_duration_weeks = (await dbQuery(
        `SELECT duration_weeks FROM programs WHERE id = ?`,
        [w.program_id]
      ))[0]?.duration_weeks ?? null;
    }
    return w;
  },
  // explicitId mirrors the server's GET /:date?id= — used by
  // stores/workout.js's merge-safety refetch, which must re-fetch the
  // SAME session it's about to save over, not silently fall back to the
  // default when the client is editing a non-default one (issue #76).
  async byDate(date, explicitId = null) {
    const row = explicitId != null ? await Workout._resolve(date, explicitId) : await Workout._defaultRow(date);
    return Workout._enrich(row);
  },
  // GET /api/workout/:date/sessions (issue #76) — every session logged
  // that date, each enriched like byDate. Excludes soft-deleted rows —
  // a deleted session isn't something a session-switcher should offer.
  async sessions(date) {
    const rows = await dbQuery(
      `SELECT * FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL
        ORDER BY session_seq ASC, id ASC`,
      [ME, date]
    );
    const out = [];
    for (const r of rows) out.push(await Workout._enrich(r));
    return out;
  },
  async upsert(date, body) {
    const exercises = body.exercises || [];

    // Resolve the target row (issue #76): new_session:true always creates
    // a fresh row, bypassing the existing-row lookup entirely, so "start
    // a new session" can never accidentally land on one that already
    // exists. Otherwise an explicit id targets that specific session;
    // absent both, the default-session lookup reproduces pre-#76
    // single-row behavior exactly.
    const existing = body.new_session ? null : await Workout._resolve(date, body.id ?? null);

    let targetId;
    if (existing) {
      targetId = existing.id;
      await dbRun(
        `UPDATE workout_log
            SET template_id = ?, program_id = ?, name = ?, exercises = ?,
                notes = ?, duration_min = ?, completed = ?, program_week = ?, updated_at = ?, sync_state = 'pending'
          WHERE id = ?`,
        [
          body.template_id ?? existing.template_id ?? null,
          body.program_id  ?? existing.program_id  ?? null,
          body.name ?? existing.name ?? null,
          _stringify(exercises),
          body.notes ?? existing.notes ?? null,
          body.duration_min ?? existing.duration_min ?? null,
          body.completed ? 1 : 0,
          body.program_week ?? existing.program_week ?? null,
          _now(), targetId,
        ]
      );
    } else {
      // A brand-new row: either the very first session for this date
      // (default path, session_seq=0 — identical to pre-#76 behavior) or
      // an explicit additional session (new_session:true, next
      // session_seq for this date).
      let nextSeq = 0;
      if (body.new_session) {
        const r = (await dbQuery(
          `SELECT COALESCE(MAX(session_seq), -1) + 1 AS n FROM workout_log WHERE user_id = ? AND date = ?`,
          [ME, date]
        ))[0];
        nextSeq = r?.n ?? 0;
      }
      const ins = await dbRun(
        `INSERT INTO workout_log
          (user_id, date, template_id, program_id, name, exercises, notes, duration_min, completed, program_week,
           session_seq, created_at, updated_at, sync_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          ME, date,
          body.template_id ?? null,
          body.program_id  ?? null,
          body.name ?? null,
          _stringify(exercises),
          body.notes ?? null,
          body.duration_min ?? null,
          body.completed ? 1 : 0,
          body.program_week ?? null,
          nextSeq,
          _now(), _now(),
        ]
      );
      targetId = ins.lastId;
    }

    // Option C (2026-08-11): persist any explicit per-entry deletions
    // as pending tombstones in the local mirror, scoped to the resolved
    // session's workout_id (issue #76) so a deletion in one session
    // doesn't affect another same-date session's tombstone lookups. Sync
    // push includes these so the server-side merge treats them as
    // deleted rather than preserving-by-default. Without this, a delete
    // performed while offline would silently fail to propagate on
    // reconnect.
    const dr = body.deleted_uuids;
    if (dr) {
      const del = dr.exercises || (Array.isArray(dr) ? dr : []);
      const setsByEx = (dr.sets && typeof dr.sets === 'object' && !Array.isArray(dr.sets)) ? dr.sets : {};
      const ts = _now();
      for (const uuid of del) {
        if (typeof uuid === 'string' && uuid) {
          await dbRun(
            `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at, sync_state)
             VALUES (?, ?, ?, 'exercise', '', ?, ?, 'pending')`,
            [ME, date, targetId, uuid, ts]
          );
        }
      }
      for (const [exUuid, uuids] of Object.entries(setsByEx)) {
        for (const uuid of (uuids || [])) {
          if (typeof uuid === 'string' && uuid) {
            await dbRun(
              `INSERT OR IGNORE INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at, sync_state)
               VALUES (?, ?, ?, 'set', ?, ?, ?, 'pending')`,
              [ME, date, targetId, exUuid, uuid, ts]
            );
          }
        }
      }
    }

    return Workout._enrich(await (async () => {
      const rows = await dbQuery(`SELECT * FROM workout_log WHERE id = ?`, [targetId]);
      return rows[0] || null;
    })());
  },
  // DELETE /api/workout/:date — explicit day-level deletion. Optional
  // explicitId targets a specific session (issue #76); absent, deletes
  // the same default session byDate would return. Previously unsupported
  // in standalone mode at all (fell through to the generic 501) — added
  // now since a session-aware UI needs to be able to remove one session
  // without a server.
  async del(date, explicitId) {
    const existing = await Workout._resolve(date, explicitId ?? null);
    if (!existing) return { ok: true, deleted: false };
    await dbRun(`DELETE FROM workout_log WHERE id = ?`, [existing.id]);
    return { ok: true, deleted: true };
  },
  async recent(limit = 30) {
    const rows = await dbQuery(
      `SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL
         AND json_array_length(COALESCE(exercises, '[]')) > 0
       ORDER BY date DESC LIMIT ?`,
      [ME, Number(limit) || 30]
    );
    return rows.map(_workoutFromRow);
  },
  async historyFor(exerciseId) {
    const rows = await dbQuery(
      `SELECT date, exercises FROM workout_log
        WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC`,
      [ME]
    );
    const out = [];
    for (const r of rows) {
      const exs = _parseJson(r.exercises, []);
      const hit = exs.find(e => Number(e.exercise_id) === Number(exerciseId));
      if (hit) out.push({ date: r.date, ...hit });
      if (out.length >= 50) break;
    }
    return out;
  },
};

const BodyStats = {
  async get(date) {
    const rows = await dbQuery(`SELECT * FROM body_stats_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL`, [ME, date]);
    return _bodyStatsFromRow(rows[0]) || null;
  },
  async put(date, body) {
    const stats = body?.stats ?? body ?? {};
    const existing = await BodyStats.get(date);
    if (existing) {
      await dbRun(
        `UPDATE body_stats_log SET stats = ?, updated_at = ?, sync_state = 'pending' WHERE user_id = ? AND date = ?`,
        [_stringify({ ...existing.stats, ...stats }), _now(), ME, date]
      );
    } else {
      await dbRun(
        `INSERT INTO body_stats_log (user_id, date, stats, updated_at, sync_state)
         VALUES (?, ?, ?, ?, 'pending')`,
        [ME, date, _stringify(stats), _now()]
      );
    }
    return BodyStats.get(date);
  },
  async range(from, to) {
    const rows = await dbQuery(
      `SELECT date, stats FROM body_stats_log
        WHERE user_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ?
        ORDER BY date ASC`,
      [ME, from || '1970-01-01', to || '2999-12-31']
    );
    return rows.map(_bodyStatsFromRow);
  },
};

// Standalone-mode Cardio session logging. Mirrors server/routes/cardio.js
// so the Diary CardioCard + Statistics Cardio metric work offline.
const Cardio = {
  async list(start, end) {
    const rows = (start && end)
      ? await dbQuery(`SELECT * FROM cardio_log WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`, [ME, start, end])
      : await dbQuery(`SELECT * FROM cardio_log WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 500`, [ME]);
    return rows;
  },
  async byDate(date) {
    return dbQuery(`SELECT * FROM cardio_log WHERE user_id = ? AND date = ? ORDER BY id ASC`, [ME, date]);
  },
  async templates() {
    return dbQuery(`SELECT * FROM cardio_log WHERE user_id = ? AND is_template = 1 ORDER BY updated_at DESC, id DESC`, [ME]);
  },
  async create(body) {
    if (!body?.date) throw new Error('date required');
    const activity = String(body.activity || '').trim();
    if (!activity) throw new Error('activity required');
    const dm = Math.floor(Number(body.duration_min));
    if (!Number.isFinite(dm) || dm <= 0) throw new Error('duration_min must be a positive integer');
    const dist = body.distance == null || body.distance === '' ? null : Number(body.distance);
    const hr = body.avg_hr == null || body.avg_hr === '' ? null : Math.floor(Number(body.avg_hr));
    const unit = (body.distance_unit === 'mi' || body.distance_unit === 'km') ? body.distance_unit : 'km';
    const notes = body.notes ? String(body.notes).trim() : null;
    const isTpl = body.is_template ? 1 : 0;
    const r = await dbRun(
      `INSERT INTO cardio_log (user_id, date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ME, body.date, activity, dm, Number.isFinite(dist) ? dist : null, unit, Number.isFinite(hr) ? hr : null, notes, isTpl, _now(), _now()]
    );
    const rows = await dbQuery(`SELECT * FROM cardio_log WHERE id = ?`, [r.lastId]);
    return rows[0];
  },
  async update(id, body) {
    const existing = (await dbQuery(`SELECT * FROM cardio_log WHERE id = ? AND user_id = ?`, [id, ME]))[0];
    if (!existing) throw new Error('not found');
    const activity = body.activity != null ? String(body.activity).trim() : existing.activity;
    if (!activity) throw new Error('activity required');
    const dm = body.duration_min != null ? Math.floor(Number(body.duration_min)) : existing.duration_min;
    if (!Number.isFinite(dm) || dm <= 0) throw new Error('duration_min must be a positive integer');
    const dist = body.distance === '' ? null : (body.distance != null ? Number(body.distance) : existing.distance);
    const hr = body.avg_hr === '' ? null : (body.avg_hr != null ? Math.floor(Number(body.avg_hr)) : existing.avg_hr);
    const unit = (body.distance_unit === 'mi' || body.distance_unit === 'km') ? body.distance_unit : existing.distance_unit;
    const notes = body.notes === '' ? null : (body.notes != null ? String(body.notes).trim() : existing.notes);
    const isTpl = body.is_template === undefined ? (existing.is_template || 0) : (body.is_template ? 1 : 0);
    await dbRun(
      `UPDATE cardio_log SET date = ?, activity = ?, duration_min = ?, distance = ?, distance_unit = ?, avg_hr = ?, notes = ?, is_template = ?, updated_at = ?
       WHERE id = ?`,
      [body.date != null ? body.date : existing.date, activity, dm, dist, unit, hr, notes, isTpl, _now(), id]
    );
    const rows = await dbQuery(`SELECT * FROM cardio_log WHERE id = ?`, [id]);
    return rows[0];
  },
  async del(id) {
    await dbRun(`DELETE FROM cardio_log WHERE id = ? AND user_id = ?`, [id, ME]);
    return { ok: true };
  },
  async weekly(start, end) {
    if (!start || !end) throw new Error('start and end required');
    const rows = await dbQuery(
      `SELECT date, duration_min FROM cardio_log WHERE user_id = ? AND date BETWEEN ? AND ?`,
      [ME, start, end]
    );
    const byWeek = {};
    for (const row of rows) {
      const d = new Date(row.date);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
      byWeek[weekStart] = (byWeek[weekStart] || 0) + row.duration_min;
    }
    return Object.entries(byWeek).map(([week, minutes]) => ({ week, minutes })).sort((a, b) => a.week.localeCompare(b.week));
  },
};

const Stats = {
  async _allWorkouts() {
    const rows = await dbQuery(
      `SELECT * FROM workout_log WHERE user_id = ? AND deleted_at IS NULL`,
      [ME]
    );
    return rows.map(_workoutFromRow);
  },
  _completedSets(w) {
    const exs = w.exercises || [];
    return exs.flatMap(ex => (ex.sets || []).filter(s => s?.completed && !s?.warmup).map(s => ({ ...s, exercise_id: ex.exercise_id, exercise_name: ex.exercise_name })));
  },
  _hasCompletedSet(w) {
    return Stats._completedSets(w).length > 0;
  },
  async earliestWorkoutDate() {
    const rows = await dbQuery(`SELECT MIN(date) AS d FROM workout_log WHERE user_id = ? AND deleted_at IS NULL`, [ME]);
    return { date: rows[0]?.d || null };
  },
  async streaks() {
    const all = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet).sort((a, b) => a.date.localeCompare(b.date));
    const dates = new Set(all.map(w => w.date));
    let longestStreak = 0, currentStreak = 0;
    let cur = 0;
    let prev = null;
    for (const d of [...dates].sort()) {
      if (prev) {
        const gap = (new Date(d) - new Date(prev)) / 86400000;
        cur = gap === 1 ? cur + 1 : 1;
      } else cur = 1;
      longestStreak = Math.max(longestStreak, cur);
      prev = d;
    }
    // Current streak: walk back from today
    const today = new Date().toISOString().slice(0, 10);
    if (dates.has(today)) {
      currentStreak = 1;
      let day = new Date(today);
      day.setDate(day.getDate() - 1);
      while (dates.has(day.toISOString().slice(0, 10))) {
        currentStreak++;
        day.setDate(day.getDate() - 1);
      }
    }
    // Match the server's shape so Statistics.svelte renders identical
    // values whether reading from the cache (native) or from the server
    // (PWA). Previously returned { current, longest } which read as
    // undefined on the Statistics overview cards.
    return { currentStreak, longestStreak, totalWorkouts: dates.size };
  },
  async volume(from, to) {
    // Server returns [{ week, volume }] bucketed by ISO week start (Monday).
    // Match it exactly so WeeklyVolumeChart's v.week label rendering works
    // when the cache is being read instead of the server.
    const rows = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet)
      .filter(w => (!from || w.date >= from) && (!to || w.date <= to));
    const byWeek = {};
    for (const w of rows) {
      const d = new Date(w.date);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);  // Monday-anchored
      const weekStart = new Date(d.setDate(diff)).toISOString().slice(0, 10);
      if (!byWeek[weekStart]) byWeek[weekStart] = 0;
      for (const ex of w.exercises || []) {
        for (const s of ex.sets || []) {
          if (s.completed && !s.warmup && (Number(s.weight) || 0) > 0 && (Number(s.reps) || 0) > 0) {
            byWeek[weekStart] += Number(s.weight) * Number(s.reps);
          }
        }
      }
    }
    return Object.entries(byWeek).map(([week, volume]) => ({ week, volume }));
  },
  async frequency(from, to) {
    const rows = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet).filter(w => (!from || w.date >= from) && (!to || w.date <= to));
    const byWeek = {};
    for (const w of rows) {
      const d = new Date(w.date);
      d.setDate(d.getDate() - d.getDay());
      const key = d.toISOString().slice(0, 10);
      byWeek[key] = (byWeek[key] || 0) + 1;
    }
    return Object.entries(byWeek).map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week));
  },
  async records() {
    // Match server shape: [{ exerciseId, name, maxWeight, maxReps, date, e1rm }].
    // Statistics.svelte renders r.exerciseId, r.name, r.maxWeight, r.maxReps,
    // r.date, r.e1rm directly. Previously native returned legacy keys
    // (exercise_id / exercise_name / weight / reps) that all read as
    // undefined on the records list.
    const all = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet);
    const records = {};
    for (const w of all) {
      for (const ex of w.exercises || []) {
        const id = ex.exercise_id || ex.exercise_name;
        if (!records[id]) records[id] = { name: ex.exercise_name, maxWeight: 0, date: '', e1rm: 0 };
        for (const s of ex.sets || []) {
          if (!s.completed || s.warmup) continue;
          const wt = Number(s.weight) || 0;
          const reps = Number(s.reps) || 0;
          if (wt <= 0) continue;
          const e1rm = reps === 1 ? wt : Math.round(wt * (1 + reps / 30));
          if (wt > records[id].maxWeight) {
            records[id].maxWeight = wt;
            records[id].maxReps = reps;
            records[id].date = w.date;
          }
          if (e1rm > records[id].e1rm) records[id].e1rm = e1rm;
        }
      }
    }
    return Object.entries(records).map(([id, r]) => ({ exerciseId: id, ...r }));
  },
  async progressFor(exerciseId, from, to) {
    // Match server shape: [{ date, maxWeight, totalVolume, sets, avgRpe }].
    // Statistics.svelte's progress chart + history list keys off these.
    const rows = (await Stats._allWorkouts())
      .filter(Stats._hasCompletedSet)
      .filter(w => (!from || w.date >= from) && (!to || w.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date));
    const out = [];
    for (const w of rows) {
      const ex = (w.exercises || []).find(e => Number(e.exercise_id) === Number(exerciseId));
      if (!ex) continue;
      const completed = (ex.sets || []).filter(s => s.completed && !s.warmup && (Number(s.weight) || 0) > 0);
      if (!completed.length) continue;
      const maxWeight = Math.max(...completed.map(s => Number(s.weight) || 0));
      const totalVolume = completed.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
      const rpeValues = completed
        .map(s => parseFloat(s.rpe))
        .filter(n => Number.isFinite(n) && n > 0);
      const avgRpe = rpeValues.length
        ? Math.round((rpeValues.reduce((a, b) => a + b, 0) / rpeValues.length) * 10) / 10
        : null;
      out.push({ date: w.date, maxWeight, totalVolume, sets: completed.length, avgRpe });
    }
    return out;
  },
  async muscleGroupVolume(from, to) {
    // Match server shape: [{ muscle, sets, volume }] (sorted by volume desc).
    // Server normalizes muscle names with a wider set of buckets (biceps,
    // triceps, forearms, quads, hamstrings, glutes, calves separately) than
    // the previous native version that collapsed everything to chest/back/
    // shoulders/arms/legs/core. Keeping the buckets identical keeps the
    // muscle-group volume chart looking the same on both modes.
    const all = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet)
      .filter(w => (!from || w.date >= from) && (!to || w.date <= to));
    // Includes soft-deleted rows on purpose (#49): sets logged against an
    // exercise the user later cleared from their library still need their
    // muscle group to resolve, otherwise every affected set would fall
    // through to the 'other' bucket and skew Muscle Balance.
    const exRows = await dbQuery(`SELECT id, primary_muscles, category FROM exercises`, []);
    const exMap = {};
    for (const r of exRows) {
      exMap[r.id] = {
        muscles: _parseJson(r.primary_muscles, []),
        category: r.category || 'other',
      };
    }
    const normalize = m => {
      const s = String(m || '').toLowerCase().trim();
      if (s.includes('chest') || s.includes('pec')) return 'chest';
      if (s.includes('back') || s.includes('lat') || s.includes('trap') || s.includes('rhomboid')) return 'back';
      if (s.includes('shoulder') || s.includes('delt')) return 'shoulders';
      if (s.includes('bicep')) return 'biceps';
      if (s.includes('tricep')) return 'triceps';
      if (s.includes('forearm')) return 'forearms';
      if (s.includes('ab') || s.includes('core') || s.includes('oblique')) return 'core';
      if (s.includes('quad')) return 'quads';
      if (s.includes('hamstring')) return 'hamstrings';
      if (s.includes('glute')) return 'glutes';
      if (s.includes('calf') || s.includes('calve')) return 'calves';
      if (s.includes('leg')) return 'legs';
      if (s.includes('arm')) return 'arms';
      if (s.includes('cardio')) return 'cardio';
      return s || 'other';
    };
    const out = {};
    for (const w of all) {
      for (const ex of w.exercises || []) {
        const info = exMap[ex.exercise_id] || { muscles: [], category: 'other' };
        const groups = info.muscles.length ? info.muscles : [info.category];
        const normalized = [...new Set(groups.map(normalize))];
        for (const s of ex.sets || []) {
          if (!s.completed || s.warmup || (Number(s.weight) || 0) <= 0 || (Number(s.reps) || 0) <= 0) continue;
          const w = Number(s.weight) * Number(s.reps);
          for (const g of normalized) {
            if (!out[g]) out[g] = { muscle: g, sets: 0, volume: 0 };
            out[g].sets++;
            out[g].volume += w;
          }
        }
      }
    }
    return Object.values(out).sort((a, b) => b.volume - a.volume);
  },
  async weekdayDistribution(from, to) {
    const rows = (await Stats._allWorkouts()).filter(Stats._hasCompletedSet).filter(w => (!from || w.date >= from) && (!to || w.date <= to));
    const out = [0, 0, 0, 0, 0, 0, 0];
    for (const w of rows) out[new Date(w.date).getDay()]++;
    return out.map((count, day) => ({ day, count }));
  },
};

const AiChat = {
  async getHistory() {
    const rows = await dbQuery(
      `SELECT id, role, content, created_at FROM ai_chat_history WHERE user_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1000`,
      [ME]
    );
    return rows;
  },
  async append(role, content) {
    const r = await dbRun(
      `INSERT INTO ai_chat_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      [ME, role, content, _now()]
    );
    return { id: r.lastId };
  },
  async clear() {
    await dbRun(`DELETE FROM ai_chat_history WHERE user_id = ?`, [ME]);
    return { ok: true };
  },
  // /api/ai/chat — handled at the client by aiChat.js (direct provider call).
  // In standalone mode the server's proxy isn't used; the existing aiChat.js
  // already routes directly to Claude/OpenAI/Gemini, so this stub never fires.
  proxy() { throw new _Unsupported('AI chat is dispatched directly to the provider in standalone mode.'); },
};

const Prescriptions = {
  // No trainer/coach in standalone — return empty so UI shows "no prescription".
  forDate() { return null; },
  upcoming() { return []; },
};

const Trainer = {
  members() { return []; },
  unsupported() { throw new _Unsupported('Trainer features require a server connection.'); },
};

const Notify = {
  // Push services (Apprise/Gotify/ntfy) are direct-callable from the client
  // via CapacitorHttp; the server proxy isn't needed in standalone mode.
  // notifications.js already routes around /api/notify on native.
  send() { return { ok: true, dispatched: 'client' }; },
};

const FullBackup = {
  // Local-backup module replaces /api/full-backup in standalone mode.
  // Kept as a stub so the Settings UI surfaces a clear "use Local Backup" hint.
  unsupported() { throw new _Unsupported('Use Settings → Local Backup in standalone mode.'); },
};

// ── path → handler dispatch ──────────────────────────────────────────────

/**
 * Route an /api/... request to the right handler. Returns a plain object
 * (will be JSON-encoded by the fetch interceptor) or throws on error.
 *
 * Throwing _Unsupported indicates "this endpoint requires a server"; the
 * interceptor turns that into HTTP 501.
 */
async function handle(method, path, body, query) {
  const m = method.toUpperCase();
  // Strip leading slash + split. Query string is already parsed by caller.
  const segs = path.replace(/^\/+/, '').split('/');
  // segs[0] is always "api"
  if (segs[0] !== 'api') throw new _Unsupported(`Not an API path: ${path}`);

  const r = segs[1];
  const id = segs[2];
  const sub = segs[3];

  // ── /api/auth/* ────────────────────────────────────────────────────────
  if (r === 'auth') {
    if (id === 'me'              && m === 'GET')    return Auth.me();
    if (id === 'me'              && m === 'DELETE') { await Settings.clearData(); return { ok: true }; }
    if (id === 'status'          && m === 'GET')    return Auth.status();
    if (id === 'login'           && m === 'POST')   return Auth.loginOffline();
    if (id === 'logout'          && m === 'POST')   return Auth.noopOk();
    if (id === 'register'        && m === 'POST')   return Auth.loginOffline();
    if (id === 'profile'         && m === 'PUT')    return Auth.updateProfile(body || {});
    if (id === 'password'        && m === 'PUT')    return Auth.noopOk();
    if (id === 'users'           && m === 'GET' && !sub) return Auth.users();
    if (id === 'users'           && sub)            return Auth.me();
    if (id === 'forgot-password' && m === 'POST')   return Auth.noopOk();
    if (id === 'reset-password'  && m === 'POST')   return Auth.noopOk();
    if (id === 'recover'         && m === 'POST')   return Auth.noopOk();
    if (id === 'invite'          && m === 'POST')   throw new _Unsupported('Invitations require a server.');
    if (id === 'accept-invite'   && m === 'POST')   throw new _Unsupported('Invitations require a server.');
    if (id === 'validate-token'  && m === 'POST')   throw new _Unsupported('Invitations require a server.');
    if (id === 'management')                         return Auth.noopOk();
  }

  // ── /api/app-config ────────────────────────────────────────────────────
  if (r === 'app-config') {
    if (!id              && m === 'GET')  return AppConfig.get();
    if (!id              && m === 'PUT')  return AppConfig.set(body || {});
    if (id === 'env-locks' && m === 'GET') return AppConfig.envLocks();
    if (id === 'test-email')               throw new _Unsupported('Email tests require a server.');
  }

  // ── /api/settings ──────────────────────────────────────────────────────
  if (r === 'settings') {
    if (!id              && m === 'GET') return Settings.get();
    if (!id              && m === 'PUT') return Settings.put(body || {});
    if (id === 'clear-data' && m === 'DELETE') return Settings.clearData();
    if (id === 'push-test') return { ok: true, dispatched: 'client' };
  }

  // ── /api/exercises ─────────────────────────────────────────────────────
  if (r === 'exercises') {
    if (!id                                  && m === 'GET')    return Exercises.list(query || {});
    if (!id                                  && m === 'POST')   return Exercises.create(body || {});
    if (id === 'custom' && sub === 'all'     && m === 'DELETE') return Exercises.deleteAllCustom();
    if (id === 'media-urls')                                    return [];
    // Usage stats — compute from local workout_log so sort+recency work
    // in standalone mode too.
    if (id === 'usage' && m === 'GET') {
      const rows = await dbQuery(
        `SELECT date, exercises FROM workout_log
          WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL
          ORDER BY date DESC`, [ME]
      );
      const out = {};
      for (const row of rows) {
        let exs;
        try { exs = JSON.parse(row.exercises || '[]'); } catch { continue; }
        const seen = new Set();
        for (const ex of exs) {
          if (!ex.exercise_id) continue;
          const hasCompleted = (ex.sets || []).some(s => s.completed && !s.warmup);
          if (!hasCompleted) continue;
          const k = `${ex.exercise_id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (!out[k]) out[k] = { count: 0, last_date: row.date };
          out[k].count++;
          if (row.date > out[k].last_date) out[k].last_date = row.date;
        }
      }
      return out;
    }
    if (id === 'sources' && sub === 'list')                     return Exercises.sourcesList();
    if (id === 'sources' && sub === 'import' && m === 'POST')   return Exercises.sourcesImport(body?.source, body?.apiKey);
    if (id === 'sources' && sub === 'toggle' && m === 'POST')   return Exercises.sourcesToggle(body?.source, body?.enabled);
    if (id === 'sources' && sub === 'clear'  && m === 'POST')   return Exercises.sourcesClear(body?.source);
    if (id === 'sources')                                        Exercises.unsupported();
    if (id === 'sync-wger' && m === 'POST')                     return Exercises.sourcesImport('wger');
    if (/^\d+$/.test(id) && m === 'GET')    return Exercises.get(Number(id));
    if (/^\d+$/.test(id) && m === 'PUT')    return Exercises.update(Number(id), body || {});
    if (/^\d+$/.test(id) && m === 'DELETE') return Exercises.del(Number(id));
  }

  // ── /api/exercise-import ──────────────────────────────────────────────
  // Standalone parity for the custom-catalog JSON import (mirrors
  // server/routes/exercise-import.js#import-json). The catalogs/* endpoints
  // need to keep working too so users can manage what they've imported.
  if (r === 'exercise-import') {
    // POST /api/exercise-import/import-json
    if (id === 'import-json' && m === 'POST') {
      const catalogName = String(body?.catalogName || '').trim();
      if (!catalogName) throw new Error('catalogName is required');
      if (catalogName.length > 60) throw new Error('catalogName must be 60 characters or fewer');
      const list = Array.isArray(body?.exercises) ? body.exercises : null;
      if (!list) throw new Error('exercises must be an array');
      if (list.length === 0) throw new Error('exercises array is empty');
      if (list.length > 10000) throw new Error('exercises array exceeds 10,000 row cap');

      const source = `import:${catalogName}`;
      const _norm = s => String(s || '').trim().replace(/\s+/g, ' ');
      const _arr  = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(_norm).filter(Boolean) : [];
      const _str  = v => (v == null || v === '') ? null : String(v);

      const seen = new Set();
      let count = 0, duplicates = 0, skipped = 0;
      for (const raw of list) {
        const name = _norm(raw?.name);
        if (!name) { skipped++; continue; }
        const equipment = _arr(raw?.equipment);
        const key = name.toLowerCase() + '||' + equipment.join(',').toLowerCase();
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        try {
          await dbRun(
            `INSERT OR IGNORE INTO exercises (name, category, equipment, instructions,
               primary_muscles, secondary_muscles, img_url, gif_url, video_url,
               source, is_global, created_by, created_at, updated_at, sync_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending')`,
            [
              name,
              _str(raw?.category) || 'other',
              JSON.stringify(equipment),
              _str(raw?.instructions),
              JSON.stringify(_arr(raw?.primary_muscles)),
              JSON.stringify(_arr(raw?.secondary_muscles)),
              _str(raw?.img_url),
              _str(raw?.gif_url),
              _str(raw?.video_url),
              source,
              ME,
              _now(),
              _now(),
            ]
          );
          count++;
        } catch { skipped++; }
      }
      return { ok: true, catalogName, count, duplicates, skipped };
    }
    // GET /api/exercise-import/catalogs → list imported catalogs
    if (id === 'catalogs' && !sub && m === 'GET') {
      const rows = await dbQuery(
        `SELECT source, COUNT(*) AS count FROM exercises
         WHERE source LIKE 'import:%' AND deleted_at IS NULL
         GROUP BY source`,
        []
      );
      const out = [];
      for (const r of rows) {
        const name = r.source.replace(/^import:/, '');
        const disabled = (await dbQuery(
          `SELECT value FROM user_settings WHERE user_id = ? AND key = ?`,
          [ME, `catalog_disabled_${name}`]
        ))[0];
        out.push({
          id: r.source, name, count: r.count,
          enabled: !disabled?.value || disabled.value === 'false',
        });
      }
      return out;
    }
    // POST /api/exercise-import/catalogs/toggle
    if (id === 'catalogs' && sub === 'toggle' && m === 'POST') {
      const name = String(body?.name || '').trim();
      const enabled = !!body?.enabled;
      const key = `catalog_disabled_${name}`;
      if (enabled) {
        await dbRun(`DELETE FROM user_settings WHERE user_id = ? AND key = ?`, [ME, key]);
      } else {
        await dbRun(
          `INSERT OR REPLACE INTO user_settings (user_id, key, value, updated_at, sync_state)
           VALUES (?, ?, ?, ?, 'pending')`,
          [ME, key, 'true', _now()]
        );
      }
      return { ok: true };
    }
    // POST /api/exercise-import/catalogs/delete
    if (id === 'catalogs' && sub === 'delete' && m === 'POST') {
      const name = String(body?.name || '').trim();
      const source = `import:${name}`;
      const r = await dbRun(
        `UPDATE exercises SET deleted_at = ?, sync_state = 'pending' WHERE source = ? AND deleted_at IS NULL`,
        [_now(), source]
      );
      await dbRun(`DELETE FROM user_settings WHERE user_id = ? AND key = ?`, [ME, `catalog_disabled_${name}`]);
      return { ok: true, removed: r?.changes || 0 };
    }
    Exercises.unsupported();
  }

  // ── /api/programs ──────────────────────────────────────────────────────
  if (r === 'programs') {
    if (!id                  && m === 'GET')    return Programs.list();
    if (!id                  && m === 'POST')   return Programs.create(body || {});
    if (id === 'deactivate'  && m === 'POST')   return Programs.deactivate();
    if (/^\d+$/.test(id) && m === 'GET')        return Programs.get(Number(id));
    if (/^\d+$/.test(id) && m === 'PUT')        return Programs.update(Number(id), body || {});
    if (/^\d+$/.test(id) && m === 'DELETE')     return Programs.del(Number(id));
    if (/^\d+$/.test(id) && sub === 'activate'    && m === 'POST') return Programs.activate(Number(id));
    if (/^\d+$/.test(id) && sub === 'week-cursor' && m === 'POST') return Programs.setWeekCursor(Number(id), body || {});
    if (/^\d+$/.test(id) && sub === 'reorder'     && m === 'PUT')  return Programs.reorder(Number(id), body || {});
    // /api/programs/:id/assign[/:userId] — POST (assign) or DELETE (unassign).
    // Standalone has no other user to assign to, so these are no-ops here.
    // In native+server mode the dispatcher hits the server first and only
    // falls through if offline; the user-mgmt UI hides the feature in
    // standalone anyway, so this is mostly defensive.
    if (/^\d+$/.test(id) && sub === 'assign') return { ok: true };
  }

  // ── /api/templates ─────────────────────────────────────────────────────
  if (r === 'templates') {
    if (!id              && m === 'POST')   return Templates.create(body || {});
    if (/^\d+$/.test(id) && m === 'GET')    return Templates.get(Number(id));
    if (/^\d+$/.test(id) && m === 'PUT')    return Templates.update(Number(id), body || {});
    if (/^\d+$/.test(id) && m === 'DELETE') return Templates.del(Number(id));
  }

  // ── /api/workout/:date | /api/workout/recent | /api/workout/history/:exerciseId ─
  // Server wraps GET /:date and PUT /:date responses in { workout: ... };
  // matching that here so loadWorkout in src/stores/workout.js — which does
  // todayLog.set(data.workout || null) — works whether reading from cache
  // (native) or from the server (PWA).
  if (r === 'workout') {
    if (id === 'recent'  && m === 'GET') return Workout.recent(query?.limit);
    if (id === 'history' && /^\d+$/.test(sub) && m === 'GET') return Workout.historyFor(Number(sub));
    if (id === 'history' && sub) return [];
    // /api/workout/:date/feedback — no local store for feedback in
    // standalone; return empty list so the diary renders cleanly.
    if (id && sub === 'feedback' && m === 'GET') return [];
    // /api/workout/:date/sessions (issue #76) — every session that date.
    if (id && sub === 'sessions' && m === 'GET') return { sessions: await Workout.sessions(id) };
    if (id              && m === 'GET')    return { workout: await Workout.byDate(id, query?.id != null ? Number(query.id) : null) };
    if (id              && m === 'PUT')    return { workout: await Workout.upsert(id, body || {}) };
    if (id              && m === 'DELETE') return Workout.del(id, query?.id != null ? Number(query.id) : null);
  }

  // ── /api/body-stats/:date | /api/body-stats/range ─────────────────────
  // Server wraps GET /:date and PUT /:date in { stats: ... }; range returns
  // a bare array. BodyStats.svelte reads data.stats off the wrapper.
  if (r === 'body-stats') {
    if (id === 'range' && m === 'GET') return BodyStats.range(query?.from, query?.to);
    if (id              && m === 'GET') return { stats: await BodyStats.get(id) };
    if (id              && m === 'PUT') return { stats: await BodyStats.put(id, body || {}) };
  }

  // ── /api/cardio/* ─────────────────────────────────────────────────────
  if (r === 'cardio') {
    if (!id                                  && m === 'GET')    return Cardio.list(query?.start, query?.end);
    if (!id                                  && m === 'POST')   return Cardio.create(body || {});
    if (id === 'stats' && sub === 'weekly'   && m === 'GET')    return Cardio.weekly(query?.start, query?.end);
    if (id === 'templates'                   && m === 'GET')    return Cardio.templates();
    // Bare /:date fetches sessions for a single day.
    if (id && /^\d{4}-\d{2}-\d{2}$/.test(id) && m === 'GET')    return Cardio.byDate(id);
    if (id && /^\d+$/.test(id)               && m === 'PUT')    return Cardio.update(Number(id), body || {});
    if (id && /^\d+$/.test(id)               && m === 'DELETE') return Cardio.del(Number(id));
  }

  // ── /api/stats/* ──────────────────────────────────────────────────────
  if (r === 'stats') {
    const from = query?.from, to = query?.to;
    if (id === 'earliest-workout-date')  return Stats.earliestWorkoutDate();
    if (id === 'streaks')                return Stats.streaks();
    if (id === 'volume')                 return Stats.volume(from, to);
    if (id === 'frequency')              return Stats.frequency(from, to);
    if (id === 'records')                return Stats.records();
    if (id === 'muscle-group-volume')    return Stats.muscleGroupVolume(from, to);
    if (id === 'weekday-distribution')   return Stats.weekdayDistribution(from, to);
    if (id === 'progress' && /^\d+$/.test(sub)) return Stats.progressFor(Number(sub), from, to);
  }

  // ── /api/ai/* ─────────────────────────────────────────────────────────
  if (r === 'ai') {
    if (id === 'history' && m === 'GET')    return AiChat.getHistory();
    if (id === 'history' && m === 'DELETE') return AiChat.clear();
    if (id === 'chat')                      return AiChat.proxy();
  }

  // ── /api/prescriptions ────────────────────────────────────────────────
  if (r === 'prescriptions') {
    if (id === 'my' && /^\d{4}-\d{2}-\d{2}$/.test(sub)) return Prescriptions.forDate();
    if (id === 'my' && sub === 'upcoming')              return Prescriptions.upcoming();
  }

  // ── /api/trainer ──────────────────────────────────────────────────────
  // Standalone has no trainer/member relationships. Lists return [], writes
  // return { ok: true } so the UI degrades gracefully without throwing.
  if (r === 'trainer') {
    if (id === 'activity' && m === 'GET')                       return [];
    if (id === 'activity' && sub === 'seen' && m === 'POST')    return { ok: true };
    if (id === 'unassigned-members' && m === 'GET')             return [];
    if (id === 'prescriptions' && /^\d+$/.test(sub) && m === 'PUT') return { ok: true };
    if (id === 'members' && /^\d+$/.test(sub) && m === 'POST')  return { ok: true };
    if (id === 'feedback' && m === 'POST')                       return { ok: true };
    return [];
  }

  // ── /api/notify ───────────────────────────────────────────────────────
  // ── /api/coach-feedback (member-side inbox / unread surfaces) ─────────
  // Standalone has no trainer, so inbox is always empty and seen-marking
  // is a no-op. Falls back gracefully without throwing in the UI.
  if (r === 'coach-feedback') {
    if (id === 'inbox' && m === 'GET')          return [];
    if (id === 'unread-dates' && m === 'GET')   return [];
    if (id === 'seen' && m === 'POST')          return { ok: true };
    if (/^\d+$/.test(id) && sub === 'reply' && m === 'PUT') return { ok: true };
    return [];
  }

  if (r === 'notify') return Notify.send();

  // ── /api/full-backup ──────────────────────────────────────────────────
  if (r === 'full-backup') FullBackup.unsupported();

  // ── /api/upload + /api/upload/exercise-media ──────────────────────────
  // Standalone equivalent of the server's multer routes: write the blob
  // to Capacitor Filesystem under Directory.Data/lifttrace-uploads/,
  // return the same JSON shape so call sites (Profile avatar, MediaInput)
  // don't need to branch on platform.
  if (r === 'upload') {
    if (m !== 'POST') throw new _Unsupported(`Unsupported upload method: ${m}`);
    if (!body || typeof body.get !== 'function') {
      throw new _Unsupported('Upload requires a FormData payload with a file field.');
    }
    const file = body.get('file');
    if (!file) throw new _Unsupported('No file in upload payload.');
    const { writeLocalUpload } = await import('./local-uploads.js');
    const isExercise = id === 'exercise-media';
    const written = await writeLocalUpload(file, {
      category:     isExercise ? 'exercise' : 'avatar',
      originalName: file.name || '',
    });
    // /api/upload server response: { url, mimeType }
    // /api/upload/exercise-media: { url, kind, mimeType, size }
    return isExercise
      ? { url: written.url, kind: written.kind, mimeType: written.mimeType, size: written.size }
      : { url: written.url, mimeType: written.mimeType };
  }

  // ── /api/proxy + /api/radio-proxy ─────────────────────────────────────
  if (r === 'proxy')        throw new _Unsupported('Image proxying requires a server.');
  if (r === 'radio-proxy') {
    // /api/radio-proxy/now-playing?url=…   → fetch from station's own
    //                                         status-json.xsl / stats endpoint
    // /api/radio-proxy/info?url=…          → not available standalone
    //                                         (would need raw header read)
    // /api/radio-proxy/icon-suggest?url=…  → not available standalone
    if (id === 'now-playing' && m === 'GET') {
      const u = query?.url;
      if (!u) return { title: '', updatedAt: null };
      const { getNowPlaying } = await import('./radio-icy.js');
      const r = await getNowPlaying(u);
      return r ? { title: r.title, updatedAt: r.updatedAt, source: r.source }
               : { title: '', updatedAt: null };
    }
    throw new _Unsupported('This radio proxy endpoint requires a server.');
  }

  // ── /api/subsonic ─────────────────────────────────────────────────────
  if (r === 'subsonic') throw new _Unsupported('Subsonic music library requires a server.');

  // ── /api/workout-import ──────────────────────────────────────────────
  // Standalone parity for the Strong/Hevy/FitNotes/JEFit CSV importers.
  // The adapters in src/lib/workout-import/ are pure JS copies of their
  // server siblings, so the only thing that changes vs the server route
  // is where the parsed workouts get written (local SQLite vs server DB).
  if (r === 'workout-import') {
    if (m !== 'POST') throw new _Unsupported(`Unsupported workout-import method: ${m}`);
    if (!body || typeof body.get !== 'function') {
      throw new _Unsupported('Workout import requires a FormData payload with a file field.');
    }
    const file = body.get('file');
    if (!file) throw new _Unsupported('No file in workout-import payload.');
    const source = String(body.get('source') || '');
    const SUPPORTED = ['strong', 'hevy', 'fitnotes', 'jefit'];
    if (!SUPPORTED.includes(source)) throw new _Unsupported(`Unsupported source: ${source}`);

    const text = await file.text();
    const userUnit = await (async () => {
      const row = (await dbQuery(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'weightUnit'`, [ME]))[0];
      if (!row) return 'lbs';
      try { return JSON.parse(row.value); } catch { return row.value || 'lbs'; }
    })();

    const { parseStrong }   = await import('./workout-import/strong.js');
    const { parseHevy }     = await import('./workout-import/hevy.js');
    const { parseFitnotes } = await import('./workout-import/fitnotes.js');
    const { parseJefit }    = await import('./workout-import/jefit.js');
    const { matchExercise } = await import('./workout-import/common.js');
    const parse = { strong: parseStrong, hevy: parseHevy, fitnotes: parseFitnotes, jefit: parseJefit }[source];

    let workouts;
    try { workouts = parse(text, userUnit); }
    catch (e) { throw new Error(`Parse failed: ${e.message}`); }
    if (!workouts.length) throw new Error('No workouts found in file');

    const library = await dbQuery(
      `SELECT id, name FROM exercises WHERE (is_global = 1 OR created_by = ?) AND deleted_at IS NULL`,
      [ME]
    );

    // ── /preview ──────────────────────────────────────────────────────
    if (id === 'preview') {
      let totalSets = 0;
      const unmatched = new Map();
      const matched   = new Set();
      for (const w of workouts) {
        for (const ex of w.exercises) {
          totalSets += (ex.sets || []).length;
          const found = matchExercise(ex.sourceName, library);
          if (found) matched.add(ex.sourceName);
          else unmatched.set(ex.sourceName, (unmatched.get(ex.sourceName) || 0) + 1);
        }
      }
      const dates = workouts.map(w => w.date);
      const dateSet = new Set(dates);
      const existingRows = await dbQuery(
        `SELECT date FROM workout_log WHERE user_id = ? AND deleted_at IS NULL AND date IN (${dates.map(() => '?').join(',') || "''"})`,
        [ME, ...dates]
      );
      const dupeDates = new Set(existingRows.map(r => r.date).filter(d => dateSet.has(d)));
      return {
        workouts: workouts.length,
        sets: totalSets,
        uniqueExercises: matched.size + unmatched.size,
        matchedExercises: matched.size,
        unmatchedExercises: [...unmatched.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([name, count]) => ({ name, count })),
        duplicateDates: dupeDates.size,
        dateRange: { from: workouts[0].date, to: workouts[workouts.length - 1].date },
      };
    }

    // ── /commit ───────────────────────────────────────────────────────
    if (id === 'commit') {
      const dupeMode = String(body.get('onDuplicate') || '') === 'replace' ? 'replace' : 'skip';
      let imported = 0, skipped = 0, replaced = 0;
      for (const w of workouts) {
        const existing = (await dbQuery(
          `SELECT id FROM workout_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL`,
          [ME, w.date]
        ))[0];
        if (existing) {
          if (dupeMode === 'skip') { skipped++; continue; }
          await dbRun(
            `UPDATE workout_log SET deleted_at = ?, sync_state = 'pending' WHERE id = ?`,
            [_now(), existing.id]
          );
          replaced++;
        }
        const exerciseRows = w.exercises.map(ex => {
          const match = matchExercise(ex.sourceName, library);
          return {
            exercise_id:   match ? match.id : null,
            exercise_name: match ? match.name : ex.sourceName,
            sets:          ex.sets,
            superset_id:   ex.superset_id ?? null,
            superset_size: ex.superset_size || 1,
          };
        });
        await dbRun(
          `INSERT INTO workout_log (user_id, date, name, notes, duration_min, exercises, completed, created_at, updated_at, sync_state)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending')`,
          [ME, w.date, w.name || 'Imported', w.notes || null, w.duration_min || null,
           JSON.stringify(exerciseRows), _now(), _now()]
        );
        imported++;
      }
      return { imported, skipped, replaced };
    }

    throw new _Unsupported(`Unknown workout-import endpoint: ${id}`);
  }

  throw new _Unsupported(`No standalone handler for ${m} ${path}`);
}

export const LtApiNative = { handle, _Unsupported };
