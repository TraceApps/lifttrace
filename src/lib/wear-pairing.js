/**
 * wear-pairing.js: hand the watch app what it needs to reach the server.
 *
 * The Wear app talks to LiftTrace itself, so it logs sets with the phone in a
 * locker. It needs the server address and a token for the signed-in account,
 * and there is no keyboard on a watch worth typing either into. The phone
 * writes both into the Wearable Data Layer when you sign in, and takes them
 * away when you sign out.
 *
 * Android only, and only when a watch is actually paired with this phone.
 */
import { registerPlugin } from '@capacitor/core';
import { isNative, getServerUrl, getAuthToken } from './platform.js';

// Registered at module level: a plugin proxy returned from an async function
// confuses Capacitor's promise handling.
const WearPairing = registerPlugin('WearPairing');

/** Is there a watch paired with this phone? */
export async function hasWatch() {
  if (!isNative) return false;
  try {
    const { paired } = await WearPairing.hasWatch();
    return !!paired;
  } catch {
    return false;
  }
}

/**
 * Send the current server and token to the watch. Safe to call often: the
 * write carries a timestamp, so a refreshed token still reaches the watch.
 */
export async function pairWatch() {
  if (!isNative) return false;
  const serverUrl = getServerUrl();
  const token = getAuthToken();
  // Standalone mode keeps everything on the phone, so there is no address for
  // the watch to call and nothing to pair.
  if (!serverUrl || !token) return false;
  if (!(await hasWatch())) return false;
  try {
    await WearPairing.pair({ serverUrl, token });
    // A watch paired part way through a session should still show its
    // length, and one that started the timer itself should have that
    // honoured here rather than overwritten.
    await syncWorkoutTimer();
    return true;
  } catch {
    return false;
  }
}

/**
 * How long this session has been running, for the watch to show. The state is
 * a start time and a running total rather than a count, so the watch keeps
 * counting correctly with the phone out of range: it only needs telling again
 * when the timer is paused, resumed or cleared.
 */
export async function publishWorkoutTimer(state, clearedAt = 0) {
  if (!isNative) return false;
  try {
    if (!state) {
      await WearPairing.clearTimer({ at: clearedAt || Date.now() });
      return true;
    }
    await WearPairing.timer({
      date: String(state.date || ''),
      startTime: Number(state.startTime) || 0,
      baseElapsed: Number(state.baseElapsed) || 0,
      paused: !!state.paused,
      pausedElapsed: Number(state.pausedElapsed) || 0,
      // The stamp travels with it: both sides must judge by the same clock
      // reading, or a republish would look newer than it is.
      at: Number(state.at) || Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Settle the session timer between the phone and the watch. Either can start,
 * pause or stop it, so whichever spoke last is the one that counts; this runs
 * when the app comes back to the front, which is before anyone can press
 * anything here.
 */
export async function syncWorkoutTimer() {
  if (!isNative) return false;
  try {
    // The newest word from either device. Each device keeps its own record
    // at this path, so "the last one read" is not the same thing as "the
    // most recent one", and taking the wrong one is how a paused timer
    // starts itself again.
    const remote = await WearPairing.readTimer();
    const { timerStampedAt, adoptTimer } = await import('../stores/workoutTimer.js');
    const mine = timerStampedAt();
    const theirs = remote?.found ? Number(remote.at || 0) : 0;
    const local = JSON.parse(localStorage.getItem('lt:workoutTimer') || 'null');
    if (theirs > mine) {
      adoptTimer(remote.cleared ? null : {
        date: String(remote.date || ''),
        startTime: Number(remote.startTime) || 0,
        baseElapsed: Number(remote.baseElapsed) || 0,
        paused: !!remote.paused,
        pausedElapsed: Number(remote.pausedElapsed) || 0,
        at: theirs,
      }, theirs);
      return true;
    }
    // Only speak up when this phone genuinely has the later word. Saying it
    // again otherwise would restamp a stale record as the newest one.
    if (mine > theirs) await publishWorkoutTimer(local, mine);
    return true;
  } catch {
    return false;
  }
}

/** Signed out: the watch shouldn't keep a working token. */
export async function unpairWatch() {
  if (!isNative) return false;
  try {
    await WearPairing.unpair();
    return true;
  } catch {
    return false;
  }
}
