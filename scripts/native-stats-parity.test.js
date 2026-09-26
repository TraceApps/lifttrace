/**
 * Android Statistics (issue #101). The phone answers Statistics from its own
 * copy of the data when offline or in standalone mode, so its stats code must
 * agree with the server's. A full run of one dataset through both (server
 * routes and api-native) was done by hand across five time zones when this
 * was fixed; it needs module mocking, which CI's Node lacks. These keep the
 * pieces that make the two agree from drifting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const serverLoad = await import('../server/lib/muscle-load.js');
const clientLoad = await import('../src/lib/muscle-load.js');
const serverGroups = await import('../server/lib/muscle-groups.js');
const clientGroups = await import('../src/lib/muscle-groups.js');

const NAMES = ['Chest', 'Pectorals', 'Lats', 'latissimus dorsi', 'Upper Back', 'Traps', 'Delts', 'Shoulders',
  'Biceps', 'Brachialis', 'Triceps', 'Forearms', 'Abs', 'Core', 'Obliques', 'Quadriceps', 'Quads', 'Hamstrings',
  'Glutes', 'Calves', 'Adductors', 'Hip Flexors', 'Shins', 'Lower Back', 'Cardio', 'Hands', 'Unknown Muscle', ''];
const CATEGORIES = ['chest', 'back', 'shoulders', 'upper arms', 'arms', 'lower arms', 'waist', 'core',
  'upper legs', 'legs', 'lower legs', 'neck', 'cardio', ''];

test('body-map muscle load: the server and phone copies give identical results', () => {
  assert.deepEqual(clientLoad.MUSCLES_18, serverLoad.MUSCLES_18);
  for (const p of NAMES) for (const s of NAMES.slice(0, 8)) for (const category of CATEGORIES) {
    const info = { primary: [p], secondary: [s], category };
    assert.deepEqual(clientLoad.musclesOf(info), serverLoad.musclesOf(info), JSON.stringify(info));
  }
  for (const category of CATEGORIES) {
    assert.deepEqual(clientLoad.musclesOf({ primary: [], secondary: [], category }),
      serverLoad.musclesOf({ primary: [], secondary: [], category }), category);
  }
});

test('muscle groups: the server and phone copies give identical results', () => {
  for (const n of NAMES) assert.equal(clientGroups.normalizeMuscle(n), serverGroups.normalizeMuscle(n), n);
});

const native = read('../src/lib/api-native.js');
const stats = native.slice(native.indexOf('const Stats = {'), native.indexOf('const AiChat = {'));

test('the phone answers every Statistics request the page makes, with the same range parameters', () => {
  const page = read('../src/lib/api.js');
  const used = [...page.matchAll(/\/api\/stats\/([a-z-]+)/g)].map(m => m[1]);
  const routing = native.slice(native.indexOf("if (r === 'stats') {"), native.indexOf("// ── /api/ai/*"));
  for (const route of new Set(used)) {
    if (route === 'progress') continue;
    assert.match(routing, new RegExp(`id === '${route}'`), `no phone handler for /api/stats/${route}`);
  }
  assert.match(routing, /query\?\.start \?\? query\?\.from, to = query\?\.end \?\? query\?\.to/);
  for (const fn of ['volume', 'frequency', 'streaks', 'records', 'muscleGroupVolume', 'muscleEffectiveSets', 'weekdayDistribution']) {
    assert.match(stats, new RegExp(`\\n  async ${fn}\\(`), `Stats.${fn} exists`);
  }
});

test('weeks start on Monday and dates are read as calendar days, on both sides', () => {
  assert.match(stats, /_weekStart\(date\) \{[\s\S]*?getUTCDay\(\)[\s\S]*?day === 0 \? 6 : day - 1/);
  assert.doesNotMatch(stats, /d\.setDate\(d\.getDate\(\) - d\.getDay\(\)\)/, 'no Sunday-first week');
  assert.doesNotMatch(stats, /new Date\(w\.date\)\.getDay\(\)/, 'no local-time weekday');
  const server = read('../server/routes/stats.js');
  assert.match(server, /function _weekStart\(date\) \{[\s\S]*?getUTCDay\(\)/);
  assert.doesNotMatch(server, /const d = new Date\(row\.date\);\s*\n\s*(\/\/.*\n\s*)?const day = d\.getDay\(\)/);
});

test('connected to a server, Statistics asks the server; a local 501 never ends a request', () => {
  const fetchSrc = read('../src/lib/apiFetch.js');
  const patterns = fetchSrc.slice(fetchSrc.indexOf('const LOCAL_FIRST_GET_PATTERNS'), fetchSrc.indexOf('];', fetchSrc.indexOf('const LOCAL_FIRST_GET_PATTERNS')));
  assert.doesNotMatch(patterns, /\\\/api\\\/stats/);
  assert.match(fetchSrc, /if \(cached\.status !== 501\) \{/);
});

test('Statistics shows a failure as an error, keeps what did load, and reports it once', () => {
  const page = read('../src/routes/Statistics.svelte');
  assert.match(page, /Promise\.allSettled\(\[/);
  assert.match(page, /if \(seq !== _loadSeq\) return;/);
  assert.match(page, /\{#if loadError\}[\s\S]*?statistics\.load_failed_detail[\s\S]*?on:click=\{loadData\}/);
  assert.match(page, /if \(range === 'All'\) await loadData\(\);/, 'mount does not load a second time');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.ok(en.statistics.load_failed_detail && en.statistics.retry);
});

test('Statistics refreshes through the existing body-stats-saved event', () => {
  const page = read('../src/routes/Statistics.svelte');
  assert.match(page, /_onBodyStatsSaved = \(\) => \{ loadData\(\); \};/);
  assert.match(page, /addEventListener\('lt:body-stats-saved', _onBodyStatsSaved\)/);
  assert.match(page, /removeEventListener\('lt:body-stats-saved', _onBodyStatsSaved\)/);
});

test('a workout day is any day with a ticked set, warm-ups included, on both sides', () => {
  assert.match(stats, /_hasCompletedSet\(w\) \{\s*\n\s*return \(w\.exercises \|\| \[\]\)\.some\(ex => \(ex\.sets \|\| \[\]\)\.some\(s => s\?\.completed\)\);/);
  assert.match(read('../server/routes/stats.js'), /function hasCompletedSet\(exercises\) \{\s*\n\s*return exercises\.some\(ex => \(ex\.sets \|\| \[\]\)\.some\(s => s\.completed\)\);/);
});
