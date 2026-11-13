/**
 * What the Settings page should hold for the connection the server reports.
 *
 * There are three states, not two. A connection saved before identities and
 * versions existed has a URL, a token and the workout-federation switch, but
 * no identity. Treating "no identity" as "no connection" cleared all of it on
 * upgrade, including the switch Diary checks before sending a workout. The
 * URL and switch are real and stay; only the body import needs a new
 * verification. A failed or missing connection still clears everything.
 */
import { SECRET_SET } from './secret-set.js';

export function serverConnectionState(connection) {
  if (!connection || typeof connection.url !== 'string' || !connection.url) {
    return {
      present: false,
      needsVerification: false,
      values: {
        ntInstanceUrl: '',
        ntInstanceToken: '',
        ntConnectionIdentity: null,
        ntConnectionVersion: 0,
        ntConnectionVerified: false,
        ntFederationEnabled: false,
      },
    };
  }
  const values = {
    ntInstanceUrl: connection.url,
    // The server has the token and never sends it; this page keeps the
    // placeholder so it can be saved again.
    ntInstanceToken: SECRET_SET,
    ntConnectionIdentity: connection.identity || null,
    ntConnectionVersion: Number.isSafeInteger(connection.version) ? connection.version : 0,
    ntConnectionVerified: !!connection.verified && !!connection.identity,
    // The workout push only needs the URL, token and switch. It keeps working
    // while the connection awaits a new verification for body measurements.
    ntFederationEnabled: !!connection.enabled,
  };
  return {
    present: true,
    needsVerification: !connection.verified,
    values,
  };
}
