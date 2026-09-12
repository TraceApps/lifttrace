/**
 * server/lib/webhook-delivery.js
 *
 * Pure delivery mechanics for outgoing webhooks (issue #79): building
 * the signed envelope and sending it. Deliberately has NO db.js import
 * (server/lib/webhooks.js owns the DB-backed subscription management
 * and delivery-status bookkeeping, and imports these two functions from
 * here), so this file, and only this file, can be unit-tested directly
 * without a compiled better-sqlite3 native binding, which the rest of
 * the webhooks feature needs.
 */
import { createHmac } from 'crypto';

const FETCH_TIMEOUT_MS = 10000;

/**
 * Build the signed envelope for one delivery. Pure (no DB, no network).
 */
export function signEnvelope(secret, event, data) {
  const envelope = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
  const signature = createHmac('sha256', secret).update(envelope).digest('hex');
  return { envelope, signature };
}

/**
 * POST one already-signed envelope to `url`. Throws on a non-2xx
 * response, a network error, or the fetch timing out, callers decide
 * whether/how to retry.
 */
export async function sendWebhookRequest(url, envelope, signature, deliveryId, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-LiftTrace-Signature': `sha256=${signature}`,
        'X-LiftTrace-Event': event,
        'X-LiftTrace-Delivery': deliveryId,
      },
      body: envelope,
    });
    if (!res.ok) throw new Error(`Upstream responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
