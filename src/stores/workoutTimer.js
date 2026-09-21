import { writable, get } from 'svelte/store';

const KEY = 'lt:workoutTimer';

function _load() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
  catch { return null; }
}
const AT_KEY = 'lt:workoutTimerAt';

function _save(state) {
  // Stamped, so that when the phone and the watch have both had a say, the
  // later one is the one that counts. The stamp is kept even when the timer
  // is stopped, or a stop would look older than the running state it ended
  // and the watch would hand it straight back.
  const at = Date.now();
  const stamped = state ? { ...state, at } : null;
  localStorage.setItem(AT_KEY, String(at));
  if (stamped) localStorage.setItem(KEY, JSON.stringify(stamped));
  else localStorage.removeItem(KEY);
  // A paired watch shows how long you have been training and can start, pause
  // and stop it itself. It is told whenever the timer changes here and counts
  // on its own from there, so the phone can go back in a locker.
  publishTimer(stamped);
}

/** When the timer here was last changed, for settling that against the watch. */
export function timerStampedAt() {
  try {
    return Number(localStorage.getItem(AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The watch started, paused or stopped the timer. Take its word for it
 * without telling it back what it just told us.
 */
export function adoptTimer(state, at = 0) {
  localStorage.setItem(AT_KEY, String(at || state?.at || Date.now()));
  if (state) localStorage.setItem(KEY, JSON.stringify(state));
  else localStorage.removeItem(KEY);
  timerState.set(state);
  timerMs.set(_computeMs(state));
  if (state && !state.paused) _startTicking();
  else _stopTicking();
}

function publishTimer(state) {
  try {
    import('../lib/wear-pairing.js')
      .then(({ publishWorkoutTimer }) => publishWorkoutTimer(state))
      .catch(() => {});
  } catch { /* no watch, or no bundler support here */ }
}

// State shape:
//   null = no timer
//   { date, startTime, baseElapsed, paused: false } = running
//   { date, startTime, baseElapsed, paused: true, pausedElapsed } = paused
const saved = _load();

export const timerState = writable(saved);

/** Elapsed in milliseconds — updated via requestAnimationFrame when running */
export const timerMs = writable(saved ? _computeMs(saved) : 0);

function _computeMs(state) {
  if (!state) return 0;
  if (state.paused) return state.pausedElapsed * 1000;
  return Math.max(0, state.baseElapsed * 1000 + (Date.now() - state.startTime));
}

let _rafId = null;

function _tick() {
  const state = get(timerState);
  if (!state || state.paused) { _rafId = null; return; }
  timerMs.set(_computeMs(state));
  _rafId = requestAnimationFrame(_tick);
}

function _startTicking() {
  if (_rafId != null) return;
  _rafId = requestAnimationFrame(_tick);
}

function _stopTicking() {
  if (_rafId != null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

// If we have saved running state, resume ticking
if (saved && !saved.paused) _startTicking();
// If paused, just set the frozen elapsed
if (saved && saved.paused) timerMs.set(_computeMs(saved));

/** Start the timer for a given date (or resume from minutes) */
export function startTimer(dateStr, resumeFromMinutes = 0) {
  const state = {
    date: dateStr,
    startTime: Date.now(),
    baseElapsed: Math.round((resumeFromMinutes || 0) * 60),
    paused: false,
  };
  timerState.set(state);
  _save(state);
  timerMs.set(_computeMs(state));
  _startTicking();
}

/** Pause — freezes elapsed time, keeps state alive (pill stays visible) */
export function pauseTimer() {
  const state = get(timerState);
  if (!state || state.paused) return;
  const elapsedSec = state.baseElapsed + (Date.now() - state.startTime) / 1000;
  const paused = { ...state, paused: true, pausedElapsed: elapsedSec };
  timerState.set(paused);
  _save(paused);
  timerMs.set(elapsedSec * 1000);
  _stopTicking();
}

/** Resume from paused state */
export function resumeTimer() {
  const state = get(timerState);
  if (!state || !state.paused) return;
  const resumed = {
    date: state.date,
    startTime: Date.now(),
    baseElapsed: state.pausedElapsed,
    paused: false,
  };
  timerState.set(resumed);
  _save(resumed);
  _startTicking();
}

/** Stop the timer completely — returns total minutes elapsed.
 *  Clears state so the pill disappears. */
export function stopTimer() {
  const state = get(timerState);
  if (!state) return 0;
  const ms = _computeMs(state);
  timerState.set(null);
  _save(null);
  _stopTicking();
  timerMs.set(0);
  return Math.round(ms / 60000 * 10) / 10;
}

/** Reset — zero elapsed and stop */
export function resetTimer() {
  timerState.set(null);
  timerMs.set(0);
  _save(null);
  _stopTicking();
}

/** Format ms as MM:SS.cs or H:MM:SS.cs */
export function formatTimerMs(ms, opts = { centi: true }) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  const base = h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
  return opts.centi ? `${base}.${String(cs).padStart(2,'0')}` : base;
}

// Re-sync when tab becomes visible
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const state = get(timerState);
    if (!document.hidden && state && !state.paused) _startTicking();
  });
}
