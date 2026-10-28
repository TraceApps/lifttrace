# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 5 (compat mode: `runes: false` + `componentApi: 4`), Vite 6, svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3, bcryptjs 3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3002 (host and container)
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
- `android/wear/src/main/java/com/lifttrace/app/wear/`, the Wear OS app: `Session.kt` (every decision the watch makes on its own, pure data in and out, unit-tested), `WearStore.kt` (state plus the outbox), `Pairing.kt` (prefs, cache and the Wearable Data Layer), `LiftApi.kt` (the same day read and written as everywhere else)

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

### Trace assistant (tool use)

Trace calls typed tools instead of relying on a pre-stuffed context
payload. 18 tools live in `src/lib/aiTools.js` (11 read + 7 write):
workouts, exercises, programs, PRs, body stats, coach prescriptions,
plus writers for logging a workout, adding an exercise, appending a
set, logging a body stat, loading a template, switching active
program, and coach-only prescription. Tool execution stays
client-side against `fetch('/api/...')` even in env-locked mode so
the server never gains write access to the user's data. The shared
loop in `src/lib/aiChat.js` allows 12 rounds of tool use per turn across
Claude, OpenAI, Gemini, and OpenAI-compatible providers (and through the
server's `/api/ai/chat`), then sends one last request with the tools off so
the model answers from what it found; it does the same sooner once the tool
answers pass about 300 kB, and calls past that in a round are answered "not
run". `get_workouts` and `get_prs` page with `offset`. The system
prompt in `src/components/ai/Trace.svelte` stays trimmed to a stable
core (persona, weight unit, today's date + day, user profile, active
program name, one-line recent-activity summary); everything else is
fetched via tools on demand.

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

### The watch is a client, not a satellite

`android/wear` is a standalone Wear OS app that talks to the server itself
over the same REST routes the phone and browser use: it reads one day and
writes one day, so the merge on the server is the one already in use. The
phone hands over the address and a token through the Wearable Data Layer and
nothing is typed on the watch. Both APKs must carry the same package name and
signing certificate or the Data Layer silently carries nothing.

Four paths cross the Data Layer, each one record per device, each stamped by
the clock of whoever wrote it, newest wins, and a deletion is the Data Layer
tidying up after a device rather than a signal to act on:

- `/lifttrace/pairing`, the server address and token
- `/lifttrace/timer`, the session stopwatch
- `/lifttrace/rest`, the rest between sets
- `/lifttrace/awake`, written by the watch whenever its app opens, and the
  gate the phone reads before sending a rest: a watch on a charger in another
  room should not be woken for one, let alone buzz

Anything that has to happen with the app off the screen is an AlarmManager
exact alarm carrying a deadline, never something counting; anything repeating
on screen is inside `repeatOnLifecycle(RESUMED)`. Both rules exist because
breaking either one was measurable in the battery stats.

### The web app works offline

`src/lib/offline-api.js` and `offline-edits.js` hang off `apiFetch.js`, so no
screen needed changing. Online, every call goes to the server and the answer
is kept in an IndexedDB mirror. With no server, the mirror answers reads, and
writes go into an outbox that shows at once and is replayed later against the
same routes the Android app replays its queue against, so the server merges a
browser's edits exactly as it merges a phone's. New rows get temporary ids
mapped to real ones after they go up, and creates carry a `client_key`, as
the phone's do (a cardio session, an exercise, a coach's prescription, a new
workout of the day). A create and a delete of the same row both still waiting
cancel out only when the create was never tried; once tried, the server
may have made it with its answer lost, so the delete goes by the create's
key (`DELETE .../by-key/:key`, which also stops a late create making
anything). A server without that route gets the create again, then a delete
by id, except a prescription: a server from before keeps no key for one, so
it would make a second, and the coach is told to remove it again if it shows
instead. A Web Lock stops two tabs sending at
once, and a BroadcastChannel keeps them in step. Not built on Background Sync
(Safari lacks it): the page flushes on a backoff, on `online`, and when the
tab comes to the front.

### Coaching is consent first

`server/lib/coaching.js` holds who coaches whom (`coach_clients`, the same
table NutriTrace uses; the active pairing is mirrored to `users.trainer_id`
for older readers) and the one guard every coach route uses: an active
pairing the client accepted. A request still waiting, an ended pairing and
another coach's client are refused alike, admins included. Roles are read
from the database on every request, not from the token. The conversation
(`server/lib/coaching-messages.js`) is one thread per pairing; its photos sit
under `UPLOADS_PATH/coaching`, outside the public `/uploads` mount, and are
served only to the two people. No Trace tool, MCP tool or token route reads it.

### Private media is never under /uploads

`/uploads` is mounted ahead of the auth check so an Android WebView `<img>`
can load it without a header, which makes anything there readable by URL.
Set videos (`server/lib/set-media.js`) and coaching photos therefore live in
directories kept out of that mount and are streamed through routes that check
the owner (and, for clips, the owner's active coach).

### Links in emails come from PUBLIC_URL

`server/lib/public-url.js` (identical in all four Trace apps) builds the
address in reset, invite, coaching and weekly summary emails from
`PUBLIC_URL`, or else from an address a signed-in admin has used, never from
the request's Host headers, which the sender controls.

### Only the app's own addresses get CORS

`server/lib/cors.js` (identical in all four Trace apps) decides which pages
on another address may call the API with the person's sign-in. Allowed: the
Android app's WebView (`https://app.lifttrace.local`, and
`https://localhost` from versions before it) and the address in
`PUBLIC_URL`, each compared whole: scheme, host and port. Anything else gets
no CORS headers. The web app calls its own address, which needs none;
the API, MCP and the watch app send no Origin.

### Changes from another site are refused

`server/lib/cross-site.js` (identical in all four Trace apps) runs before
every route: a request that changes something (any method but GET, HEAD and
OPTIONS) passes only when the browser's `Sec-Fetch-Site` is `same-origin` or
`none`, or its `Origin` is one CORS allows (above) or exactly the request's
own address (from `X-Forwarded-Proto` and `X-Forwarded-Host`, or Host), or
it carries neither header (the Android app's native code, the watch app,
MCP, the API, scripts, other servers). Browsers always send `Origin` on
these methods (`null` from a sandboxed frame or a page that sends no
referrer), and a page can't change it, so a page on any other address, on
the same site or not, can't send a form, a no-cors fetch or an upload that
changes anything, with or without the sign-in cookie. Anything else gets a
403 (`code: "cross_site"`) and one warning in the log per address. Behind a
proxy that passes neither the public `Host` nor `X-Forwarded-Host`, writes
need `PUBLIC_URL` over plain http (no browser sends `Sec-Fetch-Site` there)
and, over https, from older browsers without it (such as Safari before
16.4). It can't tell apart apps that share one origin (two apps under
subpaths of the same host), and a DNS rebinding page counts as the app's own
address.

LiftTrace has no CSRF token; this is what stops a page on the same site
(another name under your domain, another port on the machine) from using the
sign-in cookie, and a page anywhere from writing to a server without
accounts.

### Update checks are off until asked for

`server/lib/update-check.js`: a fresh database asks in the setup wizard and
checks nothing until someone says yes; a database that already had accounts
keeps checking, as it did before. `UPDATE_CHECK=off` wins over the setting.
Browsers ask the server, which asks GitHub (cached 24 hours); the Android app
asks GitHub itself, only once it was told yes on that phone.

### Security posture

- bcrypt cost 12
- Per-username + per-IP login throttling
- Constant-time recovery-token comparison via `crypto.timingSafeEqual`
- Always-200 forgot-password (no enumeration oracle)
- Zip-slip + zip-bomb defense in full-backup restore
- Magic-byte upload validation in `server/lib/image-magic.js`
- `secure: true` cookie default with `INSECURE_COOKIES=1` opt-out
- JSON body limit 1 MB global
- AI chat caps (60 messages / 8 MB)
- Backup `:name` extension guard
- Session duration capped at 1 year via `MAX_SESSION_HOURS`
- JWT_SECRET refuse-to-start in production if unset
- Changes from another site refused (`server/lib/cross-site.js`, above)

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
- **Differential sync:** `src/lib/sync.js` handles push/pull cycles,
  one at a time, each request with a deadline. Offline writes are
  queued requests replayed in order; a write that names a row the
  server doesn't have yet joins the queue even when online. A row made
  offline has an id below zero until its create goes up, then it and
  every queued write naming it take the server's id; creates carry a
  `client_key` the server dedupes on (`server/lib/create-keys.js`).
  Every row only this device has has an id below zero: made offline,
  made standalone (renumbered when the copy becomes an account's, or
  before an Upload), or everything the account had here after Disconnect
  (`renumberLocalRows`, which also records each row's origin in
  `row_origin` so connecting back to that account puts it back:
  `adoptLocalCopy`); a copy from an earlier version is sorted out once,
  against the server's list (queued creates linked to their rows only on
  an exact match). Moving rows to new ids is one transaction of a few
  dozen statements (`id_remap`), and no sync runs while Disconnect does
  it. So an id above zero always means the server's row. A pull writes over it, or deletes
  it when the server did, except while a queued write is about to change
  it (it asks for those again next time, for up to an hour; after that,
  once the queue has gone up, it pulls everything). Rows below zero are
  never touched by a pull (body stats on a day the server also has are
  merged), and are created on the server, under a key, the first time a
  write names them. The server also sends rows deleted outright
  (`sync_deletions`), the full list of programs and program workouts the
  account may keep, and, without user accounts, the program being
  followed; the pull is gzipped. The local copy, its queue included,
  belongs to one account on one server (`src/lib/local-account.js`,
  tagged with the server's `instance_id` from `/api/auth/status`, its
  address and the user id; a copy from before tags is tagged at startup
  as the account last signed in). App.svelte checks it before showing
  anything: another account clears it (asking first if the previous one
  left changes waiting), the same user id at another address with an
  instance id unknown is asked about, and a sync refuses while it is
  another account's (or might be). Claiming a copy is one at a time. Each sync reads the session once. Before the copy changes
  hands (another account, Connect, Disconnect, sign-out), a running sync
  is stopped and waited for (`src/lib/account-gen.js`: every sync checks
  the number before it writes), and what the app holds in memory for the
  account is reset (`src/lib/user-state.js`). A queued edit carries the
  time it was made (on the server's clock, from the last pull) and the
  fields it changed (`X-Edited-At`, `X-Changed-Fields`); the server keeps
  the newer edit of each field, or group of fields, from each row's
  `field_times` (`server/lib/newer-wins.js`; a create is stamped with its
  own edit time, and updated_at, which housekeeping moves, never counts); a
  delete loses (409) to a later edit of the row. The web app's outbox sends the same headers,
  on the clock from `X-Server-Time`. Sessions come from the
  `Authorization` header before the cookie when it is one of this server's
  (`req.authVia`). Signed out, no sync runs.
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
