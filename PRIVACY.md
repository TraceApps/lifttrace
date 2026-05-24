# Privacy Policy — LiftTrace

**Last updated:** May 24, 2026

## Overview

LiftTrace is a self-hosted weightlifting and training tracker. Your data is stored on **your own server** — not on our servers, not in the cloud, and not shared with third parties.

## Data Collection

### What LiftTrace stores on YOUR server:
- Workout logs (exercises, sets, reps, weights, RPE, warm-ups, supersets, free-text notes)
- Programs and templates (mesocycles, weekly schedules, coach prescriptions)
- Body stats (weight, body composition, custom metrics) and progress trends
- Custom exercises with uploaded images / GIFs / videos
- Imported workout history from Strong / Hevy / FitNotes / Jefit
- Radio settings (station presets, library server credentials)
- AI chat history (if Trace is enabled)
- User account information (username, email, avatar)
- App settings and preferences

### What LiftTrace does NOT collect:
- We do not operate any central server that receives your data
- We do not collect analytics, telemetry, or usage statistics
- We do not serve advertisements
- We do not sell, share, or transmit your data to third parties
- We do not use tracking cookies or fingerprinting

## Third-Party Services

LiftTrace connects to the following external services **only when you explicitly enable them**:

- **wger / free-exercise-db / exercisedb** — Exercise library data, fetched once at server startup to seed the local exercise table. Subject to each project's respective terms.
- **Radio Browser** ([radio-browser.info](https://www.radio-browser.info/)) — Internet radio station discovery, queried when you browse stations in the Radio tab.
- **Subsonic / Jellyfin / Plex / Emby** — Music library sources for the Radio player. You connect to your own self-hosted server with your own credentials; LiftTrace stores those credentials encrypted on your server.
- **OIDC providers (Authentik, Keycloak, Google, etc.)** — If admins configure OIDC SSO, sign-in is delegated to your chosen identity provider. Client secrets are stored encrypted at rest.
- **AI providers (Claude / OpenAI / Gemini / OpenAI-compatible)** — If Trace is enabled, your conversation and relevant workout context is sent to the AI provider you choose. Subject to their respective privacy policies. Your API key is stored on your server, not ours. The "OpenAI Compatible" provider (Ollama, LM Studio, DeepSeek, Groq, etc.) connects directly from the browser to the endpoint you configure — LiftTrace never sees those requests.
- **Push notification services (Gotify / ntfy / Apprise)** — If configured, notification content (rest timer alerts, goal reminders) is sent to your self-hosted push server.

## Data Retention

Your data is retained on your server until you delete it. You can:
- Delete individual workouts, exercises, programs, or custom exercises at any time
- Export all your data via JSON export or full backup (ZIP)
- Delete your account and all associated data
- Wipe the database entirely

## Android App

The LiftTrace Android app stores data locally on your device in a SQLite database within the app's private data directory. When connected to a server, data syncs bidirectionally. The app requests the following permissions:

- **Internet** — Server sync, exercise library lookups, radio streaming, AI chat
- **Notifications** — Rest timer cues, scheduled workout reminders
- **Schedule / use exact alarm** — Precise rest timer beeps even when the app is backgrounded
- **Receive boot completed** — Re-arm scheduled reminders after device reboot
- **Camera** — Capture custom exercise images / videos, Trace image attachments
- **Record audio** — Hold-to-speak voice logging on the Trace FAB
- **External storage (Android 12 and below)** — Save shared workout cards and exported backups to your Downloads folder
- **Modify audio settings** — Adjust output for the Radio player
- **Foreground service (media playback)** — Keep the Radio player alive when the app is backgrounded or the screen is off
- **Biometric (fingerprint / face)** — Optional biometric unlock for the app, declared by the biometric plugin

LiftTrace does **not** request Health Connect or any wearable / fitness sync permissions.

### Local data at rest

LiftTrace does not add its own SQLite-level encryption (e.g. SQLCipher) on top of the database. Instead, it relies on Android's built-in file-based encryption (FBE), which has been the default on every Android device since Android 7 (2016). FBE encrypts the app's private data directory using a key derived from your device PIN, password, or biometric — meaning a locked phone is already encrypted at rest, and the contents of the database are inaccessible to anyone without your unlock credential. This matches the approach used by other self-hosted lifestyle apps (Immich, Joplin, Obsidian, AnkiDroid).

This means: an attacker with physical access to your *locked* device cannot read your data. An attacker with physical access to your *unlocked* device can read it — but they could also simply open the app. If your threat model includes nation-state-level adversaries with extended access to your unlocked device, no workout tracker (and few apps in any category) will protect you, and you should be using a hardened device profile separate from this app.

The local database is the same database used by all your data: workouts, exercises, programs, settings, AI chat history. Full backups (ZIP exports) are also unencrypted by default — keep them in trusted storage if you back up off-device.

## Children's Privacy

LiftTrace is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

This privacy policy may be updated from time to time. Changes will be noted in the changelog.

## Contact

For privacy questions, open an issue at [github.com/traceapps/lifttrace](https://github.com/traceapps/lifttrace).
