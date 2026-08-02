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
LIBRARY_ROOT=./dev-library                   # the folder `npm run dev` reads; the container overrides this with /library
SCAN_MAX_FILES=50000                         # a scan gives up past this many files (05 §5.2); 0 = no limit

# --- S3 (derived artifacts; dev values match the compose MinIO) ---
S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=                          # empty = same as S3_ENDPOINT; set it when browsers reach the bucket under another name (09 §9.2)
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
mkdir -p dev-library && cp -r <some-documents> dev-library/   # your test corpus; LIBRARY_ROOT points here
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
    # Stirling 2.x requires a login by default and answers 401 to every API call.
    environment: { SECURITY_ENABLELOGIN: 'false', SYSTEM_ENABLEANALYTICS: 'false' }
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

## 12.7. Deployment (`deploy/`, shipped with the repository)

`deploy/` is the supported way to run Legere: `init.sh`, `docker-compose.yaml` and `.env.example`.
The root `README.md` quickstart is `curl … /deploy/init.sh | bash` — the script asks for the document
folder (creating it when it does not exist), downloads the compose file, writes a `.env` with three
generated secrets, and offers to start. They ship **in** the repository on purpose: a self-hosted
product whose install instructions are "write your own compose file" is a product nobody installs.

What must never ship is a secret, and none does: `.env.example` carries empty placeholders, `init.sh`
fills them with `openssl rand -hex 24` (hex, because the value lands inside a `postgres://` URL where
a `/` or `+` would truncate it), and the resulting `.env` is written `chmod 600`. Empty placeholders
are also why the compose file's `${VAR:?…}` guards exist and why the file cannot be used with the
example as-is: compose treats an empty value as missing and refuses to start, naming one variable at
a time. Generating the values is the script's whole reason to exist.

Without a terminal — piped into a provisioning tool, or run in CI — the script asks nothing, applies
defaults, and stops before starting containers rather than doing it unannounced. Settings go in front
of `bash`, not in front of `curl`, or they reach the wrong process:

```bash
curl -fsSL https://raw.githubusercontent.com/joshuan/legere/main/deploy/init.sh | LIBRARY_PATH=/mnt/documents bash
```

The stack is self-contained: the app, PostgreSQL with pgvector, Stirling-PDF, and MinIO with a
one-shot bucket init. Only the app and MinIO publish a port; the database and Stirling stay on the
internal network. Migrations apply themselves on start (§12.6). Pointing `S3_*` at a managed object
store and deleting the two MinIO services is a supported edit, and is what a larger deployment does.

Two settings decide whether a fresh install works, and both are the first thing `.env.example`
explains:

- `LIBRARY_PATH` — the folder mounted at `/library`, **read-only**. It is the operator's own document
  storage; Legere never writes there ([`09 §9.1`](./09-file-storage.md)).
- `S3_PUBLIC_ENDPOINT` — how the *browser* reaches the bucket. The server talks to `http://minio:9000`
  inside the compose network, but a presigned URL is only valid for the host it was signed against,
  so previews stay blank unless this names the outside address ([`09 §9.2`](./09-file-storage.md)).

Beyond that: `APP_BASE_URL` must match what the browser shows (the CSRF origin check is fail-closed),
and the `sid` cookie is `Secure` in production — over plain HTTP only `localhost` works, anything
else needs TLS in front (§12.8).

The compose project is named `legere`. Running it from a clone of this repository collides with the
development stack of §12.5, which takes the same name from its directory — use
`docker compose -p <other-name>` there.

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
