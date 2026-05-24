import { writable, get } from 'svelte/store';
import { restAlert, restAlertVibrate, restAlertTone, restAlertToneId, restPerExercise } from './settings.js';
import { getTone } from '../lib/restTones.js';
import { isNative } from '../lib/platform.js';
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
    if (!state || !state.endTime) return null;
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

async function _scheduleNativeFinish(state) {
  if (!isNative || !state) return;
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
    // Always cancel previous cues — handles the "user pressed add 30s
    // mid-countdown" case where we re-schedule a fresh batch.
    await cancelCues();

    const wantTone = get(restAlertTone);
    const wantVibe = get(restAlertVibrate);
    if (!wantTone && !wantVibe) return; // nothing to fire

    const toneId = get(restAlertToneId) || 'classic';
    const tone   = getTone(toneId);
    const hasCountdown = !!(tone.countdown && tone.countdown(3));
    const T = state.endTime;

    // Build the cue list. The audio cue is ONE entry that plays the full
    // pre-rendered 3-2-1-finale WAV (lt_tone_<id>.wav, see
    // scripts/build-rest-tones.mjs); it fires at endTime-3s for tones
    // with countdown, endTime for minimal-style tones. Vibration cues
    // are independent per-tick haptics aligned with the audio beeps.
    const cues = [];
    if (wantTone) {
      const soundFireAt = hasCountdown ? T - 3000 : T;
      if (soundFireAt > Date.now()) {
        cues.push({ at: soundFireAt, sound: `lt_tone_${toneId}`, vibrate: false, finale: false });
      }
    }
    if (wantVibe) {
      // Mirror the v4 cadence: a buzz on each beep + a finale double-pulse
      // at zero so "0" feels distinct from the countdown.
      const tickOffsets = hasCountdown ? [-3000, -2000, -1000] : [];
      for (const offset of tickOffsets) {
        const at = T + offset;
        if (at > Date.now()) cues.push({ at, sound: '', vibrate: true, finale: false });
      }
      if (T > Date.now()) cues.push({ at: T, sound: '', vibrate: true, finale: true });
    }

    // Schedule a SILENT visible notification at zero for the "look at
    // your phone, you're done" cue. Sound + vibration handled by the
    // plugin's broadcasts above; this notification adds nothing audible
    // and just surfaces the message in the shade.
    const body = state.exerciseName ? `Ready for your next ${state.exerciseName} set` : 'Back to work!';
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
      const r = await scheduleCues(cues);
      console.log(`[restTimer] cue plugin scheduled ${r.scheduled}/${cues.length} broadcasts`);
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

// ── Tick loop (for UI updates only — NOT authoritative) ────────────────────
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
  const remaining = Math.max(0, (state.endTime - Date.now()) / 1000);
  restRemaining.set(remaining);
  if (remaining <= 0) _stopTick();
}

// ── Public API ─────────────────────────────────────────────────────────────
export function startRest({ exerciseId, exerciseName, durationSec } = {}) {
  // Prefer per-exercise memory if caller didn't specify
  let total = durationSec;
  if (total == null && exerciseId != null) {
    const memory = get(restPerExercise) || {};
    if (memory[exerciseId]) total = memory[exerciseId];
  }
  if (total == null || total <= 0) return;
  if (!get(restAlert)) return;

  // startRest is called from a user gesture (set checkbox tap) — the
  // ONLY context where browsers will actually show the Notification
  // permission prompt. Requesting it later from inside _finish's
  // setTimeout silently fails on Chrome / Safari because that callback
  // isn't a user gesture, which is why backgrounded rest cues never
  // alerted on the PWA. Fire-and-forget; the result drives _finish's
  // showNotification gate next time the timer hits zero.
  _ensureNotifyPermission();

  const state = {
    startedAt: Date.now(),
    endTime:   Date.now() + total * 1000,
    total,
    exerciseId: exerciseId ?? null,
    exerciseName: exerciseName || '',
  };
  restTimer.set(state);
  _persist(state);
  _scheduleBeeps(state.endTime);
  // Only arm the OS notification if the user is already backgrounded —
  // otherwise the in-app Web Audio path handles cues and an OS schedule
  // would double up at -3s. The visibilitychange handler at the bottom of
  // this file re-arms the OS schedule if the user backgrounds mid-timer.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    _scheduleNativeFinish(state);
  }
  _startTick();
}

function _ensureNotifyPermission() {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
  } catch {}
}

export function addRestTime(extraSec = 30) {
  const state = get(restTimer);
  if (!state) return;
  const next = { ...state, endTime: state.endTime + extraSec * 1000, total: state.total + extraSec };
  restTimer.set(next);
  _persist(next);
  _scheduleBeeps(next.endTime);
  _scheduleNativeFinish(next);
}

export function stopRest(rememberIfFull = true, opts = {}) {
  const { keepNativeNotif = false } = opts;
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
  _stopTick();
}

// ── Boot: rehydrate a running timer on page load ───────────────────────────
if (typeof window !== 'undefined') {
  const resumed = _load();
  if (resumed) {
    restTimer.set(resumed);
    _scheduleBeeps(resumed.endTime);
    // Re-schedule the OS notification too — _ensureNativeNotifReady is
    // idempotent and the scheduler de-dupes by id, so this is safe even
    // if a previous app launch already scheduled the same notification.
    _scheduleNativeFinish(resumed);
    _startTick();
  }

  document.addEventListener('visibilitychange', () => {
    const state = get(restTimer);
    if (!state) return;
    if (document.visibilityState === 'visible') {
      // Foregrounded: catch up on missed ticks, re-issue any beeps the
      // browser dropped while throttled, and cancel the OS notification —
      // the in-app Web Audio path will fire the countdown + finale now
      // that the WebView is awake again.
      _tick();
      _scheduleBeeps(state.endTime);
      _cancelNativeFinish();
    } else {
      // Backgrounded: arm the OS notification so the bundled tone audio
      // (3-2-1-finale) plays without the WebView. Foreground in-app cues
      // won't fire from setTimeout callbacks while suspended anyway.
      _scheduleNativeFinish(state);
    }
  });
}
