# syntax=docker/dockerfile:1

# Mimir runs on Node — Flue's CLI needs node:module.registerHooks, which Bun
# lacks. Bun is only the package manager / script runner; `flue build` executes
# under Node via its `#!/usr/bin/env node` bin shebang. Deploy target is node.

FROM node:24-slim AS base
WORKDIR /app
# Bun pins installs via bun.lock; flue itself still runs under Node.
RUN npm install -g bun@1.3.14

# --- build: full install (incl. @flue/cli) + flue build -> dist/server.mjs ---
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json flue.config.ts ./
COPY src ./src
RUN bun run build

# --- deps: production-only node_modules for the runtime stage ---
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime: Node only (no bun), non-root ---
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=sqlite:/data/mimir.db
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    coreutils \
    findutils \
    gawk \
    grep \
    jq \
    ripgrep \
    sed \
    tar \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# SQLite file (dedup + summary-comment ids) lives on a mounted volume.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
# Liveness: any HTTP response from the server means it's up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
