/**
 * The phone's own reminders fire only on the days they apply to
 * (reminder-plan.js). Streak at Risk used to be a daily alarm that went off
 * every evening, a streak or not, trained or not, and the Workout Reminder
 * and Rest Day the same.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planReminders, fireTime, WORKOUT_DAYS } from '../src/lib/reminder-plan.js';

const TODAY = '2026-11-16';
const all = { workout: true, streak: true, rest: true };
const kinds = (list, kind) => list.filter(r => r.kind === kind).map(r => r.day);

test('a missed day leaves no streak: no Streak at Risk today or tomorrow', () => {
  const trained = new Set(['2026-11-13', '2026-11-14']); // trained, then missed the 15th
  assert.deepEqual(kinds(planReminders({ today: TODAY, trained, ...all }), 'streak'), []);
});

test('a streak going into today is at risk today, and none tomorrow while today is not trained', () => {
  const trained = new Set(['2026-11-14', '2026-11-15']);
  assert.deepEqual(kinds(planReminders({ today: TODAY, trained, ...all }), 'streak'), ['2026-11-16']);
});

test('trained today: no alert today, and tomorrow is at risk', () => {
  const trained = new Set(['2026-11-15', '2026-11-16']);
  const plan = planReminders({ today: TODAY, trained, ...all });
  assert.deepEqual(kinds(plan, 'streak'), ['2026-11-17']);
  assert.ok(!kinds(plan, 'workout').includes(TODAY), 'no Workout Reminder on a day trained');
});

test('an excused day gets no Streak at Risk and no Workout Reminder', () => {
  const trained = new Set(['2026-11-15']);
  const excused = new Set([TODAY, '2026-11-20']);
  const plan = planReminders({ today: TODAY, trained, excused, ...all });
  assert.deepEqual(kinds(plan, 'streak'), []);
  assert.ok(!kinds(plan, 'workout').includes(TODAY));
  assert.ok(!kinds(plan, 'workout').includes('2026-11-20'));
});

test('Rest Day only on the day after a trained day, and not once that day is trained', () => {
  assert.deepEqual(kinds(planReminders({ today: TODAY, trained: new Set(['2026-11-15']), ...all }), 'rest'), [TODAY]);
  assert.deepEqual(kinds(planReminders({ today: TODAY, trained: new Set(['2026-11-15', TODAY]), ...all }), 'rest'), ['2026-11-17']);
  assert.deepEqual(kinds(planReminders({ today: TODAY, trained: new Set(['2026-11-13']), ...all }), 'rest'), []);
});

test('the Workout Reminder covers the days ahead, each with its own id offset; only what is on is planned', () => {
  const plan = planReminders({ today: TODAY, workout: true });
  assert.equal(plan.length, WORKOUT_DAYS);
  assert.deepEqual(plan.map(r => r.offset), [...Array(WORKOUT_DAYS).keys()]);
  assert.equal(plan.at(-1).day, '2027-01-14');
  assert.deepEqual(planReminders({ today: TODAY, trained: new Set(['2026-11-15']) }), []);
});

test('fireTime is the chosen time on that calendar day in the phone\'s zone, across month ends', () => {
  const at = fireTime('2026-11-30', '20:15', 20);
  assert.deepEqual([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()], [2026, 10, 30, 20, 15]);
  assert.equal(fireTime('2026-12-01', 'bad', 7).getHours(), 7);
});

test('the phone sets these one-off reminders and sets them again when training changes', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const notif = read('../src/lib/notifications.js');
  assert.match(notif, /planReminders\(\{ today, \.\.\.days, \.\.\.on \}\)/);
  assert.match(notif, /schedule: \{ at, allowWhileIdle: true \}/);
  assert.doesNotMatch(notif, /_dailyAt/, 'no daily repeating Workout, Streak or Rest alarm');
  assert.match(notif, /const mine = new Set\(\[REMINDER_IDS\.workout, REMINDER_IDS\.streakAtRisk, REMINDER_IDS\.restDay\]\)/, 'the old repeating alarms are still cancelled');
  const app = read('../src/App.svelte');
  assert.match(app, /\['lt:training-changed', 'lt:sync-complete', 'lt:watch-saved'\]/);
  // Coming back (perhaps on a new day) sets them again, in Local mode and with a server.
  assert.equal((app.match(/=> rescheduleRemindersSoon\(\)\)\.catch/g) || []).length, 2);
  const fetchSrc = read('../src/lib/apiFetch.js');
  assert.match(fetchSrc, /\^\\\/api\\\/\(workout\|workout-import\|cardio\|excused-days\)/);
  // Trained days are asked like Statistics asks: the server when connected.
  assert.match(notif, /LtApi\.getFrequency\(day, day, cardio\)/);
  assert.match(notif, /LtApi\.listExcusedDays\(\)/);
  // Only reminders not yet fired are cancelled: one in the shade stays.
  assert.match(notif, /LocalNotifications\.getPending\(\)/);
  assert.match(app, /k === 'cardioEnabled'\) rescheduleRemindersSoon\(\)/);
});
