// Which sets are personal records: the PR badge on a set, the "N new PRs"
// chip in the workout summary and the PR celebration all read this one rule.
//
// A set is a PR when it beats what came before it, in any one of these:
//   a rep set: the top weight, or the top estimated 1-rep max
//   a timed set (issue #89): the longest hold, or the heaviest load held
//   a distance or calorie set (issue #119): the longest distance or the
//     most calories in a set, or the heaviest load it was done with
// and what came before it is the exercise's history on the days before the
// set's own (a PR as of that date: a later day that matches or beats it
// never takes its badge away, and a day logged afterwards for an earlier
// date is judged by the days before it), every earlier completed working
// set of the same exercise that day (earlier cards first, then earlier sets
// on the card, by position, so the badge does not depend on the order the
// sets were ticked in), and the earlier workouts of the same day. A set that
// only matches an earlier one, that day or before, is not a PR. Warm-ups and
// unfinished sets never count, either way.
//
// The estimated 1-rep max is the one the records list, GET /api/v1/records
// and the pr.set webhook use (server/lib/volume.js accumulateRecord): rounded,
// and the weight itself for a single. scripts/pr-sets.test.js holds the two
// to each other. The server sends pr.set by comparing the all-time records
// before and after a save, which agrees with this rule for the newest day (a
// day logged afterwards for an earlier date can badge a set that moves no
// all-time record, and sends none), so only the app computes it per set and
// there is no copy on the server. (The heaviest load held, a timed
// set's second record, is the records' maxHoldWeight; a distance or calorie
// set's, maxDistanceLoad and maxCaloriesLoad.)
import { setKind, setReps } from './workout.js';

/** What an exercise's earlier sets have reached so far. */
export function newBests() {
  return {
    weight: 0, e1rm: 0, duration: 0, load: 0, reps: 0, holds: 0,
    distance: 0, distanceLoad: 0, distances: 0,
    calories: 0, caloriesLoad: 0, calorieSets: 0,
  };
}

// For each kind other than reps: the set field, then the bests keys for its
// top amount, its heaviest load and how many such sets there were.
const AMOUNT = {
  time: ['duration_sec', 'duration', 'load', 'holds'],
  distance: ['distance_m', 'distance', 'distanceLoad', 'distances'],
  calories: ['calories', 'calories', 'caloriesLoad', 'calorieSets'],
};

function e1rmOf(w, r) {
  if (!(r >= 0)) return null; // reps missing: no estimate, as in the records
  return r === 1 ? w : Math.round(w * (1 + r / 30));
}

/** The records `set` would set against `bests`: [] when it sets none. */
export function prKinds(bests, exercise, set) {
  if (!set || !set.completed || set.warmup) return [];
  const out = [];
  const amount = AMOUNT[setKind(exercise, set)];
  if (amount) {
    const [field, top, load] = amount;
    const d = Number(set[field]) || 0;
    if (d <= 0) return out;
    const w = Number(set.weight) || 0;
    if (d > bests[top]) out.push(top);
    if (w > 0 && w > bests[load]) out.push(load);
    return out;
  }
  const w = Number(set.weight) || 0;
  // Split reps count at the weaker side (setReps), as in the records.
  const r = Number(setReps(set)) || 0;
  if (!(w > 0) || !(r > 0)) return out;
  if (w > bests.weight) out.push('weight');
  if (e1rmOf(w, r) > bests.e1rm) out.push('e1rm');
  return out;
}

/** Fold a set into `bests` (the next set is judged against it too). */
export function absorbSet(bests, exercise, set) {
  if (!set || !set.completed || set.warmup) return;
  const amount = AMOUNT[setKind(exercise, set)];
  if (amount) {
    const [field, top, load, count] = amount;
    const d = Number(set[field]) || 0;
    if (d <= 0) return;
    bests[count]++;
    if (d > bests[top]) bests[top] = d;
    const w = Number(set.weight) || 0;
    if (w > bests[load]) bests[load] = w;
    return;
  }
  const w = Number(set.weight) || 0;
  if (!(w > 0)) return;
  bests.reps++;
  if (w > bests.weight) bests.weight = w;
  const e = e1rmOf(w, Number(setReps(set)));
  if (e != null && e > bests.e1rm) bests.e1rm = e;
}

/** The bests on the days before `date`: `history` is GET /api/workout/history/:id. */
export function historyBests(history, date) {
  const b = newBests();
  for (const h of history || []) {
    if (!h || !(String(h.date) < String(date))) continue;
    for (const s of h.sets || []) absorbSet(b, h, s);
  }
  return b;
}

/** Fold in the same exercise's sets from earlier workouts of the same day. */
function absorbEarlier(bests, exerciseId, earlier) {
  for (const list of earlier || []) {
    for (const ex of Array.isArray(list) ? list : []) {
      if (Number(ex?.exercise_id) !== Number(exerciseId)) continue;
      for (const s of ex.sets || []) absorbSet(bests, ex, s);
    }
  }
}

/**
 * The exercise lists of the workouts of `date` before the open one:
 * `sessions` is GET /api/workout/:date/sessions, in the order they were
 * started. Another date's list (one still on its way in) is ignored. With
 * the open workout not in it yet (a new one), all of them are earlier.
 */
export function earlierWorkouts(sessions, openId, date) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(s => s?.date === date);
  const at = list.findIndex(s => s.id === openId);
  return (at >= 0 ? list.slice(0, at) : list.filter(s => s.id !== openId))
    .map(s => (Array.isArray(s.exercises) ? s.exercises : []));
}

// Every set of the workout in order, with the records it sets (see prKinds).
function walk({ exercises, history, date, earlier }, visit) {
  const running = new Map();
  (exercises || []).forEach((ex, i) => {
    const id = ex?.exercise_id;
    if (!id) return;
    if (!running.has(id)) {
      const h = history?.[id];
      if (!Array.isArray(h)) running.set(id, null);
      else {
        const b = historyBests(h, date);
        absorbEarlier(b, id, earlier);
        running.set(id, b);
      }
    }
    const b = running.get(id);
    if (!b) return;
    (ex.sets || []).forEach((s, j) => {
      visit(i, j, prKinds(b, ex, s));
      absorbSet(b, ex, s);
    });
  });
}

/**
 * The PR sets of a workout: { exerciseIndex: Set<setIndex> }.
 *  exercises  the workout's exercises, in order
 *  history    { exerciseId: getWorkoutHistory answer }; an exercise whose
 *             history has not arrived yet is left out (no badge on a guess)
 *  date       the workout's date; only the history before it counts
 *  earlier    the exercise lists of this day's earlier workouts
 */
export function prFlags({ exercises, history, date, earlier = [] }) {
  const out = {};
  walk({ exercises, history, date, earlier }, (i, j, kinds) => {
    if (kinds.length) (out[i] ||= new Set()).add(j);
  });
  return out;
}

/**
 * What to celebrate for one set just ticked: 'weight', 'e1rm', 'hold',
 * 'distance' or 'calories', or null. The same rule as the badge, and as before only once the exercise has
 * a first session behind it (nothing to beat on the very first one).
 * `history` is that exercise's getWorkoutHistory answer.
 */
export function celebrationFor({ exercises, exIdx, setIdx, history, date, earlier = [] }) {
  const ex = exercises?.[exIdx];
  const set = ex?.sets?.[setIdx];
  if (!ex?.exercise_id || !set || !Array.isArray(history)) return null;
  const base = historyBests(history, date);
  const kind = setKind(ex, set);
  const amount = AMOUNT[kind];
  if (base[amount ? amount[3] : 'reps'] === 0) return null;
  let kinds = [];
  walk({ exercises, history: { [ex.exercise_id]: history }, date, earlier }, (i, j, k) => {
    if (i === exIdx && j === setIdx) kinds = k;
  });
  if (amount) return kinds.length ? (kind === 'time' ? 'hold' : kind) : null;
  return kinds.includes('weight') ? 'weight' : kinds.includes('e1rm') ? 'e1rm' : null;
}
