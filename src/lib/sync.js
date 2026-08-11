/**
 * sync.js — Server-connected native mode sync.
 *
 * The local SQLite database doubles as an offline cache when the device is
 * connected to a LiftTrace server. Three pieces of behavior:
 *
 *   1. pullSnapshot() — refresh the local cache from server list endpoints.
 *      Called on connect, on app foreground, and from a Settings → Sync now button.
 *
 *   2. flushQueue() — re-attempt any writes that were enqueued while the
 *      device was offline. Called from the `online` event and on app open.
 *
 *   3. enqueueWrite() — record a failed write so it can be retried later.
 *      Called from apiFetch.js when a server PUT/POST/DELETE fails due to
 *      a network error.
 *
 * Reads are served from local SQLite when the server is unreachable; writes
 * always update local cache optimistically so the UI stays consistent
 * regardless of network state.
 */

import { writable } from 'svelte/store';
import { isNative, getServerUrl, getAuthToken } from './platform.js';
import { dbQuery, dbRun, getSyncMeta, setSyncMeta } from './db-native.js';
import { LtApiNative } from './api-native.js';

/**
 * Live sync state, mirrored into the Settings UI for the "Last synced X ago"
 * label + spinner. Also lets the rest of the app react to sync activity
 * (e.g. show a transient banner during a manual fullSync).
 */
export const syncState = writable({
  syncing:  false,
  phase:    '',           // 'pushing' | 'pulling' | ''
  progress: '',           // human-readable status line
  lastSync: null,         // ISO timestamp of the most recent successful pull
  error:    null,
  online:   true,
  // Structured classification of the current connection problem
  // (kind: 'no_network' | 'server_error' | 'server_unreachable'). Feeds
  // the smart connection banner in App.svelte via
  // lib/connection-message.js. `showErrorBanner` gates the full banner
  // vs the compact hamburger cloud badge — automatic probes update the
  // badge; manual retries / user-initiated syncs opt into the banner.
  connectionIssue: null,
  showErrorBanner: false,
});

// ── Server-reachability probe ────────────────────────────────────────────
// Mirrors NT sync.js. Distinguishes "no network" (airplane / OS offline)
// from "server unreachable" (network fine, host doesn't answer) from
// "server error" (HTTP 4xx/5xx). Feeds the smart connection banner.
let _lastOfflineAt = 0;
let _lastOnlineAt = 0;
let _onlineCheckPromise = null;
const OFFLINE_RETRY_DELAY_MS = 15000;
const ONLINE_CHECK_CACHE_MS = 15000;

/** True while the health-check circuit breaker is suppressing redundant requests. */
export function isServerKnownUnavailable() {
  return !!_lastOfflineAt && Date.now() - _lastOfflineAt < OFFLINE_RETRY_DELAY_MS;
}

async function _networkSnapshot() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { connected: false, connectionType: 'none' };
  }
  try {
    const { Network } = await import('@capacitor/network');
    return await Network.getStatus();
  } catch {
    return {
      connected: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      connectionType: 'unknown',
    };
  }
}

function _serverHost() {
  try { return new URL(getServerUrl()).hostname; }
  catch { return getServerUrl() || 'server'; }
}

function _connectionIssue({ network, error = null, status = null }) {
  const noNetwork = !network?.connected || network?.connectionType === 'none';
  return {
    kind: noNetwork ? 'no_network' : status ? 'server_error' : 'server_unreachable',
    host: _serverHost(),
    connectionType: network?.connectionType || 'unknown',
    status,
    detail: error?.message || null,
    at: new Date().toISOString(),
  };
}

function _publishConnectionIssue(issue, showErrorBanner = false) {
  syncState.update(s => ({
    ...s,
    online: false,
    connectionIssue: issue,
    ...(showErrorBanner ? { showErrorBanner: true } : {}),
  }));
}

async function _probeServer(showErrorBanner = false) {
  const url = getServerUrl();
  if (!url) return true;
  try {
    const tok = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const res = await fetch(url + '/api/health', { headers, signal: AbortSignal.timeout(3000) });
    const online = res.ok;
    if (!online) {
      _lastOnlineAt = 0;
      _lastOfflineAt = Date.now();
      const network = await _networkSnapshot();
      const issue = _connectionIssue({ network, status: res.status });
      console.warn(`[sync] server health check failed: host=${issue.host} network=${issue.connectionType} status=${res.status}`);
      _publishConnectionIssue(issue, showErrorBanner);
    } else {
      _lastOfflineAt = 0;
      _lastOnlineAt = Date.now();
      syncState.update(s => ({ ...s, online: true, connectionIssue: null, showErrorBanner: false }));
    }
    return online;
  } catch (error) {
    _lastOnlineAt = 0;
    _lastOfflineAt = Date.now();
    const network = await _networkSnapshot();
    const issue = _connectionIssue({ network, error });
    console.warn(`[sync] server unreachable: host=${issue.host} network=${issue.connectionType} error=${error?.message || String(error)}`);
    _publishConnectionIssue(issue, showErrorBanner);
    return false;
  }
}

export async function checkOnline(force = false, showErrorBanner = false) {
  if (!force && isServerKnownUnavailable()) return false;
  if (!force && _lastOnlineAt && Date.now() - _lastOnlineAt < ONLINE_CHECK_CACHE_MS) {
    return true;
  }
  if (!force && _onlineCheckPromise) return _onlineCheckPromise;
  if (force) return _probeServer(showErrorBanner);

  _onlineCheckPromise = _probeServer(showErrorBanner);
  try {
    return await _onlineCheckPromise;
  } finally {
    _onlineCheckPromise = null;
  }
}

// Verbose sync logs are gated on dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('lt:verboseLogging') === '1') console.log(...a); } catch {} };

let _syncing = false;
let _flushing = false;

// ── Server fetch helper (uses CapacitorHttp to bypass WebView CORS) ──────

/**
 * Handle a 401 from any sync endpoint by clearing local auth state so
 * App.svelte's reactive gate sends the user to Login. Without this,
 * an expired JWT or rotated server-side JWT_SECRET puts sync into an
 * unwinnable retry loop. Mirrors the same fix in NT sync.js
 * (commit d1e8217) and CT (commit c4d6334).
 */
async function _handleSyncAuthError() {
  console.warn('[sync] received 401 — clearing local auth so the user can re-sign-in');
  try {
    const { setAuthToken } = await import('./platform.js');
    setAuthToken(null);
  } catch {}
  try { localStorage.removeItem('wl:userId'); } catch {}
  try { localStorage.removeItem('lt:cachedUser'); } catch {}
  try { localStorage.removeItem('lt:csrf'); } catch {}
  // Also wipe the biometric-saved JWT. Without this, the user retrieves
  // a stale token on next launch via biometric, hits 401 silently, and
  // bounces back to Login with no visible feedback. NT confirmed this
  // pattern via logcat (commit 9d33afb).
  try {
    const { clearSavedToken } = await import('./biometric.js');
    await clearSavedToken();
  } catch {}
  try {
    const { currentUser } = await import('../stores/auth.js');
    currentUser.set(null);
  } catch {}
}

async function _serverFetch(method, path, body) {
  const url = getServerUrl();
  if (!url) throw new Error('No server configured');
  const { CapacitorHttp } = await import('@capacitor/core');
  const headers = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { url: url + path, headers };
  if (body != null) opts.data = body;
  const fn = method === 'GET' ? CapacitorHttp.get
          : method === 'POST' ? CapacitorHttp.post
          : method === 'PUT' ? CapacitorHttp.put
          : method === 'DELETE' ? CapacitorHttp.delete
          : CapacitorHttp.request;
  const res = await fn.call(CapacitorHttp, opts);
  if (res.status < 200 || res.status >= 300) {
    const msg = res.data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// ── Pull (server → local cache) ──────────────────────────────────────────

/**
 * Differential pull — fetch all rows changed in any syncable table since
 * our last successful pull, then upsert them into local SQLite. Soft-
 * deletes (deleted_at IS NOT NULL) propagate so a row deleted on another
 * device is also dropped from this one.
 *
 * On the first run after a fresh install (no last_pull_at) the server
 * returns everything since 1970 — same shape as a full snapshot, just
 * delivered through the differential endpoint so the code path is one.
 *
 * After that, steady-state syncs return only what changed (typically 0-5
 * rows) and run cheaply enough that the App.svelte 30-second periodic
 * scheduler doesn't drain battery.
 */
export async function pullSnapshot(silent = false) {
  if (!isNative || !getServerUrl()) return { ok: false, reason: 'not native+server' };
  if (_syncing) return { ok: false, reason: 'already syncing' };
  _syncing = true;
  if (!silent) syncState.update(s => ({ ...s, syncing: true, phase: 'pulling', progress: 'Pulling changes…', error: null }));
  const started = Date.now();
  const result = { ok: true, tables: {}, errors: [] };

  try {
    // Use the previous pull's server_time as `since` (server gives us a
    // monotonic timestamp on every response). Fall back to last_pull_at
    // for installs that synced under the old snapshot path; fall back
    // again to epoch for cold installs.
    const since =
      (await getSyncMeta('last_server_time')) ||
      (await getSyncMeta('last_pull_at')) ||
      '1970-01-01T00:00:00.000Z';
    _dlog('[sync] pullSnapshot since=', since);

    let pull;
    try {
      pull = await _serverFetch('GET', `/api/sync/pull?since=${encodeURIComponent(since)}`);
    } catch (e) {
      console.warn('[sync] /api/sync/pull failed:', e.status, e.message);
      if (e.status === 401) await _handleSyncAuthError();
      result.errors.push(['pull', e.message]);
      result.ok = false;
      return result;
    }

    // Apply each table's diff. SQLite-side: DELETE soft-deleted rows by id,
    // INSERT OR REPLACE everything else. Each upsert is O(1); the whole
    // pull is a small batch in steady state.
    await _applyExercises(pull.exercises, result);
    await _applyPrograms(pull.programs, result);
    await _applyTemplates(pull.workout_templates, result);
    await _applyAssignments(pull.program_assignments, result);
    await _applyWorkouts(pull.workout_log, result);
    // Option C (2026-08-11): apply server-side per-entry tombstones so a
    // delete performed on another device drops the matching items/sets
    // from the local workout rows here too. Runs AFTER _applyWorkouts
    // so it filters the freshly-mirrored rows in one pass.
    await _applyWorkoutTombstones(pull.workout_tombstones, result);
    await _applyBodyStats(pull.body_stats_log, result);
    await _applySettings(pull.user_settings, result);
    await _applyChat(pull.ai_chat_history, result);

    // Advance the watermark — next pull asks for everything after this
    // server-time. Falls back to the client clock if the server didn't
    // send one (older server build).
    if (pull.server_time) await setSyncMeta('last_server_time', pull.server_time);
    await setSyncMeta('last_pull_at', new Date().toISOString());
    await setSyncMeta('last_pull_duration_ms', String(Date.now() - started));
    result.durationMs = Date.now() - started;
    _dlog('[sync] pullSnapshot done', JSON.stringify(result.tables), `errors=${result.errors.length}`, `${result.durationMs}ms`);
    // Notify routes that a sync completed so they can refresh local-first
    // reads against the freshly-populated cache.
    try { window.dispatchEvent(new CustomEvent('lt:sync-complete', { detail: result })); } catch {}
    return result;
  } finally {
    _syncing = false;
    syncState.update(s => ({
      ...s,
      syncing:  false,
      phase:    '',
      progress: '',
      lastSync: result.ok ? new Date().toISOString() : s.lastSync,
      error:    result.ok ? null : 'Sync failed',
    }));
  }
}

// ── Per-table diff appliers ──────────────────────────────────────────────
// Each takes the array of changed rows and either upserts or deletes by id
// based on deleted_at. Tag every applied write 'clean' so sync_state stays
// truthful — the only 'pending' rows should be local writes the device
// hasn't pushed yet.
//
// Pending guard: before each INSERT OR REPLACE, skip rows that are still
// `sync_state='pending'` locally. Without this, a pull arriving while a
// local write is in-flight (or its retry is queued) clobbers the user's
// fresh edit with the server's pre-edit value. The bug is self-healing on
// the next pull once the server registers the edit, but until then the
// UI shows stale data and the user sees their input "disappear". NutriTrace
// hit the same shape (see NT's dbUpsertFromServer guard).

async function _localIsPending(table, idColumn, id) {
  if (id == null) return false;
  const rows = await dbQuery(
    `SELECT sync_state FROM ${table} WHERE ${idColumn} = ? LIMIT 1`,
    [id]
  );
  return rows[0]?.sync_state === 'pending';
}

async function _applyExercises(rows, result) {
  if (!rows?.length) { result.tables.exercises = 0; return; }
  for (const e of rows) {
    if (e.deleted_at) {
      await dbRun(`DELETE FROM exercises WHERE id = ?`, [e.id]);
      continue;
    }
    if (await _localIsPending('exercises', 'id', e.id)) continue;
    await dbRun(
      `INSERT OR REPLACE INTO exercises
         (id, name, category, primary_muscles, secondary_muscles, equipment,
          instructions, tips, img_url, gif_url, video_url,
          external_id, source, is_global, created_by, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
      [
        e.id, e.name, e.category || null,
        JSON.stringify(e.primary_muscles || []),
        JSON.stringify(e.secondary_muscles || []),
        JSON.stringify(e.equipment || []),
        e.instructions || null, e.tips || null,
        e.img_url || null, e.gif_url || null, e.video_url || null,
        e.external_id || null, e.source || 'custom',
        e.is_global ? 1 : 0, e.created_by || null,
        e.created_at || new Date().toISOString(),
        e.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.exercises = rows.length;
}

async function _applyPrograms(rows, result) {
  if (!rows?.length) { result.tables.programs = 0; return; }
  for (const p of rows) {
    if (p.deleted_at) { await dbRun(`DELETE FROM programs WHERE id = ?`, [p.id]); continue; }
    if (await _localIsPending('programs', 'id', p.id)) continue;
    await dbRun(
      `INSERT OR REPLACE INTO programs (id, name, description, goal, created_by, visibility, duration_weeks, advance_mode, on_complete, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
      [
        p.id, p.name, p.description || null, p.goal || 'general',
        p.created_by || null, p.visibility || 'private',
        p.duration_weeks ?? 1, p.advance_mode || 'sessions', p.on_complete || 'hold',
        p.created_at || new Date().toISOString(),
        p.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.programs = rows.length;
}

async function _applyTemplates(rows, result) {
  if (!rows?.length) { result.tables.templates = 0; return; }
  for (const t of rows) {
    if (t.deleted_at) { await dbRun(`DELETE FROM workout_templates WHERE id = ?`, [t.id]); continue; }
    if (await _localIsPending('workout_templates', 'id', t.id)) continue;
    await dbRun(
      `INSERT OR REPLACE INTO workout_templates (id, program_id, name, day_label, order_index, exercises, created_at, updated_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
      [
        t.id, t.program_id, t.name, t.day_label || null, t.order_index ?? 0,
        JSON.stringify(t.exercises || []),
        t.created_at || new Date().toISOString(),
        t.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.templates = rows.length;
}

async function _applyAssignments(rows, result) {
  if (!rows?.length) { result.tables.assignments = 0; return; }
  for (const a of rows) {
    if (a.deleted_at) { await dbRun(`DELETE FROM program_assignments WHERE id = ?`, [a.id]); continue; }
    await dbRun(
      `INSERT OR REPLACE INTO program_assignments (id, program_id, assigned_to, assigned_by, start_date, active, week_cursor, week_cursor_session_base, week_cursor_pinned_at, assigned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id, a.program_id, a.assigned_to, a.assigned_by || null,
        a.start_date || null, a.active ? 1 : 0,
        a.week_cursor ?? null, a.week_cursor_session_base ?? null, a.week_cursor_pinned_at || null,
        a.assigned_at || new Date().toISOString(),
        a.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.assignments = rows.length;
}

async function _applyWorkouts(rows, result) {
  if (!rows?.length) { result.tables.workouts = 0; return; }
  for (const w of rows) {
    if (w.deleted_at) {
      await dbRun(`DELETE FROM workout_log WHERE id = ?`, [w.id]);
      continue;
    }
    if (await _localIsPending('workout_log', 'id', w.id)) continue;
    await dbRun(
      `INSERT OR REPLACE INTO workout_log
         (id, user_id, date, template_id, program_id, name, exercises,
          notes, duration_min, completed, program_week, created_at, updated_at, sync_state)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
      [
        w.id, w.date, w.template_id || null, w.program_id || null,
        w.name || null,
        JSON.stringify(w.exercises || []),
        w.notes || null, w.duration_min ?? null,
        w.completed ? 1 : 0,
        w.program_week ?? null,
        w.created_at || new Date().toISOString(),
        w.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.workouts = rows.length;
}

/**
 * Apply server-side per-entry tombstones to the local mirror. For each
 * tombstone: (1) upsert into local workout_tombstones with
 * sync_state='clean' so it's not resent on the next push, (2) drop
 * the matching exercise or set from that date's workout_log row so
 * the UI reflects the deletion immediately without waiting for a
 * subsequent write. Runs after _applyWorkouts so it filters rows the
 * pull just refreshed.
 */
async function _applyWorkoutTombstones(rows, result) {
  if (!rows?.length) { result.tables.workoutTombstones = 0; return; }
  const byDate = new Map();
  for (const t of rows) {
    if (!t || !t.date || !t.kind || !t.uuid) continue;
    await dbRun(
      `INSERT INTO workout_tombstones (user_id, date, kind, ex_uuid, uuid, deleted_at, sync_state)
       VALUES (1, ?, ?, ?, ?, ?, 'clean')
       ON CONFLICT(user_id, date, kind, ex_uuid, uuid) DO UPDATE SET
         deleted_at = excluded.deleted_at, sync_state = 'clean'`,
      [t.date, t.kind, t.ex_uuid || '', t.uuid, t.deleted_at || new Date().toISOString()]
    );
    // Only exercise/set kinds filter the daily workout row locally;
    // template tombstones affect a separate table.
    if (t.kind !== 'exercise' && t.kind !== 'set') continue;
    const g = byDate.get(t.date) || { exUuids: new Set(), setsByEx: new Map() };
    if (t.kind === 'exercise') g.exUuids.add(t.uuid);
    else {
      const set = g.setsByEx.get(t.ex_uuid) || new Set();
      set.add(t.uuid);
      g.setsByEx.set(t.ex_uuid, set);
    }
    byDate.set(t.date, g);
  }
  for (const [date, g] of byDate) {
    const rows2 = await dbQuery(
      `SELECT id, exercises FROM workout_log WHERE user_id = 1 AND date = ?`,
      [date]
    );
    const row = rows2?.[0];
    if (!row) continue;
    let exercises;
    try { exercises = JSON.parse(row.exercises || '[]'); } catch { continue; }
    if (!Array.isArray(exercises)) continue;
    const filtered = [];
    for (const ex of exercises) {
      if (ex?.uuid && g.exUuids.has(ex.uuid)) continue; // drop whole exercise
      const setTombstones = g.setsByEx.get(ex?.uuid);
      if (setTombstones && Array.isArray(ex.sets)) {
        filtered.push({ ...ex, sets: ex.sets.filter(s => !s?.uuid || !setTombstones.has(s.uuid)) });
      } else {
        filtered.push(ex);
      }
    }
    await dbRun(
      `UPDATE workout_log SET exercises = ? WHERE id = ?`,
      [JSON.stringify(filtered), row.id]
    );
  }
  result.tables.workoutTombstones = rows.length;
}

async function _applyBodyStats(rows, result) {
  if (!rows?.length) { result.tables.bodyStats = 0; return; }
  for (const b of rows) {
    if (b.deleted_at) { await dbRun(`DELETE FROM body_stats_log WHERE id = ?`, [b.id]); continue; }
    if (await _localIsPending('body_stats_log', 'id', b.id)) continue;
    await dbRun(
      `INSERT OR REPLACE INTO body_stats_log (id, user_id, date, stats, updated_at, sync_state)
       VALUES (?, 1, ?, ?, ?, 'clean')`,
      [b.id, b.date, JSON.stringify(b.stats || {}), b.updated_at || new Date().toISOString()]
    );
  }
  result.tables.bodyStats = rows.length;
}

async function _applySettings(rows, result) {
  if (!rows?.length) { result.tables.settings = 0; return; }
  // Lazy-import DB so the sync module doesn't pull the localStorage helper
  // into every consumer that just needs sync state types.
  const { DB } = await import('./db.js');
  for (const s of rows) {
    if (!s.key) continue;
    // Same pending guard as the other appliers but keyed on (user_id, key).
    const localRows = await dbQuery(
      `SELECT sync_state FROM user_settings WHERE user_id = 1 AND key = ? LIMIT 1`,
      [s.key]
    );
    if (localRows[0]?.sync_state === 'pending') continue;
    await dbRun(
      `INSERT INTO user_settings (user_id, key, value, updated_at, sync_state)
       VALUES (1, ?, ?, ?, 'clean')
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_state = 'clean'`,
      [s.key, s.value ?? null, s.updated_at || new Date().toISOString()]
    );
    // ALSO write to localStorage + dispatch the wl:setting event so
    // running Svelte stores update without a full reload. Without this
    // step, e.g. radioStations added on PWA only became visible on
    // Android after a force-restart, because the in-memory store kept
    // its localStorage-loaded value while the sync was quietly updating
    // local SQLite in the background.
    try {
      let parsedValue = s.value;
      if (typeof parsedValue === 'string') {
        // user_settings stores values as JSON strings (matches server
        // settings table). Parse so DB.setSetting receives the real
        // value the store will reactively re-emit.
        try { parsedValue = JSON.parse(parsedValue); } catch { /* leave as raw string */ }
      }
      DB.setSetting(s.key, parsedValue);
      window.dispatchEvent(new CustomEvent('wl:setting', { detail: { key: s.key } }));
    } catch { /* DOM unavailable (non-browser test) — fine */ }
  }
  result.tables.settings = rows.length;
}

async function _applyChat(rows, result) {
  if (!rows?.length) { result.tables.chat = 0; return; }
  for (const c of rows) {
    if (c.deleted_at) { await dbRun(`DELETE FROM ai_chat_history WHERE id = ?`, [c.id]); continue; }
    await dbRun(
      `INSERT OR REPLACE INTO ai_chat_history (id, user_id, role, content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [c.id, c.role, c.content, c.created_at || new Date().toISOString(), c.updated_at || new Date().toISOString()]
    );
  }
  result.tables.chat = rows.length;
}

// ── Push queue (failed writes → retry) ────────────────────────────────────

/**
 * Enqueue a write that failed against the server. Replayed on reconnect by
 * flushQueue(). Called by apiFetch.js when a fetch throws or returns 5xx.
 */
export async function enqueueWrite(method, path, body) {
  await dbRun(
    `INSERT INTO sync_queue (table_name, row_id, operation, payload)
     VALUES (?, NULL, ?, ?)`,
    [path, method, JSON.stringify({ method, path, body: body == null ? null : body })]
  );
}

/**
 * Replay every queued write against the server. On HTTP 4xx the entry is
 * dropped (request was malformed — retrying won't help). On 5xx / network
 * error the attempts counter increments and the entry stays.
 */
export async function flushQueue() {
  if (!isNative || !getServerUrl()) return { ok: false, reason: 'not native+server' };
  if (_flushing) return { ok: false, reason: 'already flushing' };
  _flushing = true;
  const result = { attempted: 0, succeeded: 0, dropped: 0, retained: 0 };

  try {
    const rows = await dbQuery(
      `SELECT id, payload, attempts FROM sync_queue ORDER BY id ASC LIMIT 200`,
      []
    );
    _dlog('[sync] flushQueue', rows.length, 'queued writes');
    for (const row of rows) {
      result.attempted++;
      let payload;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      if (!payload?.method || !payload?.path) {
        await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        result.dropped++;
        continue;
      }
      try {
        await _serverFetch(payload.method, payload.path, payload.body);
        await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        result.succeeded++;
      } catch (e) {
        if (e.status === 401) {
          // Auth lost — clear local auth so the user re-signs-in, and
          // KEEP the queued write so it replays once they're back in.
          // Stop the whole flush; the rest of the queue would just
          // 401 too and waste cycles.
          await _handleSyncAuthError();
          await dbRun(
            `UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            [String(e.message || e).slice(0, 500), row.id]
          );
          result.retained++;
          break;
        }
        if (e.status && e.status >= 400 && e.status < 500) {
          // Permanent failure — drop so it doesn't block forever.
          await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
          result.dropped++;
        } else {
          await dbRun(
            `UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            [String(e.message || e).slice(0, 500), row.id]
          );
          result.retained++;
        }
      }
    }
    return result;
  } finally {
    _flushing = false;
  }
}

// ── Convenience: pull + flush ─────────────────────────────────────────────

export async function runSync() {
  const flush = await flushQueue();
  const pull = await pullSnapshot();
  return { flush, pull };
}

/**
 * Full sync — flush pending writes then pull diff. `silent=true` skips the
 * UI status spinner (used by the periodic 30-second scheduler so the user
 * doesn't see a constant blinking sync bar). Throws on hard failure so
 * App.svelte can surface a toast if needed.
 */
export async function fullSync(silent = false, forceCheck = false, showFailureBanner = false) {
  if (!isNative || !getServerUrl()) return { ok: false, reason: 'not native+server' };
  // Server-reachability probe before the heavy push/pull. `forceCheck`
  // bypasses the circuit breaker; `showFailureBanner` opts into the
  // smart connection banner if the probe fails.
  const online = await checkOnline(forceCheck, showFailureBanner);
  if (!online) return { ok: false, reason: 'offline' };
  if (!silent) syncState.update(s => ({ ...s, syncing: true, phase: 'pushing', progress: 'Pushing changes…', error: null }));
  const flush = await flushQueue();
  const pull = await pullSnapshot(silent);
  // Clear connection state + error on a successful round so a stale
  // banner from a prior failure doesn't linger once the issue is
  // resolved.
  if (pull?.ok !== false) {
    syncState.update(s => ({
      ...s, error: null, online: true,
      connectionIssue: null, showErrorBanner: false,
    }));
  } else if (showFailureBanner) {
    syncState.update(s => ({ ...s, showErrorBanner: true }));
  }
  return { flush, pull };
}

/**
 * Wire `online` event + page-visibility change to flush the queue + pull
 * automatically when the device reconnects or the user comes back to the app.
 */
export function startBackgroundSync() {
  if (!isNative || !getServerUrl()) return;

  const trigger = () => { runSync().catch(() => {}); };

  // Browser online/offline events feed the compact hamburger cloud
  // badge immediately, even before the next scheduled probe fires.
  // Without the 'offline' half, syncState.online stays optimistically
  // true until the next fetch fails, so the badge would lag.
  window.addEventListener('online', () => {
    syncState.update(s => ({ ...s, online: true }));
    trigger();
  });
  window.addEventListener('offline', () => {
    syncState.update(s => ({ ...s, online: false }));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') trigger();
  });

  // First sync 1 second after boot — gives the UI time to render.
  setTimeout(trigger, 1000);
}

/** Read-only sync status for the Settings UI. */
export async function getSyncStatus() {
  if (!isNative) return null;
  const lastAt = await getSyncMeta('last_pull_at');
  const lastMs = await getSyncMeta('last_pull_duration_ms');
  const queue = await dbQuery(`SELECT COUNT(*) AS c FROM sync_queue`, []);
  return {
    lastPullAt: lastAt,
    lastPullDurationMs: lastMs ? Number(lastMs) : null,
    queueSize: queue[0]?.c ?? 0,
    syncing: _syncing,
    flushing: _flushing,
  };
}
