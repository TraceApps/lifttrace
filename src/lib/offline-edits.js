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

  // Your own profile: a name, a nickname, a picture. Nothing here decides
  // what anyone else can see, so it queues like the rest.
  if (path === '/api/auth/profile' && m === 'PUT') return { kind: 'profile', key: 'profile' };

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
  // What each of a workout's queued saves said it changed, together. One
  // that didn't say (queued by an earlier version) makes the merged one say
  // nothing, so the server takes all of it, as it did then.
  const changes = new Map();
  const out = [];

  for (let op of ops || []) {
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
      const listed = op.body?.changed_uuids;
      const c = changes.has(op.key) ? changes.get(op.key) : { exercises: new Set(), sets: new Map() };
      if (c === null || !listed || typeof listed !== 'object' || !Array.isArray(listed.exercises)) {
        changes.set(op.key, null);
      } else {
        for (const uuid of listed.exercises) c.exercises.add(uuid);
        for (const [ex, uuids] of Object.entries(listed.sets || {})) {
          const set = c.sets.get(ex) || new Set();
          for (const uuid of uuids || []) set.add(uuid);
          c.sets.set(ex, set);
        }
        changes.set(op.key, c);
      }
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
    // A new workout of the day made here and then changed again: still one
    // new workout, with the newest values. Made and then deleted: it never
    // happened. Without this the change went up alone, carrying an id the
    // server never had, and landed in the day's first workout.
    if (prev?.kind === 'workout' && prev.body?.new_session && prev.tempId != null) {
      if (op.kind === 'workout-delete') { byKey.delete(op.key); continue; }
      if (op.kind === 'workout') {
        byKey.set(op.key, { ...op, body: { ...op.body, new_session: true, client_key: prev.body.client_key }, tempId: prev.tempId, changed: null });
        continue;
      }
    }
    // A later change of the same thing goes up in its place: it carries
    // what both changed, made as late as the later one. When either can't
    // say what it changed (no copy to tell by, or queued by an earlier
    // version), the merged one counts all it sends: a narrower list would
    // drop the earlier change's other fields.
    if (prev) {
      op = { ...op, changed: Array.isArray(prev.changed) && Array.isArray(op.changed) ? [...new Set([...prev.changed, ...op.changed])] : null };
      // A day's first workout made here keeps the temporary id it was made
      // under, so the replay still learns the server's id for it.
      if (op.kind === 'workout' && prev.kind === 'workout' && op.tempId == null && prev.tempId != null) op.tempId = prev.tempId;
    }
    byKey.set(op.key, op);
  }

  for (const op of byKey.values()) {
    if (op.kind !== 'workout') { out.push(op); continue; }
    const t = tombs.get(op.key);
    const c = changes.get(op.key);
    const body = {
      ...op.body,
      deleted_uuids: {
        exercises: [...t.exercises],
        sets: Object.fromEntries([...t.sets].map(([ex, set]) => [ex, [...set]])),
      },
    };
    if (c) body.changed_uuids = { exercises: [...c.exercises], sets: Object.fromEntries([...c.sets].map(([ex, set]) => [ex, [...set]])) };
    else delete body.changed_uuids;
    out.push({ ...op, body });
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

/** A queued save as a screen shows it: never with the request's own flags.
 *  The Diary saves what it shows back whole, and with `new_session` still on
 *  every save of a workout started here started yet another one. */
function _asShown(workout) {
  delete workout.new_session;
  delete workout.client_key;
  return workout;
}

/**
 * A queued save of a workout by a temporary id the server never gave its own
 * id for (its creation refused, or lost): sent as it is, the server put it in
 * the day's first workout, over what was there. It goes up as a new workout
 * of the day instead. Not when the queue holds a day's first workout queued
 * by an earlier version, with no temporary id: that is what such an id meant.
 */
export function orphanWorkoutSave(op, map, ops) {
  if (op?.kind !== 'workout' || op.body?.new_session) return null;
  const id = op.body?.id;
  if (id == null || !isTempId(id) || map?.[Number(id)] != null) return null;
  const date = String(op.key).slice('workout:'.length).split('#')[0];
  if ((ops || []).some(o => o.kind === 'workout' && o.key === `workout:${date}#default` && o.tempId == null)) return null;
  const body = { ...op.body, new_session: true, client_key: `web-workout${id}` };
  delete body.id;
  return body;
}

/**
 * What is queued for one workout of a day. `want`: the workout asked for by
 * id, or null for the day's first. `firstId`: the day's first workout as held
 * here, when known. A save sent with no id is about the day's first, which
 * is also the one made by a day's first save made here.
 */
function _opsForWorkout(ops, date, want, firstId) {
  const ofDay = (ops || []).filter(op => (op.kind === 'workout' || op.kind === 'workout-delete') && op.key.startsWith(`workout:${date}#`));
  const sessionOf = (op) => op.key.slice(op.key.indexOf('#') + 1);
  // New workouts of the day started here, under their temporary ids.
  const made = new Set(ofDay.filter(op => op.body?.new_session && op.tempId != null).map(op => String(op.tempId)));
  const firstMadeHere = ofDay.find(op => sessionOf(op) === 'default' && op.tempId != null)?.tempId;
  // Nothing else known for the day: the first new workout started here is
  // its first (on the server it is, on a day that had none).
  const first = firstId ?? firstMadeHere ?? ofDay.find(op => op.body?.new_session && op.tempId != null)?.tempId;
  const isFirst = (id) => (first != null ? String(first) === String(id) : !made.has(String(id)));
  return ofDay.filter(op => {
    const s = sessionOf(op);
    if (want != null) return s === String(want) || (s === 'default' && isFirst(want));
    return s === 'default' || (first != null ? s === String(first) : !made.has(s));
  });
}

/**
 * The mirrored answer with queued work applied, so a day edited offline
 * shows what you typed rather than what the server last knew.
 */
export function answerWithOps(url, mirrored, ops, firstId = undefined) {
  const path = pathOf(url);
  const day = path.match(/^\/api\/workout\/(\d{4}-\d{2}-\d{2})$/);
  if (day) {
    // A day can hold more than one workout (#76): only what was queued for
    // the one asked for applies. `firstId`: the day's first workout, as held
    // here, for a read by id.
    const want = new URLSearchParams(String(url).split('?')[1] || '').get('id');
    const mine = _opsForWorkout(ops, day[1], want, want == null ? mirrored?.workout?.id : firstId);
    const queued = mine.filter(op => op.kind === 'workout');
    const removed = mine.some(op => op.kind === 'workout-delete');
    if (removed && !queued.length) return { workout: null };
    if (!queued.length) return mirrored;
    const last = queued[queued.length - 1];
    const workout = _asShown({ ...(mirrored?.workout || {}), ...last.body, _pending: true });
    // Made here: its temporary id, until the server gives it its own.
    if (workout.id == null && last.tempId != null) workout.id = last.tempId;
    return { workout };
  }
  // The day's tabs: a workout started here shows as one, a deleted one goes.
  const tabs = path.match(/^\/api\/workout\/(\d{4}-\d{2}-\d{2})\/sessions$/);
  if (tabs) {
    const work = (ops || []).filter(op => (op.kind === 'workout' || op.kind === 'workout-delete') && op.key.startsWith(`workout:${tabs[1]}#`))
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (!work.length) return mirrored;
    const held = Array.isArray(mirrored?.sessions) ? mirrored.sessions : mirrored === undefined ? [] : null;
    if (held === null) return mirrored;
    let rows = [...held];
    for (const op of work) {
      const session = op.key.slice(op.key.indexOf('#') + 1);
      const at = session === 'default' ? (rows.length ? 0 : -1) : rows.findIndex(r => String(r.id) === session);
      // With no id named, the server deletes the day's first.
      if (op.kind === 'workout-delete') {
        rows = rows.filter((r, i) => i !== at);
        continue;
      }
      if (at >= 0 && !op.body?.new_session) rows[at] = _asShown({ ...rows[at], ...op.body, id: rows[at].id, _pending: true });
      else if (at < 0) rows.push(_asShown({ ...op.body, date: tabs[1], id: op.body?.id ?? op.tempId ?? -(op.seq || 1), _pending: true }));
    }
    return { ...(mirrored || {}), sessions: rows };
  }
  // The recent list feeds the Diary's dots, week strip and streak and the
  // Statistics heatmap, so a day logged, cleared or deleted offline has to
  // read that way there too, not only on the day itself.
  if (path === '/api/workout/recent') {
    const work = (ops || []).filter(op => op.kind === 'workout' || op.kind === 'workout-delete')
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (!work.length) return mirrored;
    const held = Array.isArray(mirrored) ? mirrored : mirrored === undefined ? [] : null;
    if (held === null) return mirrored;
    let rows = [...held];
    for (const op of work) {
      const [, date, session] = String(op.key).match(/^workout:(\d{4}-\d{2}-\d{2})#(.+)$/) || [];
      if (!date) continue;
      // With no session named, a save goes to the day's first session and a
      // delete takes the day, as on the day itself.
      const onDay = rows.filter(r => r.date === date);
      // With no session named, a save or a delete is about the day's first,
      // as on the server.
      const mine = session === 'default'
        ? onDay.sort((a, b) => (a.session_seq || 0) - (b.session_seq || 0)).slice(0, 1)
        : onDay.filter(r => String(r.id) === session);
      if (op.kind === 'workout-delete') { rows = rows.filter(r => !mine.includes(r)); continue; }
      if (mine.length && !op.body?.new_session) {
        rows = rows.map(r => (r === mine[0] ? { ...r, ...op.body, date, _pending: true } : r));
      } else {
        rows.push({ ...op.body, date, id: op.body?.id ?? op.tempId ?? -(op.seq || 1), _pending: true });
      }
    }
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  if (path === '/api/settings') {
    const queued = (ops || []).filter(op => op.kind === 'setting');
    if (!queued.length) return mirrored;
    const settings = { ...(mirrored || {}) };
    for (const op of queued) if (op.body?.key) settings[op.body.key] = op.body.value;
    return settings;
  }
  // Progress photos: one taken with no connection belongs on the timeline
  // from the moment it is taken, not when it reaches the server.
  if (path === '/api/body-stats/photos') {
    const made = (ops || []).filter(op => op.kind === 'photo-add');
    const gone = new Set((ops || []).filter(op => op.kind === 'photo-delete').map(op => Number(op.id)));
    if (!made.length && !gone.size) return mirrored;
    const held = Array.isArray(mirrored?.photos) ? mirrored.photos : mirrored === undefined ? [] : null;
    if (held === null) return mirrored;
    const waiting = made.map(op => ({
      id: op.tempId ?? -(op.seq || 1), date: op.body?.date, url: op.body?.url,
      created_at: new Date(op.at || Date.now()).toISOString(), _pending: true,
    }));
    const photos = held.filter(p => !gone.has(Number(p.id))).concat(waiting);
    return { ...(mirrored || {}), count: photos.length, photos };
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
  // A new workout of the day is a row of its own: nothing of the one held
  // here, which answered with that one's id, so the next save went there.
  const made = !!body?.new_session && body?.id == null;
  const workout = _asShown({ ...(made ? {} : (mirrored?.workout || {})), ...body, _pending: true });
  if (made || workout.id == null) workout.id = tempId;
  return { workout, tombstones: [], queued: true, offline: true };
}

/**
 * The answer a queued write hands back, shaped like the route's own.
 *
 * This matters more than it looks: the screens read these. The progress
 * photo helper refuses to carry on unless it gets `{ photo }` back, and
 * said "Could not save photo" for a photo that was safely queued, because
 * the reply was the right status with the wrong shape.
 */
export function queuedReply(op, body, tempId) {
  const now = new Date().toISOString();
  const queued = { queued: true, offline: true };
  switch (op?.kind) {
    case 'photo-add':
      return { ok: true, photo: { id: tempId, date: body?.date, url: body?.url, created_at: now }, ...queued };
    case 'profile':
      return { user: { ...(body || {}) }, ...queued };
    case 'body-stats':
      return { stats: { date: op.key?.split(':')[1] || null, stats: body?.stats || {}, updated_at: now }, ...queued };
    case 'cardio-create':
    case 'exercise-create':
    case 'prescription-create':
      return { ...(body || {}), id: tempId, created_at: now, updated_at: now, ...queued };
    case 'cardio-update':
    case 'exercise-update':
    case 'prescription-update':
      return { ...(body || {}), id: op.id, updated_at: now, ...queued };
    default:
      return { ok: true, ...(body || {}), ...queued };
  }
}

/**
 * Which kept answers to let go of, oldest first, once there are more than
 * `keep`. The copy this browser holds has to have a ceiling: a database with
 * no room left would refuse the outbox too, and then nothing could be
 * logged offline at all, which is the one thing that must not happen.
 */
export function staleAnswerKeys(rows, keep) {
  const held = (rows || []).filter(r => r && r.key != null);
  if (held.length <= keep) return [];
  return held
    .slice()
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, held.length - keep)
    .map(r => r.key);
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
    case 'profile':          return 'your profile';
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

/**
 * Queued work as it stands now some temporary ids have their real ones (a
 * replay that stopped partway): filed under the real id, so a read of that
 * workout still finds what is queued for it.
 */
export function opsAsKnown(ops, map) {
  if (!map || !Object.keys(map).length) return ops;
  const real = (id) => (id != null && map[Number(id)] != null ? map[Number(id)] : id);
  return (ops || []).map(op => {
    const m = String(op.key || '').match(/^(workout:\d{4}-\d{2}-\d{2}#)(-\d+)$/);
    if (!m || map[Number(m[2])] == null) return op;
    return { ...op, key: `${m[1]}${map[Number(m[2])]}`, tempId: real(op.tempId), body: remapIds(op.body, map) };
  });
}

/** A path that still names a temporary id, pointed at the real one. */
export function remapPath(path, map) {
  return String(path).replace(/\/(-\d+)(\b|$)/, (all, id) => {
    const real = map?.[Number(id)];
    return real != null ? `/${real}` : all;
  }).replace(/([?&]id=)(-\d+)(?=&|$)/, (all, key, id) => {
    const real = map?.[Number(id)];
    return real != null ? `${key}${real}` : all;
  });
}
