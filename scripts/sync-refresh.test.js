/**
 * What a pull changed on the phone, and a page asking to hear of it
 * (src/lib/sync-refresh.js). Pages read their data once, when they open;
 * a pull that changes rows under an open page announces the kinds of rows it
 * touched (lt:sync-complete detail.kinds), and the page reads again only if it
 * shows one of them.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pullKinds, syncTouched, onSyncChanges, newestRead } from '../src/lib/sync-refresh.js';

test('pullKinds: the kinds a pull brought rows for', () => {
  assert.deepEqual(pullKinds({}), []);
  assert.deepEqual(pullKinds(null), []);
  assert.deepEqual(pullKinds({ exercises: 0, programs: 0, workouts: 0 }), [], 'zero rows is nothing');
  assert.deepEqual(pullKinds({ exercises: 2, bodyStats: 1, settings: 3 }).sort(), ['bodyStats', 'exercises', 'settings']);
  assert.deepEqual(pullKinds({ workoutTombstones: 1 }), ['workouts'], 'a set deleted elsewhere changes the workout');
  assert.deepEqual(pullKinds({ workouts: 1, workoutTombstones: 1 }), ['workouts']);
  assert.deepEqual(pullKinds({ dropped: 1 }).sort(), ['programs', 'templates'], 'a program or day this account no longer keeps');
  assert.deepEqual(pullKinds({ programsHealed: 1 }).sort(), ['programs', 'templates']);
  assert.deepEqual(pullKinds({ templatesHealed: 1 }), ['templates']);
  assert.deepEqual(pullKinds({ assignments: 1, excusedDays: 2 }).sort(), ['assignments', 'excusedDays']);
});

test('syncTouched: kinds decide, nothing announced is nothing to read', () => {
  assert.equal(syncTouched(null, ['programs']), false);
  assert.equal(syncTouched({ changed: false, kinds: [] }, ['programs']), false);
  assert.equal(syncTouched({ changed: false, kinds: [] }), false);
  assert.equal(syncTouched({ changed: true, kinds: ['exercises'] }, ['programs']), false);
  assert.equal(syncTouched({ changed: true, kinds: ['exercises', 'programs'] }, ['programs']), true);
  assert.equal(syncTouched({ changed: true, kinds: ['exercises'] }), true, 'a page that shows everything');
  // An event that does not say what it touched counts when it says it brought rows.
  assert.equal(syncTouched({ changed: true }, ['programs']), true);
  assert.equal(syncTouched({ changed: false }, ['programs']), false);
});

test('onSyncChanges: calls for the kinds it shows, and stops when told', () => {
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (t, f) => { listeners.set(t, [...(listeners.get(t) || []), f]); },
    removeEventListener: (t, f) => { listeners.set(t, (listeners.get(t) || []).filter(x => x !== f)); },
  };
  try {
    const fire = detail => (listeners.get('lt:sync-complete') || []).slice().forEach(f => f({ detail }));
    const seen = [];
    const off = onSyncChanges(d => seen.push(['a', d.kinds]), ['programs']);
    const offAll = onSyncChanges(d => seen.push(['all', d.kinds]));
    assert.equal(listeners.get('lt:sync-complete').length, 2);
    fire({ changed: true, kinds: ['exercises'] });
    fire({ changed: true, kinds: ['programs'] });
    fire({ changed: false, kinds: [] });
    assert.deepEqual(seen, [['all', ['exercises']], ['a', ['programs']], ['all', ['programs']]]);
    off(); offAll();
    assert.equal(listeners.get('lt:sync-complete').length, 0, 'nothing left behind');
  } finally { delete globalThis.window; }
});

test('newestRead: only the newest read stands', () => {
  const newest = newestRead();
  const first = newest();
  const second = newest();
  assert.equal(first(), false);
  assert.equal(second(), true);
  const third = newest();
  assert.equal(second(), false);
  assert.equal(third(), true);
});

// ── Wiring ──

const root = new URL('../', import.meta.url).pathname;
function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(svelte|js)$/.test(f)) out.push(p);
  }
  return out;
}
const sources = files(join(root, 'src')).map(p => [p.slice(root.length), readFileSync(p, 'utf8')]);

// The text of each onSyncChanges(...) call in a source, up to its closing parenthesis.
function callsOf(src) {
  const out = [];
  for (const m of src.matchAll(/onSyncChanges\(/g)) {
    if (/import\b/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
    let depth = 0, q = null;
    for (let i = m.index + 'onSyncChanges'.length; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { out.push(src.slice(m.index, i + 1)); break; }
    }
  }
  return out;
}

test('every page listens inside a non-async onMount, so its listener is taken away', () => {
  for (const [name, src] of sources) {
    if (name === 'src/lib/sync-refresh.js') continue;
    for (const call of callsOf(src)) {
      const at = src.indexOf(call);
      assert.match(src.slice(Math.max(0, at - 40), at), /onMount\(\(\) => $/, `${name}: onSyncChanges is returned from a plain onMount(() => ...)`);
    }
  }
});

test('no sync listener hides in an async onMount', () => {
  for (const [name, src] of sources) {
    for (const m of src.matchAll(/onMount\(async\b/g)) {
      const body = src.slice(m.index, m.index + 4000);
      const end = body.search(/\n  \}\);/);
      assert.doesNotMatch(end > 0 ? body.slice(0, end) : body, /onSyncChanges/, `${name}: an async onMount's cleanup never runs`);
    }
  }
});

// What each page that reads once shows, as the kinds it listens for.
const PAGES = {
  'src/routes/ExerciseDetail.svelte': ['exercises', 'workouts'],
  'src/routes/ProgramDetail.svelte': ['programs', 'templates', 'assignments', 'workouts', 'excusedDays'],
  'src/components/progress-photos/ProgressPhotosTimeline.svelte': ['bodyStats'],
  'src/components/settings/SettingsCatalog.svelte': ['exercises'],
};
for (const [page, kinds] of Object.entries(PAGES)) {
  test(`${page} listens for ${kinds.join(', ')}`, () => {
    const calls = callsOf(readFileSync(join(root, page), 'utf8'));
    assert.ok(calls.length >= 1, 'listens');
    // The kinds are the array that ends the call: onSyncChanges(fn, ['a', 'b']).
    const listened = new Set(calls.flatMap(c => [...((c.match(/,\s*\[([^\]]*)\]\s*\)$/) || [])[1] || '').matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1])));
    for (const k of kinds) assert.ok(listened.has(k), `${k} is among the kinds it listens for (${[...listened]})`);
  });
}

test('the Diary passes what a pull brought on: body stats to the side rail, a followed program to the plan', () => {
  const src = readFileSync(join(root, 'src/routes/Diary.svelte'), 'utf8');
  assert.match(src, /syncTouched\(e\?\.detail, \['bodyStats'\]\)\) window\.dispatchEvent\(new CustomEvent\('lt:body-stats-saved'\)\)/);
  assert.match(src, /syncTouched\(e\?\.detail, \['programs', 'templates', 'assignments'\]\)\) loadActiveProgram\(\{ quiet: true \}\)/);
});

test('the pages with a listener of their own read what the sync brought for their other parts', () => {
  const ex = readFileSync(join(root, 'src/routes/Exercises.svelte'), 'utf8');
  assert.match(ex, /_detailSelected && syncTouched\(e\?\.detail, \['exercises', 'workouts'\]\)/, 'the wide detail pane');
  const st = readFileSync(join(root, 'src/routes/Statistics.svelte'), 'utf8');
  assert.match(st, /syncTouched\(e\?\.detail, \['exercises'\]\)\) LtApi\.getExercises\(\)/, "the picker's exercise names");
});

test('sync.js says the kinds with the event', () => {
  const src = readFileSync(join(root, 'src/lib/sync.js'), 'utf8');
  assert.match(src, /result\.kinds = pullKinds\(result\.tables\);[\s\S]{0,200}new CustomEvent\('lt:sync-complete', \{ detail: result \}\)/);
});
