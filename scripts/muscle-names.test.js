/**
 * Every muscle name the exercise libraries hand us lands somewhere real
 * (issue #110, reported by @kavemang).
 *
 * wger names its muscles in Latin, and nine of its fifteen were unknown to
 * the body map, so an exercise that used them lost those muscles, and when
 * none were left, fell back to a guess from its category. A set of dumbbell
 * lunges came out as a generic leg day, and a curl credited the triceps as
 * much as the biceps. The fatigue view and Muscle Balance each had their own
 * gaps, and all three filed hip abduction under core.
 *
 * The vocabularies below are the complete ones each source can produce:
 * wger's from its importer, Free Exercise DB's fixed list, and ExerciseDB's
 * /api/v1/muscles as of 2026-09-25.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { musclesOf } from '../src/lib/muscle-load.js';
import { musclesOf as serverMusclesOf } from '../server/lib/muscle-load.js';
import { normalizeMuscle } from '../server/lib/muscle-groups.js';

// The fatigue view's matcher is private to its module, so it is read out
// of the source rather than exported for a test.
const recoverySrc = readFileSync(new URL('../src/lib/muscle-recovery.js', import.meta.url), 'utf8');
const at = recoverySrc.indexOf('function _normalizeMuscle');
const recoveryOf = new Function(recoverySrc.slice(at, recoverySrc.indexOf('\n}\n', at) + 2) + '; return _normalizeMuscle;')();

const WGER = ['Biceps brachii', 'Anterior deltoid', 'Serratus anterior', 'Pectoralis major', 'Triceps brachii',
  'Rectus abdominis', 'Gastrocnemius', 'Gluteus maximus', 'Trapezius', 'Quadriceps femoris', 'Hamstrings',
  'Latissimus dorsi', 'Brachialis', 'Obliquus externus', 'Soleus'];
const FREE_DB = ['abdominals', 'abductors', 'adductors', 'biceps', 'calves', 'chest', 'forearms', 'glutes',
  'hamstrings', 'lats', 'lower back', 'middle back', 'neck', 'quadriceps', 'shoulders', 'traps', 'triceps'];
// Left off the body map on purpose: nothing on the figure to shade.
const NOT_DRAWN = ['neck', 'Hands', 'Feet', 'Ankles', 'Ankle Stabilizers', 'Sternocleidomastoid', 'Cardiovascular System'];

const drawn = (name) => Object.keys(musclesOf({ primary: [name] }));

test('the wger importer keeps its own table of muscle names', () => {
  // If wger ever gains a muscle, it arrives here first; this fails so the
  // list above, and the maps, are brought along with it.
  const src = readFileSync(new URL('../src/lib/exercise-sources/wger.js', import.meta.url), 'utf8');
  const table = src.slice(src.indexOf('const MUSCLE_MAP'), src.indexOf('};', src.indexOf('const MUSCLE_MAP')));
  const inTable = [...table.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...inTable].sort(), [...WGER].sort());
});

test('every wger muscle is drawn on the body map', () => {
  for (const name of WGER) assert.equal(drawn(name).length, 1, name);
});

test('every Free Exercise DB muscle is drawn, except the neck', () => {
  for (const name of FREE_DB.filter(n => n !== 'neck')) assert.equal(drawn(name).length, 1, name);
});

test('what is left off the figure is left off on purpose', () => {
  for (const name of NOT_DRAWN) assert.deepEqual(drawn(name), [], name);
});

test('the reported lunges count their own muscles, not a leg-day guess', () => {
  // wger: Dumbbell Lunges Standing, quadriceps primary and glutes secondary.
  const lunges = musclesOf({ primary: ['Quadriceps femoris'], secondary: ['Gluteus maximus'], category: 'legs' });
  assert.deepEqual(lunges, { quadriceps: 1, gluteal: 0.4 });
});

test('a curl works the biceps, not the triceps as well', () => {
  assert.deepEqual(musclesOf({ primary: ['Biceps brachii'], category: 'arms' }), { biceps: 1 });
});

test('the server and the phone draw the same body map', () => {
  for (const name of [...WGER, ...FREE_DB]) {
    assert.deepEqual(serverMusclesOf({ primary: [name] }), musclesOf({ primary: [name] }), name);
  }
});

test('the fatigue view and Muscle Balance recognize the names the body map does', () => {
  const expect = {
    'Gastrocnemius': 'calves', 'Soleus': 'calves', 'Brachialis': 'biceps', 'Obliquus externus': 'core',
    'Rotator Cuff': 'shoulders', 'Wrist Flexors': 'forearms', 'Grip Muscles': 'forearms',
    'Quadriceps femoris': 'quads', 'Gluteus maximus': 'glutes', 'Pectoralis major': 'chest',
  };
  for (const [name, bucket] of Object.entries(expect)) {
    assert.equal(recoveryOf(name), bucket, `fatigue: ${name}`);
    assert.equal(normalizeMuscle(name), bucket, `balance: ${name}`);
  }
});

test('hip abduction is a glute muscle everywhere, never core', () => {
  // "abductors" contains "ab", which the core test used to catch first.
  assert.deepEqual(drawn('abductors'), ['gluteal']);
  assert.equal(recoveryOf('abductors'), 'glutes');
  assert.equal(normalizeMuscle('Abductors'), 'glutes');
  // and the abs themselves still are core
  assert.equal(recoveryOf('abdominals'), 'core');
  assert.equal(normalizeMuscle('Rectus abdominis'), 'core');
});
