import { APP_VERSION } from './lib/version.js';
if (typeof window !== 'undefined') window.__APP_VERSION__ = APP_VERSION;

// Diagnostic log capture MUST be the first import so its console.* wrappers
// install before any other module logs. See src/lib/log-capture.js.
import './lib/log-capture.js';

import './styles/tokens.css';
import './styles/base.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/buttons.css';
import './styles/forms.css';
import App from './App.svelte';
import { DB } from './lib/db.js';
import { installApiFetch } from './lib/apiFetch.js';
import { initI18n } from './i18n/index.js';

// Initialise i18n with the user's SAVED language (falling through to the
// browser locale via pickInitialLocale() only when nothing's saved). Passing
// the saved locale up-front lets svelte-i18n load that dictionary before
// App mounts, so the language-store subscription doesn't flip locales mid-
// mount to a dict that hasn't loaded yet. Prior behavior — initI18n() with
// no arg — threw '[svelte-i18n] Cannot format a message without first
// setting the initial locale' inside `new App(...)` when the saved language
// differed from the navigator, propagated out of DB.init().then(...), and
// landed on the Database Error screen. See #55.
// DB.getSetting is pure localStorage, safe before DB.init().
initI18n(DB.getSetting('language'));

// Install the Capacitor fetch interceptor BEFORE any code calls fetch('/api/...').
// On web this is a no-op; on native it routes /api/... URLs to either the
// configured server (server mode) or the local SQLite handler (standalone).
installApiFetch();

// Native UX polish: status bar style + edge-to-edge handling. Status bar
// matches the dark surface so the bezel doesn't look like an empty band
// above the page banner. SplashScreen is configured via capacitor.config.ts
// to auto-hide after 1.2s; calling hide() explicitly here as belt-and-suspenders.
import { Capacitor } from '@capacitor/core';
if (Capacitor.isNativePlatform()) {
  (async () => {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: '#0F1115' });
    } catch {}
    try {
      const { SplashScreen } = await import('@capacitor/splash-screen');
      await SplashScreen.hide();
    } catch {}
  })();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  const appearance = localStorage.getItem('wl_appearance') || 'system';
  if (appearance === 'system') {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    const meta = document.getElementById('theme-color-meta');
    if (meta) meta.content = e.matches ? '#0A0B0F' : '#F5F7FA';
  }
});

DB.init()
  .then(() => {
    new App({ target: document.getElementById('app') });
  })
  .catch(err => {
    console.error('DB init failed:', err);
    document.getElementById('app').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100dvh;padding:32px;text-align:center;gap:16px;font-family:sans-serif;">
        <span style="font-size:48px">⚠️</span>
        <h2 style="color:#F0F2F8">Database Error</h2>
        <p style="color:rgba(240,242,248,0.6);max-width:300px">
          Could not open the local database. Try closing other tabs or clearing site data.
        </p>
        <button onclick="location.reload()"
          style="padding:12px 24px;border-radius:12px;background:#FF7433;
                 color:#0A0B0F;font-weight:600;border:none;cursor:pointer;font-size:15px;">
          Retry
        </button>
      </div>`;
  });
