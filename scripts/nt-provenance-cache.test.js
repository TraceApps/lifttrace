import assert from 'node:assert/strict';
import test from 'node:test';
import { ntProvenanceCache, NT_PROVENANCE_CACHE_KEYS } from '../src/lib/nt-provenance-cache.js';

test('the device cache is exactly the server provenance', () => {
  assert.deepEqual(
    ntProvenanceCache({ instanceUrl: 'https://nt.example.test/', userId: 7, source: 'withings' }),
    {
      ntBodySyncedSource: 'withings',
      ntBodySyncedConnectionIdentity: { instanceUrl: 'https://nt.example.test', userId: '7' },
    },
  );
});

test('a missing or malformed server record clears the cache', () => {
  for (const value of [null, undefined, {}, [], 'withings', { source: 'withings' }, { instanceUrl: 'https://nt.example.test' }]) {
    assert.deepEqual(ntProvenanceCache(value), {
      ntBodySyncedSource: '',
      ntBodySyncedConnectionIdentity: null,
    }, `${JSON.stringify(value)} means nothing is fixed`);
  }
});

test('both cached keys are covered by the reset path', () => {
  assert.deepEqual([...NT_PROVENANCE_CACHE_KEYS].sort(), [
    'ntBodySyncedConnectionIdentity',
    'ntBodySyncedSource',
  ]);
  assert.deepEqual(Object.keys(ntProvenanceCache(null)).sort(), [...NT_PROVENANCE_CACHE_KEYS].sort());
});
