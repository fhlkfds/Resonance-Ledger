# syntax=docker/dockerfile:1.7

# Resonance Ledger production image.
#
# Six stages per specification section 13. The app, worker, and migrator all
# come from this one file so they always share a code revision.
#
# Base images are pinned by digest. Refresh them deliberately with a reviewed
# change, never by floating a tag.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa

# ---------------------------------------------------------------- base ----
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1
# Prisma needs OpenSSL to select its query engine; ca-certificates covers
# outbound HTTPS to Spotify. Nothing else is added to the runtime lineage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- deps ----
FROM base AS deps
# Only the manifests are copied so this layer caches until dependencies move.
# .env is excluded by .dockerignore and is never present in any build context.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ------------------------------------------------------------- builder ----
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json next.config.ts ./
COPY postcss.config.mjs tailwind.config.ts eslint.config.mjs ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY public ./public
# typecheck runs `next typegen` first, so route types exist on a clean
# checkout where .next has never been written.
RUN npx prisma generate \
 && npm run typecheck \
 && npm run build:worker \
 && npm run build

# -------------------------------------------------------- runtime-deps ----
FROM base AS runtime-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
# The standalone bundle carries its own tree; this pruned tree supplies the
# Prisma Client and engines the bundled worker loads at runtime.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 && npx prisma generate \
 && npm cache clean --force

# ------------------------------------------------------------- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="Resonance Ledger" \
      org.opencontainers.image.description="Self-hosted Spotify listening-history and analytics" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ARG APP_VERSION=local
ARG VCS_REF=unknown
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/fhlkfds/Resonance-Ledger"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# Fixed UID/GID so a bind-mounted volume keeps stable ownership.
RUN groupadd --system --gid 10001 resonance \
 && useradd --system --uid 10001 --gid 10001 --no-create-home resonance

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# The standalone output already carries the traced dependency subset the app
# and the bundled worker need, including Prisma Client and its engine. A
# second production tree would only duplicate it.
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=builder --chown=10001:10001 /app/public ./public
COPY --from=builder --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 scripts/container-app-health.mjs ./scripts/container-app-health.mjs
COPY --chown=10001:10001 LICENSE ./LICENSE

# Server source maps would expose the original source layout in a production
# image without helping the operator, so they are dropped from the final stage.
RUN find /app/.next -name '*.map' -type f -delete

USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]

# ------------------------------------------------------------ migrator ----
FROM base AS migrator
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 resonance \
 && useradd --system --uid 10001 --gid 10001 --no-create-home resonance

# Applying migrations needs only the Prisma CLI, Prisma Client, and the
# committed schema. Installing the full production tree would drag in Next,
# React, and ECharts, none of which run a migration, so a minimal manifest is
# generated from the pinned versions the repository already declares.
COPY package.json ./package.source.json
COPY scripts/migrator-manifest.mjs ./scripts/migrator-manifest.mjs
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    node scripts/migrator-manifest.mjs \
 && rm package.source.json \
 && npm install --omit=optional --no-audit --no-fund \
 && npx prisma generate \
 && npm cache clean --force \
 && chown -R 10001:10001 /app

USER 10001:10001
STOPSIGNAL SIGTERM
# It contains no application secret; DATABASE_URL arrives at run time.
CMD ["npx", "prisma", "migrate", "deploy"]
