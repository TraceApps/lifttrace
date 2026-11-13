/**
 * nt-sync-coordination.js — keeps a NutriTrace connection change and a body
 * sync from overlapping, and keeps both attached to the account they started
 * under.
 *
 * A body import reads provenance from the connection and then writes
 * measurements. A connection change replaces that connection. Run together,
 * the import can read the previous NutriTrace account and attribute the
 * measurements to the next one. So both take the same queue:
 *
 *   - a sync that starts while a transition is running waits for it, then
 *     reads the settings the transition left behind;
 *   - a transition that starts while a sync is running waits for the sync, so
 *     the running import finishes against the connection it read.
 *
 * The queue is per tab, which is exactly what it can promise; the server-side
 * provenance claim (lib/nt-body-provenance.js) is what holds across tabs and
 * devices.
 *
 * Account capture is separate from the queue: signing out or switching account
 * moves accountGen, and every side effect checks it again before writing, so a
 * queued operation that lost its account writes nothing into the next one.
 */
import { accountGen, copyMoving } from './account-gen.js';

let _tail = Promise.resolve();
let _pending = 0;

function accountUserKey() {
  try { return localStorage.getItem('wl:userId') || ''; } catch { return ''; }
}

/** The account an operation belongs to, read before its first await. */
export function captureNtAccount() {
  return { gen: accountGen(), user: accountUserKey() };
}

/** True when the phone now belongs to someone else than `account`. */
export function ntAccountChanged(account) {
  if (!account) return false;
  if (account.gen !== accountGen() || account.user !== accountUserKey()) return true;
  return copyMoving();
}

/** The refusal a queued NutriTrace operation throws when it lost its account. */
export function ntAccountChangedError() {
  const error = new Error('The signed-in account changed while NutriTrace settings were saving.');
  error.code = 'account-changed';
  return error;
}

/** One NutriTrace transition or import at a time, in arrival order. */
export function runNtExclusive(task) {
  if (typeof task !== 'function') throw new TypeError('task is required');
  _pending += 1;
  // `_tail` is always a settled-swallowing promise, so a failed task does not
  // stop the ones behind it; the caller still sees its own rejection. The
  // count drops before the caller resumes, so ntExclusiveBusy() reflects "no
  // work left" as soon as the last awaited operation returns.
  const run = _tail.then(task);
  const settled = run.then(
    value => { _pending -= 1; return value; },
    error => { _pending -= 1; throw error; },
  );
  _tail = settled.then(() => {}, () => {});
  return settled;
}

/** True while a transition or import is running or waiting for its turn. */
export function ntExclusiveBusy() {
  return _pending > 0;
}
