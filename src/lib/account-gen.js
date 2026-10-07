/**
 * account-gen.js: a number that changes whenever the phone's copy changes
 * hands (another account signs in, Connect, Disconnect, sign-out).
 *
 * Work that started before such a change (a sync, a save's follow-up
 * write to the phone's copy) reads it when it starts and checks it again
 * before writing anything here: if it moved, the work belonged to the
 * previous account and is dropped, never written into the next one's copy.
 * sync.js moves it (stopSyncForAccountChange) and stops what is running.
 */
let _gen = 0;

export const accountGen = () => _gen;

export function nextAccountGen() {
  _gen += 1;
  return _gen;
}

// Someone signed out and nobody has signed in since (kept across launches):
// no sync runs, so an account's queued changes never go up without its
// session, or under anyone else's cookie.
export function signedOut() {
  try { return localStorage.getItem('lt:signedOut') === '1'; } catch { return false; }
}
export function markSignedOut(on) {
  try { if (on) localStorage.setItem('lt:signedOut', '1'); else localStorage.removeItem('lt:signedOut'); } catch { /* no storage */ }
}

// The copy is changing hands right now (Disconnect moving its rows): no
// sync runs, and no write made meanwhile is applied to it, until it ends.
let _moving = false;
export const copyMoving = () => _moving;
export function setCopyMoving(on) {
  _moving = !!on;
}
