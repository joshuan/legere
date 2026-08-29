# 12. Build, Configuration, Run

## 12.1. Toolchain

- Node **26** (exact version pinned in `.nvmrc` at scaffolding; always `nvm use`).
- npm only; one `package.json`, `package-lock.json` committed. `pnpm`/`yarn`/`bun` forbidden.
- TypeScript **7**, `strict`. Dev/test transpilation — SWC (ADR-017); prod server build — `tsc`.
- The lockfile is authoritative and is regenerated with `npm run deps:relock` — the install runs in a
  `node:26-alpine` container with `--ignore-scripts`, so the resolution matches the image's platform
  and no dependency's install script runs on the developer's machine to produce it.
- **`overrides` are for advisories a direct dependency will not let go of**, never for pinning a
  version somebody prefers. A transitive package with an open advisory whose parent pins it exactly
  is the only case: `next` pins `postcss` to an exact version and takes `sharp` as an optional
  dependency a major behind, and `eslint-plugin-boundaries` pins `handlebars` exactly (SEC-07). Each
  entry raises the package to the version the upstream project itself already ships, and comes out
  again when the parent catches up — CI's `npm audit` ([`13 §13.1`](./13-ci-cd.md#131-principles)) is
  what says when it has not.

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
TRUST_PROXY=                                 # empty = do not believe X-Forwarded-For; 1 = one ingress in front. Empty *behind* a proxy makes every anonymous caller one rate-limit bucket (12 §12.8)

# --- database ---
DATABASE_URL=postgresql://legere:legere@localhost:5432/legere?schema=public

# --- auth ---
AUTH_SECRET=dev-secret-change-me-min-32-chars!!   # ≥32 chars; HMAC for email codes
SESSION_TTL_DAYS=30
API_TOKEN_TTL_DAYS=90                        # default lifetime of a read-only API token (08 §8.2a); the owner may choose 1…365
COOKIE_DOMAIN=                               # empty in dev; set consciously in prod
TURNSTILE_SECRET_KEY=                        # empty = CAPTCHA disabled; set it only on a build that has the site key below, or nothing can pass it — warned about at every start (08 §8.4)
NEXT_PUBLIC_TURNSTILE_SITE_KEY=              # build-time (baked into the client bundle); the widget is rendered when it is set. Setting it here, at runtime, does nothing

# --- email (empty SMTP_HOST = LogEmailSender: the letter is dropped, never printed) ---
SMTP_HOST=                                   # a local catcher makes registration work on a laptop (§12.5)
SMTP_PORT=587
SMTP_SECURE=false                            # 465 → true, 587 → false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="Legere <no-reply@example.com>"
SMTP_ALLOW_PLAINTEXT=false                   # on 587 the session must upgrade to TLS or the letter is not sent; true sends it in the clear, and production refuses that for a relay that is not on this host (§12.4a)
ALLOW_UNCONFIGURED_EMAIL=false               # production refuses an empty SMTP_HOST without this (§12.4a)

# --- library volume ---
LIBRARY_ROOT=./dev-library                   # the folder `npm run dev` reads; the container overrides this with /library
GROUPING_WINDOW_MINUTES=10                   # how close in time scans must be to be suggested as one document (05 §5.6a)
SCAN_MAX_FILES=50000                         # a scan gives up past this many files (05 §5.2); 0 = no limit
UPLOAD_MAX_BYTES=104857600                   # 100 MiB: the largest file a user may upload (05 §5.1a)
TRASH_RETENTION_DAYS=30                      # how long a file of ours waits in the trash before the sweep deletes it (05 §5.7a); a library original waits for a person however this is set

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
DOCLING_URL=http://localhost:5001            # where `npm run dev:up` serves it; empty here left every dev on the fallback
DOCLING_PICTURE_DESCRIPTION=false            # captions for pictures; read the note below before turning it on

# --- processing ---
OCR_LANGUAGES=rus+eng
PDF_TEXT_MIN_CHARS_PER_PAGE=32               # below → treat as scan, run OCR
IMAGE_PAGE_CORRECTION=true                   # level the lighting and take out the skew of a photographed page (05 §5.5 step 1)
PREVIEW_MAX_DIM=1600
THUMB_MAX_DIM=400
CHUNK_TARGET_CHARS=1000
CHUNK_OVERLAP_CHARS=200
CLASSIFIER_EXCERPT_CHARS=0                   # 0 = the whole text; a cap leaves the model naming a document from its letterhead (05 §5.5 step 4)
CLASSIFIER_MAX_PAGE_IMAGES=20                # how many pages travel with that text as pictures
CLASSIFIER_AUTO_MAX_PAGES=10                 # past this the pipeline does not analyse unasked at all — 0 lifts it (05 §5.5 step 4)

# --- the recogniser of last resort (05 §5.5 step 3): a vision model reading recognised pages ---
TRANSCRIBER_API_BASE_URL=                    # empty = the tesseract result stands, as before this existed
TRANSCRIBER_API_KEY=
TRANSCRIBER_MODEL=                           # a model that accepts images
TRANSCRIBER_MAX_PAGES=20                     # transcribing forty pages is a different decision from analysing them
TRANSCRIBER_PAGE_IMAGE_MAX_DIM=1600
CLASSIFIER_PAGE_IMAGE_MAX_DIM=1200           # longest side of each of them: a model reads a page, it does not print it
QUEUE_CONCURRENCY_INGEST=4
QUEUE_CONCURRENCY_PROCESS=2
QUEUE_UNIT_CONCURRENCY=1
QUEUE_REPROCESS_MAX=500                      # cap on one POST /api/admin/queue/reprocess call

# --- per-service gates (05 §5.4b): concurrency 0 = ungated (else 1…32), cooldown 0…600 seconds ---
SERVICE_CONCURRENCY_STIRLING=0               # calls of this service in flight at once
SERVICE_COOLDOWN_STIRLING=0                  # how long a finished call's slot stays shut
SERVICE_CONCURRENCY_DOCLING=0                # one whole parse — submit, poll, collect — is one call
SERVICE_COOLDOWN_DOCLING=0
SERVICE_CONCURRENCY_CLASSIFIER=0             # the provider the analysis step reads with (CLASSIFIER_* below)
SERVICE_COOLDOWN_CLASSIFIER=0
SERVICE_CONCURRENCY_TRANSCRIBER=0
SERVICE_COOLDOWN_TRANSCRIBER=0
SERVICE_CONCURRENCY_EMBEDDINGS=0             # one batch of embeddings is one call
SERVICE_COOLDOWN_EMBEDDINGS=0

# --- AI providers (empty base URL = feature disabled, steps SKIPPED) ---
EMBEDDINGS_API_BASE_URL=                     # OpenAI-compatible, e.g. https://api.openai.com/v1 or http://ollama:11434/v1
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=bge-m3                      # multilingual, 1024-wide; what the column is sized for
EMBEDDING_DIMENSIONS=1024                    # must match the DB vector(1024); changing requires migration + re-vectorization (04 §4.5)
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

**The `ANALYST_*` names are still read.** The four knobs that tune the analysis — the excerpt, the
page images, their size, and the length past which a document is not analysed unasked — were named
after the port that calls them before they moved into the namespace of the variable that turns the
service on ([`05 §5.4b`](./05-library-and-processing.md#54b-per-service-gates) gives the same reason
for the gate keys). Where the `CLASSIFIER_*` name is absent the `ANALYST_*` one is read in its
place, so an instance carrying `ANALYST_AUTO_MAX_PAGES=10` keeps that cap across the upgrade instead
of quietly falling back to the default. `/admin/instance` reports the row under the name it has now.

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
image and `deploy/docker-compose.yaml` set — is held to more than that, for two reasons: the values
this repository publishes so a reader can copy a file and see the app start are values anybody can
read on GitHub, and a setting that is merely a convenience on a laptop can be a way in on a
deployment. `loadConfig` collects every problem and refuses to boot, in the same multi-line form the
schema errors use:

| Refused | Why |
|---|---|
| `AUTH_SECRET` equal to the example in `.env.example` | It is the HMAC key for email verification codes, and it is published |
| `S3_SECRET_ACCESS_KEY` equal to `legere-secret` | Same, for the bucket holding every derived artifact |
| The browser-facing bucket origin equal to `APP_BASE_URL`'s | 🔒 The viewer embeds the canonical PDF from a presigned URL, and a PDF viewer runs script in the origin that served it. Different origins is what keeps a document in the archive from scripting the app; put them on one and it can. The check reads `S3_PUBLIC_ENDPOINT`, or `S3_ENDPOINT` when no public one is set ([`09 §9.2`](./09-file-storage.md)) |
| An empty `SMTP_HOST`, unless `ALLOW_UNCONFIGURED_EMAIL=true` | 🔒 Every account is created, verified and recovered by typing a six-digit code that arrives by email ([`08 §8.1.3`](./08-auth-and-authorization.md)), and that code exists in the letter and nowhere else — the log fallback records a letter's recipient and subject and drops its body (§8.1.8). So an instance with no mail server is an instance nobody can sign up to, and it says so at boot rather than at the sign-up form. It used to print the code instead, which made "can read `docker compose logs`" mean "can take over any account" |
| `SMTP_ALLOW_PLAINTEXT=true` on an unencrypted connection to a relay that is not on this host | 🔒 The opt-out below, granted only where it costs nothing. The letters carry that same six-digit code and the session carries the relay password, so sending them in the clear to another machine is handing both to whoever sits on the path — which is the whole of [SEC-62](./tasks/security-audit-2026-08-second-pass.md#sec-62). "On this host" is read literally: `localhost`, `127.0.0.1` or `::1`, the three ways of writing a relay the packets never leave the machine to reach. Anything else is a network, and a network is what the refusal is about. The refusal is silent when it would change nothing — when `SMTP_SECURE=true`, where the session is TLS from the first byte and the flag is inert, and when there is no `SMTP_HOST` at all |

`ALLOW_UNCONFIGURED_EMAIL` is the way to run without mail on purpose — an archive whose accounts
already exist, a relay being repaired. It buys the *boot*, not the letters: registration,
verification and password resets still cannot complete, and the startup warning says so on every
start, which is how a deliberate setting is noticed once it has outlived its reason.

🔒 `SMTP_ALLOW_PLAINTEXT` is the same shape of permission, for the other half of §12.8's mail rule.
With `SMTP_SECURE=false` the transport asks for `STARTTLS` whether or not the greeting offered it
and gives up if the upgrade does not happen, so a relay talked out of encrypting produces a send
failure rather than a plaintext session that looks like success from both ends. Setting this to
`true` takes that floor away — for a Postfix listening on `127.0.0.1`, or a mail catcher on a laptop
(§12.5), where there is no path for anyone to sit on. It is a per-connection decision and not a
per-environment one, which is why production refuses it by the *relay's address* rather than by
`NODE_ENV`: the same-host case is exactly as safe on a deployment as it is on a laptop, and every
other case is exactly as unsafe. Like the setting above it buys nothing quietly — while it is in
effect the startup warning names the relay and says what travels to it.

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` carry **no defaults at all**: a credential that works
without being set is a credential published in this repository. Every path that runs the app supplies
them — `.env` in development, the compose file in a deployment, `test/setup.server.ts` in CI.

Five things are warned about at startup rather than refused, because an operator may want them:

- `APP_BASE_URL` that is not `https://` — session cookies then travel without the `Secure` attribute
  ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions) explains why that follows the
  address rather than `NODE_ENV`), and so does everything else.
- A development instance running on a published example value — the warning says production will
  refuse it, so the surprise happens on a laptop and not on a deploy.
- An empty `SMTP_HOST` — on a laptop that is the normal state and the warning is the early notice
  that the three-step flow cannot complete; in production it can only be reached by asking for it.
- 🔒 A `SMTP_ALLOW_PLAINTEXT` that is actually in effect — set, with a relay configured, on a
  connection that is not already TLS. Where production allows it at all the relay is on this host, so
  there is nothing to refuse; but a setting made for a catcher and left behind when the catcher was
  replaced by a real relay is the way this ends up switched on where it was never meant to be, and a
  line at every start is what makes that visible. The warning names the host, because "plaintext to
  where" is the question that decides whether it matters.
- 🔒 A `TURNSTILE_SECRET_KEY` that is set — **whatever else is set beside it**. The secret turns
  CAPTCHA verification on for every login and every registration, and the token those requests must
  carry is minted by a widget that exists only in a client bundle built with
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Get the pair wrong and nobody can sign in, register or finish a
  password reset — the last administrator included — so the warning names the build argument and
  tells the operator to open the sign-in page and see a widget before they close the session. It is
  not a refusal because the correct case cannot be told from the broken one at boot: an image built
  from this repository carries the site key inlined in its bundle and *not* in its environment
  (§12.6), so a boot check on the runtime value would refuse exactly the instance that did it right
  ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha),
  [SEC-77](./tasks/security-audit-2026-08-second-pass.md#sec-77)). It is unconditional for the
  mirror-image reason: putting the site key into the runtime environment as well changes nothing
  about the bundle, and is exactly what silences the `/admin/instance` row that would otherwise have
  said so.

One more is written at the moment it can be observed rather than at boot: an unset `TRUST_PROXY` in
front of a request that carries `X-Forwarded-For` (§12.8).

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

**Reading a sign-up code locally.** `npm run db:seed` is the way in — `admin@legere.local` /
`password` — and it is enough for everything but the three-step flow itself. To go through
registration, an invite or a reset on a laptop, mail needs somewhere to land: the code is in the
letter and in no log, on purpose ([`08 §8.1.8`](./08-auth-and-authorization.md#818-local-development)).
Any catcher does; one command and three lines of `.env`:

```bash
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit   # letters at http://localhost:8025
```
```dotenv
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_ALLOW_PLAINTEXT=true
```

The third line is the one that is easy to leave out and hard to read the error of: a catcher speaks
no TLS, and without it the transport asks for the upgrade, does not get it and refuses to send
(§12.4a). It is the same permission a relay on `127.0.0.1` needs in production, granted here for the
same reason — the letter never leaves the machine.

It is not in `docker compose up` because it is not part of the product: the dev stack holds the
services Legere talks to in production, and a mail catcher is a thing to read letters with.

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
quick.

**Embeddings are a local model by default.** `EMBEDDINGS_MODEL=bge-m3` at
`EMBEDDING_DIMENSIONS=1024` is what the column is sized for (`04 §4.3`), and ollama serves it on the
OpenAI-compatible path this client speaks: `ollama pull bge-m3`, then
`EMBEDDINGS_API_BASE_URL=http://<host>:11434/v1` with no key. bge-m3 is multilingual and takes 8k
tokens, so a `CHUNK_TARGET_CHARS` chunk fits several times over. Left empty, vectorization stays
`SKIPPED` and semantic search reports itself unavailable — everything else works (`05 §5.5` step 6).
A hosted 1536-wide model (OpenAI's `text-embedding-3-small`) is the same three variables plus a key,
and a migration to widen the column: what that costs, and why the width is not a runtime setting, is
`04 §4.5`. 🔒 An ollama exposed beyond `127.0.0.1` (`OLLAMA_HOST=0.0.0.0:11434`) is an
unauthenticated API on that network — firewall it to the instance, since anyone who reaches it can
run any model on that machine.

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
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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

🔒 Five details in that runtime stage are load-bearing, and each answers something the container
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
- **npm and corepack deleted** (SEC-07). The stage runs `node` and the Prisma binary out of
  `node_modules`; the package manager the base image ships is never invoked. It is not neutral
  weight, though — it brings a dependency tree of its own, which is what the release scan of §13.3
  reports against (npm's bundled `brace-expansion` and `ip-address`): advisories against code that
  never runs here, with no fix available to us until the base image takes one. Deleting the thing
  answers both halves — the finding goes away because the code goes away, and a container that has
  been talked into running a command can no longer install anything with it.

The image still migrates itself when it is run without compose, so `docker run` remains a working
deployment; the shipped stack overrides the command and migrates in a container of its own (§12.7).

## 12.7. Deployment (`deploy/`, shipped with the repository)

`deploy/` is the supported way to run Legere: `init.sh`, `docker-compose.yaml` and `.env.example`.
The root `README.md` quickstart is `curl … /deploy/init.sh | bash` — the script asks for the document
folder (creating it when it does not exist) and for a mail server, downloads the compose file,
writes a `.env` with three generated secrets, and offers to start. They ship **in** the repository on purpose: a self-hosted
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

🔒 **So are the two containers that do the opening** ([`SEC-78`](./tasks/security-audit-2026-08-second-pass.md#sec-78)).
The app hands the bytes on: tesseract, Ghostscript, LibreOffice, PDFBox and torch run in `stirling`
and `docling`, which is where a malformed document meets native code, and until M47.11 those two
declared nothing but an image, a restart policy and an environment. They now carry the same block — a non-root user,
`cap_drop: [ALL]`, `no-new-privileges`, a read-only root filesystem, and `STIRLING_MEMORY_LIMIT` /
`DOCLING_MEMORY_LIMIT` beside `APP_MEMORY_LIMIT` in `.env`. The memory limit is the one that answers
a recorded failure rather than a hypothetical one: on 2026-08-18 a single long PDF grew until the
kernel started killing things on the host, and took the reverse proxy and sshd with it. The page
window of [`05 §5.5`](./05-library-and-processing.md) bounds what one parse asks for; this bounds
what the container may take, so an expensive document dies alone. Docling's 4 GB is the number to
lower first on a small box, and lowering it turns a dead host into failed documents.

Both take the whole set — but not as the app takes it, and each departure is written beside the
setting it belongs to:

- **Neither `/tmp` is memory.** Both write the whole upload and its intermediates there — hundreds of
  megabytes for one large scan — so a `tmpfs` would spend the memory limit above on scratch files
  and turn a big document into an OOM kill. Each gets a Docker volume instead (`stirling-tmp`,
  `docling-tmp`): writable, on disk, and still not the image. `docker compose down -v` empties them;
  nothing in them outlives a conversion.
- **Stirling insists on five more writable paths**, and they are `tmpfs` because none of them is
  worth keeping: `/configs` (its generated settings and heap-dump directory), `/logs`, `/pipeline`
  and `/customFiles` (a feature Legere does not use), and `/home/stirlingpdfuser`, where unoserver
  builds a LibreOffice profile on the first conversion. Docling needs none of this: its models are
  baked in and read from a read-only cache.
- **Stirling's image had to change to allow any of it** (`deploy/stirling/Dockerfile`). Upstream
  starts as root and its entrypoint links a diagnostics helper into `/usr/local/bin` before doing
  anything else — a write no non-root process may make and no read-only filesystem allows, and
  `set -e` turns the refusal into a container that exits 1 without saying why. Taking the executable
  bit off that helper is what the entrypoint tests for, so the block is skipped; the script is still
  there for `docker exec … bash /scripts/stirling-diagnostics.sh`. The image then declares
  `USER stirlingpdfuser` (1001), the account upstream drops to when it is started as root and the
  one that already owns everything Stirling writes — so `npm run dev:up` runs it unprivileged too,
  not only the deployment.

All of it was measured on the images this repository publishes, not reasoned about: both containers
start under the full set, Stirling answers `/api/v1/info/status`, OCRs a PDF in Russian and converts
a document through LibreOffice, and Docling parses a twelve-page window with forced tesseract OCR.

🔒 **The two parser images are pinned by digest and built by CI** ([`SEC-79`](./tasks/security-audit-2026-08-second-pass.md#sec-79),
[`13 §13.3`](./13-ci-cd.md)). `deploy/stirling` and `deploy/docling` name their bases as
`tag@sha256:…` rather than `:latest`, and their tesseract language data by commit rather than by
`main`: what the two containers that chew on hostile documents are made of no longer depends on what
an upstream published this morning. Moving a pin forward is a one-line edit that Dependabot writes
itself (it watches both directories, [`13 §13.1`](./13-ci-cd.md)), and by hand it is
`docker buildx imagetools inspect <image>:latest --format '{{.Manifest.Digest}}'` — the command is in
the comment above each `FROM`.

🔒 **The app is not given the object store's root credentials.** `minio-init` creates a scoped
service account whose policy reaches the `legere` bucket and nothing else — no other bucket, no user
administration, no console — and the app is given that. `MINIO_ROOT_PASSWORD` stays for
administration. Rotating the app's key is an edit to `.env` and the next `up`; the init step is
idempotent and updates the account in place. One ceiling worth knowing, because MinIO reports it
only as a failed container: a **service-account** secret may be at most 40 characters, so
`MINIO_APP_PASSWORD` is generated shorter than the others.

🔒 **The script asks for SMTP, and stops rather than starting a stack that cannot mail.** The
six-digit code that creates the first administrator arrives by email and is written nowhere else
(§12.4a), so an install without it is an install with no way in — and the app refuses to boot in
that state, which as a first experience is a container restarting in a loop. Answering the mail
questions is therefore part of the install; leaving the host blank ends the script with the two
steps that finish it (`SMTP_HOST` in `.env`, then `docker compose up -d`) and the opt-in for running
without mail on purpose. The port answers for `SMTP_SECURE` — 465 is implicit TLS, 587 is STARTTLS,
and mismatching that pair is the commonest mail failure there is. 🔒 **465 is the default it offers**
([`SEC-62`](./tasks/security-audit-2026-08-second-pass.md#sec-62)), and an operator who types
anything else gets a paragraph rather than silence, because the difference is not a preference:
§12.8 has it. What is typed goes into `.env` by string replacement rather than through `sed`,
because `&`, `|` and a backslash are all legal in a mail password and all mean something in a `sed`
replacement.

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
- **First run:** configure `SMTP_HOST` **before** the first start — `init.sh` asks for it, and the
  app refuses to boot without it (§12.4a) — then open the site → onboarding asks for an address and
  emails it a six-digit code → that code creates the first administrator → add a library in
  `/admin/libraries` pointing at the mounted folder → watch the first scan in the queue dashboard.
  🔒 There is no other way to obtain that code, and deliberately so: it used to be readable in
  `docker compose logs app`, which made log access equal to account takeover. If mail is broken and
  the instance must come up anyway, `ALLOW_UNCONFIGURED_EMAIL=true` starts it — with no path to a
  first administrator until a mail server exists.
- **Email pitfalls:** `SMTP_SECURE` must match the port (465→true, 587→false); `SMTP_FROM` domain
  must be authorized (SPF/DKIM) or providers will 5xx/spam-folder you. A letter that could not be
  sent is a log line naming the recipient and the subject and never the body, so "did it try?" is
  answerable from the log and "what was the code?" is not.
- 🔒 **Mail on 465, not on 587** ([`SEC-62`](./tasks/security-audit-2026-08-second-pass.md#sec-62)).
  What travels in these letters is the six-digit code that creates, verifies and recovers every
  account, and the relay password that carries it. On **465** the session is TLS from the first byte:
  a relay that will not speak it fails, loudly, and nothing about the connection is negotiable by
  whoever sits between. On **587** the session opens in the clear and is upgraded only if the server
  advertises `STARTTLS` — one line of a greeting, which an attacker on the path (a hostile LAN, a
  resolver they control, a compromised upstream) can simply delete. Nodemailer then does not upgrade
  and does not complain: the relay credential and every code go out in plaintext and every letter
  arrives, so nothing looks wrong from either end. The shipped `.env.example`, the compose defaults
  and `init.sh` therefore all say 465 with `SMTP_SECURE=true`, and 587 is a deliberate edit.
- 🔒 **Mail is encrypted, or it is not sent.** The paragraph above is what the deployment chooses;
  this is what the application will do whatever it is configured with. Whenever `SMTP_SECURE` is
  false the transport is built with `requireTLS`, so it issues `STARTTLS` on every connection —
  whether or not the greeting advertised it — and treats a refusal as a failed send. Deleting that
  one line from the greeting therefore no longer buys a plaintext session; it buys an error, and the
  letter is not sent. On 587 that is the difference between "the network between here and the relay
  is trusted" and "the relay is who it says it is": the *upgrade* is now non-negotiable, and only
  the certificate is not checked more strictly than Node's defaults check it.

  The failure says so. An operator sees `SMTP refused to encrypt` naming the host and port, the two
  ways out (465 with `SMTP_SECURE=true`, or `SMTP_ALLOW_PLAINTEXT=true` for a relay on this host) and
  the original error underneath — because "mail is broken" sends an operator to their relay's
  configuration, and this one is a decision they can make in `.env` in a minute. The body of the
  letter is never in it, here as everywhere: the code stays out of the log even when the send fails
  ([`08 §8.1.8`](./08-auth-and-authorization.md)).

  `SMTP_ALLOW_PLAINTEXT=true` is the whole of the opt-out and it is only for a relay the packets
  never leave this host to reach — production refuses it for anything else (§12.4a), and while it is
  on, every start says so.
- **Behind a proxy:** set `TRUST_PROXY` — `1` for a single ingress, a larger number for a chain, or
  a value Express understands (`loopback`, a CIDR list). It is **empty by default**, and that is
  deliberate: with it on, `req.ip` comes from `X-Forwarded-For`, which the client writes. Publish the
  app port directly with `TRUST_PROXY=1` and every caller picks their own rate-limit bucket per
  request, so the per-IP limits of [`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)
  stop existing. Set it only when something in front of the app rewrites the header. Cookies are
  `Secure` whenever `APP_BASE_URL` is `https://`, so TLS at the ingress remains the expectation.
- 🔒 **And what forgetting it costs is no longer a matter of degree.** It used to be over-throttling,
  which is the safe direction to fail. Since the throttle key became **one budget per caller** rather
  than one per caller per handler ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha),
  [SEC-57](./tasks/security-audit-2026-08-second-pass.md#sec-57)), an anonymous caller behind a proxy
  that the app does not trust is `req.ip` = the proxy — **the same caller as everybody else**. All of
  them then share a single `auth` allowance of 20 per 60 s across page loads, logins, registrations
  and the two link previews. The sign-in screen spends from it on every load, through
  `GET /api/auth/onboarding`, so twenty page loads in a minute from anywhere on the internet and the
  instance answers `429 RATE_LIMITED` to everybody, including whoever is trying to sign in. That is a
  self-inflicted denial of service from a variable left blank, which is why it is named here and not
  only in the `.env` comment.
  **The app says so when it can tell.** There is no boot check — at boot the two topologies are
  indistinguishable, and a warning on every correctly published instance is how an operator learns to
  skip warnings. Instead, when `TRUST_PROXY` is empty, the first request that arrives carrying
  `X-Forwarded-For` writes one `warn` line naming the shared budget, once per process. It is worded
  to push neither way on purpose: that header is written by whoever sent the request, so anybody can
  produce the line, and a line that read "set `TRUST_PROXY`" would be an attacker asking an operator
  to switch the per-IP limits off (SEC-05).
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
| `Content-Security-Policy` | on pages: `frame-ancestors 'none'; base-uri 'none'; form-action 'self'; script-src 'self' 'nonce-<per-request>' 'strict-dynamic'; connect-src 'self' <bucket> https://challenges.cloudflare.com; img-src 'self' data: <bucket>; object-src 'self' <bucket>`; on `/api`: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | Nothing under `/api` has a reason to load anything at all; the page directives are below |
| `Referrer-Policy` | `no-referrer` | 🔒 Invite and reset links carry a single-use credential in their path ([`08 §8.1.2`](./08-auth-and-authorization.md#812-admin-invite)); the browser default would hand it to the first third-party asset a page loads |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | None of them is used |
| `Strict-Transport-Security` | one year, `includeSubDomains` — **only when `APP_BASE_URL` is `https://`** | An instance on `http://<lan-ip>` is supported ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)); telling that browser to upgrade would lock its operator out |

Neither Express nor Next advertises what it is built on.

**Where `<bucket>` comes from.** The origin a browser is actually sent to for a presigned URL —
`S3_PUBLIC_ENDPOINT` when one is set, `S3_ENDPOINT` otherwise ([`09 §9.2`](./09-file-storage.md)) —
computed at boot from the same configuration `12.4a` already refuses to start on when it equals
`APP_BASE_URL`. It has to be named: the viewer's preview `<img>` and its canonical `<object>` point
at `/api/documents/:id/…`, which answers `302` to that origin, and a CSP is re-checked against the
host a redirect lands on.

🔒 **What `img-src` is for.** A document's Markdown is what the parser read off the pages, and a page
can say `![](https://beacon.example/p.png?d=payroll)`. Rendered, that is a read receipt on a private
archive: the uploader learns which of their documents were opened, when and from which address, out
of a deployment that is often meant to have no way out to the internet at all
([SEC-66](./tasks/security-audit-2026-08-second-pass.md#sec-66)). `img-src` is the directive that
closes it without a renderer having to be trusted. `data:` rides along for what the UI toolkit
inlines; `object-src` keeps the viewer's PDF embed working while refusing every other origin a
plugin could be pointed at.

🔒 **What `script-src` is for, and why the nonce and not `'unsafe-inline'`.** This is the directive
that blunts a stored XSS in a viewer that renders attacker-supplied Markdown
([SEC-03](./tasks/security-audit-2026-08.md#sec-03), [SEC-06](./tasks/security-audit-2026-08.md#sec-06)
option 2). It reads `'self' 'nonce-<per-request>' 'strict-dynamic'`, and each of the three earns its
place: `'self'` is the fallback for a browser that has never heard of `'strict-dynamic'`; the nonce
is minted per response and is the only thing the page's own scripts carry; `'strict-dynamic'` lets a
script that is already trusted load another, which is how the CAPTCHA widget's script arrives.
There is deliberately **no `'unsafe-inline'`** — every browser that honours the nonce ignores it, and
on the ones that do not it hands back exactly what the directive exists to take away, which is why
this was written down as a task rather than shipped weak.

**How the nonce gets onto the page** is the awkward part, and it is written up in
[`10 §10.4a`](./10-frontend-architecture.md#104a-how-the-csp-nonce-reaches-a-page): the middleware
writes the policy onto the **request** as well as the response, and Next reads its own
`content-security-policy` request header to stamp its script tags. There is no Next middleware in
this stack to do it the way Next's own guide does. §10.4a also records what Ant Design turned out to
need (nothing — the registry emits a `<style>`, and there is deliberately no `style-src`) and why
every page of this app is dynamically rendered anyway, which is what makes a per-request nonce sound.

**`connect-src` beside it.** Worth having only now that `script-src` exists — it constrains code that
is already running. `'self'` is the app's own API, the only thing the client calls today; the bucket
is there because every route to a derived artifact answers `302` into that origin and a redirect a
`fetch` follows is checked against `connect-src` again; and `https://challenges.cloudflare.com` is
what the login page's CAPTCHA widget talks to
([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)).

🔒 **The CAPTCHA origin is named unconditionally**, and that is a decision. Whether a build has a
widget at all is decided by `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, which is inlined into the client bundle
at build time and is *not* in the environment a correctly built image runs with ([`12 §12.6`](#126-dockerfile-one-image))
— the same asymmetry `08 §8.4` gives for warning about `TURNSTILE_SECRET_KEY` unconditionally. The
server cannot tell the two cases apart, and of the two ways to be wrong, naming an origin nobody
calls costs a line in a header, while omitting the one the widget needs is a sign-in page nobody on
the instance can get past. The widget's `<iframe>` needs no directive: the page policy has no
`default-src`, so `frame-src` falls back to nothing and is unconstrained.

## 12.8b. Observing a live instance from the dev machine

Development regularly asks two questions of a running instance — *what is the app logging?* and
*what does the data say?* — and both have narrow, read-only answers that deserve better than an
interactive shell on the production host. Two scripts under `scripts/ops/` provide them:

- **`scripts/ops/prod-logs.sh <target>`** — the app's pino JSON log via `ssh <host> docker logs`,
  plus a one-shot `health` summary of the host. Flags: `--since` (default `1h`), `--tail`
  (default `200`), `--grep <ERE>`. 🔒 Every target is a **fixed remote command template**; nothing
  the caller passes is interpolated into the remote command — `--since`/`--tail` are validated
  against strict patterns and `--grep` filters locally, after the transfer.
- **`scripts/ops/prod-db.sh "<SQL>"`** (or `-f file.sql`, or `-` for stdin; `--csv` for
  machine-readable output) — `psql` straight to the instance's database **as a dedicated read-only
  role**. 🔒 Read-only is a property of that role's privileges in PostgreSQL (membership in
  `pg_read_all_data` and nothing else), not of the wrapper's discipline; the wrapper adds
  `default_transaction_read_only=on` and a 15 s `statement_timeout` on top as a seat belt, and never
  prints the credentials.

**Where the instance's coordinates live — and why not here.** Both scripts read
`~/.config/legere/ops.env` (path overridable via `LEGERE_OPS_ENV`; template with every variable
name: [`scripts/ops/ops.env.example`](../scripts/ops/ops.env.example)). This repository is public;
host names, ssh aliases, container names, database addresses and passwords are each operator's own
and never belong in it. The scripts therefore carry the *shape* of the access and none of its
*values*, and refuse loudly (exit 2, naming the template) when the file is missing or incomplete.

**Why this is the sanctioned path.** `.claude/settings.json` (committed) allows exactly these two
scripts to run unprompted, which makes the routine questions cheap for an AI development agent;
anything beyond them — an arbitrary ssh, a write, another host — falls outside the allowlist and
asks first. The alternative this replaces was a blanket ssh permission, which answered the same
questions while also permitting everything else.

**Scope.** The app container and the database — deliberately nothing more. Stirling, Docling, the
AI providers and S3 are external services from this application's point of view (`02` ADRs); their
health is read from the outcomes the pipeline records — `documents.processing_error`,
`document_events` — via `prod-db.sh`, not from their hosts, whose administration is not this
repository's business.

## 12.9. Open questions

None.
