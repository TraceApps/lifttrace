/**
 * offline-edits.js: the pure half of the browser's offline mode.
 *
 * No IndexedDB, no fetch, no Svelte. Every function here is plain data in,
 * plain data out, so it can be tested without a browser
 * (scripts/offline-edits.test.js). offline-api.js does the storage and the
 * sending, and apiFetch.js is where it meets the app.
 *
 * LiftTrace already speaks to itself through `fetch('/api/...')` everywhere,
 * so offline work is kept as the request the app tried to make:
 *
 *   { seq, method: 'PUT', path: '/api/workout/2026-09-20', body: {...}, key, kind, at }
 *
 * Going back online replays those requests against the same routes the
 * Android app replays its own queue against, so there is no second merge
 * path to keep in step with the server.
 */

/** Was this the server being unreachable, rather than a real answer? */
export function isOfflineError(err) {
  if (!err) return false;
  if (err.offline) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err.message || err);
  // fetch() rejects with a TypeError when the network is gone; a request the
  // app gave up on aborts instead.
  return /Failed to fetch|NetworkError|Load failed|network|timeout|aborted|The operation was aborted/i.test(msg);
}

/** The path without its query, for matching. */
export const pathOf = (url) => String(url).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
/** What a mirrored answer is filed under: the path and its query together. */
export const mirrorKey = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');

// Reads worth keeping a copy of. Everything a screen needs to open with no
// connection is here; anything else still asks the server and says so when it
// can't be reached.
export const MIRRORED_GETS = [
  /^\/api\/workout\/\d{4}-\d{2}-\d{2}$/,
  /^\/api\/workout\/\d{4}-\d{2}-\d{2}\/sessions$/,
  /^\/api\/workout\/recent$/,
  /^\/api\/workout\/history\/\d+$/,
  /^\/api\/exercises$/,
  /^\/api\/exercises\/\d+$/,
  /^\/api\/exercises\/usage$/,
  /^\/api\/programs$/,
  /^\/api\/programs\/\d+$/,
  /^\/api\/templates\/\d+$/,
  /^\/api\/body-stats\/[\w-]+$/,
  /^\/api\/settings$/,
  /^\/api\/stats(\/|$)/,
  // Cardio and the coaching side of the diary: read-only lists that would
  // otherwise leave holes in a screen that is otherwise complete.
  /^\/api\/cardio(\/|\?|$)/,
  /^\/api\/prescriptions\//,
  /^\/api\/coach-feedback\//,
  /^\/api\/workout\/\d{4}-\d{2}-\d{2}\/feedback$/,
  /^\/api\/exercises\/sources\/list$/,
  // The coaching side: a coach's roster, a member's session, the notes
  // inbox. All read-only, and all wanted on a gym floor.
  /^\/api\/trainer\/members$/,
  /^\/api\/trainer\/members\/\d+$/,
  /^\/api\/trainer\/members\/\d+\/workout\/\d{4}-\d{2}-\d{2}$/,
  /^\/api\/trainer\/members\/\d+\/prescriptions$/,
  /^\/api\/trainer\/activity$/,
  // Who is signed in, and how. Without these the app reads an unreachable
  // server as "nobody is signed in" and starts forgetting what depends on it,
  // and Settings greets you with an error instead of your own profile.
  /^\/api\/auth\/status$/,
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/oidc\/(providers|links)$/,
];

export const isMirroredGet = (url) => MIRRORED_GETS.some(re => re.test(pathOf(url)));

/**
 * The work this layer will take on without a connection, and how to collapse
 * it. Anything not named here needs the server: a photo upload, an import,
 * Trace, anything admin.
 */
export function writeOp(method, url, body) {
  const path = pathOf(url);
  const query = new URLSearchParams(String(url).split('?')[1] || '');
  const m = (method || 'GET').toUpperCase();

  let match = path.match(/^\/api\/workout\/(\d{4}-\d{2}-\d{2})$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    // A date can hold more than one session (#76), so the session is part of
    // what a queued save is about.
    const session = body?.id ?? (query.get('id') != null ? Number(query.get('id')) : null);
    return { kind: m === 'PUT' ? 'workout' : 'workout-delete', key: `workout:${match[1]}#${session ?? 'default'}` };
  }
  match = path.match(/^\/api\/body-stats\/([\w-]+)$/);
  if (match && m === 'PUT') return { kind: 'body-stats', key: `body:${match[1]}` };

  if (path === '/api/exercises' && m === 'POST') return { kind: 'exercise-create', key: null };
  match = path.match(/^\/api\/exercises\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'exercise-update' : 'exercise-delete', key: `exercise:${match[1]}`, id: Number(match[1]) };
  }
  // Cardio: logged away from wifi more often than anything else here. The
  // write paths take an id, the read paths take a date, and an id is all
  // digits, so the two cannot be confused.
  if (path === '/api/cardio' && m === 'POST') return { kind: 'cardio-create', key: null };
  match = path.match(/^\/api\/cardio\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'cardio-update' : 'cardio-delete', key: `cardio:${match[1]}`, id: Number(match[1]) };
  }

  // Which program you are on, and where in it. Editing a program is desk
  // work and still needs the server; starting one at the gym does not.
  match = path.match(/^\/api\/programs\/(\d+)\/activate$/);
  if (match && m === 'POST') return { kind: 'program-activate', key: 'program:active', id: Number(match[1]) };
  if (path === '/api/programs/deactivate' && m === 'POST') return { kind: 'program-activate', key: 'program:active' };
  match = path.match(/^\/api\/programs\/(\d+)\/week-cursor$/);
  if (match && m === 'POST') return { kind: 'program-week', key: `program:${match[1]}:week` };

  // ── Coaching ──────────────────────────────────────────────────────
  // Writing a note, replying to one, marking them read, and prescribing
  // work: all of it is text or read state against rows that already exist,
  // so it queues like anything else. Adding or removing a member, and
  // assigning a program, are NOT here: they change who can see whose data,
  // and doing that against a roster pulled down hours ago is how someone
  // ends up with access they should not have.
  if (path === '/api/trainer/feedback' && m === 'POST') {
    // One note per exercise per coach, so a note written twice before the
    // connection returns goes up once, with what it ended up saying.
    const anchor = body?.exercise_uuid || (body?.exercise_idx ?? 'workout');
    return { kind: 'coach-note', key: `note:${body?.workout_id}:${anchor}` };
  }
  match = path.match(/^\/api\/coach-feedback\/(\d+)\/reply$/);
  if (match && m === 'PUT') return { kind: 'coach-reply', key: `reply:${match[1]}` };
  if (path === '/api/coach-feedback/seen' && m === 'POST') return { kind: 'seen', key: 'seen:notes' };
  if (path === '/api/trainer/activity/seen' && m === 'POST') return { kind: 'seen', key: 'seen:activity' };
  match = path.match(/^\/api\/trainer\/members\/(\d+)\/prescriptions$/);
  if (match && m === 'POST') return { kind: 'prescription-create', key: null };
  match = path.match(/^\/api\/trainer\/prescriptions\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'prescription-update' : 'prescription-delete', key: `prescription:${match[1]}`, id: Number(match[1]) };
  }

  // A progress photo taken with no connection: the file rides inside this
  // request as a data URL and the server turns it into a file on arrival.
  if (path === '/api/body-stats/photos' && m === 'POST') return { kind: 'photo-add', key: null };
  match = path.match(/^\/api\/body-stats\/photos\/(-?\d+)$/);
  if (match && m === 'DELETE') return { kind: 'photo-delete', key: `photo:${match[1]}`, id: Number(match[1]) };

  if (path === '/api/settings' && m === 'PUT') return { kind: 'setting', key: `setting:${body?.key}` };
  return null;
}

/** Tombstones from a workout save, in the shape the route accepts. */
const _tombs = (body) => {
  const raw = body?.deleted_uuids;
  return {
    exercises: Array.isArray(raw?.exercises) ? raw.exercises : Array.isArray(raw) ? raw : [],
    sets: raw && typeof raw.sets === 'object' && !Array.isArray(raw.sets) ? raw.sets : {},
  };
};

/**
 * One request per thing, newest state winning, with two exceptions.
 *
 * Deletions: the app works out `deleted_uuids` by diffing against what it
 * last saw saved, and a queued save counts as saved, so the next save of that
 * day carries none. Every tombstone queued for a day therefore rides along
 * with the last save, or something deleted offline and followed by another
 * change would come back: the route keeps whatever the client doesn't mention.
 *
 * An exercise created and then deleted offline never goes up at all.
 */
export function collapseOps(ops) {
  const byKey = new Map();
  const tombs = new Map();
  const out = [];

  for (const op of ops || []) {
    if (!op) continue;
    // A create is keyed by the temporary id it was given when it was queued,
    // which is what a later edit or removal of that row carries too.
    if (!op.key) { out.push(op); continue; }

    if (op.kind === 'workout') {
      const t = tombs.get(op.key) || { exercises: new Set(), sets: new Map() };
      const queued = _tombs(op.body);
      for (const uuid of queued.exercises) t.exercises.add(uuid);
      for (const [ex, uuids] of Object.entries(queued.sets)) {
        const set = t.sets.get(ex) || new Set();
        for (const uuid of uuids || []) set.add(uuid);
        t.sets.set(ex, set);
      }
      tombs.set(op.key, t);
    }

    const prev = byKey.get(op.key);
    if (prev?.kind === 'exercise-create' || prev?.kind === 'cardio-create' || prev?.kind === 'prescription-create') {
      // Made offline and then changed again: still one create, with the
      // newest values. Made and then removed: it never happened.
      if (op.kind === 'exercise-delete' || op.kind === 'cardio-delete' || op.kind === 'prescription-delete') { byKey.delete(op.key); continue; }
      if (op.kind === 'exercise-update' || op.kind === 'cardio-update' || op.kind === 'prescription-update') {
        byKey.set(op.key, { ...prev, body: { ...prev.body, ...op.body }, seq: op.seq });
        continue;
      }
    }
    byKey.set(op.key, op);
  }

  for (const op of byKey.values()) {
    if (op.kind !== 'workout') { out.push(op); continue; }
    const t = tombs.get(op.key);
    out.push({
      ...op,
      body: {
        ...op.body,
        deleted_uuids: {
          exercises: [...t.exercises],
          sets: Object.fromEntries([...t.sets].map(([ex, set]) => [ex, [...set]])),
        },
      },
    });
  }
  return out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/**
 * Which queued requests a replay accounted for: the ones whose key went up
 * successfully, plus any that cancelled each other out and were never sent.
 */
export function sentSeqs(ops, doneKeys) {
  const done = new Set(doneKeys || []);
  const queued = new Set(collapseOps(ops).map(op => op.key).filter(Boolean));
  return (ops || [])
    .filter(op => !op.key || done.has(op.key) || !queued.has(op.key))
    .map(op => op.seq);
}

// ── What the screens see while work is waiting ──────────────────────

/**
 * The mirrored answer with queued work applied, so a day edited offline
 * shows what you typed rather than what the server last knew.
 */
export function answerWithOps(url, mirrored, ops) {
  const path = pathOf(url);
  const day = path.match(/^\/api\/workout\/(\d{4}-\d{2}-\d{2})$/);
  if (day) {
    const queued = (ops || []).filter(op => op.kind === 'workout' && op.key.startsWith(`workout:${day[1]}#`));
    const removed = (ops || []).some(op => op.kind === 'workout-delete' && op.key.startsWith(`workout:${day[1]}#`));
    if (removed && !queued.length) return { workout: null };
    if (!queued.length) return mirrored;
    const last = queued[queued.length - 1];
    return { workout: { ...(mirrored?.workout || {}), ...last.body, _pending: true } };
  }
  if (path === '/api/settings') {
    const queued = (ops || []).filter(op => op.kind === 'setting');
    if (!queued.length) return mirrored;
    const settings = { ...(mirrored || {}) };
    for (const op of queued) if (op.body?.key) settings[op.body.key] = op.body.value;
    return settings;
  }
  const memberDay = path.match(/^\/api\/trainer\/members\/\d+\/workout\/(\d{4}-\d{2}-\d{2})$/);
  if (memberDay && mirrored) {
    const notes = (ops || []).filter(op => op.kind === 'coach-note' && op.body?.workout_id === mirrored.id);
    if (!notes.length) return mirrored;
    const feedback = [...(mirrored.feedback || [])];
    for (const op of notes) {
      const at = feedback.findIndex(f => (op.body.exercise_uuid
        ? f.exercise_uuid === op.body.exercise_uuid
        : (f.exercise_idx ?? null) === (op.body.exercise_idx ?? null)));
      const note = { ...(at >= 0 ? feedback[at] : {}), ...op.body, _pending: true };
      if (!String(op.body.note || '').trim()) { if (at >= 0) feedback.splice(at, 1); continue; }
      if (at >= 0) feedback[at] = note; else feedback.push({ id: op.seq * -1, ...note });
    }
    return { ...mirrored, feedback };
  }

  const cardioDay = path.match(/^\/api\/cardio\/(\d{4}-\d{2}-\d{2})$/);
  if (path === '/api/cardio' || cardioDay) {
    const made = (ops || []).filter(op => op.kind === 'cardio-create'
      && (!cardioDay || op.body?.date === cardioDay[1]));
    const changed = new Map((ops || []).filter(op => op.kind === 'cardio-update').map(op => [Number(op.id), op.body]));
    const gone = new Set((ops || []).filter(op => op.kind === 'cardio-delete').map(op => Number(op.id)));
    if (!made.length && !changed.size && !gone.size) return mirrored;
    // A day never opened online still shows what was logged on it here.
    const base = Array.isArray(mirrored) ? mirrored : mirrored === undefined ? [] : null;
    if (base === null) return mirrored;
    return base
      .filter(r => !gone.has(Number(r.id)))
      .map(r => (changed.has(Number(r.id)) ? { ...r, ...changed.get(Number(r.id)), _pending: true } : r))
      .concat(made.map(op => ({ ...op.body, id: op.tempId, _pending: true })));
  }

  if (path === '/api/exercises') {
    const made = (ops || []).filter(op => op.kind === 'exercise-create');
    const gone = new Set((ops || []).filter(op => op.kind === 'exercise-delete').map(op => Number(op.id)));
    if (!made.length && !gone.size) return mirrored;
    const list = Array.isArray(mirrored) ? mirrored : mirrored?.exercises ?? (mirrored === undefined ? [] : null);
    if (!Array.isArray(list)) return mirrored;
    const rows = list.filter(e => !gone.has(Number(e.id)))
      .concat(made.map(op => ({ ...op.body, id: op.tempId, _pending: true })));
    return Array.isArray(mirrored) ? rows : { ...mirrored, exercises: rows };
  }
  return mirrored;
}

/** The reply a queued workout save hands back, shaped like the route's own. */
export function queuedWorkoutReply(mirrored, body, tempId) {
  const workout = { ...(mirrored?.workout || {}), ...body, _pending: true };
  if (workout.id == null) workout.id = tempId;
  return { workout, tombstones: [], queued: true, offline: true };
}

/**
 * A queued change in a few words, for telling someone their server refused
 * it. Never the raw path: "PUT /api/workout/2026-09-20" means nothing to the
 * person who logged the set.
 */
export function describeOp(op) {
  const date = (op?.path || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  const on = date ? ` on ${date}` : '';
  switch (op?.kind) {
    case 'workout':          return `your workout${on}`;
    case 'workout-delete':   return `deleting the workout${on}`;
    case 'body-stats':       return `your body stats${on}`;
    case 'cardio-create':    return `the ${op.body?.activity || 'cardio'} you logged`;
    case 'cardio-update':    return 'a cardio session you changed';
    case 'cardio-delete':    return 'a cardio session you deleted';
    case 'exercise-create':  return `the exercise "${op.body?.name || 'you added'}"`;
    case 'exercise-update':  return 'an exercise you changed';
    case 'exercise-delete':  return 'an exercise you deleted';
    case 'program-activate': return 'the program you started';
    case 'program-week':     return 'the program week you moved to';
    case 'coach-note':       return 'the note you left for your member';
    case 'coach-reply':      return 'your reply to your coach';
    case 'seen':             return 'marking notes as read';
    case 'prescription-create': return 'the work you prescribed';
    case 'prescription-update': return 'a prescription you changed';
    case 'prescription-delete': return 'a prescription you removed';
    case 'photo-add':        return 'the progress photo you took';
    case 'photo-delete':     return 'a progress photo you removed';
    case 'setting':          return `the "${op.body?.key || 'setting'}" setting`;
    default:                 return 'a change you made';
  }
}

/**
 * Will trying again ever help? A server that is struggling (5xx), busy (429)
 * or slow (408) deserves another go. So does a session that has expired or
 * lost its footing (401, 403): signing in again fixes that, and throwing the
 * work away because a cookie timed out would be inexcusable. Everything else
 * (a malformed row, a row that no longer exists, a conflict) is the server's
 * considered answer, and repeating it will only produce the same answer.
 */
export const shouldRetryStatus = (status) =>
  status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;

// ── Rows made with no connection ────────────────────────────────────

let _tempSeq = 0;
/** An id that cannot be mistaken for one the server gave out. */
export const newTempId = () => -(Date.now() * 1000 + (++_tempSeq % 1000));
export const isTempId = (id) => Number(id) < 0;

/** Temporary id to real id, from what a replayed request answered. */
export function createdId(response) {
  const row = response?.exercise || response?.workout || response?.cardio || response;
  const id = row?.id;
  return id != null && Number(id) > 0 ? Number(id) : null;
}

/**
 * Point everything at the real ids: a workout logged offline against an
 * exercise that only existed offline has to follow it to the id the server
 * gave it, or the save arrives pointing at nothing.
 */
export function remapIds(value, map) {
  if (!map || !Object.keys(map).length) return value;
  const swap = (id) => (map[Number(id)] != null ? map[Number(id)] : id);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const key of ['exercise_id', 'exerciseId', 'id', 'server_id']) {
        if (out[key] != null && isTempId(out[key])) out[key] = swap(out[key]);
      }
      for (const [k, val] of Object.entries(out)) {
        if (val && typeof val === 'object') out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** A path that still names a temporary id, pointed at the real one. */
export function remapPath(path, map) {
  return String(path).replace(/\/(-\d+)(\b|$)/, (all, id) => {
    const real = map?.[Number(id)];
    return real != null ? `/${real}` : all;
  });
}
