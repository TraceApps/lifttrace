/**
 * The body-import provenance as it arrives on a native pull.
 *
 * It is not an ordinary setting (the server owns the claim), so it travels as
 * its own field in GET /api/sync/pull instead of user_settings. This applies
 * that field to the device cache, including the case that matters after Clear
 * Data on another device: no claim means clear the markers and the six-hour
 * throttle, or this phone would refuse every later source on its own.
 */
import { ntProvenanceCache } from './nt-provenance-cache.js';

/**
 * Apply `pull.nt_body_provenance`, if the server sent the field. Returns false
 * for an older server that sends nothing, which must leave the cache alone.
 * `setSetting` is the caller's storage write (DB.setSetting on the phone).
 */
export function applyPulledNtProvenance(pull, { setSetting } = {}) {
  if (typeof setSetting !== 'function') throw new TypeError('setSetting is required');
  if (!pull || pull.nt_body_provenance === undefined) return false;
  for (const [key, value] of Object.entries(ntProvenanceCache(pull.nt_body_provenance))) {
    setSetting(key, value);
  }
  // The claim and the history it described were deleted together, so the
  // throttle that belonged to them goes too.
  if (!pull.nt_body_provenance) setSetting('ntBodyLastSyncAt', null);
  return true;
}
