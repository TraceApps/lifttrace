import { writable, get, derived } from 'svelte/store';
import { DB } from '../lib/db.js';

// Server-driven env-lock state. Populated from /api/app-config/env-locks
// on app startup. Drives both the "Configured via environment variables"
// banner and the effective enabled state for env-controlled features.
// Mirrors NutriTrace #36 fix.
export const envLocks = writable({ smtp: false, ai: false, ai_enabled: false, oidc_provider_ids: [] });

const SERVER_SETTINGS = new Set([
  'weightUnit', 'heightUnit',
  'dateFormat', 'timeFormat',
  'weeklyWorkoutGoal', 'goals',
  'heightCm', 'currentWeightKg', 'dob', 'gender', 'caloriesBurnedEnabled',
  'statsChartType', 'statsYZero', 'statsAvgLine', 'statsTrendLine',
  'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel', 'aiBaseUrl', 'aiAssistantName', 'aiKeyVerified',
  'wgerEnabled', 'exerciseDbApiKey',
  // Appearance/UI prefs
  'appearance', 'accentColor', 'language',
  'navStyle', 'sidebarPersistent', 'startPage', 'disableAnimations',
  'pageBanners', 'bannerStyle', 'bannerAnimation',
  // NutriTrace federation — workout calorie sync (Phase 2)
  'ntInstanceUrl', 'ntInstanceToken', 'ntFederationEnabled', 'ntConnectionVerified',
  'screenKeepAwake', 'goalCelebrations', 'autoFillLastWeights', 'showCompletionSummary', 'favoriteExercises', 'customEquipment',
  'exerciseReorderMethod', 'autoCollapseCompleted', 'autoNameWorkouts', 'confirmExerciseRemoval',
  'autoGenerateWarmups', 'trackRpe',
  'radioStations',
  'restTimerEnabled', 'restDuration', 'restAutoStart', 'restAlert',
  'restAlertVibrate', 'restAlertTone', 'restAlertToneId', 'restPerExercise',
  'notifLocalEnabled', 'notifPushService',
  'gotifyUrl', 'gotifyToken', 'ntfyUrl', 'ntfyTopic', 'ntfyToken', 'appriseUrl', 'appriseTag',
  'notifWorkoutReminder', 'notifWorkoutTime', 'notifRestDay',
  'notifStreakAlert', 'notifStreakTime',
  'notifWorkoutComplete', 'notifPRCelebrations',
  'notifMemberCompletes', 'notifMemberMissed', 'notifMemberReply', 'notifCoachFeedback',
  'notifWeeklySummary', 'weeklySummaryDay', 'weeklySummaryTime',
  'bodyStatsVisible', 'exerciseLoadTypes',
  'radioEnabled', 'radioProvider', 'radioUrl', 'radioUser', 'radioPassword', 'radioCrossfade', 'radioOriginalFormat',
  'radioStationsEnabled',
  'updateCheckInterval', // hours between checks: 1, 4, 12, 24, or 0 for manual only
]);

const _saveQueue = {};
function _isLoggedIn() { return !!localStorage.getItem('wl:userId'); }

export function scheduleSave(key, value) {
  if (!SERVER_SETTINGS.has(key)) return;
  clearTimeout(_saveQueue[key]);
  _saveQueue[key] = setTimeout(() => {
    if (!_isLoggedIn()) return;
    fetch('/api/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    }).catch(() => {});
  }, 600);
}

/**
 * Write multiple settings at once. Each value is persisted to localStorage
 * (which fires wl:setting events so all subscribed Svelte stores update),
 * and any keys in SERVER_SETTINGS are queued for server sync via the
 * existing scheduleSave debounce. Used by the Wizard's finish() so a single
 * call lands every collected field in localStorage + the server in one go,
 * instead of the per-key DB.setSetting path which only writes localStorage.
 */
export function bulkSet(settingsObj) {
  if (!settingsObj || typeof settingsObj !== 'object') return;
  for (const [key, value] of Object.entries(settingsObj)) {
    if (value === undefined) continue;
    DB.setSetting(key, value);
    if (SERVER_SETTINGS.has(key)) scheduleSave(key, value);
  }
}

export async function loadServerSettings() {
  if (!_isLoggedIn()) return;
  try {
    const res = await fetch('/api/settings', { credentials: 'include' });
    if (!res.ok) return;
    const serverSettings = await res.json();
    for (const [key, value] of Object.entries(serverSettings)) {
      DB.setSetting(key, value);
      // Dispatch with the BARE key — the createSettingStore listener
      // below compares against the bare key, not 'wl_<key>'. The old
      // wl_-prefixed event silently bypassed every store, so settings
      // loaded from the server only took effect after a full app reload
      // (when stores re-read from localStorage on init).
      window.dispatchEvent(new CustomEvent('wl:setting', { detail: { key } }));
    }
  } catch {}
}

function createSettingStore(key, defaultValue) {
  const store = writable(DB.getSetting(key, defaultValue));

  window.addEventListener('wl:setting', (e) => {
    if (e.detail && e.detail.key === key) {
      const next = DB.getSetting(key, defaultValue);
      const prev = get(store);
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        store.set(next);
      }
    }
  });

  return {
    subscribe: store.subscribe,
    set(value) {
      DB.setSetting(key, value);
      store.set(value);
      scheduleSave(key, value);
    },
    update(fn) {
      const current = DB.getSetting(key, defaultValue);
      this.set(fn(current));
    },
    get() {
      return get(store);
    }
  };
}

// Appearance
export const appearance       = createSettingStore('appearance',       'system');
export const language         = createSettingStore('language',          'en');
export const accentColor      = createSettingStore('accentColor',      'orange');
export const navStyle         = createSettingStore('navStyle',         'both');
export const sidebarPersistent = createSettingStore('sidebarPersistent', false);
export const startPage        = createSettingStore('startPage',        '/');
export const disableAnimations = createSettingStore('disableAnimations', false);
// Desktop opt-out. When true, App.svelte stamps `html.force-mobile-layout`
// so the desktop-only CSS (Settings two-pane rail, any future ≥1024px
// layouts) reverts to the mobile stack. Lets desktop users preview the
// phone layout without resizing the window. Matches NutriTrace's shape
// so any shared debug tooling recognizes the same class.
export const forceMobileLayout = createSettingStore('forceMobileLayout', false);
// bannerStyle is the canonical banner-display setting.
//   'animated' = tall header with illustrated SVG (original behavior)
//   'gradient' = tall header filled with the active accent gradient, no SVG
//   'off'      = compact header (no banner area at all)
// pageBanners is kept as a derived alias so existing call sites
// (App.svelte hamburger row sizing, SettingsBackup defaults) keep working.
// bannerStyle migration. Kept dead simple:
//   - Saved bannerStyle → keep the explicit pick.
//   - Legacy pageBanners=false → 'off' (respect the prior opt-out).
//   - Anything else → 'animated' (preserve the existing-user experience).
// New users completing the Wizard get 'gradient' written into their
// settings batch on finish() — that's the only path that yields the
// new default, which gives us a 100% reliable "this is a new install"
// signal without scraping localStorage.
function _migrateBannerStyle() {
  const saved = DB.getSetting('bannerStyle', null);
  if (saved != null) return saved;
  if (DB.getSetting('pageBanners', true) === false) return 'off';
  return 'animated';
}
export const bannerStyle = createSettingStore('bannerStyle', _migrateBannerStyle());
// bannerAnimation picks which CSS animation applies when bannerStyle is
// 'animated'. Four styles: 'shimmer' (default), 'drift', 'pulse', 'aurora'.
// Implemented as documentElement-level classes in App.svelte so the route
// markup stays unaware of which animation is active.
export const bannerAnimation = createSettingStore('bannerAnimation', 'shimmer');
// pageBanners is a legacy derived alias. The illustrated SVG banners
// were retired in rc.6 along with the .has-banner CSS path that read
// this. Kept around as `bannerStyle !== 'off'` for any third-party
// embed code that still imports the symbol; new internal call sites
// should read `bannerStyle` directly.
export const pageBanners = derived(bannerStyle, $s => $s !== 'off');
export const screenKeepAwake  = createSettingStore('screenKeepAwake',  false);
// Android-only, per-device biometric unlock for sign-in. Intentionally NOT
// in SERVER_SETTINGS — each device opts in independently.
export const biometricLoginEnabled = createSettingStore('biometricLoginEnabled', false);
export const goalCelebrations = createSettingStore('goalCelebrations', true);
export const autoFillLastWeights = createSettingStore('autoFillLastWeights', true);
export const showCompletionSummary = createSettingStore('showCompletionSummary', true);
export const favoriteExercises = createSettingStore('favoriteExercises', []);
// User-defined equipment names (Slackboard, Sandbag, etc.) that show up
// alongside the six normalized buckets in the Exercises filter row and
// in the ExerciseEditor equipment picker. Synced via SERVER_SETTINGS so
// a user's home-gym kit follows them between devices.
export const customEquipment = createSettingStore('customEquipment', []);
export const exerciseReorderMethod = createSettingStore('exerciseReorderMethod', 'both'); // 'drag' | 'buttons' | 'both'
// Exercises tab display density (issue #74). Desktop only, so mobile's
// existing compact list is untouched.
export const exerciseBrowserDensity = createSettingStore('exerciseBrowserDensity', 'compact'); // 'compact' | 'comfortable'
export const autoCollapseCompleted = createSettingStore('autoCollapseCompleted', true);
export const autoNameWorkouts = createSettingStore('autoNameWorkouts', true);
export const confirmExerciseRemoval = createSettingStore('confirmExerciseRemoval', true);
export const autoGenerateWarmups    = createSettingStore('autoGenerateWarmups', false);
export const trackRpe               = createSettingStore('trackRpe', false);

// Radio stations (user-managed list of streaming URLs): [{id, name, url, genre}]
export const radioStations = createSettingStore('radioStations', []);
export const radioStationsEnabled = createSettingStore('radioStationsEnabled', false);

// Rest timer
export const restTimerEnabled = createSettingStore('restTimerEnabled', false);
export const restDuration     = createSettingStore('restDuration',     90);
export const restAutoStart    = createSettingStore('restAutoStart',    true);
export const restAlert        = createSettingStore('restAlert',        true);
export const restAlertVibrate = createSettingStore('restAlertVibrate', true);
export const restAlertTone    = createSettingStore('restAlertTone',    true);
export const restAlertToneId  = createSettingStore('restAlertToneId',  'classic');
// Per-exercise rest memory (map of exercise_id -> seconds). Auto-populated each
// time the timer runs to completion; overrides the global restDuration when present.
export const restPerExercise  = createSettingStore('restPerExercise',  {});

// Notifications
export const notifLocalEnabled    = createSettingStore('notifLocalEnabled',    true);
export const notifPushService     = createSettingStore('notifPushService',     'none');
export const gotifyUrl            = createSettingStore('gotifyUrl',            '');
export const gotifyToken          = createSettingStore('gotifyToken',          '');
export const ntfyUrl              = createSettingStore('ntfyUrl',             'https://ntfy.sh');
export const ntfyTopic            = createSettingStore('ntfyTopic',            '');
export const ntfyToken            = createSettingStore('ntfyToken',            '');
export const appriseUrl           = createSettingStore('appriseUrl',           '');
export const appriseTag           = createSettingStore('appriseTag',           '');
export const notifWorkoutReminder = createSettingStore('notifWorkoutReminder', false);
export const notifWorkoutTime     = createSettingStore('notifWorkoutTime',     '07:00');
export const notifRestDay         = createSettingStore('notifRestDay',         false);
export const notifStreakAlert     = createSettingStore('notifStreakAlert',      false);
export const notifStreakTime      = createSettingStore('notifStreakTime',       '20:00');
export const notifWorkoutComplete = createSettingStore('notifWorkoutComplete', true);
export const notifPRCelebrations  = createSettingStore('notifPRCelebrations',  true);
// Coach-side: fire when a member completes a prescribed workout, or when
// a dated prescription's day passes without completion. Default on so the
// feature is discoverable; coach can flip off in Settings → Notifications.
export const notifMemberCompletes = createSettingStore('notifMemberCompletes', true);
export const notifMemberMissed    = createSettingStore('notifMemberMissed',    true);
// Trainer-side: ping when a member replies to one of the coach's notes.
export const notifMemberReply     = createSettingStore('notifMemberReply',     true);
// Member-side: ping when their coach leaves feedback on a workout.
export const notifCoachFeedback   = createSettingStore('notifCoachFeedback',   true);
export const notifWeeklySummary   = createSettingStore('notifWeeklySummary',   false);
export const weeklySummaryDay     = createSettingStore('weeklySummaryDay',     0);
export const weeklySummaryTime    = createSettingStore('weeklySummaryTime',    '09:00');

// Body stats — which measurements are visible
export const bodyStatsVisible = createSettingStore('bodyStatsVisible', [
  'weight', 'bodyFat', 'neck', 'chest', 'waist', 'hips', 'biceps', 'thighs', 'calves'
]);

// Per-exercise load-type memory. When the user picks a non-default mode
// for an exercise instance and ticks "Remember", we save it here so the
// next time the same exercise gets added the load_type pre-fills.
// Shape: { [exercise_id]: 'bilateral' | 'paired' | 'unilateral' }
export const exerciseLoadTypes = createSettingStore('exerciseLoadTypes', {});

// Radio / Music
export const radioEnabled  = createSettingStore('radioEnabled',  false);
export const radioProvider = createSettingStore('radioProvider',  'subsonic');
export const radioUrl      = createSettingStore('radioUrl',      '');
export const radioUser     = createSettingStore('radioUser',     '');
export const radioPassword = createSettingStore('radioPassword', '');
export const radioCrossfade = createSettingStore('radioCrossfade', 0); // 0 = off, 1-12 seconds
export const radioOriginalFormat = createSettingStore('radioOriginalFormat', false);

// Units
export const weightUnit  = createSettingStore('weightUnit',  'lbs');
export const heightUnit  = createSettingStore('heightUnit',  'ft');
export const dateFormat  = createSettingStore('dateFormat',  'US');
export const timeFormat  = createSettingStore('timeFormat',  '12h');

// Goals
export const weeklyWorkoutGoal = createSettingStore('weeklyWorkoutGoal', 4);
// Cardio is opt-in — off by default because most LT users are pure
// lifters. Toggling on adds a Cardio card to the Diary + a Cardio
// metric pill to Statistics. Matches NT's Activity card pattern for
// family consistency.
export const cardioEnabled = createSettingStore('cardioEnabled', false);
// Cardio weekly-minutes target. 0 disables the target line on the
// Statistics Cardio chart; anything > 0 draws a horizontal reference
// line at that value, same visual language as weeklyWorkoutGoal on
// the Frequency chart.
export const weeklyCardioMinutesGoal = createSettingStore('weeklyCardioMinutesGoal', 0);
export const goals             = createSettingStore('goals', {});

// Body profile — used by the calorie-burn estimator (Mifflin-St Jeor BMR + MET).
// heightCm + currentWeightKg are always stored in SI regardless of the user's
// chosen heightUnit / weightUnit; the wizard + profile UI convert to and from
// feet+inches / lbs as needed. Keeping them in SI means formulas don't have
// to switch on unit at every call site.
export const heightCm        = createSettingStore('heightCm',        null);
export const currentWeightKg = createSettingStore('currentWeightKg', null);

// Calorie burn estimation (per workout). Off by default — the estimate is
// loose (resistance-training calorie counts have ±25% error even with
// perfect inputs) so opt-in keeps it from being mistaken for a hard number.
export const caloriesBurnedEnabled = createSettingStore('caloriesBurnedEnabled', false);

// Stats chart
export const statsChartType = createSettingStore('statsChartType', 'bar');
export const statsYZero     = createSettingStore('statsYZero',     true);
export const statsAvgLine   = createSettingStore('statsAvgLine',   true);
export const statsTrendLine = createSettingStore('statsTrendLine', true);

// Exercise sources
export const wgerEnabled       = createSettingStore('wgerEnabled',       true);
export const exerciseDbApiKey  = createSettingStore('exerciseDbApiKey',  '');

// AI Trace (formerly LiftBot — renamed for TraceApps brand cohesion)
export const aiEnabled       = createSettingStore('aiEnabled',       false);
// Derived effective enabled — per-user toggle OR env-set AI_ENABLED=true.
// Use this for the FAB gate, chat gates, anywhere $aiEnabled was checked.
export const aiEffectivelyEnabled = derived(
  [aiEnabled, envLocks],
  ([$aiEnabled, $envLocks]) => !!$aiEnabled || (!!$envLocks.ai && !!$envLocks.ai_enabled)
);
export const aiProvider      = createSettingStore('aiProvider',      'claude');
export const aiApiKey        = createSettingStore('aiApiKey',        '');
export const aiModel         = createSettingStore('aiModel',         '');
// Base URL for the OpenAI-compatible (custom) provider — Ollama, LM Studio,
// LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq, Together AI, Mistral La
// Plateforme, etc. Stored as a setting so users can point at any
// /v1/chat/completions-compatible endpoint without rebuilding the app.
export const aiBaseUrl       = createSettingStore('aiBaseUrl',       '');
export const aiAssistantName = createSettingStore('aiAssistantName', 'Trace');
// Connection-status flag set true by SettingsTrace's save-and-test
// flow (and cleared on any auth-field edit). Drives the green pill
// on the SettingsTrace connection banner. The Trace FAB is NOT gated
// on this — see NutriTrace's lesson, gating breaks legacy installs.
export const aiKeyVerified   = createSettingStore('aiKeyVerified',   false);

// ── NutriTrace federation (workout calorie sync) ─────────────────────────
// User-entered URL + personal access token for a NutriTrace instance,
// plus a flag that's auto-flipped on by a successful Save+Test. After
// every completed workout, if federation is enabled and calorie
// estimation is on, Diary.svelte fires a POST to the server proxy at
// /api/nt/log-workout which forwards to NT's /api/v1/workouts. The
// token never leaves the LiftTrace server after the initial save.
export const ntInstanceUrl       = createSettingStore('ntInstanceUrl',       '');
export const ntInstanceToken     = createSettingStore('ntInstanceToken',     '');
export const ntFederationEnabled = createSettingStore('ntFederationEnabled', false);
// Persisted "the URL + token verified successfully against NT" flag, so the
// Connected pill survives a page re-mount instead of resetting to blank.
// Mirrors SettingsTrace's aiKeyVerified pattern. Cleared by any field edit
// in SettingsFederation; set true by a successful /api/nt/test response.
export const ntConnectionVerified = createSettingStore('ntConnectionVerified', false);

// In-app update check cadence. Hours between GitHub-tag + PWA-SW checks
// when the app is open. 0 = manual only (turns off every auto-check —
// mount, visibility-change, and the periodic PWA poll). Read by
// _throttleMs() in lib/updates.js and by App.svelte's PWA poll.
export const updateCheckInterval = createSettingStore('updateCheckInterval', 4);

// Local-mode scheduled backup. Per-device (no server in local mode).
// JS-side tick in src/lib/local-backup-scheduler.js fires when due.
// TraceApps parity with NutriTrace + CookTrace.
export const localBackupSchedule  = createSettingStore('localBackupSchedule',  'off');
export const localBackupTime      = createSettingStore('localBackupTime',      '03:00');
export const localBackupRetention = createSettingStore('localBackupRetention', 7);
export const localBackupLastRun   = createSettingStore('localBackupLastRun',   null);
export const localBackupLastError = createSettingStore('localBackupLastError', null);

/** Apply accent color */
let _lastAppliedAccent = null;
export function applyAccentColor(value) {
  if (value === _lastAppliedAccent) return;
  _lastAppliedAccent = value;
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  ['--accent','--accent-2','--accent-dim','--accent-text'].forEach(v =>
    document.documentElement.style.removeProperty(v));
  if (value === 'orange') {
    document.documentElement.removeAttribute('data-accent');
  } else if (isHex) {
    document.documentElement.removeAttribute('data-accent');
    const r = parseInt(value.slice(1,3), 16);
    const g = parseInt(value.slice(3,5), 16);
    const b = parseInt(value.slice(5,7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent',      value);
    document.documentElement.style.setProperty('--accent-2',    value);
    document.documentElement.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},0.15)`);
    document.documentElement.style.setProperty('--accent-text', lum > 0.55 ? '#0A0B0F' : '#FFFFFF');
  } else {
    document.documentElement.setAttribute('data-accent', value);
  }
  // Tint the browser-chrome tab bar to match the accent. Chromium
  // reads <meta name="theme-color"> and paints the address-bar strip
  // (and the top of the focused tab on Android) with it, so multi-
  // instance self-hosters can spot which install a tab belongs to at
  // a glance. Favicon stays the branded LT logo.
  _applyThemeColor(value);
  // Only push back into the store when the caller passed a value that
  // differs from what's already there. Without this guard, the
  // `$: applyAccentColor($accentColor)` reactive in App.svelte would
  // round-trip the store's CURRENT value back through .set() on every
  // boot — triggering DB.setSetting + scheduleSave, which produced a
  // local user_settings row on the very first launch even though the
  // user hadn't touched a setting.
  if (get(accentColor) !== value) accentColor.set(value);
}

/** Resolve any accent value (named, hex, or fallback) to a hex string.
 *  Names must stay in sync with the picker CSS in tokens.css. */
function _accentToHex(value) {
  if (typeof value !== 'string') return null;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  const NAMED = {
    orange: '#FF7433', mint:  '#4FFFB0', blue:  '#4FC3F7',
    red:    '#FF7070', purple:'#CE93D8', teal:  '#4DD0E1',
    pink:   '#F48FB1', yellow:'#FFF176', indigo:'#9FA8DA',
    lime:   '#C5E1A5', rose:  '#FF80AB', cyan:  '#80DEEA',
  };
  return NAMED[value] || null;
}

function _applyThemeColor(accentValue) {
  const hex = _accentToHex(accentValue);
  if (!hex) return;
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = hex;
}

/** Apply appearance */
let _lastAppliedAppearance = null;
export function applyAppearance(value) {
  if (value === _lastAppliedAppearance) return;
  _lastAppliedAppearance = value;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = value === 'dark' || (value === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // Re-apply the accent-tinted browser-chrome color; falls back to the
  // bg-based color only when no accent is loaded yet (early boot).
  const accentHex = _accentToHex(_lastAppliedAccent);
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = accentHex || (dark ? '#0A0B0F' : '#F5F7FA');
  // Same guard as applyAccentColor — see comment there.
  if (get(appearance) !== value) appearance.set(value);
}
