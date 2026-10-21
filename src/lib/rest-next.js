/**
 * rest-next.js: what you lift after this rest, for the rest bar and the rest
 * notification.
 *
 * The Diary's rule for who is next (Diary.svelte updateExercise): the same
 * exercise again, or in a superset the first exercise of the group, because
 * the next round starts at the top. Rounds go by a set's optional `number`,
 * so a pairing can be uneven: the next round is the earliest one with a set
 * still to do, and an exercise that sits that round out is passed over (the
 * watch picks the same way, Session.kt). When the exercise, or the whole
 * group, has nothing left, the next is the first exercise after it in the
 * session with a working set to do: that is the hand-off to the next lift.
 *
 * Pure, so it is tested on its own (scripts/rest-shade.test.js).
 */
import { isTimedSet, fmtWeight, fmtSetDuration, lastCompletedSession } from './workout.js';

const inSuperset = (ex) => ex?.superset_id != null && Number(ex?.superset_size) > 1;

/** Working sets, each with the number it goes by: its own, or its place. */
function numbered(ex) {
  let auto = 0;
  return (ex?.sets || []).filter(s => s && !s.warmup).map(s => {
    auto += 1;
    return { set: s, number: s.number != null ? Number(s.number) : auto };
  });
}

/** The group an exercise belongs to, in session order (just it when standalone). */
function groupOf(exercises, idx) {
  const ex = exercises[idx];
  if (!inSuperset(ex)) return [idx];
  const out = [];
  exercises.forEach((e, i) => { if (inSuperset(e) && e.superset_id === ex.superset_id) out.push(i); });
  return out.length ? out : [idx];
}

/** What a set says about itself, for the notification. */
function describe(ex, set, extra) {
  return {
    exerciseId: ex.exercise_id ?? null,
    name: ex.exercise_name || '',
    superset: inSuperset(ex),
    weight: Number(set.weight) || 0,
    reps: Number(set.reps) || 0,
    repsL: set.reps_l != null ? Number(set.reps_l) || 0 : null,
    repsR: set.reps_r != null ? Number(set.reps_r) || 0 : null,
    durationSec: Number(set.duration_sec) || 0,
    timed: isTimedSet(ex, set),
    ...extra,
  };
}

/**
 * The next set in a group: the earliest round with work left, and in it the
 * first exercise of the group. A standalone exercise with a warm-up still to
 * do is next for that warm-up (a warm-up is not part of any round).
 */
function nextInGroup(exercises, members) {
  if (members.length === 1) {
    const ex = exercises[members[0]];
    const first = (ex?.sets || []).find(s => s && !s.completed);
    if (first?.warmup) return describe(ex, first, { warmup: true, number: 0, count: 0 });
  }
  let best = null;
  for (const i of members) {
    const todo = numbered(exercises[i]).filter(n => !n.set.completed);
    if (!todo.length) continue;
    const round = Math.min(...todo.map(n => n.number));
    if (best == null || round < best.round) best = { round, i };
  }
  if (!best) return null;
  const ex = exercises[best.i];
  const pick = numbered(ex).find(n => !n.set.completed && n.number === best.round);
  // "of 4": the highest round in the pairing, or the exercise's own last set.
  const count = Math.max(0, ...members.flatMap(i => numbered(exercises[i]).map(n => n.number)));
  return describe(ex, pick.set, { number: pick.number, count });
}

/**
 * The set to lift after the rest that starts now, given the session as it
 * reads with the set just ticked, and where that set was. Null when there is
 * nothing left to do in the session.
 */
export function nextUp(exercises, idx) {
  const list = Array.isArray(exercises) ? exercises : [];
  if (!list[idx]) return null;
  const own = groupOf(list, idx);
  const here = nextInGroup(list, own);
  if (here) return here;
  // This lift (or its group) is done: on to the next one with work left,
  // later in the session first, then anything earlier that was skipped.
  const seen = new Set(own);
  const order = [...list.keys()].filter(i => i > idx).concat([...list.keys()].filter(i => i < idx));
  for (const i of order) {
    if (seen.has(i)) continue;
    const members = groupOf(list, i);
    members.forEach(m => seen.add(m));
    const found = nextInGroup(list, members);
    if (found) return found;
  }
  return null;
}

/**
 * One set as words: "150 lbs × 8", "8 reps", "1:00", "20 lbs × 1:00",
 * "8 / 8". `unit` is left out for "Last time 145 × 8". `t` translates.
 */
export function setWords(s, { unit = '', timed = false, t = defaultT } = {}) {
  if (!s) return '';
  const weight = Number(s.weight) || 0;
  const load = weight > 0 ? (unit ? fmtWeight(weight, unit) : fmtNumber(weight)) : '';
  let work = '';
  const dur = Number(s.durationSec ?? s.duration_sec) || 0;
  const l = s.repsL ?? s.reps_l;
  const r = s.repsR ?? s.reps_r;
  if (timed && dur > 0) work = fmtSetDuration(dur);
  else if (l != null && r != null && (Number(l) > 0 || Number(r) > 0)) work = `${Number(l) || 0} / ${Number(r) || 0}`;
  else if (Number(s.reps) > 0) work = load ? String(Number(s.reps)) : t('rest_bar.reps', { values: { n: Number(s.reps) } });
  if (load && work) return `${load} × ${work}`;
  return load || work;
}

function fmtNumber(w) {
  const rounded = Math.round(w * 10) / 10;
  return String(rounded % 1 === 0 ? Math.round(rounded) : rounded);
}

function defaultT(key, opts) {
  if (key === 'rest_bar.reps') return `${opts?.values?.n} reps`;
  return key;
}

/**
 * What you did on this set last time, by the Diary's own rule for "last
 * time" (lastCompletedSession: the most recent earlier day with a working
 * set done). The same set of that session when it had one, else its last.
 */
export function lastTimeFor(history, { before, number, timed = false, t = defaultT } = {}) {
  const last = lastCompletedSession(history, { before });
  if (!last || !last.working?.length) return '';
  const n = Number(number) || 1;
  const same = last.working[n - 1] || last.working[last.working.length - 1];
  return setWords(same, { timed: timed || isTimedSet({ set_type: last.set_type }, same), t });
}

/**
 * The notification's two lines. Title: what is next ("Bench Press · Set 3 of
 * 4", "Round 2 of 3" in a superset); text: that set's weight and reps, and
 * last time's when known. With nothing next, the plain word for a rest.
 */
export function restNoticeText(next, { unit = 'lbs', last = '', t = defaultT, fallbackTitle = '' } = {}) {
  if (!next || !next.name) return { title: fallbackTitle, text: '' };
  const key = next.warmup ? 'rest_bar.warmup' : next.superset ? 'rest_bar.round_of' : 'rest_bar.set_of';
  const title = t(key, { values: { name: next.name, n: next.number, count: next.count } });
  const parts = [];
  const planned = setWords(next, { unit, timed: next.timed, t });
  if (planned) parts.push(planned);
  if (last) parts.push(t('rest_bar.last_time', { values: { set: last } }));
  return { title, text: parts.join(' · ') };
}
