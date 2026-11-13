/**
 * The device's copy of the server's body-import provenance.
 *
 * The server owns which NutriTrace connection and source imported a body
 * history (server/lib/nt-body-provenance.js). The two settings below are only
 * a cache so the import can stop before asking the server, which is faster
 * than a refused claim and much clearer than a half-started import. A cache
 * that outlives the server record would block the choice forever — exactly
 * what happened when Clear Data deleted the claim but not these markers — so
 * the same helper builds the cache from the server's answer and clears it
 * when that answer is gone.
 */
export const NT_PROVENANCE_CACHE_KEYS = Object.freeze([
  'ntBodySyncedSource',
  'ntBodySyncedConnectionIdentity',
]);

/**
 * The cache values for a server provenance (the `ntBodyProvenance` setting, or
 * the `provenance` of GET /api/nt/federation-connection). A missing or
 * malformed record means nothing is fixed, so the cache is empty.
 */
export function ntProvenanceCache(provenance) {
  const p = provenance && typeof provenance === 'object' && !Array.isArray(provenance) ? provenance : null;
  const source = p && typeof p.source === 'string' ? p.source : '';
  const instanceUrl = p && typeof p.instanceUrl === 'string'
    ? p.instanceUrl.trim().replace(/\/+$/, '')
    : '';
  const userId = p && p.userId != null ? String(p.userId) : '';
  const identity = instanceUrl && userId ? { instanceUrl, userId } : null;
  return {
    ntBodySyncedSource: identity ? source : '',
    ntBodySyncedConnectionIdentity: identity,
  };
}
