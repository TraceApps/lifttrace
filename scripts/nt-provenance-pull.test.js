import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPulledNtProvenance } from '../src/lib/nt-provenance-pull.js';

function applied(pull) {
  const writes = new Map();
  const handled = applyPulledNtProvenance(pull, { setSetting: (key, value) => writes.set(key, value) });
  return { handled, writes };
}

test('a pull with a claim rebuilds the device cache', () => {
  const { handled, writes } = applied({
    nt_body_provenance: { instanceUrl: 'https://nt.example.test/', userId: 7, source: 'withings' },
  });
  assert.equal(handled, true);
  assert.deepEqual(Object.fromEntries(writes), {
    ntBodySyncedSource: 'withings',
    ntBodySyncedConnectionIdentity: { instanceUrl: 'https://nt.example.test', userId: '7' },
  });
});

test('a pull with no claim clears the markers and the throttle', () => {
  const { handled, writes } = applied({ nt_body_provenance: null });
  assert.equal(handled, true);
  assert.equal(writes.get('ntBodySyncedSource'), '');
  assert.equal(writes.get('ntBodySyncedConnectionIdentity'), null);
  assert.equal(writes.get('ntBodyLastSyncAt'), null);
});

test('an older server that sends no field leaves the cache alone', () => {
  const { handled, writes } = applied({ user_settings: [] });
  assert.equal(handled, false);
  assert.equal(writes.size, 0);
});
