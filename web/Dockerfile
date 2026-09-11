# Multi-stage: the runtime image carries the standalone server and the static
# assets, not node_modules or the Next toolchain.
#
# The build context is the REPO ROOT (docker-compose.yml sets `context: .`), so
# every COPY source below is repo-relative -- web/package.json, not
# package.json.
FROM node:22-alpine AS deps
WORKDIR /app/web
# Manifest + lockfile only, so this layer survives source edits: it takes a
# minute, the source layers take a second.
#
# This repo does NOT use npm workspaces. web/ carries its own package.json and
# lockfile; the root package.json only holds `concurrently` for `npm run dev`,
# which no image needs. Installing web/ directly IS the dependency step.
COPY web/package.json web/package-lock.json ./
# --ignore-scripts because web's postinstall (sync-maplibre-worker) reads
# scripts/, which is not in this stage. The build stage runs it explicitly,
# where it also has to run anyway -- see below.
RUN npm ci --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app/web
COPY --from=deps /app/web/node_modules ./node_modules
COPY web/ ./
# Baked in as the fallback only; the rewrites in next.config.ts are what route
# /api, and the standalone server reads this at runtime.
ARG NEXT_PUBLIC_API_ORIGIN=http://api:8000
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN
# Explicitly, not as a postinstall hook: `COPY web/ ./` above replaces public/
# wholesale with whatever the context holds. A fresh clone has no
# public/maplibre/, so syncing before that copy would be undone by it and the
# map would fail to start its worker with a 404 at runtime.
RUN npm run sync:maplibre && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# next.config.ts pins outputFileTracingRoot to web/ itself, so the standalone
# tree is rooted AT THE APP: server.js sits at its top level, not under a web/
# subdirectory the way a monorepo-rooted trace would place it. Getting this
# wrong fails at `docker run`, not at build time.
COPY --from=build /app/web/.next/standalone ./
# Neither static/ nor public/ is traced into standalone; the server expects
# both beside it.
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
