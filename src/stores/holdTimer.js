import { writable, get } from 'svelte/store';
import { playTimerCue, stopRest } from './restTimer.js';

/**
 * Hold timer for timed sets (issue #89): tap start, drop into the plank,
 * tap stop, and the set is filled in and completed with the time held.
 *
 * Like the rest timer, it works from absolute timestamps rather than
 * counting interval ticks, so a phone that locks mid-plank, a throttled
 * background tab, or navigating away from the Diary still reads the right
 * elapsed time on return. State is persisted so an app reload mid-hold does
 * not lose it.
 *
 * Starting gives a three second lead-in (3, 2, 1, go) because you tap the
 * button standing up and then have to get into position; counting those
 * seconds would inflate every hold. The lead-in can be skipped by tapping.
 *
 * Only one hold runs at a time, since nobody holds two planks at once.
 *
 * Writing the result is a handoff rather than a direct save: stopping
 * publishes `holdResult`, and the exercise card that owns that set applies
 * it through its normal update path. That keeps rest-timer start, PR
 * detection and superset round logic exactly as they are for a tapped tick,
 * and needs no event plumbing through superset cards.
 */

const LS_KEY = 'lt:hold-timer';
export const LEAD_IN_MS = 3000;
// A timer left running for hours is a forgotten one, not a hold.
const STALE_MS = 3 * 60 * 60 * 1000;

/** Running hold, or null. See startHold for the shape. */
export const holdTimer = writable(null);
/** Whole seconds held so far (0 during the lead-in). */
export const holdElapsed = writable(0);
/** 3, 2 or 1 during the lead-in, 0 once the hold is running. */
export const holdLeadIn = writable(0);
/** Result waiting for its exercise card to apply it, or null. */
export const holdResult = writable(null);

let _tick = null;
let _cues = [];

function _persist(state) {
  try {
    if (state) localStorage.setItem(LS_KEY, JSON.stringify(state));
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: the hold simply does not survive a reload */ }
}

function _clearTimers() {
  if (_tick) { clearInterval(_tick); _tick = null; }
  for (const t of _cues) clearTimeout(t);
  _cues = [];
}

function _update() {
  const state = get(holdTimer);
  if (!state) return;
  const now = Date.now();
  const lead = state.goAt - now;
  holdLeadIn.set(lead > 0 ? Math.ceil(lead / 1000) : 0);
  holdElapsed.set(lead > 0 ? 0 : Math.floor((now - state.goAt) / 1000));
}

function _schedule(state) {
  _clearTimers();
  const now = Date.now();
  const at = (ms, fn) => { const d = ms - now; if (d >= -100) _cues.push(setTimeout(fn, Math.max(0, d))); };
  at(state.goAt - 3000, () => playTimerCue('count', 3));
  at(state.goAt - 2000, () => playTimerCue('count', 2));
  at(state.goAt - 1000, () => playTimerCue('count', 1));
  at(state.goAt, () => playTimerCue('go'));
  // Reaching the target gets the same cue, but the clock keeps running:
  // going past a prescribed time is how a hold PR happens.
  if (state.targetSec > 0) at(state.goAt + state.targetSec * 1000, () => playTimerCue('go'));
  _tick = setInterval(_update, 200);
  _update();
}

/**
 * @param {object} ctx
 * @param {string} ctx.date          workout date the set belongs to
 * @param {number} ctx.exIdx         exercise position when started
 * @param {number} ctx.setIdx        set position when started
 * @param {number|null} ctx.exerciseId
 * @param {string|null} ctx.exerciseUuid  preferred identity, stable across reorders and sessions
 * @param {string|null} ctx.setUuid
 * @param {string} ctx.exerciseName
 * @param {number} ctx.targetSec     prescribed or last-session time, 0 for none
 */
export function startHold(ctx) {
  const now = Date.now();
  const state = { ...ctx, targetSec: Number(ctx.targetSec) || 0, startedAt: now, goAt: now + LEAD_IN_MS };
  // You are working now, so a running rest countdown no longer applies.
  stopRest(false);
  holdResult.set(null);
  holdTimer.set(state);
  _persist(state);
  _schedule(state);
}

/** Start counting immediately instead of waiting out the lead-in. */
export function skipLeadIn() {
  const state = get(holdTimer);
  if (!state || state.goAt <= Date.now()) return;
  const next = { ...state, goAt: Date.now() };
  holdTimer.set(next);
  _persist(next);
  _schedule(next);
}

/**
 * Stop and publish the result for the owning exercise card. Stopping during
 * the lead-in records nothing, since nothing was held.
 */
export function stopHold() {
  const state = get(holdTimer);
  if (!state) return null;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - state.goAt) / 1000));
  _clearTimers();
  holdTimer.set(null);
  holdElapsed.set(0);
  holdLeadIn.set(0);
  _persist(null);
  const result = { ...state, elapsedSec };
  if (elapsedSec > 0) holdResult.set(result);
  return result;
}

/** Discard without writing anything. */
export function cancelHold() {
  _clearTimers();
  holdTimer.set(null);
  holdElapsed.set(0);
  holdLeadIn.set(0);
  _persist(null);
}

/** Called by the exercise card once it has written the result. */
export function consumeHoldResult() {
  holdResult.set(null);
}

// Identity rule lives in lib/holdMatch.js so it can be tested without Capacitor.
export { holdMatches } from '../lib/holdMatch.js';

/** Restore a hold that was running before a reload. */
export function resumeHoldTimer() {
  if (get(holdTimer)) return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state?.goAt || Date.now() - state.startedAt > STALE_MS) { _persist(null); return; }
    holdTimer.set(state);
    _schedule(state);
  } catch { _persist(null); }
}
