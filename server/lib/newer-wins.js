/**
 * newer-wins.js: an edit meets the row here, field by field, and the newer
 * edit of each field stays.
 *
 * Every row keeps when each of its fields last changed (field_times, JSON
 * { field: time }; `_base`, the row's last write before its first stamp,
 * for every field not stamped since). A request says when its edit was made (X-Edited-At, the
 * Android app's queued edits, put on the server's clock) and which fields
 * it changed (X-Changed-Fields); without them it was made now and changes
 * every field it sends (the web, and the app online). For each field it
 * changed, or each group of fields that belong together:
 *   - changed here later than the edit: what's here stays, and the edit's
 *     value of it is dropped from the request;
 *   - otherwise the edit's value goes in and the field is stamped with the
 *     edit's time.
 * Fields the edit didn't change stay as they are. The route then writes the
 * request as usual, and touches the row even when the edit lost every
 * field, so its updated_at moves and the device that sent it gets the row
 * that won with its next pull.
 */

const MAX_AHEAD_MS = 5000;

export function toMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v);
  return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

/** When the request's edit was made: the header, if it can be right, else now. */
export function editedAt(req, now = Date.now()) {
  const h = typeof req.get === 'function' ? req.get('x-edited-at') : req.headers?.['x-edited-at'];
  const ms = toMs(h);
  // Never later than now: an edit can't be made after it arrives (a clock
  // a little ahead would otherwise beat an edit made here a moment later).
  return Number.isFinite(ms) && ms <= now + MAX_AHEAD_MS ? Math.min(ms, now) : now;
}

function _changedHeader(req) {
  const h = typeof req.get === 'function' ? req.get('x-changed-fields') : req.headers?.['x-changed-fields'];
  if (typeof h !== 'string') return null;
  return new Set(h.split(',').map(s => s.trim()).filter(Boolean));
}

export function fieldTimes(row) {
  try { return row?.field_times ? JSON.parse(row.field_times) || {} : {}; } catch { return {}; }
}

/**
 * Decide an edit against `existing` (null: a new row, everything goes in).
 * `values`: the edit's values by field (undefined: not sent). `fields`: the
 * fields that merge; `groups`: lists of fields that go together.
 * Returns { keep: Set of fields where what's here stays, times: the row's
 * field_times afterwards (JSON), at: the edit's time (ms) }.
 */
export function decide(req, existing, values, { fields, groups = [] }) {
  const at = editedAt(req);
  const header = _changedHeader(req);
  const sent = f => values[f] !== undefined;
  const changed = f => sent(f) && (!header || header.has(f));
  const times = fieldTimes(existing);
  // A field never stamped since the row was made: the time it was made
  // (_base, see createdTimes). Never updated_at: that moves without an
  // edit (a program deleted under a session, a reorder, a create replayed
  // later than it was made). A row with no stamps at all has no edit to
  // stand against, and the edit goes in.
  const baseline = toMs(times._base);
  const stamp = f => { const t = toMs(times[f]); return Number.isFinite(t) ? t : baseline; };

  const inGroup = new Set();
  const units = [];
  for (const g of groups) {
    const u = g.filter(f => fields.includes(f));
    if (u.length) { units.push(u); u.forEach(f => inGroup.add(f)); }
  }
  for (const f of fields) if (!inGroup.has(f)) units.push([f]);

  const keep = new Set();
  const next = { ...times };
  for (const unit of units) {
    const touched = unit.filter(changed);
    if (!touched.length) {
      // Sent but not changed by this edit: what's here stays.
      for (const f of unit) if (sent(f)) keep.add(f);
      continue;
    }
    const latest = Math.max(...unit.map(stamp).filter(Number.isFinite), -Infinity);
    if (existing && latest > at) {
      for (const f of unit) if (sent(f)) keep.add(f);
      continue;
    }
    const iso = new Date(at).toISOString();
    for (const f of unit) if (sent(f)) next[f] = iso;
  }
  return { keep, times: JSON.stringify(next), at };
}

/**
 * A delete meets the row as a whole: when anything in it changed later than
 * the delete was made (an edit made elsewhere after the device deleted it
 * offline), the row stays, and the device gets it back. Returns the time of
 * that later change, or null when the delete goes ahead.
 */
export function deleteLoses(req, existing) {
  if (!existing) return null;
  const at = editedAt(req);
  // Only edits count (the time each field changed, and the time the row was
  // made), never updated_at, which housekeeping moves. No stamps: nothing to
  // stand against, the delete goes ahead.
  const stamps = Object.values(fieldTimes(existing)).map(toMs).filter(Number.isFinite);
  if (!stamps.length) return null;
  const latest = Math.max(...stamps);
  return latest > at ? new Date(latest).toISOString() : null;
}

/** A new row's field_times: made at the create's edit time (a create queued
 *  offline was made then, not when it arrives), the time every field not
 *  changed since counts from. A create that doesn't say when it was made
 *  (online, or from an older app) gets none: stamped with its arrival, it
 *  would beat edits made to it offline before it arrived. */
export function createdTimes(req) {
  const h = typeof req.get === 'function' ? req.get('x-edited-at') : req.headers?.['x-edited-at'];
  if (!h) return null;
  return JSON.stringify({ _base: new Date(editedAt(req)).toISOString() });
}

/** Stamp fields that merge their own way (a workout's exercises and sets)
 *  with the edit's time, so a delete made before them knows it is older. */
export function stampMerged(req, timesJson, fields) {
  let t = {};
  try { t = JSON.parse(timesJson || '{}') || {}; } catch { t = {}; }
  const iso = new Date(editedAt(req)).toISOString();
  for (const f of fields) if (!(toMs(t[f]) > toMs(iso))) t[f] = iso;
  return JSON.stringify(t);
}

/** The refusal for a delete that lost: the row that stays, for the device. */
export function refuseDelete(res, row, changedAt) {
  return res.status(409).json({ error: `Changed elsewhere after it was deleted here (${changedAt}), so it was kept.`, kept: true, row });
}

/**
 * The same, on a request body: fields where what's here stays get the
 * row's value (`current(f)`), so the route's usual write leaves them as
 * they are. Returns the row's field_times afterwards.
 */
export function applyToBody(req, existing, body, { fields, groups = [], current }) {
  const { keep, times } = decide(req, existing, body, { fields, groups });
  if (existing) for (const f of keep) body[f] = current(f);
  return times;
}
