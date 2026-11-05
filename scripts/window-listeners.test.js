/**
 * A page or component that listens on window or document stops listening
 * when it goes away. The Diary (the Add button's place on resize), Statistics
 * (the metric pills' indicator), Settings > Appearance (the side panel
 * toggle) and Trace (its button's place) added a resize listener each time
 * they opened and never took it away, so every visit left one more running
 * on every resize, for a page no longer there.
 *
 * Every window or document listener in src/ (outside App.svelte, which lives
 * as long as the app) is a named function taken away with the same type and
 * function, and none is an inline function that could never be taken away.
 * The real Diary and Statistics are counted in a browser in the fix's notes.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.svelte')) files.push(p);
  }
})(join(root, 'src'));
// Lives as long as the app does.
const WHOLE_APP = new Set(['src/App.svelte']);

test('every window and document listener a component adds, it takes away', () => {
  assert.ok(files.length > 50, 'found the components');
  const problems = [];
  for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/');
    if (WHOLE_APP.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(window|document)\.addEventListener\(\s*'([^']+)'\s*,\s*([^,)]+)/g)) {
      const [, target, type, fn] = m;
      if (!/^[A-Za-z_$][\w$]*$/.test(fn.trim())) { problems.push(`${rel}: ${target} '${type}' listener is an inline function`); continue; }
      const off = new RegExp(`\\b${target}\\.removeEventListener\\(\\s*'${type}'\\s*,\\s*${fn.trim().replace(/\$/g, '\\$')}\\b`);
      if (!off.test(src)) problems.push(`${rel}: ${target} '${type}' ${fn.trim()} is never taken away`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the four that leaked take theirs away when they go', () => {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  assert.match(read('src/routes/Diary.svelte'), /onDestroy\(\(\) => \{[\s\S]*?window\.removeEventListener\('resize', _clampAddFab\);[\s\S]*?\}\);/);
  assert.match(read('src/routes/Statistics.svelte'), /onDestroy\(\(\) => \{[\s\S]*?window\.removeEventListener\('resize', _measureIndicator\);[\s\S]*?\}\);/);
  assert.match(read('src/components/ai/Trace.svelte'), /onDestroy\(\(\) => \{[\s\S]*?window\.removeEventListener\('resize', _clampFab\);[\s\S]*?\}\);/);
  assert.match(read('src/components/settings/SettingsAppearance.svelte'), /onDestroy\(\(\) => \{[^\n]*window\.removeEventListener\('resize', _onResize\)/);
});
