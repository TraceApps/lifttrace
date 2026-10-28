/**
 * Excused days pause a calendar-mode program (issue #121), in the plan-week
 * rule's two copies: server/lib/programWeek.js and src/lib/programWeek.js
 * (the Android app's, standalone and connected). Both are held to the same
 * cases (fixtures/program-week-cases.mjs) and kept identical below their
 * header; the places that report a week pass the excused days in.
 * program-pause-server.test.js runs the dated case through the real server,
 * android-sync.test.js through the phone's own copy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = await import('../server/lib/programWeek.js');
const client = await import('../src/lib/programWeek.js');
const { CASES, NOW, optsFor, datedCase } = await import('./fixtures/program-week-cases.mjs');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const body = (src) => src.slice(src.indexOf('*/') + 2).trim();

test('the two copies are the same below their header', () => {
  assert.equal(body(read('../src/lib/programWeek.js')), body(read('../server/lib/programWeek.js')));
});

for (const [name, rule] of [['server', server], ['app', client]]) {
  test(`${name} copy: every case`, () => {
    for (const c of CASES) {
      assert.deepEqual(rule.planWeekState(c.program, c.assignment, optsFor(c)), c.expect, c.why);
      assert.equal(rule.currentPlanWeek(c.program, c.assignment, optsFor(c)), c.expect.week, c.why);
    }
  });
  test(`${name} copy: the dated case`, () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    const d = datedCase(today);
    const program = { advance_mode: 'calendar', duration_weeks: 4, on_complete: 'hold' };
    const opts = (excused, trained) => ({ now: NOW, timeZone: 'UTC', excusedDays: excused, trainedDays: new Set(trained) });
    assert.deepEqual(rule.planWeekState(program, { start_date: d.start }, opts(Object.values(d.excused), [d.excused.trained])), d.expect);
    assert.deepEqual(rule.planWeekState(program, { start_date: d.start }, opts([d.excused.before, d.excused.counted, d.excused.trained, d.excused.ahead], [d.excused.trained, d.excused.counted])), d.afterUndo);
  });
}

test('basic weeks without excused days: calendar, chosen, sessions, repeat', () => {
  const now = NOW;
  const at = (days) => new Date(now - days * 864e5).toISOString();
  const cal = { advance_mode: 'calendar', duration_weeks: 6 };
  for (const rule of [server, client]) {
    assert.equal(rule.currentPlanWeek(cal, { start_date: '2026-10-01' }, { now }), 3);
    assert.equal(rule.currentPlanWeek(cal, { assigned_at: at(8) }, { now }), 2);
    assert.equal(rule.currentPlanWeek(cal, { week_cursor: 4, week_cursor_pinned_at: at(15) }, { now }), 6);
    assert.equal(rule.currentPlanWeek(cal, null, { now }), 1, 'no anchor: week 1');
    assert.equal(rule.currentPlanWeek(cal, { assigned_at: 'not a date' }, { now }), 1, 'an unreadable anchor: week 1');
    const sess = { duration_weeks: 3 };
    assert.equal(rule.currentPlanWeek(sess, {}, { sessionsInProgram: 7, sessionsPerWeek: 3 }), 3);
    assert.equal(rule.currentPlanWeek(sess, { week_cursor: 1, week_cursor_session_base: 5 }, { sessionsInProgram: 8, sessionsPerWeek: 3 }), 2);
    assert.equal(rule.currentPlanWeek({ ...sess, on_complete: 'repeat' }, {}, { sessionsInProgram: 9, sessionsPerWeek: 3 }), 1);
  }
});

test("calendarDaysSince: whole days at the zone's midnight, as the calendar clock counts (the card's one-week Week N)", () => {
  for (const rule of [server, client]) {
    // 6 days 13 hours by the clock, 7 calendar days in UTC: Week 2, not 1.
    assert.equal(rule.calendarDaysSince('2026-10-08 23:00:00', { now: NOW, timeZone: 'UTC' }), 7);
    // 2 am UTC on the 9th was still the 8th in New York: 7 days there, 6 in UTC.
    assert.equal(rule.calendarDaysSince('2026-10-09 02:00:00', { now: NOW, timeZone: 'America/New_York' }), 7);
    assert.equal(rule.calendarDaysSince('2026-10-09 02:00:00', { now: NOW, timeZone: 'UTC' }), 6);
    assert.equal(rule.calendarDaysSince('2026-10-08T23:00:00.000Z', { now: NOW, timeZone: 'UTC' }), 7, 'ISO reads the same');
    assert.equal(rule.calendarDaysSince('2026-10-15', { now: NOW, timeZone: 'UTC' }), 0, 'a date as written: today is day 0');
    assert.equal(rule.calendarDaysSince('2026-10-17', { now: NOW, timeZone: 'UTC' }), -2, 'a day ahead is below zero');
    assert.equal(rule.calendarDaysSince(null, { now: NOW }), null);
    assert.equal(rule.calendarDaysSince('not a date', { now: NOW }), null);
  }
});

test('pauseWindow: what callers read excused days for', () => {
  const p = { advance_mode: 'calendar', duration_weeks: 4 };
  const now = NOW, timeZone = 'UTC';
  assert.deepEqual(server.pauseWindow(p, { start_date: '2026-10-01' }, { now, timeZone }), { from: '2026-10-01', to: '2026-10-15' });
  assert.deepEqual(server.pauseWindow(p, { start_date: '2026-09-01', assigned_at: '2026-08-01 00:00:00', week_cursor: 2, week_cursor_pinned_at: '2026-10-08T09:00:00Z' }, { now, timeZone }), { from: '2026-10-08', to: '2026-10-15' }, 'pinned: from the pin');
  assert.equal(server.pauseWindow({ ...p, advance_mode: 'sessions' }, { start_date: '2026-10-01' }, { now }), null);
  assert.equal(server.pauseWindow({ ...p, duration_weeks: 1 }, { start_date: '2026-10-01' }, { now }), null);
  assert.equal(server.pauseWindow(p, {}, { now }), null);
  assert.equal(server.pauseWindow(p, { start_date: '2026-10-20' }, { now, timeZone }), null, 'not started');
  assert.equal(server.dayOf(NOW, 'Nowhere/Invalid') != null, true, 'a zone Intl refuses falls back to the device');
});

test('every place that reports a week passes the excused days in', () => {
  const programs = read('../server/routes/programs.js');
  assert.doesNotMatch(programs, /currentPlanWeek\(/, 'programs.js goes through planWeekFor');
  assert.equal((programs.match(/planWeekFor\(/g) || []).length, 3, 'list (accounts and not) and detail');
  assert.match(programs, /p\.paused_days = pausedDays/);
  assert.match(read('../server/lib/mcp/tools/get-active-program.js'), /planWeekFor\(userId, assignment, assignment/);
  assert.match(read('../server/lib/mcp/tools/get-active-program.js'), /paused_days: pausedDays/);
  // The coach's view counts the client's days, in the client's zone
  // (planWeekFor falls back to it), not the coach's.
  assert.match(read('../server/routes/trainer.js'), /getActiveProgramCore\(memberId\);/);
  assert.match(read('../server/lib/program-pause.js'), /timeZone = timeZone \?\? userZone\(userId\);/);
  const native = read('../src/lib/api-native.js');
  assert.doesNotMatch(native, /currentPlanWeek\(/);
  assert.match(native, /planWeekState\(program, assignment, \{[\s\S]*?excusedDays,[\s\S]*?trainedDays,/);
  assert.match(native, /Programs\.list\(query \|\| \{\}\)/);
  assert.match(native, /Programs\.get\(Number\(id\), query \|\| \{\}\)/);
  const api = read('../src/lib/api.js');
  assert.match(api, /getPrograms: \(\) => fetch\(`\/api\/programs\$\{planWeekQuery\(\)\}`/);
  assert.match(api, /getProgram: \(id\) => fetch\(`\/api\/programs\/\$\{id\}\$\{planWeekQuery\(\)\}`/);
  assert.match(api, /getMemberOverview: .*planWeekQuery\(\{ cardio: false \}\)/);
  const ai = read('../src/lib/aiTools.js');
  assert.doesNotMatch(ai, /_get\(`\/api\/programs\/\$\{(Number\(id\)|active\.id|Number\(tpl\.program_id\))\}`\)/, "Trace's reads of a week send the zone and Track Cardio");
  assert.equal((ai.match(/paused_days: p\.paused_days/g) || []).length, 2);
  for (const f of ['../src/routes/Programs.svelte', '../src/routes/ProgramDetail.svelte', '../src/routes/Diary.svelte', '../src/routes/Coaching.svelte']) {
    assert.match(read(f), /\$_\('programs\.paused_days', \{ values: \{ count: /, f);
  }
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.programs.paused_days, '{count, plural, one {Paused # day for excused days} other {Paused # days for excused days}}');
});
