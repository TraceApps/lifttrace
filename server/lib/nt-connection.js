/**
 * nt-connection.js — one saved NutriTrace connection, written in one step.
 *
 * The URL, the token, the identity NutriTrace reports and the enabled flag
 * belong together: a reader (the body-composition proxy, a claim) that sees
 * the URL of one Save and the identity of another would attribute one
 * account's measurements to another. Saving them as separate settings PUTs
 * allowed exactly that when two tabs saved at once, and a partly failed
 * sequence left a new token with the old address.
 *
 * So a transition is a single transaction here: either all of the fields are
 * the new connection or all of them stay the old one. Two values travel with
 * it, and they answer two different questions:
 *
 *   - `fingerprint` is a hash of the address, the secret token and the
 *     identity. It says whether the stored identity still belongs to the
 *     stored credentials. The token never leaves the server, so a client
 *     cannot compute one for a token it does not have: a settings write that
 *     changes the URL or identity without going through here makes it stop
 *     matching, and every body import fails closed until the connection is
 *     saved again.
 *   - `version` is a monotonic counter, incremented by every transition
 *     (including enable/disable). It is the compare-and-set value: a Save
 *     based on an older connection is refused even when the address, token
 *     and identity ended up the same after A -> B -> A, and a tab that loaded
 *     the connection while it was off cannot turn it back on with a stale
 *     snapshot. It is server-owned, so a generic settings write cannot rewind
 *     it.
 */
import { createHash } from 'node:crypto';
import { readSettingRaw, settingToStore } from './secret-settings.js';

export const NT_CONNECTION_TIMEOUT_MS = Number(process.env.NT_TIMEOUT_MS) > 0
  ? Number(process.env.NT_TIMEOUT_MS)
  : 8000;
export const NT_CONNECTION_MAX_REPLY_BYTES = Number(process.env.NT_MAX_REPLY_BYTES) > 0
  ? Number(process.env.NT_MAX_REPLY_BYTES)
  : 1024 * 1024;

/** The monotonic transition counter, written only by this module. */
export const NT_CONNECTION_VERSION_KEY = 'ntConnectionVersion';

/** Settings the server writes and a client must not replace. */
export function isServerOwnedNtKey(key) {
  return key === NT_CONNECTION_VERSION_KEY || key === 'ntConnectionScopes';
}

/** The parts of a saved connection. A generic write of one is a transition. */
export const NT_CONNECTION_SETTING_KEYS = Object.freeze([
  'ntInstanceUrl', 'ntInstanceToken', 'ntFederationEnabled',
  'ntConnectionVerified', 'ntConnectionIdentity',
]);

export function isConnectionSettingKey(key) {
  return NT_CONNECTION_SETTING_KEYS.includes(key);
}

/** The identity of a connection as the server stores it. */
export function connectionIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const instanceUrl = typeof value.instanceUrl === 'string' ? value.instanceUrl.replace(/\/+$/, '') : '';
  const userId = value.userId == null ? '' : String(value.userId);
  const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : '';
  if (!instanceUrl || !userId) return null;
  return fingerprint ? { instanceUrl, userId, fingerprint } : { instanceUrl, userId };
}

/**
 * The fingerprint that ties an identity to the credential it was verified
 * with. Changing the address, the token or either identity field changes it,
 * so a receipt (or a lazy settings write) from another configuration can never
 * be mistaken for this one.
 */
export function connectionFingerprint(url, token, identity) {
  const id = connectionIdentity(identity);
  if (!url || !token || !id) return null;
  return createHash('sha256')
    .update(`${url}\n${token}\n${id.instanceUrl}\n${id.userId}`)
    .digest('hex');
}

function _readUserId(database, userId, key) {
  const row = database.prepare(
    `SELECT value FROM user_settings WHERE ${userId == null ? 'user_id IS NULL' : 'user_id = ?'} AND key = ?`
  ).get(...(userId == null ? [key] : [userId, key]));
  if (!row?.value) return null;
  return readSettingRaw(key, row.value);
}

function _readVersion(database, userId) {
  const value = Number(_readUserId(database, userId, NT_CONNECTION_VERSION_KEY));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The connection stored for an account, or the fields as far as they go. */
export function readConnection(database, userId) {
  const url = _readUserId(database, userId, 'ntInstanceUrl');
  const token = _readUserId(database, userId, 'ntInstanceToken');
  const enabled = !!_readUserId(database, userId, 'ntFederationEnabled');
  const version = _readVersion(database, userId);
  const stored = connectionIdentity(_readUserId(database, userId, 'ntConnectionIdentity'));
  if (!url || !token || !stored) {
    return { url: url || '', token: token || '', enabled, verified: false, identity: null, fingerprint: null, version };
  }
  const fingerprint = connectionFingerprint(url, token, stored);
  if (!fingerprint || stored.fingerprint !== fingerprint) {
    return { url, token, enabled, verified: false, identity: null, fingerprint: null, version };
  }
  return {
    url,
    token,
    enabled,
    verified: !!_readUserId(database, userId, 'ntConnectionVerified'),
    identity: stored,
    fingerprint,
    version,
  };
}

function _write(database, userId, key, value) {
  const row = database.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  const stored = settingToStore(key, value, row?.value ?? null);
  if (stored === undefined) return;
  database.prepare(
    `INSERT INTO user_settings (user_id, key, value, field_times, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       field_times = excluded.field_times,
       updated_at = datetime('now')`
  ).run(userId, key, stored, JSON.stringify({ value: Date.now() }));
}

/**
 * Save one connection transition in a single IMMEDIATE transaction, checking
 * `expectedVersion` in the same transaction as the write: a tab that based its
 * Save on an older connection is refused instead of silently replacing another
 * tab's newer one. The version is bumped for every transition, so a change
 * that leaves the address and identity the same (OFF, or A -> B -> A) is still
 * a new version.
 *
 * `identity: null` is allowed for a change that only switches federation off:
 * nothing is verified then, so the identity, scopes and verified flag are left
 * as they were.
 */
export function saveConnectionTransition(database, userId, {
  url,
  token,
  identity = null,
  enabled,
  bodySyncEnabled,
  scopes,
  verified = true,
  expectedVersion = null,
} = {}) {
  if (userId == null) return { ok: false, code: 'no-account' };
  if (!url || !token) return { ok: false, code: 'invalid-connection' };
  if (identity && !connectionIdentity(identity)) return { ok: false, code: 'invalid-connection' };
  const fingerprint = identity ? connectionFingerprint(url, token, identity) : null;

  database.exec('BEGIN IMMEDIATE');
  try {
    const currentVersion = _readVersion(database, userId);
    if (isStale(currentVersion, expectedVersion)) {
      database.exec('ROLLBACK');
      return { ok: false, code: 'connection-changed' };
    }
    const version = currentVersion + 1;
    _write(database, userId, 'ntInstanceUrl', url);
    _write(database, userId, 'ntInstanceToken', token);
    if (identity) {
      _write(database, userId, 'ntConnectionIdentity', { ...connectionIdentity(identity), fingerprint });
      if (scopes !== undefined) _write(database, userId, 'ntConnectionScopes', scopes);
    }
    _write(database, userId, 'ntConnectionVerified', !!verified);
    _write(database, userId, 'ntFederationEnabled', !!enabled);
    if (bodySyncEnabled !== undefined) _write(database, userId, 'ntBodySyncEnabled', !!bodySyncEnabled);
    _write(database, userId, NT_CONNECTION_VERSION_KEY, version);
    database.exec('COMMIT');
    return { ok: true, version };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw error;
  }
}

/**
 * Record a change to the saved connection that did not come through
 * saveConnectionTransition: a settings write from a client from before the
 * atomic endpoint, or Clear All Settings deleting the connection rows. Bumping
 * the version invalidates any Save that was already on its way with the old
 * one, so an old write cannot quietly become current again.
 */
export function bumpConnectionVersion(database, userId) {
  if (userId == null) return 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    const version = _readVersion(database, userId) + 1;
    _write(database, userId, NT_CONNECTION_VERSION_KEY, version);
    database.exec('COMMIT');
    return version;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw error;
  }
}

/**
 * The stored version moved past the one a Save started from. A connection
 * saved before versions existed (0) is never a match for an expected version,
 * so the caller re-reads and saves again instead of overwriting blindly.
 */
export function isStale(currentVersion, expectedVersion) {
  return Number.isSafeInteger(expectedVersion) && expectedVersion >= 0 && currentVersion !== expectedVersion;
}
