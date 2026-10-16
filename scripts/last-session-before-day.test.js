/**
 * The Diary's "Last" row compares an exercise with the session before the
 * day being logged. History (GET /api/workout/history/:id, and the phone's
 * own copy in api-native.js) lists every day the exercise appears on, newest
 * first and the day being logged included, so once one set was ticked the
 * card read "Last (today)", its volume chip compared today with itself, and
 * auto-fill copied today's sets. A day viewed in the past compared itself
 * with later days. Days before the diary's date count, as on the watch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { lastCompletedSession, exerciseVolume } = await import('../src/lib/workout.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const set = (weight, reps, completed = true, extra = {}) => ({ weight, reps, completed, ...extra });

// The reported day: the previous Push had the incline at 145, today's has one
// set of 150 x 8 ticked (the seeded one), and a second ticked offline.
const TODAY = '2026-10-16';
const history = [
  { date: TODAY, sets: [set(150, 8), set(150, 8, false), set(150, 8, false)] },
  { date: '2026-10-13', sets: [set(145, 8), set(145, 8), set(145, 7)] },
  { date: '2026-10-09', sets: [set(145, 8), set(145, 8), set(145, 7)] },
  { date: '2026-10-06', sets: [set(140, 8), set(140, 8), set(140, 8)] },
];

test('the reported case: today is never its own last session', () => {
  const last = lastCompletedSession(history, { before: TODAY });
  assert.equal(last.date, '2026-10-13');
  assert.deepEqual(last.completed.map(s => `${s.weight}x${s.reps}`), ['145x8', '145x8', '145x7']);
  // The volume chip: two sets of 150 x 8 against the previous session, not
  // against today's first set (which read +100%).
  const current = exerciseVolume({ load_type: 'bilateral', sets: [set(150, 8), set(150, 8), set(150, 8, false)] });
  const prev = exerciseVolume({ load_type: 'bilateral', sets: last.completed });
  assert.equal(Math.round((current - prev) / prev * 100), -28);
});

test('a second session the same day is not last time either', () => {
  const twoToday = [
    { date: TODAY, sets: [set(150, 8)] },
    { date: TODAY, sets: [set(155, 6), set(155, 6)] },
    ...history.slice(1),
  ];
  assert.equal(lastCompletedSession(twoToday, { before: TODAY }).date, '2026-10-13');
});

test('a day in the past compares with the day before it, not a later one', () => {
  assert.equal(lastCompletedSession(history, { before: '2026-10-13' }).date, '2026-10-09');
  assert.equal(lastCompletedSession(history, { before: '2026-10-06' }), null, 'nothing before the first time');
  // Planning ahead: today's ticked set is the last one before tomorrow.
  assert.equal(lastCompletedSession(history, { before: '2026-10-17' }).date, TODAY);
});

test('the phone\'s history shape (the whole exercise spread in) reads the same', () => {
  const native = history.map(h => ({ date: h.date, uuid: 'u', exercise_id: 985, exercise_name: 'Incline', sets: h.sets }));
  assert.equal(lastCompletedSession(native, { before: TODAY }).date, '2026-10-13');
});

test('an entry with no date never passes as before the day; no day keeps the old pick', () => {
  assert.equal(lastCompletedSession([{ sets: [set(1, 1)] }, history[1]], { before: TODAY }).date, '2026-10-13');
  assert.equal(lastCompletedSession(history).date, TODAY);
  assert.equal(lastCompletedSession(history, {}).date, TODAY);
});

test('the card, auto-fill, PR badges, celebrations and the watch use the same day rule', () => {
  const card = read('../src/components/diary/ExerciseCard.svelte');
  assert.match(card, /lastCompletedSession\(await LtApi\.getWorkoutHistory\(exerciseId\), \{ before: day \}\)/);
  // Looked up again for a new day, and a late answer for an old one is dropped.
  assert.match(card, /\$: if \(exercise\.exercise_id && `\$\{exercise\.exercise_id\}\|\$\{date\}` !== _lastSessionFetched\)/);
  assert.match(card, /loadLastSession\(exercise\.exercise_id, date\);/);
  assert.match(card, /if \(!recent \|\| key !== _lastSessionFetched\) return;/);
  const diary = read('../src/routes/Diary.svelte');
  const fill = diary.slice(diary.indexOf('async function getLastSets'), diary.indexOf('let pickerTargetSupersetId'));
  assert.match(fill, /\{ before: \$currentDate \}/);
  // Every card gets the diary's date: Diary's own card and its superset card
  // (each tag on its own, so a date on a later tag can't stand in for it).
  const tags = (src, name) => src.match(new RegExp(`<${name}\\b[\\s\\S]*?/>`, 'g')) || [];
  const diaryCards = tags(diary, 'ExerciseCard');
  assert.equal(diaryCards.length, 1);
  assert.match(diaryCards[0], /\bdate=\{\$currentDate\}/);
  const supersets = tags(diary, 'SupersetCard');
  assert.equal(supersets.length, 1);
  assert.match(supersets[0], /\bdate=\{\$currentDate\}/);
  const inSuperset = tags(read('../src/components/diary/SupersetCard.svelte'), 'ExerciseCard');
  assert.equal(inSuperset.length, 2);
  for (const tag of inSuperset) assert.match(tag, /\{date\}/);
  // PR badges and the PR celebrations leave the day out.
  assert.match(diary, /const prior = \(history \|\| \[\]\)\.filter\(h => h\.date !== \$currentDate\);/);
  assert.equal((diary.match(/if \(h\.date === \$currentDate\) continue;/g) || []).length, 2);
  // The watch's "Last time": days before today only.
  assert.match(read('../android/wear/src/main/java/com/lifttrace/app/wear/Session.kt'), /if \(date\.isBlank\(\) \|\| date >= today\) continue/);
});
