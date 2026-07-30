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
EXPOSE 3003
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
