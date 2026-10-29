/**
 * The server's own bookkeeping about rows, never part of an answer: when
 * each field of a row last changed (field_times, lib/newer-wins.js) is how
 * two edits of a row are settled here, and means nothing to an app, a page,
 * an API client or an agent. Routes answer with rows as they read them
 * (SELECT *), so it's taken out of every JSON answer under /api, at any
 * depth a row sits in one (a list, { workout: {...} }). The sync pull,
 * which isn't sent with res.json, leaves it out itself (routes/sync.js).
 * Backups keep it: they're files, never JSON answers, so a restore keeps
 * each field's time.
 */
const PRIVATE = 'field_times';
const MAX_DEPTH = 6;

export function withoutPrivateFields(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > MAX_DEPTH) return body;
  if (Array.isArray(body)) { for (const v of body) withoutPrivateFields(v, depth + 1); return body; }
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return body;
  if (Object.prototype.hasOwnProperty.call(body, PRIVATE)) delete body[PRIVATE];
  for (const k of Object.keys(body)) { const v = body[k]; if (v && typeof v === 'object') withoutPrivateFields(v, depth + 1); }
  return body;
}

/** Express middleware: every res.json answer goes without them. */
export function privateFieldsOut(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => json(withoutPrivateFields(body));
  next();
}
