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
import { dbQuery, dbRun, dbExec, getSyncMeta, setSyncMeta } from './db-native.js';
import { LtApiNative } from './api-native.js';
import { isTempId, createdId, describeOp, writeOp, newTempId } from './offline-edits.js';
import { localDataIsThisAccount } from './local-account.js';
import { accountGen, nextAccountGen, copyMoving } from './account-gen.js';

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
  // Queued changes the server refused when they were replayed, as
  // { what, reason }, for App.svelte to tell the person once.
  refused:  [],
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
  const _probeStartedAt = Date.now();
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
    // `name` is the field that tells these apart: a deadline we set reports
    // TimeoutError/"signal timed out", while a DNS, TLS or CORS failure reports
    // TypeError/"Failed to fetch" whatever the real cause. The elapsed time
    // separates a fast refusal from a request that hung until the OS killed it.
    console.warn(`[sync] server unreachable: host=${issue.host} network=${issue.connectionType} after=${Date.now() - _probeStartedAt}ms name=${error?.name || 'Error'} error=${error?.message || String(error)}`);
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
// Bumped when what a pull guarantees changes; a device on an older one
// pulls everything again, once.
const _PULL_SCHEME = '2';

// ── Whose data this is ───────────────────────────────────────────────────
// The local copy, its queue included, belongs to one account on one server
// (local-account.js). A sync runs only when that is the account whose
// session it carries, and reads the session once: a sign-out (and another
// account signing in) part way through never sends the rest of this
// account's queue under the next one's session.
let _roundToken = null;

// The copy changing hands (another account, Connect, Disconnect, sign-out:
// account-gen.js) stops a sync part way. Each send or pull notes the number
// as it starts and checks it before writing anything here, and a request
// still out is given up on at once. Without this, a pull still downloading
// when another account signed in landed in that account's copy (and told it
// the full pull it needed was done).
let _roundGen = null;
const _alive = () => _roundGen == null || _roundGen === accountGen();
const _staleError = () => Object.assign(new Error('The account on this phone changed'), { name: 'AccountChanged', stale: true });
function _assertAlive() { if (!_alive()) throw _staleError(); }
let _switched = null;
function _switchSignal() {
  if (!_switched) {
    let reject;
    const promise = new Promise((_, r) => { reject = r; });
    promise.catch(() => {});
    _switched = { promise, reject };
  }
  return _switched.promise;
}

// ── Server fetch helper (uses CapacitorHttp to bypass WebView CORS) ──────

/**
 * Handle a 401 from any sync endpoint by clearing local auth state so
 * App.svelte's reactive gate sends the user to Login. Without this,
 * an expired JWT or rotated server-side JWT_SECRET puts sync into an
 * unwinnable retry loop. Mirrors the same fix in NT sync.js
 * (commit d1e8217) and CT (commit c4d6334).
 */
async function _handleSyncAuthError() {
  // Signed out: no sync until someone signs in again (the queue waits for
  // this account), and the server's cookie can't stand in for the session.
  try { (await import('./account-gen.js')).markSignedOut(true); } catch { /* none */ }
  try { await (await import('./local-account.js')).forgetServerCookies(); } catch { /* none */ }
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

let _pullDownload = null;

async function _serverFetch(method, path, body, token = _roundToken ?? getAuthToken(), extraHeaders = {}) {
  const url = getServerUrl();
  if (!url) throw new Error('No server configured');
  const { CapacitorHttp } = await import('@capacitor/core');
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Sends and pulls run one at a time, so a request that never answers
  // would hold every later sync (and sign-in, which waits for one). Each
  // gets a deadline. A pull can be large and the link slow: natively the
  // read deadline is the time without a byte arriving, so a download that
  // keeps moving is never cut off; the overall backstop here is only for
  // one that hangs without the native deadline noticing. The server
  // compresses the pull.
  const isPull = path.startsWith('/api/sync/pull');
  // (scripts/android-sync scales these down to test them in seconds)
  const scale = Number(globalThis.__ltDeadlineScale) || 1;
  const limit = (isPull ? 600000 : 30000) * scale;
  const opts = { url: url + path, headers, connectTimeout: 15000, readTimeout: isPull ? 60000 : 30000 };
  if (body != null) opts.data = body;
  const fn = method === 'GET' ? CapacitorHttp.get
          : method === 'POST' ? CapacitorHttp.post
          : method === 'PUT' ? CapacitorHttp.put
          : method === 'DELETE' ? CapacitorHttp.delete
          : CapacitorHttp.request;
  // A request given up on here still runs natively (it can't be cancelled
  // from here), so a pull never starts while an earlier one is still
  // downloading: they would stack on a slow link.
  if (isPull && _pullDownload) {
    throw Object.assign(new Error('An earlier sync is still downloading'), { name: 'Busy' });
  }
  const call = fn.call(CapacitorHttp, opts);
  if (isPull) {
    _pullDownload = call;
    call.then(() => {}, () => {}).finally(() => { if (_pullDownload === call) _pullDownload = null; });
  }
  let timer;
  const res = await Promise.race([
    call,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })), limit); }),
    _switchSignal(),
  ]).finally(() => clearTimeout(timer));
  if (res.status < 200 || res.status >= 300) {
    const msg = res.data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

/** A read straight from the server, never from this device's copy. */
export function serverGet(path) {
  return _serverFetch('GET', path);
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
export function pullSnapshot(silent = false) {
  if (!isNative || !getServerUrl()) return Promise.resolve({ ok: false, reason: 'not native+server' });
  return _exclusive(() => _pullSnapshot(silent));
}

async function _pullSnapshot(silent = false, token = getAuthToken(), gen = accountGen()) {
  if (_syncing) return { ok: false, reason: 'already syncing' };
  if (gen !== accountGen()) return { ok: false, reason: 'account_changed' };
  if (!(await localDataIsThisAccount(token))) return { ok: false, reason: 'other_account' };
  _syncing = true;
  _roundToken = token;
  _roundGen = gen;
  if (!silent) syncState.update(s => ({ ...s, syncing: true, phase: 'pulling', progress: 'Pulling changes…', error: null }));
  const started = Date.now();
  const result = { ok: true, tables: {}, errors: [] };

  try {
    // Issue #76: if db-native.js's multi-session schema rebuild failed on
    // this device (flagged rather than left half-applied — see
    // _migrateMultiSession's doc comment), force a full re-pull instead
    // of trusting the local mirror's watermark. A server-connected device
    // can always recover this way; only genuinely standalone (no server)
    // installs can't, which is exactly why db-native.js also backs up the
    // raw file before attempting that rebuild.
    if ((await getSyncMeta('schema_migration_v76_failed')) === '1') {
      await setSyncMeta('last_server_time', '');
      await setSyncMeta('last_pull_at', '');
      await setSyncMeta('schema_migration_v76_failed', '');
      console.warn('[sync] local schema migration (#76) had failed — forcing a full re-pull');
    }

    // Use the previous pull's server_time as `since` (server gives us a
    // monotonic timestamp on every response). Fall back to last_pull_at
    // for installs that synced under the old snapshot path; fall back
    // again to epoch for cold installs.
    //
    // Everything again, once, when a replayed change was refused (the
    // server's copy of what it refused comes back down), and once after
    // this version is installed: earlier versions handed out ids the
    // server also uses and left rows they had edited offline stuck on that
    // edit, so what such a device holds can't be trusted to be current.
    //
    // Rows an earlier pull left alone because a queued write was about to
    // change them are asked for again (since_floor), or one the write never
    // touched would be skipped past for good.

    // A copy from an earlier version: its ids are sorted out first (once).
    if (!(await _idsSettled())) {
      result.ok = false;
      result.errors.push(['ids', 'not sorted out yet']);
      return result;
    }
    // A floor held up for over an hour (a write the server keeps failing)
    // would make every pull bigger: let it go, and pull everything once the
    // queue has gone up instead.
    const queuedNow = (await dbQuery(`SELECT COUNT(*) AS n FROM sync_queue`, []))[0]?.n || 0;
    if ((await getSyncMeta('full_pull_when_drained')) === '1' && !queuedNow) {
      await setSyncMeta('full_pull', '1');
      await setSyncMeta('full_pull_when_drained', '');
    }
    const fullPull = (await getSyncMeta('full_pull')) === '1' || (await getSyncMeta('pull_scheme')) !== _PULL_SCHEME;
    let since = fullPull ? '1970-01-01T00:00:00.000Z' :
      (await getSyncMeta('last_server_time')) ||
      (await getSyncMeta('last_pull_at')) ||
      '1970-01-01T00:00:00.000Z';
    const floor = await getSyncMeta('since_floor');
    const floorAge = floor ? Date.parse(_sqlTime(since).replace(' ', 'T') + 'Z') - Date.parse(_sqlTime(floor).replace(' ', 'T') + 'Z') : 0;
    if (floor && floorAge > 3600 * 1000) {
      await setSyncMeta('since_floor', '');
      await setSyncMeta('full_pull_when_drained', '1');
    } else if (floor && _sqlTime(floor) < _sqlTime(since)) since = floor;
    _dlog('[sync] pullSnapshot since=', since);

    let pull;
    try {
      // A full pull of a copy that holds rows (pulled again on purpose): the
      // server then also says what was deleted, which it leaves out of a
      // first pull.
      let held = '';
      if (since.startsWith('1970')) {
        const n = (await dbQuery(`SELECT (SELECT COUNT(*) FROM programs WHERE id > 0) + (SELECT COUNT(*) FROM workout_log WHERE id > 0) + (SELECT COUNT(*) FROM exercises WHERE id > 0 AND COALESCE(is_global, 0) = 0) AS n`, []))[0]?.n || 0;
        if (n) held = '&held=1';
      }
      const sentAt = Date.now();
      pull = await _serverFetch('GET', `/api/sync/pull?since=${encodeURIComponent(since)}${held}`);
      if (pull?.server_time) _noteServerClock(pull.server_time, sentAt);
    } catch (e) {
      result.ok = false;
      if (e.stale || !_alive()) { result.reason = 'account_changed'; return result; }
      console.warn('[sync] /api/sync/pull failed:', e.status, e.message);
      if (e.status === 401) await _handleSyncAuthError();
      result.errors.push(['pull', e.message]);
      return result;
    }
    // Signed in as someone else while it downloaded: none of it is theirs.
    if (!_alive()) { result.ok = false; result.reason = 'account_changed'; return result; }

    // Apply each table's diff. SQLite-side: DELETE soft-deleted rows by id,
    // INSERT OR REPLACE everything else. Each upsert is O(1); the whole
    // pull is a small batch in steady state. Rows a queued write is still
    // on its way to change are left alone (see _queuedTargets).
    const guard = await _queuedTargets();
    let skippedFrom = null;
    guard.skip = (ts) => { const t = _sqlTime(ts || '1970-01-01 00:00:00'); if (skippedFrom == null || t < skippedFrom) skippedFrom = t; };
    try {
      await _applyPull(pull, result, guard);
      _assertAlive();
    } catch (e) {
      // The copy changed hands part way (every row checks first): stop, and
      // leave the pull cursor alone; the copy is the next account's now.
      if (!e?.stale) throw e;
      result.ok = false;
      result.reason = 'account_changed';
      return result;
    }

    // Advance the watermark — next pull asks for everything after this
    // server-time. Falls back to the client clock if the server didn't
    // send one (older server build).
    if (pull.server_time) await setSyncMeta('last_server_time', pull.server_time);
    await setSyncMeta('last_pull_at', new Date().toISOString());
    await setSyncMeta('since_floor', skippedFrom || '');
    if (fullPull) {
      await setSyncMeta('full_pull', '');
      await setSyncMeta('pull_scheme', _PULL_SCHEME);
    }
    await setSyncMeta('last_pull_duration_ms', String(Date.now() - started));
    result.durationMs = Date.now() - started;
    _dlog('[sync] pullSnapshot done', JSON.stringify(result.tables), `errors=${result.errors.length}`, `${result.durationMs}ms`);
    // Notify routes that a sync completed so they can refresh local-first
    // reads against the freshly-populated cache.
    try { window.dispatchEvent(new CustomEvent('lt:sync-complete', { detail: result })); } catch {}
    return result;
  } finally {
    _syncing = false;
    _roundToken = null;
    _roundGen = null;
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
// Queued guard: before each INSERT OR REPLACE, skip rows that a queued
// write is still on its way to change. Without this, a pull arriving while
// a local write is waiting clobbers the user's fresh edit with the server's
// pre-edit value. This used to read the row's sync_state, which an offline
// edit set to 'pending' and nothing ever set back, so after one offline
// edit the row ignored every later change from the server. The queue is
// the truth: once the write has gone up (or been refused) the row follows
// the server again, and the write itself brings the row down in the next
// pull because it changed updated_at.

const _NO_GUARD = {
  programs: new Set(), workout_templates: new Set(), exercises: new Set(), reorder: new Set(),
  workoutDates: new Set(), bodyDates: new Set(), assignments: false, creates: false, skip() {},
};

// Server timestamps as comparable text, whichever format they arrive in.
const _sqlTime = (v) => String(v || '').replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '');

/** One pull's rows, table by table, into this device's copy. */
async function _applyPull(pull, result, guard) {
  await _applyExercises(pull.exercises, result, guard);
  await _applyPrograms(pull.programs, result, guard);
  await _applyTemplates(pull.workout_templates, result, guard);
  if (pull.solo_active !== undefined) await _applySoloActive(pull.solo_active, result, guard);
  else await _applyAssignments(pull.program_assignments, result, guard);
  await _applyWorkouts(pull.workout_log, result, guard);
  // Option C (2026-08-11): apply server-side per-entry tombstones so a
  // delete performed on another device drops the matching items/sets
  // from the local workout rows here too. Runs AFTER _applyWorkouts
  // so it filters the freshly-mirrored rows in one pass.
  await _applyWorkoutTombstones(pull.workout_tombstones, result);
  await _applyBodyStats(pull.body_stats_log, result, guard);
  await _applySettings(pull.user_settings, result, guard);
  await _applyChat(pull.ai_chat_history, result);
  // Rows the server deleted outright come in each table's list as
  // { id, deleted_at } (server db.js sync_deletions), applied above. Then
  // everything this account may no longer keep (unassigned, or never its
  // own). Servers before this send no keep list.
  await _applyKeep(pull.keep, result, guard);
  await _healAssignedPrograms(result);
}

// ── Rows that are this phone's own ───────────────────────────────────────
// A row this phone made on its own (standalone, after Disconnect, or
// offline) has an id below zero; one made standalone gets its id below zero
// when the copy becomes an account's (local-account.js), and what an Upload
// leaves behind gets one when it ends. A copy from an earlier version is
// sorted out once (_idsSettled). So an id above zero always means the
// server's row: a pull may write over it or delete it (unless a change made
// here is still on its way up), and never has to guess which row is which.
// Guessing (by when and by whom a row was made) used to split one row into
// two, and could take two rows for one.
//
// Moving rows to new ids is one transaction (dbExec): the ids, every row
// and queued write that names them, and settings kept per exercise, so a
// stop part way (the app killed, an error) leaves the copy as it was. It is
// a few dozen statements however big the account, not a few per row.

const _ID_TABLES = ['programs', 'workout_templates', 'exercises', 'workout_log', 'body_stats_log', 'cardio_log', 'program_assignments'];
// What a row holds, to tell whether it changed while disconnected (a time
// isn't enough: an edit in the same second keeps it).
const _CONTENT = {
  programs: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete', 'deleted_at'],
  workout_templates: ['program_id', 'name', 'day_label', 'order_index', 'exercises', 'deleted_at'],
  exercises: ['name', 'category', 'primary_muscles', 'secondary_muscles', 'equipment', 'instructions', 'tips', 'img_url', 'gif_url', 'video_url', 'load_type', 'set_type', 'deleted_at'],
  workout_log: ['date', 'name', 'exercises', 'notes', 'duration_min', 'completed', 'program_week', 'program_id', 'template_id', 'deleted_at'],
  body_stats_log: ['date', 'stats', 'deleted_at'],
  cardio_log: ['date', 'activity', 'duration_min', 'distance', 'distance_unit', 'avg_hr', 'notes', 'is_template'],
  program_assignments: ['program_id', 'active', 'week_cursor'],
};
const _contentOf = (t, alias = 'x') => `json_array(${_CONTENT[t].map(c => `${alias}.${c}`).join(', ')})`;
const _MARKED = ['programs', 'workout_templates', 'exercises', 'workout_log', 'body_stats_log'];

// Ids for rows made the phone's own in one go (Disconnect, a claim, the end
// of an Upload): below every id the clock hands out (newTempId is
// -(ms * 1000 + n): about -1.8e15 now, -5e15 not before 2128), a block per
// batch and a range per table inside it, so they stay unique across tables
// (_findLocal looks a row up by its id alone).
const _BLOCK_BASE = 5e15, _BLOCK = 1e12, _TABLE_RANGE = 1e11;
function _blockIdFor(block) {
  return (table, id) => (id > 0 && id < _TABLE_RANGE
    ? -(_BLOCK_BASE + block * _BLOCK + _ID_TABLES.indexOf(table) * _TABLE_RANGE + id)
    : newTempId());
}
async function _nextBlock() {
  return ((Number(await getSyncMeta('id_block')) || 0) % 4000) + 1;
}

/** A queued write with every id it names that `lookup(table, id)` moves
 *  (undefined: stays) put in the new terms. Only where it names that
 *  table's rows: 5 may be a program and an exercise both. */
function _remapPayload(p, lookup) {
  const out = { ...p };
  const to = (table, v) => {
    if (v == null || !Number.isFinite(Number(v))) return v;
    const n = lookup(table, Number(v));
    return n === undefined ? v : n;
  };
  const [base, q] = String(p.path || '').split('?');
  const isWorkout = _isWorkoutWrite(p);
  const SEG = { programs: 'programs', templates: 'workout_templates', exercises: 'exercises', cardio: 'cardio_log' };
  let path = base.replace(/^\/api\/(programs|templates|exercises|cardio)\/(-?\d+)(?=\/|$)/, (all, seg, id) => `/api/${seg}/${to(SEG[seg], id)}`);
  if (q) {
    const params = new URLSearchParams(q);
    if (isWorkout && params.has('id')) params.set('id', String(to('workout_log', params.get('id'))));
    path = `${path}?${params}`;
  }
  out.path = path;
  const made = _createdTable(p);
  if (out.localId != null && made) out.localId = to(made, out.localId);
  const b = p.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const body = { ...b };
    if (body.program_id != null) body.program_id = to('programs', body.program_id);
    if (body.template_id != null) body.template_id = to('workout_templates', body.template_id);
    if (/^\/api\/programs\/-?\d+\/reorder$/.test(base)) {
      for (const k of ['ids', 'order']) if (Array.isArray(body[k])) body[k] = body[k].map(v => to('workout_templates', v));
    }
    if (Array.isArray(body.exercises)) {
      body.exercises = body.exercises.map(e => (e && e.exercise_id != null ? { ...e, exercise_id: to('exercises', e.exercise_id) } : e));
    }
    if (_isExerciseSetting(p)) {
      body.value = _swapExerciseSetting(body.value, (id) => { const n = lookup('exercises', id); return n === undefined ? undefined : n; });
    }
    if (isWorkout && body.id != null) body.id = to('workout_log', body.id);
    out.body = body;
  }
  return out;
}

const _EX_JSON = (t) => `(CASE WHEN e.type = 'object' THEN CAST(json_extract(e.value, '$.exercise_id') AS INTEGER) END)`;

/**
 * The statements that move rows to new ids, with everything here that
 * names them. `maps`: { table: [[old, new], ...] }.
 */
async function _remapStatements(maps) {
  const S = [];
  const add = (statement, values = []) => S.push({ statement, values });
  const has = (t) => (maps[t]?.length || 0) > 0;
  add(`DELETE FROM id_remap`);
  for (const t of _ID_TABLES) {
    const pairs = maps[t] || [];
    for (let i = 0; i < pairs.length; i += 300) {
      const chunk = pairs.slice(i, i + 300);
      add(`INSERT INTO id_remap (tbl, old, new) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`, chunk.flatMap(([o, n]) => [t, o, n]));
    }
  }
  const ref = (t, col, of) => add(
    `UPDATE ${t} SET ${col} = (SELECT new FROM id_remap WHERE tbl = '${of}' AND old = ${t}.${col}) WHERE ${col} IN (SELECT old FROM id_remap WHERE tbl = '${of}')`
  );
  if (has('programs')) for (const t of ['workout_templates', 'workout_log', 'program_assignments']) ref(t, 'program_id', 'programs');
  if (has('workout_templates')) { ref('workout_log', 'template_id', 'workout_templates'); ref('coach_prescriptions', 'template_id', 'workout_templates'); }
  if (has('workout_log')) ref('workout_tombstones', 'workout_id', 'workout_log');
  if (has('exercises')) {
    for (const t of ['workout_log', 'workout_templates', 'coach_prescriptions']) {
      add(`UPDATE ${t} SET exercises = (
          SELECT json_group_array(CASE
            WHEN m.new IS NOT NULL THEN json_set(e.value, '$.exercise_id', m.new)
            WHEN e.type IN ('object', 'array') THEN json(e.value)
            ELSE e.value END)
          FROM json_each(${t}.exercises) e
          LEFT JOIN id_remap m ON m.tbl = 'exercises' AND m.old = ${_EX_JSON(t)})
        WHERE CASE WHEN json_valid(exercises) AND json_type(exercises) = 'array'
          THEN EXISTS (SELECT 1 FROM json_each(${t}.exercises) e JOIN id_remap m ON m.tbl = 'exercises' AND m.old = ${_EX_JSON(t)})
          ELSE 0 END`);
    }
  }
  for (const t of _ID_TABLES) {
    if (has(t)) add(`UPDATE ${t} SET id = (SELECT new FROM id_remap WHERE tbl = '${t}' AND old = ${t}.id) WHERE id IN (SELECT old FROM id_remap WHERE tbl = '${t}')`);
  }
  // Queued writes and settings kept per exercise: worked out here.
  const index = {};
  for (const t of _ID_TABLES) index[t] = new Map((maps[t] || []).map(([o, n]) => [Number(o), n]));
  const lookup = (t, id) => index[t]?.get(Number(id));
  for (const r of await dbQuery(`SELECT id, payload FROM sync_queue`, [])) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const next = _remapPayload(p, lookup);
    if (JSON.stringify(next) !== JSON.stringify(p)) add(`UPDATE sync_queue SET payload = ?, table_name = ? WHERE id = ?`, [JSON.stringify(next), next.path, r.id]);
  }
  if (has('exercises')) {
    for (const r of await dbQuery(`SELECT user_id, key, value FROM user_settings WHERE key IN (${_EXERCISE_SETTINGS.map(() => '?').join(', ')})`, _EXERCISE_SETTINGS)) {
      let v;
      try { v = JSON.parse(r.value); } catch { continue; }
      const moved = _swapExerciseSetting(v, (id) => lookup('exercises', id));
      if (JSON.stringify(moved) !== JSON.stringify(v)) add(`UPDATE user_settings SET value = ? WHERE user_id IS ? AND key = ?`, [JSON.stringify(moved), r.user_id, r.key]);
    }
  }
  return S;
}

/** Move rows to new ids, in one transaction with `extra` statements. */
async function _remapRows(maps, extra = []) {
  const stmts = [...await _remapStatements(maps), ...extra];
  await dbExec(stmts);
  return stmts.length;
}

/** Give one of this phone's rows an id of its own (below zero), with
 *  everything here that names it. */
async function _renumberRow(table, from, to = newTempId()) {
  await _remapRows({ [table]: [[Number(from), to]] });
  return to;
}

/** Ids of the rows that become this phone's own: `all` (Disconnect) every
 *  row the account had here but the library and the starter programs;
 *  otherwise the rows only this phone has. */
async function _ownPairs(all, block) {
  const idFor = _blockIdFor(block);
  const mine = all ? '' : ` AND COALESCE(sync_state, 'pending') = 'pending'`;
  // A row a queued write is about to change is the server's (one put back
  // in place with its change queued): never the phone's own.
  const named = all ? null : await _queuedRowIds();
  const sel = {
    programs: `SELECT id FROM programs WHERE id > 0${all ? ` AND NOT (created_by IS NULL AND visibility = 'shared')` : mine}`,
    exercises: `SELECT id FROM exercises WHERE id > 0 AND COALESCE(is_global, 0) = 0${mine}`,
    workout_log: `SELECT id FROM workout_log WHERE id > 0${mine}`,
    body_stats_log: `SELECT id FROM body_stats_log WHERE id > 0${mine}`,
    cardio_log: `SELECT id FROM cardio_log WHERE id > 0`,
    program_assignments: `SELECT id FROM program_assignments WHERE id > 0`,
  };
  const maps = {};
  for (const [t, sql] of Object.entries(sel)) {
    const ids = (await dbQuery(sql.replace('SELECT id', 'SELECT id, ' + (t === 'body_stats_log' ? 'date' : 'NULL AS date')), []))
      .filter(r => !named || !(named[t]?.has(Number(r.id)) || (t === 'body_stats_log' && named.bodyDates.has(r.date))))
      .map(r => Number(r.id));
    if (ids.length) maps[t] = ids.map(id => [id, idFor(t, id)]);
  }
  // A program's workouts go with it; at Disconnect, every workout but a
  // starter program's.
  const moving = new Set((maps.programs || []).map(([o]) => o));
  const days = (await dbQuery(`SELECT id, program_id, sync_state FROM workout_templates WHERE id > 0`, []))
    .filter(r => (all ? !(Number(r.program_id) > 0 && !moving.has(Number(r.program_id)))
      : (r.sync_state ?? 'pending') === 'pending' && !named.workout_templates.has(Number(r.id))))
    .map(r => Number(r.id));
  if (days.length) maps.workout_templates = days.map(id => [id, idFor('workout_templates', id)]);
  return maps;
}

/**
 * Every row this phone made on its own gets an id below zero. `all` (at
 * Disconnect): every row the account had here becomes the phone's own, so
 * it is kept, and an Upload to the next server sends it; the library and
 * starter programs stay as they are, and `origin` ({ inst, uid }) records
 * where each came from, so connecting back to that account puts them back
 * in place (relink). Otherwise (when the copy becomes an account's, and
 * after an Upload): the rows only this phone has. `extra` statements run
 * in the same transaction.
 */
export async function renumberLocalRows({ all = false, origin = null, extra = [] } = {}) {
  if (!isNative) return { rows: 0, statements: 0 };
  const block = await _nextBlock();
  const maps = await _ownPairs(all, block);
  const rows = Object.values(maps).reduce((n, p) => n + p.length, 0);
  const after = [];
  if (all) {
    for (const t of _MARKED) if (maps[t]?.length) after.push({ statement: `UPDATE ${t} SET sync_state = 'pending' WHERE id IN (SELECT new FROM id_remap WHERE tbl = ?)`, values: [t] });
  }
  if (origin) {
    for (const t of _ID_TABLES) {
      if (!maps[t]?.length) continue;
      after.push({
        statement: `INSERT OR REPLACE INTO row_origin (tbl, local_id, server_id, inst, uid, base)
          SELECT m.tbl, m.new, m.old, ?, ?, ${_contentOf(t)} FROM id_remap m JOIN ${t} x ON x.id = m.new WHERE m.tbl = ?`,
        values: [origin.inst, origin.uid == null ? null : String(origin.uid), t],
      });
    }
  }
  after.push({ statement: `INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('id_block', ?)`, values: [String(block)] });
  const statements = rows || extra.length ? await _remapRows(maps, [...after, ...extra]) : 0;
  if (rows) _dlog('[sync] rows made this phone\'s own:', rows, 'in', statements, 'statements');
  return { rows, statements };
}

// ── Back to the account Disconnect took them from ────────────────────────

/** Updates and deletes for rows changed or deleted while disconnected,
 *  addressed to the server's row. */
function _relinkWrite(t, r, sid) {
  const ex = (v) => _json(v, []);
  if (r.deleted_at) {
    if (t === 'programs') return ['DELETE', `/api/programs/${sid}`, null];
    if (t === 'workout_templates') return ['DELETE', `/api/templates/${sid}`, null];
    if (t === 'exercises') return ['DELETE', `/api/exercises/${sid}`, null];
    if (t === 'workout_log') return ['DELETE', `/api/workout/${r.date}?id=${sid}`, null];
    return null;
  }
  if (t === 'programs') return ['PUT', `/api/programs/${sid}`, { name: r.name, description: r.description, goal: r.goal, visibility: r.visibility,
    duration_weeks: r.duration_weeks, advance_mode: r.advance_mode, on_complete: r.on_complete }];
  if (t === 'workout_templates') return ['PUT', `/api/templates/${sid}`, { name: r.name, day_label: r.day_label, exercises: ex(r.exercises) }];
  if (t === 'exercises') return ['PUT', `/api/exercises/${sid}`, { name: r.name, category: r.category, primary_muscles: ex(r.primary_muscles),
    secondary_muscles: ex(r.secondary_muscles), equipment: ex(r.equipment), instructions: r.instructions, tips: r.tips, img_url: r.img_url,
    gif_url: r.gif_url, video_url: r.video_url, load_type: r.load_type, set_type: r.set_type }];
  if (t === 'workout_log') return ['PUT', `/api/workout/${r.date}`, { id: sid, name: r.name, notes: r.notes, duration_min: r.duration_min,
    completed: !!r.completed, program_week: r.program_week, program_id: r.program_id, template_id: r.template_id, exercises: ex(r.exercises) }];
  if (t === 'body_stats_log') return ['PUT', `/api/body-stats/${r.date}`, { stats: _json(r.stats, {}) }];
  if (t === 'cardio_log') return ['PUT', `/api/cardio/${sid}`, { date: r.date, activity: r.activity, duration_min: r.duration_min, distance: r.distance,
    distance_unit: r.distance_unit, avg_hr: r.avg_hr, notes: r.notes, is_template: !!r.is_template }];
  return null;
}

const _ORIGIN_MATCH = `o.inst IS ? AND (? IS NULL OR o.uid IS NULL OR o.uid = ?)`;
const _originArgs = (m) => [m.inst, m.uid == null ? null : String(m.uid), m.uid == null ? null : String(m.uid)];

/** What a copy holds that came from this account on this server (kept at
 *  Disconnect, unchanged or not): rows. */
export async function countFromOrigin(match) {
  if (!isNative || !match?.inst) return {};
  const out = {};
  for (const t of _ID_TABLES) {
    out[t] = new Set((await dbQuery(`SELECT o.local_id FROM row_origin o WHERE o.tbl = ? AND ${_ORIGIN_MATCH}`, [t, ..._originArgs(match)])).map(r => Number(r.local_id)));
  }
  return out;
}

/**
 * The copy is about to become `match`'s ({ inst, uid }: the account on
 * this server): rows it holds that Disconnect took from that same account
 * go back to the server's ids (unchanged ones as they were; changed ones
 * with the change queued as an update to the server's row, deleted ones
 * with the delete queued), and rows only this phone has get ids below
 * zero. One transaction, with `extra` statements.
 */
export async function adoptLocalCopy({ match = null, extra = [] } = {}) {
  if (!isNative) return { rows: 0, statements: 0 };
  const block = await _nextBlock();
  const maps = await _ownPairs(false, block);
  const writes = [], changed = {};
  if (match?.inst) {
    for (const t of _ID_TABLES) {
      const rows = await dbQuery(
        `SELECT x.*, o.server_id AS _sid, o.base AS _base, ${_contentOf(t)} AS _now FROM row_origin o JOIN ${t} x ON x.id = o.local_id WHERE o.tbl = ? AND ${_ORIGIN_MATCH}`,
        [t, ..._originArgs(match)]
      );
      if (!rows.length) continue;
      maps[t] = [...(maps[t] || []), ...rows.map(r => [Number(r.id), Number(r._sid)])];
      for (const r of rows) {
        const edited = r.deleted_at != null || String(r._now ?? '') !== String(r._base ?? '');
        if (!edited || t === 'program_assignments') continue;
        (changed[t] ||= []).push(Number(r._sid));
        const w = _relinkWrite(t, r, Number(r._sid));
        if (w) writes.push(w);
      }
    }
  }
  const index = {};
  for (const t of _ID_TABLES) index[t] = new Map((maps[t] || []).map(([o, n]) => [Number(o), n]));
  const lookup = (t, id) => index[t]?.get(Number(id));
  const after = [];
  for (const t of _MARKED) {
    if (!maps[t]?.length) continue;
    // Back at its server id: the server's row again, clean unless changed here.
    after.push({ statement: `UPDATE ${t} SET sync_state = 'clean' WHERE id IN (SELECT new FROM id_remap WHERE tbl = ? AND new > 0)`, values: [t] });
    const ids = changed[t] || [];
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      after.push({ statement: `UPDATE ${t} SET sync_state = 'pending' WHERE id IN (${chunk.map(() => '?').join(', ')})`, values: chunk });
    }
  }
  for (const [method, path, body] of writes) {
    const p = _remapPayload({ method, path, body }, lookup);
    after.push({ statement: `INSERT INTO sync_queue (table_name, row_id, operation, payload) VALUES (?, NULL, ?, ?)`, values: [p.path, method, JSON.stringify(p)] });
  }
  // Origins whose row has gone (put back, uploaded, deleted) are done with.
  for (const t of _ID_TABLES) after.push({ statement: `DELETE FROM row_origin WHERE tbl = ? AND local_id NOT IN (SELECT id FROM ${t})`, values: [t] });
  after.push({ statement: `INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('id_block', ?)`, values: [String(block)] });
  const rows = Object.values(maps).reduce((n, p) => n + p.length, 0);
  const statements = await _remapRows(maps, [...after, ...extra]);
  if (rows) _dlog('[sync] copy made ready for its server:', rows, 'rows,', writes.length, 'changes queued,', statements, 'statements');
  return { rows, statements, queued: writes.length };
}

// ── A copy from an earlier version ───────────────────────────────────────
// Earlier versions gave rows made offline the next number up (one the
// server may also use), queued their creates without saying which row they
// made, and left rows edited offline marked as changed for good. Once, with
// the server's list in hand:
//   - a row the server has under the same number, made at the same time, is
//     the server's row (clean again, unless a queued write is to change it);
//   - a queued create is linked to the row it made only when exactly one
//     row only this phone has matches its request exactly, and no other
//     create matches that row. Where it's ambiguous (two rows, or a row
//     edited since), those creates are dropped and each such row goes up
//     from what it holds now, once, so nothing is made twice and no edit
//     goes to the wrong row;
//   - any other row only this phone has gets an id below zero.
const _LEGACY_TABLES = ['programs', 'workout_templates', 'exercises', 'workout_log', 'body_stats_log'];

async function _idsSettled() {
  if ((await getSyncMeta('local_ids')) === '1') return true;
  try {
    const left = {};
    let count = 0;
    for (const table of _LEGACY_TABLES) {
      const global = table === 'exercises' ? ' AND COALESCE(is_global, 0) = 0' : '';
      left[table] = await dbQuery(`SELECT * FROM ${table} WHERE id > 0 AND sync_state = 'pending'${global}`, []);
      count += left[table].length;
    }
    const legacyCreates = (await dbQuery(`SELECT id, payload FROM sync_queue ORDER BY id ASC`, [])).some(r => {
      try { const p = JSON.parse(r.payload); return !!_createdTable(p) && (p.localId == null || !isTempId(p.localId)); } catch { return false; }
    });
    if (count || legacyCreates) {
      const pull = await _serverFetch('GET', `/api/sync/pull?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}`);
      _assertAlive();
      const theirs = {};
      for (const t of _LEGACY_TABLES) theirs[t] = new Map((pull?.[t] || []).map(r => [Number(r.id), r]));
      const isServers = (t, row) => { const s = theirs[t]?.get(Number(row.id)); return !!s && _sameRow(t, row, s); };
      await _linkLegacyCreates(isServers);
      await _joinUploadedCopies(pull, isServers);
      const queued = await _queuedTargets();
      for (const table of _LEGACY_TABLES) {
        for (const mine of await dbQuery(`SELECT * FROM ${table} WHERE id > 0 AND sync_state = 'pending'${table === 'exercises' ? ' AND COALESCE(is_global, 0) = 0' : ''}`, [])) {
          _assertAlive();
          if (isServers(table, mine)) {
            // The server's row, edited here: the server's again, unless a
            // queued write is still to change it.
            if (!_targetedBy(queued, table, mine)) await dbRun(`UPDATE ${table} SET sync_state = 'clean' WHERE id = ?`, [mine.id]);
          } else {
            await _renumberRow(table, mine.id);
          }
        }
      }
    }
    _assertAlive();
    await setSyncMeta('full_pull', '1');
    await setSyncMeta('local_ids', '1');
    return true;
  } catch (e) {
    _dlog('[sync] sorting out an earlier version\'s ids failed; tried again next sync', e?.message);
    return false;
  }
}

/** The server's row under the same number is the same row: same date (a
 *  logged workout or body stat), made at the same time, by the same
 *  account. Used once, for a copy from an earlier version. */
function _sameRow(table, mine, theirs) {
  const dated = table === 'workout_log' || table === 'body_stats_log';
  if (dated && mine.date !== theirs.date) return false;
  // Body stats are one row a day: the date says it. Anything else needs
  // the time it was made on both sides; without it, it's not the same row.
  if (table !== 'body_stats_log') {
    if (!mine.created_at || !theirs.created_at || _sqlTime(mine.created_at) !== _sqlTime(theirs.created_at)) return false;
  }
  if ((table === 'programs' || table === 'exercises') && (mine.created_by ?? null) !== (theirs.created_by ?? null)) return false;
  return true;
}

function _targetedBy(q, table, row) {
  if (table === 'programs') return q.programs.has(Number(row.id)) || q.reorder.has(Number(row.id));
  if (table === 'workout_templates') return q.workout_templates.has(Number(row.id));
  if (table === 'exercises') return q.exercises.has(Number(row.id));
  if (table === 'workout_log') return q.workoutDates.has(row.date);
  if (table === 'body_stats_log') return q.bodyDates.has(row.date);
  return false;
}

// What an earlier version's create made: the row api-native.js wrote for it
// (its defaults included). Only an exact match links a create to a row.
const _same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');
const _MADE_AS = {
  programs: (b, r) => _same(r.name, b.name) && _same(r.description, b.description || null) && _same(r.goal, b.goal || 'general')
    && _same(r.visibility, b.visibility || 'private') && _same(r.duration_weeks, b.duration_weeks ?? 1)
    && _same(r.advance_mode, b.advance_mode || 'sessions') && _same(r.on_complete, b.on_complete || 'hold'),
  workout_templates: (b, r) => _same(r.name, b.name) && _same(r.program_id, b.program_id) && _same(r.day_label, b.day_label || null)
    && JSON.stringify(_json(r.exercises, [])) === JSON.stringify(Array.isArray(b.exercises) ? b.exercises : []),
  exercises: (b, r) => _same(r.name, b.name) && _same(r.category, b.category || null) && _same(r.instructions, b.instructions || null),
  cardio_log: (b, r) => _same(r.activity, b.activity) && _same(r.date, b.date) && _same(r.duration_min, b.duration_min) && _same(r.notes, b.notes || null),
};
const _NAME_OF = { programs: 'name', workout_templates: 'name', exercises: 'name', cardio_log: 'activity' };

/** An earlier version's queued creates, matched to the rows they made. */
async function _linkLegacyCreates(isServers) {
  const queue = [];
  for (const r of await dbQuery(`SELECT id, payload FROM sync_queue ORDER BY id ASC`, [])) {
    try { queue.push({ id: r.id, p: JSON.parse(r.payload) }); } catch { /* left alone */ }
  }
  // Workouts: earlier versions noted the new workout's own (positive) id.
  for (const { id: qid, p } of queue) {
    if (_createdTable(p) !== 'workout_log' || p.localId == null || isTempId(p.localId)) continue;
    const row = (await dbQuery(`SELECT * FROM workout_log WHERE id = ? AND date = ? AND sync_state = 'pending'`, [Number(p.localId), workoutDateOf(p.path)]))[0];
    if (!row || isServers('workout_log', row)) continue;
    await _linkCreate(qid, 'workout_log', row);
  }
  // Programs first, so a day's program_id is in the same terms as its row.
  for (const table of ['programs', 'exercises', 'workout_templates', 'cardio_log']) {
    const fresh = [];
    for (const r of await dbQuery(`SELECT id, payload FROM sync_queue ORDER BY id ASC`, [])) {
      try { const p = JSON.parse(r.payload); if (_createdTable(p) === table && p.localId == null) fresh.push({ id: r.id, p }); } catch { /* left alone */ }
    }
    if (!fresh.length) continue;
    const state = table === 'cardio_log' ? '' : ` AND sync_state = 'pending'`;
    const rows = (await dbQuery(`SELECT * FROM ${table} WHERE id > 0${state} ORDER BY id ASC`, [])).filter(r => !isServers(table, r));
    const body = (c) => (c.p.body && typeof c.p.body === 'object' && !Array.isArray(c.p.body) ? c.p.body : {});
    const exact = new Map(fresh.map(c => [c.id, rows.filter(r => _MADE_AS[table](body(c), r))]));
    const takenBy = new Map();
    for (const c of fresh) for (const r of exact.get(c.id)) takenBy.set(r.id, (takenBy.get(r.id) || 0) + 1);
    const done = new Set();
    for (const c of fresh) {
      const m = exact.get(c.id);
      if (m.length === 1 && takenBy.get(m[0].id) === 1) {
        await _linkCreate(c.id, table, m[0]);
        done.add(c.id);
      }
    }
    // Ambiguous: rows only here with the same name as a create left over.
    const name = _NAME_OF[table];
    const linkedRows = new Set();
    for (const c of fresh) if (done.has(c.id)) linkedRows.add(exact.get(c.id)[0].id);
    const leftover = fresh.filter(c => !done.has(c.id));
    const alike = rows.filter(r => !linkedRows.has(r.id) && leftover.some(c => _same(r[name], body(c)[name])));
    if (!alike.length) continue;
    for (const c of leftover) if (alike.some(r => _same(r[name], body(c)[name]))) await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [c.id]);
    for (const r of alike) await _queueCreateFromRow(table, r);
  }
}

/**
 * Rows an earlier version made offline whose create already went up (it
 * never learned the server's id): the server's row with exactly the same
 * content, made by this account, that no other row here is, is that row.
 * The phone's copy goes, and whatever names it names the server's row.
 */
async function _joinUploadedCopies(pull, isServers) {
  const content = {
    programs: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete', 'created_by'],
    exercises: ['name', 'category', 'instructions', 'created_by'],
    workout_templates: ['name', 'day_label', 'program_id', 'exercises'],
  };
  for (const table of ['programs', 'exercises', 'workout_templates']) {
    const mine = (await dbQuery(`SELECT * FROM ${table} WHERE id > 0 AND sync_state = 'pending'`, [])).filter(r => !isServers(table, r));
    if (!mine.length) continue;
    const theirs = pull?.[table] || [];
    const val = (t, r, k) => (k === 'exercises' ? JSON.stringify(_json(r[k], [])) : r[k] ?? null);
    const like = (a, b) => content[table].every(k => String(val(table, a, k) ?? '') === String(val(table, b, k) ?? ''));
    for (const r of mine) {
      _assertAlive();
      const hits = theirs.filter(s => !s.deleted_at && like(r, s));
      const others = mine.filter(o => o !== r && hits.some(s => like(o, s)));
      if (hits.length !== 1 || others.length) continue;
      const sid = Number(hits[0].id);
      if (sid === Number(r.id)) continue;
      const stmts = (await _remapStatements({ [table]: [[Number(r.id), sid]] }))
        .filter(st => !st.statement.startsWith(`UPDATE ${table} SET id =`));
      stmts.push({ statement: `DELETE FROM ${table} WHERE id = ?`, values: [Number(r.id)] });
      await dbExec(stmts);
    }
  }
}

/** Link a queued create to its row: the row gets an id below zero, the
 *  create says so, and carries a key (made once, however often it's sent). */
async function _linkCreate(queueId, table, row) {
  _assertAlive();
  const to = await _renumberRow(table, row.id);
  const fresh = (await dbQuery(`SELECT payload FROM sync_queue WHERE id = ?`, [queueId]))[0];
  if (!fresh) return;
  let next;
  try { next = JSON.parse(fresh.payload); } catch { return; }
  next.localId = to;
  if (next.body && typeof next.body === 'object' && !Array.isArray(next.body) && !next.body.client_key
      && (table !== 'workout_log' || next.body.new_session)) {
    next.body = { ...next.body, client_key: `legacy:${table}:${row.id}:${row.created_at || ''}` };
  }
  await dbRun(`UPDATE sync_queue SET payload = ?, table_name = ? WHERE id = ?`, [JSON.stringify(next), next.path, queueId]);
}

/** A create for a row as it is now (an id below zero, a key): it goes up
 *  once, with what it holds. */
async function _queueCreateFromRow(table, row) {
  _assertAlive();
  const to = await _renumberRow(table, row.id);
  const r = (await dbQuery(`SELECT * FROM ${table} WHERE id = ?`, [to]))[0];
  if (!r) return;
  const key = `legacy:${table}:${row.id}:${row.created_at || ''}`;
  let req = null;
  if (table === 'programs') req = ['/api/programs', { name: r.name, description: r.description, goal: r.goal, visibility: r.visibility,
    duration_weeks: r.duration_weeks, advance_mode: r.advance_mode, on_complete: r.on_complete }];
  else if (table === 'workout_templates') req = ['/api/templates', { program_id: r.program_id, name: r.name, day_label: r.day_label,
    order_index: r.order_index, exercises: _json(r.exercises, []) }];
  else if (table === 'exercises') req = ['/api/exercises', { name: r.name, category: r.category, primary_muscles: _json(r.primary_muscles, []),
    secondary_muscles: _json(r.secondary_muscles, []), equipment: _json(r.equipment, []), instructions: r.instructions, tips: r.tips,
    load_type: r.load_type, set_type: r.set_type }];
  else if (table === 'cardio_log') req = ['/api/cardio', { date: r.date, activity: r.activity, duration_min: r.duration_min, distance: r.distance,
    distance_unit: r.distance_unit, avg_hr: r.avg_hr, notes: r.notes, is_template: !!r.is_template }];
  if (!req) return;
  const qid = await enqueueWrite('POST', req[0], { ...req[1], client_key: key });
  await noteQueuedLocalId(qid, to);
}

/** The rows queued writes act on, by id (a day's body stats by date). */
async function _queuedRowIds() {
  const out = { programs: new Set(), workout_templates: new Set(), exercises: new Set(), cardio_log: new Set(), workout_log: new Set(), body_stats_log: new Set(), bodyDates: new Set() };
  for (const r of await dbQuery(`SELECT payload FROM sync_queue`, [])) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const path = String(p?.path || '').split('?')[0];
    const m = path.match(/^\/api\/(programs|templates|exercises|cardio)\/(-?\d+)(?=\/|$)/);
    if (m) out[{ programs: 'programs', templates: 'workout_templates', exercises: 'exercises', cardio: 'cardio_log' }[m[1]]].add(Number(m[2]));
    const b = path.match(/^\/api\/body-stats\/(\d{4}-\d{2}-\d{2})$/);
    if (b) out.bodyDates.add(b[1]);
    if (_isWorkoutWrite(p)) { const id = _targetWorkoutId(p); if (id != null) out.workout_log.add(Number(id)); }
  }
  return out;
}

/** What the queued writes are about to change, for the pull to leave alone. */
async function _queuedTargets() {
  const t = {
    programs: new Set(), workout_templates: new Set(), exercises: new Set(), reorder: new Set(),
    workoutDates: new Set(), bodyDates: new Set(), assignments: false, creates: false,
  };
  let rows = [];
  try { rows = await dbQuery(`SELECT payload FROM sync_queue`, []); } catch { return t; }
  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const path = String(p?.path || '').split('?')[0];
    let m;
    if ((m = path.match(/^\/api\/programs\/(-?\d+)\/reorder$/))) t.reorder.add(Number(m[1]));
    else if (/^\/api\/programs\/(-?\d+\/(activate|week-cursor)|deactivate)$/.test(path)) t.assignments = true;
    else if ((m = path.match(/^\/api\/programs\/(-?\d+)$/))) t.programs.add(Number(m[1]));
    else if ((m = path.match(/^\/api\/templates\/(-?\d+)$/))) t.workout_templates.add(Number(m[1]));
    else if ((m = path.match(/^\/api\/exercises\/(-?\d+)$/))) t.exercises.add(Number(m[1]));
    else if ((m = path.match(/^\/api\/body-stats\/(\d{4}-\d{2}-\d{2})$/))) t.bodyDates.add(m[1]);
    else if (workoutDateOf(p.path)) t.workoutDates.add(workoutDateOf(p.path));
    if (p.method === 'POST' && /^\/api\/(programs|templates|exercises)$/.test(path)) t.creates = true;
  }
  return t;
}

async function _applyExercises(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.exercises = 0; return; }
  for (const e of rows) {
    _assertAlive();
    // A row deleted on the server goes here too, unless a change made here
    // is still on its way to it (that write comes first; the next pull
    // settles it). Same in every table below.
    if (guard.exercises.has(e.id)) { guard.skip(e.updated_at); continue; }
    if (e.deleted_at) {
      await dbRun(`DELETE FROM exercises WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [e.id]);
      continue;
    }
    await dbRun(
      `INSERT OR REPLACE INTO exercises
         (id, name, category, primary_muscles, secondary_muscles, equipment,
          instructions, tips, img_url, gif_url, video_url,
          external_id, source, is_global, created_by, created_at, updated_at,
          load_type, set_type, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
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
        // INSERT OR REPLACE rewrites the whole row, so any column left out
        // here is reset to its default on every pull. load_type used to be
        // missing, which silently cleared a library load type on Android
        // each sync; set_type (issue #89) would have gone the same way.
        e.load_type ?? null,
        e.set_type ?? null,
      ]
    );
  }
  result.tables.exercises = rows.length;
}

// Devices that pulled an assignment before the server learned to send the
// plan with it are left holding an assignment for a program they do not
// have, and no future differential pull mentions that assignment again.
// Repair it once per run: ask the server for any assigned program the
// device is missing, and store it with its workouts.
const _healedPrograms = new Set();

async function _healAssignedPrograms(result) {
  let orphans;
  try {
    orphans = await dbQuery(
      `SELECT a.program_id AS pid
         FROM program_assignments a
         LEFT JOIN programs p ON p.id = a.program_id
        WHERE p.id IS NULL AND a.program_id IS NOT NULL`
    );
  } catch { return; }
  if (!orphans?.length) return;

  for (const { pid } of orphans) {
    if (pid == null || _healedPrograms.has(pid)) continue;
    _healedPrograms.add(pid);
    try {
      const program = await _serverFetch('GET', `/api/programs/${pid}`);
      if (!program?.id) continue;
      await _applyPrograms([program], { tables: {} });
      if (program.templates?.length) {
        await _applyTemplates(program.templates, { tables: {} });
      }
      result.tables.programsHealed = (result.tables.programsHealed || 0) + 1;
      _dlog('[sync] healed assigned program', pid);
    } catch (e) {
      if (e?.stale) throw e;
      // A refusal (gone, or no longer ours) is an answer: stop asking. Any
      // other failure is the connection, so let the next pull try again
      // rather than failing this one over it.
      const status = e?.status;
      if (!(status >= 400 && status < 500)) _healedPrograms.delete(pid);
      _dlog('[sync] heal failed for program', pid, status, e?.message);
    }
  }
}

async function _applyPrograms(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.programs = 0; return; }
  for (const p of rows) {
    _assertAlive();
    if (guard.programs.has(p.id) || guard.reorder.has(p.id)) { guard.skip(p.updated_at); continue; }
    if (p.deleted_at) { await dbRun(`DELETE FROM programs WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [p.id]); continue; }
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

async function _applyTemplates(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.templates = 0; return; }
  for (const t of rows) {
    _assertAlive();
    if (guard.workout_templates.has(t.id) || guard.reorder.has(t.program_id)) { guard.skip(t.updated_at); continue; }
    if (t.deleted_at) { await dbRun(`DELETE FROM workout_templates WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [t.id]); continue; }
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

async function _applyAssignments(rows, result, guard = _NO_GUARD) {
  // A program started or a week moved offline is still on its way: the
  // server's rows are older than what this device shows. They come back
  // in the next pull, which the queued write itself causes.
  if (guard.assignments) {
    for (const a of rows || []) guard.skip(a.updated_at);
    result.tables.assignments = 0;
    return;
  }
  // A stand-in written offline (id below zero) gives way to the server's
  // row for the same program when it arrives (UNIQUE program, user).
  if (!rows?.length) { result.tables.assignments = 0; return; }
  for (const a of rows) {
    _assertAlive();
    if (a.deleted_at) { await dbRun(`DELETE FROM program_assignments WHERE id = ?`, [a.id]); continue; }
    // Stored as this device's one user (1), as workouts and body stats
    // are: api-native reads and writes assignments for user 1, so the
    // account's real id here meant an athlete other than the first account
    // never saw their active program on the phone, and a program started
    // offline stayed active beside the server's choice.
    await dbRun(
      `INSERT OR REPLACE INTO program_assignments (id, program_id, assigned_to, assigned_by, start_date, active, week_cursor, week_cursor_session_base, week_cursor_pinned_at, assigned_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id, a.program_id, a.assigned_by || null,
        a.start_date || null, a.active ? 1 : 0,
        a.week_cursor ?? null, a.week_cursor_session_base ?? null, a.week_cursor_pinned_at || null,
        a.assigned_at || new Date().toISOString(),
        a.updated_at || new Date().toISOString(),
      ]
    );
  }
  result.tables.assignments = rows.length;
}

/**
 * A server without user accounts keeps the one program being followed (and
 * its pinned week) in its own settings, and sends it in full every pull.
 * This device's copy becomes exactly that, unless a start, stop or week
 * change made here is still on its way up.
 */
async function _applySoloActive(active, result, guard = _NO_GUARD) {
  if (guard.assignments) { result.tables.assignments = 0; return; }
  _assertAlive();
  await dbRun(`DELETE FROM program_assignments`, []);
  const pid = Number(active?.program_id);
  if (Number.isSafeInteger(pid) && pid > 0) {
    await dbRun(
      `INSERT INTO program_assignments (id, program_id, assigned_to, active, week_cursor, week_cursor_session_base, week_cursor_pinned_at, assigned_at, updated_at)
       VALUES (?, ?, 1, 1, ?, ?, ?, NULL, ?)`,
      [newTempId(), pid, active.week_cursor ?? null, active.week_cursor_session_base ?? null, active.week_cursor_pinned_at ?? null, new Date().toISOString()]
    );
  }
  result.tables.assignments = pid > 0 ? 1 : 0;
}

async function _applyWorkouts(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.workouts = 0; return; }
  for (let w of rows) {
    _assertAlive();
    // A row deleted outright arrives as its id alone: its day is the copy's.
    if (w.deleted_at && !w.date) w = { ...w, date: (await dbQuery(`SELECT date FROM workout_log WHERE id = ?`, [w.id]))[0]?.date };
    // That day's offline edits are still queued; once they have gone up,
    // reconcileWorkoutDate brings the day back in line with the server.
    if (guard.workoutDates.has(w.date)) { guard.skip(w.updated_at); continue; }
    if (w.deleted_at) {
      await dbRun(`DELETE FROM workout_log WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [w.id]);
      continue;
    }
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
  const byWorkout = new Map(); // key: `${date}::${workoutId}`
  for (const t of rows) {
    _assertAlive();
    if (!t || !t.date || !t.kind || !t.uuid) continue;
    const workoutId = t.workout_id || 0;
    await dbRun(
      `INSERT INTO workout_tombstones (user_id, date, workout_id, kind, ex_uuid, uuid, deleted_at, sync_state)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'clean')
       ON CONFLICT(user_id, date, workout_id, kind, ex_uuid, uuid) DO UPDATE SET
         deleted_at = excluded.deleted_at, sync_state = 'clean'`,
      [t.date, workoutId, t.kind, t.ex_uuid || '', t.uuid, t.deleted_at || new Date().toISOString()]
    );
    // Only exercise/set kinds filter a workout row locally; template
    // tombstones (workoutId 0, synthetic date) affect a separate table.
    if (t.kind !== 'exercise' && t.kind !== 'set') continue;
    const key = `${t.date}::${workoutId}`;
    const g = byWorkout.get(key) || { date: t.date, workoutId, exUuids: new Set(), setsByEx: new Map() };
    if (t.kind === 'exercise') g.exUuids.add(t.uuid);
    else {
      const set = g.setsByEx.get(t.ex_uuid) || new Set();
      set.add(t.uuid);
      g.setsByEx.set(t.ex_uuid, set);
    }
    byWorkout.set(key, g);
  }
  for (const g of byWorkout.values()) {
    _assertAlive();
    // workoutId scopes the tombstone to its own session (issue #82) so a
    // deletion on one same-day session never touches another; falls back
    // to a bare date lookup only for tombstones that predate the #76
    // migration's workout_id backfill (workoutId 0 with an exercise/set
    // kind should not normally occur post-backfill, but degrades safely
    // to the pre-#76 single-row-per-date behavior rather than dropping
    // the tombstone).
    const rows2 = g.workoutId
      ? await dbQuery(`SELECT id, exercises FROM workout_log WHERE user_id = 1 AND id = ? AND date = ?`, [g.workoutId, g.date])
      : await dbQuery(`SELECT id, exercises FROM workout_log WHERE user_id = 1 AND date = ?`, [g.date]);
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

async function _applyBodyStats(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.bodyStats = 0; return; }
  for (let b of rows) {
    _assertAlive();
    if (b.deleted_at && !b.date) b = { ...b, date: (await dbQuery(`SELECT date FROM body_stats_log WHERE id = ?`, [b.id]))[0]?.date };
    if (guard.bodyDates.has(b.date)) { guard.skip(b.updated_at); continue; }
    if (b.deleted_at) { await dbRun(`DELETE FROM body_stats_log WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [b.id]); continue; }
    // One only this device has, on the same date (made before it was
    // connected): both are kept. Where both have a number, the server's
    // stands (this device's may be an older edit it already sent); the
    // ones only this device has stay, and go up to be merged on the server
    // too. Written over, they were lost.
    const mine = (await dbQuery(
      `SELECT id, stats FROM body_stats_log WHERE user_id = 1 AND date = ? AND sync_state = 'pending'`,
      [b.date]
    ))[0];
    if (mine) {
      let local = {};
      try { local = JSON.parse(mine.stats || '{}') || {}; } catch { /* unreadable */ }
      const theirs = b.stats || {};
      const missing = Object.fromEntries(Object.entries(local).filter(([k, v]) => !(k in theirs) && v != null));
      await dbRun(`DELETE FROM body_stats_log WHERE id = ?`, [mine.id]);
      await dbRun(
        `INSERT OR REPLACE INTO body_stats_log (id, user_id, date, stats, updated_at, sync_state)
         VALUES (?, 1, ?, ?, ?, ?)`,
        [b.id, b.date, JSON.stringify({ ...local, ...theirs }), b.updated_at || new Date().toISOString(),
         Object.keys(missing).length ? 'pending' : 'clean']
      );
      if (Object.keys(missing).length) await enqueueWrite('PUT', `/api/body-stats/${b.date}`, { stats: missing });
      continue;
    }
    await dbRun(
      `INSERT OR REPLACE INTO body_stats_log (id, user_id, date, stats, updated_at, sync_state)
       VALUES (?, 1, ?, ?, ?, 'clean')`,
      [b.id, b.date, JSON.stringify(b.stats || {}), b.updated_at || new Date().toISOString()]
    );
  }
  result.tables.bodyStats = rows.length;
}

/**
 * Setting keys with a write still queued for the server (made offline).
 * Those local values are newer than anything the server can send back.
 */
export async function queuedSettingKeys() {
  const keys = new Set();
  if (!isNative) return keys;
  try {
    const rows = await dbQuery(`SELECT payload FROM sync_queue WHERE table_name LIKE '/api/settings%'`, []);
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload);
        if (p?.method !== 'PUT' || !p.body || typeof p.body !== 'object') continue;
        if (typeof p.body.key === 'string' && 'value' in p.body) keys.add(p.body.key);
        else for (const k of Object.keys(p.body)) keys.add(k);
      } catch { /* malformed row: flushQueue drops it */ }
    }
  } catch { /* no local DB yet */ }
  return keys;
}

async function _applySettings(rows, result, guard = _NO_GUARD) {
  if (!rows?.length) { result.tables.settings = 0; return; }
  // Lazy-import DB so the sync module doesn't pull the localStorage helper
  // into every consumer that just needs sync state types.
  const { DB } = await import('./db.js');
  const { isRecentlyChanged } = await import('../stores/settings.js');
  // Skip a key only while this device's own change is still on its way:
  // queued offline, or just edited and not yet saved. The local row's
  // sync_state is not used for this. Settings reach the server through
  // the write queue, not /sync/push, so nothing ever cleared 'pending'
  // and one offline edit blocked every later change to that setting from
  // the web.
  const queued = await queuedSettingKeys();
  for (const s of rows) {
    _assertAlive();
    if (!s.key) continue;
    if (queued.has(s.key) || isRecentlyChanged(s.key)) { guard.skip(s.updated_at); continue; }
    // Deleted on the server: back to its default here too.
    if (s.deleted_at) {
      await dbRun(`DELETE FROM user_settings WHERE key = ?`, [s.key]);
      try {
        DB.removeSetting(s.key);
        window.dispatchEvent(new CustomEvent('wl:setting', { detail: { key: s.key } }));
      } catch { /* DOM unavailable */ }
      continue;
    }
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
    _assertAlive();
    if (c.deleted_at) { await dbRun(`DELETE FROM ai_chat_history WHERE id = ?`, [c.id]); continue; }
    await dbRun(
      `INSERT OR REPLACE INTO ai_chat_history (id, user_id, role, content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [c.id, c.role, c.content, c.created_at || new Date().toISOString(), c.updated_at || new Date().toISOString()]
    );
  }
  result.tables.chat = rows.length;
}

// ── Rows deleted on the server ───────────────────────────────────────────

const _posIds = (ids) => (Array.isArray(ids) ? ids.map(Number).filter(n => Number.isSafeInteger(n) && n > 0) : []);

/**
 * Programs and workout days this account may keep, in full, from the
 * server. Any other one this device got from the server goes: deleted,
 * unassigned, or one of the days older servers handed every phone. Rows
 * only this device has (ids below zero) stay, and so does one with a change
 * made here still on its way up. Missing ones are fetched.
 */
const _healedTemplates = new Set();
async function _applyKeep(keep, result, guard = _NO_GUARD) {
  if (!keep || !Array.isArray(keep.programs) || !Array.isArray(keep.workout_templates)) return;
  const programs = new Set(_posIds(keep.programs));
  const days = new Set(_posIds(keep.workout_templates));
  let dropped = 0;
  // A create from an earlier version of the app may still be queued under
  // an id the server doesn't know yet; leave the lists alone until it's in.
  if (!guard.creates) {
    for (const { id } of await dbQuery(`SELECT id FROM programs WHERE id > 0 AND COALESCE(sync_state, 'clean') != 'pending'`, [])) {
      _assertAlive();
      if (programs.has(id) || guard.programs.has(id) || guard.reorder.has(id)) continue;
      await dbRun(`DELETE FROM programs WHERE id = ?`, [id]);
      await dbRun(`DELETE FROM program_assignments WHERE program_id = ?`, [id]);
      dropped++;
    }
    for (const { id, program_id } of await dbQuery(`SELECT id, program_id FROM workout_templates WHERE id > 0 AND COALESCE(sync_state, 'clean') != 'pending'`, [])) {
      _assertAlive();
      if (days.has(id) || guard.workout_templates.has(id) || guard.reorder.has(program_id)) continue;
      await dbRun(`DELETE FROM workout_templates WHERE id = ?`, [id]);
      dropped++;
    }
  }
  result.tables.dropped = dropped;

  // Anything listed but missing here: a day prescribed by a coach that
  // didn't change itself, or one an older version skipped. A few per pull.
  const haveP = new Set((await dbQuery(`SELECT id FROM programs`, [])).map(r => r.id));
  const haveT = new Set((await dbQuery(`SELECT id FROM workout_templates`, [])).map(r => r.id));
  let budget = 25;
  for (const id of programs) {
    if (haveP.has(id) || _healedPrograms.has(id) || budget <= 0) continue;
    budget--;
    _healedPrograms.add(id);
    try {
      const program = await _serverFetch('GET', `/api/programs/${id}`);
      if (!program?.id) continue;
      await _applyPrograms([program], { tables: {} }, guard);
      if (program.templates?.length) await _applyTemplates(program.templates, { tables: {} }, guard);
      for (const t of program.templates || []) haveT.add(t.id);
      result.tables.programsHealed = (result.tables.programsHealed || 0) + 1;
    } catch (e) {
      if (e?.stale) throw e;
      if (!(e?.status >= 400 && e?.status < 500)) _healedPrograms.delete(id);
    }
  }
  for (const id of days) {
    if (haveT.has(id) || _healedTemplates.has(id) || budget <= 0) continue;
    budget--;
    _healedTemplates.add(id);
    try {
      const t = await _serverFetch('GET', `/api/templates/${id}`);
      if (!t?.id) continue;
      await _applyTemplates([t], { tables: {} }, guard);
      result.tables.templatesHealed = (result.tables.templatesHealed || 0) + 1;
    } catch (e) {
      if (e?.stale) throw e;
      if (!(e?.status >= 400 && e?.status < 500)) _healedTemplates.delete(id);
    }
  }
}

// ── Push queue (failed writes → retry) ────────────────────────────────────

/**
 * Enqueue a write that failed against the server. Replayed on reconnect by
 * flushQueue(). Called by apiFetch.js when a fetch throws or returns 5xx.
 */
// Offline writes being queued right now (apiFetch.js _queueWrite: queue the
// request, apply it here, note the row it made). A sync reads the queue, or
// decides a row has no create of its own, only once none is half-way:
// caught between the steps, a row made offline was created on the server by
// the sync and again by its own queued create.
const _queueing = new Set();
// Writes marked half-way in this run of the app. One marked in an earlier
// run (the app stopped between the steps) never finishes: it goes as it is.
const _halfHere = new Set();
export function beginQueueWrite() {
  let done;
  const p = new Promise(r => { done = r; });
  _queueing.add(p);
  return () => { _queueing.delete(p); done(); };
}
// True once none is half-way; false if one still is after `ms` (a step that
// never answers): the caller then leaves alone what such a write may name.
async function _queueWritesIdle(ms = 5000) {
  if (!_queueing.size) return true;
  let timer;
  const gaveUp = new Promise(r => { timer = setTimeout(() => r(false), ms); });
  const idle = (async () => { while (_queueing.size) await Promise.all([..._queueing]); return true; })();
  try { return await Promise.race([idle, gaveUp]); } finally { clearTimeout(timer); }
}

/** The write is all the way in the queue (its row noted on it): a sync may
 *  send it. */
export async function settleQueuedWrite(queueId) {
  if (queueId == null) return;
  const row = (await dbQuery(`SELECT payload FROM sync_queue WHERE id = ?`, [queueId]))[0];
  if (!row) return;
  let p;
  try { p = JSON.parse(row.payload); } catch { return; }
  _halfHere.delete(Number(queueId));
  if (!p.half) return;
  delete p.half;
  await dbRun(`UPDATE sync_queue SET payload = ? WHERE id = ?`, [JSON.stringify(p), queueId]);
}

export async function enqueueWrite(method, path, body, edit = null) {
  const payload = { method, path, body: body == null ? null : body };
  if (edit?.editedAt) payload.editedAt = edit.editedAt;
  if (Array.isArray(edit?.changed)) payload.changed = edit.changed;
  if (edit?.half) payload.half = true;
  const r = await dbRun(
    `INSERT INTO sync_queue (table_name, row_id, operation, payload)
     VALUES (?, NULL, ?, ?)`,
    [path, method, JSON.stringify(payload)]
  );
  if (edit?.half && r?.lastId != null) _halfHere.add(Number(r.lastId));
  return r?.lastId ?? null;
}

// ── When an edit made offline was made, and what it changed ──────────────
// The server keeps the newer edit of each field (server/lib/newer-wins.js),
// so a queued edit says when it was made, on the server's clock (this
// device's clock corrected by the last difference seen in a pull), and
// which fields it changed against this device's copy. Without them the
// server took it as made when it arrived, and an edit made offline
// overwrote a later one made on the web.
const _CLOCK_KEY = 'lt:clockOffset';
// The server takes its time as the request arrives, so it's compared with
// when the request left here: never with when a long answer finished
// arriving, which would put this clock behind (and an edit made here just
// after a save of its own would look older than that save).
function _noteServerClock(serverTime, sentAt) {
  const ms = Date.parse(serverTime);
  if (!Number.isFinite(ms)) return;
  try { localStorage.setItem(_CLOCK_KEY, String(Math.round(ms - sentAt))); } catch { /* no storage */ }
}
export function serverNow() {
  let off = 0;
  try { off = Number(localStorage.getItem(_CLOCK_KEY)) || 0; } catch { /* no storage */ }
  return new Date(Date.now() + off).toISOString();
}

const _EDIT_FIELDS = {
  programs: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete'],
  workout_templates: ['name', 'day_label'],
  exercises: ['name', 'category', 'primary_muscles', 'secondary_muscles', 'equipment', 'instructions', 'tips', 'img_url', 'gif_url', 'video_url', 'load_type', 'set_type'],
  workout_log: ['name', 'notes', 'duration_min', 'completed', 'program_week', 'program_id', 'template_id'],
};
const _norm = (v) => {
  if (v === undefined || v === '') v = null;
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* text */ } }
  if (typeof v === 'boolean') v = v ? 1 : 0;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  return JSON.stringify(v ?? null);
};

/** Before an edit is queued: when it's made, and which fields it changes
 *  compared with this device's copy (null: can't tell, all it sends). */
export async function describeEdit(method, path, body) {
  const out = { editedAt: serverNow(), changed: null };
  if (method !== 'PUT' || !body || typeof body !== 'object' || Array.isArray(body)) return out;
  const p = String(path || '').split('?')[0];
  try {
    let m, row = null, table = null;
    if ((m = p.match(/^\/api\/(programs|templates|exercises)\/(-?\d+)$/))) {
      table = { programs: 'programs', templates: 'workout_templates', exercises: 'exercises' }[m[1]];
      row = (await dbQuery(`SELECT * FROM ${table} WHERE id = ?`, [Number(m[2])]))[0];
    } else if ((m = p.match(/^\/api\/body-stats\/(\d{4}-\d{2}-\d{2})$/))) {
      const r = (await dbQuery(`SELECT stats FROM body_stats_log WHERE date = ? AND deleted_at IS NULL`, [m[1]]))[0];
      if (!r || !body.stats || typeof body.stats !== 'object') return out;
      const mine = _json(r.stats, {});
      out.changed = Object.keys(body.stats).filter(k => _norm(body.stats[k]) !== _norm(mine[k]));
      return out;
    } else if (p === '/api/settings') {
      if (typeof body.key === 'string') out.changed = ['value'];
      return out;
    } else if (workoutDateOf(path)) {
      table = 'workout_log';
      const id = _targetWorkoutId({ path, body });
      row = id != null
        ? (await dbQuery(`SELECT * FROM workout_log WHERE id = ?`, [Number(id)]))[0]
        : (await dbQuery(`SELECT * FROM workout_log WHERE date = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1`, [workoutDateOf(path)]))[0];
    }
    if (!row || !table) return out;
    out.changed = _EDIT_FIELDS[table].filter(f => body[f] !== undefined && _norm(body[f]) !== _norm(row[f]));
  } catch { /* can't tell */ }
  return out;
}

const _editHeaders = (p) => {
  const h = {};
  if (p?.editedAt) h['X-Edited-At'] = p.editedAt;
  if (Array.isArray(p?.changed)) h['X-Changed-Fields'] = p.changed.join(',');
  return h;
};

/** A workout created offline got a device-side id; remember it on the
 *  queued write so the replay can swap it for the server's id (issue #102). */
export async function noteQueuedLocalId(queueId, localId) {
  if (queueId == null || localId == null) return;
  const row = (await dbQuery(`SELECT payload FROM sync_queue WHERE id = ?`, [queueId]))[0];
  if (!row) return;
  let payload;
  try { payload = JSON.parse(row.payload); } catch { return; }
  payload.localId = localId;
  await dbRun(`UPDATE sync_queue SET payload = ? WHERE id = ?`, [JSON.stringify(payload), queueId]);
}

// ── Workout cache after this device's own saves (issue #102) ───────────
//
// In server mode the Diary reads a workout from the device's copy first, but
// that copy used to change only when a pull brought the server's version
// down, and a pull skips rows marked 'pending'. An offline edit marks the row
// pending and nothing ever cleared it, so from then on the device kept its own
// stale copy of that workout. These keep the copy in step with the device's
// own saves: an online save writes the server's answer straight back, and once
// every queued offline write for a date has gone up, that date's rows are
// replaced with the server's.

const _WORKOUT_PATH = /^\/api\/workout\/(\d{4}-\d{2}-\d{2})(?:\?|$)/;

/** The workout date a queued or live request path writes to, if any. */
export function workoutDateOf(path) {
  const m = _WORKOUT_PATH.exec(String(path || ''));
  return m ? m[1] : null;
}

// Bumped whenever this device writes a date's workout rows itself. A
// server refresh of the date started before such a write is out of date by
// the time it answers, so it stands down instead of writing over it.
const _dateGen = new Map();
const _bumpDate = (date) => _dateGen.set(date, (_dateGen.get(date) || 0) + 1);

async function _queuedWorkoutDates() {
  const dates = new Set();
  const rows = await dbQuery(`SELECT table_name FROM sync_queue WHERE table_name LIKE '/api/workout/%'`, []);
  for (const r of rows) { const d = workoutDateOf(r.table_name); if (d) dates.add(d); }
  return dates;
}

async function _writeServerWorkout(w) {
  if (!w?.id || !w.date) return;
  if (w.deleted_at) { await dbRun(`DELETE FROM workout_log WHERE id = ? AND COALESCE(sync_state, 'clean') != 'pending'`, [w.id]); return; }
  await dbRun(
    `INSERT OR REPLACE INTO workout_log
       (id, user_id, date, template_id, program_id, name, exercises,
        notes, duration_min, completed, program_week, session_seq, created_at, updated_at, sync_state)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean')`,
    [
      w.id, w.date, w.template_id || null, w.program_id || null,
      w.name || null,
      JSON.stringify(Array.isArray(w.exercises) ? w.exercises : _parseMaybe(w.exercises)),
      w.notes || null, w.duration_min ?? null,
      w.completed ? 1 : 0,
      w.program_week ?? null,
      w.session_seq ?? 0,
      w.created_at || new Date().toISOString(),
      w.updated_at || new Date().toISOString(),
    ]
  );
}
function _parseMaybe(v) { try { return JSON.parse(v || '[]'); } catch { return []; } }

/** The workout session a queued workout write targets: body id, or ?id=. */
function _targetWorkoutId(payload) {
  const b = payload?.body;
  if (b && typeof b === 'object' && b.id != null) return b.id;
  const q = String(payload?.path || '').split('?')[1];
  if (!q) return null;
  const id = new URLSearchParams(q).get('id');
  return id != null && id !== '' && Number.isFinite(Number(id)) ? Number(id) : null;
}

/** Point a queued workout write at the server's id, wherever it carries one. */
function _retargetWorkout(payload, serverId) {
  if (payload.body && typeof payload.body === 'object' && payload.body.id != null) {
    payload.body = { ...payload.body, id: serverId };
  }
  const [base, q] = String(payload.path || '').split('?');
  if (q) {
    const params = new URLSearchParams(q);
    if (params.has('id')) { params.set('id', String(serverId)); payload.path = `${base}?${params}`; }
  }
}

/** After an online save: store the server's copy, unless offline edits for
 *  that date are still waiting to go up (they will reconcile it instead). */
export async function mirrorSavedWorkout(date, workout, gen = accountGen()) {
  if (!isNative || !getServerUrl() || !workout?.id) return;
  if (gen !== accountGen() || copyMoving()) return;   // saved under the previous account
  if ((await _queuedWorkoutDates()).has(date)) return;
  _bumpDate(date);
  await _writeServerWorkout(workout);
}

/** After an online delete of a program, program workout or exercise: the
 *  server has deleted it, so this device's copy goes too. */
export async function forgetDeletedRow(path, gen = accountGen()) {
  if (!isNative || !getServerUrl() || gen !== accountGen() || copyMoving()) return;
  const m = String(path || '').split('?')[0].match(/^\/api\/(programs|templates|exercises)\/(\d+)$/);
  if (!m) return;
  const id = Number(m[2]);
  if (m[1] === 'programs') {
    await dbRun(`DELETE FROM workout_templates WHERE program_id = ?`, [id]);
    await dbRun(`DELETE FROM program_assignments WHERE program_id = ?`, [id]);
    await dbRun(`DELETE FROM programs WHERE id = ?`, [id]);
  } else {
    await dbRun(`DELETE FROM ${m[1] === 'templates' ? 'workout_templates' : 'exercises'} WHERE id = ?`, [id]);
  }
}

/** After an online delete: drop that session from the device copy (the
 *  given id, or the date's first session when none was named, as the server
 *  resolves it). Local only; reconcileWorkoutDate follows it up. */
export async function forgetDeletedWorkout(date, id, gen = accountGen()) {
  if (!isNative || !getServerUrl() || !date || gen !== accountGen() || copyMoving()) return;
  if ((await _queuedWorkoutDates()).has(date)) return;
  _bumpDate(date);
  if (id != null && Number.isFinite(id)) {
    await dbRun(`DELETE FROM workout_log WHERE id = ? AND date = ?`, [id, date]);
    return;
  }
  const first = (await dbQuery(
    `SELECT id FROM workout_log WHERE user_id = 1 AND date = ? AND deleted_at IS NULL ORDER BY session_seq ASC, id ASC LIMIT 1`,
    [date]
  ))[0];
  if (first) await dbRun(`DELETE FROM workout_log WHERE id = ?`, [first.id]);
}

/** Replace a date's local rows with the server's sessions, once nothing for
 *  that date is left in the write queue. Also removes a session created
 *  offline under a device-side id, which the server stored under its own. */
export async function reconcileWorkoutDate(date, drop = [], acct = _roundGen ?? accountGen()) {
  if (!isNative || !getServerUrl() || !date) return false;
  if (acct !== accountGen() || copyMoving()) return false;
  if ((await _queuedWorkoutDates()).has(date)) return false;
  // A save made while the request was out (online, already written here) is
  // newer than that answer, so ask again; the next answer includes it. An
  // offline save made meanwhile is still queued, so the device copy stays.
  let sessions = null;
  for (let attempt = 0; attempt < 3 && sessions == null; attempt++) {
    const gen = _dateGen.get(date) || 0;
    const data = await _serverFetch('GET', `/api/workout/${date}/sessions`);
    // Another account's copy now: the answer was the previous one's.
    if (acct !== accountGen() || copyMoving()) return false;
    if ((await _queuedWorkoutDates()).has(date)) return false;
    if ((_dateGen.get(date) || 0) === gen) sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  }
  if (sessions == null) return false;   // still changing; the next sync tries again
  // Server rows first, then drop the local ones it doesn't have, so a failure
  // part way can't leave the day missing on the device.
  for (const w of sessions) await _writeServerWorkout(w);
  const keep = sessions.map(w => Number(w.id)).filter(Number.isFinite);
  // Rows only this device has (made before it was connected, never sent)
  // stay; `drop` names this device's rows the replay just replaced or the
  // server refused.
  await dbRun(
    `DELETE FROM workout_log WHERE user_id = 1 AND date = ?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}
        AND (COALESCE(sync_state, 'clean') != 'pending'${drop.length ? ` OR id IN (${drop.map(() => '?').join(',')})` : ''})`,
    [date, ...keep, ...drop]
  );
  return true;
}

// ── Rows made offline: device ids to server ids ─────────────────────────
//
// A row made here offline has an id below zero (api-native.js _newId). When
// its create goes up, the server's id is remembered here, every write still
// queued for it is pointed at the server's id, and so is this device's copy
// of the row and everything that refers to it. Kept a while, so a screen
// still showing the old id (and anything it sends) finds the row.

const _TEMP_KEEP_MS = 30 * 24 * 3600 * 1000;
let _tempIds = null;   // device id -> { id: server id, at, table }

async function _loadTempIds() {
  if (_tempIds) return _tempIds;
  const map = new Map();
  try {
    const now = Date.now();
    for (const [from, to, at, table] of JSON.parse((await getSyncMeta('temp_ids')) || '[]')) {
      if (now - at < _TEMP_KEEP_MS) map.set(Number(from), { id: Number(to), at, table: table || null });
    }
  } catch { /* none yet */ }
  _tempIds = map;
  return map;
}

async function _rememberTempId(from, to, table) {
  const map = await _loadTempIds();
  map.set(Number(from), { id: Number(to), at: Date.now(), table: table || null });
  await setSyncMeta('temp_ids', JSON.stringify([...map].map(([f, v]) => [f, v.id, v.at, v.table])));
}

const _idOf = (map, id) => map.get(Number(id))?.id;

/** True when a request names a row made here that the server doesn't have
 *  yet (an id below zero not yet swapped). Such a write can't go straight
 *  to the server: it waits in the queue behind that row's create. */
export async function namesUnsyncedRow(path, body) {
  const map = await _loadTempIds();
  const { targets, refs } = _namedIds({ path, body, method: 'PUT' });
  return [...targets, ...refs].some(id => isTempId(id) && !map.has(id));
}

// Where a queued write names a row: path segments (/api/programs/-5/...),
// a workout's ?id= or body id; and fields pointing at other rows.
const _isWorkoutWrite = (payload) => !!workoutDateOf(payload?.path);

function _pathIds(path) {
  const [base] = String(path || '').split('?');
  return [...base.matchAll(/\/(-?\d+)(?=\/|$)/g)].map(m => Number(m[1]));
}

// Settings kept per exercise, by its id: rest memory, remembered load and
// set types (maps), and favorites (a list). An exercise made offline is in
// them under its device id until it syncs.
const _EXERCISE_SETTINGS = ['restPerExercise', 'exerciseLoadTypes', 'exerciseSetTypes', 'favoriteExercises'];
const _isExerciseSetting = (payload) => String(payload?.path || '').split('?')[0] === '/api/settings'
  && payload?.body && typeof payload.body === 'object' && _EXERCISE_SETTINGS.includes(payload.body.key);

function _exerciseSettingIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (value && typeof value === 'object') return Object.keys(value).map(Number).filter(Number.isFinite);
  return [];
}

function _swapExerciseSetting(value, swap) {
  if (Array.isArray(value)) {
    return value.map(v => { const to = swap(Number(v)); return to === undefined ? v : to; }).filter(v => v != null);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const to = Number.isFinite(Number(k)) ? swap(Number(k)) : undefined;
      if (to === null) continue;
      out[to === undefined ? k : String(to)] = v;
    }
    return out;
  }
  return value;
}

/** This device's per-exercise settings follow an exercise to its server
 *  id, here and (through the usual settings save) on the server. `send`
 *  false: here only (an exercise given an id of this phone's own). */
async function _moveExerciseSettings(from, to, { send = true } = {}) {
  let DB, scheduleSave;
  try { ({ DB } = await import('./db.js')); ({ scheduleSave } = await import('../stores/settings.js')); } catch { return; }
  for (const key of _EXERCISE_SETTINGS) {
    const value = DB.getSetting(key, null);
    if (value != null) {
      const next = _swapExerciseSetting(value, (id) => (id === from ? to : undefined));
      if (JSON.stringify(next) !== JSON.stringify(value)) {
        DB.setSetting(key, next);
        if (send) { try { scheduleSave(key, next); } catch { /* saved locally */ } }
      }
    }
    if (send) continue;
    // The copy an Upload sends (user_settings) follows too.
    for (const r of await dbQuery(`SELECT user_id, value FROM user_settings WHERE key = ?`, [key])) {
      let stored;
      try { stored = JSON.parse(r.value); } catch { continue; }
      const moved = _swapExerciseSetting(stored, (id) => (id === from ? to : undefined));
      if (JSON.stringify(moved) !== JSON.stringify(stored)) {
        await dbRun(`UPDATE user_settings SET value = ? WHERE user_id IS ? AND key = ?`, [JSON.stringify(moved), r.user_id, key]);
      }
    }
  }
}

/** Every id this write names, by role: `targets` say which row it acts on,
 *  `refs` are rows it points at (a program, a day, an exercise). */
function _namedIds(payload) {
  const targets = _pathIds(payload.path);
  if (_isWorkoutWrite(payload)) {
    const id = _targetWorkoutId(payload);
    if (id != null) targets.push(Number(id));
  }
  const refs = [];
  const b = payload.body;
  if (_isExerciseSetting(payload)) refs.push(..._exerciseSettingIds(b.value));
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const k of ['program_id', 'template_id']) if (b[k] != null && Number.isFinite(Number(b[k]))) refs.push(Number(b[k]));
    for (const k of ['ids', 'order']) if (Array.isArray(b[k])) refs.push(...b[k].map(Number).filter(Number.isFinite));
    if (Array.isArray(b.exercises)) {
      for (const e of b.exercises) if (e && e.exercise_id != null && Number.isFinite(Number(e.exercise_id))) refs.push(Number(e.exercise_id));
    }
  }
  return { targets, refs };
}

/** The write with `swap(id)` applied to every id it names. swap returns the
 *  id to use, undefined to leave it, or null to clear a reference. */
function _swapIds(payload, swap) {
  const out = { ...payload };
  const [base, q] = String(payload.path || '').split('?');
  let path = base.replace(/\/(-?\d+)(?=\/|$)/g, (all, id) => {
    const to = swap(Number(id));
    return to != null ? `/${to}` : all;
  });
  if (q) {
    const params = new URLSearchParams(q);
    if (params.has('id') && _isWorkoutWrite(payload)) {
      const to = swap(Number(params.get('id')));
      if (to != null) params.set('id', String(to));
    }
    path = `${path}?${params}`;
  }
  out.path = path;
  const b = payload.body;
  if (_isExerciseSetting(payload)) {
    out.body = { ...b, value: _swapExerciseSetting(b.value, swap) };
    return out;
  }
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const body = { ...b };
    const one = (v) => { const to = swap(Number(v)); return to === undefined ? v : to; };
    if (_isWorkoutWrite(payload) && body.id != null) { const to = swap(Number(body.id)); if (to != null) body.id = to; }
    for (const k of ['program_id', 'template_id']) if (body[k] != null) body[k] = one(body[k]);
    for (const k of ['ids', 'order']) {
      if (Array.isArray(body[k])) body[k] = body[k].map(one).filter(v => v != null);
    }
    if (Array.isArray(body.exercises)) {
      body.exercises = body.exercises.map(e => (e && e.exercise_id != null ? { ...e, exercise_id: one(e.exercise_id) } : e));
    }
    out.body = body;
  }
  return out;
}

/** A request about to be made, with device ids already swapped for the
 *  server's: a screen opened before the swap still sends the old one. */
export async function swapKnownIds(path, body) {
  const map = await _loadTempIds();
  if (!map.size) return { path, body };
  const out = _swapIds({ path, body }, (id) => (isTempId(id) ? _idOf(map, id) : undefined));
  return { path: out.path, body: out.body };
}

// The table a create made its row in, by the address it went to.
function _createdTable(payload) {
  const path = String(payload.path || '').split('?')[0];
  if (payload.method === 'POST' && path === '/api/programs') return 'programs';
  if (payload.method === 'POST' && path === '/api/templates') return 'workout_templates';
  if (payload.method === 'POST' && path === '/api/exercises') return 'exercises';
  if (payload.method === 'POST' && path === '/api/cardio') return 'cardio_log';
  if (payload.method === 'PUT' && _isWorkoutWrite(payload)) return 'workout_log';
  return null;
}

/** This device's copy follows a row to the id the server gave it. */
async function _rekeyLocal(table, from, to) {
  if (!table || from === to) return;
  // A row already here under the server's id is the server's copy of this
  // same row (a pull brought it while the create's answer was lost); with
  // an edit made to it since, it is the newer one, so it stays and the
  // device's copy goes. Moved aside instead, it was a second copy for good.
  if (table === 'programs') {
    await dbRun(`UPDATE workout_templates SET program_id = ? WHERE program_id = ?`, [to, from]);
    await dbRun(`UPDATE workout_log SET program_id = ? WHERE program_id = ?`, [to, from]);
    // The server's assignment is already here: this one goes.
    await dbRun(
      `DELETE FROM program_assignments WHERE program_id = ?
          AND EXISTS (SELECT 1 FROM program_assignments b WHERE b.program_id = ? AND b.assigned_to = program_assignments.assigned_to)`,
      [from, to]
    );
    await dbRun(`UPDATE program_assignments SET program_id = ? WHERE program_id = ?`, [to, from]);
  } else if (table === 'workout_templates') {
    await dbRun(`UPDATE workout_log SET template_id = ? WHERE template_id = ?`, [to, from]);
  } else if (table === 'exercises') {
    for (const t of ['workout_log', 'workout_templates']) {
      for (const r of await dbQuery(`SELECT id, exercises FROM ${t} WHERE exercises LIKE ?`, [`%${from}%`])) {
        let list;
        try { list = JSON.parse(r.exercises || '[]'); } catch { continue; }
        if (!Array.isArray(list)) continue;
        let changed = false;
        for (const e of list) if (e && Number(e.exercise_id) === from) { e.exercise_id = to; changed = true; }
        if (changed) await dbRun(`UPDATE ${t} SET exercises = ? WHERE id = ?`, [JSON.stringify(list), r.id]);
      }
    }
    await _moveExerciseSettings(from, to);
  } else if (table === 'workout_log') {
    await dbRun(`UPDATE workout_tombstones SET workout_id = ? WHERE workout_id = ?`, [to, from]);
  }
  if ((await dbQuery(`SELECT 1 FROM ${table} WHERE id = ?`, [to])).length) {
    await dbRun(`DELETE FROM ${table} WHERE id = ?`, [from]);
  } else {
    await dbRun(`UPDATE ${table} SET id = ?${table === 'cardio_log' ? '' : `, sync_state = 'clean'`} WHERE id = ?`, [to, from]);
  }
}

/** A write to a program, a program's workout, an exercise or a day's body
 *  stats has gone up (or was refused): the row is the server's again, not
 *  this device's alone, so a pull may replace it and the keep list may
 *  drop it. */
async function _settled(payload) {
  const path = String(payload?.path || '').split('?')[0];
  let m;
  if ((m = path.match(/^\/api\/programs\/(\d+)\/reorder$/))) {
    await dbRun(`UPDATE workout_templates SET sync_state = 'clean' WHERE program_id = ?`, [Number(m[1])]);
  } else if ((m = path.match(/^\/api\/(programs|templates|exercises)\/(\d+)$/))) {
    const table = { programs: 'programs', templates: 'workout_templates', exercises: 'exercises' }[m[1]];
    await dbRun(`UPDATE ${table} SET sync_state = 'clean' WHERE id = ?`, [Number(m[2])]);
  } else if ((m = path.match(/^\/api\/body-stats\/(\d{4}-\d{2}-\d{2})$/))) {
    await dbRun(`UPDATE body_stats_log SET sync_state = 'clean' WHERE date = ?`, [m[1]]);
  }
}

/** A row made here whose create the server refused: it was never anywhere
 *  else, so it goes, with what only existed inside it. A workout stays to
 *  be brought in line with the server's day (reconcileWorkoutDate). */
async function _forgetLocal(table, id) {
  if (!table || id == null || table === 'workout_log') return;
  if (table === 'programs') {
    await dbRun(`DELETE FROM workout_templates WHERE program_id = ?`, [id]);
    await dbRun(`DELETE FROM program_assignments WHERE program_id = ?`, [id]);
    await dbRun(`UPDATE workout_log SET program_id = NULL WHERE program_id = ?`, [id]);
  } else if (table === 'workout_templates') {
    await dbRun(`UPDATE workout_log SET template_id = NULL WHERE template_id = ?`, [id]);
  }
  await dbRun(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

// ── Rows only this device has, named by a write ──────────────────────────

async function _hasQueuedCreate(id) {
  // One still half-way may be this row's own create: wait for it, and
  // treat the row as having one if it doesn't finish.
  if (!(await _queueWritesIdle())) return true;
  for (const r of await dbQuery(`SELECT payload FROM sync_queue WHERE payload LIKE ?`, [`%"localId":${Number(id)}%`])) {
    try { if (Number(JSON.parse(r.payload)?.localId) === Number(id)) return true; } catch { /* not this one */ }
  }
  return false;
}

// Where a row only this device has lives, by its id (ids below zero are
// unique across tables; they come from the clock).
const _ROW_TABLES = ['programs', 'workout_templates', 'exercises', 'workout_log', 'cardio_log'];
async function _findLocal(id) {
  for (const table of _ROW_TABLES) {
    const row = (await dbQuery(`SELECT * FROM ${table} WHERE id = ?`, [id]))[0];
    if (row) return { table, row };
  }
  return null;
}
const _json = (v, d) => { try { return v == null ? d : (typeof v === 'string' ? JSON.parse(v) : v); } catch { return d; } };

/**
 * A row only this device has (made before it was connected to this server
 * and moved out of the way of the server's row with that id, or one whose
 * create never went up) that a write now names: it is created on the server
 * first, like an offline create, under a key so a repeat makes one row.
 * Without this the write went up naming nothing and was dropped, and the
 * row (a logged workout, a program workout) went with it.
 * Answers 'ok', 'retry' (the connection) or 'gone' (refused, or no such row).
 */
async function _adopt(id, map, depth = 0, waiting = new Set()) {
  if (map.has(id)) return 'ok';
  if (waiting.has(id)) return 'retry';
  // Its own create was queued after this sync read the queue (made just
  // now): that create makes it, not this; made here too, it was two.
  if (await _hasQueuedCreate(id)) { waiting.add(id); return 'retry'; }
  if (depth > 3) return 'gone';
  const found = await _findLocal(id);
  if (!found) return 'gone';
  const { table, row } = found;
  const swapRef = async (v) => {
    if (v == null || !isTempId(Number(v))) return v ?? null;
    const r = await _adopt(Number(v), map, depth + 1, waiting);
    if (r === 'retry') throw Object.assign(new Error('retry'), { retry: true });
    return r === 'ok' ? _idOf(map, Number(v)) : null;
  };
  const exercisesOf = async (list) => {
    const out = [];
    for (const e of _json(list, [])) out.push(e && e.exercise_id != null ? { ...e, exercise_id: await swapRef(e.exercise_id) } : e);
    return out;
  };
  const key = `adopt:${id}:${row.created_at || ''}`;
  let req;
  try {
    if (table === 'programs') {
      req = ['POST', '/api/programs', { name: row.name, description: row.description, goal: row.goal, visibility: row.visibility,
        duration_weeks: row.duration_weeks, advance_mode: row.advance_mode, on_complete: row.on_complete, client_key: key }];
    } else if (table === 'workout_templates') {
      const pid = await swapRef(row.program_id);
      if (!pid) return 'gone';
      req = ['POST', '/api/templates', { program_id: pid, name: row.name, day_label: row.day_label, order_index: row.order_index,
        exercises: await exercisesOf(row.exercises), client_key: key }];
    } else if (table === 'exercises') {
      req = ['POST', '/api/exercises', { name: row.name, category: row.category, primary_muscles: _json(row.primary_muscles, []),
        secondary_muscles: _json(row.secondary_muscles, []), equipment: _json(row.equipment, []), instructions: row.instructions,
        tips: row.tips, img_url: row.img_url, gif_url: row.gif_url, video_url: row.video_url, load_type: row.load_type,
        set_type: row.set_type, client_key: key }];
    } else if (table === 'workout_log') {
      req = ['PUT', `/api/workout/${row.date}`, { new_session: true, name: row.name, notes: row.notes, duration_min: row.duration_min,
        completed: !!row.completed, program_week: row.program_week, program_id: await swapRef(row.program_id),
        template_id: await swapRef(row.template_id), exercises: await exercisesOf(row.exercises), client_key: key }];
    } else if (table === 'cardio_log') {
      req = ['POST', '/api/cardio', { date: row.date, activity: row.activity, duration_min: row.duration_min, distance: row.distance,
        distance_unit: row.distance_unit, avg_hr: row.avg_hr, notes: row.notes, is_template: !!row.is_template, client_key: key }];
    }
  } catch (e) { if (e.retry) return 'retry'; throw e; }
  if (!req) return 'gone';
  let sent;
  try { sent = await _serverFetch(...req); }
  catch (e) { return e.stale || _retryable(e.status) || e.status === 401 ? 'retry' : 'gone'; }
  if (!_alive()) return 'retry';
  const serverId = createdId(sent);
  if (serverId == null) return 'gone';
  await _rememberTempId(id, serverId, table);
  map.set(id, { id: serverId, at: Date.now(), table });
  await _rekeyLocal(table, id, serverId);
  if (table === 'programs') {
    for (const d of await dbQuery(`SELECT id FROM workout_templates WHERE program_id = ? AND sync_state = 'pending'`, [serverId])) {
      let dayId = d.id;
      // One whose own create is queued goes up with it, not twice.
      if (waiting.has(dayId) || await _hasQueuedCreate(dayId)) continue;
      if (!isTempId(dayId)) {
        // Only here, under this device's numbering: an id of its own first.
        dayId = await _renumberRow('workout_templates', dayId);
      }
      const r = await _adopt(dayId, map, depth + 1, waiting);
      if (r === 'retry') return 'retry';
    }
  }
  return 'ok';
}

// ── Refused writes ───────────────────────────────────────────────────────

/** A queued change in a few words, for telling someone the server refused
 *  it. The web app's descriptions (offline-edits.js), plus the program
 *  edits only this app can queue. */
export function describeQueued(payload) {
  const path = String(payload?.path || '').split('?')[0];
  const m = payload?.method;
  const name = payload?.body && typeof payload.body === 'object' && typeof payload.body.name === 'string' ? payload.body.name : null;
  if (path === '/api/programs' && m === 'POST') return name ? `the program "${name}"` : 'a program you added';
  if (/^\/api\/programs\/-?\d+$/.test(path)) return m === 'DELETE' ? 'deleting a program' : 'a program you changed';
  if (/^\/api\/programs\/-?\d+\/reorder$/.test(path)) return 'the order of a program\'s workouts';
  if (path === '/api/templates' && m === 'POST') return name ? `the program workout "${name}"` : 'a program workout you added';
  if (/^\/api\/templates\/-?\d+$/.test(path)) return m === 'DELETE' ? 'deleting a workout from a program' : 'a program workout you changed';
  if (path === '/api/exercises/custom/all' && m === 'DELETE') return 'deleting all your custom exercises';
  return describeOp({ ...(writeOp(m, payload?.path, payload?.body) || {}), path: payload?.path, body: payload?.body });
}

function _noteRefused(list) {
  if (!list.length) return;
  syncState.update(s => ({ ...s, refused: [...(s.refused || []), ...list] }));
}

/** Clear the refusals once they've been shown. */
export function forgetRefused() {
  syncState.update(s => ({ ...s, refused: [] }));
}

/** True when the server says it has no user accounts (single-user mode).
 *  No answer counts as false, so a real lost sign-in is never mistaken for
 *  a refusal. */
async function _serverHasNoAccounts() {
  try { return (await _serverFetch('GET', '/api/auth/status'))?.active === false; }
  catch { return false; }
}

// Will trying again help? A struggling (5xx), slow (408) or busy (429)
// server, yes. Any other answer is the server's considered one.
const _retryable = (status) => !status || status >= 500 || status === 408 || status === 429;

/**
 * Replay every queued write against the server, in order.
 *
 *   - A row made offline goes up first; writes that name it wait for it,
 *     then go up under the server's id (see _swapIds). A row only this
 *     device has that a write names is created first (see _adopt).
 *   - A write the server can't take now (network, 5xx, 408, 429) stays,
 *     and later writes to the same thing wait behind it.
 *   - A write the server refused (any other 4xx) is dropped, the person is
 *     told, and the next pull brings the server's copy back down in full,
 *     so what they see is what the server has. Writes to a row whose create
 *     was refused go with it. A delete of something already gone, and a
 *     create repeated after its row was deleted (410), are done quietly.
 */
export function flushQueue() {
  if (!isNative || !getServerUrl()) return Promise.resolve({ ok: false, reason: 'not native+server' });
  return _exclusive(() => _flushQueue());
}

async function _flushQueue(token = getAuthToken(), gen = accountGen()) {
  if (_flushing) return { ok: false, reason: 'already flushing' };
  if (gen !== accountGen()) return { ok: false, reason: 'account_changed', refused: [] };
  if (!(await localDataIsThisAccount(token))) return { ok: false, reason: 'other_account', refused: [] };
  _flushing = true;
  _roundToken = token;
  _roundGen = gen;
  const result = { attempted: 0, succeeded: 0, dropped: 0, retained: 0, refused: [] };
  const workoutDates = new Set();
  const dropWorkouts = [];          // this device's workout rows replaced or refused
  const map = await _loadTempIds();
  const swapped = new Map();        // this run's device id -> server id
  const waiting = new Set();        // device ids whose create hasn't gone up yet
  // Workouts created offline by earlier versions carry the device's own
  // (positive) ids; those are only ever swapped on workout writes, and
  // only dropped when their create was refused.
  const legacy = new Set();
  const refusedLegacy = new Set();
  // Writes to the same thing must reach the server in the order they were
  // made. Once one is kept for a retry, later writes to the same workout day
  // (or the same endpoint otherwise) wait behind it instead of overtaking it;
  // writes to anything else still go through.
  const orderKey = (path) => { const d = workoutDateOf(path); return d ? `workout:${d}` : String(path || '').split('?')[0]; };
  const blocked = new Set();

  try {
    // A copy from an earlier version: its ids are sorted out first (once).
    if (!(await _idsSettled())) { result.ok = false; return result; }
    await _queueWritesIdle();
    const rows = await dbQuery(
      `SELECT id, payload, attempts FROM sync_queue ORDER BY id ASC LIMIT 200`,
      []
    );
    _dlog('[sync] flushQueue', rows.length, 'queued writes');
    // A create whose server id was learned but whose rows here weren't
    // moved yet (the app stopped in between): finish moving them.
    for (const [from, v] of map) {
      if (!v.table || !isTempId(from)) continue;
      try {
        if ((await dbQuery(`SELECT 1 FROM ${v.table} WHERE id = ?`, [from])).length) await _rekeyLocal(v.table, from, v.id);
      } catch { /* tried again next time */ }
    }
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload);
        if (p?.localId != null) {
          waiting.add(Number(p.localId));
          if (!isTempId(p.localId)) legacy.add(Number(p.localId));
        }
      } catch { /* checked below */ }
    }
    for (const row of rows) {
      // The copy changed hands: what is left is the previous account's.
      if (!_alive()) break;
      result.attempted++;
      let payload;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      if (!payload?.method || !payload?.path) {
        await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        result.dropped++;
        continue;
      }
      // Still half-way into the queue (its row not yet noted on it): later.
      if (payload.half && _halfHere.has(Number(row.id))) {
        result.retained++;
        blocked.add(orderKey(payload.path));
        continue;
      }
      if (blocked.has(orderKey(payload.path))) {
        result.retained++;   // an earlier write to the same thing is still waiting
        continue;
      }
      const own = payload.localId != null ? Number(payload.localId) : null;
      const isWorkout = _isWorkoutWrite(payload);
      // Swap in the server ids already known. An earlier version's device
      // id is only ever the workout a workout write targets.
      payload = _swapIds(payload, (id) => {
        if (id === own) return undefined;
        if (isTempId(id)) return _idOf(map, id);
        return undefined;
      });
      if (isWorkout) {
        const bodyId = _targetWorkoutId(payload);
        if (bodyId != null && bodyId !== own && legacy.has(bodyId) && swapped.has(bodyId)) {
          _retargetWorkout(payload, swapped.get(bodyId));
        }
      }
      let { targets, refs } = _namedIds(payload);
      // A row only this device has that this write names: created on the
      // server first (see _adopt), then named by its server id.
      const strays = [...new Set([...targets, ...refs])].filter(id => id !== own && isTempId(id) && !waiting.has(id) && !map.has(id));
      let strayRetry = false;
      for (const id of strays) {
        if (!_alive()) break;
        const r = await _adopt(id, map, 0, waiting);
        if (r === 'retry') { strayRetry = true; break; }
        if (r === 'ok') swapped.set(id, _idOf(map, id));
      }
      if (strayRetry) {
        result.retained++;
        blocked.add(orderKey(payload.path));
        continue;
      }
      if (strays.length) {
        payload = _swapIds(payload, (id) => (id !== own && isTempId(id) ? _idOf(map, id) : undefined));
        ({ targets, refs } = _namedIds(payload));
      }
      const deviceTargets = targets.filter(id => id !== own && (isTempId(id) || (isWorkout && legacy.has(id))));
      const deviceRefs = refs.filter(id => isTempId(id));
      // Its row, or a row it points at, is still on its way up: wait.
      if ([...deviceTargets, ...deviceRefs].some(id => waiting.has(id))) {
        result.retained++;
        blocked.add(orderKey(payload.path));
        continue;
      }
      // A device id that is still below zero here was never swapped: its
      // create was refused (this run or an earlier one). An earlier
      // version's id is only unsendable when its create was refused; once
      // its create went up (the server may well have kept the same number)
      // it names the server's row.
      const unsendable = deviceTargets.filter(id => isTempId(id) || refusedLegacy.has(id));
      // A workout added to a program the server never got can't go up
      // either; it went with the program (already reported).
      const orphanDay = payload.method === 'POST' && String(payload.path).split('?')[0] === '/api/templates'
        && isTempId(Number(payload.body?.program_id));
      // Its row never reached the server (the create was refused): there is
      // nothing there to change.
      if (unsendable.length || orphanDay) {
        await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        result.dropped++;
        if (orphanDay && own != null) { waiting.delete(own); await _forgetLocal('workout_templates', own); }
        const wd = workoutDateOf(payload.path);
        if (wd) workoutDates.add(wd);
        continue;
      }
      // A reference to a row the server never got is cleared rather than
      // sent: the server would read the number as one of its own rows.
      if (deviceRefs.length) payload = _swapIds(payload, (id) => (isTempId(id) ? null : undefined));

      if (!_alive()) break;
      try {
        const sent = await _serverFetch(payload.method, payload.path, payload.body, undefined, _editHeaders(payload));
        // Gone up under the previous account; the copy is another's now.
        if (!_alive()) break;
        // Done with the queued write first, so a stop from here on can't
        // send it again (and creates carry a client_key besides).
        const serverId = own != null ? createdId(sent) : null;
        if (own != null && serverId != null && serverId !== own && isTempId(own)) {
          await _rememberTempId(own, serverId, _createdTable(payload));
        }
        await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        if (own != null) {
          waiting.delete(own);
          if (serverId != null && serverId !== own && _createdTable(payload) === 'workout_log') dropWorkouts.push(own);
          if (serverId != null && serverId !== own) {
            swapped.set(own, serverId);
            // Only a device id below zero is moved here: an earlier
            // version's id can be one a row pulled since already uses. Its
            // day is brought back in line with the server below instead.
            if (isTempId(own)) await _rekeyLocal(_createdTable(payload), own, serverId);
          }
        }
        result.succeeded++;
        await _settled(payload);
        const wd = workoutDateOf(payload.path);
        if (wd) workoutDates.add(wd);
      } catch (e) {
        if (e.stale || !_alive()) break;
        // On a server without user accounts there is no sign-in to lose: a
        // 401 there is the route's answer, so it is handled as a refusal
        // below. Treated as a lost sign-in, it signed this device out and
        // held every write queued after it, forever.
        if (e.status === 401 && !(await _serverHasNoAccounts())) {
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
        if ((e.status === 404 && payload.method === 'DELETE') || e.status === 410) {
          // Already gone (deleted on the web meanwhile, say): what was
          // asked for is done. 410: a create sent again whose row was
          // deleted since: nothing to make again, and nothing to keep here.
          if (e.status === 410 && own != null) {
            waiting.delete(own);
            if (isTempId(own)) await _forgetLocal(_createdTable(payload), own);
            if (_createdTable(payload) === 'workout_log') dropWorkouts.push(own);
          }
          await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
          result.succeeded++;
          await _settled(payload);
          const wdGone = workoutDateOf(payload.path);
          if (wdGone) workoutDates.add(wdGone);
        } else if (!_retryable(e.status)) {
          // The server's answer: retrying won't change it. Drop it, say so,
          // and bring the server's copy back down (a full pull, see
          // pullSnapshot), so nothing is left showing what isn't saved.
          await dbRun(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
          result.dropped++;
          const what = describeQueued(payload);
          const reason = e.message || `HTTP ${e.status}`;
          result.refused.push({ what, reason });
          // Also into the log behind Settings, Diagnostics: a toast lasts a
          // few seconds, and someone who looked away still deserves to know.
          console.error(`[sync] your server refused ${what}: ${reason} (${payload.method} ${String(payload.path).split('?')[0]})`);
          if (own != null) {
            waiting.delete(own);
            if (isTempId(own)) await _forgetLocal(_createdTable(payload), own);
            else refusedLegacy.add(own);
            if (_createdTable(payload) === 'workout_log') dropWorkouts.push(own);
          }
          await _settled(payload);
          // A program started or a week moved here is back to the server's.
          if (/^\/api\/programs\/(-?\d+\/(activate|week-cursor)|deactivate)$/.test(String(payload.path).split('?')[0])) {
            await dbRun(`DELETE FROM program_assignments WHERE id < 0`, []);
          }
          await setSyncMeta('full_pull', '1');
          const wdDropped = workoutDateOf(payload.path);
          if (wdDropped) workoutDates.add(wdDropped);
        } else {
          await dbRun(
            `UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            [String(e.message || e).slice(0, 500), row.id]
          );
          result.retained++;
          blocked.add(orderKey(payload.path));
        }
      }
    }
    if (!_alive()) { result.ok = false; result.reason = 'account_changed'; return result; }
    // Writes still queued (held back, or a failed retry) take the new ids.
    if (swapped.size) {
      for (const r of await dbQuery(`SELECT id, payload FROM sync_queue`, [])) {
        try {
          const p = JSON.parse(r.payload);
          const isW = _isWorkoutWrite(p);
          const own = p.localId != null ? Number(p.localId) : null;
          // Device ids below zero wherever they appear; an earlier version's
          // (positive) id only as the workout a workout write targets, never
          // as an exercise or program that happens to have that number.
          let next = _swapIds(p, (id) => (id !== own && isTempId(id) && swapped.has(id) ? swapped.get(id) : undefined));
          if (isW) {
            const target = _targetWorkoutId(next);
            if (target != null && target !== own && !isTempId(target) && legacy.has(target) && swapped.has(target)) {
              next = { ...next };
              _retargetWorkout(next, swapped.get(target));
            }
          }
          if (JSON.stringify(next) !== JSON.stringify(p)) {
            await dbRun(`UPDATE sync_queue SET payload = ?, table_name = ? WHERE id = ?`, [JSON.stringify(next), next.path, r.id]);
          }
        } catch { /* leave it */ }
      }
      // The Diary may still be showing that workout under the device id.
      try { window.dispatchEvent(new CustomEvent('lt:workout-ids', { detail: { map: [...swapped] } })); } catch { /* no window */ }
    }
    // Offline edits for these dates are now on the server (or were refused):
    // bring the device's copy back in line with it (issue #102).
    for (const d of workoutDates) {
      try { await reconcileWorkoutDate(d, dropWorkouts); } catch (e) { _dlog('[sync] reconcile failed', d, e?.message); }
    }
    _noteRefused(result.refused);
    return result;
  } finally {
    _flushing = false;
    _roundToken = null;
    _roundGen = null;
  }
}

/** The account changed (local-account.js cleared the copy): forget what
 *  this run remembered about the previous one's rows. */
export function forgetDeviceIds() {
  _tempIds = null;
  _healedPrograms.clear();
  _healedTemplates.clear();
}

// ── One sync at a time ───────────────────────────────────────────────────
// Sending and pulling used to run side by side: a second sync started while
// the first was still sending skipped the send (already running) and pulled
// right away, so a pull could land between a create going up and this
// device learning its server id, or bring back the server's copy of
// something still being sent. Now each send and pull waits for the one
// before it, and a sync asked for while another is waiting shares it.
let _chain = Promise.resolve();
function _exclusive(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

/** Resolves once the syncs running or waiting now have ended (or after
 *  `timeoutMs`, whichever comes first). */
export async function waitForSyncIdle(timeoutMs = 15000) {
  let timer;
  await Promise.race([_chain, new Promise(r => { timer = setTimeout(r, timeoutMs); })]);
  clearTimeout(timer);
}

/**
 * The phone's copy is about to change hands (another account signs in,
 * Connect, Disconnect, sign-out: local-account.js, stores/auth.js). A sync
 * running now stops writing to it at once, a request it has out is given
 * up on, and this waits for it to end before the copy is cleared or handed
 * over.
 */
export async function stopSyncForAccountChange(timeoutMs = 15000) {
  nextAccountGen();
  const s = _switched;
  _switched = null;
  s?.reject(_staleError());
  await waitForSyncIdle(timeoutMs);
}
let _waitingRound = null;
function _round(fn) {
  if (_waitingRound) return _waitingRound;
  const run = _exclusive(() => { _waitingRound = null; return fn(); });
  _waitingRound = run;
  return run;
}

/** One send-then-pull, the same answer for every caller that shares it:
 *  `ok` is false when the pull failed or the server refused a queued
 *  change (listed in `refused`). */
async function _syncRound(silent) {
  // The session as this round starts; every request in it carries this one,
  // and the copy it is for (see stopSyncForAccountChange).
  const token = getAuthToken();
  const gen = accountGen();
  // The phone still holds another account's data (a sign-in the app hasn't
  // finished checking): nothing is read, sent or fetched until App.svelte
  // has run the account check (local-account.js).
  if (!(await localDataIsThisAccount(token))) return { ok: false, reason: 'other_account', flush: null, pull: null, refused: [] };
  if (!silent) syncState.update(s => ({ ...s, syncing: true, phase: 'pushing', progress: 'Pushing changes…', error: null }));
  const flush = await _flushQueue(token, gen);
  const pull = await _pullSnapshot(silent, token, gen);
  if (gen !== accountGen()) return { ok: false, reason: 'account_changed', flush, pull, refused: [] };
  const refused = flush?.refused || [];
  return { ok: pull?.ok !== false && !refused.length, flush, pull, refused };
}

// ── Convenience: pull + flush ─────────────────────────────────────────────

export function runSync() {
  if (!isNative || !getServerUrl()) return Promise.resolve({ ok: false, reason: 'not native+server' });
  return _round(() => _syncRound(false));
}

/**
 * Full sync: flush pending writes, then pull the diff. `silent=true` skips
 * the UI status spinner (used by the periodic 30-second scheduler so the
 * user doesn't see a constant blinking sync bar). A call made while
 * another sync is waiting to start shares it, and still gets its own
 * banner handling.
 */
export async function fullSync(silent = false, forceCheck = false, showFailureBanner = false) {
  if (!isNative || !getServerUrl()) return { ok: false, reason: 'not native+server' };
  // Server-reachability probe before the heavy push/pull. `forceCheck`
  // bypasses the circuit breaker; `showFailureBanner` opts into the
  // smart connection banner if the probe fails.
  const online = await checkOnline(forceCheck, showFailureBanner);
  if (!online) return { ok: false, reason: 'offline' };
  const res = await _round(() => _syncRound(silent));
  if (res.reason === 'other_account' || res.reason === 'account_changed') return res;
  // Clear connection state + error on a successful round so a stale
  // banner from a prior failure doesn't linger once the issue is
  // resolved.
  if (res.pull?.ok !== false) {
    syncState.update(s => ({
      ...s, error: null, online: true,
      connectionIssue: null, showErrorBanner: false,
    }));
  } else if (showFailureBanner) {
    syncState.update(s => ({ ...s, showErrorBanner: true }));
  }
  return res;
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
