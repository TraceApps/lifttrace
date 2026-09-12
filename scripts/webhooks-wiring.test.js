/**
 * Static-analysis tests for outgoing webhooks wiring (issue #79).
 *
 * These do not exercise real deliveries; they guard against accidental
 * unwiring of the route mount, the feature flags, or an event call site
 * being removed during future refactors. Pure text/regex checks over
 * the source files, no db.js import, so this runs without a compiled
 * better-sqlite3 native binding. Real delivery verification (signature,
 * retry, SSRF guard against a live target) requires a running dev
 * server with WEBHOOKS_ENABLED=1 and a test receiver.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const routeJs   = readFileSync(new URL('../server/routes/webhooks.js', import.meta.url), 'utf8');
const libJs     = readFileSync(new URL('../server/lib/webhooks.js', import.meta.url), 'utf8');
const deliveryJs = readFileSync(new URL('../server/lib/webhook-delivery.js', import.meta.url), 'utf8');
const workoutJs = readFileSync(new URL('../server/routes/workout.js', import.meta.url), 'utf8');
const bodyStatsJs = readFileSync(new URL('../server/routes/body-stats.js', import.meta.url), 'utf8');
const dbJs      = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

test('webhooks route is mounted at /api/webhooks on the main router', () => {
  assert.match(indexJs, /import webhooksRoutes[\s\S]*from '\.\/routes\/webhooks\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/webhooks',\s*webhooksRoutes\)/);
});

test('webhooks CRUD route requires session auth (requireAuth, requireAdmin), not bearer', () => {
  assert.match(routeJs, /requireAuth,\s*requireAdmin/);
  assert.doesNotMatch(routeJs, /bearerAuth/);
});

test('webhooks table exists with an encrypted secret column, not a hash', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS webhooks/);
  assert.match(dbJs, /secret_encrypted/);
});

test('webhook delivery is gated on WEBHOOKS_ENABLED, off by default', () => {
  assert.match(libJs, /WEBHOOKS_ENABLED/);
});

test('webhook target URLs are validated through the shared SSRF guard, at creation and before delivery', () => {
  assert.match(libJs, /import \{ assertSafeUrl \} from '\.\/ssrf-guard\.js'/);
  const occurrences = [...libJs.matchAll(/assertSafeUrl\(/g)];
  assert.ok(occurrences.length >= 3, 'expected assertSafeUrl called at create, update, and delivery time');
});

test('the four known events are all registered with descriptions', () => {
  for (const event of ['workout.completed', 'body_stat.logged', 'pr.set', 'program.advanced']) {
    assert.match(libJs, new RegExp(`'${event.replace('.', '\\.')}'`));
  }
});

test('delivery is signed with HMAC-SHA256 and carries event/delivery-id headers', () => {
  // Lives in webhook-delivery.js, the pure module split out specifically
  // so this logic (and scripts/webhook-delivery.test.js's real HTTP
  // behavioral tests against it) don't need a compiled better-sqlite3
  // binding the way the rest of webhooks.js does.
  assert.match(deliveryJs, /createHmac\('sha256'/);
  assert.match(deliveryJs, /X-LiftTrace-Signature/);
  assert.match(deliveryJs, /X-LiftTrace-Event/);
  assert.match(deliveryJs, /X-LiftTrace-Delivery/);
  assert.match(libJs, /import \{ signEnvelope, sendWebhookRequest \} from '\.\/webhook-delivery\.js'/);
});

test('delivery retries up to 3 attempts and never throws out of dispatchWebhookEvent', () => {
  assert.match(libJs, /MAX_ATTEMPTS\s*=\s*3/);
  assert.match(libJs, /export function dispatchWebhookEvent/);
});

test('a test-delivery endpoint exists so a webhook can be verified without waiting for a real event', () => {
  assert.match(routeJs, /router\.post\('\/:id\/test'/);
  assert.match(libJs, /export async function sendTestWebhook/);
});

test('workout.js dispatches workout.completed, pr.set, and program.advanced', () => {
  assert.match(workoutJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(workoutJs, /dispatchWebhookEvent\(userId, 'workout\.completed'/);
  assert.match(workoutJs, /dispatchWebhookEvent\(userId, 'pr\.set'/);
  assert.match(workoutJs, /dispatchWebhookEvent\(userId, 'program\.advanced'/);
});

test('workout.js dispatch calls are wrapped so a webhook failure cannot block the save', () => {
  // Each of the 3 dispatchWebhookEvent( call sites in workout.js should
  // be paired with the same "never let a webhook failure block the
  // save" catch comment, whether the call is inline on one line
  // (workout.completed, pr.set) or spread across several (program.
  // advanced, which needs a nested if before the call). A crude but
  // effective regression guard against someone hoisting a call out of
  // its try/catch later.
  const dispatchCount = (workoutJs.match(/dispatchWebhookEvent\(/g) || []).length;
  const guardCatchCount = (workoutJs.match(/catch \(e\) \{ \/\* never let a webhook failure block the save \*\/ \}/g) || []).length;
  assert.equal(dispatchCount, 3, 'expected exactly 3 dispatchWebhookEvent call sites in workout.js');
  assert.equal(guardCatchCount, 3, 'expected each dispatchWebhookEvent call site to have a matching never-block-the-save catch');
});

test('body-stats.js dispatches body_stat.logged after every save', () => {
  assert.match(bodyStatsJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(bodyStatsJs, /dispatchWebhookEvent\(userId, 'body_stat\.logged'/);
});

test('pr.set detection is gated by hasQualifyingSet, not run on every save', () => {
  assert.match(workoutJs, /import \{ getRecordsCore, hasQualifyingSet \} from '\.\.\/lib\/mcp\/tools\/get-records\.js'/);
  assert.match(workoutJs, /hasQualifyingSet\(exercises\)/);
});
