import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  persistFederationConnectionTransition,
  persistSettingImmediately,
} from '../src/lib/nt-federation-persistence.js';

const settingsStore = readFileSync(new URL('../src/stores/settings.js', import.meta.url), 'utf8');
const federationUi = readFileSync(new URL('../src/components/settings/SettingsFederation.svelte', import.meta.url), 'utf8');

function connection(enabled = false, prefix = 'old') {
  return {
    ntInstanceUrl: `https://${prefix}.example.test`,
    ntInstanceToken: `${prefix}-token`,
    ntFederationEnabled: enabled,
    ntConnectionVerified: enabled,
    ntConnectionIdentity: enabled ? { instanceUrl: `https://${prefix}.example.test`, userId: 'account-1' } : null,
    ntBodySyncEnabled: false,
    ntBodySource: '',
  };
}

function nextConnection(prefix = 'new') {
  return {
    ...connection(false, prefix),
    ntFederationEnabled: true,
    ntConnectionVerified: true,
    ntConnectionIdentity: { instanceUrl: `https://${prefix}.example.test`, userId: 'account-2' },
  };
}

function persistenceHarness(initial, { fail } = {}) {
  const server = { ...initial };
  const calls = [];
  return {
    server,
    calls,
    async saveSetting(key, value) {
      calls.push([key, value]);
      if (fail?.(key, value, calls)) throw new Error(`write failed: ${key}`);
      server[key] = value;
      return { ok: true };
    },
    cancelScheduledSave(key) { calls.push(['cancel', key]); },
  };
}

test('tested federation connection is durably saved before transition resolves', async () => {
  const previous = connection(false);
  const next = nextConnection();
  const h = persistenceHarness(previous);

  await persistFederationConnectionTransition({
    previous,
    next,
    saveSetting: h.saveSetting,
    cancelScheduledSave: h.cancelScheduledSave,
  });

  for (const key of [
    'ntInstanceUrl', 'ntInstanceToken', 'ntConnectionIdentity',
    'ntConnectionVerified', 'ntFederationEnabled',
  ]) assert.deepEqual(h.server[key], next[key]);
});

test('federation is enabled only after URL, token, identity, and verification writes', async () => {
  const previous = connection(false);
  const next = nextConnection();
  const h = persistenceHarness(previous);

  await persistFederationConnectionTransition({
    previous,
    next,
    saveSetting: h.saveSetting,
    cancelScheduledSave: h.cancelScheduledSave,
  });

  const trueEnable = h.calls.findIndex(([key, value]) => key === 'ntFederationEnabled' && value === true);
  assert.ok(trueEnable > h.calls.findIndex(([key, value]) => key === 'ntConnectionVerified' && value === true));
  for (const key of ['ntInstanceUrl', 'ntInstanceToken', 'ntConnectionIdentity']) {
    assert.ok(trueEnable > h.calls.findIndex(([calledKey]) => calledKey === key));
  }
  assert.equal(h.calls.filter(([key, value]) => key === 'ntFederationEnabled' && value === true).length, 1);
});

test('body sync disabled by a successful scope check is persisted before federation is enabled', async () => {
  const previous = { ...connection(false), ntBodySyncEnabled: true };
  const next = { ...nextConnection(), ntBodySyncEnabled: false };
  const h = persistenceHarness(previous);

  await persistFederationConnectionTransition({
    previous,
    next,
    saveSetting: h.saveSetting,
    cancelScheduledSave: h.cancelScheduledSave,
  });

  const bodySyncOff = h.calls.findIndex(([key, value]) => key === 'ntBodySyncEnabled' && value === false);
  const federationOn = h.calls.findIndex(([key, value]) => key === 'ntFederationEnabled' && value === true);
  assert.ok(bodySyncOff >= 0 && bodySyncOff < federationOn);
  assert.equal(h.server.ntBodySyncEnabled, false);
});

test('a failed connection write leaves a previously disabled server disabled', async () => {
  const previous = connection(false);
  const next = nextConnection();
  const h = persistenceHarness(previous, {
    fail: (key, value) => key === 'ntConnectionVerified' && value === true,
  });

  await assert.rejects(persistFederationConnectionTransition({
    previous,
    next,
    saveSetting: h.saveSetting,
    cancelScheduledSave: h.cancelScheduledSave,
  }));

  assert.equal(h.server.ntFederationEnabled, false);
  assert.equal(h.calls.some(([key, value]) => key === 'ntFederationEnabled' && value === true), false);
});

test('failed transition restores an earlier working connection before re-enabling it', async () => {
  const previous = connection(true);
  const next = nextConnection();
  const h = persistenceHarness(previous, {
    fail: (key, value, calls) => key === 'ntConnectionIdentity' && value === next.ntConnectionIdentity
      && calls.filter(([calledKey, calledValue]) => calledKey === 'ntConnectionIdentity' && calledValue === next.ntConnectionIdentity).length === 1,
  });

  await assert.rejects(persistFederationConnectionTransition({
    previous,
    next,
    saveSetting: h.saveSetting,
    cancelScheduledSave: h.cancelScheduledSave,
  }));

  assert.equal(h.server.ntFederationEnabled, true);
  assert.equal(h.server.ntInstanceUrl, previous.ntInstanceUrl);
  assert.equal(h.server.ntInstanceToken, previous.ntInstanceToken);
  assert.deepEqual(h.server.ntConnectionIdentity, previous.ntConnectionIdentity);
  assert.equal(h.server.ntConnectionVerified, true);
});

test('explicit federation, body-sync, and source changes await immediate persistence', async () => {
  const calls = [];
  const saveSetting = async (key, value) => {
    calls.push([key, value]);
    return { ok: true };
  };
  const cancelScheduledSave = key => calls.push(['cancel', key]);

  await persistSettingImmediately('ntFederationEnabled', true, { saveSetting, cancelScheduledSave });
  await persistSettingImmediately('ntBodySyncEnabled', true, { saveSetting, cancelScheduledSave });
  await persistSettingImmediately('ntBodySource', 'wearable-a', { saveSetting, cancelScheduledSave });

  assert.deepEqual(calls.filter(([key]) => key !== 'cancel'), [
    ['ntFederationEnabled', true],
    ['ntBodySyncEnabled', true],
    ['ntBodySource', 'wearable-a'],
  ]);
  assert.match(federationUi, /on:change=\{onFederationToggle\}/);
  assert.match(federationUi, /on:change=\{onBodySyncToggle\}/);
  assert.match(federationUi, /on:change=\{onBodySourceChange\}/);
  assert.match(federationUi, /saveSettingNow\('ntFederationEnabled', next\)/);
  assert.match(federationUi, /saveSettingNow\('ntBodySyncEnabled', next\)/);
  assert.match(federationUi, /saveSettingNow\('ntBodySource', next\)/);
});

test('rapid explicit changes to one setting reach the server in click order', async () => {
  const calls = [];
  let releaseFirst;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const saveSetting = async (key, value) => {
    if (calls.length === 0) await firstWrite;
    calls.push([key, value]);
  };
  const options = { saveSetting, cancelScheduledSave() {} };

  const enabled = persistSettingImmediately('ntFederationEnabled', true, options);
  const disabled = persistSettingImmediately('ntFederationEnabled', false, options);
  releaseFirst();
  await Promise.all([enabled, disabled]);

  assert.deepEqual(calls, [
    ['ntFederationEnabled', true],
    ['ntFederationEnabled', false],
  ]);
});

test('ordinary settings retain the existing 600 ms generic debounce', () => {
  assert.match(settingsStore, /_saveQueue\[key\] = setTimeout\(\(\) => \{[\s\S]*?\}, 600\);/);
  assert.match(settingsStore, /scheduleSave\(key, value\);/);
});
