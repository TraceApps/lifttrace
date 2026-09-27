/**
 * Search folding, client and server.
 *
 * A custom exercise named "Prédicateur" or "Elevación lateral" could only be
 * found by typing the accent, which nobody does on a phone. Every search
 * folds both sides before comparing. The helpers live in two places because
 * the runtime image ships server/ and dist/ only, so the first test pins the
 * copies together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { foldText, stripAccents, includesFolded, coversFolded } from '../src/lib/search-text.js';
import { foldText as serverFoldText } from '../server/lib/search-text.js';
import { matchExercise } from '../src/lib/workout-import/common.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const SAMPLES = [
  'Prédicateur', 'Elevación lateral', 'Curl bíceps', 'Dominadas', 'Rückenzug',
  'Straße', 'Ølsuppe', 'Łosoś', 'Bench press', 'SQUAT', '', null, undefined, 42,
];

test('the client and server copies fold identically', () => {
  for (const s of SAMPLES) assert.equal(serverFoldText(s), foldText(s), `differs for ${String(s)}`);
});

test('folding drops accents and leaves plain text alone', () => {
  assert.equal(foldText('Prédicateur'), 'predicateur');
  assert.equal(foldText('Elevación lateral'), 'elevacion lateral');
  assert.equal(foldText('Bench Press'), 'bench press');
  // Letters with no combining mark to strip, so NFD alone cannot fold them.
  assert.equal(foldText('Straße'), 'strasse');
  assert.equal(foldText('Ølsuppe'), 'olsuppe');
});

test('stripAccents leaves those letters alone, the way SQL engines do', () => {
  assert.equal(stripAccents('Straße'), 'straße');
  assert.equal(stripAccents('Prédicateur'), 'predicateur');
});

test('folding is idempotent and never throws on junk', () => {
  for (const s of SAMPLES) assert.equal(foldText(foldText(s)), foldText(s));
  assert.equal(foldText(null), '');
});

test('includesFolded matches either side accented, and an empty query matches', () => {
  assert.ok(includesFolded('Elevación lateral', 'elevacion'));
  assert.ok(includesFolded('Elevacion lateral', 'elevación'));
  assert.ok(includesFolded('anything', ''));
  assert.ok(!includesFolded('Bench press', 'squat'));
});

test('coversFolded takes the tokens in any order', () => {
  assert.ok(coversFolded('Curl bíceps con barra', 'barra biceps'));
  assert.ok(!coversFolded('Bench press', 'press squat'));
});

test('an imported workout matches a library exercise without the accent', () => {
  const library = [
    { id: 1, name: 'Elevación lateral' },
    { id: 2, name: 'Bench press' },
  ];
  assert.equal(matchExercise('Elevacion lateral', library)?.id, 1);
  assert.equal(matchExercise('Elevación Lateral', library)?.id, 1);
  assert.equal(matchExercise('Bench press', library)?.id, 2);
  assert.equal(matchExercise('Nothing like it', library), null);
});

test('the SQL fold() function makes LIKE accent-insensitive', () => {
  const db = new DatabaseSync(':memory:');
  db.function('fold', { deterministic: true }, (s) => serverFoldText(s));
  db.exec('CREATE TABLE exercises (name TEXT)');
  const ins = db.prepare('INSERT INTO exercises VALUES (?)');
  ins.run('Prédicateur');
  ins.run('Bench press');
  const find = (q) => db.prepare('SELECT name FROM exercises WHERE fold(name) LIKE ?')
    .all(`%${serverFoldText(q)}%`).map(r => r.name);
  assert.deepEqual(find('predicateur'), ['Prédicateur']);
  assert.deepEqual(find('prédicateur'), ['Prédicateur']);
  assert.deepEqual(find('bench'), ['Bench press']);
  assert.deepEqual(find('zzz'), []);
});

test('the server search queries all go through fold()', () => {
  assert.match(read('../server/routes/exercises.js'), /AND fold\(name\) LIKE \?/);
  assert.match(read('../server/lib/mcp/tools/search-exercises.js'), /AND fold\(name\) LIKE \?/);
  assert.match(read('../server/lib/mcp/tools/get-exercise-progress.js'), /AND fold\(name\) LIKE \?/);
  assert.match(read('../server/db.js'), /db\.function\('fold'/);
});

test('no search box compares raw lowercase text any more', () => {
  const swept = [
    '../src/routes/Exercises.svelte',
    '../src/routes/Statistics.svelte',
    '../src/routes/Settings.svelte',
    '../src/components/exercises/ExercisePicker.svelte',
    '../src/lib/workout-import/common.js',
    '../src/lib/aiTools.js',
  ];
  for (const p of swept) {
    const src = read(p);
    assert.doesNotMatch(src, /\.toLowerCase\(\)\.includes\(/, `${p} still compares unfolded text`);
    assert.match(src, /foldText\(/, `${p} should use the shared fold`);
  }
});
