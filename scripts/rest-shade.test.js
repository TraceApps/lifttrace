/**
 * The rest in the notification shade, and pausing it (training-depth plan 6b
 * and 6c).
 *
 * The arithmetic (pause, resume, +30s), the shape the rest crosses to the
 * watch in (including what a watch or phone from before pausing makes of
 * it), what the notification says is next, and "last time" run for real
 * here. The store and the native side are checked by their wiring, since
 * they pull in Capacitor and Android.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const {
  restLeftMs, restIsLive, restProgress, pausedRest, resumedRest, extendedRest,
  restClock, restToWire, restFromWire, REST_ADD_SEC,
} = await import('../src/lib/rest-state.js');
const { nextUp, setWords, lastTimeFor, restNoticeText } = await import('../src/lib/rest-next.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const T0 = 1_791_700_000_000;
const running = (over = {}) => ({
  startedAt: T0, endTime: T0 + 90_000, total: 90, exerciseId: 3, exerciseName: 'Bench Press', ...over,
});

// ── Pause and resume ─────────────────────────────────────────────────────

test('pausing holds what was left, however long the pause lasts', () => {
  const p = pausedRest(running(), T0 + 18_000);
  assert.equal(p.paused, true);
  assert.equal(p.leftMs, 72_000);
  assert.equal(restLeftMs(p, T0 + 18_000), 72_000);
  assert.equal(restLeftMs(p, T0 + 600_000), 72_000, 'ten minutes later it has not moved');
  assert.equal(restIsLive(p, T0 + 600_000), true);
});

test('resuming counts on from what was left, from now', () => {
  const p = pausedRest(running(), T0 + 18_000);
  const r = resumedRest(p, T0 + 300_000);
  assert.equal(r.paused, undefined);
  assert.equal(r.leftMs, undefined);
  assert.equal(r.endTime, T0 + 300_000 + 72_000);
  assert.equal(r.total, 90, 'the bar still fills toward the whole rest');
  assert.ok(Math.abs(restProgress(r, T0 + 300_000) - 0.2) < 1e-9);
});

test('pausing twice or resuming a running rest changes nothing', () => {
  const p = pausedRest(running(), T0 + 18_000);
  assert.equal(pausedRest(p, T0 + 50_000), p);
  const r = running();
  assert.equal(resumedRest(r, T0 + 50_000), r);
});

test('+30s adds to the deadline, or to what is left while paused', () => {
  const r = extendedRest(running(), REST_ADD_SEC, T0 + 10_000);
  assert.equal(r.endTime, T0 + 120_000);
  assert.equal(r.total, 120);
  const p = extendedRest(pausedRest(running(), T0 + 30_000), 30, T0 + 40_000);
  assert.equal(p.leftMs, 90_000);
  assert.equal(p.total, 120);
  assert.equal(p.paused, true);
});

test('the time left reads as the rest bar writes it', () => {
  assert.equal(restClock(72_000), '1:12');
  assert.equal(restClock(71_999), '1:11', 'whole seconds, as the rest bar shows them');
  assert.equal(restClock(0), '0:00');
});

// ── To the watch and back ────────────────────────────────────────────────

test('a running rest crosses as a deadline, exactly as before', () => {
  assert.deepEqual(restToWire(running(), 5), {
    cleared: false, paused: false, label: 'Bench Press', total: 90, endsAt: T0 + 90_000, at: 5,
  });
  assert.deepEqual(restToWire(null, 6), { cleared: true, paused: false, at: 6 });
});

test('a paused rest crosses as cleared, so a watch from before pausing takes it down', () => {
  const wire = restToWire(pausedRest(running(), T0 + 18_000), 7);
  assert.equal(wire.cleared, true, 'an old watch reads only this, stops, and does not buzz mid-pause');
  assert.equal(wire.paused, true);
  assert.equal(wire.leftMs, 72_000);
  assert.equal(wire.endsAt, 0);
  // What an old phone does with it (the store before pausing existed):
  // `if (theirs.cleared || theirs.endsAt <= Date.now()) stopRest(...)`.
  assert.ok(wire.cleared || wire.endsAt <= Date.now());
});

test('a paused rest from the watch is held here, keeping what this phone knew', () => {
  const mine = { ...running(), date: '2026-10-21', next: { name: 'Bench Press', number: 3, count: 4 } };
  const r = restFromWire({ cleared: true, paused: true, leftMs: 40_000, total: 90, label: 'Bench Press' }, T0 + 50_000, mine);
  assert.equal(r.state.paused, true);
  assert.equal(r.state.leftMs, 40_000);
  assert.equal(r.state.date, '2026-10-21');
  assert.equal(r.state.next.number, 3);
  assert.equal(r.state.startedAt, T0, 'the same rest, so a swipe-away still holds for it');
});

test('a watch from before pausing still reads as running or stopped', () => {
  const run = restFromWire({ cleared: false, label: 'Squat', total: 120, endsAt: T0 + 120_000 }, T0, null);
  assert.equal(run.state.endTime, T0 + 120_000);
  assert.equal(run.state.paused, undefined);
  assert.deepEqual(restFromWire({ cleared: true }, T0, running()), { stop: true });
  assert.deepEqual(restFromWire({ cleared: false, endsAt: T0 - 1 }, T0, running()), { stop: true });
});

test('a rest resumed elsewhere drops this side\'s pause', () => {
  const mine = pausedRest(running(), T0 + 10_000);
  const r = restFromWire({ cleared: false, paused: false, label: 'Bench Press', total: 90, endsAt: T0 + 200_000 }, T0 + 150_000, mine);
  assert.equal(r.state.paused, undefined);
  assert.equal(r.state.leftMs, undefined);
  assert.equal(r.state.endTime, T0 + 200_000);
});

test('another lift\'s rest does not keep this one\'s next set', () => {
  const mine = { ...running(), next: { name: 'Bench Press', number: 3, count: 4 } };
  const r = restFromWire({ cleared: false, label: 'Squat', total: 60, endsAt: T0 + 60_000 }, T0, mine);
  assert.equal(r.state.exerciseName, 'Squat');
  assert.equal(r.state.next, undefined);
});

// ── What is next ─────────────────────────────────────────────────────────

const ex = (name, sets, over = {}) => ({ exercise_id: name.length, exercise_name: name, sets, ...over });
const s = (weight, reps, completed = false, over = {}) => ({ weight, reps, completed, ...over });

test('the same lift\'s next set, numbered among the working sets', () => {
  const bench = ex('Bench Press', [s(95, 5, true, { warmup: true }), s(150, 8, true), s(150, 8, true), s(150, 8), s(150, 8)]);
  const n = nextUp([bench], 0);
  assert.equal(n.name, 'Bench Press');
  assert.equal(n.number, 3);
  assert.equal(n.count, 4);
  assert.equal(n.weight, 150);
  assert.equal(n.reps, 8);
});

test('a superset goes back to the top for the next round', () => {
  const a = ex('Bench Press', [s(150, 8, true), s(150, 8)], { superset_id: 'g', superset_size: 2 });
  const b = ex('Barbell Row', [s(135, 10, true), s(135, 10)], { superset_id: 'g', superset_size: 2 });
  const n = nextUp([a, b], 1);
  assert.equal(n.name, 'Bench Press');
  assert.equal(n.superset, true);
  assert.equal(n.number, 2);
  assert.equal(n.count, 2);
});

test('an uneven pairing goes by the earliest round with work left', () => {
  // The third exercise only joins rounds 2 and 3.
  const a = ex('Squat', [s(225, 5, true), s(225, 5), s(225, 5)], { superset_id: 'g', superset_size: 3 });
  const b = ex('Lunge', [s(50, 10, true), s(50, 10), s(50, 10)], { superset_id: 'g', superset_size: 3 });
  const c = ex('Calf Raise', [s(100, 15, false, { number: 2 }), s(100, 15, false, { number: 3 })], { superset_id: 'g', superset_size: 3 });
  const n = nextUp([a, b, c], 1);
  assert.equal(n.name, 'Squat');
  assert.equal(n.number, 2);
  assert.equal(n.count, 3);
});

test('a finished lift hands off to the next one with work left', () => {
  const bench = ex('Bench Press', [s(150, 8, true), s(150, 8, true)]);
  const squat = ex('Squat', [s(135, 5, false, { warmup: true }), s(225, 5)]);
  const n = nextUp([bench, squat], 0);
  assert.equal(n.name, 'Squat');
  assert.equal(n.warmup, true, 'its warm-up comes first');
  const done = ex('Squat', [s(135, 5, true, { warmup: true }), s(225, 5)]);
  const m = nextUp([bench, done], 0);
  assert.equal(m.name, 'Squat');
  assert.equal(m.number, 1);
});

test('nothing left in the session is nothing next', () => {
  assert.equal(nextUp([ex('Bench Press', [s(150, 8, true)])], 0), null);
  assert.equal(nextUp([], 0), null);
});

// ── The words ────────────────────────────────────────────────────────────

const t = (key, opts) => {
  const v = opts?.values || {};
  return ({
    'rest_bar.set_of': `Set ${v.n} of ${v.count} · ${v.name}`,
    'rest_bar.round_of': `Round ${v.n} of ${v.count} · ${v.name}`,
    'rest_bar.warmup': `Warm-Up · ${v.name}`,
    'rest_bar.reps': `${v.n} reps`,
    'rest_bar.last_time': `Last time ${v.set}`,
  })[key] ?? key;
};

test('the notification leads with the next set, then last time', () => {
  const next = { name: 'Bench Press', number: 3, count: 4, weight: 150, reps: 8, timed: false };
  assert.deepEqual(restNoticeText(next, { unit: 'lbs', last: '145 × 8', t }), {
    title: 'Set 3 of 4 · Bench Press',
    text: '150 lbs × 8 · Last time 145 × 8',
  });
  assert.equal(restNoticeText({ ...next, superset: true }, { t }).title, 'Round 3 of 4 · Bench Press');
  assert.deepEqual(restNoticeText(null, { t, fallbackTitle: 'Rest' }), { title: 'Rest', text: '' });
});

test('sets read the way a lifter says them', () => {
  assert.equal(setWords({ weight: 150, reps: 8 }, { unit: 'lbs', t }), '150 lbs × 8');
  assert.equal(setWords({ weight: 62.5, reps: 5 }, { t }), '62.5 × 5');
  assert.equal(setWords({ weight: 0, reps: 12 }, { unit: 'kg', t }), '12 reps');
  assert.equal(setWords({ weight: 0, duration_sec: 60 }, { timed: true, t }), '1:00');
  assert.equal(setWords({ weight: 20, duration_sec: 45 }, { unit: 'kg', timed: true, t }), '20 kg × 0:45');
  assert.equal(setWords({ weight: 40, reps_l: 10, reps_r: 9 }, { unit: 'lbs', t }), '40 lbs × 10 / 9');
});

test('last time is the Diary\'s last session, never today, same set when it had one', () => {
  const history = [
    { date: '2026-10-21', sets: [s(150, 8, true)] },
    { date: '2026-10-17', sets: [s(95, 5, true, { warmup: true }), s(145, 8, true), s(145, 8, true), s(145, 7, true)] },
  ];
  assert.equal(lastTimeFor(history, { before: '2026-10-21', number: 3, t }), '145 × 7');
  assert.equal(lastTimeFor(history, { before: '2026-10-21', number: 5, t }), '145 × 7', 'fewer sets then: its last');
  assert.equal(lastTimeFor(history, { before: '2026-10-17', number: 1, t }), '', 'nothing before it');
});

// ── Wiring ───────────────────────────────────────────────────────────────

const store = read('../src/stores/restTimer.js');
const bar = read('../src/components/diary/RestTimer.svelte');
const diary = read('../src/routes/Diary.svelte');
const plugin = read('../android/app/src/main/java/com/lifttrace/app/RestTimerCuePlugin.java');
const shade = read('../android/app/src/main/java/com/lifttrace/app/RestShade.java');
const receiver = read('../android/app/src/main/java/com/lifttrace/app/RestTimerCueReceiver.java');
const manifest = read('../android/app/src/main/AndroidManifest.xml');

test('the rest bar pauses and resumes, on the web as in the app', () => {
  assert.match(store, /export function pauseRest\(\)/);
  assert.match(store, /export function resumeRest\(\)/);
  assert.match(bar, /paused \? resumeRest\(\) : pauseRest\(\)/);
});

test('pausing takes the OS cues down and tells the watch; resuming re-arms only from the background', () => {
  const pause = store.slice(store.indexOf('export function pauseRest'), store.indexOf('export function resumeRest'));
  assert.match(pause, /_clearBeeps\(\)/);
  assert.match(pause, /_cancelNativeFinish\(\)/);
  assert.match(pause, /_tellWatch\(next\)/);
  const resume = store.slice(store.indexOf('export function resumeRest'), store.indexOf('export function stopRest'));
  assert.match(resume, /_scheduleBeeps\(next\.endTime\)/);
  assert.match(resume, /visibilityState === 'hidden'[\s\S]*_scheduleNativeFinish\(next\)/);
});

test('+30s in the app no longer arms OS cues over the app\'s own countdown', () => {
  const add = store.slice(store.indexOf('export function addRestTime'), store.indexOf('export function pauseRest'));
  assert.match(add, /visibilityState === 'hidden'[\s\S]*_scheduleNativeFinish\(next\)/);
});

test('a paused rest survives a reload, and a running one past its end does not', () => {
  assert.match(store, /if \(state\.paused\) \{\s*if \(Number\(state\.leftMs\) > 0\) return state;/);
});

test('the Do Not Disturb option reaches every cue, and the receiver plays it as an alarm', () => {
  assert.match(store, /const alarm = get\(restAlertOutput\) === 'alarm';/);
  const plan = store.slice(store.indexOf('function _cuePlan'), store.indexOf('async function _scheduleNativeFinish'));
  const pushes = plan.split('cues.push({').slice(1).map(p => p.slice(0, p.indexOf('});')));
  assert.equal(pushes.length, 3);
  for (const p of pushes) assert.match(p, /alarm/);
  assert.match(read('../android/app/src/main/java/com/lifttrace/app/RestCues.java'), /intent\.putExtra\("alarm", c\.optBoolean\("alarm", false\)\)/);
  assert.match(receiver, /asAlarm \? AudioAttributes\.USAGE_ALARM : AudioAttributes\.USAGE_NOTIFICATION_EVENT/);
  assert.match(read('../src/stores/settings.js'), /createSettingStore\('restAlertOutput',\s+'notification'\)/);
});

test('the notification is silent, ongoing, local-only, on the lock screen, counted by Android', () => {
  for (const call of ['setOngoing(true)', 'setSilent(true)', 'setOnlyAlertOnce(true)', 'setLocalOnly(true)',
    'setVisibility(NotificationCompat.VISIBILITY_PUBLIC)', 'setUsesChronometer(true)', 'setChronometerCountDown(true)',
    'setWhen(r.endsAt)', 'setRequestPromotedOngoing(true)']) {
    assert.ok(shade.includes(call), call);
  }
  assert.doesNotMatch(shade, /startForeground|setColorized\(true\)/);
  assert.match(manifest, /android\.permission\.POST_PROMOTED_NOTIFICATIONS/);
  assert.match(manifest, /\.RestShadeReceiver"\s+android:exported="false"/);
});

test('its buttons say our words in our order: Skip Rest, +30s, Pause; paused: Resume, Skip Rest', () => {
  const running = shade.slice(shade.indexOf('} else {\n            b.setWhen'));
  const order = [...running.matchAll(/addAction\(0, r\.(\w+),/g)].map(m => m[1]).slice(0, 3);
  assert.deepEqual(order, ['skip', 'add', 'pause']);
  const paused = shade.slice(shade.indexOf('if (paused) {'), shade.indexOf('} else {\n            b.setWhen'));
  assert.deepEqual([...paused.matchAll(/addAction\(0, r\.(\w+),/g)].map(m => m[1]), ['resume', 'skip']);
  assert.match(store, /skip: t\('rest_bar\.skip'\)/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.rest_bar.skip, 'Skip Rest');
  assert.equal(en.rest_bar.paused_left, 'Rest paused, {time} left');
});

test('the bar is redrawn only while the screen is on and a rest is counting', () => {
  assert.match(shade, /ACTION_SCREEN_OFF[\s\S]*stopTicks\(\)/);
  assert.match(read('../android/app/src/main/java/com/lifttrace/app/RestRecord.java'),
    /return screenOn && !dismissed\(\) && kind\(now\) == Kind\.RUNNING;/);
});

test('the app picks up what the notification changed before it plays anything', () => {
  assert.match(store, /onNativeRest\(_fromNative\)/);
  const vis = store.slice(store.indexOf("document.addEventListener('visibilitychange'"));
  assert.ok(vis.indexOf('_syncNative()') < vis.indexOf('_scheduleBeeps(state.endTime)'));
  assert.match(plugin, /notifyListeners\("restChanged"/);
  assert.match(plugin, /notifyListeners\("openRest", data, true\)/);
});

test('the Diary hands the rest its next set and its day, and opens on that day from a tap', () => {
  assert.match(diary, /const next = nextUp\(updatedExercises, idx\);/);
  assert.match(diary, /date:\s+restDay,\s+next,/);
  assert.match(diary, /lastTimeFor\(history, \{\s*before: restDay/);
  assert.match(diary, /const targetDate = _takeOpenDate\(\) \|\| localDateStr\(\);/);
});

// ── What the independent review found ────────────────────────────────────

test('no notification timeout: on Android 8 to 14 it outlived a re-post and took a paused rest down', () => {
  assert.doesNotMatch(shade, /\.setTimeoutAfter\(/);
  assert.match(shade, /scheduleEnd\(app, r\.endsAt\)/);
});

test('an older word from the app never overwrites a newer one from a button or the watch', () => {
  assert.match(shade, /static void fromApp\(Context ctx, RestRecord r, boolean keepWords\) \{\s*RestRecord had = load\(ctx\);\s*if \(r\.at < had\.at\) return;/);
  // Last time arriving late changes the words only.
  assert.match(store, /_shade\(next, _restStamp\(\), \{ wordsOnly: true \}\)/);
});

test('cues armed while the app was away come down when it comes to the front, even on a cold start', () => {
  assert.match(plugin, /handleOnResume\(\) \{[\s\S]*?RestCues\.hold\(getContext\(\)\)/);
});

test('the app re-checks before cancelling cues, and re-arms for a rest moved meanwhile', () => {
  const fin = store.slice(store.indexOf('async function _scheduleNativeFinish'), store.indexOf('async function _cancelNativeFinish'));
  assert.ok(fin.indexOf('if (stale(get(restTimer))) return;') < fin.indexOf('await cancelCues();'));
  assert.match(fin, /return _scheduleNativeFinish\(current\)/);
});

test('a watch holding a pause hears how it ends, from the app and from the notification', () => {
  assert.match(store, /const force = _onWatch && _watchPaused;/);
  assert.match(read('../src/lib/wear-pairing.js'), /if \(!force && !\(await watchInUse\(\)\)\) return false;/);
  assert.match(shade, /boolean force = r\.onWatch && r\.kind\(now\) == RestRecord\.Kind\.PAUSED;/);
});

test('a rest taken up from the notification keeps its day and which rest it was', () => {
  const r = restFromWire({ cleared: false, label: 'Bench Press', total: 90, endsAt: T0 + 90_000, startedAt: T0 - 5, date: '2026-10-21' }, T0, null);
  assert.equal(r.state.startedAt, T0 - 5);
  assert.equal(r.state.date, '2026-10-21');
});

test('every change to the native rest runs on the main thread', () => {
  assert.match(read('../android/app/src/main/java/com/lifttrace/app/RestWearListener.java'), /RestShade\.onMain\(/);
  for (const m of ['show', 'hide', 'state', 'schedule', 'cancel']) {
    const body = plugin.slice(plugin.indexOf(`public void ${m}(PluginCall call)`));
    assert.match(body.slice(0, body.indexOf('\n    }\n')), /RestShade\.onMain\(/, m);
  }
});

test('a hold on the watch is not paused from the phone', () => {
  assert.match(read('../android/wear/src/main/java/com/lifttrace/app/wear/Pairing.kt'), /rest != null && rest\.paused && holdArmed\(ctx\) -> return/);
});
