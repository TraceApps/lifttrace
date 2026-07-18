# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 5 (compat mode: `runes: false` + `componentApi: 4`), Vite 6, svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3, bcryptjs 3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3002 (internal 3003)
- **License:** AGPL-3.0

## Layout

The important reads:

- `src/App.svelte`, root, all routes wired here
- `src/lib/api.js` (via `src/lib/apiFetch.js` interceptor), routes API calls between HTTP and native SQLite per platform
- `src/lib/db-native.js`, on-device SQLite for Android local mode
- `src/lib/sync.js`, push/pull orchestrator for Android server mode
- `src/stores/workout.js`, `currentDate`, `todayLog`, `saveWorkout`, active program
- `src/stores/player.js`, music player state (Radio + library)
- `server/db.js`, schema, migrations, sole SQLite entry point
- `server/routes/`, Express handlers, one file per entity
- `src/routes/`, top-level Svelte page components
- `src/components/settings/`, one file per settings section

Everything else is discoverable with `grep` and `ls`.

## Key Design Decisions

Things you'd want to know before rewriting them.

### Routing re-mounts on nav

`{#key $location}` in App.svelte forces route components to
destroy/recreate on every nav so `onMount` fires fresh each time.
Intentional. Reordering or removing this breaks page transitions and
skeleton-loader UX.

### Debounced workout save

`stores/workout.js` uses a 350ms debounce with optimistic UI updates.
Empty workouts (no completed sets) auto-delete server-side to keep the
diary clean.

### Settings sub-component split

`Settings.svelte` is a thin orchestrator (~900 lines). Every section
is its own file under `src/components/settings/*.svelte` with the
prop contract `{ visible, expanded, onToggle }`. Framework CSS
(`.section-toggle`, `.section-body`, `.card`, `.setting-row`, etc.)
is marked `:global()` in Settings.svelte so sub-components inherit it
without importing.

### Rest timer is superset-aware

The timer only fires when a whole superset round is complete (every
exercise in the group has matching completed-set counts). Standalone
exercises still fire after every set. Timer state is persisted via
localStorage-backed `endTime` in `src/stores/restTimer.js` so it
survives reload. Countdown beeps schedule via `setTimeout`
(not tick polling) so background-throttled timers don't miss them.

### Smart Log (natural-language workout entry)

AI parses prose like `"bench 3x5 @ 225, A1: curls 3x12 @ 30, A2: pushdowns 3x12 @ 40"`
into structured exercises/sets. Fuzzy-matches against the library
(exact → starts-with → substring → token overlap + aliases for
BP / OHP / DL / SQ / RDL / BB / DB). Entry points: Diary Smart Add
button, Diary sparkle FAB, and hold-to-record on the Trace FAB
(700ms hold threshold, 100px cancel radius).

### MSE audio pipeline (web only)

The Radio page's web player uses a single `<audio>` fed by one
`SourceBuffer`, appending tracks sequentially with matching
`timestampOffset`. Audio never pauses between tracks, which keeps
Chrome's tab-freeze exemption active on locked screens, which is
what enables background auto-advance. Pause detection at queue end
is explicit because MSE keeps the source open past buffer exhaustion
(the audio element never fires `ended`).

### Unified Android player

Radio and library tracks both flow through the native
`RadioPlayerPlugin` + `RadioPlaybackService` (Media3 ExoPlayer +
MediaSession). One session, one notification. Lockscreen swaps
`[Stop]` (radio) and `[Prev | Next | Stop]` (library) via
`setCustomLayout` + JS `setLibraryLayout(boolean)`. Web path
unchanged (still `<audio>` + MSE + Web Media Session API).

### Trace frequency visualizer (two-path)

Web: `getAudioForAnalyser()` in `player.js` returns the module-level
`<audio>` element; Trace creates a Web Audio `AnalyserNode`
(`fftSize=64`, `smoothingTimeConstant=0.75`) connected to it and
reads 32 frequency bins per RAF tick.

Android: `<audio>` doesn't see ExoPlayer's output, so
`FftAudioProcessor.java` taps PCM inside ExoPlayer's audio sink,
applies a Blackman window, runs a 64-point FFT, smooths magnitudes
on the linear scale BEFORE dB conversion, and emits via the `fft`
plugin event at ~60Hz. JS-side `_onNativeFft` writes into
`_targetBars`; a separate `_renderTick` RAF loop eases `_displayBars`
toward target at `RENDER_LERP=0.08` per frame so the SVG ring stays
fluid even when the WebView's render pipeline jitters.

### Radio station CORS proxy

`/api/radio-proxy?url=...` pipes direct stream URLs through the
server so they're same-origin (required for the Web Audio
visualizer). HLS (`.m3u8`) bypasses the proxy because `hls.js` does
its own XHR and rewriting HLS manifests through a proxy isn't worth
the cost. Server includes SSRF protection: `assertSafeUrl()` resolves
hostnames via DNS and rejects private / loopback / link-local IPs
before any fetch. Link-local + cloud-metadata is always blocked;
loopback + RFC1918 + IPv6 ULA is blocked by default but opt-out via
`ALLOW_PRIVATE_RADIO_URLS=1`.

### Workout-history import

Two-step route: `/api/workout-import/{preview,commit}`. Each app has
its own adapter in `server/lib/workout-import/` (strong.js, hevy.js,
fitnotes.js, jefit.js, garmin-fit.js) producing a canonical
`{ date, name, notes, duration_min, exercises: [{ sourceName, sets, superset_id, superset_size }] }`.
Shared helpers in `common.js` (CSV splitter, weight conversion, name
cleaner + fuzzy matcher). Skip vs replace on duplicate-date workouts.
Unmatched exercise names persist as free-text and the Replace
recovery flow relinks them later.

### Warm-up sets + RPE + exercise substitution

Sets carry an optional `warmup: true` flag. All display counters,
volume, PRs, rest-timer firing, auto-collapse, and superset-round
gating filter warm-ups out. Generator is `generateWarmupSets(W, unit)`
in `src/lib/workout.js`. RPE is `set.rpe: number | null`; chip +
picker lives in `SetRow.svelte`, gated by the `$trackRpe` setting.
Similar-exercise scoring is in `src/lib/exerciseSimilarity.js`,
`primary*3 + secondary - (differentEquipment ? 1 : 0)`, requires
at least one primary overlap. Rendered on ExerciseDetail as a
responsive grid of thumbnails.

### Security posture

- bcrypt cost 12
- Per-username + per-IP login throttling
- Constant-time recovery-token comparison via `crypto.timingSafeEqual`
- Always-200 forgot-password (no enumeration oracle)
- Zip-slip + zip-bomb defense in full-backup restore
- Magic-byte upload validation in `server/lib/image-magic.js`
- `secure: true` cookie default with `INSECURE_COOKIES=1` opt-out
- JSON body limit 1 MB global
- AI chat caps (60 messages / 200 KB)
- Backup `:name` extension guard
- Session duration capped at 1 year via `MAX_SESSION_HOURS`
- JWT_SECRET refuse-to-start in production if unset

## Android Local Mode

LiftTrace on Android runs **standalone (offline-only)** or
**server-connected** at the user's choice. First-launch wizard at
`src/routes/NativeSetup.svelte` picks the mode; Settings, then Mode,
changes it later.

- **Mode toggle:** `lt:nativeMode` in localStorage
- **Fetch interceptor:** `src/lib/apiFetch.js` patches `window.fetch`
  so every existing `fetch('/api/...')` call routes correctly without
  callsite refactor. Three modes: web (relative URL + cookies),
  native + server (absolute URL + Bearer), native + standalone
  (dispatch to `LtApiNative`, synthetic Response)
- **Native API:** `src/lib/api-native.js` implements every server
  CRUD endpoint against local SQLite
- **Local SQLite:** `src/lib/db-native.js` mirrors all 13 server
  tables plus `sync_meta` + `sync_queue`. Each mutable table has
  `updated_at` / `deleted_at` / `sync_state` columns
- **Differential sync:** `src/lib/sync.js` handles push/pull cycles
- **Image cache:** `src/lib/image-cache.js` downloads exercise media
  via Filesystem to `Directory.Data/lifttrace-images/`,
  `resolveAssetUrl()` swaps in local `file://` URIs synchronously
- **WorkManager:** `android/app/src/main/java/com/lifttrace/app/{WorkerScheduler,ReminderWorker}.java`
  optional 15-min periodic worker for native reminders. Off by
  default (gated by `_USE_NATIVE_WORKER` setting); the JS
  LocalNotifications path is the default
- **Settings gating in local mode:** User Management, Email/SMTP,
  Full Backup, Catalog, Workout Import all hidden. `SettingsMode`
  shows mode + sync status + WorkManager toggle
- **Service worker disabled in Capacitor:** `index.html` unregisters
  any existing SW and no-ops `register` when
  `Capacitor.isNativePlatform()`

## Conventions

- **localStorage prefix:** `lt:` (auth token, native mode, server URL)
- **Auth cookie:** `lt_token`
- **Runtime config:** `__LT_CONFIG__` injected on `window`
- **Deep-link scheme:** `lifttrace://`
- **Android app id:** `com.lifttrace.app`
- **Comments:** state the non-obvious constraint or say nothing.
  Skip comments that restate the next line

## Password Requirements

8+ characters with uppercase, lowercase, number, and special character.
Shared validator in `src/lib/validation.js` used across Wizard,
Profile, Reset Password, Accept Invite, and the inline enable-user-management flow.

## Build & Release

```bash
npm run dev                    # local dev server
npm run build                  # PWA build to dist/
npm run android:debug          # vite build + cap sync + assembleDebug
npm run android:open           # open android/ in Android Studio
npm run android:run            # build, sync, and install on connected device
```

`android/keystore.properties` (gitignored) configures release
signing. See `keystore.properties.example` for the format. Debug and
release builds sign with the shared TraceApps keystore so swapping
between them doesn't trigger Android's signature-mismatch reinstall
(which wipes the local SQLite DB).

## Related Docs

- [`ROADMAP.md`](ROADMAP.md), what's planned, what's shipped
- [`CHANGELOG.md`](CHANGELOG.md), per-release notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md), how to open a PR
- [`DEPLOY.md`](DEPLOY.md), full deployment guide (reverse proxies, Cloudflare Tunnel, Docker secrets, Android HTTPS paths)
