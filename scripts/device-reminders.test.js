/**
 * On-device reminders (#97). The Capacitor Android plugin reads a schedule's
 * `every` before its `on` and, when `every` is set, repeats from the moment of
 * scheduling and ignores `on`, so the time chosen in Settings was lost and
 * every app start pushed the reminder another day out. These pin the schedule
 * shape and the setting names; the helpers are run for real, lifted out of
 * notifications.js (which imports Capacitor and can't load under node).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/lib/notifications.js');
const fn = (name) => {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
};
const { _dailyAt, _weeklyOn } = new Function(`${fn('_hhmm')}\n${fn('_dailyAt')}\n${fn('_weeklyOn')}\nreturn { _dailyAt, _weeklyOn };`)();

test('daily reminders fire at the chosen time of day, with no interval to override it', () => {
  const n = _dailyAt(1, 't', 'b', '06:45');
  assert.deepEqual(n.schedule.on, { hour: 6, minute: 45 });
  assert.equal(n.schedule.every, undefined);
});

test('the weekly summary fires once a week on the chosen day (Sunday = 1 for the plugin)', () => {
  assert.deepEqual(_weeklyOn(4, 't', 'b', '09:30', 0).schedule.on, { weekday: 1, hour: 9, minute: 30 });
  assert.equal(_weeklyOn(4, 't', 'b', '09:30', 6).schedule.on.weekday, 7, 'Saturday');
  assert.equal(_weeklyOn(4, 't', 'b', '09:30', '3').schedule.on.weekday, 4, 'stored as a string');
  assert.equal(_weeklyOn(4, 't', 'b', '09:30', 0).schedule.every, undefined);
});

test('no reminder schedule carries `every`', () => {
  const body = src.slice(src.indexOf('export async function scheduleNativeReminders'), src.indexOf('// ── App-update notification'));
  assert.doesNotMatch(body, /every:\s*'/);
});

test('reminders read the setting names Settings writes, and rescheduling covers the weekly ones', () => {
  for (const key of ['notifWorkoutTime', 'notifStreakAlert', 'notifStreakTime', 'weeklySummaryTime', 'weeklySummaryDay']) {
    assert.match(src, new RegExp(`'${key}'`), key);
  }
  assert.doesNotMatch(src, /notifWorkoutReminderTime|notifStreakAtRisk|notifWeeklySummaryTime/);
  const app = read('../src/App.svelte');
  assert.match(app, /k === 'weeklySummaryDay' \|\| k === 'weeklySummaryTime'/);
});
