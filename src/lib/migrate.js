/**
 * migrate.js — Standalone → server data migration.
 *
 * Called from NativeSetup after the user logs in to a server. If the local
 * SQLite has data from a prior standalone session, surface counts so the
 * user can pick: upload local → server, replace local with server, or
 * merge (upload then pull).
 *
 * Mirrors NutriTrace's pattern (Settings.svelte three-option dialog) but
 * adds two improvements: (1) the dialog shows per-table counts before the
 * user commits, and (2) the upload pass returns a per-table success/error
 * summary so the user actually knows whether the migration completed.
 *
 * Server endpoints used (already exist):
 *   PUT  /api/workout/:date         upserts on (user_id, date)
 *   PUT  /api/body-stats/:date      upserts on (user_id, date)
 *   POST /api/programs              creates a new program
 *   POST /api/templates             creates a workout template under a program
 *   POST /api/exercises             creates a custom exercise
 *   PUT  /api/settings              upserts a single user setting (key, value)
 *
 * For workouts and body stats the server's UNIQUE(user_id, date) constraint
 * gives us free dedup — re-uploading a date the server already has overwrites
 * cleanly. Programs / custom exercises don't have a natural unique key, so
 * we accept that running upload twice produces duplicates (user is warned in
 * the merge dialog).
 */

import { dbQuery } from './db-native.js';
import { isNative, getServerUrl, getAuthToken } from './platform.js';

/**
 * Count local rows that would be uploaded. Returns
 * `{ workouts, bodyStats, programs, templates, customExercises, settings, total }`.
 *
 * Runs SQL aggregates only — fast, no network. Excludes soft-deleted rows
 * (`deleted_at IS NOT NULL`) and seeded global exercises.
 */
export async function countLocalData() {
  if (!isNative) return _empty();
  try {
    const [w, b, p, t, e, s] = await Promise.all([
      _scalar('SELECT COUNT(*) FROM workout_log WHERE deleted_at IS NULL'),
      _scalar('SELECT COUNT(*) FROM body_stats_log WHERE deleted_at IS NULL'),
      _scalar('SELECT COUNT(*) FROM programs WHERE deleted_at IS NULL'),
      _scalar('SELECT COUNT(*) FROM workout_templates'),
      _scalar(`SELECT COUNT(*) FROM exercises
               WHERE source = 'custom' AND is_global = 0 AND deleted_at IS NULL`),
      _scalar('SELECT COUNT(*) FROM user_settings'),
    ]);
    const total = w + b + p + t + e + s;
    return { workouts: w, bodyStats: b, programs: p, templates: t, customExercises: e, settings: s, total };
  } catch (err) {
    console.warn('[migrate] countLocalData failed:', err?.message || err);
    return _empty();
  }
}

/**
 * Push every local row to the server. Caller is responsible for putting the
 * app into server mode FIRST (setNativeMode('server') + setServerUrl +
 * setAuthToken) so apiFetch routes the writes correctly. Returns
 * `{ success: { workouts, bodyStats, ... }, errors: [...], total, totalSuccess }`.
 *
 * `onProgress(stage, current, total)` is called between each row so the UI
 * can render a progress bar. `stage` is one of: 'workouts', 'bodyStats',
 * 'programs', 'customExercises', 'settings'.
 */
export async function uploadLocalToServer({ onProgress } = {}) {
  if (!isNative)        throw new Error('uploadLocalToServer only runs on Capacitor');
  if (!getServerUrl())  throw new Error('Server URL not configured');
  if (!getAuthToken())  throw new Error('Auth token missing — log in first');

  const summary = {
    success: { workouts: 0, bodyStats: 0, programs: 0, templates: 0, customExercises: 0, settings: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
  };

  // ── Custom exercises first ────────────────────────────────────────────────
  // Programs reference exercises by id. Server creates new ids, so we keep
  // a local→remote id map for any later code that needs it. Today's
  // workout_templates store exercise rows as JSON snapshots (not FKs to
  // exercise rows), so the map is informational; templates upload fine
  // even without it.
  const exMap = new Map();
  const customEx = await dbQuery(
    `SELECT * FROM exercises WHERE source = 'custom' AND is_global = 0 AND deleted_at IS NULL`
  );
  for (let i = 0; i < customEx.length; i++) {
    onProgress?.('customExercises', i, customEx.length);
    const row = customEx[i];
    try {
      const created = await _post('/api/exercises', {
        name:              row.name,
        category:          row.category,
        primary_muscles:   _parseJson(row.primary_muscles),
        secondary_muscles: _parseJson(row.secondary_muscles),
        equipment:         _parseJson(row.equipment),
        instructions:      row.instructions,
        tips:              row.tips,
        img_url:           row.img_url,
        gif_url:           row.gif_url,
        video_url:         row.video_url,
      });
      if (created?.id) exMap.set(row.id, created.id);
      summary.success.customExercises++;
    } catch (e) {
      summary.errors.push({ stage: 'customExercises', name: row.name, message: e.message });
    }
  }

  // ── Programs + their workout templates ────────────────────────────────────
  const programs = await dbQuery(`SELECT * FROM programs WHERE deleted_at IS NULL`);
  for (let i = 0; i < programs.length; i++) {
    onProgress?.('programs', i, programs.length);
    const p = programs[i];
    let createdProgramId = null;
    try {
      const created = await _post('/api/programs', {
        name:        p.name,
        description: p.description,
        goal:        p.goal,
        visibility:  p.visibility || 'private',
      });
      createdProgramId = created?.id;
      summary.success.programs++;
    } catch (e) {
      summary.errors.push({ stage: 'programs', name: p.name, message: e.message });
      continue; // can't upload templates without a parent program id
    }

    const templates = await dbQuery(
      `SELECT * FROM workout_templates WHERE program_id = ? ORDER BY order_index ASC`,
      [p.id]
    );
    for (const t of templates) {
      try {
        await _post('/api/templates', {
          program_id:  createdProgramId,
          name:        t.name,
          day_label:   t.day_label,
          order_index: t.order_index,
          exercises:   _parseJson(t.exercises),
        });
        summary.success.templates++;
      } catch (e) {
        summary.errors.push({ stage: 'templates', name: `${p.name} / ${t.name}`, message: e.message });
      }
    }
  }

  // ── Workouts (upserts by date — clean dedup) ──────────────────────────────
  const workouts = await dbQuery(
    `SELECT * FROM workout_log WHERE deleted_at IS NULL ORDER BY date ASC`
  );
  for (let i = 0; i < workouts.length; i++) {
    onProgress?.('workouts', i, workouts.length);
    const w = workouts[i];
    try {
      await _put(`/api/workout/${encodeURIComponent(w.date)}`, {
        template_id:  w.template_id,
        program_id:   w.program_id,
        name:         w.name,
        exercises:    _parseJson(w.exercises),
        notes:        w.notes,
        duration_min: w.duration_min,
        completed:    !!w.completed,
      });
      summary.success.workouts++;
    } catch (e) {
      summary.errors.push({ stage: 'workouts', name: w.date, message: e.message });
    }
  }

  // ── Body stats (upserts by date) ──────────────────────────────────────────
  const bodyStats = await dbQuery(
    `SELECT * FROM body_stats_log WHERE deleted_at IS NULL ORDER BY date ASC`
  );
  for (let i = 0; i < bodyStats.length; i++) {
    onProgress?.('bodyStats', i, bodyStats.length);
    const b = bodyStats[i];
    try {
      await _put(`/api/body-stats/${encodeURIComponent(b.date)}`, _parseJson(b.stats));
      summary.success.bodyStats++;
    } catch (e) {
      summary.errors.push({ stage: 'bodyStats', name: b.date, message: e.message });
    }
  }

  // ── User settings (upsert per-key) ────────────────────────────────────────
  const settings = await dbQuery(`SELECT * FROM user_settings`);
  for (let i = 0; i < settings.length; i++) {
    onProgress?.('settings', i, settings.length);
    const s = settings[i];
    try {
      await _put('/api/settings', { key: s.key, value: _parseJson(s.value) });
      summary.success.settings++;
    } catch (e) {
      summary.errors.push({ stage: 'settings', name: s.key, message: e.message });
    }
  }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _empty() {
  return { workouts: 0, bodyStats: 0, programs: 0, templates: 0, customExercises: 0, settings: 0, total: 0 };
}

async function _scalar(sql) {
  const rows = await dbQuery(sql);
  if (!rows?.length) return 0;
  const first = rows[0];
  return Number(Object.values(first)[0]) || 0;
}

function _parseJson(s, fallback = null) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

async function _post(path, body) {
  return _request('POST', path, body);
}
async function _put(path, body) {
  return _request('PUT', path, body);
}
async function _request(method, path, body) {
  // Goes through the patched fetch in apiFetch.js — once nativeMode is
  // 'server' and a token is set, this rewrites to the server origin and
  // attaches Authorization: Bearer. We don't call apiFetch directly because
  // it's installed as a global window.fetch override.
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let msg = `${method} ${path} → ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  try { return await res.json(); } catch { return null; }
}
