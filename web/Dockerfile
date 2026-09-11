# Multi-stage: the runtime image carries the standalone server and the static
# assets, not node_modules or the Next toolchain.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY web/package.json ./web/package.json
# `mkdir -p` because npm workspaces HOIST: with no conflicting versions every
# package lands in /app/node_modules and web/node_modules is never created, so
# the COPY below fails the build with "not found". It is a real directory in
# some dependency trees (a version conflict forces a local copy) and absent in
# others, and the Dockerfile must not depend on which.
RUN (npm ci --workspaces --include-workspace-root || npm install) \n    && mkdir -p /app/web/node_modules

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY package.json ./
COPY web/ ./web/
# The API origin is baked in at build time only as a fallback; the rewrite in
# next.config.ts is what actually routes /api, and it reads this at runtime in
# the standalone server.
ARG NEXT_PUBLIC_API_ORIGIN=http://api:8000
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN
RUN npm --prefix web run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# `output: "standalone"` in next.config.ts emits a self-contained server plus
# the minimal node_modules it actually needs.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public
EXPOSE 3000
CMD ["node", "web/server.js"]
