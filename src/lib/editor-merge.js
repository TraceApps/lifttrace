/**
 * editor-merge.js: a program workout open in the editor (WorkoutEditor)
 * when a sync brings a newer copy of it.
 *
 * `base` is the copy the editor opened with (or last took in), `mine` what
 * the editor shows now, `fresh` the newer copy. A field you changed in the
 * editor (it differs from base) keeps what you made it; every other field
 * takes the newer copy's. The list of exercises follows the newer copy
 * (exercises added, removed or moved there) unless you changed the list
 * yourself (added, removed, moved one, or changed a superset), or changed an
 * exercise the newer copy no longer has: then your order and supersets stay,
 * each exercise still takes the newer copy's fields you didn't change, one
 * removed there that you didn't change goes, and one added there comes in at
 * the end. Exercises are matched by uuid; a copy with an exercise that has
 * none keeps your exercises as they are.
 */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keyOf = (ex, i) => ex?.uuid || `#${i}`;
const shape = list => list.map((ex, i) => [keyOf(ex, i), ex?.superset_id ?? null]);
const byKey = list => new Map(list.map((ex, i) => [keyOf(ex, i), ex]));
const SUPERSET = ['superset_id', 'superset_size', 'superset_position'];
const noSuperset = ex => { const out = { ...ex }; for (const k of SUPERSET) delete out[k]; return out; };

// Each superset counted again from the list: a group left with one member
// (the other removed elsewhere) is no group.
function tidySupersets(list) {
  const members = new Map();
  for (const ex of list) if (ex.superset_id != null) members.set(ex.superset_id, (members.get(ex.superset_id) || 0) + 1);
  const seen = new Map();
  return list.map(ex => {
    if (ex.superset_id == null) return ex;
    const n = members.get(ex.superset_id);
    if (n < 2) return noSuperset(ex);
    const at = seen.get(ex.superset_id) || 0;
    seen.set(ex.superset_id, at + 1);
    return { ...ex, superset_size: n, superset_position: at };
  });
}

function mergeFields(base, mine, fresh, skip) {
  const out = { ...fresh };
  for (const k of new Set([...Object.keys(base || {}), ...Object.keys(mine || {})])) {
    if (k === skip || same(base?.[k], mine?.[k])) continue;
    if (mine?.[k] === undefined) delete out[k];
    else out[k] = mine[k];
  }
  return out;
}

/** Returns { template, listFrom: 'fresh' | 'mine' }. */
export function mergeTemplate(base, mine, fresh) {
  const out = mergeFields(base, mine, fresh, 'exercises');
  const bEx = base?.exercises || [], mEx = mine?.exercises || [], fEx = fresh?.exercises || [];
  const keyed = bEx.every(e => e?.uuid) && fEx.every(e => e?.uuid);
  if (!keyed) { out.exercises = mEx; return { template: out, listFrom: 'mine' }; }
  const bBy = byKey(bEx), fBy = byKey(fEx), mBy = byKey(mEx);
  const merged = (k, f, m) => { const b = bBy.get(k); return b && f && m ? mergeFields(b, m, f) : (m || f); };
  const listMine = !same(shape(bEx), shape(mEx))
    || mEx.some((m, i) => { const k = keyOf(m, i); return bBy.has(k) && !fBy.has(k) && !same(bBy.get(k), m); });
  if (!listMine) {
    out.exercises = fEx.map((f, i) => { const k = keyOf(f, i); return merged(k, f, mBy.get(k)); });
    return { template: out, listFrom: 'fresh' };
  }
  // Your order and supersets: each exercise keeps your superset fields.
  const kept = mEx.flatMap((m, i) => {
    const k = keyOf(m, i), b = bBy.get(k), f = fBy.get(k);
    if (b && !f) return same(b, m) ? [] : [m]; // removed there: goes, unless you changed it
    const ex = merged(k, f, m);
    for (const key of SUPERSET) { if (m[key] === undefined) delete ex[key]; else ex[key] = m[key]; }
    return [ex];
  });
  // Added there (not in the copy you opened, nor yours): at the end, on its own.
  const added = fEx.filter((f, i) => { const k = keyOf(f, i); return !bBy.has(k) && !mBy.has(k); }).map(noSuperset);
  out.exercises = tidySupersets([...kept, ...added]);
  return { template: out, listFrom: 'mine' };
}
