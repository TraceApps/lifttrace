/**
 * Reordering exercises with the arrow buttons (Diary's moveExercise).
 *
 * The list is drawn as blocks: a superset is one block holding two or three
 * exercises, anything else is a block of one. The arrows used to swap single
 * entries in the flat array, so an exercise below a superset swapped with
 * that superset's LAST member and pulled it out of the group, because a
 * group is a consecutive run of the same superset_id. They move blocks now.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');

/** Diary's own grouping, lifted verbatim in shape. */
function group(exercises) {
  const groups = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    const ssId = ex.superset_id;
    if (ssId != null && ex.superset_size > 1) {
      const g = [];
      const startI = i;
      while (i < exercises.length && exercises[i].superset_id === ssId) { g.push(exercises[i]); i++; }
      groups.push({ startIdx: startI, exercises: g });
    } else {
      groups.push({ startIdx: i, exercises: [ex] });
      i++;
    }
  }
  return groups;
}

/** Diary's moveExercise, same logic, operating on a plain array. */
function move(exercises, idx, dir) {
  const groups = group(exercises);
  const from = groups.findIndex(g => idx >= g.startIdx && idx < g.startIdx + g.exercises.length);
  if (from < 0) return exercises;
  const to = from + dir;
  if (to < 0 || to >= groups.length) return exercises;
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  return groups.flatMap(g => g.exercises);
}

const names = list => list.map(e => e.name);
const ss = (name, id) => ({ name, superset_id: id, superset_size: 2 });
const solo = (name, id) => ({ name, superset_id: id, superset_size: 1 });

// A1 + A2 paired, then three on their own. The shape that broke.
const day = () => [ss('KB Swings', 1), ss('Battle Ropes', 1), solo('Deadlifts', 2), solo('Sumo Squats', 3), solo('Leg Press', 4)];

test('an exercise below a superset moves in front of the whole superset', () => {
  const after = move(day(), 2, -1);
  assert.deepEqual(names(after), ['Deadlifts', 'KB Swings', 'Battle Ropes', 'Sumo Squats', 'Leg Press']);
  // And the pairing is still a pairing: both members, still next to each other.
  const groups = group(after);
  assert.equal(groups.length, 4);
  assert.deepEqual(names(groups[1].exercises), ['KB Swings', 'Battle Ropes']);
});

test('a superset moves as one block, not a member at a time', () => {
  const after = move(day(), 0, 1);
  assert.deepEqual(names(after), ['Deadlifts', 'KB Swings', 'Battle Ropes', 'Sumo Squats', 'Leg Press']);
  assert.deepEqual(names(group(after)[1].exercises), ['KB Swings', 'Battle Ropes']);
});

test('moving a superset down steps over the whole next exercise', () => {
  const after = move(move(day(), 0, 1), 1, 1);
  assert.deepEqual(names(after), ['Deadlifts', 'Sumo Squats', 'KB Swings', 'Battle Ropes', 'Leg Press']);
});

test('two exercises on their own still swap with each other', () => {
  const after = move(day(), 3, -1);
  assert.deepEqual(names(after), ['KB Swings', 'Battle Ropes', 'Sumo Squats', 'Deadlifts', 'Leg Press']);
});

test('the ends of the list hold', () => {
  assert.deepEqual(names(move(day(), 0, -1)), names(day()));
  assert.deepEqual(names(move(day(), 4, 1)), names(day()));
});

test('no member of a superset is ever separated from its group', () => {
  let list = day();
  for (const [idx, dir] of [[2, -1], [0, 1], [4, -1], [1, 1], [3, -1], [0, 1]]) {
    list = move(list, idx, dir);
    for (const g of group(list)) {
      const ids = new Set(g.exercises.map(e => e.superset_id));
      assert.equal(ids.size, 1, 'a block holds one superset_id');
      if (g.exercises[0].superset_size > 1) {
        assert.equal(g.exercises.length, 2, 'a pairing keeps both members together');
      }
    }
  }
});

test('the Diary still reorders by block, not by row', () => {
  // Guards the actual source against a quiet return to the swap it used to do.
  assert.match(source, /async function moveExercise\(idx, dir\) \{[\s\S]{0,400}supersetGroups/);
  assert.doesNotMatch(source, /\[updated\[idx\], updated\[newIdx\]\] = \[updated\[newIdx\], updated\[idx\]\]/);
});
