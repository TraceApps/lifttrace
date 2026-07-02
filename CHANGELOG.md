# Changelog

All notable changes to LiftTrace are documented here.

---

## v1.0.0-rc.6 — 2026-07-01

### Added

- **Per-Exercise Sharing.** Every exercise now has a Share button in its detail header that produces a portable JSON file. Send the file to another LiftTrace user through any channel (WhatsApp, email, Drive, Signal), and they can tap the file to open it directly in LiftTrace, which prompts them to add the exercise to their library. On the receiving side, the Exercises page's "+" button also offers Import From File and Import From URL, so anyone can pull an exercise from a public URL (raw.githubusercontent.com links work out of the box; github.com/blob URLs are auto-rewritten). Enables community exercise libraries in a lightweight way: a public repo of JSON files, and users can bookmark or share individual links.

- **CSV Workout Export.** The Workout Summary sheet gains a download button that produces a long-format CSV (one row per set) with date, exercise, set number, reps, weight, RPE, warmup flag, completion state, and per-set / exercise / workout notes. Unilateral splits become two rows so left and right stay separate. PWA downloads directly; Android writes the file to Cache and opens the system Share sheet. Made for anyone feeding an external analysis pipeline or spreadsheet.

- **Custom Equipment.** Add your own equipment types (Slackboard, Sandbag, Weight Vest, whatever's in your home gym or hotel gym) via a new "+ Add" pill in the Exercise Editor's equipment picker. Custom entries sync across devices via your LiftTrace account. They also appear as dashed-border chips in the Exercises filter row when at least one exercise uses them.

- **Multi-Select Equipment Filter** on the Exercises page. The equipment chip strip used to be one-at-a-time; it's now multi-select, so you can pick everything you have access to today (Barbell + Dumbbell + Bodyweight when you're travelling and the hotel gym is bare) and filter the library to only exercises that match. Selection persists across navigation.

### Changed

- **Animated Banner Redesigned.** Setting Banner Style to Animated used to show illustrated SVG art in every page's header. Those had cross-viewport rendering issues on narrow phones (the art crowded the title and hid action buttons on the Exercises page), so they've been replaced with the same compact accent bar as Gradient plus a subtle motion effect. Pick which motion under Settings → Appearance → Banner Animation: Shimmer (soft white sweep, default), Drift (slow hue rotation), Pulse (brightness breathing), or Aurora (overlapping accent clouds). All four honour Reduce Motion. If you're upgrading from rc.5 with Animated selected, the setting name stays the same but the look is new. The compact bar also reclaims about 40 pixels of vertical real estate on every page.

- **Trace FAB Visualizer Feels Snappier on Android.** The frequency ring around the AI coach FAB now tracks music dynamics with the same amplitude as it does on the PWA. It was previously over-damped because two smoothing layers stacked instead of one, leaving the bars perpetually chasing shrinking targets.

### Fixed

- **Cross-Device Workout Save Race.** When editing the same workout from two devices near-simultaneously (phone + PWA), a save would sometimes clobber the other device's just-completed sets with a stale in-memory snapshot. The workout store now refetches and merges before writing, so both devices' edits survive.

- **Password Manager Password Generation.** Browsers and password managers now correctly generate passwords that satisfy LiftTrace's policy (uppercase + lowercase + digit + special character, 8+ chars) when signing up, accepting an invite, resetting a password, or changing one from Profile. Previously the "suggest strong password" flow produced passwords without a special character, which the field then rejected.

---

## v1.0.0-rc.5 — 2026-06-10

### Added

- **Scheduled Automatic Backups** for both server mode and Android local-only mode. Pick daily or weekly, server backups land in the same directory as manual full-backups, local-mode backups export the device's SQLite mirror to the share sheet. Configure under Settings → Backup → Schedule.
- **Multi-Architecture Docker Image**. The public image at `ghcr.io/traceapps/lifttrace` now ships both `amd64` and `arm64` builds, so Raspberry Pi 4 / 5 and other ARM self-hosters can `docker compose up -d` without building from source.
- **Default Session Length Raised** from 30 days to 1 year so PWA users stop getting signed out every month. Admins can still set their own session length under Settings → User Management → Session Length.

### Changed

- **Better Biometric Failure Path** on Android. When a stored auth token has expired, biometric sign-in now surfaces a clear "Session Expired" prompt instead of silently bouncing back to the Login screen with no explanation.

### Fixed

- Sync no longer clobbers local pending edits during a pull. If a workout or setting was edited locally and not yet pushed to the server, an incoming server pull no longer overwrites it with older data.
- Sync now clears local auth state on a 401 response so the user gets prompted to sign in again, instead of the app looping silently on every subsequent request.

### Docs

- The `INSECURE_COOKIES` env var is now called out inline in the example `docker-compose.yml` with a comment explaining the exact symptom (every request 401s after a successful login because the browser drops the `Secure` cookie over plain HTTP). README troubleshooting entry expanded with the Firefox console message that confirms the diagnosis. Closes the gap that surfaced as issue #4.

---

## v1.0.0-rc.4 — 2026-05-29

### Added

- **NutriTrace Federation** — log each completed workout's estimated calories burned to your NutriTrace diary automatically. Set it up in Settings → Integrations → NutriTrace by entering your NutriTrace URL and an API token (created on NutriTrace under Settings → User Management → API Tokens with the `write:workouts` scope). Workouts show up in NutriTrace's Workout History next to Fitbit / Garmin data, and NutriTrace handles the double-count-vs-wearable decision automatically.
- **Editable Workout Duration** on the completion summary. The Duration tile is now a button: tap it to pick from quick presets (30 / 45 / 60 / 75 / 90 / 120 min) or enter a custom value. Useful when you forgot to start the timer, or to fix a value after the fact. The kcal estimate updates live, and if NutriTrace federation is on, the edit re-syncs.
- **Fallback Calorie Estimate** when no duration is tracked. LiftTrace now estimates burn from your completed set count instead of refusing to show a number. Badged "rough" so you know it's less precise than a timed session.
- **"You're All Set" Celebration** at the end of the first-run wizard before landing on the diary.
- **Shared Loading Spinner** across Diary, Programs, Coaching, Exercise detail, Statistics, and Workout editor. No more plain "Loading…" text.

### Changed

- **Stronger Edit Affordance** on the Workout Summary Duration tile: accent-tinted background, accent border, and a clear edit pencil so it reads as tappable next to the read-only stats.
- **Persistent Connected Pill** on the NutriTrace federation card. Once verified, the green status pill stays visible until you edit the URL or token, instead of disappearing when you navigate away.
- **Title Case Sweep** across about 20 button labels, menu titles, and section headers that were inconsistently sentence-cased (Clear All Settings, Mark All Seen, Delete User, Add to Favorites, etc.).
- **i18n**: 7 new common error strings now route through translation, plus the create-admin form in Settings → User Management.

### Fixed

- **Settings → Backup** silently failing when the backup list endpoint returned an error, leaving the user with an empty list and no explanation. Now surfaces a toast with the underlying message.
- **Radio** showing an empty grid when Subsonic / Jellyfin was unreachable. Now shows "Couldn't reach your media server" with a Retry button so the failure mode is obvious.
- **Workout Complete notification** firing on every set toggle when re-opening a completed workout's summary (rc.3 caught the main flow; this patches the toggle edge case).

---

## v1.0.0-rc.3 — 2026-05-25

### Fixed

- **Fresh Docker install crashed on first boot** with `SqliteError: no such table: coach_activity` (issue #2). A migration that adds a column to `coach_activity` was running *before* the `CREATE TABLE` for it, so any database that had never seen an earlier LiftTrace beta would fail to start. Existing installs (which had the table from an earlier beta) were unaffected. The ALTER is now ordered after the CREATE, so `docker compose up` works on a clean volume.

---

## v1.0.0-rc.2 — 2026-05-25

### Added

- **Gradient banner style** as a third option for Settings → Appearance → Page Banners (between Animated and Off). A compact-height header filled with your active accent color over a subtle glass overlay; header action icons pick up a matching frosted-glass pill so they stay legible against the saturated background.

### Changed

- **Page Banners default for new installs is now Gradient** instead of Animated. Existing users keep whatever they had; the new default only applies to users finishing or skipping the first-launch wizard.
- **Goal Celebrations toggle moved** from Settings → Workout to Settings → Appearance, next to Reduce Motion. Same toggle, same behavior; the move groups all visual-effect controls together and matches NutriTrace's layout.
- **Notification Delivery card simplified.** Push service status shows a single "Configured" pill with one Test button at the top of the card, instead of a separate subtext block and Send-Test row.

### Fixed

- **Re-opening a completed workout summary no longer re-fires the "Workout Complete" notification.** Tapping "View Workout Summary" on a previously-completed session now just opens the summary, instead of re-running the celebration / save / timer-reset path. Affects both local notifications and any configured push service (Gotify, ntfy, Apprise). Also stops the same path from clobbering today's running rest timer if you opened a past day's summary mid-session.

---

## v1.0.0-rc.1 — 2026-05-24 — First public release candidate

LiftTrace goes public. The dev tree (`TraceApps/lifttrace-dev`) has
been syncing to the public mirror at `TraceApps/lifttrace` since this
release. Same app, just an open repo and signed Android APK in
GitHub Releases.

What you get out of the box (since the first private build):

- **Diary** — daily workout log with sets, reps, weights, RPE, warm-ups,
  supersets, rest timer with persistent state across navigation, and
  Smart Add for natural-language entry.
- **Programs** — build mesocycles, assign templates by day, progress
  through weeks. Coach prescriptions flow into Diary automatically.
- **Exercises** — full library (wger / free-exercise-db / exercisedb)
  plus your own custom exercises with images, GIFs, or YouTube.
- **Statistics** — volume, PRs, frequency, body stats trends.
- **Trace AI** — multi-provider coach (Claude / OpenAI / Gemini / any
  OpenAI-compatible endpoint) with live workout context, hold-to-voice
  log on the FAB, frequency visualizer ring when music plays.
- **Radio** — built-in player for Subsonic / Jellyfin libraries and
  streaming Icecast / Shoutcast / HLS internet radio with now-playing
  metadata. Plays through ExoPlayer on Android (lockscreen + media
  controls), MSE on web (gapless, locked-screen-safe).
- **Coaching** — trainer accounts can build templates and prescribe
  workouts to athletes. Prescriptions show in Diary on the right day.
- **OIDC SSO** — sign in via Authentik, Keycloak, Pocket ID, Authelia,
  Auth0, Google, or any OIDC 1.0 provider. Multi-provider supported.
- **Workout-history import** — bring in your old log from Strong, Hevy,
  FitNotes, or Jefit (CSV).
- **Multi-user** — invite by email or link, sessions configurable up to
  one year, admin / trainer / user roles, OIDC group → role mapping.
- **Wearables-style biometric sign-in** on Android (fingerprint / face).
- **Local + server modes on Android** — run fully offline with on-device
  SQLite, or connect to a self-hosted LiftTrace server for sync.
- **Smart Log** — paste a workout in plain English ("bench 3x5 @ 225,
  A1: curls 3x12 @ 30, A2: pushdowns 3x12 @ 40") and it gets parsed,
  matched against the library, and saved.

This is a release candidate, not a final 1.0. Expect bugfixes and
polish in the `-rc.N` series before the `1.0.0` tag drops.

### Security — Android release builds now reject cleartext HTTP

The release-signed APK distributed via GitHub Releases enforces a
strict network security policy: only HTTPS connections to your
LiftTrace server are allowed, and only system-installed CAs are
trusted. This protects auth tokens (JWT cookies and Bearer headers)
from interception on untrusted networks like public WiFi.

If you self-host on plain HTTP (LAN-only, no TLS), you have four
options spelled out in [DEPLOY.md](DEPLOY.md) → "Connecting from
Android":

1. Real domain + Let's Encrypt (recommended).
2. Cloudflare Tunnel / Tailscale Funnel / Tailscale mesh.
3. Self-signed cert + install your CA on Android.
4. Build the debug APK yourself — `npm run android:debug` produces
   a permissive APK that accepts `http://` and self-signed certs.
   Sideload it instead of the release APK.

Server-side, `INSECURE_COOKIES=1` continues to opt out of the
HTTPS-only auth-cookie flag for non-TLS server deployments.

## v0.10.1-beta.5 — 2026-04-30 — OIDC Single Sign-On

LiftTrace now supports OpenID Connect SSO. Sign in via Authentik,
Keycloak, Pocket ID, Authelia, Auth0, Google, or any OIDC 1.0
provider that supports Authorization Code Flow + PKCE + Discovery.

What you get:

- **Multiple providers** — admins can configure as many IdPs as
  they want from Settings → User management → OIDC providers.
  Each one gets its own button on the Login page.
- **Provider preset picker** — when adding a provider, pick from
  Auth0, Authelia, Authentik, Google, Keycloak, Pocket ID, or
  Custom. Each preset pre-fills sensible defaults (scope, auth
  method, group claim).
- **Auto-link verified emails** (default ON) — when an IdP says
  `email_verified=true` and the email matches an existing
  LiftTrace user, the accounts link silently on first SSO sign-in.
- **Auto-register new users** (default OFF) — opt in for blanket
  onboarding. Leave off for shared IdPs (Google, work SSO).
- **Admin role mapping** — pin an "admin" group claim and value;
  membership promotes the user to admin on every login.
- **Profile → Linked accounts** — sign in with your password,
  then link an SSO provider from your Profile so next time you
  can use either.
- **Allow password login toggle** — disable password login
  entirely once SSO is configured. `RECOVERY_TOKEN` still works
  as the lockout escape hatch.
- **Android support** — SSO works on the native app too, via
  Chrome Custom Tabs and a `lifttrace://oidc-callback` deep link.

Client secrets are encrypted at rest. Discovery is cached for an
hour. PKCE + state + nonce are validated on every callback.

### UX polish in the same release

- **No more theme flash** — the app no longer reapplies
  accent/dark-mode every 30 seconds when settings poll.
- **Diary stops re-fetching on every nav** — switching tabs no
  longer causes a brief meal-card flash if the data is already
  loaded for today.
- **Settings text fits** — long labels in OIDC and elsewhere no
  longer push toggles or action icons off-screen.

### For self-hosters

Backups now include OIDC providers and per-user links. The
`client_secret` column stays encrypted in the dump; restoring
to a host with a different `JWT_SECRET` (and no `TOKEN_ENC_KEY`
override) will require re-entering secrets in Settings.

---

## v0.10.1-beta.4 — 2026-04-28 — Real FFT visualizer on Android

The FAB equalizer ring now mirrors the PWA: real frequency-domain
data driven directly off the audio that's playing, not procedural
sine waves.

The previous Android path used `android.media.audiofx.Visualizer` to
sniff the ExoPlayer audio session, but on most recent Pixel /
Samsung ROMs that service returns `INIT_CHECK_FAILED (-3)` for
media-output sessions regardless of how the session is allocated —
the OS audio policy blocks it. We had a procedural sine-wave
fallback so the ring stayed lively, but the bars no longer reacted
to the actual music.

Fix: tap the PCM stream inside ExoPlayer's own audio sink via a
custom `AudioProcessor` (`FftAudioProcessor.java`). It accumulates
samples into a 256-frame window, applies a Hann window, runs a
Cooley-Tukey FFT, packs the bins into the same byte layout
Android's `Visualizer.getFft()` produces, and emits at ~30Hz. The
JS-side `_decodeFft` parser doesn't need to change.

Why it always works now: the processor lives inside our decoder
pipeline, before the audio hits `AudioTrack`. No system service or
permission involved. Drop-in for every device where ExoPlayer plays
sound.

The legacy `Visualizer` attempt is left in place as a parallel
source — if a device happens to allow it, both feeds run and the
visualizer just keeps the most recent frame. The procedural
fallback in `src/lib/native-player.js` stays too as a last-resort
safety net (it auto-disables the moment a real FFT frame arrives).

---

## v0.10.1-beta.3 — 2026-04-28 — i18n parity batch (192 keys)

Continues the parity push toward NutriTrace's 210-key baseline by
extracting the strings that surface across the most-used UI shells —
the dialog primitives, the Trace FAB, and the Diary action toasts /
date-nav buttons.

Newly wired through `$_()`:

- `Sheet.svelte` — close button label + tooltip via `common.close`.
- `ActionSheet.svelte` — sheet cancel button via `common.cancel`.
- `Trace.svelte` — FAB aria-label + tooltip (`trace.fab_label`,
  `trace.fab_tooltip`), the chat clear button (`trace.clear_conversation`),
  the close icon, the attach-image button, and the input placeholder
  (`trace.ask_placeholder`).
- `Diary.svelte` — the workout-name placeholder, tap-to-rename tooltip,
  the four date-nav buttons (previous / next / jump-to-date / today),
  the six action-button labels (gym tools, body stats, workout actions
  +`_long` aria-label variants), seven action toasts (cleared, timer
  reset, copied, four superset state changes), and two error toasts
  (no workout yesterday, copy failed).

Net new keys: 26 (`diary` + `trace` blocks). en.json now at 192 keys.
Bridges roughly half the remaining gap to NutriTrace's en.json.

---

## v0.10.1-beta.2 — 2026-04-29 — i18n thorough wiring (166 keys)

beta.1 created the i18n keys but didn't wire most of them into
components. This beta does the actual extraction so a translator
copying en.json to fr.json and picking Français in Settings → Units
sees real strings flip live, not just the language picker label
itself.

Surfaces wired through \$_():

- BottomNav: 6 nav labels (Diary / Exercises / Programs / Stats /
  Radio / Settings).
- Sidebar: same nav labels + sign-out tooltip.
- All 7 main route page titles (Diary, Exercises, Programs, Statistics,
  Coaching, Settings, Profile) plus the Profile page's save button.
- All 15 settings section headers in their respective Settings*.svelte
  sub-components (Appearance / Workout / Statistics / Trace / Radio /
  Catalog / Backup / Notifications / Email / Users / Mode / Workout
  Import / Diagnostics / About / Units).
- SettingsAppearance: Theme / Accent / Navigation labels.
- SettingsUnits: Language picker label.
- Login: subtitle, all field labels + placeholders, sign-in button
  with loading state, forgot-password + locked-out toggles, full
  recovery box copy (explainer / prompt / action / disabling state),
  success copy, all error toasts.
- ForgotPassword: title, intro, email label, send-link button, sent
  confirmation with email interpolation, errors.
- ResetPassword: title, validating + invalid + success states, set-for
  username interpolation, password labels + strength placeholder,
  submit + saving states, errors.
- AcceptInvite: title, validating + invalid + success states, intro
  variants (with/without prefilled email), all four field labels +
  placeholders, submit + creating states, errors.
- Profile: Personal Info / Security headers, Full Name / Email /
  Nickname / Birthday / Gender labels + placeholders, gender-unset
  option, password change flow (current + new + confirm labels,
  change-password button with loading state, save + password-changed
  toasts).
- Wizard: nav buttons (Back / Next / Get Started / Skip / Let's go),
  all 6 step titles + descriptions, both variants of the usermgmt
  step (forceAccountCreation vs multi-user toggle), all step-specific
  field placeholders + button labels + interpolated progress messages
  for the library import, theme picker labels.

en.json holds 166 keys. Server-side strings, Diary primary actions,
exercise editor / smart-log / per-route deep extraction still pending —
those land as volunteer translators identify which screens they need.

---

## v0.10.1-beta.1 — 2026-04-28 — i18n, subpath, Docker secrets, shared DatePicker

Ports four patterns from NutriTrace's v1.0.0-rc.6 release. None affect
existing deployments by default — every feature opts in via env var or
component swap.

### Added

- **Internationalization (i18n) scaffolding.** `svelte-i18n` wired up with
  one JSON file per locale under `src/i18n/`. Language picker added at the
  top of Settings → Units & Format. en.json covers 45 keys — nav labels,
  page titles for the 11 main routes, all 15 settings section headers, and
  common buttons (Save, Cancel, Delete, etc.). New `npm run i18n:check`
  script reports per-locale completeness. Deeper extraction (workout
  editor strings, smart-log modal, exercise editor, settings sub-section
  internals) follows in subsequent batches as volunteer translators
  request specific screens.

- **Reverse-proxy / subpath support via `BASE_URL` env var.** Lets users
  mount LiftTrace at `/lifttrace/` or any other prefix without URL
  rewriting in the reverse proxy. Server mounts all middleware + routes
  inside an Express sub-router at the prefix; client reads basePath from
  `window.__LT_CONFIG__` injected at HTML serve time. Default empty
  `BASE_URL` is identical to pre-feature behavior. Vite `base: './'` so
  asset URLs are relative; PWA manifest `start_url`/`scope` are `'./'`
  for subpath PWA install. `apiFetch.js` interceptor extended to also
  run in PWA mode when basePath is set, prefixing `/api/` and
  `/uploads/` URLs — single point of interception means no per-call-
  site changes were needed.

- **Docker / Swarm-style secret file env vars.** New
  `server/docker-entrypoint.sh` reads any `*_FILE` env var at container
  startup, loads the referenced file, and exports the value as the
  corresponding env var before Node starts. Covers `JWT_SECRET_FILE`,
  `RECOVERY_TOKEN_FILE`, `SMTP_PASS_FILE`, `AI_API_KEY_FILE`. Errors
  loudly if both `NAME` and `NAME_FILE` are set or if the file is
  unreadable.

- **Shared `DatePicker` + `DateInput` components.** New
  `src/components/ui/DatePicker.svelte` calendar (month/year nav,
  year/month grid pickers, day grid, locale-aware), and
  `src/components/ui/DateInput.svelte` wrapper combining a masked text
  input + calendar trigger button. Manual date entry is masked: only
  digits accepted, separators auto-inserted in the user's chosen format
  (ISO/US/EU), capped at 8 digits. Profile birthday now uses DateInput
  instead of the browser-native `<input type="date">`.

### Fixed

- Static asset references in components (Sidebar brand icon, all auth
  screens' logos, NativeSetup logo, Settings → About icon) used absolute
  `/icons/...` paths and would have 404'd at subpath. All now route
  through `resolveAssetUrl()` which prefixes with basePath in PWA mode.

### Notes

- LiftTrace doesn't have CSRF middleware (only auth.js in
  server/middleware/), so the CSRF rejection bugs that affected
  NutriTrace's settings.js + login flow during its rc.6 testing don't
  apply here. The fetch interceptor handles apiUrl consistency without
  any per-call-site changes — much simpler than NutriTrace's pattern.
- LiftTrace's wizard is structurally simpler than NutriTrace's (6 steps,
  no dob/gender duplicate, already uses Trace branding). No wizard
  cleanup pass needed.

---

## v0.10.0-beta.9 — 2026-04-28

### Fixed — Native auth bearer token never being stored
beta.8 taught the server to read the JWT from `Authorization: Bearer …`,
but two upstream gaps meant the token was never actually being set in
localStorage on native, so the header always went out empty:

1. **Server `/api/auth/login` only set a cookie**, never returned the
   JWT in the response body. NativeSetup called
   `setAuthToken(data.token)` → `data.token` was `undefined` →
   `localStorage.removeItem('lt:authToken')`. Same for `/register`,
   `/reset-password`, `/accept-invite`.
2. **Login.svelte (the regular login screen) didn't call
   `setAuthToken` at all** — only relied on the cookie. So when a user
   got bounced from NativeSetup → loadAuthState 401 → Login screen,
   even a successful re-login left no token stored, and every
   subsequent API call landed unauthenticated.

Fix:
- Server: `/login`, `/register`, `/reset-password`, `/accept-invite`
  now return `{ user, token }` in the response body. Cookie still set
  for browser PWA path; bearer token now available for native.
- Client: `Login.svelte` + `Wizard.svelte` + `ResetPassword.svelte` +
  `AcceptInvite.svelte` now call `setAuthToken(data.token)` after a
  successful response.

Server redeploy required AND new APK install. After both, the
NativeSetup → migrate path stops bouncing to Login, and the regular
Login screen actually persists the bearer token across launches.

---

## v0.10.0-beta.8 — 2026-04-28

### Fixed — Native Android server-mode authentication
The server's `authenticate` middleware was reading the JWT only from the
`lt_token` cookie. Native Capacitor builds use the patched fetch in
`src/lib/apiFetch.js`, which sends the JWT as `Authorization: Bearer …`
and explicitly sets `credentials: 'omit'` so cookies don't ride along
(WebViews don't reliably persist cross-launch cookies). Result: every
authenticated request from the Android app was hitting `req.cookies` =
nothing → server replied 401 "Not authenticated" → migration uploads
silently dropped, sync pulls cached as failures, and `loadAuthState`
returned a null user even though the token was valid.

Server middleware now accepts the token from EITHER the cookie OR the
Authorization header — same pattern NutriTrace already uses. Browser
PWA builds keep working off the cookie; native Android works off the
Bearer header.

Server redeploy required (`docker compose pull && up -d` or equivalent).
The Android APK doesn't need rebuilding — it was already sending the
header correctly; the server just wasn't reading it.

---

## v0.10.0-beta.7 — 2026-04-27

### Added — Standalone → server data migration
First-launch wizard (and Settings → "Connect to server") now detects local
SQLite data when transitioning out of standalone mode and presents a
three-option dialog before silently switching modes:

- **Upload to server** — push every local row through the existing
  `PUT /api/workout/:date`, `PUT /api/body-stats/:date`, `POST /api/programs`,
  `POST /api/templates`, `POST /api/exercises`, `PUT /api/settings`
  endpoints. Workouts and body-stats use `UNIQUE(user_id, date)` for
  clean dedup; programs and custom exercises accept duplicates.
- **Replace with server** — destroy the local SQLite (via existing
  `destroyLocalDb`) and let `pullSnapshot` repopulate from the server.
- **Merge both** — upload local first, then run `runSync()` to refresh
  the local cache so the UI reflects the merged state.

The dialog shows per-table counts up front (`12 workouts, 8 body-stats
entries, 3 programs (12 templates), 5 custom exercises`) and the
upload pass shows live progress + a final success/error tally per
table — both improvements over the silent NutriTrace pattern this
mirrors. New helper at `src/lib/migrate.js`.

### Internal — Material Symbols bundled locally (v0.10.0-beta.6 hotfix)
The icon-name FOUT on Android cold-launch ("menu", "fitness_center",
etc. flashing as text before the font arrived) is fixed by bundling
the Material Symbols Rounded variable woff2 into `public/fonts/` and
declaring an `@font-face` with `font-display: block`. Inter stays on
Google Fonts since the system-ui fallback is cosmetically fine.

---

## v0.10.0-beta.6 — 2026-04-27

### Changed — Unified Android playback on Media3 ExoPlayer
Radio AND library tracks (Subsonic / Jellyfin / local) now both flow
through the same native ExoPlayer + MediaSession. Replaces the prior
split where streams went native and library tracks went through the
JS MSE pipeline + capacitor-music-controls plugin. Wins:

- **One MediaSession** — eliminates the dual-session bug that caused
  intermittent dead lockscreen taps and notification flicker.
- **One notification UX** across radio + library. Lockscreen swaps
  between [Stop] (live radio) and [Prev | Next | Stop] (library) via
  Media3's custom command layout.
- **Native ExoPlayer for everything** — same decoder that already
  works for HE-AAC/HLS/iHeart now also plays Jellyfin/Subsonic streams
  with HTTP/2 + redirect handling out of the box.
- **`audiofx.Visualizer` ring on every track** (not just radio).
- **Drops capacitor-music-controls-plugin** — kills the package we
  had to monkey-patch around (NPE in Java + Capacitor 8 thenable bug).

The Web PWA path is unchanged — `<audio>` + MSE + Web Media Session
API still drive the desktop / mobile-browser experience.

### Added — RDS Italia + HLS-ID3 metadata parsing
- ID3 `TextInformationFrame` (TIT2 / TPE1) entries from `HlsMediaSource`
  are now collected and emitted as combined "Artist - Title" — unlocks
  metadata for RDS Grandi Successi, RDS Next, and any HLS broadcaster
  that publishes timed ID3 tags.
- New `Song*<title>*<artist>*<year>*<uuid>` parser added to all three
  sanitizers (Java, JS, server) — clean output for RDS Relax and other
  RDS Italia format streams. `Spot*…` / `Ad*…` payloads are dropped so
  the previous song stays on the lockscreen during ad breaks.

### Fixed — PWA stream RDS now reaches the lockscreen
The now-playing poll updated only the in-app stores; the OS-level
Media Session metadata stayed frozen on the station name. New
`_updateStreamMediaSession` pushes the parsed title/artwork onto
`navigator.mediaSession.metadata` on each poll tick.

### Fixed — PWA rest timer silent when backgrounded
`Notification.requestPermission()` was called from inside `_finish`'s
setTimeout — not a user gesture, so the prompt silently no-op'd and
permission stayed `default` forever. Moved the request to `startRest`
which fires from a real set-checkbox tap, so the SW notification path
actually has permission to vibrate / sound when the timer hits 0.

### Fixed — Lockscreen / notification controls on Android
- Self-hosted MediaStyle notification posted in `onStartCommand`
  (always shows, beats the 5-second `startForeground` deadline).
- Stop button via Media3 custom session command + `setCustomLayout`.
- Skip-prev / skip-next arrows stripped for radio (live streams have
  no playlist) but re-added for library tracks.
- `MediaStyleNotificationHelper.MediaStyle` for proper session binding.

### Internal — `RadioPlayerPlugin` foundation expansion
- `play()` accepts pre-fill metadata (title/artist/album/coverUrl)
  + per-request HTTP headers (Authorization Bearer for Subsonic /
  Jellyfin auth).
- New `seek(positionMs)` plugin method.
- New 250ms position ticker emitting `{ position, duration }` so JS
  scrubbers / remaining-time displays can drive off the same data.
- New `setLibraryLayout(boolean)` toggles the lockscreen action set.

---

## v0.10.0-beta.5 — 2026-04-26

### Fixed — Rest timer keeps counting after workout finish
The auto-finish path saved `completed: 1` and fired the celebration but
left any in-flight rest timer running. Now `stopRest(false)` is called as
part of the finish so the timer pill / lock-screen notification clears the
moment the workout's done.

### Improved — Background countdown vibrates / notifies
When the page is backgrounded the browser suspends Web Audio, so the
3-2-1 countdown beeps were silent. `_countdownCue` now falls back to a
Service Worker notification (silent + vibrate, tagged so successive ticks
replace the prior) when `document.visibilityState === 'hidden'`. The
audible "Rest complete" notification at 0s is unchanged. Net: in-pocket
countdown haptic feedback works without unlocking the phone.

### Added — Editable set number / asymmetric superset support
The "Set N" label on each row is now tappable (Diary) / editable (Workout
Editor). User picks an explicit round number (1-8) which is persisted as
`set.number`; auto-default behavior is unchanged for anyone who never
touches it.

The round-gate logic in `_shouldStartRest` rewrites to operate on `number`
instead of completed-set-count: round N is "done" across a superset when
every exercise that **has** a set numbered N has it completed. Exercises
without a set at round N are skipped — the addon pattern.

Use case (from user): superset where Exercise A has 3 sets, Exercise B is
an addon on round 2, Exercise C is an addon on round 3. Edit B's set to
"2" and C's set to "3"; rest now fires correctly after each round.

Template authoring: WorkoutEditor's per-set rows replace the static `#1`
display with a small numeric input, custom values get an accent-colored
border so the addon structure is visible at a glance. The `set_specs`
JSON gains an optional `number` field that propagates from template to
diary on workout load. Templates without explicit numbers behave
identically to before.

---

## v0.10.0-beta.4 — 2026-04-26

### Refactor — "Help Improve LiftTrace" → "Diagnostics" (parity with NutriTrace v0.39.36+)
Internal section key (`helpImprove`) kept as-is to avoid touching openSections /
toggleSection wiring; rename is purely UI + file-level.

- File: `SettingsHelpImprove.svelte` → `SettingsDiagnostics.svelte` (via `git mv`,
  history preserved).
- Section header: "Help Improve LiftTrace" → "Diagnostics". Icon:
  `volunteer_activism` → `troubleshoot`.
- Search keywords: `'help improve diagnostics logs verbose bug'` →
  `'diagnostics logs verbose bug troubleshoot'`.
- Code-comment references in `src/lib/{log-capture,sync,db-native,notifications}.js`
  updated from "Settings → Help Improve LiftTrace" → "Settings → Diagnostics".
- LiftTrace doesn't have a calibration export feature (NutriTrace-specific);
  this rename is just about the section label.

---

## v0.10.0-beta.3 — 2026-04-26

### Changed — AI Assistant label parity with NutriTrace
Both apps now share the exact same AI Assistant section UX. The brand name
"Trace" appears only as the default value of the user-customizable assistant-
name field, so customizing it doesn't leave stale labels around the rest of
the UI.

- Settings → AI Assistant section toggle "Enable Trace" → "Enable AI Assistant".
- Section description "Floating AI coach with chat + image attachments" →
  "Adds a floating chat button to all pages" (matches NutriTrace).
- Stale "Settings → FitBot AI" copy in `aiChat.js` error message → "Settings → AI Assistant".
- Section header label "Trace AI" → "AI Assistant".
- Migration in `App.svelte` onMount: existing installs on the legacy default
  name `'LiftBot'` are auto-bumped to `'Trace'`. Custom names persist.

---

## v0.10.0-beta.2 — 2026-04-26

### Renamed — LiftBot is now Trace
The AI coach is renamed from "LiftBot" to "Trace" so the same persona ships
across both LiftTrace and NutriTrace under the TraceApps umbrella brand.

- New friendly face: `src/components/ai/TraceFace.svelte` — port of
  NutriTrace's FitBotFace (rounded head, blinking eyes, pulsing antenna,
  twinkling cheeks, idle smile bob). Replaces the lifting-themed
  `LiftBotFace` (barbell arm + body) so the visual identity is brand-
  neutral and identical across the two apps.
- Renamed: `LiftBot.svelte` → `Trace.svelte`,
  `LiftBotFace.svelte` → `TraceFace.svelte`,
  `SettingsLiftBot.svelte` → `SettingsTrace.svelte`.
- All UI strings: "LiftBot" → "Trace" (Settings section, toggle label,
  assistant-name placeholder default, FAB aria-label).
- Settings store key `aiAssistantName` default flips from "LiftBot" to
  "Trace". User-set custom names persist unchanged.
- LiftTrace-specific features kept intact: music-driven frequency visualizer
  ring around the FAB, hold-to-record voice → Smart Log, workout-context
  injection in the system prompt.
- Docs (README.md, FUTURE.md) updated for the new name.
  Historical CHANGELOG entries preserve "LiftBot" as the original name.

---

## v0.10.0-beta.1 — 2026-04-26

### Native Android app — initial scaffold (Capacitor 8)
The big architectural shift: LiftTrace now wraps the same Svelte PWA in a
Capacitor shell so it can run as a native Android app. Mirrors the
NutriTrace pattern: standalone-or-server modes, full local SQLite mirror,
native WorkManager reminders, offline-first writes with retry queue.

#### Mode selection
- First-launch wizard (`src/routes/NativeSetup.svelte`) offers **Use Locally**
  (offline-only, single-user) or **Connect to Server** (URL + login → JWT).
- Mode persists in `localStorage` (`lt:nativeMode`, `lt:serverUrl`,
  `lt:authToken`). Switch back via Settings → App Mode.
- Server-only sections (User Management, Email/SMTP, Full Backup, Catalog,
  Workout Import) hidden in standalone mode; UI surfaces an "offline" hint
  for endpoints that require a server.

#### Local SQLite mirror
- 13 server tables mirrored 1:1 in `src/lib/db-native.js` plus `sync_meta`
  + `sync_queue` infra tables. Each mutable row carries `updated_at`,
  `deleted_at`, and `sync_state` columns the server schema doesn't have so
  the sync engine can detect diffs without server-side schema changes.
- `LtApiNative` (`src/lib/api-native.js`) implements every server CRUD
  endpoint against the local database — exercises, programs, templates,
  workout_log, body_stats, settings, stats, ai chat history.
- Endpoints that genuinely require a server (image proxy, full-backup ZIP,
  sync-wger, radio-proxy, subsonic, file uploads) throw a friendly 501 the
  Settings UI can render as "offline only".

#### Fetch interceptor (drop-in routing)
- Patched `window.fetch` (`src/lib/apiFetch.js`) routes every existing
  `fetch('/api/...')` call without callsite refactor: rewrites to absolute
  URL + Bearer in server mode, dispatches to LtApiNative in standalone.
- On network failure in server mode: GET falls back to LtApiNative cache;
  POST/PUT/DELETE enqueue in `sync_queue` and mirror to local cache so the
  UI stays consistent (returns synthetic 202).

#### Differential sync
- `pullSnapshot()` refreshes the local cache from server list endpoints
  (settings, exercises, programs, last 200 workouts, last 90 days of
  body stats). Single-shot replace — no diff yet, cheap enough for personal
  use.
- `flushQueue()` replays queued writes; 4xx responses drop the entry,
  5xx / network errors increment `attempts` and retain.
- `startBackgroundSync()` wires `online` and `visibilitychange` events so
  the queue flushes + cache refreshes on reconnect / app foreground.

#### Native notifications
- `src/lib/notifications.js` now routes through `@capacitor/local-notifications`
  on native (Web Notification API on PWA).
- `scheduleNativeReminders()` schedules daily-repeating workout / rest day /
  streak / weekly-summary reminders directly via the OS so they fire even
  when the app is closed. Re-runs on every `wl:setting` change.
- Push services (Apprise / Gotify / ntfy) called directly from device via
  `CapacitorHttp` in native mode — bypasses the `/api/notify` server proxy
  that isn't reachable in standalone.

#### Native WorkManager
- Java sources `WorkerScheduler.java` + `ReminderWorker.java` under
  `android/app/src/main/java/com/lifttrace/app/`. 15-minute periodic worker
  reads the same SQLite database the JS app uses (`lifttraceSQLite.db`),
  posts notifications based on user_settings toggles, de-dupes per-day via
  SharedPreferences.
- Gated by `_USE_NATIVE_WORKER` setting (default off — JS LocalNotifications
  is the v0.10.x default). Toggle in Settings → App Mode → "Background
  reminders".
- Includes per-day SharedPreferences dedupe so each reminder fires once.
  Streak-at-risk and workout reminder both check `workout_log` for today's
  exercises so they're suppressed if the user already logged something.

#### Offline media + local backup
- `src/lib/image-cache.js` — downloads exercise GIFs / images / videos via
  `@capacitor/filesystem` to `Directory.Data/lifttrace-images/`. URL-to-file
  mapping persisted in `sync_meta.image_map`; `resolveAssetUrl()` swaps in
  the local URI synchronously when present.
- `src/lib/local-backup.js` — JSON dump of every cached table to
  `Directory.Data/lifttrace-backups/`. Built-in Share sheet so the user can
  send the file to Drive / email. `importBackup()` does a destructive
  restore.

#### Native UX polish
- StatusBar configured to dark style + `#0F1115` background to match the app
  surface; SplashScreen explicitly hidden after main bootstraps.
- New `src/lib/haptics.js` shim — `@capacitor/haptics` impacts on native
  (Light/Medium/Heavy by total ms), `navigator.vibrate` fallback on web.
  Existing call sites in SetRow + restTimer + LiftBot now route through it.
- AndroidManifest declares `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`,
  `USE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `CAMERA`. SW registration
  blocked in `index.html` when running in Capacitor (assets served natively
  — SW would intercept navigation and route to offline.html).

#### Capacitor plugins installed (12)
@capacitor/core, @capacitor/android, @capacitor/cli (dev),
@capacitor-community/sqlite, @capacitor/app, @capacitor/local-notifications,
@capacitor/splash-screen, @capacitor/status-bar, @capacitor/keyboard,
@capacitor/haptics, @capacitor/filesystem, @capacitor/share,
@capacitor/camera, @capacitor/browser, @capacitor/preferences.
Health Connect + barcode-scanner + speech-recognition deferred to FUTURE.md.

#### Build flow
- `npm run android:debug` → vite build + cap sync + assembleDebug → APK at
  `android/app/build/outputs/apk/debug/app-debug.apk`.
- Release keystore deferred to FUTURE.md (debug-signed APK is fine for
  personal use; switching keys later requires uninstall first).

---

## v0.9.4-beta.22 — 2026-04-22

### Security — radio-proxy SSRF guard
Tiered protection against using the radio proxy as an SSRF tool to probe
internal services or exfiltrate cloud-instance metadata.

**Always blocked** (no opt-out):
- Link-local addresses `169.254/16` and IPv6 `fe80::/10`
- The cloud-metadata IPs (AWS / GCP / Azure all use `169.254.169.254`)
- IPv4-mapped link-local IPv6 (`::ffff:169.254.…`)

These are never legitimate radio URLs and are the highest-impact
SSRF target (extracting IAM credentials from a compromised instance).

**Blocked by default, opt-out available**:
- Loopback: `127.0.0.0/8`, `::1`
- RFC1918 private: `10/8`, `172.16/12`, `192.168/16`
- IPv6 ULA: `fc00::/7`
- IPv4-mapped private (`::ffff:10.…` etc.)

Set `ALLOW_PRIVATE_RADIO_URLS=1` in your environment to allow the proxy
to fetch private/loopback addresses. Logs a startup warning. Useful
for self-hosters running an internal Icecast on the same LAN / Docker
network.

**Applied to**: main stream proxy, `/info`, `/icon-suggest`, the
fallback `status-json.xsl` / `stats?json=1` probes, and the homepage
HTML icon-parser. Hostname is resolved via `dns/promises` and the
returned IP is checked against the blocklist before any network call.
Public-internet URLs (the 99% case) see no behavior change.

### Docs
- `CHANGELOG.md` extended with this release

---

## v0.9.4-beta.21 — 2026-04-22

### Security audit — pre-1.0 hardening pass
Backports the critical findings from NutriTrace's recent 4-phase security
audit. Same architecture, same applicable threats. No new dependencies
added; everything is in-house.

**Auth & sessions** (`server/middleware/auth.js`, `server/routes/auth.js`):
- `JWT_SECRET` now refuses to start in production with the dev default.
  Catches the most common self-host misconfiguration.
- Session duration capped at 1 year (was effectively forever for
  `session_hours = 0`). Override via `MAX_SESSION_HOURS`.
- Auth cookie is now `secure: true` by default. Opt-out with
  `INSECURE_COOKIES=1` (logs a warning at startup) for local dev /
  reverse-proxied HTTP setups. Was previously tied to
  `NODE_ENV=production`, which most self-hosters never set.
- bcrypt cost factor 10 → 12 (every hashSync call). ~4× slower per
  hash but meaningfully more resistant to GPU offline cracking if
  the DB ever leaks.
- Login rate-limit now runs **two parallel buckets**: per-IP (10/15min)
  AND per-username (6/15min). Previously per-IP only — credential-
  stuffing across IPs aimed at one account would slip through.
- Recovery-token comparison switched to `crypto.timingSafeEqual()`.
  String `===` is byte-by-byte and timing-side-channel-vulnerable.
- `/api/auth/forgot-password` always returns 200 regardless of
  whether the email matches a real account or whether SMTP is
  configured. Previously the response acted as an account-enumeration
  oracle.

**Backup** (`server/routes/full-backup.js`):
- Restore is now zip-slip + zip-bomb safe. Path normalization rejects
  any entry that resolves outside `/uploads/`. 50,000 entry cap.
  5 GB uncompressed total cap. Stops a 1 KB malicious ZIP from
  filling the disk or path-traversing.
- Upload size cap 2 GB → 512 MB by default
  (`BACKUP_UPLOAD_MAX_MB` to override).
- `:name` parameter on download / delete / restore now requires a
  `.zip` extension. Stops an admin from being tricked into operating
  on arbitrary files in the backups directory via path-style names.

**Uploads** (`server/routes/upload.js`, new `server/lib/image-magic.js`):
- Magic-byte sniffing on every upload. The actual first bytes of the
  written file are checked against known image / video signatures;
  if they don't match the file is deleted and the request 400s.
  Closes the "client-sent MIME is trusted" hole — most importantly,
  SVG is rejected entirely (it can carry inline `<script>`).

**API limits**:
- Global JSON body limit `50 MB` → `1 MB`
  (`server/index.js`). The handful of endpoints that legitimately
  accept large payloads use multer file uploads with their own caps.
- AI chat (`server/routes/ai.js`): rejects `> 60 messages` or
  `> 200 KB` combined payload. Bounds API-key-bill blast radius from
  a misbehaving client.

**Already correct** (verified, no change needed):
- `/api/auth/users` was already auth+admin gated.
- `/api/proxy` already uses exact-match `ALLOWED.includes(hostname)`,
  not `endsWith` — so `i.imgur.com.evil.tld` won't bypass.

**Deferred**:
- Radio-proxy SSRF private-IP guard — moderate priority, separate
  follow-up.
- CSRF middleware — bigger architectural change, not required for the
  pre-1.0 cut.

---

## v0.9.4-beta.20 — 2026-04-22

### Exercise picker — sticky filters + "stay open" multi-add
Two compounding improvements that turn "add 5 exercises" from 15 taps
into 6.

1. **Filters persist** across picker opens. Search text, category, and
   equipment sub-filter all land in `sessionStorage` (key
   `lt:picker-filters`). Reopening the picker mid-workout restores
   exactly where you left off. Clears when the browser session ends
   or you change dates.

2. **Picker stays open on add** (Apple-Music pattern). Tapping an
   exercise no longer dismisses the sheet — it:
   - Adds the exercise to today's workout
   - Flashes the row with a green "✓ Added" badge for 1.5s
   - Keeps you in the picker so you can immediately tap another
   Tap the backdrop / Close / back-swipe to exit.

   Replace mode (swapping an exercise's identity) and
   add-to-existing-superset mode still close the sheet because each
   resolves a specific user intent. Plain "build today's workout"
   flow is where the stay-open behavior lives.

Picked pattern A over pattern B (long-press selection mode) because:
- No hidden mode to discover
- Zero new UI chrome (checkboxes, count badges, Done/Cancel buttons)
- Scales identically from one exercise to many
- Error recovery stays trivial (remove from Diary)

---

## v0.9.4-beta.19 — 2026-04-22

### Statistics — NutriTrace-inspired polish
Three patterns borrowed from NutriTrace's Statistics page:

1. **Inline sparklines on Overview summary cards.**
   - *Day Streak* card gets a 14-day dot row — filled dots are workout
     days, outlined dots are rest days. Quick visual read of recent
     consistency without scrolling to the heatmap.
   - *This {range}* card gets an 8-week bar sparkline of workout
     counts per week. Instant sense of whether training frequency is
     climbing or drifting.
   - New reusable `<Sparkline />` component (`bars` / `dots` modes,
     pure SVG, fixed-width).

2. **Animated sliding pill indicator on the metric selector.**
   Replaces hard class-based background swap with a smoothly
   translating absolute-positioned indicator that measures the active
   pill's DOM position and slides to it. Works with variable-width
   horizontally-scrolling pills. Uses the same 0.26s cubic-bezier the
   rest of the app uses.

3. **Weekly-goal reference line on the Frequency chart.**
   When the user has set `weeklyWorkoutGoal > 0`, a dashed green
   horizontal line crosses the chart at that y-position. Weeks whose
   bar meets-or-exceeds the goal get a green success gradient + glow;
   weeks that fall short stay the existing blue. Instant "did I hit
   my goal?" answer.

Deliberately skipped from NutriTrace patterns:
- Chart.js migration (days of refactor for marginal gain)
- Custom-range date picker (6-pill preset covers ~95% of cases)
- Readiness/stress score breakdowns (no lifting analog)

---

## v0.9.4-beta.18 — 2026-04-22

### Statistics — polish pass (4 fixes)

1. **PR rows are tappable.** Records with a library exercise id now
   open that exercise's detail page on tap. Custom / legacy free-text
   records (no numeric id) stay as static display rows. Adds a subtle
   chevron affordance and hover/active states.

2. **RPE trend overlay on Exercise Progress.** When you've logged RPE
   for any completed sets of the chosen exercise, a dashed orange
   line plots the session's average RPE on a 5–10 scale alongside the
   top-set weight line. Legend shows above the chart when RPE data
   exists. Data surfaced via a new `avgRpe` field on the
   `/api/stats/progress/:id` response.

3. **"All" range now means all.** Previously capped at 3650 days
   (~10 years) — long enough for most users but would silently chop
   older imported data. Now resolves to `MIN(date)` from
   `workout_log` via a new `/api/stats/earliest-workout-date`
   endpoint. Body-weight range query also switched to the resolved
   `startDate` so it respects "All" properly.

4. **Scroll position preserved across metric switches.** Tapping
   Volume → Frequency → Volume now lands you back at the same
   scroll depth in Volume, not snapping to the top. Per-metric state
   in `sessionStorage`.

---

## v0.9.4-beta.17 — 2026-04-22

### Fixed — Weekly summary was counting warm-up volume
`scheduler.js` weekly-summary volume calculation now filters
`set.warmup` sets out, matching every other stats route. Warm-ups
were inflating the Sunday "volume lifted" number.

### Improved — LiftBot context awareness
Three gaps closed in the chat context injection so the coach actually
sees everything the app knows about you:

- **Warm-up sets now filtered** from "today's workout" and "recent
  workouts" summaries. Previously warm-ups counted as "work done" in
  the prompt, making LiftBot overestimate volume.
- **RPE annotations added** to the prompt — set lines now read
  `"225lbs×5 @8"` when you've logged RPE. System prompt educates the
  model on what `@N` means and explicitly suggests proposing a deload
  when RPE trends high at constant weight.
- **Today's coach prescription** is now pulled from
  `/api/prescriptions/my/{date}` and injected. LiftBot will stay
  inside the trainer's plan unless asked for variations.

### Verified — Full backup coverage
Audited the backup route against every recent addition. Confirmed
the backup ZIP includes: custom exercises + their media
(`/uploads/exercises/`), radio stations (incl. groups / homepages /
rest-tone preset), warm-up flags + RPE values (live in the
`workout_log.exercises` JSON), imported workout history, all
settings (including auto-collapse, auto-generate-warmups, track-RPE
toggles). Device-local state (collapse positions, FAB positions,
active rest timer) is intentionally excluded — that's local browser
state. No backup changes needed.

### Docs
- `FUTURE.md` completely rewritten to reflect current reality
  (everything shipped in the past two days moved to "Recently
  Shipped" with version anchors). The 1.0 prep checklist stands.

---

## v0.9.4-beta.16 — 2026-04-22

### Radio — polish pass
Five small-but-real UX improvements surfaced by a review of the Radio
page.

- **Stations now-playing highlight.** The currently-playing station
  row now gets the same accent-dim background + accent left-bar
  treatment as Albums / Playlists / Search rows. Previously the
  subtitle changed to show ICY metadata but the row itself was
  indistinguishable from its neighbours.
- **Artists empty state.** If the server returns no artists (new
  install / wrong credentials), the tab now shows a friendly
  "No artists found. Check your Subsonic server connection in
  Settings." prompt instead of a blank page — matching what Albums /
  Playlists already did.
- **"Added" chip on Browse results.** Searching Radio-Browser now
  compares each result's URL against your existing `$radioStations`;
  any station already in your list shows a green ✓ "Added" chip
  (disabled Add button) so you don't accidentally duplicate it.
- **Bigger reorder arrows on touch devices.** `@media (hover: none)
  and (pointer: coarse)` bumps the up/down reorder buttons from
  26×22 px to 40×36 px with a larger icon. Desktop is unchanged.
- **Search loading feedback.** Both the main Search tab and the
  Browse directory search now show a spinning `progress_activity`
  icon + "Searching…" line while a search is in flight, and the
  main Search button gets a spinner when busy.

Skipped from the review:
- "Radio" → "Music" page rename (branding call; no change)
- Mobile volume slider in mini-player (intentional — OS hardware
  buttons cover this)
- "Inconsistent card padding" (invisible to users)

---

## v0.9.4-beta.15 — 2026-04-22

### Diary — layout polish pass
Four small-but-real improvements to how the Diary page reads at a
glance mid-workout:

- **Removed the duplicate workout-name bar.** The template name was
  showing twice — once in a calendar-icon chip and again as the
  editable title below the progress strip. Only the editable version
  (the useful one) remains.
- **"Now doing" pill.** A sticky accent-colored row appears between
  the summary bar and the exercise list whenever there's an
  incomplete working set. Shows the current exercise + "Set N of M"
  and scrolls to that card when tapped. Supersets report the group
  as "Superset: A / B".
- **Current-set highlight.** The first incomplete working set in each
  exercise card gets a subtle accent left-bar + tint — a visual "you
  are here" cue so you don't have to scan for the next ○.
- **Summary bar progress fill.** Soft accent-gradient grows behind
  the stat row as sets complete; flips to success green when the
  workout is done.

### Settings — copy polish
- Section name "Import from other apps" → "Import from Other Apps"
  (matches the title-case convention of every other section).
- Card label "Offline media" → "Offline exercise library" (clearer
  meaning, matches sentence-case convention of other setting rows).

---

## v0.9.4-beta.14 — 2026-04-21

### Added — Selectable rest-timer tones
Five synth-generated tone presets with a per-preset preview button in
Settings → Workout → Rest Timer.

- **Classic** — 880 Hz countdown, higher chirp at 0 (previous hardcoded default)
- **Bells** — soft musical chime, C–E–G major-third finale
- **Beeper** — sharp square-wave beeps, triple-tap finale
- **Gym** — low thud countdown, rising sawtooth horn at 0
- **Minimal** — no countdown beeps, single soft click on the 0 mark only

Tap any row to select, tap ▶ to preview without running the real
timer. All presets respect the existing "Play tone" master toggle.

Implementation is synth-only (oscillator presets, no audio files) so
there's nothing to bundle and offline behaviour is unchanged.

---

## v0.9.4-beta.13 — 2026-04-21

### Added — Warm-up set generator
Classic 5-step ramp (bar → 50% → 70% → 85% → working) prepended to
exercises that have a target weight.

- **Manual**: each exercise card gets an inline "⚡ Warm-ups" button
  next to "Add Set" (visible when the exercise has a working weight
  set). Tap to prepend 3-4 warm-up sets.
- **Auto**: new Settings → Workout → "Auto-generate warm-up sets"
  toggle (off by default). When on, loading a template auto-prepends
  warm-ups to each exercise based on its target weight.
- Warm-up sets carry a `warmup: true` flag. They're visually muted,
  labelled `W` in the set number column, and **excluded from**:
  - Set count ("3/5 sets" header)
  - Volume calculations (exercise card chip + Statistics)
  - PR detection
  - Rest timer firing
  - Auto-collapse-on-complete signal
- Round-robin superset logic also ignores warm-ups when deciding
  whether a round is "closed".

### Added — RPE / RIR per set
Optional per-set Rate of Perceived Exertion logging for
autoregulated programs (5/3/1, nSuns, RTS, GZCL-style).

- New Settings → Workout → "Track RPE per set" toggle (off by
  default). When off, nothing visually changes.
- When on: each completed set shows a small chip next to the ✓
  (either `@8` when set, or `RPE` placeholder). Tapping the chip
  opens a compact picker with 6, 7, 7.5, 8, 8.5, 9, 9.5, 10 + Clear.
- Stored as `set.rpe: number | null` on the workout log.
- Bonus: the Strong/Hevy import already reads RPE into the notes
  field as `"RPE 8"` — a future migration can promote those into
  the proper field now that it exists.

### Added — Similar exercises
New "Similar exercises" section on the ExerciseDetail page. Shows up
to 8 alternatives ranked by how many primary muscles they share with
the current exercise.

- Scoring: `primary_overlap * 3 + secondary_overlap - (different_equipment ? 1 : 0)`.
- Small equipment penalty (not a hard filter — the whole point is
  finding alternatives when your preferred equipment is taken).
- Each card shows name + equipment tags + GIF/image thumbnail;
  tapping opens that exercise's detail page.
- Hidden gracefully when the source exercise has no
  `primary_muscles` metadata (some legacy custom entries).

---

## v0.9.4-beta.12 — 2026-04-21

### Improved — Radio station "now playing" metadata
Non-breaking improvements to how we extract and clean the current-song
info from streaming radio stations. UI output shape unchanged — just
fewer garbled or missing titles.

- **UTF-8 / Latin-1 fallback**: when we detect mojibake (`\uFFFD`
  replacement chars) in the decoded StreamTitle we retry the raw bytes
  as Latin-1 / Windows-1252. Accented artist names (Mötley Crüe, Beyoncé,
  Sigur Rós, etc.) now show correctly for older Icecast servers.
- **HTML entity decode**: `&amp;`, `&#39;`, `&#x2013;` etc. decoded inline.
- **Normalized dashes**: every flavor of Unicode dash (em, en, minus,
  figure-dash) collapsed to plain ASCII `-`.
- **Ad-break markers suppressed**: strings like `"Advertisement"`,
  `"Commercial Break"`, `"Station ID"`, `"Unknown"` are now returned as
  empty so the UI falls back to the station's genre instead of showing
  the ad marker literally.
- **Fallback side-channel metadata** for stations that don't send
  inline `StreamTitle`: when we've got no fresh inline metadata, the
  `/now-playing` endpoint fires a background probe against the stream
  origin's `/status-json.xsl` (Icecast) or `/stats?json=1`
  (Shoutcast v2). Results go into the same cache. Debounced to one
  attempt per 30 seconds per URL so we never hammer the upstream.

All changes are additive — the client-side data shape
(`{ title, updatedAt }`) is unchanged. Stations that were already
showing metadata cleanly continue to do so.

---

## v0.9.4-beta.11 — 2026-04-21

### Added — FitNotes + Jefit import adapters
Rounds out the experimental Import-from-other-apps feature. Same
preview → commit flow as Strong + Hevy.

- **FitNotes** (Android) — reads the CSV export, detects weight unit
  from the column header (`Weight (kgs)` vs `Weight (lbs)`). FitNotes
  has no workout-name field, so imported workouts are auto-named by
  the trained muscle categories (e.g. "Chest / Back").
- **Jefit** — reads the Workout Log CSV export. Permissive column
  lookup by name (not position) handles both the modern `Log Date,
  Routine, Exercise, Set, Weight, Weight Unit, Reps, Notes` header and
  older `Date, Exercise Name, Weight, Unit, Reps, Notes`. Dates
  accepted in ISO, `MM/DD/YYYY`, and `Mon DD YYYY` formats.

Source picker in Settings → Import from other apps now shows all 4
options in a responsive grid (2 cols mobile, 4 cols desktop).

---

## v0.9.4-beta.10 — 2026-04-21

### Added — Workout-history import from Strong / Hevy (experimental)
New Settings → "Import from other apps" section (DATA group, labelled
EXPERIMENTAL) that accepts a CSV export from Strong or Hevy and
rebuilds your workout history inside LiftTrace.

- Two-step flow: upload file → preview (workouts, sets, matched
  exercises, date range, duplicate dates) → commit with skip / replace
  choice on collisions
- Exercise name fuzzy-matching against your library (same priority
  tiers as Smart Log: exact → starts-with → substring → token-overlap)
- Unmatched exercise names land as free-text on their workout rows,
  never dropping data — the existing "not-linked → Replace" flow lets
  you link them to library exercises later
- Preserves supersets (Hevy's `superset_id` remaps to our integer ids)
- Converts weight units to your current setting (Strong has per-row
  unit; Hevy is always kg)

### Changed — User management consolidated (NutriTrace parity)
- Removed the account / sign-out header card from the top of Settings
  (sign-out now lives solely in the sidebar footer, as it already did)
- "User Management" section now visible to all logged-in users with a
  new "My Profile" shortcut row at the top that navigates to `/profile`.
  Admins still see the user list / invite / session controls below.
- Moved into its own "Account" group; the "Admin" group now just holds
  the Email (SMTP) settings card.
- List-users fetch is now scoped to admin role to avoid 403s for
  members.

---

## v0.9.4-beta.9 — 2026-04-21

### Fixed — Drag auto-scroll on mobile was crawling
Two compounding bugs made edge-scroll on mobile nearly useless after
beta.8:

1. The edge-scroll update was wired to per-group `on:dragover`
   handlers. When the pointer drifted into page chrome or whitespace
   (i.e. the very places you drag to in order to scroll), no handler
   fired and velocity never updated. Moved to document-level `drag` +
   `dragover` listeners attached on dragstart / removed on dragend so
   the scroll ramps regardless of what's under the pointer.

2. The app has `scroll-behavior: smooth` set globally on `<html>`. Every
   `scrollBy(0, 26)` in the RAF loop was being animated over ~300 ms by
   the browser, so 60 stacked calls per second barely moved the page.
   Especially bad on mobile where HTML5 drag events fire sparser than
   desktop. Forcing `behavior: 'instant'` on the drag-scroll calls
   bypasses the global smooth-scroll for just these calls (every other
   `scrollBy`/`scrollTo`/`scrollIntoView` in the app already specifies
   its own behavior, so nothing else changes).

Also bumped MAX_SPEED 14 → 26 px/frame (~1560 px/s) and EDGE_ZONE
80 → 110 px for a snappier response on both platforms.

---

## v0.9.4-beta.8 — 2026-04-21

### Rest timer — persistent, countdown beeps, repositioned
Rebuilt on top of a persistent module-level store driven by an absolute
`endTime` timestamp, so a running timer now survives page navigation,
backgrounded tabs, and locked screens. If you're resting for 2 minutes
and lock your phone, the alert still fires accurately.

- **Countdown cues** — short beeps at the 3s / 2s / 1s marks (rising
  pitch) plus a final higher-pitch double alert at 0. Each step
  vibrates (if enabled); the 0-mark fires a double vibrate.
- **Background alerts** — when the PWA is backgrounded the OS handles
  the alert via a Service Worker notification with a vibrate pattern,
  so you're still notified if you've switched to another app.
- **Position flipped** — the red rest bar now sits directly above the
  mini-player. The workout-mode pill smoothly slides up above the rest
  bar when rest activates, then back down when rest ends, via a new
  `--rest-h` CSS variable (no jank).
- **Survives navigation** — open LiftBot or flip to Stats mid-rest; the
  timer is still counting when you return to Diary.

### Diary polish
- **Auto-collapse on completion** now defaults ON. Completing every
  set of a standalone exercise or every set of a superset round
  collapses the card so you can see your next move at a glance.
  Still controllable via Settings → Workout → Auto-collapse.
- **Collapse state persists** across page navigation (per date, per
  card). Leaves for Stats, comes back — the same cards are still
  collapsed.
- **Reorder arrow icons changed** to `keyboard_double_arrow_up/down`
  everywhere (ExerciseCard, SupersetCard child cards, Radio stations,
  WorkoutEditor ⋮ menu, WorkoutEditor inline buttons). The existing
  `expand_more` chevron is reserved for the collapse state so the two
  no longer look the same.
- **Drag auto-scrolls** on mobile. When a dragged exercise / superset
  is held within 80 px of the viewport top or bottom edge, the page
  scrolls in that direction at a speed proportional to how deep into
  the edge zone the pointer is. Solves the "stuck on screen" problem.

---

## v0.9.4-beta.7 — 2026-04-21

### Added — Custom exercises (in-app create/edit/delete)
A first-class feature for building your own exercises without leaving
the app. No more Excel imports for one-off additions.

- **Create** from the Exercises page "+" button (header, top-right) or
  from the workout picker's "Create 'X'" shortcut when a search finds
  nothing — pre-fills the name and auto-selects the new exercise after
  save so you can add it to the current workout in one flow.
- **Edit / Delete** from the exercise detail page (pencil + trash
  icons next to the title, only on your custom exercises — seeded
  catalog exercises stay read-only).
- **Manage all** in Settings → Exercise Catalog → "My Exercises":
  list with thumbnail / name / category, per-row edit + delete, and a
  "Delete all my exercises" bulk action.
- **Custom chip** on library rows so you can tell your own exercises
  apart at a glance.
- **Editor form** covers name, category, primary/secondary muscles
  (mutually exclusive — selecting a muscle as primary removes it from
  secondary), equipment chips, instructions, tips.
- **Media picker** handles everything in one control: upload from
  device (image / GIF / video, up to 100 MB), paste any image URL, or
  paste a YouTube link (auto-detected and rendered as an embedded
  iframe). Only one media per exercise — replacing it clears the
  others.
- Workout history stays intact when you delete a custom exercise —
  `workout_log` already denormalizes exercise names, and the existing
  "not-linked → Replace" recovery flow handles relinking.
- All covered by the existing full-backup (SQLite + /uploads folder).

### Server
- New `POST /api/upload/exercise-media` route accepting image/* and
  video/* up to 100 MB.
- New `DELETE /api/exercises/custom/all` route for the bulk clear
  action. Scoped to `source='custom' AND is_global=0 AND
  created_by=<userId>` — can never delete seeded or other users' rows.

---

## v0.9.4-beta.6 — 2026-04-20

### Added — Radio stations: discovery, now-playing, drag-drop, auto-fill
- **Browse sub-tab** — new sub-tab inside the Stations tab that searches
  the Radio-Browser.info community directory (~40,000 stations). Type a
  name, genre, or country; tap a result to add it. Populates name, URL,
  genre, and icon automatically.
- **Now playing** (ICY metadata) — stations that embed `StreamTitle` in
  the stream (most Icecast/Shoutcast servers) now show the currently
  playing track in the mini-player, full player, and the station list
  entry itself. The server parses the interleaved metadata blocks and
  strips them before forwarding clean audio. A polling endpoint
  (`/api/radio-proxy/now-playing`) returns the latest title. Polling
  runs globally in `player.js` — works while the user is on any page.
- **Drag-and-drop reorder** — drag a station row on desktop to reorder.
  Cross-group drops update the station's `group` field automatically;
  drop onto a group header to move it to the end of that group. Mobile
  keeps the up/down arrow buttons.
- **Auto-fill station info** — "Auto-fill" button on the Stream URL
  field fetches the stream's `icy-name` and `icy-genre` headers via a
  new `/api/radio-proxy/info` endpoint and prefills the form.
- **Icon auto-fetch button** — opt-in "Auto" button next to the Icon
  URL field uses Google's favicon service against the stream URL's
  domain. Works well for stations hosted on their own domain.
- **Playlist file resolution** — if you paste a `.pls` or `.m3u` URL
  (e.g. SomaFM), the proxy fetches the playlist and uses the first
  stream URL automatically. No more manually opening playlists.

---

## v0.9.4-beta.5 — 2026-04-20

### Added — Radio stations: HLS streams, groups, reordering, group rename
- **HLS support** — TuneIn-style `.m3u8` streams (e.g. Radio Deejay) now
  play in Chrome/Firefox via lazy-loaded `hls.js`. Safari uses native
  HLS. The hls.js chunk only loads when an `.m3u8` URL is actually
  played (zero cost for users who never add HLS stations).
- **Groups** — new optional Group field per station (free-text, with
  datalist auto-suggestions from existing groups). Stations tab
  renders a section header per group; "Ungrouped" appears last.
- **Rename group** — pencil icon next to each group header bulk-renames
  every station in that group in one dialog. Clearing the name moves
  all stations in the group to "Ungrouped".
- **In-group reorder** — up/down arrow buttons on each station move it
  within its current group (cross-group moves go through the Edit
  dialog's Group field).
- **Radio station backup** — stations are stored in `user_settings` and
  have always been included in full backup + restore. Groups/ordering
  carry through automatically (`group` is just another field on the
  array items).

### Fixed — Cross-origin radio streams silenced by Web Audio
Icecast/Shoutcast MP3 streams (e.g. `Radio105.mp3`) were being silenced
by the new LiftBot visualizer because `createMediaElementSource` requires
same-origin audio. A new `/api/radio-proxy?url=...` server route pipes
direct streams through our server, making them same-origin. HLS bypasses
the proxy (hls.js does its own XHR). The visualizer keeps working on
every track — library, direct stream, or HLS.

---

## v0.9.4-beta.4 — 2026-04-19

### Added — LiftBot FAB frequency visualizer
When music is playing, 32 SVG bars radiate outward from the LiftBot FAB
edge, each bar driven by a real-time Web Audio `AnalyserNode` reading
frequency data from the player's audio element.

- Bars react to the actual music — bass hits pulse the lower-frequency
  bars harder, treble shows activity at the top
- SVG `feGaussianBlur` bloom filter gives bright bars a soft glow
- Bars disappear completely in silence; only appear on sound activity
- Ring color follows the selected accent scheme (`currentColor` pattern)
- Fades in/out smoothly when playback starts/stops
- Disappears automatically during hold-to-record mode
- Falls back silently if Web Audio API is unavailable or blocked by
  CORS (e.g. external streaming stations)

### Fixed — Program workout list scroll restore
When tapping into a workout template from a long program list (e.g.
Monumental Valley with 57 workouts) and pressing back, the list now
returns to the exact scroll position rather than jumping to the top.
Position is saved per-program in `sessionStorage`.

### Fixed — ProgramDetail header overlap
Removed the "Duplicate" text label from the header action buttons.
The label was appearing at wider viewports and overlapping with long
program names. Icon + tooltip is sufficient.

---

## v0.9.4-beta.2 — 2026-04-18

### Added — Hold-to-voice-log on LiftBot FAB
Same pattern as NutriTrace's AIFitBot. Press and hold the floating
LiftBot button:

- **~700ms hold** → FAB turns red and pulses, face morphs to a mic
  icon, a "Listening… release to log" hint appears, start-beep fires,
  and Web Speech API begins capturing.
- **Release on the FAB** → end-beep, transcript is parsed by LiftBot,
  matched against the exercise library, and opened in the Smart Add
  review screen (pre-parsed mode — skips the input phase).
- **Slide > 100px from FAB center** while holding → cancel-preview
  (FAB greys out, hint changes to "Release to cancel"). Release
  there = abort, lower end-beep.
- **Move > 6px before the hold threshold** → drag mode (existing
  behavior; move the FAB around).
- **Plain tap** → opens the chat panel as before.

SmartLogModal gained a `preParsedMatches` / `preParsedSourceText`
prop pair so it can skip the input phase when the caller already
did the parse/match work.

### Docs
- Updated `README.md` with Smart Add, hold-to-record, share card,
  streaming stations, superset-aware rest timer, auto-collapse, and
  right-click parity.
- `FUTURE.md` — moved Share workout card, Streaming stations, LiftBot
  data access, and Smart Add into "Recently Shipped". Added Selectable
  tones and Sticky rest bar as new planned items.

---

## v0.9.4-beta.1 — 2026-04-18

### Added — Smart Add (workout edition)
Natural-language / voice workout logging, borrowed from NutriTrace's
Smart Log pattern and adapted for lifting.

- New **Smart Add** button on Diary (both empty state and FAB group)
- Modal accepts typed or spoken input via Web Speech API (PWA only
  for now; text input works everywhere)
- LiftBot parses the prose into structured exercises/sets — handles:
  - Uniform sets: `"bench 3x5 @ 225"`
  - Per-set variation: `"squat 225x5, 245x5, 265x5"`
  - Bodyweight: `"pullups BW x 8"`, `"BW+25"` for weighted
  - AMRAP: `"3xAMRAP"`, RPE: `"@8"`, ranges: `"3x8-10"` (midpoint)
  - Supersets: `"A1: bench 3x5 @ 185, A2: row 3x8 @ 95"` →
    creates a linked superset group
- Exercise names matched fuzzily against the library (exact →
  starts-with → substring → token overlap), with aliases for common
  abbreviations (BP, OHP, DL, SQ, RDL, BB, DB)
- Review screen shows candidate matches as tappable chips, editable
  sets/reps/weights, flags unmatched exercises ("not in library")
- Saves to today's workout, appending (doesn't replace)
- New module: [src/lib/smartLogWorkout.js](src/lib/smartLogWorkout.js)
- New component: [src/components/diary/SmartLogModal.svelte](src/components/diary/SmartLogModal.svelte)

### Added — Right-click parity with long-press
Right-click on a Diary exercise card now opens the same menu that
long-press / ⋮ opens. Other long-press actions in the app (Radio
track rows, WorkoutEditor exercise rows) already had contextmenu
handlers — this closes the gap.

---

## v0.9.3-beta.3 — 2026-04-18

**Settings polish pass** — pure UX cleanup, no feature changes.

### Changed — Settings page IA
- Every section now sits under a group label. Orphaned sections
  (Notifications, Email, User Management) were visually adrift;
  they now belong to groups:
  - DISPLAY → Appearance, Units & Format
  - WORKOUT → Workout, Statistics
  - NOTIFICATIONS → Notifications (promoted to its own group)
  - INTEGRATIONS → LiftBot, Radio, Exercise Catalog
  - DATA → Backup & Restore
  - ADMIN → Email, User Management (admin-gated; label hidden
    for non-admins)
  - About sits alone at the bottom (no label).

### Changed — Workout section internal structure
The Workout section had 9+ toggles in an undifferentiated block.
Now split with sub-labels matching the Notifications/Backup
pattern:
  - Goals & Progress (weekly goal, celebrations, keep-awake)
  - Logging Behavior (auto-fill, completion summary, auto-collapse,
    auto-name, reorder method, confirm before removing)
  - Rest Timer (all timer settings)
  - Body Measurements (the 9 stat toggles)

### Changed — copy & hints
- Added hints to dropdowns that previously had none (Weekly goal,
  Rest duration, Reorder method).
- Shortened the 4-line "Highest quality playback" hint to one line.
- Shortened "Streaming stations" toggle description.
- LiftBot API key layout cleaned up: provider help link now lives
  in the hint under the label (matching other sections) instead
  of a separate description block below the field.
- `.sub-label` CSS promoted to `:global()` in Settings.svelte so
  every sub-component inherits consistent styling.

---

## v0.9.3-beta.2 — 2026-04-18

### Added
- **Share workout card**. The Workout Complete summary sheet now has
  a Share button next to Done. Tap it to generate a 1080×1350 PNG
  card with workout name, date, stats (volume/sets/exercises/duration),
  and the top set for each exercise, themed with your accent color.
  On mobile → Web Share API (native share sheet → IG/text/etc.).
  On desktop → downloads the PNG.
  - Client-side canvas render, no server dependency
  - New module: [src/lib/workoutCard.js](src/lib/workoutCard.js)
  - Truncates long exercise lists with "…and N more"

---

## v0.9.3-beta.1 — 2026-04-18

**Versioning scheme change** — switching to `MAJOR.MINOR.PATCH-beta.BUILD`
under a stable base. Small ships increment the `-beta.N` counter;
patch/minor bumps reserved for coherent, user-facing releases. `1.0.0`
locked until release-ready.

### Fixed
- **Program template prefill** — loading a workout from a program
  template was dropping the template's `target_weight` / `target_reps`
  when per-set `set_specs` weren't used. Diary would fall back to
  zeros or last-session weights. Now: per-set specs > last-session
  weights (if auto-fill on) > template's planned weight/reps > empty.
  Fresh users see the planned numbers; returning users keep
  progressive-overload memory.

### Added
- **Rest timer alert split into vibrate + tone sub-toggles**. The
  master "Alert when done" toggle now gates two independent
  sub-options (both default ON): Vibrate, Play tone. Turn off
  either independently — useful for silent gyms (vibrate only) or
  phones without a haptic motor (tone only). Selectable tone
  sounds flagged as a future option.
- **Streaming stations toggle**. Stations tab is now opt-in via
  a new "Streaming stations" toggle in Settings → Radio (default
  OFF). When off, the Stations tab is hidden from the Radio page
  entirely — cleaner for users who only want their personal
  library. Toggle on to manage Icecast/SomaFM/etc. URLs.

---

## v0.9.3-beta — 2026-04-18

### Fixed
- **SupersetCard action order** now matches ExerciseCard
  (`…, X, chevron`). Previously the chevron came before the X, which
  made the two card types read differently. One-line swap.

---

## v0.9.2-beta — 2026-04-18

Five workout + player fixes from in-the-wild use.

### Fixed
- **Rest timer now respects supersets**. Previously the timer fired
  after every set even inside a superset round — so rest would start
  after A1 even when A2 was still coming. Now the timer only fires
  when the round is complete (every exercise in the group has the
  same number of completed sets). Standalone exercises unchanged.
- **Pause button stuck on "pause" icon when queue ends**. In MSE
  playback mode the audio element doesn't fire `ended` at the end of
  the last buffered track (MediaSource stays open). The progress tick
  now detects "at buffer end + last track + no repeat" and calls
  `pause()` explicitly, flipping the button back to play. Non-MSE
  (streaming stations, fallback) was already fine.
- **Radio context menu (long-press) appeared at top of screen on
  mobile**. Some Android browsers fire `contextmenu` with (0,0)
  coordinates for long-press gestures. Now captures pointer position
  on `pointerdown` as a fallback and clamps the menu to the viewport
  after it renders.

### Added
- **Superset auto-collapse**. The existing `autoCollapseCompleted`
  setting now applies to supersets too — collapses the whole
  superset card when every set in every exercise of the group is
  done. Tap the header to re-expand. No new setting needed.
- **Reorder exercises within a superset**. Each exercise inside a
  superset now shows up/down arrow buttons so you can reorder them
  without breaking the superset group. Works any time; best used
  before you start logging sets so order stays predictable.

---

## v0.9.1-beta — 2026-04-18

Bundle of four user-facing changes that came out of an in-the-wild
review pass: Radio scroll glitch, diary delete safeguards, LiftBot
data access, and streaming internet radio.

### Fixed
- **Radio page auto-scrolled** down on load. Root cause was browser
  scroll anchoring — the loading spinner got replaced by a much
  taller content block, and the anchor algorithm scrolled down to
  keep "something" visually stable. Added `overflow-anchor: none` on
  the Radio `.page` container.

### Added
- **Confirm before removing exercise / superset from diary**. New
  setting `confirmExerciseRemoval` in Settings → Workout (default
  ON). Wraps `removeExercise` and `removeSuperset` in Diary with a
  confirm dialog naming the exercise(s) that would be removed.
  Individual set removal is still fast-path (no confirm).
- **LiftBot live data context**. Every message now injects a
  system-prompt block with:
  - Today's workout (already had this)
  - Active program + its workout templates with exercise names
  - Last 14 workouts (date, name, top sets per exercise)
  - Today's body stats + 30-day weight trend
  - Top 10 PRs
  - Weekly goal + last 4 weeks of frequency
  - Streaks

  So the bot can now actually answer questions like "how's my bench
  progressing?" or "what should I do today?" without you pasting
  anything.
- **Streaming radio stations**. New "Stations" tab in the Radio page
  for user-managed internet streaming URLs (Icecast, SomaFM, etc.).
  Add / edit / delete stations inline; each station plays via the
  existing audio element with MSE bypassed (streams don't have
  queue/duration semantics). Stations are stored in `user_settings`
  as JSON so they're covered by full backup automatically.

### Backup audit
Confirmed all 13 DB tables + the `uploads/` tree are covered by
full-backup. No gaps from recent work — imported XLSX catalogs,
radio config, AI keys, notification push tokens, coach prescriptions,
trainer assignments all flow through backed-up tables.

### Versioning
Patch-level bump only. As we approach public release + Android app
launch at 1.0.0, minor bumps are reserved for genuine user-visible
capability shifts. Refactors, polish, and feature additions of this
scale should stay patch-level.

---

## v0.9.0-beta — 2026-04-18

Finishes the Settings sub-component split that was kicked off in
v0.8.9. Settings.svelte drops from ~2,700 lines to ~890 as an
orchestrator only — every section now lives in its own component
under `components/settings/`.

### Refactor
- **Settings sub-component split completed**. New components (all
  under `src/components/settings/`):
  - `SettingsAppearance.svelte` — theme, accent picker, nav, banners
  - `SettingsUnits.svelte` — weight unit, date/time format
  - `SettingsWorkout.svelte` — goals, rest timer, body measurements
  - `SettingsStatistics.svelte` — chart preferences
  - `SettingsLiftBot.svelte` — AI provider/model/API key
  - `SettingsRadio.svelte` — Subsonic/Jellyfin/Plex/Emby config
  - `SettingsCatalog.svelte` — exercise sources + custom XLSX import
  - `SettingsBackup.svelte` — full backup, restore, danger zone
  - `SettingsNotifications.svelte` — local + push services
  - `SettingsEmail.svelte` — SMTP config (admin only)
  - `SettingsUserManagement.svelte` — user list, invites, enable flow
- Each component imports the Svelte stores it needs directly and
  exposes only `visible`, `expanded`, `onToggle` props so the parent
  stays a thin orchestrator.
- Framework CSS classes (`.section-toggle`, `.section-body`, `.card`,
  `.setting-row`, etc.) remain `:global()` in Settings.svelte so
  sub-components inherit styling automatically.
- Fixed literal `\u2026` escape sequences that were leaking into rendered
  template text (inside JS strings they're fine, inside template text
  they render as `\u2026` literally). Affected: SettingsRadio, SettingsCatalog,
  SettingsWorkout.

### Notes
- No user-visible feature changes — pure restructure.
- All sections still render, search/collapse still works, admin-only
  gating still works.

---

## v0.8.9-beta — 2026-04-19

Picks up three of the four refactors that were deferred in v0.8.8
(Emby split stays deferred \u2014 still works via Jellyfin fork compat).

### Refactor
- **Statistics charts extracted** into reusable components:
  - `components/statistics/WeeklyVolumeChart.svelte`
  - `components/statistics/WorkoutFrequencyChart.svelte`
  - Formatting helpers moved to `lib/statsFormat.js` so they're
    usable from both the page and the components.
  - Removed ~100 lines of duplicated SVG + template code from
    Statistics.svelte. Three callsites (Overview, Volume view,
    Frequency view) now each render `<WeeklyVolumeChart />` or
    `<WorkoutFrequencyChart />` with prop differences.
- **WorkoutEditor menu triggers consolidated**: dropped the
  `use:longpress` action + its touch handlers. Each exercise card
  now responds only to the \u22ee menu button (primary) and
  `contextmenu` (right-click on desktop). Long-press was
  functionally identical to the \u22ee and undiscoverable on desktop.
- **Settings sub-component split started**: About section extracted
  to `components/settings/SettingsAbout.svelte` as the template for
  the rest. Shared framework classes (section-toggle, section-body,
  card, setting-row, etc.) are now `:global()` in Settings.svelte
  so extracted sections inherit styling automatically. Remaining
  sections tracked in FUTURE.md \u2014 safer to do one at a time.

---

## v0.8.8-beta — 2026-04-19

Full-app audit pass. Four bundled commits covering: must-fix bugs,
quick-win polish, medium-scope refinements, and player hygiene.
All suggestions from the audit either landed or are explicitly
flagged and skipped.

### Fixed
- **All auth flows now share one password validator** (`lib/validation.js`).
  Previously AcceptInvite and ResetPassword only enforced 4 chars; now
  every flow matches the server rule (8 chars + complexity).
- **Password strength indicator** (0\u20134 bar with live label) on Profile,
  AcceptInvite, ResetPassword.
- **Statistics body-weight loading** was firing N individual requests in
  a loop. Replaced with a new `GET /api/body-stats/range` batch endpoint
  \u2014 Body Weight view paints in one round-trip now.
- **MSE** surfaces a clear error when a track has no stream URL instead
  of silently failing inside the source buffer.

### Changed
- **Exercises filters now stack.** Picking equipment narrows the category
  chips (instead of resetting them) and vice versa; matches Diary. Count
  badge shows 'filtered / total' when filtered.
- **Exercises empty state** distinguishes 'library empty' from 'filters
  returned nothing' with a contextual action for each case.
- **ExerciseDetail** now shows a real error state with 'Try again' and
  'Back' when the API fails, instead of an endless loading spinner.
- **Programs coach badge**: 'Coach: {name}' (colon) for clearer ownership.
- **Programs import sheet** gains per-option icons + 'Accepts .xlsx or
  .xls only' hints so users don't upload CSVs.
- **ProgramDetail Duplicate button** labels itself on \u2265640px viewports
  (icon-only below).
- **ProgramDetail templates** are now drag-to-reorder on desktop.
  Optimistic local update + server rollback on failure. Drag handle
  icon on each row.
- **Wizard**: '(Optional)' suffix on skippable step titles; library
  imports now parallelise at concurrency-2 and report success/failure
  summary.
- **Settings \u201cKeep original format\u201d** renamed to 'Highest quality
  playback' with copy that doesn't require codec knowledge.
- **Coaching**: 'Assign program' gets equal visual weight to
  'Prescribe', both primary buttons.

### Added
- **Keyboard shortcuts** for the music player on desktop: Space to
  play/pause, Shift+\u2192 next, Shift+\u2190 previous. Gated on non-input
  focus.
- **Queue cap** at 500 tracks (~8 hours). Prevents unbounded memory
  growth on long sessions.

### Deferred from the audit (intentionally)
- Statistics chart-component extraction: duplicated ~30-line blocks
  across Overview/Volume/Frequency metrics are maintenance-debt but
  not buggy. Skipped to avoid regression risk to working charts.
- WorkoutEditor menu triggers: long-press + right-click + \u22ee were
  flagged as over-engineered but don't actually conflict. Kept.
- Settings.svelte sub-component extraction: 2,700-line file is hard
  to maintain but works; refactor has high regression surface.
- Emby provider '/emby/' route split: works today by Jellyfin fork
  compatibility; explicit split risks breaking working Emby users.
  Added explanatory comment instead.

---

## v0.8.7-beta — 2026-04-19

Equipment filter polish, offline-media caching, and licensing hygiene
ahead of the paid Android app.

### Added
- **Equipment filter consolidation** — raw equipment strings from every
  source (wger / free-db / exercisedb / exercisedb-oss / custom XLSX)
  now collapse into six canonical buckets: **Barbell · Bodyweight ·
  Dumbbell · Cable · Machine · Other**. Shared helper
  `src/lib/equipment.js` powers both the main Exercises page and the
  in-workout ExercisePicker so vocabulary stays consistent.
- **Scroll affordance** on the equipment chip row: gradient fades on
  both edges, plus a wheel-to-horizontal handler so desktop scroll
  wheels pan the row.
- **Workbox runtime cache for exercise media** split into two buckets:
  stable sources (OSS media, free-db, wger) keep a 30-day TTL; rotating
  sources (commercial AscendAPI CDNs) drop to 6 days because their
  URLs rotate every Monday per AscendAPI's caching guide.
- **"Pre-cache media for offline"** button in Settings → Exercise
  Catalog with a live progress bar. Seeds the SW cache with every
  gif/img/video URL in the library — ideal pre-gym on home WiFi.
- **Bigger, clearer "Clear" button** on each source row. Sweep-broom
  icon, label, danger-tinted. Confirm dialog spelled out so it's
  obvious the source row itself isn't going away.
- **First-run wizard gets an Exercise Library step** (skippable). Lists
  every available source with a license badge next to its name,
  one-line note, checkbox picker, optional API-key field. Pre-selects
  Free Exercise DB (Public Domain) as the safe default. Import button
  fires sequentially with per-source progress; Skip button advances.

### Changed
- **Auto-seed default flipped** from `'wger,free-db'` → `''`. New installs
  land with an empty library; the wizard prompts on first run. Self-
  hosters can still opt in by setting `EXERCISE_SOURCES` in their
  docker-compose env. Existing installs are unaffected (autoSeed
  short-circuits when library has content).

### Fixed
- **exercisedb-oss pagination** — was using `?cursor=` when the API wants
  `?after=`. Silent failure that made every request return page 1, so
  imports capped at 25 exercises. Now walks all ~1,500.
- **Dedup by exerciseId** in the OSS seeder as defense-in-depth against
  any future cursor-loop behaviour.

---

## v0.8.6-beta — 2026-04-18

Second Diary polish pass. Tier 1 + 2 + 3 from the deep dive.

### Added
- **Weight \u00b1 step buttons** next to each weight input \u2014 single tap to add/remove 5 lb (or 2.5 kg). Gym-reality logging without typing four digits with sweaty hands.
- **Green pulse on set completion** \u2014 150ms success-colour flash on the row when you tick it done. Pairs with the haptic nudge.
- **Collapsible notes area** \u2014 empty-state is now a small "Add workout notes" button instead of an always-visible empty textarea. Auto-expands once the notes field has content.
- **Workout-day dots on the calendar picker** \u2014 days with a completed workout get an accent dot under the date number. Calendar stops feeling dead.
- **Inline workout title** above the progress strip \u2014 tap to rename (Enter to commit, Esc to cancel).
- **Auto-name workouts** (setting) \u2014 when the name is empty and exercises are added, derive a default from primary muscle categories (Push Day / Pull Day / Leg Day / Arm Day / Upper Body / Full Body, etc.). Users can still tap-to-rename at any time.
- **Volume delta chip** on each exercise card \u2014 under the "Last time" row, shows +/\u2212% vs the previous session. Green for gains, red for regressions.
- **Progression nudge chip** \u2014 if last session hit target reps at a given weight, card shows "Try {weight+5} (+5)" next to the targets. Step is 2.5 kg in kilogram mode.
- **Auto-collapse completed exercises** (setting, off by default) \u2014 once every set on a card is ticked, the card collapses to its header. Tap to re-expand.
- **Reorder method setting** \u2014 choose Drag only / Buttons only / Drag + buttons. Default is both.
- **Per-exercise rest memory** \u2014 the rest timer now remembers how long you rested for each specific exercise (stored in `restPerExercise` setting). Heavy compounds automatically get longer rest than accessories on the next session. Starts with the global default for any exercise you haven't rested for yet; updates whenever the timer is completed or extended.

### Changed
- ExerciseCard re-fetches the last session reactively when the exercise id changes (previously only on first mount).
- Workout Settings section gets four new rows: Auto-collapse, Auto-name, Reorder method, plus the existing rest-timer block.

---

## v0.8.5-beta — 2026-04-18

Diary deep-dive pass. Three focused packs:

### Pack A — Themed confirms (also fixes a latent ActionSheet bug)
- New `ConfirmDialog` store + mount: `await confirmDialog({ title, message, confirmText, dangerous })` from anywhere returns a Promise. Renders through the existing themed `Dialog` component.
- Replaced every `confirm()` call across the app (10 sites: Diary, Programs, ProgramDetail, Settings, Coaching) — no more browser-chrome dialog against the dark UI.
- Fixed the Replace-workout silent-noop bug: ActionSheet callsites were using `open={X}` (one-way) so the child's self-close after select never synced back. Switched the four sites to `bind:open={X}`.

### Pack B — Daily-value UX (the wins you see every workout)
- **"Last time" ghost row under each exercise card** — pulls the most recent completed session via `getWorkoutHistory` and renders `Last (3d ago) · 135×10 · 135×10 · 135×8`. Removes the scroll-through-history dance that every competing app already solves.
- **Session progress strip** at the top of the exercise list — sets done, elapsed time, total volume moved. Gradient-fill progress bar ramps to green on full completion.
- **Explicit Finish Workout button** at the end of the list (visible once ≥ 1 set is completed). Pauses the timer, records duration, flips `completed = 1`, celebrates, opens the summary — gives proper closure even for partial workouts. Button turns into "View workout summary" after completion. Auto-fire on full completion still works and shares the same code path.

### Pack C — Logging ergonomics
- **Tap-to-select on weight/reps inputs** — single tap puts the cursor on a pre-selected value so typing overwrites. No more tap-then-backspace.
- **Haptic feedback on set completion** — subtle 12ms vibrate (harmless no-op where unsupported).
- **Drag-to-reorder exercises on desktop** — HTML5 drag with a gradient drop-indicator. Supersets move as a unit. Mobile keeps the up/down arrow buttons (native drag is unreliable on iOS).

---

## v0.8.4-beta — 2026-04-18

### Added
- **Coaching** (trainer-member mode) — the dormant `trainer` / `member` roles
  are now first-class features:
  - Admin pairs each member with a trainer via a new dropdown in Settings →
    User Management.
  - Trainers see a new **Coaching** page in the sidebar listing their assigned
    members, with per-member drill-down: streak, assigned programs, recent
    workouts, and prescribed workouts.
  - "Assign to member" button on any program the trainer owns.
  - Member's Programs list shows a **Coach X** badge on programs assigned by
    their trainer.
- **Prescribed workouts** — trainers can prescribe a specific workout to a
  member, optionally for a specific date.
  - New `coach_prescriptions` table (template reference or inline ad-hoc
    exercises; optional date; trainer note).
  - Member's Diary shows a **"Coach X prescribed …"** banner on prescribed
    days with a one-tap **Load** button that pre-fills the workout using the
    same flow as the template loader (progressive-overload auto-fill still
    applies).
  - Trainer's prescription list flags each dated prescription as Completed
    (✓ green) or Missed (red) based on whether the member logged a matching
    workout that day.

### Changed
- `POST /api/programs/:id/assign` now enforces trainer-owns-member (admins
  retain full access).
- Role changes clean up relationships: demoting a trainer nulls their
  members' `trainer_id`; demoting a member clears their own `trainer_id`.
- User deletion cascades through `coach_prescriptions` (both trainer and
  member references).
- Full backup now round-trips `users.trainer_id` and `coach_prescriptions`.

---

## v0.8.3-beta — 2026-04-18

### Added
- **Exercise info sheet for imported/orphaned data** — the info (ℹ️) button
  now handles exercises that lack an `exercise_id` (typical of Excel-imported
  workouts). Falls back to library search by name:
  - If a library match is found, shows details normally.
  - If no match (e.g. user removed the exercise from the library), shows
    a "not linked" state with a **Replace with library exercise** button
    that opens the picker in replace mode — preserves sets, reps, weight
    and notes while swapping identity, repairing the data in one tap.
  - Applies in both Diary and WorkoutEditor.
- **Shuffle-aware radio prefetch** — prefetch now commits to a single
  "next up" index in shuffle mode instead of fetching random tracks that
  rarely matched what actually played. Prefetched bytes are now the bytes
  that play next, cutting wasted bandwidth and silence gaps.
- **Fallback-path prefetch** — browsers/formats that fall through to the
  non-MSE `audio.src` path now warm the HTTP cache via a hidden
  `preload='auto'` audio element (fires at track start and again 15s
  before end). Previously only the MSE pipeline prefetched.

### Fixed
- Info button in WorkoutEditor did nothing for templates that predated
  the library-linking schema. Root cause was missing `exercise_id`, not
  a handler issue; the new name-fallback + Replace flow above resolves it.

---

## v0.8.2-beta — 2026-04-18

### Added
- **Statistics page redesigned** around a NutriTrace-style metric pill selector.
  Pick what to analyze — same range controls, summary card, chart, and history
  layout apply to every view. Scales to new metrics without reorganizing.
  - **Overview** (default) — streaks + workouts-this-range + avg/week cards,
    90-day activity heatmap, compact weekly volume + frequency charts
  - **Exercise Progress** — pick an exercise via searchable picker; shows
    top-set line chart over time, min/max/avg summary, and full session history.
    The headline "lifting app" feature that was previously missing.
  - **Records** — "Recent PRs" feed at top + PRs grouped by muscle category
    (Chest, Back, Shoulders, Arms, Legs, Core) instead of a single
    sort-by-absolute-weight list that compared curls to squats
  - **Volume** — weekly volume bar chart + muscle-group breakdown showing
    total volume per muscle; surfaces training imbalances at a glance
  - **Frequency** — workouts-per-week + weekday distribution (which day you
    train most)
  - **Body Weight** — trend line + current/min/max/change summary + history
    list, using the same pattern as every other metric
- **New server endpoints**:
  - `GET /api/stats/muscle-group-volume` — aggregates sets and volume by
    primary muscle, normalizing variants (pecs→chest, quads→legs, etc.)
  - `GET /api/stats/weekday-distribution` — workout counts per day of week

### Changed
- Statistics layout uses a single scrolling view but shows one focused metric
  at a time (matches NutriTrace). Removed the "everything at once" scroll that
  made specific data hard to find.
- Summary cards now adapt to the active metric instead of being fixed.
- Removed "Average workouts per week" hero card (redundant with the frequency
  chart it sat above).

---

## v0.8.1-beta — 2026-04-16

### Fixed
- **Loading spinner lingered after track started playing** — `_mseAppendAhead` (background prefetch of next 2 tracks) was flipping `isBuffering`, keeping the spinner on for 30+ seconds during cellular downloads. Background prefetch is now silent; `isBuffering` only reflects the current track's load.
- **Prev wrapping to last track** — `prev()` on track 0 (or double-tap via Android lock screen) wrapped `idx -1` to `q.length - 1`. Now restarts track 0, matching Spotify/Apple Music default behavior.
- **Next/prev jumping to wrong track after MSE auto-advance** — `onTrackAdvance` was updating `currentTrack` but leaving `queueIndex` stale. After auto-advancing from track 0 → track 3 via the buffer, hitting next sent you to track 1 (not 4). Now syncs `queueIndex` on every advance.
- **Lock-screen skip jumping multiple tracks** — some Android devices fire the Media Session `nexttrack`/`previoustrack` handler twice per tap. Added 300ms debounce so double-fires are ignored while intentional rapid skipping still works.
- **Queue click in full player played nothing** — handler was `playTrack(...) || queueIndex.set(i)` but `playTrack` now returns a Promise (always truthy), so `set(i)` never ran. Rewrote as proper click handler that updates `queueIndex` then plays.
- **Queue click started at the wrong time** — MSE's `_mse.reset()` cleared the buffer but didn't reset `audio.currentTime`. If you were 9s into a track and clicked another, the new track started at 9s. Now explicitly seeks to 0 after reset+append.
- **Lock-screen scrubber stopped playback** — OS sends `seekTime` as per-track time (0 to track duration) but we were setting `audio.currentTime = seekTime` directly. In MSE mode `audio.currentTime` is cumulative across the buffer, so this put you in the wrong buffer region. Now translates to absolute position: `entry.startTime + clamp(seekTime, 0, entry.duration)`.
- **±10s skip back/forward** in MSE mode now clamped to the current track's segment so it can't land in an adjacent track's buffered data.
- **Silence gap when clicking a song in the queue** — `playTrack` always did `_mse.reset()` + re-fetched, throwing away pre-fetched tracks. Now seeks into the existing buffer if the track is already there (instant), appends additively if not (spinner during download but existing buffered tracks preserved), and only does a full reset when a new queue is being loaded.

---

## v0.8.0-beta — 2026-04-16

### Added
- **MSE (MediaSource Extensions) audio pipeline** for gapless background playback.
  Single `<audio>` element fed by a continuous `SourceBuffer` — tracks are appended
  sequentially with matching `timestampOffset` so audio never pauses between tracks.
  Solves the Chrome background-tab-freeze issue that caused auto-advance to stall
  on locked screens. Falls back to direct `audio.src` for non-Jellyfin providers
  or unsupported browsers.
- **"Keep original format" radio setting** — plays raw files (bit-perfect FLAC,
  native MP3, etc.) when the queue uses a single consistent codec the browser can
  decode. Mixed-codec queues automatically fall back to 320 kbps MP3 transcoding
  so playback always works.
- **Loading indicator** on mini-player and full player when tracks are being
  fetched into the MSE buffer.
- **Pre-fetch 2 tracks ahead** so rapid double-skip doesn't stall on downloads.
- **Timer pause/resume/reset** split — pill persists while paused (preserves
  elapsed time), reset button on pill + "Reset timer" in ⋮ menu dismiss entirely.
- **Glassmorphism workout mode pill** matching the mini-player/bottom-nav style.
- **Reset (X) button** directly on the floating pill.
- **Auto-stop + save timer duration** when all workout sets are completed.
- **Lock-screen prev/next/seek handlers** fully registered at module load so they
  respond immediately.
- **Auto-skip on track format errors** — unsupported codec in one file doesn't
  stall the whole queue.

### Changed
- **Rewrote `player.js`** to match Google's canonical Media Session sample
  structurally — module-level handler registration, native `play`/`pause` events
  driving `mediaSession.playbackState`, metadata updated in `play().then(...)`,
  DOM-attached audio element per real-world PWA reports.
- **Workout mode pill** is now more translucent (0.45 background + 28px blur +
  200% saturate) for a proper glass effect.
- **`audio.currentTime`** in MSE mode is per-track-relative (not cumulative) for
  the progress bar and lock-screen `setPositionState`.
- **Jellyfin song metadata** now includes `container` field so the client can
  decide codec for the "Keep original format" path.

### Fixed
- **Background music auto-advance** on locked screen (via MSE — the core fix).
- **Skip buttons during playback** no longer show a "pause flash" caused by native
  `pause` event firing on src change.
- **X button in mini-player** no longer skips to next track (was triggering the
  auto-skip-on-error path via `audio.src=''`).
- **Audio element stuck state** after returning from a backgrounded tab — now
  re-issues play() on `visibilitychange` and forces `audio.load()` when the
  element's network state indicates a suspended buffer.
- **NaN duration display** for Jellyfin transcodes with Infinity duration.
- **Full player** album art now has top padding on desktop (drag handle is hidden).
- **Radio Artists tab** surfaces errors clearly; Jellyfin now tries
  `/Artists/AlbumArtists` first (more reliable) with fallback to `/Artists`.

---

## v0.7.2-beta — 2026-04-15

### Added
- **Program template per-set targets**: optional "Different weight or reps per set…" link in the WorkoutEditor expands into per-set rows for pyramid/drop/ramp programming. Stored as `set_specs: [{weight, reps}]` on the exercise. Uniform targets remain the default. When loaded into Diary, each set pre-fills with its specific target.
- **Program deactivation**: Active badge in ProgramDetail is now clickable (tap to deactivate). New `POST /api/programs/deactivate` endpoint.
- **Future-date planning** in Diary: "Plan ahead" empty state + blue "Planning ahead" badge on future workouts with exercises. PR/workout-complete celebrations suppressed when editing future dates.
- **Pause button on WorkoutModeBar** pill — pause the timer from any page.
- **Rest day reminder** (🧘 Rest Day) added to scheduler.

### Changed
- **Media Session** improvements for lock-screen playback: setPositionState periodically, playbackState signaling, global action handlers, seekto handler.
- **Next track preloading**: when current track has ≤6s remaining, pre-buffer next track in a warm audio element. On 'ended', swap to it instead of cold-fetching a new src — prevents auto-advance stalls on locked screens.
- **Audio element setup**: removed `crossOrigin='use-credentials'` (streams are same-origin), added `playsinline` attribute for mobile PWA background behavior.
- **Service worker**: explicit NetworkOnly route for `/api/subsonic/*` so media fetches bypass SW entirely (SW can be suspended on screen lock).
- **Workout completion** auto-stops the timer and persists duration before opening the summary (was showing `—`).

### Fixed
- **Date nav UTC/local drift**: prev/next day buttons in Diary skipped days or did nothing in negative UTC offsets. Now parse date with local noon (`T12:00:00`) so arithmetic stays within target day.
- **Exercise picker scroll in WorkoutEditor**: Sheet now uses `height="full"` like the Diary picker.

---

## v0.7.1-beta — 2026-04-13

### Added
- **Superset creation in Diary**: ⋮ more-options menu on each exercise card with "Add to existing superset", "Start new superset…", and "Remove from superset" actions. Uses same `superset_id` / `superset_size` / `superset_position` schema as WorkoutEditor so data stays compatible. Auto-dissolves supersets that drop below 2 members.
- **Progress-aware left-edge strip** on standalone exercise cards (NutriTrace-style): muted when no sets done, accent gradient when in progress, success green when all sets complete.
- **Progress-aware superset border**: card border turns accent while in progress, success green when all done (was only turning green when done).

---

## v0.7.0-beta — 2026-04-13

### Added
- **Floating WorkoutModeBar**: bottom-center pill that shows running timer (with centisecond precision, `MM:SS.cs`) and wake-lock status on every page. Tap timer to jump back to Diary; tap wake-lock to toggle from anywhere. Auto-positions above the music mini-player.
- **Statistics settings section**: chart type, lock Y-axis to zero, show average line, show trend line (exposes existing store settings).
- **Danger Zone** in Backup & Restore: Clear all settings, Clear all data, Delete my account — matches NutriTrace.
- **Self-delete account endpoint** (`DELETE /api/auth/me`) with full data cleanup cascade.
- **Clear all workout data endpoint** (`DELETE /api/settings/clear-data`).
- **Loop banner animations toggle** under Appearance (when banners are on).
- **Custom color picker Sheet** with HSL sliders, RGB inputs, hex input, live preview — replaces native color input.
- **Rest day reminder** notification: fires at 10 AM the day after a logged workout if no workout is logged yet. 🧘 Rest Day.
- **Remove-set button** (X) on each set row in Diary.
- **Add-exercise-to-superset** button inside the superset card with picker wiring.
- **Debounced workout save** (350ms) — fixes phantom delete when typing weights/reps.
- **Persistent workout timer**: state saved to localStorage, survives navigation/tab switch/PWA close, ticks via RAF for smooth centisecond display.
- **Global wake lock store**: separates user intent from lock state, re-acquires on visibility change, persists across routes.

### Changed
- **Settings reorganized**: Units & Format consolidated into one section (weight unit + date + time); sections regrouped — Display (Appearance, Units & Format), Workout (Workout, Statistics), Integrations, Data.
- **Page header** now `min-height: 40px` (was fixed 40px) with `line-height: 1.2` — long titles wrap without being clipped on mobile.
- **Exercise picker in Diary** now uses `height="full"` Sheet mode; removed `max-height: 80dvh` that blocked scrolling.
- **Exercises page filter bar** (search + category + equipment chips) is now sticky while scrolling; `overflow-x: hidden` on `.page` prevents horizontal shift from chip overflow.
- **Bottom nav** shown on all pages except wizard (was hiding on exercise detail, workout editor, profile).
- **Mini-player** uses dynamic `--nav-bar-h` to sit at correct bottom whether bottom nav is visible or not.
- **All pages** include `--mini-player-h` in bottom padding so content isn't hidden behind the player.
- **Workout summary**: only counts exercises with at least one completed set; weight×reps only when both > 0 (matches server stats).
- **Stats queries** (streaks, frequency, volume, records, progress) now require at least one completed set before counting a day.
- **Empty workout cleanup**: removing all exercises from a diary entry now deletes the `workout_log` row server-side instead of keeping an empty record.
- **Media Session API** enhanced: sets `playbackState` ('playing'/'paused'/'none'), calls `setPositionState()` for lock-screen progress, registers action handlers globally (not per-track), adds `seekto` handler.

### Fixed
- **Phantom delete on weight input**: changed `value={set.weight \|\| ''}` to `value={set.weight ?? ''}` so 0 displays correctly; debounced save prevents server round-trip from overwriting typed input.
- **Set completion clicks not registering**: added keyed `{#each ... (setIdx)}` so Svelte doesn't reuse DOM nodes across add/remove.
- **Wake lock released on page/tab switch**: moved to a global store with visibility-change re-acquire; intent vs state separated so browser releases don't cancel user intent.
- **Workout timer stopped on navigation**: moved to localStorage-backed store.
- **Music didn't advance to next track on lock screen**: Media Session now properly signals playback state and position.
- **Celebration notifications showed generic "test notification" text**: new `/api/notify` endpoint routes through `pushNotify()` with actual emoji-prefixed title/body instead of the test endpoint's fallback.
- **Exercise picker scroll blocked**: removed `max-height: 80dvh` + set Sheet to `height="full"`.
- **Page header clipped multi-line titles** (ExerciseDetail, Radio): changed fixed height to min-height.
- **Horizontal scroll on Exercises page**: `overflow-x: hidden` on `.page`.

---

## v0.6.0-beta — 2026-04-12

### Added
- **Progressive overload auto-fill**: when adding an exercise or loading a template, weight/reps are pre-filled from your last completed session. Toggle in Settings → Workout → "Auto-fill last weights" (default ON).
- **Gym Tools**: new utility in diary topbar (calculator icon) with two tabs:
  - **Plate Calculator**: enter target weight → shows plates needed per side with colored visual barbell, handles lbs and kg plate sets
  - **Unit Converter**: lbs↔kg instant conversion with large accent-colored result
- **Workout completion summary**: when all sets are checked off, a sheet shows total volume, sets, exercises, duration, and per-exercise breakdown. Toggle in Settings → Workout → "Completion summary" (default ON).
- **Last workout quick-load**: empty diary shows your 3 most recent workouts as one-tap cards with date and exercise count.
- **Exercise reordering**: up/down arrow buttons on each exercise card in the diary for mid-workout reordering.
- **Favorite exercises**: star icon on each exercise in the Exercises page. Favorites sort to the top of each category. Stored per-user.
- **Body weight chart**: SVG trend line on the Statistics page showing body weight over time from body stats entries.
- **Calendar heatmap**: 91-day grid on Statistics showing workout days (accent) vs rest days. Today is outlined.
- **Starter program templates**: 3 generic programs seeded on first boot for new users — Push/Pull/Legs, Upper/Lower, Full Body 3x. Each with complete exercise lists and target sets/reps.

### Changed
- **Notifications**: restructured into sub-sections (Delivery, Scheduled Reminders, Alerts & Celebrations, Summaries) matching NutriTrace. Push services in alphabetical order. Gotify test now reads stored config directly.
- **Email (SMTP)**: redesigned to NutriTrace-style card layout with form-group fields, show/hide password toggle, Save + Test buttons inline with status.
- **Notification messages**: emojis added (🏋️ Workout, 🔥 Streak, 💪 Complete, 🏆 PR, 📊 Summary) + "LiftTrace —" prefix on push notifications.
- **Email templates**: use actual app logo instead of 💪 emoji. Auto-captured public URL for weekly summary emails.
- **Buttons**: all buttons now have `.btn` base class for proper border-radius (12px). Fixed 8 squared buttons across 4 pages.
- **Offline page**: redesigned to match NutriTrace (card layout, tagline, branded colors).
- **Login recovery**: token field uses type="password" with separate instruction text.
- **buttons.css**: replaced hardcoded mint green with var(--accent-dim). File header corrected.
- **LiftBot FAB**: clamped to viewport on load and resize — can't be dragged off-screen.

### Fixed
- LiftBot FAB disappearing due to async env-locks timing. Now checks on mount, shows while loading.
- Push service test (Gotify/ntfy/Apprise) now reads stored config directly and returns specific error messages.

### Removed
- exercise-descriptions.json (600KB generated file) removed from repo. Descriptions come from XLSX imports only.
- Auto-fill description logic removed from exercise importer.

---

## v0.5.0-beta — 2026-04-12

### Added
- **Radio / Music Player**: integrated music streaming via Subsonic-compatible servers.
  - Four providers: Emby, Jellyfin, Plex, Subsonic (Navidrome/Airsonic/Gonic)
  - Library browser: Albums (random grid), Artists, Playlists, Search tabs
  - Mini-player: persistent bar above bottom nav with album art, controls, volume, close button
  - Full player: slide-up sheet with large album art, seekable progress, shuffle/repeat/volume, queue view
  - Crossfade setting (1-12 seconds) with dual audio element blend
  - Queue management: add to queue, play next, view/reorder/remove from full player
  - Now-playing indicator on track rows (accent highlight + equalizer icon)
  - Context menu (right-click): Play next / Add to queue
  - Media Session API for lock screen controls
  - Animated equalizer banner (JS-driven segmented LED bars with color gradient: green→yellow→red + floating music notes)
  - Radio nav item only shows when enabled + server URL configured
  - Settings: provider dropdown, server URL, credentials, crossfade, test connection, save button, experimental badge
- **Body Stats**: measurement tracking from the diary
  - Button in diary date-nav opens a slide-up sheet
  - Tracks: weight, body fat %, neck, chest, waist, hips, biceps, thighs, calves
  - Units auto-adapt (lbs/kg, in/cm)
  - Per-measurement visibility toggles in Settings → Workout
  - Saves per-date to body_stats_log table (API already existed)
- **Exercise Import**: custom XLSX upload with named catalogs
  - Downloadable blank template (list format: Exercise Name | Body Part | Equipment | Description)
  - Named catalogs: enter a name before importing (e.g. "My Exercises")
  - Enable/disable toggle per catalog (hides exercises without deleting)
  - Delete button for imported catalogs (online sources only have toggle)
  - Dedup by name+equipment within file; cross-source duplicates allowed
  - Auto-fill descriptions from bundled database when XLSX has none
- **Exercise Sub-filters**: equipment filter chips below category pills
  - Dynamic: shows equipment types present in current category with counts
  - E-Z Curl Bar merged into Barbell, Body Only/None merged into Bodyweight
  - Alphabetical order with Other always last
  - Category pills hidden when no exercises match
- **LiftBot Context**: AI coach now has access to real user data
  - Today's workout (exercises, sets, weights)
  - Body stats, personal records (top 10), streaks
  - Weight unit preference
- **LiftBot API Key**: save button + show/hide toggle + provider-specific "get your key" links

### Changed
- **Page headers**: matched NutriTrace layout exactly — hamburger-row/offset variables, line-height: 1.1, proper padding calculations
- **Banner height**: all pages now uniform (h1 40px fixed, padding-bottom 72px with banner), all local .page-header overrides removed
- **Program auto-seed**: disabled — Monumental Valley/Shredville no longer seed for new users
- **Single song play**: clicking a track plays only that song; Play All/Shuffle explicitly queue the full list
- **Exercise categories**: Free-Exercise-DB now maps by primary muscle → body part; cardio check runs before muscle check
- **Backup**: exercises table added to full backup dump + restore (was missing)

### Fixed
- Mini-player overlapping diary FABs (bottom padding includes --mini-player-h)
- Empty category pills (Cardio/Full Body/Other) hidden when no exercises match
- Exercise empty state changed from "sync from wger" to generic "import sources in Settings"
- SMTP env lock: only triggers when SMTP_HOST is non-empty (port default was false positive)

---

## v0.4.0-beta — 2026-04-12

### Added
- **Mandatory auth for PWA**: fresh installs force admin account creation in the wizard before any data is accessible. Server returns `setup_required: true` when no users exist. Prevents accidental open-access deployments.
- **Wizard upgrade** (5 steps): welcome → multi-user setup (optional toggle, forced when `setup_required`) → weight units → weekly goal → appearance. LiftBotFace robot icon on welcome.
- **User Management UI** in Settings: user list, add user form, invite with email/link, session duration config, disable user management.
- **Email (SMTP) config** in Settings: editable fields (host/port/TLS/user/pass/from), env-lock banner, test button.
- **Profile upgrade**: avatar upload (96px with camera overlay), email field, password change with complexity validation.
- **Notification system**: device notifications + push services (Gotify/ntfy/Apprise), server scheduler (15-min tick), workout reminders, streak alerts, PR/workout celebrations, weekly summary (push + email).
- **Sponsor links** in About section (GitHub Sponsors, Ko-fi).

### Changed
- **Settings visual overhaul**: flat section toggles (no card borders), single-card layouts with dividers, NutriTrace-matching style.
- **LiftBotFace component**: extracted to reusable component used in FAB, header, welcome, message avatars.
- **Page banners** default to on for new installs.
- **PWA config**: matched NutriTrace's workbox pattern (NetworkFirst navigation, null fallback) for proper install prompt.

### Fixed
- **Password validation bug** (CRITICAL): `/password` and `/users/:id/password` tested wrong variable (`password` instead of `new_password`). Extracted to reusable `validatePassword()`.
- **SMTP env lock**: empty env vars (`SMTP_HOST=`) falsely triggered lock, hiding all fields. Now only locks on non-empty values.
- **Settings reset on admin creation**: `user_settings` and `ai_chat_history` now migrated to first admin (were left orphaned with `user_id=NULL`).
- **Recovery endpoint**: requires `RECOVERY_TOKEN` env var (was accepting any request).

### Security
- **Rate limiting**: 10 attempts per 15-min window per IP on login, forgot-password, recover.
- **Upload auth**: `/api/upload` now requires authentication (was public).
- **JWT warning**: startup warning when using insecure dev default secret.
- **CORS**: explicit allowlist for same-host + Capacitor origins.
- **Password complexity**: 8+ chars, uppercase, lowercase, number, special character enforced everywhere via single `validatePassword()` function.
- **requireAdmin** passes in single-user mode (matching `requireAuth` pattern).

---

## v0.3.0-beta — 2026-04-12

### Added
- **Notification system**: device notifications (Web Notification API) + push services (Gotify, ntfy, Apprise). Server-side 15-min scheduler for workout reminders, streak alerts, and weekly summaries. PR and workout completion celebrations in the diary.
- **User Management UI** in Settings: user list with avatars, add user form, invite user with email or shareable link, session duration config, disable user management danger button.
- **Email (SMTP) config** in Settings: host/port/TLS/user/pass/from fields, test email button, env-lock banner.
- **Profile upgrade**: 96px avatar with upload, email field, password change with complexity validation + show/hide toggle.
- **Sponsor links** in About section (GitHub Sponsors, Ko-fi).

### Changed
- **Settings layout**: consolidated multiple cards per section into single cards with `setting-divider` lines between logical groups — matches NutriTrace's unified flow.
- **Password requirements**: 8+ chars, uppercase, lowercase, number, special character (was 4 chars).
- **Recovery endpoint**: now requires `RECOVERY_TOKEN` env var (was accepting any request).
- **Email templates**: added personalized greeting, fallback URL below CTA, safety text, weekly summary template.

### Fixed
- `.env.example` and `docker-compose.yml`: added missing `RECOVERY_TOKEN` and `LOG_LEVEL` vars.

---

## v0.2.0-beta — 2026-04-11

### Added
- **Rest timer**: configurable countdown between sets with auto-start on set completion, vibrate + tone alerts, +30s extend, skip button. Settings: toggle, duration (30s–5min), auto-start, alert.
- **Exercise catalog sources**: multi-source exercise library — wger (~600), Free Exercise DB (~870 with images), ExerciseDB via RapidAPI (~1,300 with animated GIFs). Import/remove per source in Settings.
- **Exercise media**: ExerciseDetail renders video, animated GIFs, or start/end image swap depending on what the source provides. Source badge on each media card.
- **Animated page banners**: five SVG banners (Diary, Exercises, Programs, Statistics, Settings) using `var(--accent)` at low opacity. Toggleable in Settings. Respects `prefers-reduced-motion`.
- **LiftBot AI chat**: full NutriTrace-style chat panel — mobile bottom sheet (88vh) / desktop floating card (420x640px), fly transition, animated typing dots, quick-ask chips, image attachments (camera/gallery), gradient user bubbles, message timestamps, unread badge.
- **LiftBot FAB**: glassmorphism floating button with gradient animation, ring pulse, draggable with localStorage persistence, custom flexing robot SVG icon with arm sway + eye blink animations.
- **Settings overhaul**: collapsible sections with icons, sticky search bar (keyword matching), profile hero card with gradient avatar, hint subtitles, conditional sidebar toggle, reset to defaults.
- **Backup & restore**: NutriTrace-style UI — backup list table with download/restore/delete per entry, upload & restore with XHR progress tracking, confirmation dialogs, progress bar.
- **App icons**: full icon pack (192, 512, 180 apple-touch, 1024 master) in PWA manifest + index.html.
- **4 missing accent palettes**: pink, rose, cyan, lime (dark + light theme rules).
- **Centralized version**: `src/lib/version.js` used by Settings and Sidebar.

### Changed
- **Diary header**: now uses the global `.page-header` pattern with gradient `<h1>Diary</h1>` title, matching all other pages. Date bar is a secondary sticky element below.
- **Diary date bar**: reduced to match NutriTrace height (17/12px text, 32px nav buttons, 6px padding). Safe-area padding only applied when no banner is above.
- **Calendar date picker**: portal-based with `max-width: 600px; margin: 0 auto` (prevents desktop blowup).
- **WorkoutTimer**: now shows `H:MM:SS` when duration exceeds 1 hour.
- **Docker image**: moved from `ghcr.io/traceapps/lifttrace` to `ghcr.io/traceapps/lifttrace`.

### Fixed
- Accent colors pink/rose/cyan/lime had no CSS rules — fell through to default orange.
- Backup routes failed with "Not authenticated" in single-user mode (no users registered).
- Settings section toggles didn't expand — Svelte reactivity gap with function-based dependency tracking.
- Calendar overflow on desktop — was inside a Sheet with no max-width constraint.

---

## v0.1.0-alpha — 2026-03-30

### Added
- Initial release
- Workout diary with daily logging, set tracking, superset support
- Programs and workout templates with Excel import
- Exercise library seeded from wger API
- Statistics dashboard (streaks, volume, frequency, personal records)
- Settings with theme, accent color, navigation style, units
- Multi-user support with roles (admin, trainer, member)
- PWA with installable manifest
- Docker deployment with GitHub Actions CI
- LiftBot AI assistant (basic chat)
