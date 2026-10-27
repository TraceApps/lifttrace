import { DB } from './db.js';
import { isNative, getServerUrl } from './platform.js';
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
 * Push services (Apprise / Gotify / ntfy) go through the server
 * (/api/notify) on the web and on Android signed in to a server with
 * accounts. Android otherwise (on its own, a server without accounts, or a
 * server it can't reach just then) sends them itself through CapacitorHttp.
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
    if (_serverSends() && await _serverPush(title, body, priority)) return;
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

// Android signed in to a server with accounts: the server sends it, as it
// does for the web app, from the settings it keeps for the account. It
// reaches a push service on the home network, which a release build of the
// app can't (it only goes to https:// itself). Without accounts the server
// keeps no settings, so the phone sends it.
function _serverSends() {
  try {
    return !!getServerUrl() && localStorage.getItem('lt:userMgmt') === '1' && !!localStorage.getItem('wl:userId');
  } catch { return false; }
}

// Whether the server took it. Not reached (no connection, the server down,
// the session over): the phone sends it itself. Never queued for later
// (apiFetch.js needsServerNow).
async function _serverPush(title, body, priority) {
  try {
    const res = await fetch('/api/notify', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, priority }),
    });
    return res.ok;
  } catch { return false; }
}

async function _nativePush(service, title, body, priority) {
  const req = nativePushRequest(service, key => DB.getSetting(key, ''), title, body, priority);
  if (!req) return;
  const { NativeHttp } = await import('./native-http.js');
  const res = await NativeHttp.post(req);
  if (res?.status < 200 || res?.status >= 300) _dlog(`[notifications] ${service} push answered ${res.status}`);
}

// A header value as plain ASCII: ntfy reads RFC 2047 (=?UTF-8?B?...?=), as
// the server sends it (server/lib/push-notify.js).
function _asciiHeader(v) {
  const s = String(v);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

// The service's address without a trailing slash, query or fragment, as the
// server takes it (serviceBase in server/lib/ssrf-guard.js).
function _serviceBase(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch { /* as typed */ }
  return String(url).trim().replace(/\/+$/, '');
}

/**
 * The CapacitorHttp request for a push through the person's service, or null
 * when it isn't set up. `setting(key)` reads a setting by the names Settings,
 * Notifications saves them under (stores/settings.js), the same ones the
 * server reads; the phone read others (notifNtfyUrl and so on), never saved,
 * so its own pushes never went. It's the request the server sends (the same
 * address, token, body and priority), except that the server puts the app's
 * name in front of the title. Capacitor sends no body at all without a
 * Content-Type, so ntfy's says it's text.
 */
export function nativePushRequest(service, setting, title, body, priority = 5) {
  if (service === 'gotify') {
    const url = setting('gotifyUrl');
    const token = setting('gotifyToken');
    if (!url || !token) return null;
    return {
      url: `${_serviceBase(url)}/message?token=${encodeURIComponent(token)}`,
      headers: { 'Content-Type': 'application/json' },
      data: { title, message: body, priority },
    };
  }
  if (service === 'ntfy') {
    const url = setting('ntfyUrl') || 'https://ntfy.sh';
    const topic = setting('ntfyTopic');
    const token = setting('ntfyToken');
    if (!topic) return null;
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Title': _asciiHeader(title), 'Priority': String(Math.min(5, priority)) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return { url: `${_serviceBase(url)}/${encodeURIComponent(topic)}`, headers, data: body };
  }
  if (service === 'apprise') {
    const url = setting('appriseUrl');
    const tag = setting('appriseTag');
    if (!url) return null;
    const data = { title, body, type: priority >= 7 ? 'warning' : 'info' };
    if (tag) data.tag = tag;
    return { url: `${_serviceBase(url)}/notify`, headers: { 'Content-Type': 'application/json' }, data };
  }
  return null;
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
  // Worded as the server words it for a workout finished on the watch
  // (server/lib/watch-finish.js).
  notify('💪 Workout Complete!', workoutName ? `Great session. "${workoutName}" is done!` : 'Great session. All sets complete!', 5);
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

/**
 * Longest-hold PR on a timed exercise (issue #89). Kept apart from
 * celebratePR because that one dedupes on weight, and most holds have none:
 * a longer bodyweight plank would never beat a stored 0.
 */
export function celebrateHoldPR(exerciseName, durationSec, weight, unit) {
  const key = `lt:prHoldCelebrated:${exerciseName}:${new Date().toDateString()}`;
  const last = parseFloat(localStorage.getItem(key) || '0');
  if (durationSec <= last) return;
  const enabled = DB.getSetting('notifPRCelebrations', true);
  if (!enabled) return;
  localStorage.setItem(key, String(durationSec));
  const m = Math.floor(durationSec / 60);
  const s = String(durationSec % 60).padStart(2, '0');
  const body = weight > 0
    ? `${exerciseName}: ${m}:${s} @ ${weight} ${unit}`
    : `${exerciseName}: ${m}:${s}`;
  notify('🏆 New Hold PR!', body, 5);
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

    // Setting names and defaults have to match the ones the settings layer
    // actually stores (src/stores/settings.js, and the same keys the server
    // scheduler reads), or every reminder here silently falls back to its
    // default and the times chosen in Settings, Notifications never apply.
    const out = [];
    if (DB.getSetting('notifWorkoutReminder', false)) {
      const time = DB.getSetting('notifWorkoutTime', '07:00');
      out.push(_dailyAt(REMINDER_IDS.workout, '🏋️ Time to Train', 'Open LiftTrace and crush today\'s workout.', time));
    }
    if (DB.getSetting('notifStreakAlert', false)) {
      const time = DB.getSetting('notifStreakTime', '20:00');
      out.push(_dailyAt(REMINDER_IDS.streakAtRisk, '🔥 Streak at Risk', 'Don\'t break your streak — log a quick session.', time));
    }
    if (DB.getSetting('notifRestDay', false)) {
      // No rest-day time in Settings: the server fires this one at a fixed
      // hour too, so the device keeps its own fixed hour.
      out.push(_dailyAt(REMINDER_IDS.restDay, '🧘 Rest Day', 'Stretch, hydrate, and recover well today.', '09:00'));
    }
    if (DB.getSetting('notifWeeklySummary', false)) {
      const time = DB.getSetting('weeklySummaryTime', '09:00');
      const day  = DB.getSetting('weeklySummaryDay', 0);
      out.push(_weeklyOn(REMINDER_IDS.weeklySummary, '📊 Weekly Summary', 'Check this week\'s training volume + PRs.', time, day));
    }

    if (out.length) await LocalNotifications.schedule({ notifications: out });
    _dlog('[notifications] scheduled', out.length, 'native reminders');
  } catch (e) {
    _dlog('[notifications] schedule failed:', e?.message || e);
  }
}

function _hhmm(hhmm, fallbackHour) {
  const [h, m] = (hhmm || '').split(':').map(Number);
  return { hour: isNaN(h) ? fallbackHour : h, minute: isNaN(m) ? 0 : m };
}

// A schedule carrying `every` never reads `on`: the Android plugin repeats from
// the moment it was scheduled and returns, so the chosen time of day is lost and
// every app start pushes the alarm another interval out. With `on` alone the
// plugin takes its cron path, which re-arms itself at the same clock time after
// each fire.
function _dailyAt(id, title, body, hhmm) {
  return {
    id,
    title,
    body,
    smallIcon: 'ic_stat_icon_config_sample',
    schedule: {
      on: _hhmm(hhmm, 17),
      allowWhileIdle: true,
    },
  };
}

// Weekly summary fires once a week, on the day chosen in Settings. Capacitor
// counts weekdays from 1 = Sunday, while weeklySummaryDay is 0 = Sunday, the
// same numbering the server scheduler compares against Date#getDay().
function _weeklyOn(id, title, body, hhmm, day) {
  const d = Number(day);
  return {
    id,
    title,
    body,
    smallIcon: 'ic_stat_icon_config_sample',
    schedule: {
      on: { weekday: (isNaN(d) ? 0 : ((d % 7) + 7) % 7) + 1, ..._hhmm(hhmm, 9) },
      allowWhileIdle: true,
    },
  };
}

// ── App-update notification ───────────────────────────────────────────────

// Fixed ID for the "update available" notification so re-posts replace
// the previous one instead of stacking. Any bumped version overwrites.
export const UPDATE_NOTIFICATION_ID = 9999;

let _updateChannelCreated = false;
let _updateTapListener = null;

// Silent "App updates" channel — low importance so it lands in the shade
// without sound or heads-up, matching how F-Droid / Play post update
// notices. Separate channel means users can mute updates independently
// from other LiftTrace notifications in Android's per-channel settings.
async function _ensureUpdateChannel() {
  if (_updateChannelCreated || !isNative) return;
  try {
    await LocalNotifications.createChannel({
      id: 'lifttrace-updates',
      name: 'App updates',
      description: 'Notifies you when a new app version is available.',
      importance: 2, // LOW: no sound, no vibration, no heads-up
      visibility: 1, // PUBLIC
    });
    _updateChannelCreated = true;
  } catch (e) {
    console.warn('[notifications] update channel creation failed:', e.message);
  }
}

/** True when the OS-level notification permission is currently granted. */
export async function isUpdateNotificationPermissionGranted() {
  if (!isNative) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    return perm.display === 'granted';
  } catch { return false; }
}

/**
 * Post a silent "update available" notification. Uses the low-importance
 * `lifttrace-updates` channel so it lands in the shade without sound or
 * heads-up popup. Tapping the notification is handled by
 * `registerUpdateTapListener` — decoupled so the tap handler can navigate
 * the app without this module needing to know about routing.
 *
 * Returns true if the notification was posted, false otherwise (native
 * missing, permission denied, etc.). Silent-on-failure — the in-app
 * banner is the fallback.
 */
export async function showUpdateNotification(latest) {
  if (!isNative || !latest?.version) return false;
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') return false;
  await _ensureUpdateChannel();
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: UPDATE_NOTIFICATION_ID,
        channelId: 'lifttrace-updates',
        title: 'LiftTrace update available',
        body: `${latest.version} is ready. Tap to install.`,
        extra: { version: latest.version, notesUrl: latest.notesUrl || '' },
      }],
    });
    _dlog(`[notifications] update notification posted for ${latest.version}`);
    return true;
  } catch (e) {
    console.warn('[notifications] update notification failed:', e?.message || e);
    return false;
  }
}

/** Clear a previously-posted update notification (e.g. after user installs). */
export async function cancelUpdateNotification() {
  if (!isNative) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: UPDATE_NOTIFICATION_ID }] });
  } catch { /* silent */ }
}

/**
 * Register a one-time listener for taps on the update notification.
 * `handler` receives { version, notesUrl } and is expected to route into
 * the install flow. Safe to call multiple times — subsequent calls no-op
 * so App.svelte can defensively register on every mount.
 */
export async function registerUpdateTapListener(handler) {
  if (!isNative || _updateTapListener) return;
  try {
    _updateTapListener = await LocalNotifications.addListener('localNotificationActionPerformed', ev => {
      if (ev?.notification?.id !== UPDATE_NOTIFICATION_ID) return;
      const extra = ev.notification.extra || {};
      try { handler({ version: extra.version || '', notesUrl: extra.notesUrl || '' }); }
      catch (e) { console.warn('[notifications] update tap handler threw:', e); }
    });
    _dlog('[notifications] update tap listener registered');
  } catch (e) {
    console.warn('[notifications] failed to register update tap listener:', e?.message || e);
  }
}
