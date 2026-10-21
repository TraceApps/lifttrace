import { writable, get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { restAlert, restAlertVibrate, restAlertTone, restAlertToneId, restAlertOutput, restPerExercise, weightUnit } from './settings.js';
import { getTone } from '../lib/restTones.js';
import { isNative } from '../lib/platform.js';
import { restLeftMs, pausedRest, resumedRest, extendedRest, restFromWire, REST_ADD_SEC } from '../lib/rest-state.js';
import { restNoticeText } from '../lib/rest-next.js';
// CLAUDE.md note (LiftTrace + NutriTrace): LocalNotifications MUST be a static
// import. Dynamic `await import('@capacitor/local-notifications')` silently
// fails on Android with `.then() is not a function`, so the rest-timer
// finish notification never schedules → no sound + no vibration when the
// app is backgrounded. Do not change this to dynamic.
import { LocalNotifications } from '@capacitor/local-notifications';

/**
 * Persistent rest-timer state that survives page navigation AND backgrounded
 * tabs. Works off an absolute `endTime` timestamp rather than a fragile
 * setInterval countdown — so even if the browser throttles timers or the
 * user backgrounds the PWA for two minutes, we still know exactly how much
 * time is left when they come back.
 *
 * Countdown UX: three short beeps at the 3 / 2 / 1 second marks (each with
 * a small vibrate), plus a final higher-pitch alert + double vibrate at 0.
 * When the document is hidden we fire a Service Worker notification so the
 * OS can vibrate / sound in the background.
 *
 * A rest can be paused: it then holds what was left (`paused`, `leftMs`)
 * instead of a deadline, nothing counts or rings, and resuming counts on from
 * there (src/lib/rest-state.js). On Android the rest also sits in the
 * notification shade and on the lock screen while it runs or is paused, with
 * buttons that work with the app closed (RestShade.java); whatever they
 * change is picked up here.
 */

const LS_KEY = 'lt:rest-timer';

/** Current timer record, or null if no timer is running. */
export const restTimer = writable(null);
/** Remaining seconds (fractional). 0 when idle. */
export const restRemaining = writable(0);

let _tickInterval = null;
let _beepTimers = [];

// ── Persistence ────────────────────────────────────────────────────────────
function _persist(state) {
  try {
    if (state) localStorage.setItem(LS_KEY, JSON.stringify(state));
    else localStorage.removeItem(LS_KEY);
  } catch {}
}

function _load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state) return null;
    // A paused rest has no deadline to run past: it keeps what was left.
    if (state.paused) {
      if (Number(state.leftMs) > 0) return state;
      localStorage.removeItem(LS_KEY);
      return null;
    }
    if (!state.endTime) return null;
    if (state.endTime <= Date.now()) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return state;
  } catch { return null; }
}

// ── Audio ──────────────────────────────────────────────────────────────────
let _audioCtx = null;
function _tone(frequency, durationMs, gainPeak = 0.28, oscType = 'sine') {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      _audioCtx = new Ctx();
    }
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = oscType;
    osc.frequency.value = frequency;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + 0.015);
    gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + (durationMs / 1000) + 0.02);
  } catch {}
}

function _playPresetCountdown(n) {
  const preset = getTone(get(restAlertToneId));
  const cue = preset.countdown?.(n);
  if (!cue) return;
  _tone(cue.freq, cue.ms, cue.gain ?? 0.22, cue.type || 'sine');
}

function _playPresetFinale() {
  const preset = getTone(get(restAlertToneId));
  for (const step of (preset.finale || [])) {
    setTimeout(() => _tone(step.freq, step.ms, step.gain ?? 0.28, step.type || 'sine'), step.delayMs || 0);
  }
}

// Play a preset without going through the rest-timer state machine — used by
// the Settings preview button so users can sample each tone before picking.
export function previewRestTone(id) {
  const preset = getTone(id);
  // Short countdown taste + finale
  const c3 = preset.countdown?.(3);
  const c1 = preset.countdown?.(1);
  let t = 0;
  if (c3) { setTimeout(() => _tone(c3.freq, c3.ms, c3.gain ?? 0.22, c3.type || 'sine'), t); t += 200; }
  if (c1) { setTimeout(() => _tone(c1.freq, c1.ms, c1.gain ?? 0.22, c1.type || 'sine'), t); t += 200; }
  for (const step of (preset.finale || [])) {
    setTimeout(() => _tone(step.freq, step.ms, step.gain ?? 0.28, step.type || 'sine'), t + (step.delayMs || 0));
  }
}

function _vibrate(pattern) {
  // Routed through haptics shim so Capacitor builds get native impact feedback
  // instead of relying on the WebView's flaky navigator.vibrate.
  import('../lib/haptics.js').then(m => m.haptic(pattern)).catch(() => {});
}

// ── Scheduled countdown cues (3s / 2s / 1s / 0s) ───────────────────────────
function _clearBeeps() {
  for (const t of _beepTimers) clearTimeout(t);
  _beepTimers = [];
}

function _scheduleBeeps(endTime) {
  _clearBeeps();
  const offsets = [
    { at: endTime - 3000, action: () => _countdownCue(3) },
    { at: endTime - 2000, action: () => _countdownCue(2) },
    { at: endTime - 1000, action: () => _countdownCue(1) },
    { at: endTime,        action: () => _finish()       },
  ];
  const now = Date.now();
  for (const { at, action } of offsets) {
    const delay = at - now;
    if (delay < -100) continue; // already passed, skip
    _beepTimers.push(setTimeout(action, Math.max(0, delay)));
  }
}

function _countdownCue(n) {
  // When the page is backgrounded (or the device screen is off), Web Audio
  // is suspended so the synthesized countdown beep never plays. Fall back
  // to a Service Worker notification so the OS provides a haptic cue.
  // The 0s "Rest complete" notification is still handled by _finish().
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (hidden) {
    _bgCountdownNotify(n);
    return;
  }
  if (get(restAlertTone))    _playPresetCountdown(n);
  if (get(restAlertVibrate)) _vibrate(40);
}

/**
 * Sound + vibration cue for the hold timer (issue #89), reusing the rest
 * timer's tone preset and honouring the same Tone and Vibrate settings, so a
 * user who silenced rest alerts is not surprised by beeps from a plank.
 * Foreground only: a hold is done looking at the phone, and the rest timer's
 * background notification path would say "rest" about a set.
 *
 * kind: 'count' (n = 3, 2 or 1) or 'go' (start of the hold, and the moment
 * the target time is reached).
 */
export function playTimerCue(kind, n = 1) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (kind === 'count') {
    if (get(restAlertTone))    _playPresetCountdown(n);
    if (get(restAlertVibrate)) _vibrate(40);
    return;
  }
  if (get(restAlertTone))    _playPresetFinale();
  if (get(restAlertVibrate)) _vibrate([80, 60, 80]);
}

// ── Native (Capacitor) OS-level finish notification ───────────────────────
// On Android, sound + vibration during the countdown is delivered by the
// RestTimerCue native plugin (AlarmManager broadcasts → MediaPlayer +
// Vibrator with no notification posted), and only the final "Rest
// complete" message appears as a LocalNotification on a silent channel.
// That gets users the audio cues they're used to without the 4-5
// stacked notification rows the v4 multi-notification design produced.
const REST_TIMER_AUDIO_ID = 9001;

const REST_TIMER_CHANNEL_FINISH = 'lifttrace_rest_v6_finish';
const REST_TIMER_TONES = ['classic', 'bells', 'beeper', 'gym', 'minimal'];
let _nativeNotifReady = false;

async function _ensureNativeNotifReady() {
  if (_nativeNotifReady) return;
  if (!isNative) return;
  try {
    // Best-effort cleanup of stale channels from earlier versions —
    // channels are immutable once created, so v2/v3/v4/v5 stick around
    // in OS settings forever otherwise. Failures (channel doesn't
    // exist) are ignored.
    const stale = [
      'lifttrace_rest_timer',
      'lifttrace_rest_timer_v2',
      'lifttrace_rest_timer_v2_silent',
      ...REST_TIMER_TONES.map(t => `lifttrace_rest_v3_${t}`),
      ...REST_TIMER_TONES.map(t => `lifttrace_rest_v4_${t}`),
      'lifttrace_rest_v4_tick',
      ...REST_TIMER_TONES.flatMap(t => [`lifttrace_rest_v5_${t}_vibe`, `lifttrace_rest_v5_${t}_quiet`]),
    ];
    for (const id of stale) {
      try { await LocalNotifications.deleteChannel({ id }); } catch {}
    }

    // Single channel for the visible "Rest complete" message at zero.
    // Silent — the actual sound + haptic cues come from the
    // RestTimerCue plugin running BroadcastReceivers, so this
    // notification is purely the "look up at your phone" text.
    try {
      await LocalNotifications.createChannel({
        id:          REST_TIMER_CHANNEL_FINISH,
        name:        'Rest timer',
        description: 'Tells you when your rest period is over.',
        importance:  4, visibility: 1,
        vibration:   false,
        sound:       null,
      });
    } catch (e) {
      console.warn(`[restTimer] createChannel ${REST_TIMER_CHANNEL_FINISH} failed:`, e?.message || e);
    }
    await LocalNotifications.requestPermissions().catch(() => {});
    _nativeNotifReady = true;
  } catch (e) {
    console.warn('[restTimer] _ensureNativeNotifReady failed:', e?.message || e);
  }
}

/**
 * The rest's sound and buzz as the plugin arms them, ending at T, from the
 * account's settings; null when both are off. Kept by the plugin too, so the
 * notification's Resume and +30s can put them back with the app closed.
 */
function _cuePlan(state, T) {
  const wantTone = get(restAlertTone);
  const wantVibe = get(restAlertVibrate);
  if (!wantTone && !wantVibe) return null; // nothing to fire

  const toneId = get(restAlertToneId) || 'classic';
  const tone   = getTone(toneId);
  const hasCountdown = !!(tone.countdown && tone.countdown(3));
  // Settings > Workout, Play Through Do Not Disturb: the cue as an alarm.
  const alarm = get(restAlertOutput) === 'alarm';

  // Build the cue list. The audio cue is ONE entry that plays the full
  // pre-rendered 3-2-1-finale WAV (lt_tone_<id>.wav, see
  // scripts/build-rest-tones.mjs); it fires at endTime-3s for tones
  // with countdown, endTime for minimal-style tones. Vibration cues
  // are independent per-tick haptics aligned with the audio beeps.
  //
  // The whole batch goes over, past entries included: the plugin skips
  // those, and keeps the batch so the notification's Pause, Resume and +30s
  // can put it back against a new end with the app closed.
  const cues = [];
  if (wantTone) {
    const soundFireAt = hasCountdown ? T - 3000 : T;
    cues.push({ at: soundFireAt, sound: `lt_tone_${toneId}`, vibrate: false, finale: false, alarm });
  }
  if (wantVibe) {
    // Mirror the v4 cadence: a buzz on each beep + a finale double-pulse
    // at zero so "0" feels distinct from the countdown.
    const tickOffsets = hasCountdown ? [-3000, -2000, -1000] : [];
    for (const offset of tickOffsets) {
      cues.push({ at: T + offset, sound: '', vibrate: true, finale: false, alarm });
    }
  }

  // The message at zero, and the finale buzz, ride on one cue. The
  // receiver posts it local-only, so it stays in this phone's shade: Wear
  // mirrors a phone's notifications to the watch by default, and the watch
  // app runs its own rest with its own alarm and its own words. Two copies
  // of the same fact, one of them unlabelled, is how a buzz on a wrist
  // becomes a mystery.
  const body = state.exerciseName ? `Ready for your next ${state.exerciseName} set` : 'Back to work!';
  cues.push({
    at: T, sound: '', vibrate: wantVibe, finale: true, alarm,
    title: 'Rest complete', body,
    // Mirrored to the watch only when the watch does not have the rest
    // itself. When it does, it rings with its own alarm and its own
    // words, and a second unlabelled copy of this is the thing that made
    // a buzz on the wrist unaccountable.
    localOnly: _onWatch,
  });
  return { cues, body };
}

async function _scheduleNativeFinish(state) {
  if (!isNative || !state) return;
  // Settle the question of whether the watch has this rest before deciding
  // whether the notification is allowed to reach it.
  try { await _telling; } catch { /* answered as "no watch" already */ }
  await _ensureNativeNotifReady();
  try {
    // Cancel any previously-scheduled rest-timer artifacts from older
    // versions or a re-armed timer. v4 used ids 9001-9005 for audio +
    // tick notifications; we still clean those up so leftover scheduled
    // alarms from a pre-upgrade install don't fire alongside the new
    // plugin-driven cues.
    await LocalNotifications.cancel({
      notifications: [
        { id: REST_TIMER_AUDIO_ID },
        { id: 9002 }, { id: 9003 }, { id: 9004 }, { id: 9005 },
      ],
    }).catch(() => {});
    const { scheduleCues, cancelCues, isCuePluginAvailable } = await import('../lib/rest-cue.js');
    // Paused, skipped or moved while the lines above were waiting (by the
    // notification's buttons, say): this batch is for a deadline that no
    // longer exists, and whoever moved the rest has armed its own.
    const stale = (cur) => !cur || cur.paused || cur.endTime !== state.endTime;
    if (stale(get(restTimer))) return;
    // Always cancel previous cues — handles the "user pressed add 30s
    // mid-countdown" case where we re-schedule a fresh batch.
    await cancelCues();
    // Moved while cancelling: what was cancelled may have been armed for the
    // new deadline, so arm for the rest as it now is.
    const current = get(restTimer);
    if (stale(current)) {
      if (current && !current.paused && document.visibilityState === 'hidden') return _scheduleNativeFinish(current);
      return;
    }

    const plan = _cuePlan(state, state.endTime);
    if (!plan) return; // nothing to fire
    const { cues, body } = plan;
    const T = state.endTime;
    const fireAt = new Date(T);
    const notifications = [{
      id:        REST_TIMER_AUDIO_ID,
      title:     'Rest complete',
      body,
      smallIcon: 'ic_stat_icon_config_sample',
      group:     'rest-timer',
      channelId: REST_TIMER_CHANNEL_FINISH,
      sound:     null,
      schedule:  { at: fireAt, allowWhileIdle: true },
    }];

    if (cues.length && isCuePluginAvailable()) {
      const r = await scheduleCues(cues, T);
      console.log(`[restTimer] cue plugin scheduled ${r.scheduled}/${cues.length} broadcasts`);
      // The finale cue carries the message, so there is nothing left for
      // LocalNotifications to post. That is the point: what it posts cannot
      // be marked local-only, and so it mirrors to the watch.
      return;
    } else if (cues.length && !isCuePluginAvailable()) {
      // Plugin unavailable (PWA / older build) — there's no clean way to
      // fire audio without a notification, so log + skip the per-beep
      // cues. The user still gets the at-zero notification.
      console.warn('[restTimer] RestTimerCue plugin unavailable — skipping countdown audio/vibration cues');
    }
    console.log(`[restTimer] scheduling finish notification at ${fireAt.toISOString()}`);
    await LocalNotifications.schedule({ notifications });
    // Sanity-check the schedule actually landed — getPending returns the
    // current queue. If the notification we just scheduled isn't in it,
    // something silently rejected it.
    try {
      const pending = await LocalNotifications.getPending();
      const found = (pending?.notifications || []).find(n => n.id === REST_TIMER_AUDIO_ID);
      console.log(`[restTimer] schedule OK pending=${pending?.notifications?.length ?? 0} ours=${!!found}`);
    } catch {}
  } catch (e) {
    console.warn('[restTimer] _scheduleNativeFinish failed:', e?.message || e);
  }
}

async function _cancelNativeFinish() {
  if (!isNative) return;
  try {
    // Cancel both the visible "Rest complete" notification AND any
    // RestTimerCue alarm broadcasts that haven't fired yet (e.g. user
    // skipped to the next set mid-countdown). Ids 9002-9005 are v4-era
    // tick notifications — kept in the cancel list so a pre-upgrade
    // install with leftovers gets cleaned up.
    await LocalNotifications.cancel({
      notifications: [
        { id: REST_TIMER_AUDIO_ID },
        { id: 9002 }, { id: 9003 }, { id: 9004 }, { id: 9005 },
      ],
    });
    const { cancelCues } = await import('../lib/rest-cue.js');
    await cancelCues();
  } catch (e) {
    console.warn('[restTimer] _cancelNativeFinish failed:', e?.message || e);
  }
}

async function _bgCountdownNotify(n) {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.showNotification) return;
    // Tag + renotify=false so successive 3/2/1 replace each other instead
    // of stacking. Silent stays true — the OS just vibrates per the pattern.
    // Audible "Rest complete" comes at 0 via _finish().
    await reg.showNotification(`Rest: ${n}`, {
      tag: 'rest-timer-countdown',
      silent: true,
      vibrate: get(restAlertVibrate) ? [40] : [],
      renotify: false,
      requireInteraction: false,
    });
    // Auto-dismiss after a short while so a stale "Rest: 1" doesn't linger
    // on the lock screen after the rest finishes.
    setTimeout(() => {
      reg.getNotifications({ tag: 'rest-timer-countdown' })
        .then(ns => ns.forEach(nn => nn.close()))
        .catch(() => {});
    }, 1500);
  } catch {}
}

async function _finish() {
  const state = get(restTimer);
  // A paused rest has no zero to reach (its beeps were cleared on pausing).
  if (state?.paused) return;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

  if (hidden) {
    // PWA path: service worker notification (no-op on Capacitor since the
    // SW is unregistered there — but the LocalNotification scheduled at
    // startRest fires from the OS regardless, so the user still gets
    // sound + vibration on Android even though we don't run code here).
    try {
      if (!isNative && 'serviceWorker' in navigator && 'Notification' in window) {
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission === 'granted') {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg?.showNotification) {
            reg.showNotification('Rest complete', {
              body: state?.exerciseName ? `Ready for your next ${state.exerciseName} set` : 'Back to work!',
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
              tag: 'rest-timer',
              vibrate: get(restAlertVibrate) ? [180, 80, 180, 80, 220] : [],
              silent: !get(restAlertTone),
              renotify: true,
            });
          }
        }
      }
    } catch {}
  } else {
    // Foreground: cancel the scheduled OS notification (if any) so the
    // user doesn't get a duplicate cue, then play the in-app finale.
    _cancelNativeFinish();
    if (get(restAlertTone)) _playPresetFinale();
    if (get(restAlertVibrate)) _vibrate([180, 80, 180]);
  }

  // Linger briefly so 0:00 flashes, then clear in-app state. Pass
  // _keepNativeNotif so we don't cancel the OS notification that just
  // fired — when the app is backgrounded the WebView often resumes
  // briefly when the alarm fires (notification posted, sound + vibrate
  // playing), and an indiscriminate cancel here would dismiss the
  // notification before the user even sees it. Manual stop / skip-set
  // paths still cancel as normal.
  setTimeout(() => stopRest(false, { keepNativeNotif: true }), 700);
}

// ── Tick loop (for UI updates only, NOT authoritative) ─────────────────────
function _startTick() {
  _stopTick();
  _tickInterval = setInterval(_tick, 250);
  _tick();
}
function _stopTick() {
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}
function _tick() {
  const state = get(restTimer);
  if (!state) { restRemaining.set(0); return; }
  const remaining = restLeftMs(state) / 1000;
  restRemaining.set(remaining);
  // Paused: the number holds, so there is nothing to tick.
  if (state.paused || remaining <= 0) _stopTick();
}

// ── The wrist ──────────────────────────────────────────────────────────────
/**
 * A rest is one thing happening to one person, so both devices hold it and
 * either can ring. Whichever spoke last is the one that counts.
 *
 * Only while the watch app is in use: `publishRest` checks that itself, and
 * says whether the watch actually took it. That answer also decides whether
 * this phone's own notification may mirror across, since a watch that has
 * the rest will say so in its own words and does not need a second copy.
 */
const REST_AT = 'lt:rest-at';
let _onWatch = false;

function _restStamp() {
  try { return Number(localStorage.getItem(REST_AT) || 0) || 0; } catch { return 0; }
}
function _restStamped(at) {
  try { localStorage.setItem(REST_AT, String(at)); } catch {}
}

let _telling = null;
let _shading = null;
// The watch holds this rest paused (it took the pause, or paused it itself).
let _watchPaused = false;
function _tellWatch(state) {
  if (!isNative) return;
  const at = Date.now();
  // A watch that took this rest's pause hears how it ends even once it has
  // gone half an hour unopened, or it would show "Paused" for good.
  const force = _onWatch && _watchPaused;
  _restStamped(at);
  // The notification is told first, with the same stamp, so that when this
  // phone hears its own write to the watch come back (RestWearListener) it
  // is already the word it holds and changes nothing.
  _shading = _shade(state, at);
  // Kept, because whether the watch took it is what decides if this phone's
  // own notification may mirror across, and the notification is scheduled in
  // the same breath as the send. Reading _onWatch before this settles would
  // mean the first rest of a session always mirrored, which is the double
  // buzz this is here to stop.
  _telling = Promise.resolve(_shading)
    .then(() => import('../lib/wear-pairing.js'))
    .then(({ publishRest }) => publishRest(state, at, { force }))
    .then(took => {
      _onWatch = !!took;
      _watchPaused = _onWatch && !!state?.paused;
      // The notification's buttons follow the same rule with the app closed.
      import('../lib/rest-cue.js').then(({ restOnWatch }) => restOnWatch(at, _onWatch)).catch(() => {});
      return _onWatch;
    })
    .catch(() => { _onWatch = false; return false; });
}

// ── The shade (Android) ────────────────────────────────────────────────────
/**
 * The rest in the notification shade and on the lock screen, in this app's
 * words. Everything it says is worked out here, translated, because its
 * buttons act with no web layer to ask (RestShade.java).
 */
function _accent() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  } catch {}
  return '#FF7433';
}

async function _shade(state, at = _restStamp(), { wordsOnly = false } = {}) {
  if (!isNative) return;
  try {
    const { showRest, hideRest } = await import('../lib/rest-cue.js');
    if (!state) { await hideRest(at); return; }
    const t = get(_);
    const fallbackTitle = state.exerciseName
      ? t('rest_bar.next', { values: { name: state.exerciseName } })
      : t('rest_bar.title');
    const end = state.paused ? Date.now() + restLeftMs(state) : Number(state.endTime) || 0;
    const plan = _cuePlan(state, end);
    const { title, text } = restNoticeText(state.next, {
      unit: get(weightUnit), last: state.next?.last || '', t, fallbackTitle,
    });
    await showRest({
      paused: !!state.paused,
      endsAt: Number(state.endTime) || 0,
      leftMs: restLeftMs(state),
      total: Number(state.total) || 0,
      startedAt: Number(state.startedAt) || 0,
      at,
      date: String(state.date || ''),
      label: String(state.exerciseName || ''),
      title, text, fallbackTitle,
      skip: t('rest_bar.skip'),
      add: t('rest_bar.add', { values: { s: REST_ADD_SEC } }),
      pause: t('rest_bar.pause'),
      resume: t('rest_bar.resume'),
      // The time goes in on the phone, when it is paused: "{time}" is kept.
      pausedText: t('rest_bar.paused_left', { values: { time: '{time}' } }),
      pausedChip: t('rest_bar.paused'),
      addSec: REST_ADD_SEC,
      accent: _accent(),
      // The sound and buzz for this rest, kept by the plugin so that Resume
      // and +30s on the notification can arm them with the app closed.
      cues: plan ? plan.cues : [],
      cuesEnd: end,
      // A rest taken up from the notification or the watch, with no next set
      // known here: the notification keeps the words it already had for it.
      keepWords: !state.next,
      // Only the words changed (last time arrived): nothing about the rest.
      wordsOnly,
    });
  } catch (e) {
    console.warn('[restTimer] shade failed:', e?.message || e);
  }
}

/**
 * Take a rest that the watch or this phone's notification changed. Their
 * stamp becomes ours, nothing is sent back (that would be an echo, and its
 * newer stamp would beat whatever either device does next), and the native
 * cues are left alone: whoever made the change has already moved them.
 */
function _adopt(theirs, at, { fromNative = false } = {}) {
  _restStamped(at);
  const r = restFromWire(theirs, Date.now(), get(restTimer));
  if (!r) return;
  // Said by the watch: it has the rest, in whatever state it said.
  if (!fromNative) {
    _onWatch = true;
    _watchPaused = !r.stop && !!r.state?.paused;
  }
  if (r.stop) {
    if (get(restTimer)) stopRest(false, { fromWatch: true });
    else if (!fromNative) _shade(null, at);
    return;
  }
  const state = r.state;
  restTimer.set(state);
  _persist(state);
  if (state.paused) {
    _clearBeeps();
    _stopTick();
    restRemaining.set(restLeftMs(state) / 1000);
  } else {
    _scheduleBeeps(state.endTime);
    _startTick();
  }
  // The notification follows what the watch said; one that said it itself
  // already shows it.
  if (!fromNative) _shade(state, at);
}

function _fromNative(rec) {
  if (!rec || !(Number(rec.at) > _restStamp())) return false;
  _adopt({
    cleared: !rec.active,
    paused: !!rec.active && !!rec.paused,
    leftMs: Number(rec.leftMs) || 0,
    endsAt: Number(rec.endsAt) || 0,
    total: Number(rec.total) || 0,
    label: String(rec.label || ''),
    // Which rest, and its day: for a swipe-away to keep holding, and for
    // the notification to open the right workout.
    startedAt: Number(rec.startedAt) || 0,
    date: String(rec.date || ''),
  }, Number(rec.at), { fromNative: true });
  return true;
}

/** What the notification's buttons did while this app was not looking. */
async function _syncNative() {
  if (!isNative) return false;
  const { nativeRest } = await import('../lib/rest-cue.js');
  return _fromNative(await nativeRest());
}

/**
 * The watch started, extended, paused or skipped a rest, or this phone's
 * notification did. Take the word if it is newer than ours. Called when the
 * app comes back to the front, which is before anyone can press anything here.
 */
export async function syncRest() {
  if (!isNative) return false;
  let changed = false;
  try { changed = await _syncNative(); } catch {}
  const { readRest } = await import('../lib/wear-pairing.js');
  const theirs = await readRest(_restStamp());
  if (!theirs) return changed;
  _adopt(theirs, theirs.at);
  return true;
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Start a rest. `next` is what is lifted after it (src/lib/rest-next.js),
 * for the notification; `date` is the diary day, for opening it from there.
 * Returns the rest, or null when none was started.
 */
export function startRest({ exerciseId, exerciseName, durationSec, date, next } = {}) {
  // Prefer per-exercise memory if caller didn't specify
  let total = durationSec;
  if (total == null && exerciseId != null) {
    const memory = get(restPerExercise) || {};
    if (memory[exerciseId]) total = memory[exerciseId];
  }
  if (total == null || total <= 0) return null;
  if (!get(restAlert)) return null;

  // startRest is called from a user gesture (set checkbox tap), the
  // ONLY context where browsers will actually show the Notification
  // permission prompt. Requesting it later from inside _finish's
  // setTimeout silently fails on Chrome / Safari because that callback
  // isn't a user gesture, which is why backgrounded rest cues never
  // alerted on the PWA. Fire-and-forget; the result drives _finish's
  // showNotification gate next time the timer hits zero.
  _ensureNotifyPermission();
  // Android: the rest's own notification needs the same permission, and
  // now, with the app in front, is when asking can be answered.
  if (isNative) _ensureNativeNotifReady();

  const now = Date.now();
  const state = {
    startedAt: now,
    endTime:   now + total * 1000,
    total,
    exerciseId: exerciseId ?? null,
    exerciseName: exerciseName || '',
    date: date || '',
    next: next || null,
  };
  restTimer.set(state);
  _persist(state);
  _scheduleBeeps(state.endTime);
  _tellWatch(state);
  // Only arm the OS notification if the user is already backgrounded,
  // otherwise the in-app Web Audio path handles cues and an OS schedule
  // would double up at -3s. The visibilitychange handler at the bottom of
  // this file re-arms the OS schedule if the user backgrounds mid-timer.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    _scheduleNativeFinish(state);
  }
  _startTick();
  return state;
}

/**
 * What you did on the next set last time, found after the rest started (it
 * needs the exercise's history). Only for the rest it was looked up for.
 */
export function noteRestLastTime(startedAt, last) {
  const state = get(restTimer);
  if (!state || !last || state.startedAt !== startedAt || !state.next) return;
  const next = { ...state, next: { ...state.next, last } };
  restTimer.set(next);
  _persist(next);
  // The same rest in more words: not a change to it, so no new stamp, and
  // only the words go over (a button pressed meanwhile is not undone).
  _shade(next, _restStamp(), { wordsOnly: true });
}

function _ensureNotifyPermission() {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
  } catch {}
}

export function addRestTime(extraSec = REST_ADD_SEC) {
  const state = get(restTimer);
  if (!state) return;
  const next = extendedRest(state, extraSec);
  restTimer.set(next);
  _persist(next);
  _tellWatch(next);
  if (next.paused) {
    restRemaining.set(restLeftMs(next) / 1000);
    return;
  }
  _scheduleBeeps(next.endTime);
  // As at the start: the OS cues only while the app is in the background,
  // or they play over the app's own countdown.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    _scheduleNativeFinish(next);
  }
  _tick();
}

/** Hold the rest where it is. Nothing counts or rings until it is resumed. */
export function pauseRest() {
  const state = get(restTimer);
  if (!state || state.paused) return;
  const next = pausedRest(state);
  if (restLeftMs(next) <= 0) return;
  restTimer.set(next);
  _persist(next);
  _clearBeeps();
  _stopTick();
  restRemaining.set(restLeftMs(next) / 1000);
  // The OS cues are for a deadline that no longer exists.
  _cancelNativeFinish();
  _tellWatch(next);
}

/** Count on from what was left. */
export function resumeRest() {
  const state = get(restTimer);
  if (!state || !state.paused) return;
  const next = resumedRest(state);
  if (next.endTime <= Date.now()) { stopRest(false); return; }
  restTimer.set(next);
  _persist(next);
  _scheduleBeeps(next.endTime);
  _tellWatch(next);
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    _scheduleNativeFinish(next);
  }
  _startTick();
}

export function stopRest(rememberIfFull = true, opts = {}) {
  const { keepNativeNotif = false, fromWatch = false } = opts;
  const state = get(restTimer);
  // Write back per-exercise memory on natural finish (or skip > 0 remaining)
  if (rememberIfFull && state && state.exerciseId != null && state.total > 0) {
    const memory = get(restPerExercise) || {};
    if (memory[state.exerciseId] !== state.total) {
      restPerExercise.set({ ...memory, [state.exerciseId]: state.total });
    }
  }
  restTimer.set(null);
  restRemaining.set(0);
  _persist(null);
  _clearBeeps();
  if (!keepNativeNotif) _cancelNativeFinish();
  // Not back to the watch when the watch is the one that said so: that is an
  // echo, and the newer stamp on it would beat the next thing either device
  // actually does.
  if (!fromWatch) _tellWatch(null);
  // The rest's own notification goes either way; "Rest complete" (kept by
  // keepNativeNotif) is a different one.
  else _shade(null);
  _stopTick();
}

// ── Boot: rehydrate a running timer on page load ───────────────────────────
if (typeof window !== 'undefined') {
  const resumed = _load();
  if (resumed) {
    restTimer.set(resumed);
    if (resumed.paused) restRemaining.set(restLeftMs(resumed) / 1000);
    else {
      _scheduleBeeps(resumed.endTime);
      _startTick();
    }
  }

  if (isNative) {
    // The notification's buttons (and the watch) may have changed the rest
    // with this app closed: take that first, then put the notification and
    // the cues back for whatever the rest now is (a force-stop takes both).
    (async () => {
      let rec = null;
      try {
        await _syncNative();
        rec = await (await import('../lib/rest-cue.js')).nativeRest();
      } catch {}
      const state = get(restTimer);
      if (!state) return;
      // Its own record already has this rest (the same word, or a newer one
      // just taken): put it back as it was, words and swipe-away included.
      if (rec && rec.active && rec.at >= _restStamp()) {
        import('../lib/rest-cue.js').then(({ repostRest }) => repostRest()).catch(() => {});
      } else {
        _shade(state);
      }
      // Only from the background, as everywhere else: in front, the app
      // plays the countdown itself and an OS batch would double it.
      if (!state.paused && document.visibilityState === 'hidden') _scheduleNativeFinish(state);
    })();
    import('../lib/rest-cue.js').then(({ onNativeRest }) => onNativeRest(_fromNative)).catch(() => {});
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      // Whatever the notification's buttons did while the app was away
      // comes first, so the countdown below is for the rest as it now is.
      if (isNative) { try { await _syncNative(); } catch {} }
      const state = get(restTimer);
      if (!state) return;
      _tick();
      if (state.paused) return;
      // Foregrounded: catch up on missed ticks, re-issue any beeps the
      // browser dropped while throttled, and cancel the OS notification:
      // the in-app Web Audio path will fire the countdown + finale now
      // that the WebView is awake again.
      _scheduleBeeps(state.endTime);
      _cancelNativeFinish();
    } else {
      const state = get(restTimer);
      if (!state || state.paused) return;
      // Backgrounded: arm the OS notification so the bundled tone audio
      // (3-2-1-finale) plays without the WebView. Foreground in-app cues
      // won't fire from setTimeout callbacks while suspended anyway.
      _scheduleNativeFinish(state);
    }
  });
}
