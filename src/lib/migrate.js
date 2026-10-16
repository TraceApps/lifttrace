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
 *   PUT  /api/workout/:date         each workout as a new session (new_session + client_key)
 *   PUT  /api/body-stats/:date      upserts on (user_id, date)
 *   POST /api/programs              creates a new program
 *   POST /api/templates             creates a workout template under a program
 *   POST /api/exercises             creates a custom exercise
 *   PUT  /api/settings              upserts a single user setting (key, value)
 *
 * Each logged workout goes up as a session of its own, beside anything the
 * server already has that day; body stats merge into the server's day. Every
 * create carries a client_key from this phone's row, and only rows the
 * server doesn't have are sent, so running upload twice sends nothing twice.
 * What went up intact is then removed here (the next sync brings the
 * server's copy); what didn't stays.
 */

import { dbQuery, dbRun } from './db-native.js';
import { isNative, getServerUrl, getAuthToken } from './platform.js';
import md5 from './md5.js';

/**
 * Count local rows that would be uploaded. Returns
 * `{ workouts, bodyStats, programs, templates, customExercises, settings, total }`.
 *
 * Local reads only, no network: the same rows uploadLocalToServer sends
 * (see _toUpload), so the dialog never promises more than goes up.
 */
export async function countLocalData({ serverUrl = getServerUrl(), userId, confirmServer } = {}) {
  if (!isNative) return _empty();
  try {
    // Exactly what uploadLocalToServer sends: not what Disconnect kept from
    // this same account (it goes back in place, changes as updates).
    const la = await import('./local-account.js');
    const phones = await la.copyIsPhones();
    const match = phones && serverUrl ? await la.uploadMatch(serverUrl, userId ?? la.tokenUserId(), confirmServer ? { confirmServer } : {}) : null;
    const back = match ? await (await import('./sync.js')).countFromOrigin(match) : {};
    const up = await _toUpload({ before: phones, back });
    const w = up.workouts.length, b = up.bodyStats.length, p = up.programs.length,
      e = up.customExercises.length, s = up.settings.length, c = up.cardio.length;
    let t = 0;
    for (const prog of up.programs) t += (await up.daysOf(prog.id)).length;
    const total = w + b + p + t + e + s + c;
    return { workouts: w, bodyStats: b, programs: p, templates: t, customExercises: e, cardio: c, settings: s, total };
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
export async function uploadLocalToServer({ onProgress, userId, confirmServer } = {}) {
  if (!isNative)        throw new Error('uploadLocalToServer only runs on Capacitor');
  if (!getServerUrl())  throw new Error('Server URL not configured');
  if (!getAuthToken())  throw new Error('Auth token missing — log in first');

  const summary = {
    success: { workouts: 0, bodyStats: 0, programs: 0, templates: 0, customExercises: 0, cardio: 0, settings: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
  };

  // What Disconnect kept from this same account goes back to its rows
  // first (changed ones as updates, through the sync); everything else that
  // is the phone's own gets an id below zero. Only those go up.
  {
    const la = await import('./local-account.js');
    await la.prepareCopyForUpload(getServerUrl(), userId ?? la.tokenUserId(), confirmServer ? { confirmServer } : {});
  }

  // ── Custom exercises first ────────────────────────────────────────────────
  // Programs reference exercises by id. Server creates new ids, so we keep
  // a local→remote id map for any later code that needs it. Today's
  // workout_templates store exercise rows as JSON snapshots (not FKs to
  // exercise rows), so the map is informational; templates upload fine
  // even without it.
  const exMap = new Map();
  // What went up, by local id: the copies here go once it's done (below).
  const uploaded = { exercises: [], programs: [], days: [], workouts: [], bodyStats: [], cardio: [] };
  // Program workouts that didn't go up though their program did.
  const failedDays = [];
  const up = await _toUpload();
  const customEx = up.customExercises;
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
        client_key:        _key('exercise', row),
      });
      if (created?.id) exMap.set(row.id, created.id);
      uploaded.exercises.push(row.id);
      summary.success.customExercises++;
    } catch (e) {
      summary.errors.push({ stage: 'customExercises', name: row.name, message: e.message });
    }
  }

  // ── Programs + their workout templates ────────────────────────────────────
  // Ids here are this phone's own; the server's differ. Every reference
  // that goes up is put in the server's terms, or left out: sent as it was,
  // it named whatever the server has under that number (a library
  // exercise, a starter program, someone else's row).
  const exId = await _exerciseIdMapper(exMap);
  const progMap = new Map();
  const tmplMap = new Map();
  const programs = up.programs;
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
        // The plan's length and how it moves on; left out, every uploaded
        // plan became one week long.
        duration_weeks: p.duration_weeks ?? 1,
        advance_mode:   p.advance_mode || 'sessions',
        on_complete:    p.on_complete || 'hold',
        client_key:     _key('program', p),
      });
      createdProgramId = created?.id;
      if (createdProgramId != null) progMap.set(p.id, createdProgramId);
      summary.success.programs++;
    } catch (e) {
      summary.errors.push({ stage: 'programs', name: p.name, message: e.message });
      continue; // can't upload templates without a parent program id
    }

    const templates = await up.daysOf(p.id);
    uploaded.programs.push(p.id);
    for (const t of templates) {
      try {
        const createdDay = await _post('/api/templates', {
          program_id:  createdProgramId,
          name:        t.name,
          day_label:   t.day_label,
          order_index: t.order_index,
          exercises:   _mapExercises(_parseJson(t.exercises), exId),
          client_key:  _key('day', t),
        });
        if (createdDay?.id != null) tmplMap.set(t.id, createdDay.id);
        uploaded.days.push(t.id);
        summary.success.templates++;
      } catch (e) {
        failedDays.push({ id: t.id, program: createdProgramId });
        summary.errors.push({ stage: 'templates', name: `${p.name} / ${t.name}`, message: e.message });
      }
    }
  }

  // ── Program being followed ───────────────────────────────────────────────
  // Started again on the server (with the week it was pinned to), and kept
  // active here under the server's id. Left out, uploading lost it.
  const active = (await dbQuery(
    `SELECT program_id, week_cursor FROM program_assignments WHERE active = 1 ORDER BY id DESC LIMIT 1`
  ))[0];
  if (active && progMap.has(active.program_id)) {
    const serverId = progMap.get(active.program_id);
    try {
      await _post(`/api/programs/${serverId}/activate`, {});
      if (active.week_cursor != null) await _post(`/api/programs/${serverId}/week-cursor`, { week: active.week_cursor });
    } catch (e) {
      summary.errors.push({ stage: 'programs', name: 'active program', message: e.message });
    }
  }
  for (const [localId, serverId] of progMap) {
    await dbRun(`UPDATE program_assignments SET program_id = ? WHERE program_id = ?`, [serverId, localId]);
  }

  // ── Workouts: each session as its own ─────────────────────────────────────
  // A new session every time, so a day that already has a workout on the
  // server keeps it untouched and two sessions on one day stay two. Each
  // carries a key from this phone's row, so uploading again doesn't double
  // them. These used to go up as "the day's workout": two sessions merged
  // into one, and a workout already on the server took this one's fields.
  const workouts = up.workouts;
  for (let i = 0; i < workouts.length; i++) {
    onProgress?.('workouts', i, workouts.length);
    const w = workouts[i];
    try {
      const exercises = _mapExercises(_parseJson(w.exercises, []), exId);
      const saved = await _put(`/api/workout/${encodeURIComponent(w.date)}`, {
        new_session:  true,
        client_key:   _key('workout', w),
        template_id:  w.template_id != null ? tmplMap.get(w.template_id) ?? null : null,
        program_id:   w.program_id != null ? progMap.get(w.program_id) ?? null : null,
        program_week: w.program_week ?? null,
        name:         w.name,
        exercises,
        notes:        w.notes,
        duration_min: w.duration_min,
        completed:    !!w.completed,
      });
      // The phone's copy goes only when the server's has every exercise
      // and set it had.
      if (_sameWork(exercises, saved?.workout?.exercises)) uploaded.workouts.push(w.id);
      summary.success.workouts++;
    } catch (e) {
      summary.errors.push({ stage: 'workouts', name: w.date, message: e.message });
    }
  }

  // ── Body stats (upserts by date) ──────────────────────────────────────────
  const bodyStats = up.bodyStats;
  for (let i = 0; i < bodyStats.length; i++) {
    onProgress?.('bodyStats', i, bodyStats.length);
    const b = bodyStats[i];
    try {
      // The route reads { stats }; the bare numbers this used to send were
      // read as nothing, so body stats never went up.
      const stats = _parseJson(b.stats, {}) || {};
      const saved = await _put(`/api/body-stats/${encodeURIComponent(b.date)}`, { stats });
      const there = _parseJson(saved?.stats?.stats, {}) || {};
      if (Object.keys(stats).every(k => JSON.stringify(there[k]) === JSON.stringify(stats[k]))) uploaded.bodyStats.push(b.id);
      summary.success.bodyStats++;
    } catch (e) {
      summary.errors.push({ stage: 'bodyStats', name: b.date, message: e.message });
    }
  }

  // ── Cardio ────────────────────────────────────────────────────────────────
  const cardio = up.cardio;
  for (let i = 0; i < cardio.length; i++) {
    onProgress?.('cardio', i, cardio.length);
    const c = cardio[i];
    try {
      await _post('/api/cardio', {
        date: c.date, activity: c.activity, duration_min: c.duration_min, distance: c.distance,
        distance_unit: c.distance_unit, avg_hr: c.avg_hr, notes: c.notes, is_template: !!c.is_template,
        client_key: _key('cardio', c),
      });
      uploaded.cardio.push(c.id);
      summary.success.cardio++;
    } catch (e) {
      summary.errors.push({ stage: 'cardio', name: `${c.date} ${c.activity}`, message: e.message });
    }
  }

  // ── User settings (upsert per-key) ────────────────────────────────────────
  const settings = up.settings;
  for (let i = 0; i < settings.length; i++) {
    onProgress?.('settings', i, settings.length);
    const s = settings[i];
    try {
      // Settings kept per exercise name exercises by this phone's ids: in
      // the server's terms, or left out.
      let value = _parseJson(s.value);
      if (_BY_EXERCISE.includes(s.key)) value = _mapExerciseSetting(value, exId);
      await _put('/api/settings', { key: s.key, value });
      summary.success.settings++;
    } catch (e) {
      summary.errors.push({ stage: 'settings', name: s.key, message: e.message });
    }
  }

  // The copies here of everything that went up go: the server's come down
  // with the next sync, and keeping both left two of each on this phone for
  // good. What failed to go up stays, here only.
  for (const id of uploaded.workouts) await dbRun(`DELETE FROM workout_log WHERE id = ?`, [id]);
  for (const id of uploaded.bodyStats) await dbRun(`DELETE FROM body_stats_log WHERE id = ?`, [id]);
  for (const id of uploaded.cardio) await dbRun(`DELETE FROM cardio_log WHERE id = ?`, [id]);
  for (const id of uploaded.days) await dbRun(`DELETE FROM workout_templates WHERE id = ?`, [id]);
  for (const id of uploaded.programs) await dbRun(`DELETE FROM programs WHERE id = ?`, [id]);
  for (const id of uploaded.exercises) await dbRun(`DELETE FROM exercises WHERE id = ?`, [id]);
  // What stays here names what went up by the server's ids (those rows
  // come down with the next sync), and is this phone's own: ids below zero
  // (sync.js renumberLocalRows), so the server's rows never take its place.
  for (const [mine, theirs] of progMap) {
    await dbRun(`UPDATE workout_templates SET program_id = ? WHERE program_id = ?`, [theirs, mine]);
    await dbRun(`UPDATE workout_log SET program_id = ? WHERE program_id = ?`, [theirs, mine]);
  }
  // A workout of a program that went up, that didn't go up itself: queued
  // to go up into that program (the sync tries again until it does), not
  // left behind here as the only copy.
  if (failedDays.length) {
    const sync = await import('./sync.js');
    for (const d of failedDays) {
      const t = (await dbQuery(`SELECT * FROM workout_templates WHERE id = ?`, [d.id]))[0];
      if (!t || d.program == null) continue;
      const qid = await sync.enqueueWrite('POST', '/api/templates', {
        program_id: d.program, name: t.name, day_label: t.day_label, order_index: t.order_index,
        exercises: _mapExercises(_parseJson(t.exercises, []), exId), client_key: _key('day', t),
      });
      await sync.noteQueuedLocalId(qid, t.id);
    }
  }
  for (const [mine, theirs] of tmplMap) await dbRun(`UPDATE workout_log SET template_id = ? WHERE template_id = ?`, [theirs, mine]);
  if (exMap.size) {
    for (const t of ['workout_log', 'workout_templates']) {
      for (const r of await dbQuery(`SELECT id, exercises FROM ${t}`)) {
        const list = _parseJson(r.exercises, []);
        if (!Array.isArray(list) || !list.some(e => e && exMap.has(Number(e.exercise_id)))) continue;
        const next = list.map(e => (e && exMap.has(Number(e.exercise_id)) ? { ...e, exercise_id: exMap.get(Number(e.exercise_id)) } : e));
        await dbRun(`UPDATE ${t} SET exercises = ? WHERE id = ?`, [JSON.stringify(next), r.id]);
      }
    }
  }
  try { await (await import('./sync.js')).renumberLocalRows(); }
  catch (e) { console.warn('[migrate] keeping what didn\'t go up as the phone\'s own failed:', e?.message || e); }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * What an Upload sends, and the dialog before it counts: every row that is
 * this phone's own ('pending': made here, or everything the account had
 * here after Disconnect), whatever its id. Not a row the server sent here
 * (online saves are mirrored here too), so uploading twice sends nothing
 * twice; not a row whose create is still queued (the sync sends that one);
 * not the exercise library, and not a deleted row.
 */
async function _toUpload({ before = false, back = {} } = {}) {
  const queued = new Set();
  for (const r of await dbQuery(`SELECT payload FROM sync_queue`)) {
    try { const p = JSON.parse(r.payload); if (p?.localId != null) queued.add(Number(p.localId)); } catch { /* not a create */ }
  }
  // After the copy is prepared (uploadLocalToServer), every row that is the
  // phone's own has an id below zero. Counted before that (the dialog), a
  // copy that is the phone's own still has its standalone ids, and rows
  // Disconnect kept from this same account (`back`) go back, not up.
  const MINE = `COALESCE(sync_state, 'pending') = 'pending'${before ? '' : ' AND id < 0'}`;
  const keep = (t) => rows => rows.filter(r => !queued.has(Number(r.id)) && !back[t]?.has(Number(r.id)));
  return {
    customExercises: keep('exercises')(await dbQuery(
      `SELECT * FROM exercises WHERE source = 'custom' AND COALESCE(is_global, 0) = 0 AND deleted_at IS NULL AND ${MINE} ORDER BY id`)),
    programs: keep('programs')(await dbQuery(`SELECT * FROM programs WHERE deleted_at IS NULL AND ${MINE} ORDER BY id`)),
    daysOf: async (programId) => keep('workout_templates')(await dbQuery(
      `SELECT * FROM workout_templates WHERE program_id = ? AND deleted_at IS NULL AND ${MINE} ORDER BY order_index ASC, id ASC`, [programId])),
    workouts: keep('workout_log')(await dbQuery(
      `SELECT * FROM workout_log WHERE deleted_at IS NULL AND ${MINE} ORDER BY date ASC, session_seq ASC, id ASC`)),
    bodyStats: keep('body_stats_log')(await dbQuery(`SELECT * FROM body_stats_log WHERE deleted_at IS NULL AND ${MINE} ORDER BY date ASC`)),
    // Cardio has no change marker: on the phone's own copy all of it is its own.
    cardio: keep('cardio_log')(await dbQuery(`SELECT * FROM cardio_log${before ? '' : ' WHERE id < 0'} ORDER BY date ASC, id ASC`)),
    settings: await dbQuery(`SELECT * FROM user_settings`),
  };
}

/** The key a row goes up under (the server makes it once): from what the
 *  row is (when it was made, its date and name), not from its id here,
 *  which changes when the copy changes hands. */
function _key(kind, r) {
  return `upload:${kind}:${md5(JSON.stringify([r.created_at || '', r.date || '', r.name ?? r.activity ?? '', r.session_seq ?? 0]))}`;
}

// Settings kept per exercise, by id (sync.js keeps the same list).
const _BY_EXERCISE = ['restPerExercise', 'exerciseLoadTypes', 'exerciseSetTypes', 'favoriteExercises'];
function _mapExerciseSetting(value, exId) {
  if (Array.isArray(value)) return value.map(v => exId(Number(v))).filter(v => v != null);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const to = Number.isFinite(Number(k)) ? exId(Number(k)) : null;
      if (to != null) out[String(to)] = v;
    }
    return out;
  }
  return value;
}

/** This phone's exercise id to the server's: a custom one through what the
 *  upload just made, a library one by its catalog entry (source and
 *  external id), else by name. Unknown is null (the entry keeps its name). */
async function _exerciseIdMapper(exMap) {
  const local = new Map((await dbQuery(`SELECT id, name, source, external_id FROM exercises`)).map(r => [r.id, r]));
  let server = [];
  // Straight from the server: through fetch this read is answered from
  // this phone's own copy (apiFetch local-first), which has local ids.
  try { server = await (await import('./sync.js')).serverGet('/api/exercises'); } catch { server = []; }
  if (!Array.isArray(server)) server = Array.isArray(server?.exercises) ? server.exercises : [];
  const byExt = new Map(), byName = new Map();
  for (const e of server) {
    if (e.external_id != null) byExt.set(`${e.source}|${e.external_id}`, e.id);
    const n = String(e.name || '').trim().toLowerCase();
    if (n && !byName.has(n)) byName.set(n, e.id);
  }
  return (id) => {
    if (id == null) return null;
    if (exMap.has(id)) return exMap.get(id);
    const row = local.get(Number(id));
    if (!row) return null;
    if (row.external_id != null && byExt.has(`${row.source}|${row.external_id}`)) return byExt.get(`${row.source}|${row.external_id}`);
    return byName.get(String(row.name || '').trim().toLowerCase()) ?? null;
  };
}

/** Every exercise and set of `mine` is in `theirs` (matched by uuid where
 *  there is one, else by position). */
function _sameWork(mine, theirs) {
  if (!Array.isArray(mine)) return true;
  if (!Array.isArray(theirs) || theirs.length < mine.length) return false;
  const byUuid = new Map(theirs.filter(e => e?.uuid).map(e => [e.uuid, e]));
  return mine.every((e, i) => {
    const t = (e?.uuid && byUuid.get(e.uuid)) || theirs[i];
    return t && (t.sets || []).length >= (e?.sets || []).length;
  });
}

function _mapExercises(list, exId) {
  if (!Array.isArray(list)) return list;
  return list.map(e => (e && typeof e === 'object' && 'exercise_id' in e ? { ...e, exercise_id: exId(e.exercise_id) } : e));
}
function _empty() {
  return { workouts: 0, bodyStats: 0, programs: 0, templates: 0, customExercises: 0, settings: 0, total: 0 };
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
