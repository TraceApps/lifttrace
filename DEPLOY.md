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
cd server && node index.js   # API on :3002
npm run dev                  # Vite on :5173, proxies /api → :3002
```

Fast HMR, but it runs the frontend on a **separate origin** (`:5173`) from
the API (`:3002`) via a proxy. This is convenient for iterating on markup
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
cd server && node index.js   # app + API together on :3002
```

Open `http://localhost:3002`. Re-run the three lines after any **frontend**
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
2. **Cross-origin proxy gap.** `GET /` requests landing on `:3002` (the API
   port, which has no frontend in Path A) or a stalled auth probe leave the
   shell mounted with no data.

If clearing the service worker doesn't fix it, **switch to Path B.** Serving
from a single origin sidesteps both causes entirely and is the reliable way
to confirm whether a blank screen is your code or just the dev setup.

---

## Image tags

Every release publishes a multi-arch (linux/amd64 + linux/arm64) image to
**two registries** with an identical tag set. GHCR is primary; Docker Hub
is a discoverability mirror. Both are first-class; pick whichever fits.

- **`ghcr.io/traceapps/lifttrace`** (primary)
- **`traceapps/lifttrace`** on [Docker Hub](https://hub.docker.com/r/traceapps/lifttrace) (mirror)

Two tags are published (examples below use GHCR; swap the prefix for
Docker Hub if preferred):

| Tag | Updates when | Use case |
|-----|--------------|----------|
| `ghcr.io/traceapps/lifttrace:latest` | Every stable release | Running the app |
| `ghcr.io/traceapps/lifttrace:dev` | Every push to `dev` branch | Leading edge, not for production |

There are no version-number tags (`:1`, `:1.4`, `:1.4.0`); the ones published
for the first releases stopped updating and were retired. To hold a server on
one exact build, pin it by digest
(`ghcr.io/traceapps/lifttrace@sha256:...`; `docker inspect --format
'{{index .RepoDigests 0}}' ghcr.io/traceapps/lifttrace:latest` prints the one you run).

---

## Testing pre-release builds

Two mechanisms cover pre-release testing between stable releases.

### `dev-latest` (rolling, primary)

Every dev-worthy build refreshes the [`dev-latest`](https://github.com/traceapps/lifttrace/releases/tag/dev-latest) GitHub pre-release. The APK is signed with the same keystore as stable releases, so it upgrades in place. Same guarantees as the Docker `:dev` tag, which auto-publishes on every push to `dev`. This is the default channel for testers who want "always the newest thing."

### Milestone `v<version>-devNN` (occasional, pinnable)

When a specific feature or fix is worth its own tester milestone (a new AI coach tool, a Radio backend, a big program-engine change), a numbered pre-release gets cut: `v1.0.4-dev01`, `v1.1.0-dev01`, etc. These get their own permanent GH release, their own tester-facing notes, but no Docker tag of their own: the server side of a milestone is the `:dev` image. `dev-latest` is refreshed to point at the same commit.

Iteration numbers are zero-padded two digits for 1 through 9 (`dev01`, `dev02`, …, `dev09`) and natural two digits from 10 onward (`dev10`, `dev11`, …). No dot between `dev` and the number. That keeps the identifier inside SemVer 2.0.0 §9 and gives correct lex ordering everywhere (GitHub Tags, `gh release list`).

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
      - "3002:3002"
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
      - "3002:3002"
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
| `UPLOADS_PATH` | Yes | `./uploads` | Path for uploaded exercise images / GIFs / videos, avatars, and progress photos (`body-stats/` subdirectory) |
| `UPDATE_CHECK` | No | unset | Set to `off` (or `0`, `false`, `no`) to stop the server asking GitHub about new releases for good, whatever Settings, Updates says; it also locks that setting. Unset, checks are off on a fresh install until setup or Settings, Updates turns them on. |
| `JWT_SECRET` | Yes (prod) | `dev-secret` | Secret for signing JWT auth tokens — **change this**. Server refuses to start in production with the dev default. |
| `TOKEN_ENC_KEY` | No | derived from `JWT_SECRET` | At-rest encryption key (AES-GCM, HKDF) for OIDC client secrets. By default we derive a key from `JWT_SECRET`, which means rotating `JWT_SECRET` invalidates every stored secret too. Set `TOKEN_ENC_KEY` explicitly if you want to rotate session tokens without forcing admins to re-enter OIDC client secrets. Use a long random string (e.g. `openssl rand -base64 48`). |
| `PORT` | No | `3002` | Internal Express port (map to host in docker-compose) |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug`. Use `debug` for verbose request and sync output. |
| `RECOVERY_TOKEN` | No | — | Lockout-recovery token. Required to use the "Disable user management" recovery option on the login page. Without this, the recovery endpoint is disabled for safety. |
| `MAX_SESSION_HOURS` | No | `8760` (1 year) | Cap on JWT + cookie lifetime. The per-user setting in app_config can be lower than this but cannot exceed it. |
| `INSECURE_COOKIES` | No | `0` | Set `1` to send the sign-in cookie over plain HTTP too. The cookie is HTTPS-only by default, so at a plain `http://` address other than `localhost` (a LAN IP, an Unraid WebUI link) the browser drops it and signing in loops back to the sign-in page; the sign-in and setup screens say so. Use `1` only on a trusted LAN, and leave it `0` behind HTTPS. See [Plain-HTTP LAN](https://traceapps.github.io/docs/getting-started/lan-http/). |
| `FRAME_ANCESTORS` | No | (unset) | Addresses allowed to show LiftTrace inside a frame, several separated by spaces or commas (`https://*.example.com` covers a whole domain). By default only LiftTrace itself may, so no other site can frame it to trick a click. If you show LiftTrace inside a dashboard (Homarr, Organizr, Home Assistant), it shows blank after this update until you set `FRAME_ANCESTORS` to the dashboard's address, for example `FRAME_ANCESTORS=https://home.example.com`. Origins only; a path is ignored. A proxy that already sets its own frame-ancestors for the dashboard needs `FRAME_ANCESTORS` too. |
| `BASE_URL` | No | — | Mount at a subpath instead of root (e.g. `/lifttrace`). See "Reverse Proxy with Subpath" below. |
| `PUBLIC_URL` | No | unset | The full address people open the app at, subpath included (e.g. `https://lift.example.com` or `https://example.com/lifttrace`). Links in emails (password reset, invites, coaching, the weekly summary) use it. Unset, they use an address an admin has opened the app at; until an admin has opened it once, only an admin's own request sends an email. Never taken from request headers, so a forged Host can't point a reset link at someone else's site. The server also takes it as the app's own address when it refuses changes sent from other sites' pages: set it if your reverse proxy passes neither the public `Host` nor `X-Forwarded-Host`; otherwise changes from a browser are refused (403, `cross_site`) over plain http, and over https from older browsers without `Sec-Fetch-Site` (such as Safari before 16.4). |
| `BACKUPS_PATH` | No | Inside uploads dir | Where full ZIP backups are stored |
| `EXERCISE_SOURCES` | No | `wger,free-db` | Comma-separated list of exercise libraries to auto-seed on first boot. Options: `wger`, `free-db`, `exercisedb`, `exercisedb-oss`. |
| `ALLOW_PRIVATE_RADIO_URLS` | No | `0` | Set `1` to let every account, and a single-user install, play radio stations on your own network (loopback, RFC1918, IPv6 ULA). An admin always can. Your music server (Navidrome, Jellyfin, Plex, Emby) doesn't need it. Cloud-metadata addresses stay blocked either way. |
| `SMTP_HOST` | No | — | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_SECURE` | No | `false` | `true` for TLS (port 465), `false` for STARTTLS |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | From address, e.g. `"LiftTrace" <noreply@example.com>` |
| `AI_PROVIDER` | No | — | `claude` \| `openai` \| `gemini` \| `oai-compat`. If set, AI calls are proxied server-side and the provider/model/key fields are locked in Settings for all users. |
| `AI_API_KEY` | No | — | API key for the chosen provider. Server-only, never reaches the browser. Optional when `AI_PROVIDER=oai-compat`. |
| `AI_MODEL` | No | provider default | Optional model override (e.g. `claude-haiku-5-5`, `llama3.1:8b`). Required when `AI_PROVIDER=oai-compat`. |
| `AI_BASE_URL` | No | — | Required when `AI_PROVIDER=oai-compat`. Base URL of your OpenAI-compatible endpoint, e.g. `http://ollama:11434`, with or without `/v1` (the whole `/v1/chat/completions` address works too). Reached from the server container, not the browser, so Docker Compose sidecars on internal networks work. |
| `AI_ENABLED` | No | — | If `true`, auto-enables Trace for all users. |
| `OIDC_*` | No | — | Single-provider OIDC shorthand. See `.env.example` for the full multi-provider syntax; providers can also be added in Settings → Authentication. |
| `MCP_ENABLED` | No | `0` | Set to `1` to expose the Model Context Protocol endpoint at `/api/mcp`. Off by default. See [the MCP setup guide](https://traceapps.github.io/docs/lifttrace/mcp/) for Claude Desktop / Cursor / Codex config. |
| `MCP_WRITE_ENABLED` | No | `0` | Set to `1` to allow MCP write tools (`log_set`, `log_body_stat`, `add_progress_photo`, `log_cardio`) to be registered. Also requires the calling token to hold `mcp:write`. |
| `MCP_DESTROY_ENABLED` | No | `0` | Set to `1` to allow the MCP destructive tool (`delete_workout`). Also requires the token to hold `mcp:destroy` AND every call to include `confirm: true`. |
| `ALLOWED_ORIGINS` | No | — | Comma-separated list of Origins that browser-based MCP clients may use. Server-to-server clients (no Origin header) always pass. Leave empty unless you're specifically using the MCP Inspector in a browser. `*` is refused (DNS-rebinding defense). |
| `PUBLIC_API_ENABLED` | No | `0` | Set to `1` to expose the versioned REST API at `/api/v1`, for scripts and automations that don't speak MCP. Uses the same tokens and `mcp:read`/`mcp:write` scopes as MCP. See `docs/public-api.md`. |
| `PUBLIC_API_WRITE_ENABLED` | No | `0` | Set to `1` to allow the REST API's write routes (log a set, log body stats, attach a progress photo, log cardio). Also requires the calling token to hold `mcp:write`. Independent of `PUBLIC_API_ENABLED` so read-only external access can be exposed without ever opening a write surface. |
| `WEBHOOKS_ENABLED` | No | `0` | Set to `1` to allow outgoing webhooks (workout completed, PR set, program advanced, body stat logged, cardio logged) configured in Settings, Webhooks. |
| `ALLOW_PRIVATE_WEBHOOK_URLS` | No | `0` | Set to `1` to allow a webhook target on a private/loopback address (a same-Docker-network Home Assistant instance, for example). Off by default: a webhook target normally must resolve to a public address. |

> **Note:** SMTP, AI, and OIDC settings can also be configured in their respective **Settings** sections (admin only). Environment variables take priority over the UI and lock the corresponding fields when set.

---

## First Run

1. **Open the app** — you'll be prompted with a setup wizard on first visit.
2. **Create your account** — the first account created is automatically admin.
3. **Single-user mode** — if you never create a second user account, the app runs without authentication (no login required). Add users in Settings → User Management to enable multi-user mode.

Opening the app from another device at a plain `http://` address (a LAN IP, an Unraid WebUI link)? Signing in only sticks over HTTPS, or with `INSECURE_COOKIES=1` on a trusted LAN; the sign-in and setup screens say so. `http://localhost` on the server itself works in Chrome and Firefox either way. See [Plain-HTTP LAN](https://traceapps.github.io/docs/getting-started/lan-http/).

---

## Cloudflare Tunnel (optional)

If you use Cloudflare Tunnel for external access, no special LiftTrace configuration is needed. Set your OIDC redirect URIs to the tunnel's public URL (e.g. `https://lifttrace.example.com/api/auth/oidc/callback/1`) when configuring OIDC providers.

**Free-tier upload limit**: Cloudflare's free plan caps proxied request bodies at **100 MB**. Normal use (auth, sync, exercise media) is well under this, but a full-backup *restore* upload can exceed it on accounts with many videos or imported workout history. Either run the restore from your local network (bypassing the tunnel), upgrade to a paid plan, or split the backup. Browsing and creating backups is fine — only restore-upload is affected.

---

## Behind a Sign-In Proxy

Behind a sign-in proxy (an Authentik or Authelia outpost, VoidAuth, Cloudflare Access), let `/api/*` through to LiftTrace without it. The Android and Wear apps can't sign in to the proxy; LiftTrace signs people in itself, with SSO when OIDC is set up (its callback is under `/api/auth/oidc/`). If the proxy answers the app instead, the app says that something other than LiftTrace answered with a web page. Examples: [The Android app behind a sign-in proxy](https://traceapps.github.io/docs/getting-started/reverse-proxy/#android-behind-a-login).

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

When you configure an OIDC provider, register the callback URL with the IdP **including the prefix**, for example `https://example.com/lifttrace/api/auth/oidc/callback/1`. Enter the same URL in `OIDC_REDIRECT_URIS`, or in the provider's Redirect URIs under Settings → Authentication. The provider redirects back through your reverse proxy to the prefixed path, the app handles it, and the OIDC flow completes.

### Service worker and PWA install

The PWA service worker registers correctly under the subpath. Installing the PWA from a subpath uses the prefixed URL as `start_url`. Both work, but the in-app browser experience is the primary supported case for subpath deployments.

### Native Android app

If you connect the Android app to a server running at a subpath, enter the full URL including the prefix when prompted by the setup wizard (e.g. `https://example.com/lifttrace`). All subsequent API calls preserve the path.

---

## Connecting from Android

The Android app connects to your LiftTrace server over HTTPS, or over plain HTTP to a server on your own network. Local mode (no server) needs neither.

### Plain HTTP on your own network

Enter the `http://` address, such as `http://192.168.1.20:3002`. The app first asks **Connect Without Encryption?**: the connection isn't encrypted, and anyone on the same network can read and change what's sent, including your password. Use it only on your home network or over a VPN. Choose **Connect Anyway** and the app remembers the answer for that server. Settings > Server Connection then shows **Not Encrypted** under the address.

Plain HTTP works only with a server at one of these addresses:

- a private IPv4 address: `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, `192.168.x.x`;
- a Tailscale address (`100.64.x.x` to `100.127.x.x`), loopback `127.x.x.x` or link-local `169.254.x.x`;
- an IPv6 unique local (`fc00::/7`), link-local (`fe80::/10`) or `::1` address;
- a one-word name, such as `http://lifttrace:3002`;
- a name ending in `.local`, `.home.arpa`, `.internal` or `.lan`.

Any other `http://` address (a public domain or IP) is refused before the app sends anything, and the app points to the HTTPS options. Over a VPN such as Tailscale or WireGuard, the tunnel already encrypts the traffic.

`INSECURE_COOKIES` makes no difference to the app: it signs in with a token, not the cookie. Set it only if browsers also open LiftTrace over plain HTTP.

The Wear OS app uses plain HTTP only to the server the phone confirmed, and gets that with the server address the next time the phone app opens. Everything else the app and the watch reach directly (update checks, push services, AI providers, internet radio stations, pictures from elsewhere) is still HTTPS-only, as before.

Coming from a build that allowed plain HTTP without asking (a debug build you built yourself)? On first start the app asks the same question before it contacts the server. Until you choose Connect Anyway it works with what's on the phone, nothing syncs, and it asks again on the next start. A saved `http://` server that isn't on your own network is refused the same way; to switch it to an HTTPS address, use Disconnect & Use Locally in Settings > Server Connection and connect again.

### HTTPS

HTTPS works with no prompt. Three ways to get it:

#### Real domain + Let's Encrypt (recommended)

Point a real domain at your server (`lifttrace.yourdomain.com`) and terminate TLS with a publicly-trusted cert via Caddy, Traefik, nginx + certbot, etc. The DNS-01 challenge works even when your server is on an internal IP, with no port forwarding needed. Enter `https://lifttrace.yourdomain.com` in the app and you're done.

#### Cloudflare Tunnel / Tailscale Funnel / Tailscale mesh

These hand out publicly-trusted certs automatically, with no domain or cert management on your end. Enter the tunnel URL (`https://lifttrace.yourtunnel.example.com`) in the app. See the Cloudflare Tunnel section above for the free-tier upload caveat.

#### Self-signed cert + install your CA on Android

If you generate your own root CA and use it to sign certs for `lifttrace.home.arpa` (or whatever internal domain you use), install your CA on the device once and the app accepts any cert your CA signed.

1. Export your CA's certificate as a `.crt` or `.pem` file
2. On your phone: Settings > Security & Privacy > More security settings > Encryption & credentials > Install a certificate > CA certificate
3. Browse to the file and install. Android warns that anyone with this CA can monitor your traffic; that's expected, you're explicitly trusting your own CA
4. Open LiftTrace and connect to `https://lifttrace.home.arpa`

This survives app updates. You only need to repeat it if you regenerate the CA or factory-reset the device.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

Data is in bind-mounted volumes and persists across updates.

**Upgrading to 1.3.0 or later from an earlier version:** the container now
listens on `3002` instead of `3003`. Change the right-hand side of your
compose mapping from `"3002:3003"` to `"3002:3002"`, and point any reverse
proxy that talks to the container directly (`lifttrace:3003`, a Traefik
`loadbalancer.server.port` label) at `3002`. If you set `PORT` yourself, nothing
changes.

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
