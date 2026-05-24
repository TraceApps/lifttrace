/**
 * haptics.js — Cross-platform haptic feedback.
 *
 * On native (Capacitor) routes through @capacitor/haptics for richer + more
 * reliable buzzes (Android WebView's navigator.vibrate has been unreliable
 * across vendor builds). On web falls back to navigator.vibrate.
 *
 * Public API mirrors the call signatures already used in the LiftTrace
 * codebase (vibrate(ms) and vibrate([on, off, on, off])) so existing
 * callsites can replace `navigator.vibrate(x)` with `haptic(x)` with no
 * other changes.
 */

import { isNative } from './platform.js';

let _hapticsModule = null;
async function _loadHaptics() {
  if (!isNative) return null;
  if (_hapticsModule) return _hapticsModule;
  try {
    _hapticsModule = await import('@capacitor/haptics');
    return _hapticsModule;
  } catch { return null; }
}

/**
 * Trigger a haptic. Pass a number for a single buzz of that duration in ms,
 * or an array (Android Vibrator pattern: [delay, on, off, on, ...]) for a
 * sequence. The Capacitor backend approximates patterns with successive
 * impacts since it doesn't expose raw vibrator timing.
 */
export async function haptic(pattern) {
  if (typeof pattern === 'undefined' || pattern === 0) return;
  if (isNative) {
    const m = await _loadHaptics();
    if (!m) return;
    try {
      if (Array.isArray(pattern)) {
        // Map pattern to a sequence of impacts. Light/Medium/Heavy by total ms.
        const total = pattern.reduce((a, b) => a + b, 0);
        const style = total > 600 ? m.ImpactStyle.Heavy
                    : total > 200 ? m.ImpactStyle.Medium
                    : m.ImpactStyle.Light;
        const impacts = Math.min(4, Math.ceil(pattern.length / 2));
        for (let i = 0; i < impacts; i++) {
          await m.Haptics.impact({ style });
          if (i < impacts - 1) await new Promise(r => setTimeout(r, 80));
        }
      } else {
        const ms = Number(pattern) || 12;
        const style = ms > 100 ? m.ImpactStyle.Heavy
                    : ms > 30  ? m.ImpactStyle.Medium
                    : m.ImpactStyle.Light;
        await m.Haptics.impact({ style });
      }
    } catch {}
    return;
  }
  // Web fallback
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}
