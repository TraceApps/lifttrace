/**
 * Trace's log_cardio honors Track Cardio (issue #134 follow-up).
 *
 * The public API and MCP refuse a cardio write while Track Cardio is off,
 * but Trace's own log_cardio posted to /api/cardio regardless, so a session
 * was saved where the Diary doesn't show it. It now refuses with the same
 * meaning, reading this device's setting (no server needed, so it holds
 * offline and in the Android app's local mode). get_cardio still reads, as
 * the API does, and says whether cardio is on.
 *
 * These run the real tools (src/lib/aiTools.js) with this device's settings
 * in an in-memory localStorage and every request recorded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window = new EventTarget();

const requests = [];
globalThis.fetch = async (path, init = {}) => {
  const method = init.method || 'GET';
  requests.push({ method, path });
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path.startsWith('/api/cardio?')) return json([{ id: 4, date: '2026-10-20', activity: 'Running', duration_min: 30 }]);
  if (path === '/api/cardio' && method === 'POST') return json({ id: 9, ...JSON.parse(init.body) });
  return json({});
};

const { runTool, CARDIO_OFF } = await import('../src/lib/aiTools.js');
const TODAY = new Date().toLocaleDateString('sv-SE');
const setCardio = (on, user = null) => store.set(user ? `wl_u${user}_cardioEnabled` : 'wl_cardioEnabled', JSON.stringify(on));

test('the refusal says what the API says, without the Android-only advice', () => {
  assert.equal(CARDIO_OFF, 'Cardio is off for this account. Turn on Track Cardio in LiftTrace under Settings > Workout.');
});

test('log_cardio is refused while Track Cardio is off, and nothing is sent', async () => {
  store.clear(); requests.length = 0;
  // Never set on this device: off, the default.
  await assert.rejects(runTool('log_cardio', { activity: 'Running', duration_min: 30, date: TODAY }), { message: CARDIO_OFF });
  setCardio(false);
  await assert.rejects(runTool('log_cardio', { activity: 'Running', duration_min: 30, date: TODAY }), { message: CARDIO_OFF });
  // A far-off date is refused for cardio being off, not for the date.
  await assert.rejects(runTool('log_cardio', { activity: 'Running', duration_min: 30, date: '2020-01-01' }), { message: CARDIO_OFF });
  assert.deepEqual(requests.filter(r => r.path.startsWith('/api/cardio')), []);
});

test('log_cardio logs once Track Cardio is on', async () => {
  store.clear(); requests.length = 0;
  setCardio(true);
  const r = await runTool('log_cardio', { activity: 'Running', duration_min: 30, date: TODAY });
  assert.equal(r.id, 9);
  assert.deepEqual(requests.filter(r => r.path === '/api/cardio'), [{ method: 'POST', path: '/api/cardio' }]);
});

test('the signed-in account\'s own setting decides, not another account\'s', async () => {
  store.clear(); requests.length = 0;
  setCardio(true);              // signed out, or a different account
  store.set('wl:userId', '7');
  setCardio(false, 7);
  await assert.rejects(runTool('log_cardio', { activity: 'Running', duration_min: 30, date: TODAY }), { message: CARDIO_OFF });
  setCardio(true, 7);
  await runTool('log_cardio', { activity: 'Running', duration_min: 30, date: TODAY });
  assert.equal(requests.filter(r => r.path === '/api/cardio').length, 1);
});

test('get_cardio still reads while off, as the API does, and says whether cardio is on', async () => {
  store.clear(); requests.length = 0;
  setCardio(false);
  const off = await runTool('get_cardio', {});
  assert.equal(off.cardio_enabled, false);
  assert.equal(off.count, 1);
  setCardio(true);
  assert.equal((await runTool('get_cardio', {})).cardio_enabled, true);
});
