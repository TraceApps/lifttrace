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
 * @param {Array<{ at: number, sound?: string | null, vibrate?: boolean, finale?: boolean }>} cues
 *   - at: absolute unix-ms timestamp
 *   - sound: name of a raw resource (e.g. "lt_tone_classic") or null/empty for vibration-only
 *   - vibrate: fire a single ~80ms haptic pulse
 *   - finale: use the finale double-pulse vibration pattern instead of the short one
 */
export async function scheduleCues(cues) {
  if (!isCuePluginAvailable()) return { scheduled: 0 };
  try {
    return await RestTimerCue.schedule({ cues });
  } catch (e) {
    console.warn('[rest-cue] schedule failed:', e?.message || e);
    return { scheduled: 0 };
  }
}

export async function cancelCues() {
  if (!isCuePluginAvailable()) return;
  try { await RestTimerCue.cancel(); } catch {}
}
