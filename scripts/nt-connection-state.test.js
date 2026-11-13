import assert from 'node:assert/strict';
import test from 'node:test';
import { serverConnectionState } from '../src/lib/nt-connection-state.js';

const SET = '••••••••';

test('a connection saved before identities keeps its URL, token placeholder and workout switch', () => {
  const state = serverConnectionState({
    url: 'https://nt.example.test',
    identity: null,
    enabled: true,
    verified: false,
    version: 4,
  });
  assert.equal(state.present, true);
  assert.equal(state.needsVerification, true);
  assert.deepEqual(state.values, {
    ntInstanceUrl: 'https://nt.example.test',
    ntInstanceToken: SET,
    ntConnectionIdentity: null,
    ntConnectionVersion: 4,
    ntConnectionVerified: false,
    // Diary checks this before sending a workout: it must stay on.
    ntFederationEnabled: true,
  });
});

test('a verified connection carries the identity and version the server reported', () => {
  const state = serverConnectionState({
    url: 'https://nt.example.test',
    identity: { instanceUrl: 'https://nt.example.test', userId: '7', fingerprint: 'fp' },
    enabled: true,
    verified: true,
    version: 9,
  });
  assert.equal(state.present, true);
  assert.equal(state.needsVerification, false);
  assert.deepEqual(state.values.ntConnectionIdentity, {
    instanceUrl: 'https://nt.example.test', userId: '7', fingerprint: 'fp',
  });
  assert.equal(state.values.ntConnectionVersion, 9);
  assert.equal(state.values.ntConnectionVerified, true);
  assert.equal(state.values.ntFederationEnabled, true);
});

test('no connection clears everything', () => {
  const state = serverConnectionState(null);
  assert.equal(state.present, false);
  assert.equal(state.needsVerification, false);
  assert.deepEqual(state.values, {
    ntInstanceUrl: '',
    ntInstanceToken: '',
    ntConnectionIdentity: null,
    ntConnectionVersion: 0,
    ntConnectionVerified: false,
    ntFederationEnabled: false,
  });
});
