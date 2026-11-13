/**
 * A NutriTrace connection change and a body import must not overlap.
 *
 * The failing sequence this guards: Settings publishes the new connection
 * locally, the server still has the old one, a foreground sync starts and maps
 * the previous NutriTrace account's measurements to the new provenance. Here a
 * PUT is held open (`deferred`) while a lifecycle sync is triggered, which is
 * the exact window.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { nextAccountGen } from '../src/lib/account-gen.js';
import {
  runNtExclusive,
  ntExclusiveBusy,
  captureNtAccount,
  ntAccountChanged,
  ntAccountChangedError,
} from '../src/lib/nt-sync-coordination.js';
import {
  persistFederationConnectionTransition,
  persistSettingImmediately,
} from '../src/lib/nt-federation-persistence.js';
import { syncNtBodyMeasurements } from '../src/lib/nt-body-sync.js';

const store = (value) => ({
  value,
  get() { return this.value; },
  set(next) { this.value = next; },
});

const connection = (url, userId) => ({ instanceUrl: url, userId });

const observation = (date, source, metrics) => ({ date, source, metrics });

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** Let queued microtasks *and* the macrotask they are waiting on run. */
const flush = () => new Promise(resolve => setImmediate(resolve));

function previousConnection() {
  return {
    ntInstanceUrl: '',
    ntInstanceToken: '',
    ntFederationEnabled: false,
    ntConnectionVerified: false,
    ntConnectionIdentity: null,
    ntBodySyncEnabled: true,
    ntBodySource: '',
  };
}

function nextConnection() {
  return {
    ntInstanceUrl: 'https://new.example.test',
    ntInstanceToken: 'new-token',
    ntFederationEnabled: true,
    ntConnectionVerified: true,
    ntConnectionIdentity: connection('https://new.example.test', 'account-2'),
    ntBodySyncEnabled: true,
    ntBodySource: '',
  };
}

function confirmed(next) {
  return {
    ok: true,
    connection: {
      url: next.ntInstanceUrl,
      identity: next.ntConnectionIdentity,
      enabled: !!next.ntFederationEnabled,
      verified: true,
    },
    bodySyncEnabled: next.ntBodySyncEnabled,
    capabilities: { workoutWrite: true, bodyCompositionRead: true },
    user: { username: 'pat' },
  };
}

function bodySettings(identity) {
  return {
    ntFederationEnabled: store(false),
    ntBodySyncEnabled: store(true),
    ntConnectionIdentity: store(identity),
    ntBodySyncedConnectionIdentity: store(null),
    ntBodySyncedSource: store(''),
    ntBodySource: store(''),
    ntBodyLastSyncAt: store(null),
    weightUnit: store('kg'),
    currentWeightKg: store(null),
  };
}

test('a sync triggered while a connection transition holds a PUT waits for it', async () => {
  const hold = deferred();
  const next = nextConnection();
  const settings = bodySettings(null);
  const order = [];
  const claims = [];
  let observedDuringTransition = 0;

  const saveConnection = async () => {
    order.push('save-connection');
    await hold.promise;
    return confirmed(next);
  };

  const transition = runNtExclusive(async () => {
    const result = await persistFederationConnectionTransition({
      previous: previousConnection(),
      next,
      saveConnection,
    });
    // What SettingsFederation now does inside the same critical section:
    // publish only after the server transition is confirmed.
    settings.ntInstanceUrl = store(result.values.ntInstanceUrl);
    settings.ntFederationEnabled.set(true);
    settings.ntConnectionIdentity.set(result.values.ntConnectionIdentity);
    order.push('published');
  });

  const sync = syncNtBodyMeasurements({
    manual: true,
    settings,
    now: Date.parse('2026-09-26T12:00:00Z'),
    api: {
      async getNtBodyComposition() {
        observedDuringTransition += 1;
        order.push('nt-read');
        return { readId: 'read-1', measurements: [observation('2026-08-15', 'source-a', { weight_kg: 73.1 })] };
      },
      async claimNtBodyProvenance(candidate) {
        order.push('claim');
        claims.push(candidate);
        return { ok: true, provenance: { ...candidate.connectionIdentity, source: candidate.source } };
      },
      async getBodyStatsRange() { return [{ date: '2026-08-15', stats: { weight: 73.1 } }]; },
      async saveBodyStats() { throw new Error('an identical observation must not be written'); },
    },
  });

  // The lifecycle trigger runs while the transition is waiting on its server
  // request and while the app still shows the previous connection.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(observedDuringTransition, 0, 'the sync must not read while the transition is in flight');

  hold.release();
  const [transitionResult, syncResult] = await Promise.all([transition, sync]);

  assert.equal(transitionResult, undefined);
  assert.equal(syncResult.status, 'ok');
  assert.equal(observedDuringTransition, 1);
  assert.equal(claims.length, 1, 'the import claims once, after the transition');
  assert.deepEqual(claims[0], { connectionIdentity: next.ntConnectionIdentity, source: 'source-a', readId: 'read-1' });
  assert.ok(order.indexOf('published') < order.indexOf('nt-read'), 'the import reads only the published connection');
  assert.ok(order.indexOf('claim') > order.indexOf('nt-read'));
});

test('a transition queued behind a running import starts after the import settles', async () => {
  const hold = deferred();
  const next = nextConnection();
  const settings = bodySettings(null);
  settings.ntFederationEnabled.set(true);
  const order = [];
  const writes = [];
  let account = connection('https://old.example.test', 'account-1');
  settings.ntConnectionIdentity.set(account);

  const sync = syncNtBodyMeasurements({
    manual: true,
    settings,
    now: Date.parse('2026-09-26T12:00:00Z'),
    api: {
      async getNtBodyComposition() {
        order.push('nt-read');
        await hold.promise;
        return { readId: 'read-1', measurements: [observation('2026-08-15', 'source-a', { weight_kg: 73.1 })] };
      },
      async claimNtBodyProvenance(candidate) {
        order.push('claim');
        return { ok: true, provenance: { ...candidate.connectionIdentity, source: candidate.source } };
      },
      async getBodyStatsRange() { return []; },
      async saveBodyStats(date, payload) {
        order.push('body-put');
        writes.push([date, payload]);
      },
    },
  });

  const saveConnection = async () => { order.push('save-connection'); return confirmed(next); };
  const transition = runNtExclusive(() => persistFederationConnectionTransition({
    previous: previousConnection(),
    next,
    saveConnection,
  }));

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(order.filter(entry => entry === 'save-connection').length, 0, 'the transition waits for the import');

  hold.release();
  const [syncResult] = await Promise.all([sync, transition]);

  assert.equal(syncResult.status, 'ok');
  assert.equal(writes.length, 1);
  assert.ok(order.indexOf('body-put') < order.indexOf('save-connection'));
  assert.equal(ntExclusiveBusy(), false);
});

test('a queued body sync is cancelled if the account changes before its turn', async () => {
  const hold = deferred();
  const settings = bodySettings(connection('https://nt.example.test', 'account-1'));
  settings.ntFederationEnabled.set(true);
  settings.ntBodySyncedConnectionIdentity.set(connection('https://nt.example.test', 'account-1'));
  settings.ntBodySyncedSource.set('source-a');
  let reads = 0;

  const blocker = runNtExclusive(async () => { await hold.promise; });
  const sync = syncNtBodyMeasurements({
    manual: true,
    settings,
    now: Date.parse('2026-09-26T12:00:00Z'),
    api: {
      async getNtBodyComposition() { reads += 1; return { readId: 'read-1', measurements: [] }; },
    },
  });

  await Promise.resolve();
  nextAccountGen(); // somebody signed out and another account signed in
  hold.release();

  const [result] = await Promise.all([sync, blocker]);
  assert.equal(result.status, 'account-changed');
  assert.equal(reads, 0, 'nothing is read for the next account');
});

test('a transition already on the wire writes nothing else after a sign-in', async () => {
  const hold = deferred();
  const next = nextConnection();
  const calls = [];

  const saveConnection = async body => {
    calls.push(body);
    await hold.promise;
    return confirmed(next);
  };

  const transition = persistFederationConnectionTransition({
    previous: previousConnection(),
    next,
    saveConnection,
  });

  await flush();
  assert.equal(calls.length, 1, 'one request carries the whole connection');
  nextAccountGen();
  hold.release();

  const result = await transition;
  assert.equal(result.values.ntInstanceUrl, next.ntInstanceUrl);
  assert.equal(calls.length, 1, 'no second write, url/token/identity put, or rollback follows');
});

test('a queued explicit setting write is dropped when the account changes', async () => {
  const hold = deferred();
  const calls = [];
  let firstPut = true;
  const saveSetting = async (key, value) => {
    calls.push([key, value]);
    if (firstPut) { firstPut = false; await hold.promise; }
  };
  const options = { saveSetting, cancelScheduledSave() {} };

  const first = persistSettingImmediately('ntInstanceUrl', 'https://old.example.test', options);
  const second = persistSettingImmediately('ntInstanceUrl', 'https://older.example.test', options);
  await flush();
  nextAccountGen();
  hold.release();

  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, 'fulfilled', 'the write already on the wire is not undone');
  assert.equal(secondResult.status, 'rejected');
  assert.equal(secondResult.reason.code, 'account-changed');
  assert.deepEqual(calls, [['ntInstanceUrl', 'https://old.example.test']],
    'the queued write for the old account never reaches the new one');
});

test('one exclusive queue keeps arrival order and survives a failed task', async () => {
  const order = [];
  const first = runNtExclusive(async () => { order.push('first'); });
  const failing = runNtExclusive(async () => { order.push('failing'); throw new Error('boom'); });
  const last = runNtExclusive(async () => { order.push('last'); });

  await first;
  await assert.rejects(failing, /boom/);
  await last;
  assert.deepEqual(order, ['first', 'failing', 'last']);
  assert.equal(ntExclusiveBusy(), false);
});

test('a failed transition is one failed request, not a sequence to roll back', async () => {
  const calls = [];
  await assert.rejects(
    persistFederationConnectionTransition({
      previous: previousConnection(),
      next: nextConnection(),
      saveConnection: async body => { calls.push(body); throw new Error('network'); },
    }),
    /network/,
  );
  assert.equal(calls.length, 1, 'nothing after the failed request writes a token, URL or identity');
});

test('a connection transition queued before a sign-in writes nothing for the next account', async () => {
  const hold = deferred();
  const blocker = runNtExclusive(() => hold.promise);
  // SettingsFederation captures this before the connection test and hands it
  // to the transition; the FIFO can delay the transition across a sign-in.
  const account = captureNtAccount();
  const calls = [];

  // Exactly what SettingsFederation does: the transition and its local publish
  // run inside one queued callback, which re-checks the account on entry.
  const transition = runNtExclusive(async () => {
    if (ntAccountChanged(account)) throw ntAccountChangedError();
    await persistFederationConnectionTransition({
      previous: previousConnection(),
      next: nextConnection(),
      saveConnection: async body => { calls.push(body); return confirmed(nextConnection()); },
      account,
    });
  });
  const settled = transition.then(value => ({ value }), error => ({ error }));

  await flush();
  nextAccountGen();
  hold.release();

  const { error } = await settled;
  assert.equal(error.code, 'account-changed');
  assert.deepEqual(calls, [], 'no connection request at all for the next account');
  await blocker;
});
