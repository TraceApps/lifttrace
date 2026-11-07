/**
 * holdPhase.js: the hold timer's clock, as pure functions of its saved state
 * and the time now (issues #89, #143). Kept apart from stores/holdTimer.js,
 * which pulls in Capacitor through the rest timer, so every phase can be
 * tested for real.
 *
 * A hold is a lead-in (`goAt` still ahead) and then the hold, counted up
 * from `goAt`. An Alternating exercise is timed per side (`sides`): the
 * lead-in, the left side, a switch countdown as long as the lead-in, the
 * right side. The state says which side is up (`side`, 'L' or 'R') and what
 * the left side held once it is done (`leftSec`); since everything is a
 * timestamp, a reload or a phone that slept reads the same phase.
 *
 * Stopping writes what was held: a single hold, or for a hold per side the
 * sides timed so far. The set is ticked only when it was held all the way:
 * a single hold, or both sides.
 */

import { holdSides, sideHoldSec } from './workout.js';

export const LEAD_IN_MS = 3000;

/** What the clock shows now: the side, the countdown and the time held. */
export function holdPhase(state, now) {
  if (!state) return null;
  const lead = state.goAt - now;
  return {
    side: state.sides ? (state.side === 'R' ? 'R' : 'L') : null,
    // 3, 2 or 1 during a countdown (the lead-in or the switch), else 0.
    leadIn: lead > 0 ? Math.ceil(lead / 1000) : 0,
    elapsed: lead > 0 ? 0 : Math.floor((now - state.goAt) / 1000),
    switching: !!state.sides && state.side === 'R' && lead > 0,
    leftSec: state.sides && state.side === 'R' ? (Number(state.leftSec) || 0) : null,
  };
}

/** A new hold. `targetL`/`targetR` are each side's target, for a hold per side. */
export function newHold(ctx, now) {
  const sides = !!ctx.sides;
  const targetL = Number(ctx.targetL ?? ctx.targetSec) || 0;
  const targetR = Number(ctx.targetR ?? ctx.targetSec) || 0;
  return {
    ...ctx,
    sides,
    ...(sides ? { side: 'L', leftSec: null, targetL, targetR } : {}),
    targetSec: sides ? targetL : (Number(ctx.targetSec) || 0),
    startedAt: now,
    goAt: now + LEAD_IN_MS,
  };
}

/** Start counting now instead of waiting out a countdown; null when none runs. */
export function skipCountdown(state, now) {
  if (!state || state.goAt <= now) return null;
  return { ...state, goAt: now };
}

/**
 * The left side is done: keep its time and count the switch down. Null
 * when there is no left side running to switch from.
 */
export function switchSide(state, now) {
  if (!state?.sides || state.side === 'R' || state.goAt > now) return null;
  return {
    ...state,
    side: 'R',
    leftSec: Math.max(0, Math.floor((now - state.goAt) / 1000)),
    targetSec: Number(state.targetR) || 0,
    goAt: now + LEAD_IN_MS,
  };
}

/**
 * What stopping now writes: `elapsedSec` for a single hold; for a hold per
 * side, `sideSec` { l, r } with null for a side not timed, and `elapsedSec`
 * the shorter side held. `done` says the set is held all the way and gets
 * ticked. `held` is false when nothing was held at all.
 */
export function stopResult(state, now) {
  const counted = Math.max(0, Math.floor((now - state.goAt) / 1000));
  if (!state.sides) {
    return { ...state, elapsedSec: counted, held: counted > 0, done: counted > 0 };
  }
  const l = state.side === 'R' ? (Number(state.leftSec) || 0) : counted;
  const r = state.side === 'R' ? counted : 0;
  const held = [l, r].filter(n => n > 0);
  return {
    ...state,
    sideSec: { l: l > 0 ? l : null, r: r > 0 ? r : null },
    elapsedSec: held.length ? Math.min(...held) : 0,
    held: held.length > 0,
    done: l > 0 && r > 0,
  };
}

/**
 * The set as a finished hold leaves it, applied by the exercise card that
 * owns it. A hold per side writes the sides it timed and keeps a side it
 * did not (stopped before the right side); duration_sec is the shorter
 * side. It ticks the set only when held all the way.
 */
export function applyHold(set, r) {
  if (!r.sideSec) return { ...set, duration_sec: r.elapsedSec, completed: true };
  const before = holdSides(set);
  const l = r.sideSec.l ?? (before ? before.l : null);
  const right = r.sideSec.r ?? (before ? before.r : null);
  return {
    ...set,
    duration_l_sec: l,
    duration_r_sec: right,
    duration_sec: sideHoldSec(l, right),
    completed: r.done ? true : !!set.completed,
  };
}
