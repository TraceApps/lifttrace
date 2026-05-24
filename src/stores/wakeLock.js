import { writable, get } from 'svelte/store';

/** User's intent — "I want the screen to stay on" */
export const wantScreenOn = writable(false);

/** Current lock state — is the wake lock actually active right now? */
export const screenOn = writable(false);

let _wakeLock = null;
let _listenersAttached = false;

async function _acquire() {
  if (_wakeLock) return;
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    screenOn.set(true);
    _wakeLock.addEventListener('release', () => {
      _wakeLock = null;
      screenOn.set(false);
      // Don't touch wantScreenOn — it's the user's intent, persists through
      // browser-triggered releases (visibility change, etc.)
    });
  } catch (e) {
    _wakeLock = null;
    screenOn.set(false);
  }
}

async function _release() {
  if (_wakeLock) {
    try { await _wakeLock.release(); } catch {}
    _wakeLock = null;
  }
  screenOn.set(false);
}

function _onVisibilityChange() {
  if (document.visibilityState === 'visible' && get(wantScreenOn) && !_wakeLock) {
    _acquire();
  }
}

function _attachListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;
  document.addEventListener('visibilitychange', _onVisibilityChange);
}

/** Enable screen keep-awake (intent + acquire) */
export async function enableWakeLock() {
  _attachListeners();
  wantScreenOn.set(true);
  await _acquire();
}

/** Disable screen keep-awake (clear intent + release) */
export async function disableWakeLock() {
  wantScreenOn.set(false);
  await _release();
}

/** Toggle wake lock based on current state */
export async function toggleWakeLock() {
  if (get(wantScreenOn)) await disableWakeLock();
  else await enableWakeLock();
}
