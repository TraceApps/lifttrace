/**
 * Cardio log reads and writes shared by the app's POST /api/cardio, the MCP
 * cardio tools (log_cardio, get_cardio) and the public REST API at
 * /api/v1/cardio (issue #134), so the validation and SQL live in one place.
 *
 * Every function takes the database handle as its first argument instead of
 * importing db.js, so scripts/cardio-log.test.js can drive the real SQL
 * against a scratch SQLite file without the server bootstrap.
 */

export const MAX_EXTERNAL_ID_LENGTH = 200;

export const CARDIO_OFF_MESSAGE =
  'Cardio is turned off in Settings. Turn it on under Settings, Workout, Cardio to log cardio sessions.';

/**
 * Validate and normalize a cardio session the way POST /api/cardio always
 * has: date and activity required, duration_min a positive whole number of
 * minutes, distance and avg_hr optional, distance_unit km (default) or mi.
 * Throws a plain Error whose message is safe to return as a 400.
 */
export function normalizeCardioInput(input = {}) {
  const { date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template } = input;
  if (!date) throw new Error('date required');
  if (!activity || !String(activity).trim()) throw new Error('activity required');
  const dm = Math.floor(Number(duration_min));
  if (!Number.isFinite(dm) || dm <= 0) throw new Error('duration_min must be a positive integer');
  const dist = distance == null || distance === '' ? null : Number(distance);
  const hr = avg_hr == null || avg_hr === '' ? null : Math.floor(Number(avg_hr));
  return {
    date,
    activity: String(activity).trim(),
    duration_min: dm,
    distance: Number.isFinite(dist) ? dist : null,
    distance_unit: distance_unit === 'mi' || distance_unit === 'km' ? distance_unit : 'km',
    avg_hr: Number.isFinite(hr) ? hr : null,
    notes: notes ? String(notes).trim() : null,
    is_template: is_template ? 1 : 0,
  };
}

/** A caller-supplied id for the session, or null. Blank counts as none. */
export function normalizeExternalId(externalId) {
  if (externalId == null) return null;
  const id = String(externalId).trim();
  if (!id) return null;
  if (id.length > MAX_EXTERNAL_ID_LENGTH) {
    throw new Error(`external_id must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
  }
  return id;
}

/**
 * Whether the user has turned cardio on. cardioEnabled is a server setting,
 * stored JSON-encoded in user_settings like every other synced setting, and
 * off by default.
 */
export function isCardioEnabled(db, userId) {
  if (userId == null) return false;
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, 'cardioEnabled');
  if (!row) return false;
  try { return JSON.parse(row.value) === true; } catch { return false; }
}

/**
 * Insert one cardio session. With an external_id, a session the user already
 * logged under that id is returned unchanged instead of a second copy, so a
 * script can safely re-send the same write. Returns { created, session }.
 */
export function insertCardio(db, userId, input) {
  const row = normalizeCardioInput(input);
  const externalId = normalizeExternalId(input?.external_id);
  const findExisting = () => db
    .prepare('SELECT * FROM cardio_log WHERE user_id IS ? AND external_id = ?')
    .get(userId, externalId);

  if (externalId) {
    const existing = findExisting();
    if (existing) return { created: false, session: existing };
  }

  let info;
  try {
    info = db.prepare(
      `INSERT INTO cardio_log (user_id, date, activity, duration_min, distance, distance_unit, avg_hr, notes, is_template, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, row.date, row.activity, row.duration_min, row.distance,
      row.distance_unit, row.avg_hr, row.notes, row.is_template, externalId,
    );
  } catch (e) {
    // Two identical writes racing past the lookup: the unique index lets
    // exactly one in, and the other returns that one.
    if (externalId && e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { created: false, session: findExisting() };
    }
    throw e;
  }
  return { created: true, session: db.prepare('SELECT * FROM cardio_log WHERE id = ?').get(info.lastInsertRowid) };
}

/**
 * The user's cardio sessions in an inclusive date range, oldest first.
 * `activity` is an optional case-insensitive substring ("run" matches
 * "Running" and "Trail run"). A null bound leaves that side open.
 */
export function listCardio(db, userId, { start = null, end = null, activity = null } = {}) {
  const conditions = ['user_id IS ?'];
  const params = [userId];
  if (start != null) { conditions.push('date >= ?'); params.push(start); }
  if (end != null) { conditions.push('date <= ?'); params.push(end); }
  if (activity != null && String(activity).trim()) {
    conditions.push("activity LIKE ? ESCAPE '\\'");
    params.push(`%${String(activity).trim().replace(/[\\%_]/g, '\\$&')}%`);
  }
  return db.prepare(
    `SELECT * FROM cardio_log WHERE ${conditions.join(' AND ')} ORDER BY date ASC, id ASC`
  ).all(...params);
}

/** A cardio_log row as the MCP tools and the public API return it. */
export function publicCardioSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    activity: row.activity,
    duration_min: row.duration_min,
    distance: row.distance,
    distance_unit: row.distance_unit,
    avg_hr: row.avg_hr,
    notes: row.notes,
    external_id: row.external_id ?? null,
    is_template: !!row.is_template,
    created_at: row.created_at,
  };
}
