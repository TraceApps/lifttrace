// The cases the trained-day rule (src/lib/trained-day.js, issue #121) is
// held to, fed to the rule itself, to the server's statistics
// (trained-day.test.js) and to the phone's own (android-sync.test.js): one
// set of answers for all three.
export const TODAY = '2026-10-15'; // a Thursday

const work = (extra = {}) => [{ uuid: `ex-${Math.random().toString(36).slice(2)}`, exercise_id: 1, exercise_name: 'Squat', sets: [{ uuid: `s-${Math.random().toString(36).slice(2)}`, weight: 100, reps: 5, completed: true, ...extra }] }];

export const CASES = {
  from: '2026-09-28',
  workouts: [
    { date: '2026-10-15', exercises: work(), why: 'today, trained' },
    { date: '2026-10-14', exercises: work(), why: 'two workouts on one day' },
    { date: '2026-10-14', exercises: work(), second: true },
    { date: '2026-10-13', exercises: work({ warmup: true }), why: 'a warm-up alone (a cardio day when it counts)' },
    { date: '2026-10-12', exercises: work({ completed: false }), why: 'opened, never ticked' },
    { date: '2026-10-10', exercises: work() },
    { date: '2026-10-09', exercises: work() },
    { date: '2026-10-01', exercises: work() },
  ],
  cardio: [{ date: '2026-10-11' }, { date: '2026-10-13' }],
  expect: {
    // Workouts with a completed working set.
    sessions: 6,
    cardioOff: {
      streaks: { current: 2, longest: 2, days: 5 },
      byWeek: [{ week: '2026-09-28', count: 1 }, { week: '2026-10-05', count: 2 }, { week: '2026-10-12', count: 2 }],
      weekdays: [0, 0, 0, 1, 2, 1, 1].map((count, day) => ({ day, count })),
    },
    cardioOn: {
      streaks: { current: 3, longest: 3, days: 7 },
      byWeek: [{ week: '2026-09-28', count: 1 }, { week: '2026-10-05', count: 3 }, { week: '2026-10-12', count: 3 }],
      weekdays: [1, 0, 1, 1, 2, 1, 1].map((count, day) => ({ day, count })),
    },
  },
};

/** The answers, worked out by the rule from the same rows. */
export function expected(rule) {
  const out = { sessions: CASES.workouts.filter(w => rule.hasWorkingSet(w.exercises)).length };
  for (const on of [false, true]) {
    const dates = rule.trainedDates({ workouts: CASES.workouts, cardio: CASES.cardio, cardioOn: on });
    out[on ? 'cardioOn' : 'cardioOff'] = {
      streaks: { current: rule.currentStreak(dates, TODAY), longest: rule.longestStreak(dates), days: dates.size },
      byWeek: rule.trainedDaysByWeek(dates, CASES.from, TODAY),
      weekdays: rule.weekdayCounts(dates, CASES.from, TODAY),
    };
  }
  return out;
}
