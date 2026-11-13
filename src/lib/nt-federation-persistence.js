import { captureNtAccount, ntAccountChanged, ntAccountChangedError } from './nt-sync-coordination.js';

const settingWrites = new Map();

/** True only when the server applied the write itself. */
export function serverConfirmed(answer) {
  return !!answer && answer.offline !== true && answer.queued !== true;
}

/**
 * Run a publication only while the account that started the request still
 * owns the phone. The answer can arrive after a sign-out and sign-in, and
 * writing it then would put the previous account's URL, identity or
 * "Connected as" into the next account's settings.
 */
export function publishToNtOwner(account, apply) {
  if (ntAccountChanged(account)) return false;
  apply();
  return true;
}

function unconfirmedError() {
  const error = new Error('The server did not confirm the change.');
  error.code = 'unconfirmed';
  return error;
}

/**
 * Persist a setting now while preserving write order for repeated changes.
 * The account is captured before the write is queued: a write that reaches the
 * server after someone else signed in would otherwise land in the next
 * account's settings, carrying this account's URL or token.
 */
export function persistSettingImmediately(key, value, { saveSetting, cancelScheduledSave, account } = {}) {
  if (typeof saveSetting !== 'function') throw new TypeError('saveSetting is required');
  const owner = account || captureNtAccount();
  // Only this account's pending debounce may be cancelled: after a sign-in the
  // queue belongs to the next account.
  if (!ntAccountChanged(owner)) cancelScheduledSave?.(key);

  const previous = settingWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    if (ntAccountChanged(owner)) throw ntAccountChangedError();
    // A queued generic debounce may have been scheduled while this write was
    // waiting behind an earlier explicit toggle.
    cancelScheduledSave?.(key);
    return saveSetting(key, value);
  });
  settingWrites.set(key, current);

  return current.finally(() => {
    if (settingWrites.get(key) === current) settingWrites.delete(key);
  });
}

/**
 * The same ordering, for a setting whose value the UI is about to trust
 * (the body-sync switch and its source). A queued/offline answer means the
 * server does not have it yet, so it is reported as a failure instead of
 * being shown as saved.
 */
export async function persistServerSetting(key, value, options = {}) {
  if (typeof options.saveSetting !== 'function') throw new TypeError('saveSetting is required');
  const answer = await persistSettingImmediately(key, value, {
    ...options,
    saveSetting: async (k, v) => {
      const result = await options.saveSetting(k, v);
      if (!serverConfirmed(result)) throw unconfirmedError();
      return result;
    },
  });
  if (!serverConfirmed(answer)) throw unconfirmedError();
  return answer;
}

/**
 * Save one tested connection as a single server transition.
 *
 * The server verifies the address and token, then writes URL, token, identity
 * and enabled in one transaction (server/routes/nt-federation.js,
 * server/lib/nt-connection.js). There is no sequence of one-key PUTs here, so
 * two tabs cannot interleave into an address from one Save with the identity
 * of another, and a failed step cannot leave a new token behind an old
 * address. A previous token the app never sees (the write-only placeholder)
 * stays on the server; it is never used as a rollback value in the app.
 *
 * Returns the values the server confirmed, which the caller publishes into
 * its local stores only after this resolves.
 */
export async function persistFederationConnectionTransition({
  previous,
  next,
  saveConnection,
  account,
} = {}) {
  if (typeof saveConnection !== 'function') throw new TypeError('saveConnection is required');
  const owner = account || captureNtAccount();
  if (ntAccountChanged(owner)) throw ntAccountChangedError();

  // A Save based on a connection another tab has already changed is refused
  // instead of overwriting it. The version changes on every transition,
  // including OFF and A -> B -> A, so it cannot be fooled by the address and
  // identity ending up where they were. It is sent even at 0 with no identity:
  // a tab opened before the first connection must not turn federation on
  // unconditionally after another tab saved and then switched it off. Only a
  // client from before this field (no ifVersion at all) is still accepted;
  // that compatibility is decided by the server.
  const version = Number(previous?.ntConnectionVersion);
  const ifVersion = Number.isSafeInteger(version) && version >= 0 ? version : 0;

  const answer = await saveConnection({
    url: next.ntInstanceUrl,
    token: next.ntInstanceToken,
    enabled: !!next.ntFederationEnabled,
    ...(next.ntBodySyncEnabled === undefined ? {} : { bodySyncEnabled: !!next.ntBodySyncEnabled }),
    ifVersion,
  });
  if (!serverConfirmed(answer)) throw unconfirmedError();

  const connection = answer?.connection;
  if (!connection || typeof connection.url !== 'string' || !connection.identity) {
    const error = new Error('The server did not confirm the NutriTrace connection.');
    error.code = 'unconfirmed';
    throw error;
  }

  const scopes = Array.isArray(answer.scopes) ? answer.scopes : [];

  // The server is the authority on identity and on whether body sync can be
  // on (a token without the read scope forces it off).
  return {
    values: {
      ntInstanceUrl: connection.url,
      ntConnectionIdentity: connection.identity,
      ntConnectionVersion: Number.isSafeInteger(connection.version) ? connection.version : 0,
      ntConnectionVerified: !!connection.verified,
      ntFederationEnabled: !!connection.enabled,
      ntBodySyncEnabled: answer.bodySyncEnabled === undefined
        ? next.ntBodySyncEnabled
        : !!answer.bodySyncEnabled,
    },
    capabilities: answer.capabilities || {
      workoutWrite: scopes.includes('write:workouts'),
      bodyCompositionRead: scopes.includes('mcp:read'),
    },
    user: answer.user || null,
  };
}
