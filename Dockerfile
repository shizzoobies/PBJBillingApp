# PBJBillingApp — the ONE build artifact, for every host.
#
# Why this exists (2026-09-03): Railway's default builder shipped npm 10.9.8,
# which crashed on `npm install` after a registry-side change and took every
# deploy down for two hours while production kept serving the old image. A
# Dockerfile pins Node AND npm, installs from the committed lockfile with
# `npm ci`, and produces the identical image on Railway, on the Fly.io standby,
# and on a laptop. See docs/plans/resilience-2026-09.md.
#
# Build stage: everything needed to compile the frontend (tsc + vite).
# Runtime stage: production dependencies only, plus the built `dist/`.

ARG NODE_VERSION=22.23.2
ARG NPM_VERSION=11.6.2

# ---------- build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG NPM_VERSION
WORKDIR /app
ENV CI=true
RUN npm install -g npm@${NPM_VERSION}
# Lockfile first so dependency layers cache independently of source edits.
COPY package.json package-lock.json ./
# Dev dependencies are required here: tsc and vite do the build.
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG NPM_VERSION
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g npm@${NPM_VERSION}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# The server, its libraries, and the built client. Nothing else — no tests,
# no docs, no desktop shell, no scratch. (.dockerignore keeps them out of the
# build context too, so a stray tmp/ file cannot change the image.)
COPY --from=build /app/dist ./dist
COPY server.js ./
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
COPY docs/capability-manifest.md ./docs/capability-manifest.md
COPY docs/voice-agent-persona.md ./docs/voice-agent-persona.md
COPY public ./public

EXPOSE 8080
# Railway supplies PORT; server.js reads it and falls back to 8080.
CMD ["node", "server.js"]
