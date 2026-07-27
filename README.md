<h1 align="center">LiftTrace</h1>

<p align="center"><b>Track Every Rep, Set, and PR</b></p>

<p align="center">A self-hosted weightlifting tracker.<br/>
No accounts, no telemetry, no cloud sync unless you opt in.</p>

<p align="center">
  <img src="public/icons/logo-transparent.png" alt="LiftTrace" width="180" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href="https://github.com/traceapps/lifttrace/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/traceapps/lifttrace?label=release&color=blue"></a>
  <a href="https://github.com/traceapps/lifttrace/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/traceapps/lifttrace/total?label=downloads&color=blue"></a>
  <a href="https://traceapps.github.io/docs/lifttrace/"><img alt="Documentation" src="https://img.shields.io/badge/docs-traceapps.github.io-4A90E2?logo=readthedocs&logoColor=white"></a>
  <a href="https://github.com/traceapps/lifttrace/pkgs/container/lifttrace"><img alt="Docker image" src="https://img.shields.io/badge/docker-ghcr.io%2Ftraceapps%2Flifttrace-2496ED?logo=docker&logoColor=white"></a>
  <a href="https://github.com/traceapps/lifttrace/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/traceapps/lifttrace?style=flat"></a>
</p>

---

LiftTrace runs entirely in a single Docker container on your own hardware, with a PWA for the browser and a native Android app for your phone. No accounts on external services, no data leaving your network, no subscriptions.

![Diary screenshot](docs/screenshots/01-diary.png)

---

## Principles

- **Self-hosting is free.** No paid tiers, no premium-only features behind a subscription, no nag screens.
- **No telemetry.** LiftTrace never phones home. There is no central server that receives your data, no analytics, no crash reporting, no fingerprinting.
- **Your data, your hardware.** Everything lives in a single SQLite file and an uploads folder on your machine. Back up either with `cp`, restore with `cp`, migrate to a new server by moving the volume.
- **AGPL-3.0.** The source is open and the network-use clause keeps it that way.

---

## Features

### Diary
- Daily workout logging with date navigation and calendar picker
- Per-exercise set tracking: weight, reps, RPE (optional), completion checkboxes
- **Warm-up sets.** Marked separately, excluded from volume, PRs, rest-timer firing, and workout summaries.
- **Smart Add.** Type or speak your workout ("bench 3x5 @ 225, A1: curls 3x12 @ 30, A2: pushdowns 3x12 @ 40") and Trace parses prose into structured sets and matches exercises against your library. Handles AMRAP, RPE, ranges, bodyweight, and supersets. Also available as a hold-to-record gesture on the Trace FAB: press and hold, speak, release to commit.
- **Progressive overload auto-fill.** Pre-fills weight/reps from your last session.
- **Program template prefill.** Target weight/reps from active program templates flow into the diary when you load a workout.
- **Coach prescriptions.** If a trainer has prescribed today's workout, it shows in Diary on the right day.
- **Last workout quick-load.** Recent workouts as one-tap cards on empty diary.
- **Workout completion summary** with a **Share** button. Generate a 1080×1350 PNG card and share via native share sheet on mobile or download on desktop.
- **Exercise reordering**, **add/remove sets on the fly**, **confirm before removing**
- Superset grouping with visual cards, circuit management, and **superset-aware rest timer** (only fires between rounds, not between exercises in a round)
- **Progress-aware card accents.** Left-edge strip colors reflect set completion at a glance.
- **Auto-collapse completed exercises and supersets** when every set is done
- **Floating workout mode bar.** Centisecond timer + wake-lock toggle visible on every page.
- Rest timer with countdown, auto-start on set completion, **separate vibrate and tone toggles**, persistent across navigation
- **Gym Tools.** Plate calculator + lbs↔kg converter in the diary toolbar.
- Body stats logging (weight, body fat, measurements) from the date bar
- Screen wake lock to keep your phone on during workouts
- **Right-click = long-press** on desktop for quick actions on exercise cards

### Programs & Templates
- Create structured programs with multiple workout templates
- Goal-based programs: strength, hypertrophy, cutting, bulking, endurance, general
- **Starter templates** seeded for new users (Push/Pull/Legs, Upper/Lower, Full Body 3x)
- Template reordering, duplication, and assignment to users
- Active program indicator, load today's workout with one tap
- **Multi-week progression** (v1.0.1). Programs can carry per-week Sets, Reps, Tempo, Rest, and Load matrices instead of a flat template. Advance modes: **Sessions** (roll to the next week when the current one is complete) or **Calendar** (roll on a fixed day of the week). On-complete behavior: **Hold** at the final week or **Repeat** the cycle. The diary previews the next session's target load so you know what to lift before you walk in.

### Exercise Library
- Multi-source exercise catalog:
  - **wger.** ~600 exercises, free and open (CC-BY-SA).
  - **Free Exercise DB.** ~870 exercises with start/end position images (public domain).
  - **ExerciseDB.** ~1,300 exercises with animated GIFs (RapidAPI, free tier available, bring your own key).
  - **ExerciseDB (Open Source).** Self-hostable mirror at `oss.exercisedb.dev` with no API key required; point at your own instance via the `EXERCISEDB_OSS_URL` env override.
- **Custom exercises.** Create your own with uploaded images, GIFs, videos, or YouTube embeds. They appear inline in the library with a "Custom" chip.
- **Custom XLSX Import.** Bulk-import exercises from a spreadsheet with named catalogs, equipment tags, and descriptions.
- Exercise detail view with animated media, search, category filtering, equipment sub-filters
- **Similar exercises.** Every detail page suggests substitutes based on primary/secondary muscle overlap.
- **Favorite exercises.** Star icon per exercise, favorites sort to top.
- Personal record tracking per exercise
- Enable/disable individual sources and imported catalogs independently

### Statistics
- **Metric-pill layout.** Pick what to analyze (Overview / Exercise Progress / Records / Volume / Frequency / Body Weight); same controls for every view.
- **Overview**: streaks, workouts in range, avg per week, 90-day activity heatmap, weekly volume + frequency charts
- **Exercise Progress**: pick any exercise and see top-set weight over time, min/max/avg, and complete session history
- **Records**: recent PRs feed + PRs grouped by muscle category
- **Volume**: weekly totals + muscle-group breakdown showing imbalances
- **Frequency**: weekly counts + weekday distribution
- **Body Weight**: trend line + current/min/max/change summary
- Configurable date ranges (1W / 1M / 3M / 6M / 1Y / All) apply to every metric

### Trace, AI Coach
- Floating draggable chat assistant with animated robot face shared across the TraceApps family
- **Live data context.** Every message sends the active program + templates, last 14 workouts (warm-ups filtered, RPE annotated), 30-day body weight trend, top 10 PRs, weekly goal + 4-week frequency, streaks, and today's coach prescription if one exists.
- **Hold-to-voice-log.** Press and hold the FAB to record a voice workout; release on the FAB to commit (parses and opens the Smart Add review screen), slide off to cancel.
- **Frequency visualizer ring.** 32 SVG bars radiate from the FAB while music is playing, driven by real-time Web Audio analysis.
- Attach photos for form checks (camera or gallery)
- Quick-ask suggestion chips
- Supports Claude (Anthropic), OpenAI, Google Gemini, and any OpenAI-compatible endpoint (Ollama, LM Studio, DeepSeek, Groq, etc.)
- Bring your own API key, or use the server-side proxy and lock the provider for all users

### Radio (Music Player)
- Stream music from your self-hosted media server during workouts: **Subsonic** (Navidrome, Airsonic, Funkwhale, Gonic), **Jellyfin**, **Plex**, **Emby**
- **Streaming stations.** Internet radio URLs (Icecast, Shoutcast, HLS / `.m3u8`) with browse, add/edit/delete, station groups, and **now-playing metadata** from `StreamTitle`, `text=`, RDS Italia, and embedded ID3 frames.
- Library browser: albums, artists, playlists, search
- Mini-player bar + full player with album art, seekable progress, shuffle, repeat, queue
- **MSE pipeline** on web for gapless, background-resilient playback. Audio never pauses between tracks so locked-screen tab-freeze can't stall auto-advance.
- **Unified Android player.** Radio + library both flow through Media3 ExoPlayer + MediaSession with lockscreen + Bluetooth controls (Stop for radio, Prev / Next / Stop for library).
- **Keep original format** toggle for bit-perfect playback; falls back to 320 kbps MP3 transcoding when codecs are mixed
- **2-track pre-fetch** so skip is instant for large files
- Crossfade between tracks (1-12 seconds)
- Full lock-screen controls via Media Session API

### Coaching
- Trainer accounts build templates and prescribe workouts to athletes
- Prescriptions show in Diary on the right day
- Trainer / athlete pairing managed in Settings → User Management
- One athlete can have multiple trainers

### Multi-User
- Mandatory account creation on first PWA visit (secure by default)
- Role-based access: **admin**, **trainer**, **member**
- Admin invites via email or shareable link
- All data scoped per user
- Configurable session timeout (up to 1 year, cap configurable in env)
- **zxcvbn password strength** validation across wizard, profile, reset, and accept-invite flows
- Email (SMTP) configuration in Settings or via environment variables
- **Recovery token** to disable user management from the login page if you get locked out

### Single Sign-On (OIDC)
- Multi-provider OIDC SSO: sign in via **Authentik**, **Keycloak**, **Pocket ID**, **Authelia**, **Auth0**, **Google**, or any OIDC 1.0 provider supporting Authorization Code Flow + PKCE + Discovery
- Provider preset picker (pre-fills sensible defaults per IdP) plus a Custom option
- **Auto-link** verified emails to existing accounts and **Auto-register** blanket-signup toggles
- **Admin group mapping.** Promote users to admin based on group claims.
- Configurable from Settings → User Management → OIDC providers, or declared in env (`OIDC_*` / `OIDC_PROVIDER_N_*`). Env-defined providers show with a lock badge and are read-only in the UI.
- **SSO-only mode via env.** Set `OIDC_ENABLE_EMAIL_PASSWORD_LOGIN=0` (or `false` / `no`) to disable password login server-wide; users must sign in via an OIDC provider. When set, the "Allow Password Login" toggle in Settings also becomes read-only with an env-lock note. Recovery via `RECOVERY_TOKEN` still works.
- Encrypted client secrets at rest (AES-GCM with HKDF-derived key)
- **RP-initiated logout.** Signing out also ends the session at the IdP via the standard OIDC end-session endpoint (using `id_token_hint`), so the next sign-in isn't silently completed by a still-alive IdP session. Register two Post Logout Redirect URIs at your IdP: `https://your-lifttrace-host/` for PWA and `lifttrace://oidc-callback` for Android. Falls back to a local-only clear when the IdP doesn't publish an `end_session_endpoint`.

### Workout History Import
- Bring your old log in from **Strong**, **Hevy**, **FitNotes**, or **Jefit** (CSV exports), or from **Garmin FIT** files exported from Garmin Connect
- Two-step preview → commit flow
- Fuzzy-matches exercise names against your library; unmatched names persist as free-text and can be relinked later
- Skip vs replace on duplicate-date workouts

### Body Stats
- Log body measurements from the diary (scale icon in date bar)
- Track: weight, body fat %, neck, chest, waist, hips, biceps, thighs, calves
- Per-measurement visibility toggles in Settings
- Units adapt to your weight unit preference (lbs/kg → in/cm)

### Settings & Customization
- Light / dark / system theme
- 12 accent color presets + custom hex color picker
- Configurable navigation (bottom bar, sidebar, or both)
- Animated page banners (toggle on/off)
- Collapsible settings sections with sticky search bar
- Date and time format options (US / EU / ISO, 12h / 24h)
- Weight units (lbs / kg)

### Notifications & Reminders
- Device notifications (Web Notification API) + push services (Gotify, ntfy, Apprise)
- Workout day reminders, rest day reminders, streak alerts
- Workout completion and personal record celebrations
- Weekly summary (push + email) with workout count and volume

### Backup & Restore
- Full backup: ZIP archive of all database tables + uploaded exercise media
- Backup list with download, restore, and delete per entry
- Upload and restore from a backup taken on another instance
- Progress indicator during upload and restore
- Reset to defaults (settings only, workout data preserved)

---

## Apps

### Web (PWA)
LiftTrace is a Progressive Web App. Open it in any modern browser and install via the address bar (Chrome) or share menu (Safari). It works offline once cached and gets a proper app icon, full-screen mode, and OS-level navigation.

### Android
A native Android app is published on the [Releases](https://github.com/TraceApps/lifttrace/releases) page. Sideload the signed APK from any release tag (e.g. `lifttrace-v1.0.1.apk`). The app is a Capacitor 8 shell around the same PWA, with these native upgrades:

- **Offline-first.** Runs entirely locally with on-device SQLite, or connects to a self-hosted LiftTrace server for sync.
- **Native setup wizard** on first launch: pick Local mode or Server mode
- **Biometric sign-in** (fingerprint / face) for the app
- **Native ExoPlayer** for radio + library playback with lockscreen + Bluetooth controls
- **WorkManager-based reminders** (optional) for reliable rest-timer + workout-day notifications even when the app is killed
- **Local image cache** for exercise media so the library is browseable offline
- **Local backup.** JSON dump of every cached table via the share sheet.
- **Voice input** on the Trace FAB

Release-signed APKs require HTTPS to your server (see [DEPLOY.md](DEPLOY.md) for the four supported paths including self-signed certs). Debug-signed APKs (built locally) accept any URL including plain HTTP.

**Testing pre-release.** The [`dev-latest`](https://github.com/TraceApps/lifttrace/releases/tag/dev-latest) pre-release carries a rolling signed APK built from the `dev` branch. Same signing key as stable, so you can upgrade from stable to dev in place (Android blocks the reverse without an uninstall). Not recommended for production, but useful for beta-testing incoming fixes and features. Refreshed periodically when a dev build is deemed ready, not on every dev push.

### iOS
There is no iOS app yet. Install the PWA from Safari (Share → Add to Home Screen) for the closest equivalent. A native iOS build is not blocked by code (Capacitor supports iOS), but it requires a Mac and a paid Apple Developer account, which isn't on the roadmap.

---

## Self-Hosting with Docker

### Quick Start

```yaml
services:
  lifttrace:
    image: ghcr.io/traceapps/lifttrace:latest
    container_name: lifttrace
    ports:
      - "3002:3003"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      - DB_PATH=/data/db/lifttrace.db
      - UPLOADS_PATH=/data/uploads
      - JWT_SECRET=change-me-to-a-long-random-string
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open `http://localhost:3002` and you're lifting.

**Choosing a tag.** `:latest` follows every stable release. Pin `:1.0` to auto-receive patches without opting into future minors, `:1` for auto-minor within the major, or `:1.0.0` for an exact reproducible pin. `:dev` tracks the leading edge (not recommended for production). Legacy `:1.0.0-rc.N` tags stay published indefinitely. See [DEPLOY.md](DEPLOY.md) for the full tag table.

See [DEPLOY.md](DEPLOY.md) for the full guide: reverse proxies, subpath mounting, Cloudflare Tunnel, Docker secrets, and the four Android HTTPS paths.

### Environment Variables

The most common ones. Full reference in [DEPLOY.md](DEPLOY.md) and [.env.example](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `./lifttrace.db` | SQLite database file path |
| `UPLOADS_PATH` | `./uploads` | Uploaded exercise media directory |
| `JWT_SECRET` | (required in prod) | JWT signing secret; server refuses to start in prod with the dev default |
| `TOKEN_ENC_KEY` | derived from `JWT_SECRET` | At-rest encryption key for OIDC client secrets |
| `PORT` | `3003` | Server port inside the container |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `EXERCISE_SOURCES` | `wger,free-db` | Comma-separated list of sources to auto-seed on first boot (`wger`, `free-db`, `exercisedb`, `exercisedb-oss`) |
| `INSECURE_COOKIES` | `0` | Set `1` only for non-HTTPS deployments |
| `BASE_URL` | (none) | Mount at a subpath (e.g. `/lifttrace`) instead of root |
| `RECOVERY_TOKEN` | (none) | Token required to use the "Disable user management" recovery endpoint |
| `SMTP_*` | (none) | SMTP for password reset emails and user invites |
| `AI_*` | (none) | Server-side AI proxy; `AI_PROVIDER` accepts `claude` \| `openai` \| `gemini` \| `oai-compat`; set `AI_BASE_URL` for `oai-compat` (Ollama, LM Studio, LocalAI, vLLM, etc.) so a private-network LLM works without exposing it to the browser |
| `OIDC_*` / `OIDC_PROVIDER_N_*` | (none) | OIDC SSO declared in env instead of the UI |
| `OIDC_ENABLE_EMAIL_PASSWORD_LOGIN` | (none) | Set to `0` (or `false` / `no`) to disable password login server-wide (SSO-only). Truthy values (`1` / `true` / `yes`) explicitly enable. Locks the corresponding admin UI toggle when set. |

### Data Persistence

All data lives in two bind-mounted directories:
- `/data/db/lifttrace.db`: SQLite database (workouts, exercises, programs, body stats, settings, AI chat history)
- `/data/uploads/`: exercise images, GIFs, videos, full-backup ZIPs

Back up both with `cp -r` or any volume-aware tool. Restore by stopping the container, replacing both, and starting again.

### Updating

```bash
docker compose pull
docker compose up -d
```

Data is in bind-mounted volumes and persists across updates.

---

## Translations

LiftTrace is built for translation via [svelte-i18n](https://github.com/kaisermann/svelte-i18n) with one JSON file per locale in `src/i18n/`. Adding a new language is straightforward: copy `src/i18n/en.json` to `src/i18n/<code>.json`, translate values, register the locale in `src/i18n/index.js`, and run `npm run i18n:check`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full flow.

About a third of UI strings are extracted as of `1.0.0-rc.1`, the surface every user touches every session. The rest is being extracted incrementally; PRs that grow the extracted set are welcome.

---

## Tech Stack

- **Frontend**: Svelte 5 (running in Svelte-4 compatibility mode), svelte-spa-router (hash routing), Vite 6, custom SVG charts
- **Backend**: Express 5, better-sqlite3, bcryptjs 3, JWT auth (cookie-based)
- **PWA**: vite-plugin-pwa, installable on any device
- **Android**: Capacitor 8, Media3 ExoPlayer, WorkManager, @capacitor-community/sqlite
- **AI**: Multi-provider (Claude, OpenAI, Gemini, OpenAI-compatible) with multimodal image support
- **Deploy**: Docker multi-stage build, GitHub Actions CI → GHCR

---

## Development

```bash
# Frontend dev server (port 5173, proxies API to :3003)
npm install
npm run dev

# Backend (in a separate terminal)
cd server
npm install
npm run dev
```

Android build:
```bash
npm run android:debug     # vite build + cap sync + assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request guidance and the translation workflow.

---

## Troubleshooting

- **Login appears to succeed but every page 401s** → the auth cookie is issued with the `Secure` attribute, so browsers refuse to store it over plain HTTP. The login itself returns `200`, but the cookie is dropped client-side and every subsequent request comes through cookieless. Firefox logs `Cookie "lt_token" has been rejected because a non-HTTPS cookie can't be set as "secure"` in the console; Safari fails silently. Fix: set `INSECURE_COOKIES=1` (LAN-only) or put TLS in front (Caddy, nginx + certbot, Tailscale Funnel, etc.).
- **Android app says "Connection failed" with HTTPS hint** → release APK rejects `http://`. See [DEPLOY.md](DEPLOY.md) → Connecting from Android for the four supported paths.
- **Exercise images not loading on Android** → external image URLs are proxied through the server. Check that the server is reachable from the device and `/api/proxy` returns 200.
- **Rest timer beeps don't fire when the app is backgrounded** → on Android, enable the WorkManager-based scheduler in Settings → Notifications.

For anything else, open an issue at [github.com/TraceApps/lifttrace/issues](https://github.com/TraceApps/lifttrace/issues).

---

## Sister App

LiftTrace is part of the **TraceApps** family alongside [**NutriTrace**](https://github.com/TraceApps/nutritrace), a self-hosted nutrition tracker. Same philosophy: privacy-first, self-hosted, full data ownership. Shared AI persona (Trace) and visual design language.

---

## Support

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/traceapps)

If LiftTrace has been useful and you'd like to support development, the Ko-fi link above is the easiest way. Sponsorship doesn't unlock any features (everything stays AGPL and free), but it helps keep the project sustainable. Just as helpful: open an issue with a bug report, share the project, or contribute a translation.

---

## Disclaimer

LiftTrace is not medical, health, or fitness-professional software. It does not provide medical advice, diagnosis, treatment, or personalized training prescriptions. Exercise library content, Trace AI coaching, program templates, rest-timer guidance, and any analytical output (volume, PRs, frequency, body-weight trends) are for informational and self-tracking purposes only.

Resistance training carries inherent risk of injury. Exercise selection, load, technique, and progression can interact with medical conditions (heart and cardiovascular conditions, high blood pressure, prior surgery, hernias, joint or spinal issues, osteoporosis, pregnancy, connective-tissue disorders, recent injury or rehabilitation status) in ways this app cannot assess. Consult a qualified healthcare professional, certified strength coach, or licensed physical therapist before starting a new training program, returning from injury, or making significant changes to your routine.

Trace AI answers can be incorrect or incomplete; treat them as a starting point, not a substitute for human judgment or professional advice. Exercise library data is sourced from public databases (wger, Free Exercise DB, optionally ExerciseDB via RapidAPI) and may contain inaccuracies. **Use at your own risk.**

When you enable the optional **ExerciseDB** source in Settings, you bring your own RapidAPI key and consume your own quota. LiftTrace is not affiliated with RapidAPI or ExerciseDB and is not the API consumer; your use of that integration is governed by RapidAPI's and the API provider's terms.

---

## License

AGPL-3.0: see [LICENSE](LICENSE) for details. By contributing you agree your contributions are licensed under the same.
