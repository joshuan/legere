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
  "docling:captions": "docker build -t legere-docling:dev --build-arg PICTURE_DESCRIPTION_MODEL=HuggingFaceTB/SmolVLM-256M-Instruct deploy/docling && docker compose up -d --force-recreate docling",
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
TRUST_PROXY=                                 # empty = do not believe X-Forwarded-For; 1 = one ingress in front (12 §12.8)

# --- database ---
DATABASE_URL=postgresql://legere:legere@localhost:5432/legere?schema=public

# --- auth ---
AUTH_SECRET=dev-secret-change-me-min-32-chars!!   # ≥32 chars; HMAC for email codes
SESSION_TTL_DAYS=30
API_TOKEN_TTL_DAYS=90                        # default lifetime of a read-only API token (08 §8.2a); the owner may choose 1…365
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
GROUPING_WINDOW_MINUTES=10                   # how close in time scans must be to be suggested as one document (05 §5.6a)
SCAN_MAX_FILES=50000                         # a scan gives up past this many files (05 §5.2); 0 = no limit
UPLOAD_MAX_BYTES=104857600                   # 100 MiB: the largest file a user may upload (05 §5.1a)

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

# --- Docling (layout-aware parsing; empty URL = fall back to Stirling's converter) ---
DOCLING_URL=
DOCLING_PICTURE_DESCRIPTION=false            # captions for pictures; read the note below before turning it on

# --- processing ---
OCR_LANGUAGES=rus+eng
PDF_TEXT_MIN_CHARS_PER_PAGE=32               # below → treat as scan, run OCR
PREVIEW_MAX_DIM=1600
THUMB_MAX_DIM=400
CHUNK_TARGET_CHARS=1000
CHUNK_OVERLAP_CHARS=200
QUEUE_CONCURRENCY_INGEST=4
QUEUE_CONCURRENCY_PROCESS=2
QUEUE_UNIT_CONCURRENCY=1
QUEUE_REPROCESS_MAX=500                      # cap on one POST /api/admin/queue/reprocess call

# --- AI providers (empty base URL = feature disabled, steps SKIPPED) ---
EMBEDDINGS_API_BASE_URL=                     # OpenAI-compatible, e.g. https://api.openai.com/v1 or http://ollama:11434/v1
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536                    # must match the DB vector(1536); changing requires migration + re-vectorization
CLASSIFIER_API_BASE_URL=                     # empty = reuse EMBEDDINGS_API_BASE_URL; both empty = analysis SKIPPED
CLASSIFIER_API_KEY=
CLASSIFIER_MODEL=
```

**`DOCLING_PICTURE_DESCRIPTION`.** Docling can write a caption under every picture in a document,
using a vision model that runs inside its container. It works, and it is off by default, because
measured on one 1-page train ticket with three small pictures (logo, QR code, barcode) it took **17
minutes** at ~4 cores — the model is `SmolVLM-256M`, and there is no GPU in the CPU image. The
default `picture_description_area_threshold` (5% of the page) skips pictures that small altogether,
so at the default setting nothing is captioned and nothing is slow; lowering it is what costs the
17 minutes. The captions themselves are literal — "a logo consisting of two main elements: a flag
and text" for the operator's logo, which is true and useless: it never named the railway. If what
you want from a picture is *what it means*, the AI step ([`05 §5.5`](./05-library-and-processing.md)
step 4) reads the document as a whole and answers that better and in one second.

The model is not in the published image (it is ~0.9 GB). In development one command builds it in and
restarts the container:

```bash
npm run docling:captions
```

For a deployment, build the image the same way and push it under your own tag:

```bash
docker build -t <your-registry>/legere-docling:captions \
  --build-arg PICTURE_DESCRIPTION_MODEL=HuggingFaceTB/SmolVLM-256M-Instruct \
  deploy/docling
```

Three things have to line up, and each one fails differently, so all three are handled rather than
documented:
- **the model has to be there.** Without it Docling answers `404`, and the markdown step now fails
  with an error naming the command above rather than the bare status code;
- **the conversion has to be allowed to take its time.** It is submitted to Docling's asynchronous
  endpoint and long-polled, because the synchronous one cannot carry work this long: `docling-serve`
  answers `504` after 120 s, and Node's HTTP client gives up waiting for headers after 300 s — a
  conversion going perfectly well then fails as `fetch failed`. With captions on the overall budget
  is 55 minutes, inside the `document-process` job's own hour.

The picture threshold is lowered to 1% of the page when captions are on: Docling's own default of 5%
skips exactly the pictures a document archive has — a logo, a stamp, a QR code — and the feature
then looks broken rather than strict.

`NEXT_PUBLIC_*` values are **build-time**: they are baked into the client bundle during `next build`
(passed as Docker build-args, [`13 §13.3`](./13-ci-cd.md#133-githubworkflowsreleaseyml)); setting them
at runtime has no effect.

**What is deliberately not here.** The bounds that stop one expensive document from costing the whole
instance — the pixel budget for images, how many bytes a step may hold, how long an outbound call may
take, how much of the Markdown a search snippet is cut from — are constants in the code and not
variables in this file. They are listed with their values and their reasons in
[`05 §5.4a`](./05-library-and-processing.md#54a-what-one-document-may-cost). The reasoning is the
same one that keeps `PDF_TEXT_MIN_CHARS_PER_PAGE` here and the OCR timeout there: an operator can
tell how much text makes a page a scan, and cannot tell what the right Stirling timeout is. An
instance that would need a different one has a container to fix.

## 12.4a. What production refuses to start with

The schema above validates *shape*. A production instance — `NODE_ENV=production`, which both the
image and `deploy/docker-compose.yaml` set — is held to more than that, because the values this
repository publishes so a reader can copy a file and see the app start are values anybody can read
on GitHub. `loadConfig` collects every problem and refuses to boot, in the same multi-line form the
schema errors use:

| Refused | Why |
|---|---|
| `AUTH_SECRET` equal to the example in `.env.example` | It is the HMAC key for email verification codes, and it is published |
| `S3_SECRET_ACCESS_KEY` equal to `legere-secret` | Same, for the bucket holding every derived artifact |
| The browser-facing bucket origin equal to `APP_BASE_URL`'s | 🔒 The viewer embeds the canonical PDF from a presigned URL, and a PDF viewer runs script in the origin that served it. Different origins is what keeps a document in the archive from scripting the app; put them on one and it can. The check reads `S3_PUBLIC_ENDPOINT`, or `S3_ENDPOINT` when no public one is set ([`09 §9.2`](./09-file-storage.md)) |

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` carry **no defaults at all**: a credential that works
without being set is a credential published in this repository. Every path that runs the app supplies
them — `.env` in development, the compose file in a deployment, `test/setup.server.ts` in CI.

Two things are warned about at startup rather than refused, because an operator may want them:

- `APP_BASE_URL` that is not `https://` — session cookies then travel without the `Secure` attribute
  ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions) explains why that follows the
  address rather than `NODE_ENV`), and so does everything else.
- A development instance running on a published example value — the warning says production will
  refuse it, so the surprise happens on a laptop and not on a deploy.

## 12.5. Local development

```bash
nvm use
npm install
cp .env.example .env
mkdir -p dev-library && cp -r <some-documents> dev-library/   # your test corpus; LIBRARY_ROOT points here
npm run dev:up          # PostgreSQL(+pgvector) + Stirling-PDF + Docling + ollama + MinIO (+ bucket init)
npm run db:migrate:dev
npm run db:seed         # admin@legere.local / password; library over dev-library/
npm run dev             # one process on :3000
```

**Trying the AI step locally.** The dev stack includes `ollama`, which speaks the same
OpenAI-compatible API as any hosted provider, so nothing but `.env` changes between them:

```bash
docker compose exec ollama ollama pull mistral-nemo:12b     # ~7.1 GB, once
```
```dotenv
CLASSIFIER_API_BASE_URL=http://localhost:11434/v1
CLASSIFIER_MODEL=mistral-nemo:12b
```

**Which model.** Bigger than you would expect, because the hard part of this step is not the format
of the answer but knowing things. Measured on one real train ticket — Podgorica → Belgrade, issued
by ŽPCG, with no country named anywhere in its text:

| model | answer |
|---|---|
| `qwen2.5:7b` | document type right, city `Podgorica` right, country **`RS`** — it named the city and then placed it in the wrong country |
| `mistral-nemo:12b` | document type right, city `Podgorica`, country **`ME`** — right |
| `qwen2.5:14b` | never answered: 9 GB of weights do not load in a 12 GB Docker VM |

Memory is the constraint worth planning for: the 12B needs ~7 GB resident *while Docling holds its
own models*, so a 12 GB VM OOM-kills it mid-job and the step fails with `llama-server process has
terminated: signal: killed`. 20 GB is comfortable (`colima start --memory 20 --cpu 6`; Docker
Desktop has the same setting under Resources).

Run it with `npx vitest run --project server test/integration/analyst.integration.test.ts` and the
environment above: the test skips itself when no provider is configured and prints what the model
you chose actually said.

On macOS the container has no GPU — Docker cannot pass Metal through — so answers take tens of
seconds instead of one. That is fine for seeing the step work; run ollama natively if you want it
quick. Embeddings are a separate question: `EMBEDDING_DIMENSIONS` must match the `vector(1536)`
column, and the usual local embedding models are 768 or 1024, so pointing `EMBEDDINGS_API_BASE_URL`
at ollama needs a migration first — leave it empty and vectorization stays `SKIPPED`.

Root `docker-compose.yaml` (dev dependencies only — the app itself is NOT in it):

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_USER: legere, POSTGRES_PASSWORD: legere, POSTGRES_DB: legere }
    ports: ['127.0.0.1:5432:5432']
    volumes: ['db-data:/var/lib/postgresql/data']
  stirling:
    # Our own build too: the upstream image carries six tesseract languages, none of them
    # Cyrillic (ADR-018).
    image: legere-stirling:dev
    build: ./deploy/stirling
    ports: ['127.0.0.1:8080:8080']
    # Stirling 2.x requires a login by default and answers 401 to every API call.
    environment: { SECURITY_ENABLELOGIN: 'false', SYSTEM_ENABLEANALYTICS: 'false' }
  docling:
    # Our own build: the upstream image ships tesseract with English only (ADR-018).
    image: legere-docling:dev
    build: ./deploy/docling
    environment: { DOCLING_SERVE_ENABLE_UI: 'false' }
    ports: ['127.0.0.1:5001:5001']
  ollama:
    image: ollama/ollama:latest
    ports: ['127.0.0.1:11434:11434']
    volumes: ['ollama-data:/root/.ollama']
  minio:
    image: minio/minio
    command: server /data --console-address ':9001'
    environment: { MINIO_ROOT_USER: legere, MINIO_ROOT_PASSWORD: legere-secret }
    ports: ['127.0.0.1:9000:9000', '127.0.0.1:9001:9001']
    volumes: ['minio-data:/data']
  createbuckets:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 legere legere-secret &&
                  mc mb --ignore-existing local/legere"
volumes: { db-data: {}, minio-data: {}, ollama-data: {} }
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
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 8080
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server/main.js"]
```

🔒 Four details in that runtime stage are load-bearing, and each answers something the container
would otherwise do:

- **`USER node`** (uid 1000). The process decodes whatever the library holds — PDFs and images,
  through native libraries — and nothing it does needs root. Everything copied above stays owned by
  root and merely readable, so the running process cannot rewrite its own code.
- **`PORT=8080`, `EXPOSE 8080`.** A port below 1024 needs a capability an unprivileged process does
  not have outside Docker's own default. Which port the operator publishes is unchanged.
- **`CHECKPOINT_DISABLE=1`.** The Prisma CLI otherwise checks for a newer version and caches the
  answer under `$HOME` — a network call and a write, and the filesystem is read-only.
- **`.next/cache` created and chowned.** It is the one path the process genuinely writes to: Next
  makes it on the first render. Pre-creating it means the `tmpfs` the compose file mounts there
  lands on a directory the runtime user already owns.

The image still migrates itself when it is run without compose, so `docker run` remains a working
deployment; the shipped stack overrides the command and migrates in a container of its own (§12.7).

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
internal network. Pointing `S3_*` at a managed object store and deleting the two MinIO services is a
supported edit, and is what a larger deployment does.

**Migrations run in a container of their own** — a one-shot `migrate` service the app waits for with
`service_completed_successfully`. Two things follow: a second app replica cannot race a first one on
the migration advisory lock, and the role that performs DDL is named in exactly one place, so a
deployment that wants the application to hold a DML-only role changes `DATABASE_URL` there and
nowhere else. That second role is **not** shipped yet: both services carry the same URL today, which
is what keeps `statement_timeout` unset (§12.8) and is the remaining half of the audit's SEC-43.

🔒 **The app container is unprivileged and cannot write to itself:** `user: '1000:1000'`,
`cap_drop: [ALL]`, `no-new-privileges`, `read_only: true`, and a memory limit. Exactly two paths stay
writable, both `tmpfs` and both throwaway — `/tmp`, and `/app/.next/cache`, which Next creates on the
first render. A hole in a native image or PDF library then costs a container rather than a host. If
`document-process` jobs start dying with exit code 137, `APP_MEMORY_LIMIT` is the knob: OCR and the
conversion of a large scan are what need the room.

🔒 **The app is not given the object store's root credentials.** `minio-init` creates a scoped
service account whose policy reaches the `legere` bucket and nothing else — no other bucket, no user
administration, no console — and the app is given that. `MINIO_ROOT_PASSWORD` stays for
administration. Rotating the app's key is an edit to `.env` and the next `up`; the init step is
idempotent and updates the account in place. One ceiling worth knowing, because MinIO reports it
only as a failed container: a **service-account** secret may be at most 40 characters, so
`MINIO_APP_PASSWORD` is generated shorter than the others.

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
- **Behind a proxy:** set `TRUST_PROXY` — `1` for a single ingress, a larger number for a chain, or
  a value Express understands (`loopback`, a CIDR list). It is **empty by default**, and that is
  deliberate: with it on, `req.ip` comes from `X-Forwarded-For`, which the client writes. Publish the
  app port directly with `TRUST_PROXY=1` and every caller picks their own rate-limit bucket per
  request, so the per-IP limits of [`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)
  stop existing. Set it only when something in front of the app rewrites the header. Cookies are
  `Secure` whenever `APP_BASE_URL` is `https://`, so TLS at the ingress remains the expectation.
- **Scaling later:** a second app container is possible (sessions/queue are in Postgres, files in
  S3), but per-IP rate limits become per-instance — acceptable, documented limitation.

### `statement_timeout` — where it belongs, and why it is not set yet

🔒 Nothing sets one today, and no query the application issues can be relied on to stop on its own.
Search is the one a signed-in caller can repeat at will; it is bounded from the application side
([`05 §5.4a`](./05-library-and-processing.md#54a-what-one-document-may-cost)), but a bound inside a
query is not a limit on the query, and the next expensive query will not have thought about it.

It belongs **on the database role the application connects as**, and nowhere else:

- Not on the connection string. `DATABASE_URL` is the operator's, it carries the password, and every
  deployment writes its own; a limit appended to a value copied out of an example file survives
  exactly until somebody edits it, and disappears silently rather than loudly.
- Not in application code. `SET statement_timeout` applies to whichever pooled connection happened to
  run it, which is a limit that holds for some queries and not others — the worst kind.
- Not in a migration as it stands, which is the reason this is a note and not a line of SQL:
  **migrations run as the same role the application uses.** A timeout low enough to be worth having
  would kill the first `CREATE INDEX` over a large table, and an upgrade that cannot finish is a
  worse failure than the one being prevented.

What it takes is therefore one thing, and it is already a task of its own: the migration and the
application must connect as **two different roles** — the split M15.10 introduces for privilege
reasons ([`SEC-43`](./tasks/security-audit-2026-08.md#sec-43)). Once they are separate, one statement
belongs beside the role creation in the deployment:

```sql
ALTER ROLE legere_app SET statement_timeout = '30s';
```

30 s: an order of magnitude above the slowest legitimate request the application makes (a hybrid
search over a large archive is milliseconds; the pipeline's long work is in sibling containers, not
in Postgres), and far below the point at which a caller has taken a connection out of circulation.
Applied to the role rather than to the session, it survives reconnects and pool growth, and it cannot
be forgotten by whoever writes the next query. The migration role keeps no timeout at all.

## 12.8a. Security headers

Set on every response by one middleware mounted above the dispatcher, so pages and `/api` alike
carry them ([`06 §6.9`](./06-backend-architecture.md)):

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | The archive serves user content; nothing in it may be sniffed into something executable |
| `X-Frame-Options` | `DENY` | Clickjacking, for anything predating `frame-ancestors` |
| `Content-Security-Policy` | `frame-ancestors 'none'` on pages; `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` on `/api` | Nothing under `/api` has a reason to load anything at all |
| `Referrer-Policy` | `no-referrer` | 🔒 Invite and reset links carry a single-use credential in their path ([`08 §8.1.2`](./08-auth-and-authorization.md#812-admin-invite)); the browser default would hand it to the first third-party asset a page loads |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | None of them is used |
| `Strict-Transport-Security` | one year, `includeSubDomains` — **only when `APP_BASE_URL` is `https://`** | An instance on `http://<lan-ip>` is supported ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)); telling that browser to upgrade would lock its operator out |

Neither Express nor Next advertises what it is built on.

**What is deliberately absent: a `script-src` for pages.** Ant Design's CSS-in-JS and Next's inline
bootstrap need either `'unsafe-inline'`, which would buy nothing while looking like it bought
something, or a per-request nonce threaded through the Ant Design registry and Next's script tags.
The second is the one worth having — it is what would blunt a stored XSS — and it is a task of its
own, tracked in the backlog rather than left as a comment.

## 12.9. Open questions

None.
