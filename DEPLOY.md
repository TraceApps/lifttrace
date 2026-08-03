# LiftTrace — Deployment Guide

## Quick Start

```bash
# Clone and start
git clone git@github.com:traceapps/lifttrace.git
cd lifttrace
cp .env.example .env          # edit as needed
docker compose up -d
```

The app will be available at `http://localhost:3002`.

---

## Local Development

Two ways to run the app from a source checkout. **Pick the single-origin
path when you need to verify your own branch end-to-end.** The Vite dev
server has a well-known blank-screen pitfall (below) and, being a separate
origin, exercises a different request path than production.

> Docker (`docker compose up -d`) pulls the published
> `ghcr.io/traceapps/lifttrace:latest` image, which does **not** contain
> your local changes. To test a branch you must run one of the paths below
> (or `docker build` a local image from the `Dockerfile`).

### Path A: Vite dev server (hot reload, day-to-day frontend work)

```bash
cd server && node index.js   # API on :3003
npm run dev                  # Vite on :5173, proxies /api → :3003
```

Fast HMR, but it runs the frontend on a **separate origin** (`:5173`) from
the API (`:3003`) via a proxy. This is convenient for iterating on markup
but is the source of the recurring **blank-page-with-only-the-nav-bar**
symptom (see below).

### Path B: Single origin (recommended for verifying a branch)

The Express server serves the built frontend from `server/dist` (this is
exactly what the production image does; see `Dockerfile`). Building and
serving it yourself gives you one origin, no proxy, and the same code path
users hit:

```bash
npm run build                # → dist/  (Vite output)
rm -rf server/dist && cp -r dist server/dist
cd server && node index.js   # app + API together on :3003
```

Open `http://localhost:3003`. Re-run the three lines after any **frontend**
change; the server pre-templates `dist/index.html` at startup, so a rebuild
needs a server restart to be picked up. Backend-only changes just need the
server restarted (or use `npm run dev` in `server/` for `--watch`).

### Troubleshooting: blank page (nav/shell renders, content area empty)

Almost always a **dev-only artifact of the Vite split setup (Path A)**, not a
code bug. Two usual causes:

1. **Stale PWA service worker.** LiftTrace registers a service worker; a
   worker cached from an earlier session keeps serving a stale app shell
   while the real route content fails to load. Fix: DevTools → **Application**
   → **Service Workers** → **Unregister**, then **Storage** → **Clear site
   data**, then hard-reload (`Cmd/Ctrl+Shift+R`).
2. **Cross-origin proxy gap.** `GET /` requests landing on `:3003` (the API
   port, which has no frontend in Path A) or a stalled auth probe leave the
   shell mounted with no data.

If clearing the service worker doesn't fix it, **switch to Path B.** Serving
from a single origin sidesteps both causes entirely and is the reliable way
to confirm whether a blank screen is your code or just the dev setup.

---

## Image tags

Every release publishes a multi-arch (linux/amd64 + linux/arm64) image
under several tags so you can pin to whatever risk level fits:

| Tag | Updates when | Use case |
|-----|--------------|----------|
| `ghcr.io/traceapps/lifttrace:1.0.0` | Never (pinned exact) | Reproducible pin to a specific version |
| `ghcr.io/traceapps/lifttrace:1.0` | Any 1.0.x patch release | Auto-receive bug fixes, no new features |
| `ghcr.io/traceapps/lifttrace:1` | Any 1.x.y minor release | Auto-minor within a major, no breaking |
| `ghcr.io/traceapps/lifttrace:latest` | Every stable release | Absolute latest stable |
| `ghcr.io/traceapps/lifttrace:dev` | Every push to `dev` branch | Leading edge, not for production |

Legacy `1.0.0-rc.N` tags from before the semver switch remain published
indefinitely; anyone pinned to a specific rc release is unaffected.

---

## Testing pre-release builds

Two mechanisms cover pre-release testing between stable releases.

### `dev-latest` (rolling, primary)

Every dev-worthy build refreshes the [`dev-latest`](https://github.com/traceapps/lifttrace/releases/tag/dev-latest) GitHub pre-release. The APK is signed with the same keystore as stable releases, so it upgrades in place. Same guarantees as the Docker `:dev` tag, which auto-publishes on every push to `dev`. This is the default channel for testers who want "always the newest thing."

### Milestone `v<version>-devNN` (occasional, pinnable)

When a specific feature or fix is worth its own tester milestone (a new AI coach tool, a Radio backend, a big program-engine change), a numbered pre-release gets cut: `v1.0.4-dev01`, `v1.1.0-dev01`, etc. These get their own permanent GH release, their own tester-facing notes, and their own Docker tag (`ghcr.io/traceapps/lifttrace:1.0.4-dev01`) alongside `:dev`. `dev-latest` is refreshed to point at the same commit.

Iteration numbers are zero-padded two digits for 1 through 9 (`dev01`, `dev02`, …, `dev09`) and natural two digits from 10 onward (`dev10`, `dev11`, …). No dot between `dev` and the number. That keeps the identifier inside SemVer 2.0.0 §9 and gives correct lex ordering everywhere (GitHub Tags, `gh release list`, Docker Hub).

Use numbered dev builds when reporting bugs ("I saw this on `v1.1.0-dev02`") or if you want to install a specific milestone and stay on it. Everyone else, `dev-latest` covers you.

Both channels use the shared TraceApps keystore, so upgrading between them (or from either back to stable) works in place.

---

## docker-compose.yml

A minimal working setup:

```yaml
services:
  lifttrace:
    image: ghcr.io/traceapps/lifttrace:latest
    ports:
      - "3002:3003"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      DB_PATH: /data/db/lifttrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET: change-me-to-a-long-random-string
    restart: unless-stopped
```

### With all optional features enabled

```yaml
services:
  lifttrace:
    image: ghcr.io/traceapps/lifttrace:latest
    ports:
      - "3002:3003"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      # Required
      DB_PATH: /data/db/lifttrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET: change-me-to-a-long-random-string

      # Optional: SMTP for password reset / invite emails
      SMTP_HOST: smtp.example.com
      SMTP_PORT: 587
      SMTP_SECURE: "false"      # true for port 465
      SMTP_USER: user@example.com
      SMTP_PASS: yourpassword
      SMTP_FROM: '"LiftTrace" <noreply@example.com>'

      # Optional: session duration override (hours; 0 = never expires)
      # SESSION_HOURS: 720

      # Optional: backups directory (default: inside uploads volume)
      # BACKUPS_PATH: /data/backups
    restart: unless-stopped
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_PATH` | Yes | `./lifttrace.db` | Path to SQLite database file |
| `UPLOADS_PATH` | Yes | `./uploads` | Path for uploaded exercise images / GIFs / videos |
| `JWT_SECRET` | Yes (prod) | `dev-secret` | Secret for signing JWT auth tokens — **change this**. Server refuses to start in production with the dev default. |
| `TOKEN_ENC_KEY` | No | derived from `JWT_SECRET` | At-rest encryption key (AES-GCM, HKDF) for OIDC client secrets. By default we derive a key from `JWT_SECRET`, which means rotating `JWT_SECRET` invalidates every stored secret too. Set `TOKEN_ENC_KEY` explicitly if you want to rotate session tokens without forcing admins to re-enter OIDC client secrets. Use a long random string (e.g. `openssl rand -base64 48`). |
| `PORT` | No | `3003` | Internal Express port (map to host in docker-compose) |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug`. Use `debug` for verbose request and sync output. |
| `RECOVERY_TOKEN` | No | — | Lockout-recovery token. Required to use the "Disable user management" recovery option on the login page. Without this, the recovery endpoint is disabled for safety. |
| `MAX_SESSION_HOURS` | No | `8760` (1 year) | Cap on JWT + cookie lifetime. The per-user setting in app_config can be lower than this but cannot exceed it. |
| `INSECURE_COOKIES` | No | `0` | Set `1` only for non-HTTPS deployments. Default uses `secure: true` cookies (HTTPS-only). |
| `BASE_URL` | No | — | Mount at a subpath instead of root (e.g. `/lifttrace`). See "Reverse Proxy with Subpath" below. |
| `BACKUPS_PATH` | No | Inside uploads dir | Where full ZIP backups are stored |
| `EXERCISE_SOURCES` | No | `wger,free-db` | Comma-separated list of exercise libraries to auto-seed on first boot. Options: `wger`, `free-db`, `exercisedb`. |
| `ALLOW_PRIVATE_RADIO_URLS` | No | `0` | Allow Radio streaming proxy to fetch from RFC1918 / loopback / IPv6 ULA addresses. Off by default — only enable if you stream from inside your own LAN and accept the SSRF surface area. |
| `SMTP_HOST` | No | — | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_SECURE` | No | `false` | `true` for TLS (port 465), `false` for STARTTLS |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | From address, e.g. `"LiftTrace" <noreply@example.com>` |
| `AI_PROVIDER` | No | — | `claude` \| `openai` \| `gemini` \| `oai-compat`. If set, AI calls are proxied server-side and the provider/model/key fields are locked in Settings for all users. |
| `AI_API_KEY` | No | — | API key for the chosen provider. Server-only, never reaches the browser. Optional when `AI_PROVIDER=oai-compat`. |
| `AI_MODEL` | No | provider default | Optional model override (e.g. `claude-haiku-4-5-20251001`, `llama3.1:8b`). Required when `AI_PROVIDER=oai-compat`. |
| `AI_BASE_URL` | No | — | Required when `AI_PROVIDER=oai-compat`. Base URL of your OpenAI-compatible endpoint, e.g. `http://ollama:11434`. Reached from the server container, not the browser — Docker Compose sidecars on internal networks work. |
| `AI_ENABLED` | No | — | If `true`, auto-enables Trace for all users. |
| `OIDC_*` | No | — | Single-provider OIDC shorthand. See `.env.example` and Settings → User Management → OIDC providers for the full multi-provider syntax. |

> **Note:** SMTP, AI, and OIDC settings can also be configured in their respective **Settings** sections (admin only). Environment variables take priority over the UI and lock the corresponding fields when set.

---

## First Run

1. **Open the app** — you'll be prompted with a setup wizard on first visit.
2. **Create your account** — the first account created is automatically admin.
3. **Single-user mode** — if you never create a second user account, the app runs without authentication (no login required). Add users in Settings → User Management to enable multi-user mode.

---

## Cloudflare Tunnel (optional)

If you use Cloudflare Tunnel for external access, no special LiftTrace configuration is needed. Set your OIDC redirect URIs to the tunnel's public URL (e.g. `https://lifttrace.example.com/api/auth/oidc/callback/1`) when configuring OIDC providers.

**Free-tier upload limit**: Cloudflare's free plan caps proxied request bodies at **100 MB**. Normal use (auth, sync, exercise media) is well under this, but a full-backup *restore* upload can exceed it on accounts with many videos or imported workout history. Either run the restore from your local network (bypassing the tunnel), upgrade to a paid plan, or split the backup. Browsing and creating backups is fine — only restore-upload is affected.

---

## Reverse Proxy with Subpath

To run LiftTrace behind a reverse proxy at a subpath (e.g. `https://example.com/lifttrace/`), set the `BASE_URL` environment variable to the path prefix:

```yaml
environment:
  - BASE_URL=/lifttrace
```

The path must start with `/` and must NOT have a trailing slash. Empty (the default) keeps the app at root, identical to the previous behavior — no change for existing deployments.

With `BASE_URL` set, the app's assets, API routes, service worker, and image URLs all live under that prefix. Your reverse proxy should pass requests through *without* stripping the path:

### Caddy

```caddyfile
example.com {
  handle /lifttrace/* {
    reverse_proxy localhost:3002
  }
}
```

(Note: `handle`, not `handle_path`, since we want the prefix preserved.)

### nginx

```nginx
location /lifttrace/ {
  proxy_pass http://localhost:3002/lifttrace/;  # trailing slash on both sides
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Traefik (docker-compose labels)

```yaml
labels:
  - "traefik.http.routers.lifttrace.rule=PathPrefix(`/lifttrace`)"
  # No StripPrefix middleware — pass the full path through.
```

### OIDC callback URLs at a subpath

When you configure an OIDC provider, register the callback URL with the IdP **including the prefix**, for example `https://example.com/lifttrace/api/auth/oidc/callback/1`. Enter the same URL in Settings → User Management → OIDC providers. The provider redirects back through your reverse proxy to the prefixed path, the app handles it, and the OIDC flow completes.

### Service worker and PWA install

The PWA service worker registers correctly under the subpath. Installing the PWA from a subpath uses the prefixed URL as `start_url`. Both work, but the in-app browser experience is the primary supported case for subpath deployments.

### Native Android app

If you connect the Android app to a server running at a subpath, enter the full URL including the prefix when prompted by the setup wizard (e.g. `https://example.com/lifttrace`). All subsequent API calls preserve the path.

---

## Connecting from Android

The Android app ships with a strict network security policy on **release-signed APKs** (the ones distributed via GitHub Releases): only HTTPS traffic is allowed to a user's LiftTrace server, to protect auth tokens on open WiFi. Debug-signed APKs (built locally) are unrestricted and can use plain HTTP.

This only affects **server mode** — local-only Android users never hit this.

Four supported paths for server-mode Android users:

### Path 1 — Real domain + Let's Encrypt (recommended)

Point a real domain at your server (`lifttrace.yourdomain.com`) and terminate TLS with a publicly-trusted cert via Caddy, Traefik, nginx + certbot, etc. The DNS-01 challenge works fine even when your server is on an internal IP — no port forwarding needed. Enter `https://lifttrace.yourdomain.com` in the app and you're done.

### Path 2 — Cloudflare Tunnel / Tailscale Funnel / Tailscale mesh

These hand out publicly-trusted certs automatically, no domain or cert management on your end. Enter the tunnel URL (`https://lifttrace.yourtunnel.example.com`) in the app. See the Cloudflare Tunnel section above for the free-tier upload caveat.

### Path 3 — Self-signed cert + install your CA on Android

If you generate your own root CA and use it to sign certs for `lifttrace.home.arpa` (or whatever internal domain you use), the strict APK won't trust it out of the box — but you can install your CA on the device once and the app will accept any cert your CA signed.

1. Export your CA's certificate as a `.crt` or `.pem` file
2. On your phone: Settings → Security & Privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate
3. Browse to the file and install. Android will warn that anyone with this CA can monitor your traffic — that's expected, you're explicitly trusting your own CA
4. Open LiftTrace and connect to `https://lifttrace.home.arpa`

This survives app updates. You only need to repeat it if you regenerate the CA or factory-reset the device.

### Path 4 — Plain HTTP (build the APK yourself)

If you really don't want HTTPS at all (LAN-only, fully isolated network, willing to accept the risk), the source includes a permissive debug build profile. Clone the repo and run:

```bash
npm run build && cd android && ./gradlew assembleDebug
```

The APK at `android/app/build/outputs/apk/debug/app-debug.apk` allows cleartext (`http://`) connections. Sideload it instead of the release APK.

This is also the fallback if you hit any cert issues with paths 1–3 — the debug build connects to anything.

### What you'll see in the app

If a release-built app tries to connect to an `http://` URL, the connection fails and the in-app error explicitly mentions the HTTPS requirement and points back to this section.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

Data is in bind-mounted volumes and persists across updates.

---

## Docker Secrets

The container supports Docker/Swarm-style `*_FILE` environment variables. For any server environment variable, you can provide a mounted file path instead of the raw value:

- `JWT_SECRET_FILE=/run/secrets/lifttrace_jwt_secret`
- `RECOVERY_TOKEN_FILE=/run/secrets/lifttrace_recovery_token`
- `SMTP_PASS_FILE=/run/secrets/lifttrace_smtp_pass`
- `AI_API_KEY_FILE=/run/secrets/lifttrace_ai_api_key`

Rules:

- Set either `NAME` or `NAME_FILE`, not both.
- If `NAME_FILE` is set, the container reads that file at startup and exports `NAME` before Node starts.
- If the file is missing or unreadable, the container exits immediately with a startup error.

Example Compose snippet:

```yaml
services:
  lifttrace:
    image: ghcr.io/traceapps/lifttrace:latest
    environment:
      DB_PATH: /data/db/lifttrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET_FILE: /run/secrets/lifttrace_jwt_secret
      SMTP_PASS_FILE: /run/secrets/lifttrace_smtp_pass
    secrets:
      - lifttrace_jwt_secret
      - lifttrace_smtp_pass

secrets:
  lifttrace_jwt_secret:
    file: ./secrets/jwt_secret.txt
  lifttrace_smtp_pass:
    file: ./secrets/smtp_pass.txt
```

This works for any environment variable the server reads directly, including `TOKEN_ENC_KEY`, `SMTP_USER`, `AI_API_KEY`, and similar values.

---

## Backup & Restore

Full backups (database + uploaded exercise media) can be created and restored from Settings → Backup & Restore. Backups are ZIP files that include all user data and can be used to migrate between servers.
