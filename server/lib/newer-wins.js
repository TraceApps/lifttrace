/**
 * newer-wins.js: an edit sent to one of the app's routes meets the row here,
 * field by field, and the newer edit of each field stays, by the rule every
 * Trace app shares (lib/field-sync.js; the fields and groups of each table
 * are in lib/sync-fields.js).
 *
 * Every row keeps when each of its fields last changed (field_times, JSON
 * { field: time }; `_base`, the time every field not stamped since counts
 * from). A request says when its edit was made (X-Edited-At, an edit queued
 * offline, put on the server's clock), which fields it changed
 * (X-Changed-Fields), and when each of them was changed, where it knows
 * (X-Field-Edits, JSON { field: time }: two edits queued for one row and
 * sent as one keep their own times). Without them it was made now and
 * changes every field it sends (the web, and the app online). For each
 * field it changed, or each group of fields that belong together:
 *   - changed here later than the edit, to the second: what's here stays,
 *     and the edit's value of it is dropped from the request;
 *   - otherwise the edit's value goes in and the field is stamped with the
 *     edit's time. A tie goes to the edit arriving; a value that's already
 *     here is no edit, and isn't stamped.
 * Fields the edit didn't change stay as they are. The route then writes the
 * request as usual, and touches the row even when the edit lost every
 * field, so its updated_at moves and the device that sent it gets the row
 * that won with its next pull.
 *
 * A row's updated_at never counts as an edit here: housekeeping moves it (a
 * program deleted under a session, a reorder, a create replayed later than
 * it was made). A row with no stamps at all has no edit to stand against,
 * and the edit goes in.
 */
import {
  instantMs, readTimes, mergeEdit, fieldUnits, deleteLoses as coreDeleteLoses, editRevives,
  createdTimes as coreCreatedTimes, isoTime,
} from './field-sync.js';

const MAX_AHEAD_MS = 5000;

export const toMs = instantMs;

const _header = (req, name) => (typeof req?.get === 'function' ? req.get(name) : req?.headers?.[name]);

/** When the request's edit was made: the header, if it can be right, else now. */
export function editedAt(req, now = Date.now()) {
  const ms = toMs(_header(req, 'x-edited-at'));
  // Never later than now: an edit can't be made after it arrives (a clock
  // a little ahead would otherwise beat an edit made here a moment later).
  return Number.isFinite(ms) && ms <= now + MAX_AHEAD_MS ? Math.min(ms, now) : now;
}

function _changedHeader(req) {
  const h = _header(req, 'x-changed-fields');
  if (typeof h !== 'string') return null;
  return h.split(',').map(s => s.trim()).filter(Boolean);
}

/** When each field was changed, where the request says (X-Field-Edits):
 *  { field: ms }, each never later than the edit itself. Null when it
 *  doesn't say, or says something unreadable. */
export function fieldEditsOf(req) {
  const h = _header(req, 'x-field-edits');
  if (typeof h !== 'string' || !h || h.length > 8192) return null;
  let o;
  try { o = JSON.parse(h); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const at = editedAt(req);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const ms = toMs(v);
    if (Number.isFinite(ms)) out[k] = Math.min(ms, at);
  }
  return Object.keys(out).length ? out : null;
}

export function fieldTimes(row) {
  return readTimes(row?.field_times);
}

/**
 * The core compares whole seconds and gives a tie to the edit arriving.
 * LiftTrace keeps its times to the millisecond, on the server's clock, so
 * within one second the later of two known times still wins: a stamp here
 * later than the edit's time for it (`refOf(field)`) in the same second is
 * read as one second later. Never the other way: a tie to the millisecond,
 * or a time with no milliseconds, is the core's. Returns { times, bumped:
 * { field: original } }.
 */
function _msOrder(times, refOf) {
  const out = { ...times };
  const bumped = {};
  for (const [k, v] of Object.entries(times)) {
    const ms = toMs(v);
    const ref = refOf(k);
    if (Number.isFinite(ms) && ms > ref && Math.floor(ms / 1000) === Math.floor(ref / 1000)) {
      out[k] = isoTime(Math.floor(ms / 1000) * 1000 + 1000);
      bumped[k] = v;
    }
  }
  return { times: out, bumped };
}

/** The time each field of an edit counts as made: the edit's, or a group's
 *  latest field time where the request says when each was changed. */
function _refs(at, fieldAt, values, fields, groups) {
  const own = f => (Number.isFinite(fieldAt?.[f]) ? Math.min(fieldAt[f], at) : at);
  const ref = {};
  for (const unit of fieldUnits(fields, groups)) {
    const sent = unit.filter(f => values[f] !== undefined);
    const t = sent.length ? Math.max(...sent.map(own)) : at;
    for (const f of unit) ref[f] = t;
  }
  return k => (k in ref ? ref[k] : at);
}

/**
 * Decide an edit against `existing` (null: a new row, everything goes in).
 * `values`: the edit's values by field (undefined: not sent). `fields`: the
 * fields that merge; `groups`: lists of fields that go together; `json`:
 * fields holding JSON (compared by what they hold). `changed`: the fields
 * the edit says it changed some other way than the header (a workout
 * save's body, see routes/workout.js), used when there's no header.
 * `times`: the row's field_times to decide against (default: its own).
 * Returns { keep: Set of fields where what's here stays, times: the row's
 * field_times afterwards (JSON), at: the edit's time (ms) }.
 */
export function decide(req, existing, values, { fields, groups = [], json = [], changed: listed = null, times: given } = {}) {
  const at = editedAt(req);
  const said = _changedHeader(req) ?? (Array.isArray(listed) ? listed.map(String) : null);
  const fieldAt = fieldEditsOf(req);
  const { times: ordered, bumped } = _msOrder(given !== undefined ? readTimes(given) : fieldTimes(existing), _refs(at, fieldAt, values, fields, groups));
  const m = mergeEdit({
    existing: existing || null, values, fields, groups, json,
    changed: said, at, fieldAt, times: ordered,
  });
  // What this edit didn't stamp keeps its own time.
  for (const [k, v] of Object.entries(bumped)) if (m.times[k] === ordered[k]) m.times[k] = v;
  const keep = new Set();
  // A field the edit sent whose value isn't the one that stays.
  for (const f of fields) if (values[f] !== undefined && m.row[f] !== values[f]) keep.add(f);
  return { keep, times: JSON.stringify(m.times), at };
}

/**
 * A delete meets the row as a whole: when anything in it changed later than
 * the delete was made, to the second (an edit made elsewhere after the
 * device deleted it offline), the row stays, and the device gets it back. A
 * tie goes to the delete. Returns the time of that later change, or null
 * when the delete goes ahead.
 */
export function deleteLoses(req, existing, times = fieldTimes(existing)) {
  if (!existing) return null;
  // Only edits count (the time each field changed, and the time the row was
  // made), never updated_at, which housekeeping moves. No stamps: nothing to
  // stand against, the delete goes ahead. (`times`: what to decide against,
  // when not the row's own: see routes/sync.js.)
  const at = editedAt(req);
  const { times: ordered, bumped } = _msOrder(readTimes(times), () => at);
  const fields = Object.keys(ordered).filter(k => k !== '_base');
  const later = coreDeleteLoses({ existing, fields, at, times: ordered });
  if (later == null) return null;
  // The time of that change as kept (not as read for the comparison).
  const own = Object.entries(ordered).find(([, v]) => toMs(v) === later)?.[0];
  return own && bumped[own] ? bumped[own] : isoTime(later);
}

/** Whether an edit brings back a row deleted here: only one made after the
 *  delete (its time in field_times, else the row's deleted_at). An edit
 *  made now (no X-Edited-At) always is. */
export function editBringsBack(req, existing) {
  if (!existing?.deleted_at) return true;
  // Made now: after the delete, whenever in this second it was.
  if (!_header(req, 'x-edited-at')) return true;
  return editAfterDelete(editedAt(req), fieldTimes(existing).deleted_at, existing.deleted_at);
}

/** An edit made at `at` (ms) is after a delete: the delete's stamp (its
 *  edit time, to the millisecond) when kept, else the row's deleted_at (to
 *  the second). A tie keeps the delete. */
export function editAfterDelete(at, stamp, deletedAt = null) {
  const ms = toMs(stamp);
  if (Number.isFinite(ms) && Math.floor(ms / 1000) === Math.floor(at / 1000)) return at > ms;
  return editRevives({ at, deletedAt: Number.isFinite(ms) ? stamp : deletedAt, times: {} });
}

/** field_times with the delete's time, so a later edit made before it can't
 *  bring the row back. */
export function deletedTimes(req, existing) {
  return JSON.stringify({ ...fieldTimes(existing), deleted_at: isoTime(editedAt(req)) });
}

/** A new row's field_times: made at the create's edit time (a create queued
 *  offline was made then, not when it arrives), the time every field not
 *  changed since counts from. A create that doesn't say when it was made
 *  (online, or from an older app) gets none: stamped with its arrival, it
 *  would beat edits made to it offline before it arrived. */
export function createdTimes(req) {
  if (!_header(req, 'x-edited-at')) return null;
  return JSON.stringify(coreCreatedTimes(editedAt(req)));
}

/** Stamp fields that merge their own way (a workout's exercises and sets)
 *  with the edit's time, so a delete made before them knows it is older. */
export function stampMerged(req, timesJson, fields) {
  const t = readTimes(timesJson || '{}');
  const at = editedAt(req);
  for (const f of fields) if (!(toMs(t[f]) > at)) t[f] = isoTime(at);
  return JSON.stringify(t);
}

/** The refusal for a delete that lost: the row that stays, for the device. */
export function refuseDelete(res, row, changedAt) {
  const { field_times: _t, ...out } = row || {};
  return res.status(409).json({ error: `Changed elsewhere after it was deleted here (${changedAt}), so it was kept.`, kept: true, row: out });
}

/**
 * The same, on a request body: fields where what's here stays get the
 * row's value (`current(f)`), so the route's usual write leaves them as
 * they are. Returns the row's field_times afterwards.
 */
export function applyToBody(req, existing, body, { fields, groups = [], json = [], current, changed = null, times } = {}) {
  const r = decide(req, existing, body, { fields, groups, json, changed, times });
  if (existing) for (const f of r.keep) body[f] = current(f);
  return r.times;
}
