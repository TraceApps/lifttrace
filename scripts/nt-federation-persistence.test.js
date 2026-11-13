import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  persistFederationConnectionTransition,
  persistServerSetting,
  persistSettingImmediately,
  publishToNtOwner,
  serverConfirmed,
} from '../src/lib/nt-federation-persistence.js';
import { collapseOps, isNetworkOnlySettingOp, sentSeqs, writeOp } from '../src/lib/offline-edits.js';
import { nextAccountGen } from '../src/lib/account-gen.js';
import { captureNtAccount } from '../src/lib/nt-sync-coordination.js';

const settingsStore = readFileSync(new URL('../src/stores/settings.js', import.meta.url), 'utf8');
const federationUi = readFileSync(new URL('../src/components/settings/SettingsFederation.svelte', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');

const SET = '••••••••';

function connection(enabled = false, prefix = 'old') {
  return {
    ntInstanceUrl: `https://${prefix}.example.test`,
    ntInstanceToken: `${prefix}-token`,
    ntFederationEnabled: enabled,
    ntConnectionVerified: enabled,
    ntConnectionIdentity: enabled
      ? { instanceUrl: `https://${prefix}.example.test`, userId: 'account-1', fingerprint: `${prefix}-fingerprint` }
      : null,
    ntConnectionVersion: enabled ? 7 : 0,
    ntBodySyncEnabled: false,
    ntBodySource: '',
  };
}

function nextConnection(prefix = 'new') {
  return {
    ...connection(false, prefix),
    ntFederationEnabled: true,
    ntConnectionVerified: true,
    ntConnectionIdentity: { instanceUrl: `https://${prefix}.example.test`, userId: 'account-2', fingerprint: `${prefix}-fingerprint` },
  };
}

function confirmedAnswer(next, version = 8) {
  return {
    ok: true,
    connection: {
      url: next.ntInstanceUrl,
      identity: next.ntConnectionIdentity,
      enabled: true,
      verified: true,
      version,
    },
    bodySyncEnabled: next.ntBodySyncEnabled,
    capabilities: { workoutWrite: true, bodyCompositionRead: true },
    user: { username: 'pat' },
  };
}

test('a connection transition is one server request, not a sequence of settings writes', async () => {
  const previous = connection(false);
  const next = nextConnection();
  const calls = [];
  const result = await persistFederationConnectionTransition({
    previous,
    next,
    saveConnection: async body => {
      calls.push(body);
      return confirmedAnswer(next);
    },
  });

  assert.deepEqual(calls, [{
    url: next.ntInstanceUrl,
    token: next.ntInstanceToken,
    enabled: true,
    bodySyncEnabled: false,
    // Even a tab opened before the first connection names the version it
    // started from (0), so it cannot turn federation on unconditionally.
    ifVersion: 0,
  }], 'URL, token, identity and enabled are saved together by the server');
  assert.deepEqual(result.values, {
    ntInstanceUrl: next.ntInstanceUrl,
    ntConnectionIdentity: next.ntConnectionIdentity,
    ntConnectionVersion: 8,
    ntConnectionVerified: true,
    ntFederationEnabled: true,
    ntBodySyncEnabled: false,
  });
  assert.equal(result.capabilities.workoutWrite, true);
  assert.equal(result.user.username, 'pat');
});

test('a Save based on an older connection names the version it started from', async () => {
  const previous = connection(true);
  let body;
  await persistFederationConnectionTransition({
    previous,
    next: nextConnection(),
    saveConnection: async request => { body = request; return confirmedAnswer(nextConnection()); },
  });
  assert.equal(body.ifVersion, 7);

  // A tab opened before the first connection has no identity and version 0.
  // It still names that version, so another tab's Save + OFF makes it stale
  // instead of letting it turn federation on unconditionally.
  body = undefined;
  await persistFederationConnectionTransition({
    previous: {
      ...connection(false),
      ntConnectionIdentity: null,
      ntConnectionVersion: 0,
    },
    next: nextConnection(),
    saveConnection: async request => { body = request; return confirmedAnswer(nextConnection()); },
  });
  assert.equal(body.ifVersion, 0);
});

test('nothing is published into an account that signed in while the request was in flight', () => {
  const writes = [];
  const account = captureNtAccount();

  // The account that started the Save no longer owns the phone.
  nextAccountGen();
  assert.equal(publishToNtOwner(account, () => writes.push('stale')), false);
  assert.deepEqual(writes, [], 'the answer of the previous account is dropped after a sign-in');

  // The current account's own answer still goes through.
  const current = captureNtAccount();
  assert.equal(publishToNtOwner(current, () => writes.push('current')), true);
  assert.deepEqual(writes, ['current']);
});

test('a write-only token is sent as the placeholder and never restored client-side', async () => {
  // The page only ever sees dots for a saved token. A second Save must hand
  // the placeholder to the server (which still has the secret), not invent a
  // rollback value of its own.
  const previous = { ...connection(true), ntInstanceToken: SET };
  let body;
  await persistFederationConnectionTransition({
    previous,
    next: { ...nextConnection(), ntInstanceToken: SET },
    saveConnection: async request => {
      body = request;
      return confirmedAnswer({ ...nextConnection(), ntInstanceToken: SET });
    },
  });
  assert.equal(body.token, SET);
});

test('an unconfirmed or offline answer is a failure, never a saved connection', async () => {
  for (const answer of [{ ok: true, queued: true, offline: true }, { offline: true }, null]) {
    await assert.rejects(
      persistFederationConnectionTransition({
        previous: connection(false),
        next: nextConnection(),
        saveConnection: async () => answer,
      }),
      { code: 'unconfirmed' },
    );
  }
  assert.equal(serverConfirmed({ ok: true }), true);
  assert.equal(serverConfirmed({ ok: true, queued: true }), false);
  assert.equal(serverConfirmed({ ok: true, offline: true }), false);
});

test('a server answer without an identity is refused, so nothing local is published', async () => {
  await assert.rejects(
    persistFederationConnectionTransition({
      previous: connection(false),
      next: nextConnection(),
      saveConnection: async () => ({ ok: true, connection: { url: 'https://new.example.test', enabled: true } }),
    }),
    { code: 'unconfirmed' },
  );
});

test('an explicit setting awaits a real server confirmation', async () => {
  const options = {
    saveSetting: async () => ({ ok: true, queued: true, offline: true }),
    cancelScheduledSave() {},
  };
  await assert.rejects(persistServerSetting('ntBodySyncEnabled', true, options), { code: 'unconfirmed' });
  const confirmed = await persistServerSetting('ntBodySource', 'withings', {
    saveSetting: async () => ({ ok: true }),
    cancelScheduledSave() {},
  });
  assert.deepEqual(confirmed, { ok: true });
});

test('rapid explicit changes to one setting reach the server in click order', async () => {
  const calls = [];
  let releaseFirst;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const saveSetting = async (key, value) => {
    if (calls.length === 0) await firstWrite;
    calls.push([key, value]);
    return { ok: true };
  };
  const options = { saveSetting, cancelScheduledSave() {} };

  const enabled = persistSettingImmediately('ntBodySyncEnabled', true, options);
  const disabled = persistSettingImmediately('ntBodySyncEnabled', false, options);
  releaseFirst();
  await Promise.all([enabled, disabled]);

  assert.deepEqual(calls, [
    ['ntBodySyncEnabled', true],
    ['ntBodySyncEnabled', false],
  ]);
});

test('connection settings do not queue, and old queued ones are dropped from the replay', () => {
  // A browser from before the atomic transition may already hold a queued
  // OFF and ON under the shared key. They must not be replayed: the user was
  // told they did not save, and applying the ON later would enable federation
  // or body sync behind their back.
  const legacy = (seq, value) => ({
    method: 'PUT', path: '/api/settings', body: { key: 'ntFederationEnabled', value },
    kind: 'setting', key: 'setting:ntFederationEnabled', seq,
  });
  const off = legacy(1, false);
  const on = legacy(2, true);
  assert.equal(isNetworkOnlySettingOp(off), true);
  assert.deepEqual(collapseOps([off, on]), [], 'neither the OFF nor the ON is replayed');
  assert.deepEqual(sentSeqs([off, on], []).sort(), [1, 2], 'both leave the outbox');
});

test('a connection transition is not a queueable setting operation', () => {
  assert.equal(writeOp('PUT', '/api/nt/federation-connection', { url: 'https://nt.example.test' }), null,
    'the offline layer must send it to the server or fail, never queue it');
  for (const key of ['ntFederationEnabled', 'ntInstanceUrl', 'ntInstanceToken', 'ntConnectionIdentity',
    'ntConnectionVerified', 'ntBodySyncEnabled', 'ntBodySource']) {
    assert.equal(writeOp('PUT', '/api/settings', { key, value: true }), null,
      `${key} has to reach the server or fail, not wait in the outbox`);
  }
  assert.equal(writeOp('PUT', '/api/settings', { key: 'weightUnit', value: 'kg' }).kind, 'setting');
});

test('ordinary settings retain the existing 600 ms generic debounce', () => {
  assert.match(settingsStore, /_saveQueue\[key\] = setTimeout\(\(\) => \{[\s\S]*?\}, 600\);/);
  assert.match(settingsStore, /scheduleSave\(key, value\);/);
});

test('the connection UI saves through the atomic endpoint and shows only confirmed values', () => {
  assert.match(federationUi, /saveConnection: LtApi\.saveNtFederationConnection/);
  assert.match(federationUi, /persistFederationConnectionTransition\(\{/);
  assert.doesNotMatch(federationUi, /saveSettingNow\('ntFederationEnabled'/,
    'the enabled flag is written with the connection, not as its own setting');
  assert.match(federationUi, /persistServerSetting\(key, value/);
  assert.match(federationUi, /publishToNtOwner\(account/);
  assert.match(federationUi, /publishConnection\(result, account\)/);
  assert.doesNotMatch(federationUi, /publishConnection\(result\);/,
    'a confirmation is never published without the account that asked for it');
  assert.match(federationUi, /reconcileConnection\(account\)/);
  assert.match(federationUi, /isDefiniteConnectionError\(error\) \? null : await reconcileConnection\(account\)/);
  assert.match(api, /saveNtFederationConnection: \(connection\)/);
  assert.match(api, /\/api\/nt\/federation-connection/);
});
