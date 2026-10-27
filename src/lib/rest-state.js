/**
 * rest-state.js: the arithmetic of a rest between sets, kept apart from the
 * store so it can be tested on its own.
 *
 * A running rest is a deadline (`endTime`). A paused one is the time that was
 * left when it was paused (`leftMs`), because a deadline keeps moving closer
 * while nobody is resting and a paused rest must not. Resuming turns what was
 * left back into a deadline from now.
 *
 * The same rest is held by this phone's app, by its notification (which acts
 * with the app closed) and by the watch, so it also crosses to the other two
 * in one shape, and back.
 */

/** What "+30s" adds, on the rest bar, the notification and the watch alike. */
export const REST_ADD_SEC = 30;

/** Milliseconds left, paused or not. Never negative. */
export function restLeftMs(state, now = Date.now()) {
  if (!state) return 0;
  if (state.paused) return Math.max(0, Number(state.leftMs) || 0);
  return Math.max(0, (Number(state.endTime) || 0) - now);
}

/** Still something to rest for: counting, or paused with time left. */
export function restIsLive(state, now = Date.now()) {
  return !!state && restLeftMs(state, now) > 0;
}

/** How far through the rest is, 0 to 1, as the rest bar fills. */
export function restProgress(state, now = Date.now()) {
  const total = Number(state?.total) || 0;
  if (!state || total <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - restLeftMs(state, now) / 1000 / total));
}

/** The rest held where it is. A paused rest is returned as it was. */
export function pausedRest(state, now = Date.now()) {
  if (!state || state.paused) return state;
  return { ...state, paused: true, leftMs: restLeftMs(state, now) };
}

/** Counting again from what was left. A running rest is returned as it was. */
export function resumedRest(state, now = Date.now()) {
  if (!state || !state.paused) return state;
  const left = restLeftMs(state, now);
  const { paused, leftMs, ...rest } = state;
  return { ...rest, endTime: now + left };
}

/** More rest, whether it is counting or paused. */
export function extendedRest(state, sec = REST_ADD_SEC, now = Date.now()) {
  if (!state) return state;
  const add = Math.max(0, Number(sec) || 0);
  const total = (Number(state.total) || 0) + add;
  if (state.paused) return { ...state, total, leftMs: restLeftMs(state, now) + add * 1000 };
  return { ...state, total, endTime: (Number(state.endTime) || now) + add * 1000 };
}

/** m:ss, as the rest bar and the notification write the time left (whole seconds). */
export function restClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The rest as it crosses to the watch (the /lifttrace/rest data item).
 *
 * A paused rest goes over as `cleared: true` with `paused: true` beside it. A
 * watch from before pausing existed reads only `cleared`, so it takes the rest
 * down and cancels its buzz rather than counting on to a deadline that no
 * longer exists and ringing in the middle of a pause. Resuming sends a
 * running rest, which it takes up again. A watch that knows about pausing
 * reads `paused` first and shows the rest held.
 */
export function restToWire(state, at) {
  if (!state) return { cleared: true, paused: false, at };
  if (state.paused) {
    return {
      cleared: true,
      paused: true,
      leftMs: restLeftMs(state),
      label: String(state.exerciseName || ''),
      total: Number(state.total) || 0,
      endsAt: 0,
      at,
    };
  }
  return {
    cleared: false,
    paused: false,
    label: String(state.exerciseName || ''),
    total: Number(state.total) || 0,
    endsAt: Number(state.endTime) || 0,
    at,
  };
}

/**
 * What a record from the watch or from this phone's notification means here:
 * `{ stop: true }`, or the rest to hold. `prev` is the rest this app already
 * has, whose own details (the exercise, the day, what is next) are kept when
 * the record is about the same rest.
 */
export function restFromWire(theirs, now = Date.now(), prev = null) {
  if (!theirs) return null;
  const total = Number(theirs.total) || 0;
  const keep = prev ? { ...prev } : { exerciseId: null, exerciseName: '' };
  delete keep.paused;
  delete keep.leftMs;
  const label = String(theirs.label || '');
  // Another lift's rest: what this phone had lined up next is not this one.
  if (prev && label && label !== prev.exerciseName) {
    delete keep.next;
    delete keep.startedAt;
    keep.exerciseId = null;
  }
  if (label) keep.exerciseName = label;
  // Which rest and which day, when the record says (this phone's own
  // notification does): kept, or the notification would lose them.
  if (!keep.startedAt && Number(theirs.startedAt) > 0) keep.startedAt = Number(theirs.startedAt);
  if (!keep.date && theirs.date) keep.date = String(theirs.date);
  if (theirs.paused) {
    const left = Math.max(0, Number(theirs.leftMs) || 0);
    if (left <= 0) return { stop: true };
    const t = total || Math.ceil(left / 1000);
    return {
      state: {
        ...keep,
        startedAt: Number(keep.startedAt) || now - Math.max(0, t * 1000 - left),
        endTime: now + left,
        total: t,
        paused: true,
        leftMs: left,
      },
    };
  }
  const endsAt = Number(theirs.endsAt) || 0;
  if (theirs.cleared || endsAt <= now) return { stop: true };
  const t = total || Math.max(1, Math.round((endsAt - now) / 1000));
  return {
    state: {
      ...keep,
      startedAt: Number(keep.startedAt) || endsAt - t * 1000,
      endTime: endsAt,
      total: t,
    },
  };
}
