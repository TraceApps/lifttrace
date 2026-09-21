<h1 align="center">LiftTrace</h1>

<p align="center"><b>Track Every Rep, Set, and PR</b></p>

<p align="center">A self-hosted weightlifting tracker.<br/>
No accounts, no telemetry, no cloud sync unless you opt in.</p>

<p align="center">
  <img src="public/icons/logo-transparent.png" alt="LiftTrace" width="180" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href="https://github.com/traceapps/lifttrace/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/traceapps/lifttrace?label=release&color=orange"></a>
  <a href="https://github.com/traceapps/lifttrace/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/traceapps/lifttrace/total?label=downloads&color=brightgreen"></a>
  <a href="https://github.com/traceapps/lifttrace/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/traceapps/lifttrace?style=social"></a>
  <a href="https://traceapps.github.io/docs/getting-started/compose/"><img alt="Platform" src="https://img.shields.io/badge/platform-Web%20%7C%20Android%20%7C%20Wear%20OS%20%7C%20Docker-lightgrey"></a>
  <br/>
  <a href="https://traceapps.github.io/docs/lifttrace/"><img alt="Documentation" src="https://img.shields.io/badge/docs-traceapps.github.io-8A2BE2?logo=readthedocs&logoColor=white"></a>
  <a href="https://github.com/traceapps/lifttrace/pkgs/container/lifttrace"><img alt="GHCR" src="https://img.shields.io/badge/ghcr.io-traceapps%2Flifttrace-181717?logo=github&logoColor=white"></a>
  <a href="https://hub.docker.com/r/traceapps/lifttrace"><img alt="Docker Hub pulls" src="https://img.shields.io/docker/pulls/traceapps/lifttrace?logo=docker&logoColor=white&label=docker%20pulls&color=2496ED"></a>
</p>

<p align="center">
  <b>iOS fund:</b> the Trace apps have no iOS app yet, because building one needs a Mac and an iPhone.
  <a href="https://ko-fi.com/traceapps">Chip in on Ko-fi</a>. Self-hosting stays free either way.
</p>

---

**Jump to:** [What it is](#what-lifttrace-is) · [Features](#features) · [Install](#install) · [Env vars](#env-vars) · [Docs](https://traceapps.github.io/docs/lifttrace/)

---

## What LiftTrace is

LiftTrace runs entirely in a single Docker container on your own hardware, with a PWA for the browser and a native Android app for your phone. No accounts on external services, no data leaving your network, no subscriptions. Log workouts, run programs, browse a multi-source exercise library, and ask an AI coach for form checks, all against your own SQLite file.

## Principles

- **Self-hosting is free.** No paid tiers, no premium-only features behind a subscription, no nag screens.
- **No telemetry.** LiftTrace never phones home. There is no central server that receives your data, no analytics, no crash reporting, no fingerprinting.
- **Your data, your hardware.** Everything lives in a single SQLite file and an uploads folder on your machine. Back up either with `cp`, restore with `cp`, migrate to a new server by moving the volume.
- **AGPL-3.0.** The source is open and the network-use clause keeps it that way.

---

![LiftTrace diary view](docs/screenshots/01-diary.png)

---

## Features

- **Diary and set logging.** Weight, reps, RPE, warm-up marking, Smart Add prose parser, superset-aware rest timer, floating workout mode bar, workout completion share card. → [full guide](https://traceapps.github.io/docs/lifttrace/diary/)
- **Programs and templates.** Starter templates (Push/Pull/Legs, Upper/Lower, Full Body 3x), multi-week progression with Sessions or Calendar advance modes (v1.0.1). → [full guide](https://traceapps.github.io/docs/lifttrace/programs/)
- **Exercise library.** Four sources: wger (~600, CC-BY-SA), Free Exercise DB (~870, public domain), ExerciseDB (~1,300, RapidAPI BYO key), and ExerciseDB Open Source (self-hostable mirror, no key). Plus custom exercises and XLSX bulk import. → [full guide](https://traceapps.github.io/docs/lifttrace/exercises/)
- **Statistics and PRs.** Metric-pill layout with Overview, Exercise Progress, Records, Volume, Frequency, and Body Weight views; automatic PR detection. → [full guide](https://traceapps.github.io/docs/lifttrace/statistics/)
- **Progress photos.** Dated photos alongside your body stats, with a drag-to-compare before/after view for any two dates. Photos never expire, sync across devices, and are included in full backups. → [full guide](https://traceapps.github.io/docs/lifttrace/progress/)
- **Trace AI coach.** Reads your workouts, programs, PRs, body stats, and coach prescriptions; can log a workout, prescribe (if you are a coach), start a program template, or update your active program, all conversationally. 18 tools total. Multi-provider (Claude / OpenAI / Gemini / any OpenAI-compatible endpoint). Hold-to-record voice log, FFT visualizer. → [full guide](https://traceapps.github.io/docs/lifttrace/trace/)
- **Radio player.** Stream from Subsonic (Navidrome, Airsonic, Funkwhale, Gonic), Jellyfin, Plex, Emby, plus Icecast/Shoutcast/HLS internet radio with now-playing metadata. → [full guide](https://traceapps.github.io/docs/lifttrace/radio/)
- **Coaching.** Trainer accounts prescribe workouts to athletes; prescriptions surface in Diary on the right day. → [full guide](https://traceapps.github.io/docs/lifttrace/coaching/)
- **Workout history import.** Bring your old log in from Strong, Hevy, FitNotes, Jefit (CSV) or Garmin FIT files. → [full guide](https://traceapps.github.io/docs/lifttrace/import/)
- **Multi-user and OIDC SSO.** Role-based access (admin/trainer/member), invites, session policy, plus OIDC 1.0 SSO via Authentik, Keycloak, Pocket ID, Authelia, Google, Auth0, or any compliant provider. → [full guide](https://traceapps.github.io/docs/auth/oidc/)
- **Native Android app.** Local-only mode with on-device SQLite, or connect to your self-hosted server for sync. Media3 ExoPlayer, WorkManager reminders, biometric sign-in. → [full guide](https://traceapps.github.io/docs/mobile/install/)
- **Wear OS.** A watch app for Wear OS 3 and up: the set you are on with weight and reps already filled in and what you lifted last time, any set in the session open to change, sets added or put back to not done, supersets alternating properly, holds counted down and logged, and the rest timer buzzing on your wrist even with the watch face back, plus a tile and a watch face complication. It talks to your server itself, so it keeps logging in a basement gym with the phone in a locker, and it pairs itself when you sign in on the phone.

---

## Apps

- **Web (PWA).** Install from any modern browser via the address bar (Chrome) or share menu (Safari). Works offline once cached.
- **Android.** Sideload the signed APK from the [Releases](https://github.com/TraceApps/lifttrace/releases) page. Release APKs require HTTPS to your server; debug APKs accept plain HTTP. See [DEPLOY.md](DEPLOY.md) for the four supported paths.
- **Wear OS.** A separate APK for the watch, on the same [Releases](https://github.com/TraceApps/lifttrace/releases) page. Sideload it onto a Wear OS 3 watch; it pairs itself the next time you open LiftTrace on the phone.
- **iOS.** No native build yet. Install the PWA from Safari (Share → Add to Home Screen).

---

## Install

Published to two registries with identical tag sets: `ghcr.io/traceapps/lifttrace` (primary) and `traceapps/lifttrace` on [Docker Hub](https://hub.docker.com/r/traceapps/lifttrace) (mirror). The snippet below uses GHCR; swap in `traceapps/lifttrace:latest` if that suits your setup.

```yaml
services:
  lifttrace:
    image: ghcr.io/traceapps/lifttrace:latest
    container_name: lifttrace
    ports:
      - "3002:3002"
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

See [DEPLOY.md](DEPLOY.md) for image tag conventions, reverse proxies, subpath mounting, Cloudflare Tunnel, Docker secrets, and the four Android HTTPS paths.

Pre-release testers can grab the rolling `dev-latest` APK; occasional milestone builds also get numbered `-devNN` pre-releases. See [DEPLOY.md](DEPLOY.md) for details.

---

## Env vars

The essentials. Full reference in [DEPLOY.md](DEPLOY.md), [.env.example](.env.example), and the [env vars docs page](https://traceapps.github.io/docs/lifttrace/env-vars/).

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `./lifttrace.db` | SQLite database file path |
| `UPLOADS_PATH` | `./uploads` | Uploaded exercise media directory |
| `JWT_SECRET` | (required in prod) | JWT signing secret; server refuses to start in prod with the dev default |
| `TOKEN_ENC_KEY` | derived from `JWT_SECRET` | At-rest encryption key for OIDC client secrets |
| `PORT` | `3002` | Server port inside the container (3003 before 1.3.0) |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `EXERCISE_SOURCES` | `wger,free-db` | Sources to auto-seed on first boot (`wger`, `free-db`, `exercisedb`, `exercisedb-oss`) |
| `EXERCISEDB_OSS_URL` | (upstream) | Point the OSS exercise source at your own mirror |
| `INSECURE_COOKIES` | `0` | Set `1` only for non-HTTPS deployments |
| `BASE_URL` | (none) | Mount at a subpath (e.g. `/lifttrace`) instead of root |
| `RECOVERY_TOKEN` | (none) | Token for the "Disable user management" recovery endpoint |
| `SMTP_*` | (none) | SMTP for password reset emails and user invites |
| `AI_*` | (none) | Server-side AI proxy; `AI_PROVIDER` accepts `claude` \| `openai` \| `gemini` \| `oai-compat` |
| `OIDC_*` / `OIDC_PROVIDER_N_*` | (none) | OIDC SSO declared in env instead of the UI |
| `OIDC_ENABLE_EMAIL_PASSWORD_LOGIN` | (none) | Set to `0` to disable password login server-wide (SSO-only) |

---

## Data persistence and updating

All data lives in two bind-mounted directories: `/data/db/lifttrace.db` (SQLite) and `/data/uploads/` (exercise media and backup ZIPs). Back up both with `cp -r`, restore by stopping the container and putting them back. Update with `docker compose pull && docker compose up -d`; volumes persist across updates.

---

## Tech stack

- **Frontend:** Svelte 5 (Svelte-4 compatibility mode), svelte-spa-router, Vite 6, custom SVG charts
- **Backend:** Express 5, better-sqlite3, bcryptjs 3, cookie-based JWT auth
- **PWA:** vite-plugin-pwa, installable on any device
- **Android:** Capacitor 8, Media3 ExoPlayer, WorkManager, @capacitor-community/sqlite
- **AI:** Multi-provider (Claude, OpenAI, Gemini, OpenAI-compatible) with multimodal image support
- **Deploy:** Docker multi-stage build, GitHub Actions CI → GHCR

---

## Trace family

Part of the **TraceApps** family. Sister apps: [CookTrace](https://github.com/traceapps/cooktrace) for recipes and pantry, [NutriTrace](https://github.com/traceapps/nutritrace) for nutrition tracking. Full docs for all three at [traceapps.github.io/docs](https://traceapps.github.io/docs/).

---

## Roadmap, changelog, contributing, license

- [ROADMAP.md](ROADMAP.md) for what's next.
- [CHANGELOG.md](CHANGELOG.md) for release history.
- [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request guidance. Translations: see [Contributing → Translations](https://traceapps.github.io/docs/reference/contribute/translations/).
- AGPL-3.0: see [LICENSE](LICENSE). By contributing you agree your contributions are licensed under the same.

## Support

LiftTrace is free to self-host and always will be. No paid tier, nothing behind a donation, no telemetry. It's built and maintained by one person.

**The current goal is iOS.** None of the Trace apps run properly on an iPhone, because building and testing for iOS needs Apple hardware, plus the developer accounts for both app stores. That comes to about $1,300, and the itemised breakdown is on the [Support page](https://traceapps.github.io/docs/support/).

Helping doesn't have to cost anything: starring the repo, reporting bugs with detail, and translating all count, and stars are how self-hosted projects get found.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support_the_iOS_fund-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/traceapps)

## Disclaimer

LiftTrace is not medical, health, or fitness-professional software. Exercise library content, Trace AI coaching, program templates, rest-timer guidance, and any analytical output are for informational and self-tracking purposes only. Resistance training carries inherent injury risk; consult a qualified healthcare professional or certified coach before starting a new program, returning from injury, or making significant changes. Trace AI answers can be incorrect; treat them as a starting point, not a substitute for professional advice. **Use at your own risk.**
