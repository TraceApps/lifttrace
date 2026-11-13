/**
 * nt-read-receipts.js — one body-composition read, bound to the NutriTrace
 * connection it was actually answered for.
 *
 * A claim names a source and a connection, but the measurements it describes
 * were read earlier, through the proxy. Between those two moments another tab
 * can switch the saved connection away and back:
 *
 *   tab 1: reads with A saved
 *   tab 2: switches the server to B, tab 1's read is answered by B
 *   tab 2: switches back to A
 *   tab 1: claims A
 *
 * The claim would match the (restored) saved connection while the measurements
 * belong to B. So the read itself carries a receipt: GET /api/nt/body-composition
 * issues one, bound to the connection snapshot it was performed with, and the
 * claim must present it. A receipt from another connection, another account, an
 * expired one or an unknown id is refused, and the import stops before any
 * write.
 *
 * Held in this process's memory with a short TTL: the app is a single Node
 * process over one SQLite file, and a receipt is only needed for the seconds
 * between a read and its claim. A restart or an expired receipt refuses the
 * claim (fail-closed); the next foreground sync reads again and gets a fresh
 * one.
 */
import { randomUUID } from 'node:crypto';

export const BODY_READ_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 500;

/** readId -> { userId, instanceUrl, ntUserId, expiresAt } */
const receipts = new Map();

function sweep(now) {
  for (const [id, receipt] of receipts) {
    if (receipt.expiresAt <= now) receipts.delete(id);
  }
  // A tab that reads repeatedly without ever claiming must not grow the map
  // without bound; the oldest entries are the least useful.
  while (receipts.size >= MAX_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    receipts.delete(oldest);
  }
}

/**
 * Record the connection a body-composition read was performed with.
 * `identity` is the verified NutriTrace identity ({ instanceUrl, userId,
 * revision }). The revision is part of the receipt because it also ties the
 * identity to the exact saved credential: a token rotation or another tab's
 * Save between the read and the claim invalidates it.
 */
export function issueReadReceipt(userId, identity, now = Date.now()) {
  if (userId == null) return null;
  if (!identity || typeof identity.instanceUrl !== 'string' || identity.userId == null) return null;
  sweep(now);
  const readId = randomUUID();
  receipts.set(readId, {
    userId: String(userId),
    instanceUrl: identity.instanceUrl,
    ntUserId: String(identity.userId),
    revision: typeof identity.revision === 'string' ? identity.revision : null,
    expiresAt: now + BODY_READ_TTL_MS,
  });
  return readId;
}

/**
 * Take a receipt once. Returns null for an unknown id, another account's id, or
 * an expired one, so an invalid/forged/foreign readId can never be used.
 */
export function takeReadReceipt(readId, userId, now = Date.now()) {
  if (typeof readId !== 'string' || !readId || userId == null) return null;
  sweep(now);
  const receipt = receipts.get(readId);
  if (!receipt) return null;
  receipts.delete(readId);
  if (receipt.userId !== String(userId) || receipt.expiresAt <= now) return null;
  return { instanceUrl: receipt.instanceUrl, userId: receipt.ntUserId, revision: receipt.revision };
}

/** Test and diagnostics only: how many receipts this process holds. */
export function heldReceiptCount() {
  return receipts.size;
}

export function resetReadReceipts() {
  receipts.clear();
}
