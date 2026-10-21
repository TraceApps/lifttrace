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
import { APP_VERSION } from './version.js';
import { restToWire } from './rest-state.js';

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
    // With this phone's release: a watch on an older one catches up to it.
    await WearPairing.pair({ serverUrl, token, appVersion: APP_VERSION });
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

/** How long a watch counts as "here" after its app was last opened. */
const AWAKE_FOR = 30 * 60 * 1000;

/**
 * Is the watch app in use? The watch writes the moment it is opened, and a
 * rest is only sent over while that is recent.
 *
 * The alternative is waking a watch in a drawer and buzzing it about a rest
 * nobody is going to look at, which is worse than not syncing at all.
 */
export async function watchInUse() {
  if (!isNative) return false;
  try {
    const { at } = await WearPairing.watchAwake();
    return Number(at || 0) > Date.now() - AWAKE_FOR;
  } catch {
    return false;
  }
}

/**
 * The rest between sets, for the watch to hold and ring. Returns true when
 * the watch actually has it, which is also what decides whether this phone's
 * own notification is allowed to mirror across.
 *
 * A paused rest goes over as cleared with `paused` beside it (restToWire), so
 * a watch from before pausing takes it down instead of ringing mid-pause.
 */
export async function publishRest(state, at = 0, { force = false } = {}) {
  if (!isNative) return false;
  // `force`: the watch took this rest's pause, so it hears how the rest goes
  // on even when it has gone unopened for a while (or it shows Paused for good).
  if (!force && !(await watchInUse())) return false;
  try {
    await WearPairing.rest(restToWire(state, at || Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** What the watch says about the rest, when it has the later word. */
export async function readRest(mine = 0) {
  if (!isNative) return undefined;
  try {
    const remote = await WearPairing.readRest();
    if (!remote?.found) return undefined;
    if (Number(remote.at || 0) <= mine) return undefined;
    return {
      at: Number(remote.at || 0),
      cleared: !!remote.cleared,
      // From a watch that knows about pausing; an older one never says it.
      paused: !!remote.paused,
      leftMs: Number(remote.leftMs) || 0,
      label: String(remote.label || ''),
      total: Number(remote.total) || 0,
      endsAt: Number(remote.endsAt) || 0,
    };
  } catch {
    return undefined;
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
    const { timerStampedAt, adoptTimer, sane } = await import('../stores/workoutTimer.js');
    const mine = timerStampedAt();
    const theirs = remote?.found ? Number(remote.at || 0) : 0;
    // One that can't be right goes out as stopped, which clears it on the watch too.
    const local = sane(JSON.parse(localStorage.getItem('lt:workoutTimer') || 'null'));
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

/**
 * The watch saved the day: `fn` runs, so the phone reads it again at once
 * rather than at its next sync, up to half a minute later.
 */
export function onWatchSaved(fn) {
  if (!isNative) return;
  try { WearPairing.addListener('dayChanged', (e) => fn(String(e?.date || ''))); } catch { /* no watch here */ }
}

/** This phone saved the day: the watch, while it's in use, reads it again. */
export async function tellWatchDaySaved(date) {
  if (!isNative) return false;
  if (!(await watchInUse())) return false;
  try {
    await WearPairing.dayChanged({ date: String(date || '') });
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
