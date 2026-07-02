# LiftTrace — Project Reference

**App name**: LiftTrace
**Version**: See `src/lib/version.js` (centralized)
**Location**: `/home/papa/Documents/claude_code/lifttrace/`
**GitHub**: `git@github.com:TraceApps/lifttrace-dev.git` (private monorepo; the `lifttrace` slug is reserved for the public release repo)
**Stack**: Svelte 5 (`runes: false` + `componentApi: 4` compat mode), svelte-spa-router v4 (hash routing), Vite 6, Express 5, bcryptjs 3, better-sqlite3, PWA, Capacitor 8 (Android)
**Docker**: `docker compose up -d` → serves on port 3002 (internal 3003)
**Android**: `npm run android:debug` → APK at `android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed)
**License**: AGPL-3.0
**Sister app**: NutriTrace (same philosophy, same stack, shared patterns)

## Architecture

- **`src/main.js`** — Entry point. Calls `DB.init()` BEFORE mounting App.
- **`src/App.svelte`** — Root. `{#key $location}` destroys/recreates routes on nav.
- **`src/routes/Diary.svelte`** — Main workout logging page.
- **`src/routes/Exercises.svelte`** — Exercise library browser.
- **`src/routes/ExerciseDetail.svelte`** — Single exercise view with media + history.
- **`src/routes/Programs.svelte`** + **`ProgramDetail.svelte`** — Program management.
- **`src/routes/WorkoutEditor.svelte`** — Template editor (program sub-page).
- **`src/routes/Statistics.svelte`** — Charts page with metric-pill layout.
- **`src/routes/Radio.svelte`** — Music player (library + streaming stations).
- **`src/routes/Settings.svelte`** — Thin orchestrator (~900 lines). Every section is a sub-component under `src/components/settings/`.
- **`src/components/settings/*`** — One file per section (Appearance, Workout, Statistics, Trace, Radio, Catalog, Backup, Notifications, Email, UserManagement, About). Props contract: `{ visible, expanded, onToggle }`.
- **`src/components/diary/SmartLogModal.svelte`** — Natural-language workout logging with text + voice input.
- **`src/components/ai/Trace.svelte`** — Floating AI coach with hold-to-voice-log on the FAB and frequency visualizer ring when music plays.
- **`src/stores/workout.js`** — `currentDate`, `todayLog`, `saveWorkout`, active program.
- **`src/stores/settings.js`** — All settings via `createSettingStore` (localStorage + server sync).
- **`src/stores/player.js`** — Music player state. On web: `<audio>` + MSE streamer for gapless. On Android (Capacitor): everything (radio + library) routes through the native ExoPlayer plugin (`src/lib/native-player.js` → `RadioPlayerPlugin.java`). Exports `getAudioForAnalyser()` for Web Audio API use on web.
- **`src/lib/db.js`** — IndexedDB abstraction.
- **`src/lib/version.js`** — Centralized `APP_VERSION`.
- **`src/lib/smartLogWorkout.js`** — Smart Log parser + matcher + merger.
- **`src/lib/workoutCard.js`** — Canvas renderer for the shareable completion card.
- **`src/lib/aiChat.js`** — Multi-provider AI (Claude/OpenAI/Gemini) call wrapper.
- **`server/routes/*`** — Express routes per entity (auth, exercises, programs, workout, stats, body-stats, settings, app-config, proxy, upload, ai, full-backup, notify, subsonic-proxy, radio-proxy, exercise-import, prescriptions, trainer, templates).

## Database Tables

13 tables, all included in full backup:
users, user_settings, app_config, password_reset_tokens, invite_tokens,
ai_chat_history, exercises, programs, workout_templates, program_assignments,
coach_prescriptions, workout_log, body_stats_log.

- `workout_log` has `UNIQUE(user_id, date)` — one workout per user per day.
- `exercises.source`: `wger | free-db | exercisedb | custom | import:<name>`.
- `exercises.is_global`: true for seeded, false for user-created / imported.

## Key Design Decisions

- **`{#key $location}`** in App.svelte: destroys/recreates route on every nav. `onMount` fires fresh.
- **Debounced save** in `workout.js`: 350ms delay + optimistic update. Empty workouts (no completed sets) auto-delete server-side.
- **Settings.svelte sub-component split** (v0.9.0): orchestrator only. Each section imports its own stores directly and takes `{ visible, expanded, onToggle }` props. Framework CSS (`.section-toggle`, `.section-body`, `.card`, `.setting-row`, `.sub-label`, etc.) is marked `:global()` in Settings.svelte so sub-components inherit automatically.
- **Rest timer superset-aware** (v0.9.2): only fires when the whole superset round is complete (every exercise in the group has matching completed-set counts). Standalone exercises fire after every set as usual.
- **Trace data context**: every chat message injects a system-prompt block with active program + templates, last 14 workouts (warm-ups filtered, RPE annotated), 30-day weight trend, top 10 PRs, weekly goal + 4-week frequency, streaks, and today's coach prescription if one exists. System prompt educates the model on the `@N` RPE annotation and `(+ 2 warm-up)` notation. See `buildContext()` in `src/components/ai/Trace.svelte`.
- **Smart Log (Smart Add)** (v0.9.4): AI parses natural-language workout prose (`"bench 3x5 @ 225, A1: curls 3x12 @ 30, A2: pushdowns 3x12 @ 40"`) into structured exercises/sets. Fuzzy-matches against the library (exact → starts-with → substring → token overlap, plus aliases for BP/OHP/DL/SQ/RDL/BB/DB). Entry points: Diary "Smart Add" button, Diary sparkle FAB, and **hold-to-record on the Trace FAB** (700ms hold threshold, 100px cancel radius).
- **MSE audio pipeline** (v0.8.0): single `<audio>` fed by one `SourceBuffer`; tracks appended sequentially with matching `timestampOffset`. Audio never pauses between tracks → Chrome's tab-freeze exemption stays active on locked screens → background auto-advance works.
- **Pause detection at queue end** (v0.9.2): MSE keeps `MediaSource` open even when buffer runs out, so the audio element never fires `ended`. Progress tick detects "remaining ≤ 0.1s + last track + no repeat" and calls `pause()` explicitly.
- **`autoFillLastWeights`**: progressive-overload memory. When loading from a template, priority is: per-set `set_specs` → last-session weights (if setting on) → template's `target_weight/target_reps` → empty (v0.9.3-beta.1 fix).
- **Right-click parity** (v0.9.4): every `on:contextmenu|preventDefault` mirrors the mobile long-press / ⋮ menu action, so desktop users get the same quick-actions.
- **Trace frequency visualizer**: two-path architecture matching Chromium's `RealtimeAnalyser` shape end to end. On PWA, `getAudioForAnalyser()` in `player.js` returns the module-level `<audio>` element; Trace creates a Web Audio `AnalyserNode` (`fftSize=64`, `smoothingTimeConstant=0.75`) connected to it and reads 32 frequency bins per RAF tick. On Android, `<audio>` doesn't see ExoPlayer's output, so `FftAudioProcessor.java` taps PCM inside ExoPlayer's audio sink, applies a Blackman window, runs a 64-point FFT, smooths magnitudes (0.75 on linear values BEFORE dB), maps to dB-scaled bytes in `[-100, -30]`, and emits via the `fft` plugin event at ~60Hz. JS-side `_onNativeFft` writes into `_targetBars`; a separate `_renderTick` RAF loop eases `_displayBars` toward target at `RENDER_LERP=0.08` per frame so the SVG ring stays fluid even when the WebView's render pipeline jitters. Bars render as SVG `<line>` elements radiating from the FAB edge with `stroke="currentColor"` + `color: var(--accent)`. The legacy `android.media.audiofx.Visualizer` path was removed (2026-05-24) because some devices ran both paths simultaneously and the real/imag bytes from the system Visualizer were misinterpreted as magnitudes by `_decodeFft`, causing "always at max + flickering."
- **Scroll restore pattern**: `sessionStorage.setItem(key, window.scrollY)` before `push()`, `requestAnimationFrame(() => window.scrollTo(...))` after `await load()` in `onMount`. Used in `ProgramDetail.svelte`; key is `pd_scroll_${params.id}` so different programs don't clobber each other.
- **Radio station CORS proxy** (v0.9.4-beta.5): `/api/radio-proxy?url=...` pipes direct stream URLs through the server so they're same-origin, required for the Web Audio visualizer. HLS (`.m3u8`) bypasses the proxy — `hls.js` does its own XHR and rewriting HLS manifests through a proxy isn't worth the cost. Detection is in `Radio.svelte#playStation()`.
- **Radio station grouping** (v0.9.4-beta.5): stations have an optional `group` field (free text). Rendering groups by `group` field preserving array order within each group and insertion order of groups (Ungrouped last). Reorder swaps within same-group neighbours in the flat array. Rename group = bulk-update `group` field on every station with the old name. Stations stored in `radioStations` setting → user_settings table → covered by full backup automatically.
- **HLS support** (v0.9.4-beta.5): `hls.js` is dynamically imported inside `_attachHls()` in `player.js` so the chunk only loads when an `.m3u8` URL is played. Detection via `/\.m3u8(\?|$)/i` regex. Safari uses native HLS via `canPlayType('application/vnd.apple.mpegurl')`. Cleanup via `_destroyHls()` in `stop()` and at the top of `playTrack()`.
- **Unified Android player** (v0.10.0-beta.6): radio + library tracks both flow through `RadioPlayerPlugin` + `RadioPlaybackService` (Media3 ExoPlayer + MediaSession). One MediaSession, one notification UX. Lockscreen swaps `[Stop]` (radio) ↔ `[Prev | Next | Stop]` (library) via `setCustomLayout` + JS `setLibraryLayout(boolean)`. Position events tick at 250ms; `onPosition` mirrors into `currentTime` / `duration` / `progress` stores. Per-request `Authorization: Bearer …` headers passed via `OkHttpDataSource` for authenticated Subsonic / Jellyfin endpoints. `capacitor-music-controls-plugin` removed. Web path unchanged (`<audio>` + MSE + Web Media Session API).
- **Radio metadata coverage** (v0.10.0-beta.6): three sanitizers (Java in `RadioPlayerPlugin`, JS in `radio-icy.js`, server in `radio-proxy.js`) all recognize: iHeart `text="…"` + `amgArtworkURL`, Shoutcast `title=`/`artist=`, RDS Italia `Song*<title>*<artist>*<year>*<uuid>` (and drop `Spot*`/`Ad*` payloads to keep the previous song on the lockscreen during ad breaks). HLS streams with embedded ID3 (`TIT2`/`TPE1`) frames are unlocked too.
- **Warm-up sets + RPE + exercise substitution** (v0.9.4-beta.13): sets carry an optional `warmup: true` flag — all display counters, volume, PRs, rest-timer firing, auto-collapse, and superset-round gating filter warm-ups out. Generator is `generateWarmupSets(W, unit)` in `src/lib/workout.js`. RPE is `set.rpe: number | null`; chip + picker lives in `SetRow.svelte`, gated by `$trackRpe` setting. Similar-exercise scoring in `src/lib/exerciseSimilarity.js` — `primary*3 + secondary - (differentEquipment?1:0)`, requires ≥1 primary overlap. Rendered on ExerciseDetail page as a responsive grid of thumbnails.
- **Radio-proxy SSRF guard** (v0.9.4-beta.22): `assertSafeUrl()` in `server/routes/radio-proxy.js` resolves a user-supplied hostname via `dns/promises.lookup` and rejects on private / loopback / link-local IPs before any fetch. Tiered: link-local + cloud-metadata (`169.254/16`, IPv6 `fe80::/10`) is always blocked; loopback + RFC1918 + IPv6 ULA is blocked by default but opt-out via `ALLOW_PRIVATE_RADIO_URLS=1` env var (logs warning at startup). Applied to: main stream proxy, `/info`, `/icon-suggest`, the silent fallback fetchers (`status-json.xsl`, `stats?json=1`), and the icon HTML parser. URLs that resolve to public IPs are unaffected — DNS lookup adds <10ms.
- **Security audit** (v0.9.4-beta.21): bcrypt cost 12, per-username + per-IP login throttling, constant-time recovery-token comparison via `crypto.timingSafeEqual`, always-200 forgot-password (no enumeration oracle), zip-slip + zip-bomb defense in full-backup restore, magic-byte upload validation in `server/lib/image-magic.js`, `secure: true` cookie default with `INSECURE_COOKIES=1` opt-out, JSON body limit 1 MB global, AI chat caps (60 messages / 200 KB), backup `:name` extension guard, session duration capped at 1 year via `MAX_SESSION_HOURS`, JWT_SECRET refuse-to-start in production.
- **Radio metadata hardening** (v0.9.4-beta.12): `_sanitizeTitle` in radio-proxy.js handles UTF-8 mojibake (retry as latin-1), HTML entity decode, Shoutcast key=value payloads, Unicode-dash normalization, ad-break marker suppression. When `/now-playing` is hit and we don't have a fresh inline title we fire-and-forget `_tryFallbackFetchers(url)` which probes `<origin>/status-json.xsl` (Icecast) and `<origin>/stats?json=1` (Shoutcast v2), debounced to once per 30s per URL. Results land in the same `icyTitles` cache so the next client poll picks them up. Data shape returned by the endpoint (`{ title, updatedAt }`) is unchanged — strictly additive server-side hardening.
- **Workout-history import** (v0.9.4-beta.10 → beta.11): two-step route `/api/workout-import/{preview,commit}`. Each app gets its own adapter in `server/lib/workout-import/` (strong.js, hevy.js, fitnotes.js, jefit.js) producing a canonical `{ date, name, notes, duration_min, exercises: [{ sourceName, sets, superset_id, superset_size }] }`. Shared helpers in `common.js` (CSV splitter, weight conversion, name cleaner + fuzzy matcher). Client UI is `SettingsWorkoutImport.svelte` in the DATA group, marked with an EXPERIMENTAL badge. Skip vs replace on duplicate-date workouts. Unmatched exercise names persist as free-text — existing Replace recovery flow relinks them later.
- **User-mgmt / profile pattern** (v0.9.4-beta.10): matches NutriTrace. Sign-out lives only in the sidebar footer. Settings has no top profile card. `SettingsUserManagement.svelte` is visible to ALL logged-in users and renders a "My Profile" shortcut row that pushes to `/profile`; admins also see the user list + invite + session controls below. It's grouped under "Account" (not "Admin"). Admin-only sections still gated with `$currentUser?.role === 'admin'`.
- **Drag auto-scroll gotchas** (v0.9.4-beta.9): document-level `drag`/`dragover` listeners (attached on dragstart, removed on dragend/drop) fire regardless of what's under the pointer — per-element listeners miss the edge zones. Must pass `behavior: 'instant'` to `scrollBy` explicitly inside the RAF loop or the global `scroll-behavior: smooth` on `<html>` will animate each 26-px call over 300 ms and the scroll will crawl. Every other scroll call in the app specifies its own `behavior:` value, so the global CSS isn't a problem elsewhere.
- **Rest timer persistence + cues** (v0.9.4-beta.8): `src/stores/restTimer.js` holds the timer as a module-level store driven by an absolute `endTime` timestamp (localStorage-persisted). Countdown beeps scheduled via `setTimeout` at endTime-3000/2000/1000/0 ms, not via tick polling — so throttled background timers don't miss them. Service Worker notification fires when `document.visibilityState === 'hidden'` at finish, OS handles vibrate + sound. On `visibilitychange: visible` the store re-schedules to catch anything the browser dropped while throttled. UI mounted globally in App.svelte (`<RestTimer />`) so it persists across route transitions. Rest bar publishes `--rest-h: 68px | 0px` on :root; WorkoutModeBar reads this in its `bottom` calc + has a `transition: bottom 0.26s` so the pill slides above the rest bar smoothly.
- **Persistent card collapse** (v0.9.4-beta.8): `src/lib/cardCollapse.js` writes `{ <date>: { <rowKey>: true } }` to localStorage, auto-prunes to 30 dates. ExerciseCard + SupersetCard read on mount, write on toggle. rowKey is `ex:<idx>:<exercise_id>` or `ss:<superset_id>`.
- **Custom exercises** (v0.9.4-beta.7): user-created rows in the `exercises` table use `source='custom'`, `is_global=0`, `created_by=<userId>`. `/api/exercises` list query already includes these for the creator. `ExerciseEditor.svelte` is the single modal used in three places (Exercises page "+" button, ExerciseDetail edit, picker "Create X" shortcut). `MediaInput.svelte` unifies upload/URL/YouTube — stores in exactly one of `img_url` / `gif_url` / `video_url` columns (kind inferred from MIME or URL extension). Upload route `/api/upload/exercise-media` accepts image/* and video/* up to 100 MB, saves to `/uploads/exercises/`. Bulk clear via `DELETE /api/exercises/custom/all` (scoped to current user). Settings → Exercise Catalog → "My Exercises" lists+manages them; library rows get a "Custom" chip so they stand out.
- **Radio discovery + now-playing** (v0.9.4-beta.6): Browse sub-tab in Stations calls `de1.api.radio-browser.info` directly (CORS-enabled public API, no key needed). The proxy route requests `Icy-MetaData: 1`, parses `StreamTitle` out of interleaved metadata blocks (state machine: audio → metaLen byte → meta bytes → audio), strips metadata before forwarding audio, caches title in a Map keyed by original URL. `/api/radio-proxy/now-playing` returns the cached title. `streamNowPlaying` store in `player.js` polls every 8s while `track.isStream && track.originalUrl` is set. `/api/radio-proxy/info` aborts after response headers to extract `icy-name` / `icy-genre` for the Auto-fill button. `.pls` / `.m3u` playlist files are resolved server-side inside the proxy before the upstream fetch.

## Android App (Capacitor 8) — v0.10.x

### Architecture
The Android app is a Capacitor 8 shell wrapping the same Svelte PWA. It runs offline-first with a local SQLite database, and can optionally connect to a LiftTrace server for sync — same model as NutriTrace.

- **Platform layer** (`src/lib/platform.js`): `isNative` detects Capacitor; `apiUrl()` returns empty string (local mode) or server URL (connected); `getServerUrl()` / `getNativeMode()` read from localStorage (`lt:nativeMode`, `lt:serverUrl`, `lt:authToken`).
- **Native API** (`src/lib/api-native.js`): `LtApiNative` class implements every server CRUD endpoint against local SQLite. Used in standalone mode.
- **Native DB** (`src/lib/db-native.js`): SQLite schema mirroring all 13 server tables plus `sync_meta` + `sync_queue`. Each mutable table has `updated_at` / `deleted_at` / `sync_state` columns the server schema doesn't have.
- **Fetch interceptor** (`src/lib/apiFetch.js`): patches `window.fetch` so every existing `fetch('/api/...')` call routes correctly without callsite refactor. Three modes:
  - Web → relative URL, cookies, original fetch
  - Native + server → rewrite to absolute URL + Bearer token
  - Native + standalone → dispatch to LtApiNative, return synthetic Response
- **NativeSetup wizard** (`src/routes/NativeSetup.svelte`): first-launch chooser between Use Locally and Connect to Server. Server mode: URL + login → JWT stored in localStorage.
- **Differential sync** (`src/lib/sync.js`): `pullSnapshot()` refreshes cache from server list endpoints (settings/exercises/programs/last-200-workouts/90-day body stats); `flushQueue()` retries enqueued writes; `startBackgroundSync()` wires `online` + `visibilitychange` events.
- **Native notifications** (`src/lib/notifications.js`): Capacitor LocalNotifications on native, Web Notification API on PWA. Push services (Apprise/Gotify/ntfy) called direct via CapacitorHttp on native (bypass server proxy).
- **WorkManager**: `android/app/src/main/java/com/lifttrace/app/{WorkerScheduler,ReminderWorker}.java`. 15-min periodic worker reads `lifttraceSQLite.db` directly, posts notifications based on user_settings toggles, de-dupes per-day via SharedPreferences. Gated by `_USE_NATIVE_WORKER` setting (default off — JS LocalNotifications is the v0.10.x default).
- **Image cache** (`src/lib/image-cache.js`): downloads exercise media via Filesystem plugin to `Directory.Data/lifttrace-images/`, mapping persisted in `sync_meta.image_map`. `resolveAssetUrl()` swaps in local `file://` URI synchronously when present.
- **Local backup** (`src/lib/local-backup.js`): JSON dump of every cached table. `exportBackup()` writes + opens Share sheet; `importBackup()` does destructive restore.
- **Haptics** (`src/lib/haptics.js`): cross-platform shim — `@capacitor/haptics` impacts on native, `navigator.vibrate` on web. `SetRow` / `restTimer` / `Trace` use it.
- **Settings gating in local mode**: User Management, Email/SMTP, Full Backup, Catalog, Workout Import all hidden. New `SettingsMode` component shows mode + sync status + WorkManager toggle + Disconnect/Reconnect actions.
- **Service worker disabled in Capacitor**: `index.html` unregisters any existing SW + overrides `register` to no-op when `Capacitor.isNativePlatform()`.

### Build & Run
```bash
# Prerequisites: ANDROID_HOME=/path/to/Android/Sdk, JAVA_HOME, Android Studio if you want to debug graphically.

npm run android:debug        # vite build + cap sync + assembleDebug → debug APK
npm run android:open         # open the android/ project in Android Studio
npm run android:run          # build, sync, and install on connected device

# Direct gradle:
cd android && ./gradlew assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk (~31 MB)
```

### Capacitor plugins (12)
@capacitor/{core,android,cli,app,local-notifications,splash-screen,status-bar,keyboard,haptics,filesystem,share,camera,browser,preferences} + @capacitor-community/sqlite. Health Connect + barcode-scanner + speech-recognition deferred to FUTURE.md.

### Endpoints that throw 501 (offline) in standalone mode
`/api/proxy`, `/api/radio-proxy/*`, `/api/subsonic/*`, `/api/full-backup/*`, `/api/upload*`, `/api/exercises/sync-wger`, `/api/exercises/sources/*`, `/api/exercise-import/*`, `/api/workout-import/*`, `/api/programs/import-excel`, `/api/auth/{invite,accept-invite,validate-token}`, `/api/app-config/test-email`. Settings UI surfaces the offline 501 with a friendly hint where applicable.

## Versioning Policy

See `~/.claude/projects/-home-papa/memory/feedback_lifttrace_versioning.md` for full detail.

Scheme: `MAJOR.MINOR.PATCH-beta.BUILD`

- Normal ship cadence = increment the `-beta.N` counter only (e.g. `0.9.3-beta.1` → `0.9.3-beta.2`).
- Patch bump (`0.9.3 → 0.9.4-beta.1`) only for coherent, user-facing named releases.
- Minor bump (`0.9.x → 0.10.0-beta.1`) only for genuine architectural shifts.
- **1.0.0 LOCKED until user explicitly says release-ready.**

Files that must be updated together for any version bump:
- `src/lib/version.js`
- `package.json`
- `server/package.json`
- `CHANGELOG.md` (new section at top)

## Svelte Reactivity Rules

- **Functions in templates**: Svelte only tracks dependencies that appear DIRECTLY in template expressions. Pass reactive values as explicit function parameters — don't close over them.
- **`$:` reactive statements**: fire on mount AND on change. Don't add redundant `onMount` calls.
- **Async race guards**: capture the key before await, check it still matches after.
- **Signature-gated collapse** (ExerciseCard, SupersetCard): auto-collapse fires once per sets-state signature change, so re-expanding by tap doesn't snap back closed on the next save tick.

## Environment Variables

See `.env.example` for full list. Key ones:
- `DB_PATH` — SQLite file path (default `./lifttrace.db`)
- `UPLOADS_PATH` — uploads directory (default `./uploads`)
- `JWT_SECRET` — required for production (warns at startup if not set)
- `PORT` — server port (default 3003)
- `EXERCISE_SOURCES` — comma-separated list of sources to auto-seed on first boot
- `SMTP_*` — optional, locks Settings UI fields when set
- `AI_*` — optional, locks Trace settings when set

## Password Requirements

8+ characters with uppercase, lowercase, number, and special character. Shared validator in `src/lib/validation.js` used across Wizard, Profile, Reset Password, Accept Invite, and the inline enable-user-management flow.

## Related Docs

- `README.md` — user-facing feature list and quick start
- `CHANGELOG.md` — release history
- `FUTURE.md` — planned features, tech debt, 1.0 prep work
