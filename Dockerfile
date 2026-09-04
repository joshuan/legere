FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 🔒 SEC-07. The base image ships npm and corepack; this stage runs neither — the command below is
# `node` and the Prisma binary out of `node_modules`. What they do contribute is their own bundled
# dependency trees, which is what the release scan keeps failing on (npm's `brace-expansion`,
# `ip-address`) — advisories against code that never runs here and that no lockfile of ours can fix.
# A production image with no package manager in it cannot install anything either.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# 8080, not 80: the process is not root (see USER below) and a privileged port then depends on the
# runtime's `net.ipv4.ip_unprivileged_port_start` — 0 under Docker, 1024 elsewhere. The published
# port is the operator's choice either way (docs/12 §12.7).
ENV PORT=8080
# The Prisma CLI checks for a newer version and caches the answer under $HOME: a network call and a
# write, neither of which exists on a read-only root filesystem (docs/12 §12.6).
ENV CHECKPOINT_DISABLE=1
# Everything below stays owned by root and only readable by the runtime user — the running process
# cannot rewrite its own code, which is half of what `read_only` buys.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/messages ./messages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
# The one path the process genuinely writes to: Next keeps its incremental cache under
# `.next/cache` and creates it on the first render. It exists here so that a `tmpfs` mounted over it
# lands on a directory the runtime user already owns (docs/12 §12.7).
RUN mkdir -p .next/cache && chown node:node .next/cache
# uid 1000 — the `node` user the base image already ships. Nothing here needs root, and
# `deploy/docling/Dockerfile` drops privileges the same way.
USER node
EXPOSE 8080
# Migrations require an owner credential and are always an explicit one-shot operation. The server
# starts with the DML-only runtime credential; combining both in this command would put public-schema
# DDL back into the application container (SEC-43, docs/12 §12.6–12.7).
CMD ["node", "dist/server/main.js"]
