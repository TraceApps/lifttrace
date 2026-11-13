/**
 * nt-body-provenance.js — which NutriTrace connection and source own the body
 * measurements this server imported into one LiftTrace account.
 *
 * The client cannot be the authority here. Two tabs opened before the first
 * import both read an empty provenance marker, both pass their local check, and
 * both import: one account's body history ends up mixed between two sources,
 * and the marker only remembers whichever tab wrote last. So the marker is
 * fixed here, once, by a compare-and-set (CAS):
 *
 *   - the first claim wins and is written in a single IMMEDIATE transaction,
 *     so exactly one (connection, source) pair can ever be stored per account;
 *   - every later claim for a different connection/source is refused, and the
 *     refusal carries the provenance that is actually fixed;
 *   - a measurement written through the import path carries the provenance it
 *     was mapped under, and is refused unless it matches the fixed claim.
 *
 * A source marker an earlier revision of this feature saved as two ordinary
 * settings (ntBodySyncedSource and ntBodySyncedConnectionIdentity) is adopted
 * as the first claim when it is consistent, so an account that already
 * imported cannot silently re-open the choice.
 *
 * Nothing here talks to NutriTrace or to HTTP; routes own that.
 */

export const NT_BODY_PROVENANCE_KEY = 'ntBodyProvenance';
export const LEGACY_SOURCE_KEY = 'ntBodySyncedSource';
export const LEGACY_IDENTITY_KEY = 'ntBodySyncedConnectionIdentity';
const MAX_SOURCE_LENGTH = 200;

// Settings the server owns. They are the provenance authority, so the generic
// settings API and device sync may not write them: a PUT could otherwise
// replace a fixed claim (or forge the legacy pair that seeds the first one) and
// verifyProvenance() would let another import over the first source's history.
export const RESERVED_PROVENANCE_KEYS = Object.freeze([
  NT_BODY_PROVENANCE_KEY,
  LEGACY_SOURCE_KEY,
  LEGACY_IDENTITY_KEY,
]);

export function isReservedProvenanceKey(key) {
  return RESERVED_PROVENANCE_KEYS.includes(key);
}

/** Canonical connection identity (`https://nt.example` + NT user id). */
export function stableIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const instanceUrl = typeof value.instanceUrl === 'string'
    ? value.instanceUrl.trim().replace(/\/+$/, '')
    : '';
  const userId = value.userId == null ? '' : String(value.userId).trim();
  if (!instanceUrl || !userId) return null;
  return { instanceUrl, userId };
}

/**
 * The three fields that make up a provenance claim.
 * Accepts either `{ connectionIdentity: { instanceUrl, userId }, source }` or
 * the flat `{ instanceUrl, userId, source }` shape the CAS row stores.
 *
 * `source` is kept EXACTLY as the client chose it: it names a NutriTrace source
 * and is echoed back in the claim, so trimming would fix one spelling and then
 * reject the client's own echo forever (and fold two distinct sources into
 * one). Only a value that cannot be a source is rejected, before anything is
 * fixed.
 */
export function stableProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = stableIdentity(
    value.connectionIdentity && typeof value.connectionIdentity === 'object' && !Array.isArray(value.connectionIdentity)
      ? value.connectionIdentity
      : value,
  );
  if (!identity) return null;
  const source = typeof value.source === 'string' ? value.source : null;
  if (source == null || source.length === 0 || source.length > MAX_SOURCE_LENGTH) return null;
  return { ...identity, source };
}

export function sameProvenance(left, right) {
  const a = stableProvenance(left);
  const b = stableProvenance(right);
  return !!a && !!b &&
    a.instanceUrl === b.instanceUrl && a.userId === b.userId && a.source === b.source;
}

function sameConnection(left, right) {
  return !!left && !!right &&
    left.instanceUrl === right.instanceUrl && left.userId === right.userId;
}

function parse(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function readSetting(database, userId, key) {
  const row = database.prepare(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?'
  ).get(userId, key);
  return row ? parse(row.value) : null;
}

function writeProvenance(database, userId, claim) {
  database.prepare(
    `INSERT INTO user_settings (user_id, key, value, field_times, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       field_times = excluded.field_times,
       updated_at = datetime('now')`
  ).run(userId, NT_BODY_PROVENANCE_KEY, JSON.stringify(claim), JSON.stringify({ value: Date.now() }));
}

/** The marker fixed for this account, or null when nothing was imported yet. */
export function readProvenance(database, userId) {
  if (userId == null) return null;
  return stableProvenance(readSetting(database, userId, NT_BODY_PROVENANCE_KEY));
}

/**
 * The marker an earlier revision saved as two ordinary settings. Returns:
 *   null                       nothing usable (no source marker)
 *   { ambiguous: true }        a source without the connection it came from
 *   { instanceUrl, userId, source }  a provenance that can be adopted
 */
function legacyProvenance(database, userId) {
  const source = readSetting(database, userId, LEGACY_SOURCE_KEY);
  if (typeof source !== 'string' || !source.trim()) return null;
  const identity = readSetting(database, userId, LEGACY_IDENTITY_KEY);
  const stable = stableProvenance({
    ...(identity && typeof identity === 'object' && !Array.isArray(identity) ? identity : {}),
    source,
  });
  return stable || { ambiguous: true };
}

/**
 * Claim the account's body provenance. Compare-and-set: it succeeds only when
 * nothing is fixed yet, or when the same connection+source is already fixed
 * (so a retry, or a second tab importing the same source, stays harmless).
 * `database` is passed in rather than imported so this can be exercised against
 * a scratch database.
 */
export function claimProvenance(database, userId, candidate) {
  if (userId == null) return { ok: false, code: 'no-account' };
  const claim = stableProvenance(candidate);
  if (!claim) return { ok: false, code: 'invalid-claim' };

  const attempt = () => {
    const fixed = readProvenance(database, userId);
    if (fixed) {
      if (sameProvenance(fixed, claim)) return { ok: true, first: false, provenance: fixed };
      return {
        ok: false,
        code: sameConnection(fixed, claim) ? 'source-provenance-conflict' : 'connection-provenance-conflict',
        provenance: fixed,
      };
    }

    const legacy = legacyProvenance(database, userId);
    if (legacy?.ambiguous) {
      // A source with no connection cannot be attributed to anyone: refuse to
      // guess, and let the UI report the blocked connection change.
      return { ok: false, code: 'connection-provenance-conflict', provenance: null };
    }
    if (legacy) {
      if (!sameProvenance(legacy, claim)) {
        return {
          ok: false,
          code: sameConnection(legacy, claim) ? 'source-provenance-conflict' : 'connection-provenance-conflict',
          provenance: legacy,
        };
      }
      // Consistent legacy marker: adopt it into the CAS row so the authority
      // is one atomically written value from now on.
      writeProvenance(database, userId, legacy);
      return { ok: true, first: true, provenance: legacy };
    }

    writeProvenance(database, userId, claim);
    return { ok: true, first: true, provenance: claim };
  };

  // IMMEDIATE takes the write lock before the read, so two tabs (or two
  // processes on the same file) cannot both see "nothing fixed" and both
  // write. Written with plain SQL so the claim works on any SQLite driver.
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = attempt();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw error;
  }
}

/**
 * Check the provenance carried by one imported measurement write against the
 * fixed claim. A manual body-stat edit carries none and is not affected.
 */
export function verifyProvenance(database, userId, payload) {
  const claim = stableProvenance(payload);
  if (!claim) return { ok: false, code: 'invalid-provenance' };
  if (userId == null) return { ok: false, code: 'no-account' };
  const fixed = readProvenance(database, userId);
  if (!fixed) return { ok: false, code: 'provenance-missing' };
  if (!sameProvenance(fixed, claim)) return { ok: false, code: 'provenance-mismatch', provenance: fixed };
  return { ok: true, provenance: fixed };
}

/**
 * Delete an account's ordinary settings while keeping the provenance. A bulk
 * settings wipe must not release the claim while the body history it describes
 * is still there: the next import could then choose another source and mix the
 * two.
 */
export function deleteUserSettingsKeepingProvenance(database, userId, extraKeys = []) {
  if (userId == null) return 0;
  const keys = [...RESERVED_PROVENANCE_KEYS, ...extraKeys];
  const placeholders = keys.map(() => '?').join(', ');
  return database.prepare(
    `DELETE FROM user_settings WHERE user_id = ? AND key NOT IN (${placeholders})`
  ).run(userId, ...keys).changes;
}

/**
 * The imported history is being deleted with it (clear-data), so the claim it
 * describes is released too; otherwise choosing a source again would be
 * refused forever.
 */
export function clearProvenance(database, userId) {
  if (userId == null) return 0;
  const placeholders = RESERVED_PROVENANCE_KEYS.map(() => '?').join(', ');
  return database.prepare(
    `DELETE FROM user_settings WHERE user_id = ? AND key IN (${placeholders})`
  ).run(userId, ...RESERVED_PROVENANCE_KEYS).changes;
}

/**
 * Does the read a claim is built from belong to the claim's connection?
 * The read receipt and the claim are compared as identities (source is not
 * part of a connection).
 */
export function readMatchesClaim(receipt, claim) {
  const read = stableIdentity(receipt);
  const named = stableIdentity(claim);
  return !!read && !!named &&
    read.instanceUrl === named.instanceUrl && read.userId === named.userId;
}
