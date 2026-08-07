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
# `./node_modules/.bin/prisma`, not `npx prisma`: npx would go to the registry if resolution inside
# the image ever failed, which is a network call in the start path of an offline deployment.
#
# The shipped compose runs the migration as its own one-shot service and overrides this command with
# the server alone (docs/12 §12.7). Run the image without compose and it still migrates itself
# first, so `docker run` stays a working deployment — at the cost of the application connecting with
# whatever role just performed the DDL.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server/main.js"]
