# 02. Architecture Overview

The foundation is one process/one port; around it: the external read-only library, the processing
queue, PostgreSQL with pgvector, a private S3 bucket for derived artifacts, and a sibling Stirling-PDF
container.

## 2.1. Core principle: one process, one port

The backend (NestJS) and the frontend (Next.js) live in **one repository** and run as **one Node.js
process** listening on one port. At the entry point there is an Express instance (via Nest
`ExpressAdapter`) that splits the traffic:

- `/api/*` is handled by **NestJS** (REST API, business logic per Clean Architecture);
- all other traffic (`*`, including `/_next/*`, pages, static assets) — by **Next.js** (App Router).

The **pg-boss queue workers** (file processing) live in the same process — there is no separate worker
container.

```
                    ┌───────────────── one Node.js process (PORT) ────────────────────┐
 browser ──HTTPS*──►│  Express (from Nest ExpressAdapter)                             │
                    │    ├── /api/*  → NestJS (presentation → application → domain)   │
                    │    └── *       → Next.js (App Router, React, antd, next-intl)   │
                    │  pg-boss workers (scan, parse, preview, vectorize, merge)       │
                    └──────┬───────────────┬───────────────┬───────────────┬──────────┘
                           │ SQL (Prisma)  │ HTTP (intern.)│ S3 API        │ fs (:ro)
                           ▼               ▼               ▼               ▼
              ┌──────────────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐
              │ PostgreSQL + pgvector│ │ Stirling-PDF│ │ S3 (private │ │ /library (ro) —  │
              │ (sibling container)  │ │ (sibling    │ │ bucket):    │ │ external         │
              │ data + queue +       │ │ container)  │ │ previews, md│ │ document         │
              │ vectors + FTS        │ │ PDF/OCR/    │ │ PDF artif., │ │ library          │
              │                      │ │ merge/crop  │ │ signed URLs │ │                  │
              └──────────────────────┘ └─────────────┘ └─────────────┘ └──────────────────┘
```
\* TLS is terminated by an **external load balancer** (outside this repository). The process listens on
a plain HTTP port.

**Consequences:**
- One origin for the frontend and the API → first-party cookies, no CORS, simpler authorization.
- One application Docker image; alongside it — PostgreSQL (with pgvector) and Stirling-PDF; the app's
  files live in external S3.
- Library files are mounted into the container **read-only** (`:ro`); everything Legere produces goes
  to the private S3 bucket (served via signed URLs). The server stores no files locally.
- The queue and the data live in one database: enqueueing a job and writing an entity happen in a
  single transaction.

## 2.2. Entry point `server/main.ts` (integration contract)

Details and the rationale for the ordering — in `06-backend-architecture.md` (once written):

```ts
// schematic
const server = express();
server.set('trust proxy', 1);

const nextApp = next({ dev });                    // 1) prepare Next FIRST
await nextApp.prepare();
const handle = nextApp.getRequestHandler();

const nestApp = await NestFactory.create(         // 2) Nest without a global body parser
  AppModule, new ExpressAdapter(server), { bodyParser: false });
nestApp.setGlobalPrefix('api');

server.use((req, res, forward) => {               // 3) dispatcher BEFORE nestApp.init()
  if (isApi(req.path)) return forward();
  handle(req, res).catch(forward);
});
server.use('/api', cookieParser());
server.use('/api', express.json({ limit: '1mb' }));
await nestApp.init();

server.use('/api', notFoundJson);                 // 4) unknown /api/* → JSON 404

await startQueueWorkers(nestApp);                 // 5) pg-boss: register workers
server.listen(port);
```

Key integration invariants (must not be violated):
- The `/api` prefix dispatcher is registered **before** `nestApp.init()` (otherwise Nest would
  intercept Next pages with its own 404).
- Body parsers — **only on `/api`** (global ones break Next server actions).
- An unknown `/api/*` route returns a typed JSON 404, not a Next HTML page.
- Nest does not call `listen` — it listens on the shared Express instance.
- Queue workers start after Nest initialization (they use its DI container) and before `listen`.

## 2.3. Repository layout (one package, no workspaces)

```
legere/
├── .nvmrc                       # Node 26 (exact version pinned at scaffolding time)
├── package.json                 # single, no workspaces
├── tsconfig.json
├── next.config.mjs
├── Dockerfile                   # one image (prod)
├── docker-compose.yaml          # ONLY local dependencies: PostgreSQL(+pgvector) + Stirling-PDF + MinIO (S3)
├── .env.example
├── server/
│   └── main.ts                  # bootstrap: Express + Nest(/api) + Next(*) + pg-boss workers
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── messages/                    # next-intl translation catalogs (ru.json, en.json)
├── src/
│   ├── server/                  # NestJS backend (Clean Architecture)
│   │   ├── domain/              # entities, value objects, domain services, errors, ports
│   │   ├── application/         # use cases, DTOs, infrastructure ports, job handlers
│   │   ├── infrastructure/      # Prisma, pg-boss, Stirling-PDF client, S3, fs (library), Argon2, SMTP, embeddings
│   │   ├── presentation/        # Nest controllers, modules, guards, filters, pipes
│   │   └── app.module.ts
│   ├── web/                     # frontend (FSD): screens/ widgets/ features/ entities/ shared/
│   ├── app/                     # Next App Router (routing only, thin route files)
│   └── shared/
│       └── contracts/           # isomorphic Zod schemas, enums, DTO types
└── docs/                        # this documentation (source of truth)
```

### Imports (no path aliases)
- All imports are **relative**; there is no `paths` section in tsconfig.
- `src/web/*` and `src/app/*` **must not import** `src/server/*`. Shared code — only
  `src/shared/contracts/*` (isomorphic, no node-only dependencies). Boundaries are enforced by folder
  structure and ESLint.

## 2.4. npm scripts (fixed)

| Script | What it does |
|--------|--------------|
| `npm run dev` | One process in dev mode (Nest + Next dev + workers), SWC transpilation (see ADR-017) |
| `npm run dev:up` / `dev:down` | docker compose: PostgreSQL(+pgvector) + Stirling-PDF + MinIO (S3) |
| `npm run build` | `next build` + server compilation (`tsc`) → `dist` and `.next` |
| `npm run start` | Prod start: `node dist/server/main.js` |
| `npm run typecheck` | `tsc --noEmit` (all tsconfigs) |
| `npm run lint` / `lint:fix` | ESLint + Prettier |
| `npm run test` | Vitest |
| `npm run db:migrate` / `db:migrate:dev` / `db:generate` / `db:seed` | Prisma |

## 2.5. Architecture Decision Records (ADRs)

Format: Decision / Why / Alternatives / Consequences. Change only with human approval.

### ADR-001. TypeScript, strict
All code in TS (`strict: true`); no `any`, no type assertions `as` (except `as const`), no non-null `!`.
Type safety is critical when code is written by agents; shared server/client contracts.

### ADR-002. One process/port: Express(ExpressAdapter) + NestJS + Next
- **Decision:** one Node process; Nest on `/api`, Next on everything else; a shared Express instance.
  Queue workers live in the same process.
- **Why:** operational simplicity (one container, no nginx), single-origin simplifies authorization.
- **Alternatives:** separate services + reverse proxy; a dedicated worker container — both complicate
  operations, and their benefits are unnecessary at self-hosted scale.
- **Consequences:** careful bootstrap (§2.2); heavy CPU steps are moved off the event loop
  (worker_threads or delegated to Stirling-PDF); queue concurrency is capped by config.

### ADR-003. Backend — NestJS + Clean Architecture
Domain/application are framework-free (imports of `@nestjs/*`, `@prisma/client`, `express`, `next` are
forbidden there). Nest decorators — only in infrastructure/presentation. DI — via Nest.

### ADR-004. Frontend — Next.js (App Router) + Feature-Sliced Design
Routes in `src/app` (thin), FSD layers in `src/web` (`screens → widgets → features → entities → shared`,
imports only "downward" through a slice's public API). UI — Ant Design; server state — TanStack Query.

### ADR-005. One package, npm without workspaces
The application lives and ships as a whole; isomorphic contracts are a plain folder
`src/shared/contracts`.

### ADR-006. Authentication — email+password, email verification by code, server-side sessions
- **Decision:** login via `POST /api/auth/login`; account setup requires email verification with a
  6-digit code; passwords — Argon2id; server-side sessions (httpOnly cookie, token stored as a hash).
  The first user becomes `ADMIN` (empty-instance onboarding); afterwards registration is **only via an
  admin invite link**. No JWT refresh, no external OAuth providers. Details —
  [`08`](./08-auth-and-authorization.md).
- **Why:** the requirement is in-house auth with an email code; full control over accounts; one process
  simplifies sessions. Closed registration — the instance is private (family/team).
- **Alternatives:** OAuth (external dependency), passport/Auth.js (bring their own session mechanics,
  fit Clean Architecture poorly), open registration (unnecessary for a private instance).
- **Consequences:** ports `PasswordHasher`/`EmailSender`/`SessionService`/`CaptchaVerifier`; tables
  `EmailVerification`/`UserInvite`; fail-closed CSRF; rate limiting.

### ADR-007. External library — read-only volume, scheduled scanning
- **Decision:** libraries are mounted into the container **read-only** (`:ro`); Legere discovers
  content via a **periodic scan** (a queue job, pg-boss cron) plus a manual "Scan now" trigger in the
  admin panel. No file watcher in the MVP.
- **Why:** the untouchable-sources principle (the Immich external library model); watchers are
  unreliable on network filesystems (NFS/SMB), while periodic scanning covers all cases
  deterministically.
- **Alternatives:** a chokidar watcher (may be added later as an accelerator, not a replacement for
  scanning).
- **Consequences:** changes become visible with a delay up to the scan interval (configurable, default
  15 min); the scan is incremental — a fast pass over path+size+mtime, full hashing only for
  new/changed files.

### ADR-008. Job queue — pg-boss (PostgreSQL), workers in the same process
- **Decision:** the processing queue is **pg-boss** on top of the same PostgreSQL; workers are
  registered in the main process; concurrency and retries are per job type.
- **Why:** large file batches need a reliable queue; pg-boss adds no infrastructure (Postgres is
  already there), provides transactional consistency of "write entity + enqueue job", retries, cron,
  priorities.
- **Alternatives:** BullMQ (drags in Redis — an extra service), in-memory (loses jobs on restart).
- **Consequences:** job handlers must be **idempotent** (see
  [`05 §5.4`](./05-library-and-processing.md)); job statuses are visible in the admin panel; workers
  can later be scaled horizontally with a second instance of the image without architectural changes.

### ADR-009. Deduplication — SHA-256 of content
- **Decision:** content identity = SHA-256 equality. One hash → one `Document`; all files with that
  hash are references (`FileRef`) to it. Processing (preview/md/vectors) runs once per document.
- **Why:** the deduplication requirement; scans and archives often contain copies; saves processing and
  storage.
- **Alternatives:** perceptual hashes for "similar" images — not an MVP task (dedup is exact only).
- **Consequences:** hashing is the mandatory first pipeline step; the files table is separate from the
  documents table (model details — in 03).

### ADR-010. Derived artifacts — S3 (private bucket), `FileStorage` port
- **Decision:** everything the system produces (previews, Markdown representations, canonical/merged
  PDFs) is stored in **S3-compatible storage** (AWS SDK v3, custom endpoint); the bucket is
  **private**; client viewing and downloading — short-lived **presigned GET URLs**, issued only after
  an access check. Code access — only through the `FileStorage` port. Library sources are not copied
  to S3 — the app streams them from the read-only volume.
- **Why:** a deliberate **difference from Immich** — Legere keeps no files locally: the server is
  stateless with respect to files (the library volume is read-only, everything produced goes to S3),
  only the DB and the bucket need backups, private objects are served safely via signed links.
- **Alternatives:** a local `/media` volume (the Immich model) — rejected: state on the server disk,
  harder backups and instance migration.
- **Consequences:** S3 is a mandatory deployment dependency
  (`S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET`); local dev — MinIO in docker-compose; artifact
  writes go through the server; S3 unavailability → jobs retry; bucket size is an admin-panel metric.

### ADR-011. Vectorization — pgvector in the same PostgreSQL; embedding provider behind a port
- **Decision:** embeddings of Markdown chunks are stored in the **pgvector** extension of the same DB;
  semantic search is a SQL query (cosine); hybrid with PostgreSQL FTS. Embedding retrieval is behind an
  `EmbeddingProvider` port; the implementation is a configurable OpenAI-compatible HTTP API (cloud or
  local Ollama/vLLM — set via env).
- **Why:** "normalized PostgreSQL" is a requirement; a dedicated vector store (Qdrant/Weaviate) is an
  extra service for self-hosted; the OpenAI-compatible interface covers the most providers with one
  piece of code.
- **Alternatives:** a dedicated vector DB (the scale does not require it); embedding a local model in
  the process (heavy, breaks "one lightweight image").
- **Consequences:** the local dev DB image ships with pgvector; the default provider choice is an open
  question ([`01 §1.7`](./01-vision-and-scope.md#17-open-questions)); without a configured provider the
  pipeline degrades gracefully (everything works except semantic search).

### ADR-012. PDF tooling — external Stirling-PDF
- **Decision:** all operations on binary formats are delegated to the sibling **Stirling-PDF**
  container over an internal HTTP API: office-to-PDF conversion, OCR (tesseract), PDF→JPG (previews),
  merging images into a PDF. In code — a `PdfToolbox` port with a client implementation. (Scan-set
  margin trimming happens per image via `sharp` before assembly — [`05 §5.6`](./05-library-and-processing.md#56-scan-sets-merging-into-a-pdf-on-explicit-request).)
- **Why:** the requirement ("the PDF tool lives outside"); LibreOffice/tesseract inside the app image
  would bloat it by gigabytes.
- **Alternatives:** built-in conversion libraries — rejected; narrow Node libraries (PDF text-layer
  extraction, sharp for images) are acceptable for light operations that don't need Stirling.
- **Consequences:** Stirling-PDF is a mandatory deployment dependency (internal network, not exposed);
  Stirling unavailability → jobs retry, the service keeps working (viewing/search unaffected).

### ADR-013. CI — a single Docker image to GHCR; deployment outside the repository
- **Decision:** GitHub Actions: on every PR — `typecheck` + `lint` + `test` + `build` (with a
  PostgreSQL+pgvector service); on `main`/tag — build of a **single** image `ghcr.io/<owner>/legere`.
  No deploy job; doc 12 contains only a demonstration compose example.
- **Why:** operations are separated from the repository; secrets live only in GitHub Secrets.
- **Consequences:** migrations are applied automatically on container start; S3 and external services
  are mocked in CI tests behind ports (`FileStorage`/`PdfToolbox`/`EmailSender`).

### ADR-014. Pull-request-based development
- **Decision:** direct pushes to `main` are forbidden (branch protection); every change goes branch
  (`feat/*`, `fix/*`, `docs/*`) → PR → green CI → merge. Conventional Commits.
- **Why:** change discipline and a mandatory CI check before anything lands on `main`.
- **Consequences:** required status check `CI / build-and-test`; PRs reference a backlog task.

### ADR-015. Soft delete
No physical deletion of user data — a `deletedAt` field, partial unique indexes
`WHERE deleted_at IS NULL`. A file disappearing from the library is an unavailability status, not a
deletion (see [`05 §5.7`](./05-library-and-processing.md)).

### ADR-016. i18n — next-intl, locale not in the URL
Language is a user setting (in the DB, a cookie for SSR), not a URL segment. UI languages: **en
(default)** and **ru**; `messages/en.json` is the reference catalog. The backend does not localize
texts — it returns machine `code`s; the client assembles human-readable text.

### ADR-017. Dev/test transpilation — SWC (for decorator metadata)
- **Decision:** in dev and tests TypeScript is transpiled by **SWC** (`@swc-node/register` for the dev
  runner, `unplugin-swc` for Vitest) with `decoratorMetadata` enabled; the production backend build is
  `tsc`; the client is built by Next.
- **Why:** Nest DI resolves dependencies via `design:paramtypes` (`emitDecoratorMetadata`). esbuild —
  which powers `tsx` and Vitest's default transformer — does **not** emit decorator metadata: DI would
  fail both in dev and in tests.
- **Alternatives:** `tsx`/esbuild (breaks Nest DI), `ts-node` (slower, fits ESM Next worse).
- **Consequences:** `.swcrc` in the repository; Vitest — two projects (`server`: node + SWC plugin;
  `web`: jsdom + testing-library); a DI spike under the dev runner is an early backlog task.

## 2.6. Data flow (typical scenario: a new file in the library)

1. A **cron scan** (pg-boss) or the "Scan now" button enqueues a `library-scan` job.
2. **library-scan:** walks the volume, compares path+size+mtime with the DB; for new/changed files
   creates a `FileRef` (status `DISCOVERED`) and enqueues `file-ingest`.
3. **file-ingest:** computes SHA-256 → finds/creates a `Document` (dedup); for a new document enqueues
   the `document-process` chain.
4. **document-process:** canonicalization to PDF (Stirling when needed) → first-page JPG preview →
   Markdown extraction (text layer or OCR) → categorization → chunking + embeddings into pgvector.
   Each step's artifacts are saved to S3; each step's status is recorded on the document — progress is
   visible in the admin panel.
5. **web:** the user sees the document in the list (preview), opens the viewer, searches by text and by
   meaning. TanStack Query fetches data from `/api`; authorization — session + library visibility.

The chain is identical for all documents; only the per-format steps differ (an image needs no
text-layer extraction — it goes straight to OCR; plain text needs no canonicalization for reading, and
so on, see [`05 §5.5`](./05-library-and-processing.md)).
