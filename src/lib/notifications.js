import { DB } from './db.js';
import { isNative } from './platform.js';
import { LocalNotifications } from '@capacitor/local-notifications';

// Verbose notification logs gated by dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('lt:verboseLogging') === '1') console.log(...a); } catch {} };

/**
 * Client-side notification dispatcher.
 *
 * Handles device notifications via two backends:
 *   - Web Notification API (PWA)
 *   - Capacitor LocalNotifications (Android / iOS)
 *
 * Push services (Apprise / Gotify / ntfy) go through the server proxy on
 * web, but direct via CapacitorHttp on native — the proxy isn't reachable
 * in standalone mode and adds latency in server mode.
 */

// ── Permission ───────────────────────────────────────────────────────────
export async function requestPermission() {
  if (isNative) {
    try {
      const r = await LocalNotifications.requestPermissions();
      return r?.display === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export async function hasPermission() {
  if (isNative) {
    try {
      const r = await LocalNotifications.checkPermissions();
      return r?.display === 'granted';
    } catch { return false; }
  }
  return 'Notification' in window && Notification.permission === 'granted';
}

// ── Show a device notification ────────────────────────────────────────────
export async function showNotification(title, body, id) {
  if (isNative) {
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: typeof id === 'number' ? id : Date.now() % 2_147_483_647,
          title,
          body,
          smallIcon: 'ic_stat_icon_config_sample',
          schedule: { at: new Date(Date.now() + 100) },
        }],
      });
    } catch (e) {
      // Permission not granted, or plugin error — fail silent.
    }
    return;
  }
  if (!await hasPermission()) return;
  try {
    new Notification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `lt-${id || Date.now()}`,
    });
  } catch {}
}

// ── Unified notify: device + push ────────────────────────────────────────
export async function notify(title, body, priority = 5) {
  const localEnabled = DB.getSetting('notifLocalEnabled', true);
  const pushService  = DB.getSetting('notifPushService', 'none');

  if (localEnabled) await showNotification(title, body);

  if (pushService === 'none') return;

  if (isNative) {
    // Direct call to push service from device — no server proxy needed.
    await _nativePush(pushService, title, body, priority).catch(() => {});
  } else {
    try {
      await fetch('/api/notify', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, priority }),
      });
    } catch {}
  }
}

async function _nativePush(service, title, body, priority) {
  const { CapacitorHttp } = await import('@capacitor/core');
  if (service === 'gotify') {
    const url = DB.getSetting('notifGotifyUrl', '');
    const token = DB.getSetting('notifGotifyToken', '');
    if (!url || !token) return;
    await CapacitorHttp.post({
      url: `${url.replace(/\/$/, '')}/message?token=${encodeURIComponent(token)}`,
      headers: { 'Content-Type': 'application/json' },
      data: { title, message: body, priority },
    });
  } else if (service === 'ntfy') {
    const url = DB.getSetting('notifNtfyUrl', '');
    const topic = DB.getSetting('notifNtfyTopic', '');
    if (!url || !topic) return;
    await CapacitorHttp.post({
      url: `${url.replace(/\/$/, '')}/${encodeURIComponent(topic)}`,
      headers: { 'Title': title, 'Priority': String(priority) },
      data: body,
    });
  } else if (service === 'apprise') {
    const url = DB.getSetting('notifAppriseUrl', '');
    const tags = DB.getSetting('notifAppriseTags', '');
    if (!url) return;
    await CapacitorHttp.post({
      url: url.replace(/\/$/, '') + '/notify',
      headers: { 'Content-Type': 'application/json' },
      data: { title, body, tag: tags || undefined, type: 'info' },
    });
  }
}

// ── Goal celebrations (unchanged from web build) ─────────────────────────
const _celebratedToday = new Set(
  (() => { try { return JSON.parse(localStorage.getItem('lt:celebratedToday') || '[]'); } catch { return []; } })()
);

const _lastDate = localStorage.getItem('lt:celebDate') || '';
const _today = new Date().toDateString();
if (_lastDate !== _today) {
  _celebratedToday.clear();
  localStorage.setItem('lt:celebDate', _today);
  localStorage.setItem('lt:celebratedToday', '[]');
}

function _saveCelebrated() {
  localStorage.setItem('lt:celebratedToday', JSON.stringify([..._celebratedToday]));
  localStorage.setItem('lt:celebDate', new Date().toDateString());
}

export function celebrateWorkoutComplete(workoutName) {
  const key = `workout-complete`;
  if (_celebratedToday.has(key)) return;
  const enabled = DB.getSetting('notifWorkoutComplete', true);
  if (!enabled) return;
  _celebratedToday.add(key);
  _saveCelebrated();
  notify('💪 Workout Complete!', workoutName ? `Great session — "${workoutName}" is done!` : 'Great session — all sets complete!', 5);
}

export function celebratePR(exerciseName, weight, unit, reps, type = 'weight') {
  const lastCelebratedKey = `lt:prCelebrated:${exerciseName}:${new Date().toDateString()}`;
  const lastWeight = parseFloat(localStorage.getItem(lastCelebratedKey) || '0');
  if (weight <= lastWeight) return;
  const enabled = DB.getSetting('notifPRCelebrations', true);
  if (!enabled) return;
  localStorage.setItem(lastCelebratedKey, String(weight));

  const title = type === 'e1rm' ? '🏆 New Rep PR!' : '🏆 New Weight PR!';
  const body = reps
    ? `${exerciseName}: ${weight} ${unit} × ${reps}`
    : `${exerciseName}: ${weight} ${unit}`;
  notify(title, body, 5);
}

// ── Daily reminder scheduling (Capacitor LocalNotifications) ─────────────
//
// On native, schedule daily-repeating reminders directly via the OS so they
// fire even when the app is closed. The `_USE_NATIVE_WORKER` kill switch in
// Phase 10 takes over from here once the WorkManager Java bridge is wired
// — until then this is the sole local-reminder source on the device.

const REMINDER_IDS = {
  workout:       1001,
  streakAtRisk:  1002,
  restDay:       1003,
  weeklySummary: 1004,
};

/**
 * Re-schedule all enabled daily reminders. Idempotent — call on app open
 * and after any setting change. Cancels any existing notifications first
 * so toggle-off works correctly.
 */
export async function scheduleNativeReminders() {
  if (!isNative) return;
  // Native WorkManager (Phase 10) is the canonical source when the flag is on.
  const useNative = DB.getSetting('_USE_NATIVE_WORKER', false);
  if (useNative) return;

  try {
    // Drop any previously scheduled instances.
    const ids = Object.values(REMINDER_IDS).map(id => ({ id }));
    try { await LocalNotifications.cancel({ notifications: ids }); } catch {}

    const out = [];
    if (DB.getSetting('notifWorkoutReminder', false)) {
      const time = DB.getSetting('notifWorkoutReminderTime', '17:00');
      out.push(_dailyAt(REMINDER_IDS.workout, '🏋️ Time to Train', 'Open LiftTrace and crush today\'s workout.', time));
    }
    if (DB.getSetting('notifStreakAtRisk', false)) {
      const time = DB.getSetting('notifStreakAtRiskTime', '20:00');
      out.push(_dailyAt(REMINDER_IDS.streakAtRisk, '🔥 Streak at Risk', 'Don\'t break your streak — log a quick session.', time));
    }
    if (DB.getSetting('notifRestDay', false)) {
      const time = DB.getSetting('notifRestDayTime', '09:00');
      out.push(_dailyAt(REMINDER_IDS.restDay, '🧘 Rest Day', 'Stretch, hydrate, and recover well today.', time));
    }
    if (DB.getSetting('notifWeeklySummary', false)) {
      const time = DB.getSetting('notifWeeklySummaryTime', '18:00');
      out.push(_dailyAt(REMINDER_IDS.weeklySummary, '📊 Weekly Summary', 'Check this week\'s training volume + PRs.', time));
    }

    if (out.length) await LocalNotifications.schedule({ notifications: out });
    _dlog('[notifications] scheduled', out.length, 'native reminders');
  } catch (e) {
    _dlog('[notifications] schedule failed:', e?.message || e);
  }
}

function _dailyAt(id, title, body, hhmm) {
  const [h, m] = (hhmm || '17:00').split(':').map(Number);
  return {
    id,
    title,
    body,
    smallIcon: 'ic_stat_icon_config_sample',
    schedule: {
      on: { hour: isNaN(h) ? 17 : h, minute: isNaN(m) ? 0 : m },
      every: 'day',
      allowWhileIdle: true,
    },
  };
}
