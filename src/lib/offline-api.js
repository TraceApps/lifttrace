/**
 * offline-api.js: the browser's side of working without a connection.
 *
 * Online, every call goes to the server as before and what comes back is kept
 * in IndexedDB (the mirror). When the server can't be reached, the screens
 * that matter are answered from the mirror, and what you change goes into an
 * outbox and shows at once. Back online, the outbox is replayed against the
 * same routes the Android app replays its own queue against, so the merge is
 * the one already in production: no second merge path to keep in step.
 *
 * It hangs off apiFetch.js, which already stands between the app and the
 * network, so no screen needs changing to work offline.
 *
 * Deliberately not the Background Sync API: Safari doesn't have it, and the
 * iPhone is half the point. The page flushes instead, on a backoff, on the
 * browser's own `online` event, and when the tab comes back to the front.
 *
 * Tabs share the outbox: a Web Lock keeps two of them from replaying it at
 * once, and a BroadcastChannel tells the others when it changed.
 */
import { writable } from 'svelte/store';
import {
  isOfflineError, isMirroredGet, mirrorKey, pathOf, writeOp, collapseOps, sentSeqs, OFFLINE_HEADER,
  answerWithOps, queuedWorkoutReply, newTempId, isTempId, createdId, remapIds, remapPath, orphanWorkoutSave, opsAsKnown,
  describeOp, shouldRetryStatus, staleAnswerKeys, queuedReply, newClientKey, takesClientKey,
  isKeyedCreate, byKeyPath, deletePathWithId, editPathWithId, opHeaders,
} from './offline-edits.js';
// Loaded with everything else, never fetched on demand: a picture is kept
// exactly when there is no connection to fetch a separate file with, and a
// browser whose service worker has not taken the newest build yet would have
// no copy of it. This is what "Failed to fetch dynamically imported module"
// looked like from the outside.
import { embeddableDataUrl } from './image-embed.js';
import { readDeadlineFor, queueUnsent, noteAnswered, fetchWithDeadline, sendingChange } from './request-deadline.js';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let _retryMs = RETRY_MIN_MS;
const _backoff = () => { const ms = _retryMs; _retryMs = Math.min(RETRY_MAX_MS, _retryMs * 2); return ms; };
// The server took what was waiting, or the connection came back: not quiet
// either (request-deadline.js).
const _resetBackoff = () => { _retryMs = RETRY_MIN_MS; noteAnswered(); };

/** { online, pending, syncing, error } for the header badge and Settings. */
export const offlineState = writable({
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  pending: 0,
  syncing: false,
  error: null,
  // Changes the server answered and refused. Kept, and shown once, so nothing
  // disappears without the person who made it being told.
  refused: [],
});

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
// Whose queue this is. The app clears `wl:userId` when it cannot confirm who
// is signed in, which is exactly what a reload with no connection looks like,
// so the last id this browser saw is kept here: without it the queue would be
// orphaned in a database nothing reads, and the work would never go up.
const _USER_KEY = 'lt:offline-user';
function _dbName() {
  let user = null;
  try {
    user = localStorage.getItem('wl:userId');
    if (user) localStorage.setItem(_USER_KEY, user);
    else user = localStorage.getItem(_USER_KEY);
  } catch { /* private mode */ }
  return `lifttrace-offline-${user || 'single'}`;
}
/**
 * The browser's IndexedDB, or null. A browser refusing this site storage can
 * throw just for asking (a SecurityError), and that has to read as "no
 * database" like every other way of not having one.
 */
function _idb() {
  try { return typeof indexedDB === 'undefined' ? null : indexedDB; } catch { return null; }
}

function _db() {
  const idb = _idb();
  if (!idb) return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  // The first reads of a page happen before the app knows who is signed in,
  // so they are filed under the anonymous name. Once the id turns up, bring
  // what was kept with it rather than leaving it in a database nothing reads.
  const leaving = _dbPromise?.name && _dbPromise.name !== name ? _dbPromise.name : null;
  const p = new Promise((resolve) => {
    // 4: coaching conversations kept on the device (lib/coach-messages.js).
    // Opening throws outright when the browser refuses this site storage.
    // Thrown here it rejected every read and write of this layer, so a
    // Profile save failed before any request was made (TraceApps/nutritrace#269).
    let req;
    try { req = idb.open(name, 4); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('coach_messages')) db.createObjectStore('coach_messages', { keyPath: 'uuid' });
      if (!db.objectStoreNames.contains('answers')) db.createObjectStore('answers', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('refused')) db.createObjectStore('refused', { keyPath: 'at' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    // Another tab with this database open on its old version holds an
    // upgrade back: this page works without it meanwhile and asks again
    // next time, rather than going on without it until a reload.
    let gaveUp = false;
    req.onsuccess = () => {
      const db = req.result;
      // A newer version opened in another tab: let it upgrade.
      db.onversionchange = () => { try { db.close(); } catch { /* closed */ } if (_dbPromise === p) _dbPromise = null; };
      if (gaveUp) { try { db.close(); } catch { /* closed */ } return; }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => { gaveUp = true; if (_dbPromise === p) _dbPromise = null; resolve(null); };
  });
  p.name = name;
  _dbPromise = p;
  if (leaving) p.then(db => _absorb(leaving, db));
  return p;
}

/** Move everything from an old database into this one, then drop it. */
async function _absorb(oldName, db) {
  if (!db) return;
  const old = await new Promise((resolve) => {
    let req;
    try { req = _idb()?.open(oldName); } catch { req = null; }
    if (!req) return resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!old) return;
  // The work waiting to go up and what each temporary id became always come
  // across. Copies of answers only come if nothing has been changed yet in
  // this session: this runs late, after a change may already have tidied
  // them up, and bringing a stale one back resurrects what was deleted.
  const stores = _changedSomething ? ['outbox', 'refused', 'meta'] : ['answers', 'outbox', 'refused', 'meta'];
  for (const store of stores) {
    if (!old.objectStoreNames.contains(store) || !db.objectStoreNames.contains(store)) continue;
    const rows = await new Promise((resolve) => {
      try {
        const q = old.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result || []);
        q.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    if (!rows.length) continue;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        // The outbox is keyed by a running number, so queued work is re-added
        // and given a new one rather than landing on top of something.
        for (const row of rows) { if (store === 'outbox') { const { seq, ...rest } = row; s.add(rest); } else s.put(row); }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  old.close();
  try { indexedDB.deleteDatabase(oldName); } catch { /* another tab has it open */ }
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
}
// Every read and write is wrapped: a blocked, full or private-mode database
// resolves to null instead of throwing, and the app falls back to the server.
function _tx(store, mode, fn) {
  return _db().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    let out;
    try {
      const tx = db.transaction(store, mode);
      out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
const _all = (store) => _tx(store, 'readonly', s => s.getAll()).then(r => r || []);

// How many answers to keep. Enough for a season of training (every day
// opened, every exercise looked at) and small enough that a browser never
// runs out of room because of us: a full database would refuse the outbox
// too, and then nothing could be logged offline at all.
const KEEP_ANSWERS = 400;
let _sinceTrim = 0;
// Has anything been changed since this page opened? Decides whether copies
// kept before the account was known are still safe to carry over.
let _changedSomething = false;
// Keeps two refusals in the same millisecond from landing on one another.
let _refusedSeq = 0;

const _remember = async (key, body) => {
  await _tx('answers', 'readwrite', s => s.put({ key, body, at: Date.now() }));
  // Not on every write: counting the store each time would cost more than
  // the trimming saves.
  if (++_sinceTrim >= 25) { _sinceTrim = 0; await _trimAnswers(); }
};

/** Drop the least recently kept answers, oldest first. */
async function _trimAnswers() {
  const stale = staleAnswerKeys(await _all('answers'), KEEP_ANSWERS);
  if (stale.length) await _tx('answers', 'readwrite', s => { for (const key of stale) s.delete(key); });
}

/**
 * What was last seen for this call. An exact match first (the query is part
 * of the key), then the same path without one, so a day read as
 * `?id=4` still finds the copy taken from the plain read.
 */
async function _recall(url) {
  const exact = await _tx('answers', 'readonly', s => s.get(mirrorKey(url)));
  if (exact) return exact.body;
  const path = pathOf(url);
  const byPath = await _tx('answers', 'readonly', s => s.get(path));
  if (byPath) return byPath.body;
  const rows = await _all('answers');
  return rows.find(r => pathOf(r.key) === path)?.body;
}

/** What was last seen for exactly this call, with no fallback. */
async function _recallExact(key) {
  return (await _tx('answers', 'readonly', s => s.get(key)))?.body;
}

// A day can hold more than one workout (#76). Each is kept under its own id
// (`?id=`), and the plain day under the day's first: a save of another one
// filed there made a read of the day, or of another workout, answer with it.
const _WORKOUT_DAY = /^\/api\/workout\/\d{4}-\d{2}-\d{2}$/;
const _WORKOUT_READ = /^\/api\/workout\/(\d{4}-\d{2}-\d{2})(?:\/sessions)?$/;
const _wantedWorkout = (url) => {
  if (!_WORKOUT_DAY.test(pathOf(url))) return null;
  const id = new URLSearchParams(String(url).split('?')[1] || '').get('id');
  return id != null && id !== '' ? Number(id) : null;
};
/** The copy held for one workout, by id: only that workout's. */
async function _recallWorkout(path, id) {
  const own = await _recallExact(`${path}?id=${id}`);
  if (own) return own;
  const day = await _recallExact(path);
  return day?.workout && Number(day.workout.id) === Number(id) ? day : undefined;
}
/**
 * The day's first workout as held here: the plain day's copy, else the
 * earliest of the workouts held by id. Any copy of the path would do for
 * other calls, but here it could be the day's second workout.
 */
async function _recallDay(path) {
  const row = await _tx('answers', 'readonly', s => s.get(path));
  if (row?.body?.workout) return row.body;
  // None held for the day, or its first deleted here: the earliest still
  // there, of the copies taken since (an older one may be of a workout
  // deleted since, here or elsewhere).
  const held = (await _all('answers'))
    .filter(r => r.key !== path && pathOf(r.key) === path && r.body?.workout && !r.body.workout.deleted_at && (!row || row.body?.deletedHere || r.at > row.at))
    .sort((a, b) => (a.body.workout.session_seq ?? Infinity) - (b.body.workout.session_seq ?? Infinity) || a.at - b.at);
  return held[0]?.body ?? row?.body;
}
async function _rememberWorkout(path, workout, day) {
  if (workout?.id != null) await _remember(`${path}?id=${workout.id}`, { workout });
  // The plain day is its first workout, or this one when none is known.
  const first = day?.workout?.id;
  if (first == null || Number(first) === Number(workout?.id)) await _remember(path, { workout });
}
/** The fields the caller says it changed (X-Changed-Fields), if it said. */
function _callerChanged(init) {
  const h = init?.headers;
  if (!h) return null;
  const v = typeof h.get === 'function' ? h.get('X-Changed-Fields') : (h['X-Changed-Fields'] ?? h['x-changed-fields']);
  return typeof v === 'string' ? v.split(',').map(f => f.trim()).filter(Boolean) : null;
}

// ── When an edit was made, and what it changed ──────────────────────
// The server keeps the newer edit of each field (server/lib/newer-wins.js).
// A change queued here goes up with the time it was made, on the server's
// clock (this browser's, corrected by the difference seen on the last answer:
// X-Server-Time), and the fields it changed against the copy shown when it
// was made. Without them the server took it as made when it arrived, and
// a change made offline overwrote a later one made elsewhere.
const _CLOCK_KEY = 'lt:clockOffset';
function _noteClock(res, sentAt) {
  try {
    const ms = Date.parse(res?.headers?.get?.('x-server-time') || '');
    // Taken as the request arrives there: against when it left here, never
    // when the answer finished arriving (a slow answer put the clock behind).
    if (Number.isFinite(ms)) localStorage.setItem(_CLOCK_KEY, String(Math.round(ms - sentAt)));
  } catch { /* no header, or no storage */ }
}
function _serverNow(at = Date.now()) {
  let off = 0;
  try { off = Number(localStorage.getItem(_CLOCK_KEY)) || 0; } catch { /* no storage */ }
  return new Date(at + off).toISOString();
}
const _EDIT_FIELDS = [
  [/^\/api\/programs\/\d+$/, ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete']],
  [/^\/api\/templates\/\d+$/, ['name', 'day_label']],
  [/^\/api\/exercises\/\d+$/, ['name', 'category', 'primary_muscles', 'secondary_muscles', 'equipment', 'instructions', 'tips', 'img_url', 'gif_url', 'video_url', 'load_type', 'set_type']],
  [/^\/api\/workout\/\d{4}-\d{2}-\d{2}$/, ['name', 'notes', 'duration_min', 'completed', 'program_week', 'program_id', 'template_id']],
];
const _norm = (v) => {
  if (v === undefined || v === '') v = null;
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* text */ } }
  if (typeof v === 'boolean') v = v ? 1 : 0;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  return JSON.stringify(v ?? null);
};
/** The fields a queued edit changes against the copy held here; null when
 *  there's no copy to tell by (the server then takes all it sends). */
async function _changedFields(method, target, body) {
  if (method !== 'PUT' || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const p = pathOf(target);
  if (p === '/api/settings') return typeof body.key === 'string' ? ['value'] : null;
  try {
    // Against the copy as shown here: what the server sent, with what's
    // queued here and not sent yet over it. Against the server's copy alone,
    // a second change counted the first one's fields again, as made with it.
    const queued = await _loadOps();
    if (/^\/api\/body-stats\/\d{4}-\d{2}-\d{2}$/.test(p)) {
      let held = (await _recall(target))?.stats?.stats;
      if (!held || !body.stats || typeof body.stats !== 'object') return null;
      const date = p.split('/').pop();
      for (const op of queued || []) if (op?.kind === 'body-stats' && op.key === `body:${date}` && op.body?.stats && typeof op.body.stats === 'object') held = { ...held, ...op.body.stats };
      return Object.keys(body.stats).filter(k => _norm(body.stats[k]) !== _norm(held[k]));
    }
    // An excused day (issue #121): against the list held here.
    const excused = p.match(/^\/api\/excused-days\/(\d{4}-\d{2}-\d{2})$/);
    if (excused) {
      const list = await _recall('/api/excused-days');
      const held = Array.isArray(list) ? list.find(r => r.date === excused[1]) : null;
      if (!held) return null;
      return ['reason', 'note'].filter(f => body[f] !== undefined && _norm(body[f]) !== _norm(held[f]));
    }
    const rule = _EDIT_FIELDS.find(([re]) => re.test(p));
    if (!rule) return null;
    let held = await _recall(target);
    if (/^\/api\/workout\//.test(p)) {
      if (body.id != null && _WORKOUT_DAY.test(p)) held = await _recallWorkout(p, body.id);
      if (held && _WORKOUT_DAY.test(p)) held = answerWithOps(p, held, queued, held?.workout?.id);
      held = held?.workout;
      if (held && body.id != null && Number(held.id) !== Number(body.id)) held = null;
    } else if (held) held = answerWithOps(p, held, queued);
    if (!held || typeof held !== 'object') return null;
    return rule[1].filter(f => body[f] !== undefined && _norm(body[f]) !== _norm(held[f]));
  } catch { return null; }
}

// ── Outbox ───────────────────────────────────────────────────────────
let _ops = null;
async function _loadOps() {
  if (!_ops) _ops = await _all('outbox');
  return _ops;
}
function _publish(extra = {}) {
  offlineState.update(s => ({ ...s, pending: _ops?.length || 0, ...extra }));
}

/** Changes the server refused, so a screen can say so and let them go. */
export async function refusedChanges() {
  return (await _all('refused')).sort((a, b) => a.at - b.at);
}
export async function forgetRefused() {
  await _tx('refused', 'readwrite', s => s.clear());
  _publish({ refused: [] });
}
const _channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lifttrace-offline') : null;
_channel?.addEventListener('message', async (e) => {
  if (e.data?.type !== 'outbox') return;
  if (e.data.ids) { _swapped = { ..._swapped, ...e.data.ids }; _announceIds(e.data.ids); }
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lt:offline-synced'));
  }
});

// The Diary follows a workout made here to the id the server gave it, as on
// Android (stores/workout.js), so the next save goes to that workout.
function _announceIds(map) {
  if (typeof window === 'undefined') return;
  const pairs = Object.entries(map || {}).map(([from, to]) => [Number(from), Number(to)]);
  if (pairs.length) window.dispatchEvent(new CustomEvent('lt:workout-ids', { detail: { map: pairs } }));
}

/**
 * What each temporary id became. A screen already open goes on showing the
 * id a row was created with offline, so a change made right after the queue
 * goes up would otherwise be sent against an id the server never had.
 */
let _swapped = {};
// Kept on disk as well as in memory. A flush that stops halfway (the page is
// closed, the signal goes again) leaves queued work that refers to a row the
// server has just created; without the map that work would be sent against
// an id the server never had. NoteTrace has always done this.
async function _loadSwapped() {
  const kept = await _tx('meta', 'readonly', s => s.get('idMap'));
  if (kept) _swapped = { ...kept, ..._swapped };
  return _swapped;
}
async function _rememberSwapped(map) {
  _swapped = { ..._swapped, ...map };
  await _tx('meta', 'readwrite', s => s.put(_swapped, 'idMap'));
}

const _json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});
// Long workout lists only Trace asks for, reaching years back: read from the
// server each time, not kept (the usual short list is).
const _tooBigToKeep = (url) => /\/api\/workout\/recent$/.test(pathOf(url))
  && Number(new URLSearchParams(String(url).split('?')[1] || '').get('limit')) > 500;
// This browser would not keep a change to send later (storage full, blocked
// or broken). Not "offline": the screen says what actually went wrong.
const _storageReply = () => _json(507, { error: 'This browser could not keep the change to send later.', storage: true });

// Names a row made here that the server has never had.
const _namesTempId = (path, body) => /\/-\d/.test(String(path)) || /"(id|[a-z_]+_id|tempId)":-\d/.test(JSON.stringify(body ?? null));

/**
 * Send a request that supersedes queued ones with the same key (a profile
 * save carries the whole profile), and drop those once it lands. Held under
 * the flush's lock, so a flush in this or another tab can't send an older
 * one after it.
 */
function _superseding(key, send) {
  const run = async () => {
    const res = await send();
    if (res.ok) {
      const stale = (await _all('outbox')).filter(op => op.key === key).map(op => op.seq);
      if (stale.length) {
        await _tx('outbox', 'readwrite', s => { for (const seq of stale) s.delete(seq); });
        _channel?.postMessage({ type: 'outbox' });
      }
      _ops = null;
      await _loadOps();
      _publish();
    }
    return res;
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('lifttrace-offline-flush', run);
  }
  // No Web Locks (a page on plain http): stand in for the flush, so one
  // that starts meanwhile waits for this rather than sending the older one.
  const mine = (_flushing || Promise.resolve()).catch(() => {}).then(run);
  const held = mine.then(() => false, () => false).finally(() => { if (_flushing === held) { _flushing = null; _scheduleFlush(0); } });
  _flushing = held;
  return mine;
}

const _offlineReply = (url) => {
  // Shows up in Settings, Diagnostics: which call had no copy to answer with.
  if (url) console.debug('[offline] no copy held for', String(url));
  return _json(503, { error: 'This needs a connection.', offline: true });
};

async function _queue(op) {
  const ops = await _loadOps();
  let seq = await _tx('outbox', 'readwrite', s => s.add(op));
  if (seq == null) {
    // Out of room, most likely. What you have changed matters more than a
    // copy of something you can read again later, so make space and retry
    // before telling anyone this cannot be saved.
    await _tx('answers', 'readwrite', s => s.clear());
    seq = await _tx('outbox', 'readwrite', s => s.add(op));
  }
  // No database to queue into (private mode, no space at all): say so rather
  // than pretending it was saved.
  if (seq == null) return null;
  op.seq = seq;
  ops.push(op);
  _publish({ online: _online() });
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return op;
}

// ── Sending ──────────────────────────────────────────────────────────
let _fetch = null;          // the browser's own fetch, before any patching
let _retry = null;
let _flushing = null;

function _scheduleFlush(ms = 0) {
  clearTimeout(_retry);
  _retry = setTimeout(() => { flushOutbox(); }, ms);
}

/** Replay what's waiting. Resolves true when the outbox is empty afterwards. */
export function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const run = () => _flushOnce();
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('lifttrace-offline-flush', run);
      }
      return await run();
    } finally {
      _flushing = null;
    }
  })();
  return _flushing;
}

async function _flushOnce() {
  _ops = null;
  const ops = await _loadOps();
  if (!ops.length) { _publish({ syncing: false, error: null, online: _online() }); return true; }
  if (!_online()) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });

  const send = _fetch || ((...a) => fetch(...a));
  // What this run sends. A change queued while it runs joins the same list
  // (_queue) but is not part of this run: it waits for the next, even when
  // it is of something this run sent (a delete or an edit of a row whose
  // create is on its way up), or it was cleared with it, never sent.
  const mine = new Set(ops.map(o => o.seq));
  await _loadSwapped();
  const done = new Set();
  const refused = [];
  // The workouts the server answered with, filed again once the replay is done.
  const answered = [];
  // Ids learned in an earlier run apply to what is still queued from it.
  const map = { ..._swapped };
  let stopped = null;

  for (const op of collapseOps(ops)) {
    const path = remapPath(op.path, map);
    // Deleted before its create's answer came back, the create tried and
    // maybe made (offline-edits.js deleteOfSent): by the create's key while
    // the server's id for it is still unknown here.
    if (op.byKey && /\/-\d+$|[?&]id=-\d+(&|$)/.test(path)) {
      let outcome;
      try {
        outcome = await _deleteByKey(op, send, map);
      } catch (err) {
        stopped = isOfflineError(err) ? { offline: true } : { error: err.message || 'failed' };
        break;
      }
      if (outcome.retry) { stopped = { error: outcome.retry }; break; }
      if (outcome.refused) {
        refused.push({ at: Date.now() * 1000 + (_refusedSeq = (_refusedSeq + 1) % 1000), what: describeOp(op), reason: outcome.refused });
        console.error(`[offline] your server refused ${describeOp(op)}: ${outcome.refused} (${op.method} ${op.path})`);
      }
      if (op.key) done.add(op.key);
      continue;
    }
    // A create that may reach the server from here on (its answer could be
    // lost): noted before it goes, so deleting it here later can't simply
    // drop it (offline-edits.js deleteOfSent).
    if (isKeyedCreate(op)) await _noteSent(ops, op.key);
    const orphan = orphanWorkoutSave(op, map, ops);
    const body = op.body == null ? undefined : JSON.stringify(remapIds(orphan ?? op.body, map));
    let res;
    try {
      const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opHeaders(op) };
      const sentAt = Date.now();
      res = await send(path, {
        method: op.method,
        credentials: 'include',
        headers: Object.keys(headers).length ? headers : undefined,
        body,
      });
      _noteClock(res, sentAt);
    } catch (err) {
      // Still unreachable: keep everything and try again later.
      if (isOfflineError(err)) { stopped = { offline: true }; break; }
      stopped = { error: err.message || 'failed' };
      break;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let answer = null;
      try { answer = await res.clone().json(); message = answer?.error || message; } catch { /* not json */ }
      // A create sent again whose row was deleted since (its key told the
      // server it had made it, create-keys.js): what it asked for was done,
      // so it goes quietly rather than as a refusal.
      if (res.status === 410 && answer?.gone === true) { if (op.key) done.add(op.key); continue; }
      // A server that is struggling deserves another go later, and everything
      // behind this waits with it so nothing arrives out of order.
      if (shouldRetryStatus(res.status)) { stopped = { error: message }; break; }
      // A refusal is the server's answer: trying again will not change it.
      // Set it aside, tell the person later, and carry on with the rest, so
      // one rejected change cannot hold up everything queued behind it.
      refused.push({ at: Date.now() * 1000 + (_refusedSeq = (_refusedSeq + 1) % 1000), what: describeOp(op), reason: message });
      // Also into the log behind Settings, Diagnostics: a toast lasts four
      // seconds, and someone who looked away still deserves to find out.
      console.error(`[offline] your server refused ${describeOp(op)}: ${message} (${op.method} ${op.path})`);
      if (op.key) done.add(op.key);
      continue;
    }
    if (op.kind === 'workout') {
      try { const w = (await res.clone().json())?.workout; if (w) answered.push({ path: pathOf(path), workout: w }); } catch { /* not json */ }
    }
    const madeAs = op.tempId ?? (orphan ? op.body.id : null);
    if (madeAs != null) {
      let created = null;
      try { created = createdId(await res.clone().json()); } catch { /* not json */ }
      if (created != null) map[Number(madeAs)] = created;
    }
    // Changed again before it went up: if the server had made it already
    // (its answer lost), it answered with the row as first made. The change
    // goes after it as its own edit, and if that can't go yet, all of it
    // stays to go again (the create's key makes the repeat harmless).
    const real = madeAs != null ? map[Number(madeAs)] : null;
    if (op.edits && real != null) {
      const headers = { 'Content-Type': 'application/json' };
      if (op.editsAt) headers['X-Edited-At'] = op.editsAt;
      if (Array.isArray(op.editsChanged)) headers['X-Changed-Fields'] = op.editsChanged.join(',');
      if (op.editsFieldEdits && Object.keys(op.editsFieldEdits).length) headers['X-Field-Edits'] = JSON.stringify(op.editsFieldEdits);
      let edit;
      try {
        const { client_key, ...edits } = op.edits;
        edit = await send(editPathWithId({ ...op, path }, real), { method: 'PUT', credentials: 'include', headers, body: JSON.stringify(remapIds(edits, map)) });
      } catch (err) {
        stopped = isOfflineError(err) ? { offline: true } : { error: err.message || 'failed' };
        break;
      }
      if (!edit.ok) {
        let message = `HTTP ${edit.status}`;
        try { message = (await edit.clone().json())?.error || message; } catch { /* not json */ }
        if (shouldRetryStatus(edit.status)) { stopped = { error: message }; break; }
        refused.push({ at: Date.now() * 1000 + (_refusedSeq = (_refusedSeq + 1) % 1000), what: describeOp({ ...op, kind: op.kind.replace('-create', '-update') }), reason: message });
        console.error(`[offline] your server refused ${describeOp({ ...op, kind: op.kind.replace('-create', '-update') })}: ${message} (PUT ${editPathWithId({ ...op, path }, real)})`);
      }
    }
    if (op.key) done.add(op.key);
  }

  if (refused.length) {
    await _tx('refused', 'readwrite', s => { for (const r of refused) s.put(r); });
  }

  if (Object.keys(map).length) {
    await _rememberSwapped(map);
    _channel?.postMessage({ type: 'outbox', ids: map });
    _announceIds(map);
  }

  const cleared = new Set(sentSeqs(ops.filter(o => mine.has(o.seq)), [...done]));
  if (cleared.size) {
    await _tx('outbox', 'readwrite', s => { for (const seq of cleared) s.delete(seq); });
    _ops = ops.filter(op => !cleared.has(op.seq));
  }

  const standing = await refusedChanges();
  if (stopped) {
    _publish({ syncing: false, online: stopped.offline ? false : _online(), error: stopped.error || null, refused: standing });
    _scheduleFlush(_backoff());
    return false;
  }
  // What the replay changed is out of date here, so it goes; everything else
  // stays. Clearing the lot would leave someone who reconnects for a moment
  // and loses signal again with nothing at all to look at.
  await _forgetTouched(collapseOps(ops));
  await _refileWorkouts(answered);
  _resetBackoff();
  _publish({ syncing: false, error: null, online: true, refused: standing });
  _channel?.postMessage({ type: 'outbox', synced: true, ids: map });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lt:offline-synced'));
  // Anything changed while this replay was running is in the database but
  // not in the copy this run started from, and a flush asked for while one
  // is running is answered with the running one. Read it back and go again,
  // or that work waits for something else to happen to notice it.
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
  return !(_ops?.length);
}

/** Every queued request of this thing marked as tried, here and stored. */
async function _noteSent(ops, key) {
  const fresh = (ops || []).filter(o => o.key === key && !o.sent);
  if (!fresh.length) return;
  for (const o of fresh) o.sent = true;
  // Only rows still there as they were: one cleared meanwhile (another
  // account signing in, another tab done with it) must not come back.
  await _tx('outbox', 'readwrite', s => {
    for (const o of fresh) {
      const got = s.get(o.seq);
      got.onsuccess = () => { const row = got.result; if (row && row.key === key) s.put({ ...row, sent: true }); };
    }
  });
}

/**
 * A delete of a row whose create was tried but whose answer never came, so
 * the server's id for it is unknown: sent by the create's key, which finds
 * the row that create made, or, if it never arrived, makes sure it makes
 * none when it does (server/lib/create-keys.js rowForKey). A server from
 * before that route answers 404: the create goes again, which its key makes
 * harmless (the server answers with the row it made, or makes it), and the
 * row it names is deleted by id. Answers `{}` when done, `{ retry }` to try
 * again later, `{ refused }` with the server's reason.
 */
async function _deleteByKey(op, send, map) {
  const headers = op.editedAt ? { 'X-Edited-At': op.editedAt } : {};
  const failed = async (res) => {
    let message = `HTTP ${res.status}`;
    try { message = (await res.clone().json())?.error || message; } catch { /* not json */ }
    return shouldRetryStatus(res.status) ? { retry: message } : { refused: message };
  };
  const res = await send(byKeyPath(op), { method: 'DELETE', credentials: 'include', headers });
  let answer = null;
  try { answer = await res.clone().json(); } catch { /* not json */ }
  if (res.ok && answer?.by_key === true) return {};
  // Not found by a server that has the route (a prescription of a client
  // no longer coached): its answer, not a server from before.
  if (!res.ok && (res.status !== 404 || (op.kind === 'prescription-delete' && answer?.by_key === true))) return failed(res);
  // A server from before keeps no keys for prescriptions: sent again, the
  // create would make a second one (and tell the client twice) while the
  // first stayed. Said instead, so the coach removes it once it shows.
  if (op.kind === 'prescription-delete') return { refused: 'This server is too old to remove it yet. If it shows in the list, remove it again.' };
  // Dated as the create was, as a replay of it is: dated now, it would
  // count as an edit made after the delete, which then loses to it.
  const again = { 'Content-Type': 'application/json' };
  if (op.byKey.editedAt) again['X-Edited-At'] = op.byKey.editedAt;
  if (Array.isArray(op.byKey.changed)) again['X-Changed-Fields'] = op.byKey.changed.join(',');
  const made = await send(op.byKey.path, {
    method: op.byKey.method, credentials: 'include', headers: again,
    body: JSON.stringify(remapIds(op.byKey.body, map)),
  });
  if (!made.ok) {
    // Deleted since it was made: nothing left to delete.
    let gone = null;
    try { gone = await made.clone().json(); } catch { /* not json */ }
    if (made.status === 410 && gone?.gone === true) return {};
    return failed(made);
  }
  let id = null;
  try { id = createdId(await made.clone().json()); } catch { /* not json */ }
  if (id == null) return { refused: 'The server did not say which row it made.' };
  const del = await send(deletePathWithId(op, id), { method: 'DELETE', credentials: 'include', headers });
  if (del.ok || del.status === 404) return {};
  return failed(del);
}

/**
 * Drop the kept answers a replayed change makes stale: the thing itself, and
 * the lists it appears on. Everything else is still good to read offline.
 */
async function _forgetTouched(sent) {
  const prefixes = new Set();
  const exact = new Set();
  for (const op of sent) {
    const path = pathOf(op.path);
    // A workout: what it changes, not every workout held. Dropping the lot
    // left the day, and every other day, unreadable offline after any save
    // made online, until each was opened again. The workout itself is filed
    // again from the server's answer (_refileWorkouts).
    if ((op.kind === 'workout' || op.kind === 'workout-delete') && _WORKOUT_DAY.test(path)) {
      const ids = [op.body?.id, _wantedWorkout(op.path), op.tempId].filter(id => id != null);
      for (const id of ids) exact.add(`${path}?id=${id}`);
      // A new workout of the day leaves the day's first as it is.
      const made = !!op.body?.new_session && op.body?.id == null;
      const first = (await _recallExact(path))?.workout?.id;
      if (made ? first != null && Number(first) === Number(op.tempId)
        : !ids.length || first == null || ids.some(id => Number(id) === Number(first))) exact.add(path);
      prefixes.add(`${path}/sessions`);
      prefixes.add('/api/workout/recent');
      prefixes.add('/api/workout/history');
      prefixes.add('/api/stats');
      continue;
    }
    prefixes.add(path);
    const parent = path.replace(/\/(-?\d+)(\/[a-z-]+)?$/, '');
    if (parent && parent !== path) prefixes.add(parent);
    if (op.kind?.startsWith('workout')) { prefixes.add('/api/workout'); prefixes.add('/api/stats'); }
    if (op.kind?.startsWith('cardio')) prefixes.add('/api/cardio');
    if (op.kind?.startsWith('exercise')) prefixes.add('/api/exercises');
    if (op.kind?.startsWith('program')) prefixes.add('/api/programs');
    if (op.kind === 'body-stats') prefixes.add('/api/body-stats');
    // An excused day pauses a calendar program (#121): its week changes too.
    if (op.kind?.startsWith('excused')) { prefixes.add('/api/excused-days'); prefixes.add('/api/programs'); }
    if (op.kind?.startsWith('photo')) prefixes.add('/api/body-stats');
    if (op.kind?.startsWith('coach') || op.kind?.startsWith('prescription') || op.kind === 'seen') {
      prefixes.add('/api/trainer'); prefixes.add('/api/coach-feedback'); prefixes.add('/api/prescriptions');
    }
    if (op.kind === 'setting') prefixes.add('/api/settings');
    if (op.kind === 'profile') prefixes.add('/api/auth/me');
  }
  const rows = await _all('answers');
  const stale = rows.filter(r => exact.has(r.key) || [...prefixes].some(p => pathOf(r.key) === p || pathOf(r.key).startsWith(p + '/')));
  if (stale.length) await _tx('answers', 'readwrite', s => { for (const r of stale) s.delete(r.key); });
}

/** Workouts the server just answered for, filed again: the freshest copy
 *  there is, and what a read of that day finds with no connection. */
async function _refileWorkouts(answered) {
  for (const { path, workout } of answered) {
    if (workout?.id != null) await _rememberWorkout(path, workout, await _recallDay(path));
  }
}

/**
 * The coaching conversations kept in this account's database: their own
 * store, sent by lib/coach-messages.js rather than the outbox (a message
 * keeps its uuid and is shown as waiting until the server has it).
 */
export const coachStore = {
  /** Is the database there to keep things in (not blocked, not private mode)? */
  available: async () => !!(await _db()),
  all: (store) => _all(store),
  put: (store, rows) => _tx(store, 'readwrite', s => { for (const r of rows) s.put(r); return true; }),
  del: (store, keys) => _tx(store, 'readwrite', s => { for (const k of keys) s.delete(k); return true; }),
};

/** How much is waiting to go up. */
export async function pendingCount() {
  return (await _loadOps()).length;
}

/** Clear the mirror and the queue, e.g. on sign-out. */
export async function clearOffline() {
  await _tx('answers', 'readwrite', s => s.clear());
  await _tx('outbox', 'readwrite', s => s.clear());
  await _tx('refused', 'readwrite', s => s.clear());
  await _tx('coach_messages', 'readwrite', s => s.clear());
  _ops = [];
  _swapped = {};
  _dbPromise = null;
  try { localStorage.removeItem(_USER_KEY); } catch { /* private mode */ }
  _publish({ syncing: false, error: null });
}

// ── The interceptor ──────────────────────────────────────────────────

/**
 * Wire up the listeners and remember the unpatched fetch. Called once, from
 * apiFetch.js, before the app boots.
 */
export function installOffline(origFetch) {
  _fetch = origFetch || _fetch;
  if (typeof window === 'undefined' || window.__ltOfflineWired) return;
  window.__ltOfflineWired = true;
  window.addEventListener('online', () => { _resetBackoff(); _publish({ online: true }); _scheduleFlush(0); });
  window.addEventListener('offline', () => _publish({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _online()) _scheduleFlush(0);
  });
  // A queue left from last time goes up even if the first screen opened
  // never calls the API.
  _loadSwapped().catch(() => {});
  _loadOps().then(() => { _publish(); if (_ops.length) _scheduleFlush(0); });
}

const _bodyOf = (init) => {
  const raw = init?.body;
  if (typeof raw !== 'string') return undefined;      // FormData: an upload, not ours
  try { return JSON.parse(raw); } catch { return undefined; }
};

// Reads the server answers by asking another service (Trace, the music and
// radio proxies, NutriTrace, update checks, the exercise sources) or that
// carry a whole account (backups, imports) wait as long as they take
// (request-deadline.js). Stats, history and whole lists get longer, for a
// small server with years of training. Under BASE_URL the path starts with it.
const _SLOW_READS = /\/api\/(ai(?!\/history)|proxy|radio-proxy|subsonic|updates|nt|full-backup|exercise-import|workout-import|exercises\/sources)(\/|\?|$)/;
// The server's own routes (server/routes/stats.js, workout.js, exercises.js,
// cardio.js, body-stats.js, set-media.js).
const _HEAVY_READS = /\/api\/(stats\/[^/?]+(\/[^/?]+)?|workout\/(recent|history\/[^/?]+)|exercises(\/usage)?|cardio(\/stats\/weekly)?|body-stats\/(range|photos)|set-media(\/usage)?)(\?|$)/;

/** How long a read may wait for the server, or null to wait as long as it takes. */
export function readDeadlineMsFor(url) {
  const p = pathOf(String(url));
  return readDeadlineFor(_SLOW_READS.test(p) ? 'slow' : _HEAVY_READS.test(p) ? 'heavy' : 'read');
}

/**
 * A read with a deadline for a server that doesn't answer, kept with the
 * caller's own signal: it then answers from the copy kept here or says it
 * needs a connection, as with none. Past it, no connection
 * (request-deadline.js). A change that is sent waits as long as it takes.
 */
function _timed(send, ms) {
  return (url, init = {}) => fetchWithDeadline(send, url, init, ms);
}

/**
 * The web app's request, with the mirror and the outbox behind it. Returns a
 * Response either way, so nothing above this knows the difference.
 */
export async function offlineFetch(url, init, origFetch) {
  _fetch = origFetch || _fetch;
  const method = (init?.method || 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  // A read that brings its own signal has its own deadline (the sign-in check).
  const send = isRead && !_SLOW_READS.test(pathOf(String(url)))
    ? _timed(origFetch || _fetch, init?.signal ? null : readDeadlineMsFor(url))
    : (origFetch || _fetch);

  if (method === 'GET' || method === 'HEAD') {
    // A row made here, by the id the server has since given it.
    url = remapPath(String(url), _swapped);
    const wanted = _wantedWorkout(url);
    const fromHere = async () => {
      if (!isMirroredGet(url)) return _offlineReply(url);
      const ops = opsAsKnown(await _loadOps(), _swapped);
      // One workout of the day: that workout's copy, never another's.
      const answer = wanted != null
        ? answerWithOps(url, await _recallWorkout(pathOf(url), wanted), ops, (await _recallDay(pathOf(url)))?.workout?.id)
        : answerWithOps(url, _WORKOUT_DAY.test(pathOf(url)) ? await _recallDay(pathOf(url)) : await _recall(url), ops);
      // Even with no copy of this call, what is queued for it may be the whole
      // answer: a day never opened online, with a run logged on it here.
      if (answer === undefined) return _offlineReply(url);
      return _json(200, answer, { [OFFLINE_HEADER]: '1' });
    };
    // A workout started here and still waiting to go up: the server has
    // never had its id, so the answer is here.
    if (wanted != null && isTempId(wanted)) return fromHere();
    try {
      const sentAt = Date.now();
      const res = await send(url, init);
      _noteClock(res, sentAt);
      if (res.ok && isMirroredGet(url) && !_tooBigToKeep(url)) {
        try { await _remember(mirrorKey(url), await res.clone().json()); } catch { /* not json */ }
      }
      // A coach who no longer coaches this client (they left, or the
      // coaching ended): the copies of their pages go, so none opens later
      // with no connection.
      const formerClient = res.status === 404 ? pathOf(url).match(/\/api\/trainer\/members\/(\d+)(\/|$)/) : null;
      if (formerClient) {
        // Kept under the path as asked (a BASE_URL subpath included).
        const prefix = pathOf(url).slice(0, formerClient.index) + `/api/trainer/members/${formerClient[1]}`;
        const keys = (await _all('answers')).map(r => r.key).filter(k => k === prefix || k.startsWith(prefix + '/') || k.startsWith(prefix + '?'));
        if (keys.length) await _tx('answers', 'readwrite', st => { for (const k of keys) st.delete(k); });
      }
      _publish({ online: true });
      // A workout day, or its tabs, with saves of it still waiting to go up:
      // the server's answer with them on top, as with no connection. Read as
      // the server has it, the next save (Trace's, built on that) went up in
      // their place and they were lost.
      const day = res.ok ? pathOf(url).match(_WORKOUT_READ) : null;
      if (day) {
        const ops = opsAsKnown(await _loadOps(), _swapped);
        if (ops.some(op => (op.kind === 'workout' || op.kind === 'workout-delete') && op.key.startsWith(`workout:${day[1]}#`))) {
          try {
            const fresh = await res.clone().json();
            const first = wanted != null ? (await _recallDay(pathOf(url)))?.workout?.id : undefined;
            const answer = answerWithOps(url, fresh, ops, first);
            if (answer !== fresh) return _json(200, answer);
          } catch { /* not json */ }
        }
      }
      return res;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
      return fromHere();
    }
  }

  // An upload with no server to upload to: hand back the photo itself,
  // scaled down, so it can travel inside the row it belongs to. The server
  // turns it back into a file when the queue goes up.
  if (/^\/api\/upload(\/body-stats|\/exercise-media)?$/.test(String(url).split('?')[0]) && init?.body instanceof FormData) {
    const file = init.body.get('file');
    // A video is far too big to carry inside a row, so that one still waits
    // for a connection; a picture or an animation does not have to.
    const isVideo = String(file?.type || '').startsWith('video/');
    if (file && !isVideo && (!_online() || (await _loadOps()).length)) {
      try {
        const embedded = await embeddableDataUrl(file);
        // The exercise-media route answers with the kind as well as the url.
        const kind = /^data:image\/gif/i.test(embedded) ? 'gif' : 'img';
        return _json(200, { url: embedded, kind, queued: true, offline: true });
      } catch (err) {
        return _json(413, { error: err.message, offline: true });
      }
    }
  }

  let body = _bodyOf(init);
  // A save naming its workout is a change of that one: a `new_session` left
  // on it (carried over from an earlier answer) would start another.
  if (method === 'PUT' && body?.new_session && body.id != null && _WORKOUT_DAY.test(pathOf(url))) {
    body = { ...body };
    delete body.new_session;
    delete body.client_key;
    init = { ...init, body: JSON.stringify(body) };
  }
  // A row made here that the server has since given its own id: by that id,
  // also for a save sent straight up (one prepared before the swap was heard).
  if (body && typeof body === 'object' && Object.keys(_swapped).length) {
    const remapped = remapIds(body, _swapped);
    if (JSON.stringify(remapped) !== JSON.stringify(body)) {
      body = remapped;
      init = { ...init, body: JSON.stringify(body) };
    }
  }
  const target = remapPath(String(url), _swapped);
  const op = writeOp(method, target, body);
  if (!op) {
    // Uploads, imports, Trace, admin: still the server's job.
    try {
      return await send(url, init);
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
      return _offlineReply(url);
    }
  }

  // A create carries a key made here before it is first tried, and keeps it
  // in the queue: sent again because its answer was lost (tried straight
  // away, or replayed), the server answers with the row it made instead of
  // making a second, and sends no second webhook (server/lib/create-keys.js),
  // as for the Android app. A server from before keys ignores it.
  if (!body?.client_key && takesClientKey(op, body)) {
    body = { ...body, client_key: newClientKey() };
    init = { ...init, body: JSON.stringify(body) };
  }

  _changedSomething = true;
  const queued = await _loadOps();
  const direct = async () => {
    const sentAt = Date.now();
    const res = await send(target, init);
    _noteClock(res, sentAt);
    if (res.ok) {
      // What the route just answered is the freshest copy there is.
      let answered = null;
      try { answered = (await res.clone().json())?.workout ?? null; } catch { /* not json */ }
      // Whatever this change makes stale goes, the same as after a
      // replay. Without this, something deleted while online was still in
      // the copy held here, and came back the moment the connection did
      // not: the lists are read from that copy, and nothing had told them.
      await _forgetTouched([{ ...op, path: target, body }]);
      if (op.kind === 'workout' && answered) await _refileWorkouts([{ path: pathOf(target), workout: answered }]);
      _publish({ online: true, error: null });
    }
    return res;
  };
  // Your profile carries the whole profile and nothing else in the queue
  // depends on it, so only an earlier save of it still waiting holds it
  // back (that one is dropped once this lands). Anything else waits behind
  // what is queued, so changes go up in the order they were made
  // (TraceApps/nutritrace#269).
  const isProfile = op.kind === 'profile';
  // A server that has just gone quiet isn't waited on again: the queue.
  const tried = _online() && !queueUnsent() && (isProfile || !queued.length);
  if (tried) {
    try {
      return await sendingChange(() => isProfile && queued.some(o => o.key === 'profile') ? _superseding('profile', direct) : direct());
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
    }
  }

  const MAKES_A_ROW = ['exercise-create', 'cardio-create', 'prescription-create', 'photo-add'];
  // A workout is made here too. It gets a temporary id, which the replay
  // learns the server's own for, so what is saved into it next follows it.
  const day = op.kind === 'workout' ? await _recallDay(pathOf(target)) : undefined;
  // A save naming its workout is a change of that one, whatever else it says.
  // A day's first made here, with none of the day's held, is a new workout of
  // the day as well: sent by date alone, the server put it into the day's
  // first workout, which took its name, when the day had workouts this
  // browser hadn't seen (never opened, or logged elsewhere meanwhile).
  // A save naming no workout while the day's first is one made here (its own
  // save still on its way when this one was made) is a change of that one.
  if (op.kind === 'workout' && body?.id == null && !body?.new_session && day?.workout && isTempId(day.workout.id)) {
    const id = _swapped[Number(day.workout.id)] ?? day.workout.id;
    body = { ...body, id };
    op.key = `workout:${pathOf(target).split('/').pop()}#${id}`;
  }
  // Unless it was just sent that way and its answer never came: the server
  // may have made it already, as the day's first, and a new workout of the
  // day would be a second one. It goes again as it was sent, which saves
  // into the one it made (or makes it, if it never arrived), and keeps a
  // temporary id so what is saved into it next follows it. A failure here
  // can't tell "never arrived" from "answer lost", so one that never arrived
  // also goes as it was sent: into the day's first workout on the server,
  // as it would have gone had it arrived.
  const sentAsFirst = tried && op.kind === 'workout' && body?.id == null && !body?.new_session;
  const firstMadeHere = sentAsFirst && !day?.workout;
  const newWorkout = !sentAsFirst && op.kind === 'workout' && body?.id == null && (!!body?.new_session || !day?.workout);
  const tempId = MAKES_A_ROW.includes(op.kind) || newWorkout || firstMadeHere ? newTempId() : null;
  if (newWorkout) body = { ...body, new_session: true, client_key: body.client_key || `web-workout${tempId}` };
  const date = op.kind === 'workout' ? pathOf(target).split('/').pop() : null;
  const at = Date.now();
  const stored = await _queue({
    // Tried just now: it may have reached the server, answer lost.
    ...(tried ? { sent: true } : {}),
    method,
    path: remapPath(String(url), _swapped),
    // Sent twice (its answer lost on the way back), a new workout is still
    // one: it carries a key (above).
    body,
    at,
    editedAt: _serverNow(at),
    // What the caller says it changed, else what differs from the copy here.
    // A new workout is all new.
    changed: newWorkout || firstMadeHere ? null : (_callerChanged(init) ?? await _changedFields(method, target, body)),
    ...op,
    ...(tempId == null ? {}
      : firstMadeHere ? { tempId }
      : op.kind === 'workout' ? { tempId, key: `workout:${date}#${tempId}` }
      : { tempId, id: tempId, key: `${op.kind.replace('-create', '')}:${tempId}` }),
  });
  if (!stored) {
    // Nowhere to keep it. With a connection, and nothing waiting that can be
    // read back (the store broke after the page loaded), nothing will go up
    // ahead of it either, so it goes straight to the server. Not when it was
    // just tried that way (it may have landed), nor when it names something
    // only this browser has.
    if (!tried && _online() && !_namesTempId(target, body) && !(await _all('outbox')).length) {
      try { return await direct(); } catch (err) { if (!isOfflineError(err)) throw err; _publish({ online: false }); }
    }
    return _storageReply();
  }

  // Answer in the shape the route would have, so the screen carries on.
  if (op.kind === 'workout') {
    const mirrored = body?.id != null ? await _recallWorkout(pathOf(target), body.id) : day;
    const reply = queuedWorkoutReply(mirrored, body, tempId ?? newTempId());
    await _rememberWorkout(pathOf(target), reply.workout, day);
    return _json(200, reply);
  }
  if (op.kind === 'workout-delete') {
    const gone = _wantedWorkout(target);
    const first = (await _recallDay(pathOf(target)))?.workout?.id;
    const doomed = gone ?? first;
    if (doomed != null) await _remember(`${pathOf(target)}?id=${doomed}`, { workout: null });
    // Marked as deleted here: the day's other workouts held from before still count.
    if (gone == null || Number(first) === gone) await _remember(pathOf(target), { workout: null, deletedHere: true });
    return _json(200, { ok: true, deleted: true, queued: true, offline: true });
  }
  // Shaped like the route's own answer: the screens read these.
  return _json(200, queuedReply({ ...op, id: op.id ?? tempId }, body, tempId));
}
