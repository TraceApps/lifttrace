/**
 * rest-cue.js — JS wrapper around the RestTimerCue native plugin.
 *
 * Fires audio + vibration cues at scheduled times WITHOUT posting a
 * notification, so the user only sees the single "Rest complete"
 * LocalNotification at zero instead of a stack of countdown rows in the
 * shade. The plugin uses AlarmManager + a custom BroadcastReceiver that
 * plays MediaPlayer with USAGE_NOTIFICATION_EVENT (so music auto-ducks)
 * and the system Vibrator API.
 *
 * Android-only; no-ops on PWA / iOS. Callers should still schedule the
 * final visible LocalNotification themselves for the at-zero message.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

const RestTimerCue = registerPlugin('RestTimerCue');

export function isCuePluginAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('RestTimerCue');
}

/**
 * Schedule a batch of cues. Replaces any previously-scheduled cues.
 *
 * @param {Array<{ at: number, sound?: string | null, vibrate?: boolean, finale?: boolean, alarm?: boolean }>} cues
 *   - at: absolute unix-ms timestamp
 *   - sound: name of a raw resource (e.g. "lt_tone_classic") or null/empty for vibration-only
 *   - vibrate: fire a single ~80ms haptic pulse
 *   - finale: use the finale double-pulse vibration pattern instead of the short one
 *   - alarm: play and buzz as an alarm, so it sounds through Do Not Disturb
 * @param {number} endsAt  the end of the rest these are counted back from
 */
export async function scheduleCues(cues, endsAt = 0) {
  if (!isCuePluginAvailable()) return { scheduled: 0 };
  try {
    // With the end of the rest, so the notification's Pause, Resume and +30s
    // can move these with the app closed.
    return await RestTimerCue.schedule({ cues, endsAt: Number(endsAt) || 0 });
  } catch (e) {
    console.warn('[rest-cue] schedule failed:', e?.message || e);
    return { scheduled: 0 };
  }
}

export async function cancelCues() {
  if (!isCuePluginAvailable()) return;
  try { await RestTimerCue.cancel(); } catch {}
}

/**
 * The rest in the notification shade and on the lock screen (RestShade.java):
 * started, extended, paused or resumed. `rest` carries the times and the
 * words, already translated, since the notification's buttons work with no
 * web layer to ask.
 */
export async function showRest(rest) {
  if (!isCuePluginAvailable()) return false;
  try { await RestTimerCue.show(rest); return true; } catch { return false; }
}

/** Put the notification back from its own record (after a force-stop took it). */
export async function repostRest() {
  if (!isCuePluginAvailable()) return false;
  try { await RestTimerCue.repost(); return true; } catch { return false; }
}

/**
 * Whether the watch took the word stamped `at`, so the notification's
 * buttons know to tell it how a pause it holds ends.
 */
export async function restOnWatch(at, took) {
  if (!isCuePluginAvailable()) return false;
  try { await RestTimerCue.onWatch({ at: Number(at) || 0, took: !!took }); return true; } catch { return false; }
}

/** The rest is over, skipped or stopped: the notification goes. */
export async function hideRest(at) {
  if (!isCuePluginAvailable()) return false;
  try { await RestTimerCue.hide({ at: Number(at) || Date.now() }); return true; } catch { return false; }
}

/** What the notification last had: its buttons may have changed the rest. */
export async function nativeRest() {
  if (!isCuePluginAvailable()) return null;
  try {
    const r = await RestTimerCue.state();
    if (!r?.found) return null;
    return {
      at: Number(r.at) || 0,
      active: !!r.active,
      paused: !!r.paused,
      endsAt: Number(r.endsAt) || 0,
      leftMs: Number(r.leftMs) || 0,
      total: Number(r.total) || 0,
      label: String(r.label || ''),
      date: String(r.date || ''),
      startedAt: Number(r.startedAt) || 0,
    };
  } catch { return null; }
}

/** A button on the notification, or the watch, changed the rest. */
export function onNativeRest(fn) {
  if (!isCuePluginAvailable()) return;
  try { RestTimerCue.addListener('restChanged', fn); } catch { /* no native side */ }
}

/** The notification was tapped: `fn(date)`, even when that started the app. */
export function onRestOpened(fn) {
  if (!isCuePluginAvailable()) return;
  try { RestTimerCue.addListener('openRest', (e) => fn(String(e?.date || ''))); } catch { /* no native side */ }
}
