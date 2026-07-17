# 12. Build, Configuration, Run

## 12.1. Toolchain

- Node **26** (exact version pinned in `.nvmrc` at scaffolding; always `nvm use`).
- npm only; one `package.json`, `package-lock.json` committed. `pnpm`/`yarn`/`bun` forbidden.
- TypeScript **7**, `strict`. Dev/test transpilation — SWC (ADR-017); prod server build — `tsc`.

## 12.2. npm scripts (authoritative)

```jsonc
{
  "dev": "nodemon --quiet --watch server --watch src/server --watch src/shared --ext ts,mjs,json --exec \"node server/dev.mjs\"",
  "dev:up": "docker compose up -d",
  "dev:down": "docker compose down",
  "build": "next build && tsc -p tsconfig.server.json && echo '{\"type\":\"commonjs\"}' > dist/package.json",
  "start": "node dist/server/main.js",
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json && tsc --noEmit -p tsconfig.test.json",
  "lint": "eslint . && prettier --check .",
  "lint:fix": "eslint . --fix && prettier --write .",
  "test": "vitest run",
  "db:generate": "prisma generate",
  "db:migrate": "prisma migrate deploy",
  "db:migrate:dev": "prisma migrate dev",
  "db:seed": "node --import @swc-node/register/esm-register prisma/seed.ts"
}
```

## 12.3. TypeScript configs

| File | Purpose | Key settings |
|------|---------|--------------|
| `tsconfig.json` | client + contracts (checked by Next) | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `jsx: preserve`, no `paths` |
| `tsconfig.server.json` | server build (`server/`, `src/server/`, `src/shared/`) | extends base; `emitDecoratorMetadata`, `experimentalDecorators`, `outDir: dist`, `module: nodenext` |
| `tsconfig.test.json` | tests | extends server config, `noEmit` |
| `.swcrc` | dev/test transpile | `jsc.parser.decorators`, `jsc.transform.decoratorMetadata: true`, target matching Node 26 |

## 12.4. `.env.example`

Every variable the app reads (validated by the Zod config schema at boot, [`06 §6.6`](./06-backend-architecture.md#66-configuration)):

```bash
# --- core ---
NODE_ENV=development
PORT=3000
APP_BASE_URL=http://localhost:3000          # absolute; used for CSRF origin check and links in emails/invites
LOG_LEVEL=debug                              # pino level; prod default: info

# --- database ---
DATABASE_URL=postgresql://legere:legere@localhost:5432/legere?schema=public

# --- auth ---
AUTH_SECRET=dev-secret-change-me-min-32-chars!!   # ≥32 chars; HMAC for email codes
SESSION_TTL_DAYS=30
COOKIE_DOMAIN=                               # empty in dev; set consciously in prod
TURNSTILE_SECRET_KEY=                        # empty = CAPTCHA disabled
NEXT_PUBLIC_TURNSTILE_SITE_KEY=              # build-time (baked into the client bundle)

# --- email (empty SMTP_HOST = LogEmailSender: codes go to the app log) ---
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false                            # 465 → true, 587 → false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="Legere <no-reply@example.com>"

# --- library volume ---
LIBRARY_ROOT=/library                        # dev compose mounts ./dev-library here (ro)

# --- S3 (derived artifacts; dev values match the compose MinIO) ---
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=legere
S3_ACCESS_KEY_ID=legere
S3_SECRET_ACCESS_KEY=legere-secret
S3_FORCE_PATH_STYLE=true
SIGNED_URL_TTL_SEC=300

# --- Stirling-PDF ---
STIRLING_URL=http://localhost:8080

# --- processing ---
OCR_LANGUAGES=rus+eng
PDF_TEXT_MIN_CHARS_PER_PAGE=32               # below → treat as scan, run OCR
PREVIEW_MAX_DIM=1600
THUMB_MAX_DIM=400
CHUNK_TARGET_CHARS=1000
CHUNK_OVERLAP_CHARS=200
QUEUE_CONCURRENCY_INGEST=4
QUEUE_CONCURRENCY_PROCESS=2

# --- AI providers (empty base URL = feature disabled, steps SKIPPED) ---
EMBEDDINGS_API_BASE_URL=                     # OpenAI-compatible, e.g. https://api.openai.com/v1 or http://ollama:11434/v1
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536                    # must match the DB vector(1536); changing requires migration + re-vectorization
CLASSIFIER_API_BASE_URL=                     # empty = reuse EMBEDDINGS_API_BASE_URL; both empty = categorization SKIPPED
CLASSIFIER_API_KEY=
CLASSIFIER_MODEL=
```

`NEXT_PUBLIC_*` values are **build-time**: they are baked into the client bundle during `next build`
(passed as Docker build-args, [`13 §13.3`](./13-ci-cd.md#133-githubworkflowsreleaseyml)); setting them
at runtime has no effect.

## 12.5. Local development

```bash
nvm use
npm install
cp .env.example .env
mkdir -p dev-library && cp -r <some-documents> dev-library/   # your test corpus
npm run dev:up          # PostgreSQL(+pgvector) + Stirling-PDF + MinIO (+ bucket init)
npm run db:migrate:dev
npm run db:seed         # admin@legere.local / password; library over dev-library/
npm run dev             # one process on :3000
```

Root `docker-compose.yaml` (dev dependencies only — the app itself is NOT in it):

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_USER: legere, POSTGRES_PASSWORD: legere, POSTGRES_DB: legere }
    ports: ['5432:5432']
    volumes: ['db-data:/var/lib/postgresql/data']
  stirling:
    image: stirlingtools/stirling-pdf:latest
    ports: ['8080:8080']
    environment: { DISABLE_ADDITIONAL_FEATURES: 'true' }
  minio:
    image: minio/minio
    command: server /data --console-address ':9001'
    environment: { MINIO_ROOT_USER: legere, MINIO_ROOT_PASSWORD: legere-secret }
    ports: ['9000:9000', '9001:9001']
    volumes: ['minio-data:/data']
  createbuckets:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 legere legere-secret &&
                  mc mb --ignore-existing local/legere"
volumes: { db-data: {}, minio-data: {} }
```

## 12.6. Dockerfile (one image)

Multi-stage; final image runs migrations then the server:

```dockerfile
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/messages ./messages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 80
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/main.js"]
```

## 12.7. Deployment example (illustration — keep OUTSIDE the repository)

One app container + PostgreSQL; library mounted `:ro`; S3 and TLS termination are external.

```yaml
# docker-compose.deploy.yml — EXAMPLE. Secrets from a secret manager, not from this file.
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: legere
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: legere
    volumes: ['db-data:/var/lib/postgresql/data']    # do not expose the DB port

  stirling:
    image: stirlingtools/stirling-pdf:latest         # internal network only
    environment: { DISABLE_ADDITIONAL_FEATURES: 'true' }

  app:
    image: ghcr.io/<owner>/legere:latest             # built by CI (docs/13)
    depends_on: [db, stirling]
    environment:
      NODE_ENV: production
      PORT: 80
      APP_BASE_URL: https://legere.example.com
      DATABASE_URL: postgresql://legere:${POSTGRES_PASSWORD}@db:5432/legere?schema=public
      AUTH_SECRET: ${AUTH_SECRET}
      COOKIE_DOMAIN: legere.example.com
      LIBRARY_ROOT: /library
      STIRLING_URL: http://stirling:8080
      S3_ENDPOINT: https://storage.example-s3.com
      S3_REGION: ${S3_REGION}
      S3_BUCKET: ${S3_BUCKET}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
      SMTP_FROM: 'Legere <no-reply@legere.example.com>'
      TURNSTILE_SECRET_KEY: ${TURNSTILE_SECRET_KEY}
      EMBEDDINGS_API_BASE_URL: ${EMBEDDINGS_API_BASE_URL}
      EMBEDDINGS_API_KEY: ${EMBEDDINGS_API_KEY}
    volumes:
      - /mnt/documents:/library:ro                   # THE external library (read-only!)
    ports: ['80']                                    # external ingress terminates TLS

volumes: { db-data: {} }
```

Start: `docker compose -f docker-compose.deploy.yml up -d`. Migrations apply automatically on start.
Liveness probe: `GET /api/health`.

## 12.8. Production notes

- **Backups:** PostgreSQL dumps + S3 bucket replication. The library volume is the user's own data.
- **First run:** open the site → onboarding creates the first admin → add a library in
  `/admin/libraries` pointing at the mounted folder → watch the first scan in the queue dashboard.
- **Email pitfalls:** unset `SMTP_HOST` = codes only in container logs (demo fallback — fine for a
  single-admin start, useless for inviting others). `SMTP_SECURE` must match the port (465→true,
  587→false); `SMTP_FROM` domain must be authorized (SPF/DKIM) or providers will 5xx/spam-folder you.
- **Behind the proxy:** the app assumes `trust proxy` (already set); cookies are `Secure` in prod, so
  TLS at the ingress is mandatory.
- **Scaling later:** a second app container is possible (sessions/queue are in Postgres, files in
  S3), but per-IP rate limits become per-instance — acceptable, documented limitation.

## 12.9. Open questions

None.
