# ── Stage 1: Build Svelte frontend ──────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Express server + static frontend ────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY server/ .
# Isomorphic exercise-source fetchers live under src/lib/exercise-sources/
# and are imported at runtime by server/exercise-sources/*.js via
# `../../src/lib/exercise-sources/*`. WORKDIR is /app, so those imports
# resolve to /src/lib/exercise-sources/*. Copy them into place.
COPY src/lib/exercise-sources/ /src/lib/exercise-sources/
COPY --from=build /app/dist ./dist
# Also ship the root package.json so the server can read APP_VERSION
# from it at runtime. The `COPY server/package*.json ./` step above
# put the SERVER package.json at /app/package.json; overwriting it
# with the ROOT one here makes version-source.js report the correct
# client-facing version instead of the stale server-side one.
COPY --from=build /app/package.json ./package.json
# Bake the app version into the image so the in-app updates checker
# can report the running server version. CI can pass
# `--build-arg APP_VERSION=$(node -p 'require("./package.json").version')`.
# Falls back to reading /app/package.json at runtime.
ARG APP_VERSION=""
ENV TRACEAPPS_APP_VERSION=${APP_VERSION}
EXPOSE 3003
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
