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
if (TRUST_PROXY !== '') server.set('trust proxy', TRUST_PROXY);   // off unless configured (12 §12.8)

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
  merging images into a PDF. Reading a PDF *into text* is no longer one of them — that is ADR-018. In code — a `PdfToolbox` port with a client implementation. (Scan-set
  per-file cropping happens via `sharp` before assembly — [`05 §5.6`](./05-library-and-processing.md#56-composing-a-document-out-of-files).)
- **Why:** the requirement ("the PDF tool lives outside"); LibreOffice/tesseract inside the app image
  would bloat it by gigabytes.
- **Alternatives:** built-in conversion libraries — rejected; narrow Node libraries (PDF text-layer
  extraction, sharp for images) are acceptable for light operations that don't need Stirling.
- **Consequences:** Stirling-PDF is a mandatory deployment dependency (internal network, not exposed);
  Stirling unavailability → jobs retry, the service keeps working (viewing/search unaffected).

### ADR-018. Parsing — Docling, with Stirling as the fallback
- **Decision:** a PDF becomes Markdown through **Docling** (`docling-serve`, `POST /v1/convert/file`)
  behind a `DocumentParser` port. `DOCLING_URL` empty falls back to Stirling's own converter, which
  keeps a Docling-less deployment working.
- **Why:** Stirling's converter reads text and loses the document. Measured on real files: a table
  came back as one paragraph per row with the columns run together, and a layout table used purely
  for positioning became a Markdown table of nonsense. Docling was built for exactly this — it has a
  layout model, so a heading stays a heading and a table stays a table, which is what makes the
  stored Markdown worth reading and worth chunking for search.
- **Details that were not optional:** `pdf_backend=pypdfium2`, because the default backend splits
  diacritics into separate glyph runs ("li č ne" for "lične"), breaking the word for search as much
  as for reading; and `ocr_preset=tesseract` with explicit `ocr_lang`, because the default engine has
  no Cyrillic model and, asked for Russian, silently falls back to its Chinese model set and returns
  confident-looking nonsense. The image is built from `deploy/docling/Dockerfile` with tessdata for
  the languages a document archive actually meets. **Stirling is built from
  `deploy/stirling/Dockerfile` for the same reason and with the same list:** it runs the OCR of the
  fallback path and of every image, its stock image carries `chi_sim deu eng fra osd por`, and asked
  for a language it does not have it recognises nothing at all — the step fails on "none of the
  selected languages are valid" rather than reading what it can.
- **Alternatives:** pdfjs in-process — dropped, it extracts text spans and has no idea what a table
  is; Stirling only — the measurement above; Docling with no fallback — rejected, the container is
  several gigabytes and an instance should be able to run without it.
- **Consequences:** one more optional container. OCR still runs in Stirling on the fallback path;
  on the Docling path Docling does it, given the document's own languages
  ([`03 §3.3.10`](./03-domain-model.md)). Picture captioning is available and off — see
  [`12 §12.4`](./12-build-config-run.md) for the measured cost.

### ADR-019. The recogniser of last resort — a vision model over the pages
- **Decision:** a document that had to be *recognised* — `ocrUsed`, which is the photographed and
  scanned case — has its pages sent as images to a vision model behind a `PageTranscriber` port, and
  that transcription becomes the Markdown. A document that arrived carrying its own text layer is
  untouched. `TRANSCRIBER_API_BASE_URL` empty leaves the OCR result standing, so an instance may run
  without this exactly as before it existed.
- **Why:** measured, on one real photograph of a lab report — 665 characters are legible on the page
  and 415 reached the database, and the quarter that vanished was the results table, the only reason
  that document exists. It is neither the page geometry nor the text-layer threshold: the same loss
  reproduces on the raw photograph with no page around it, while cropping to the table alone reads it
  correctly. Uneven light and bold text pressed against thin cell rules defeat a global binariser and
  the layout pass behind it, and no amount of tuning lifts that floor. On the same page a vision
  model returned nine rows of nine and eleven values of eleven, over twenty-two runs, with no wrong
  value in any of them.
- **Alternatives:** better preprocessing alone (ADR taken *as well* — see `05 §5.5` step 1 — but it
  moves 643 characters to 768, not to the whole page); region segmentation and per-region OCR —
  more machinery for a worse result than a model that reads the page; replacing tesseract outright —
  rejected, the cheap path is free, perfect on born-digital text, and the only path an instance with
  no AI has.
- **Consequences:** a second optional AI provider, configured separately from the analyst because an
  instance may want a different model for reading a page than for judging one. 🔒 Three failures were
  measured before this was trusted and each is refused rather than believed: an answer that ran out
  of room reads exactly like a finished one and is caught by `finish_reason`; a collapse to four
  tokens is caught by refusing any transcription shorter than what OCR already had; and a
  hallucinated Markdown image pointing at a temporary file **on the provider's own disk** appeared in
  four runs of seven *despite the prompt forbidding it*, so those lines are stripped in code — an
  instruction a model ignores is not a control.

### ADR-021. A file is not a document

**Context.** Until v0.4 a document *was* a file: one content hash, one mime type, one size, one set
of bytes. Everything that did not fit — forty photographs of one passport — was pushed into a
separate concept (scan sets) that produced a second document out of the first forty, and the
canonical PDF existed only for office formats, because only they needed converting.

**Decision.** Split the two. A **file** is bytes with a hash, a name and one home. A **document** is
an ordered list of files plus one **canonical PDF built from them, for every document, always**. The
viewer shows the canonical, Download hands over the canonical, every pipeline step reads the
canonical; the originals stay untouched and downloadable one at a time. Composition is editable —
add, combine, split, reorder, crop — and every change rebuilds the canonical.

**Consequences.** Deduplication moves from documents to files (ADR-009 still holds, one level down).
Scan sets disappear: "these are one document" is now a property of a document rather than a machine
for making a new one. Every document gains a text layer and a uniform preview, including images and
plain text, which is what makes search and OCR one code path instead of four. The price is that a
composition change re-runs the whole pipeline for that document — paid in the background, and the
old artifacts keep serving until the new ones land.

### ADR-022. Typed fields — a schema per document type, shipped as data in code

- **Decision:** a document type may carry a **field schema** — the typed facts a paper of that kind
  states: a receipt names a vendor, a total and a day; a passport a holder, a number and an expiry.
  Schemas are **data, not code paths**: a versioned registry in `src/shared/contracts`, keyed by the
  type's slug, shipped with the release and read by the server and the client alike. A sixth
  pipeline step — `fields` ([`05 §5.5`](./05-library-and-processing.md#55-document-processing-pipeline-document-process))
  — asks the classifier provider to fill the schema and stores the answer on the document
  ([`03 §3.3.10a`](./03-domain-model.md)) with a per-field record of who decided; searchable values
  join the FTS index ([`04 §4.3`](./04-database-schema.md#43-raw-sql-in-migrations-required-steps)).
  The first schemas: `receipt`, `passport`, `id-card`.
- **Why:** a photograph of a till receipt is typed JSON waiting to be read, and the pipeline already
  reads everything else about it. Keeping the schema as data keeps **one pipeline**: the trunk
  (canonical → preview → text → vectors) stays identical for every document — which is what ADR-021
  bought — and the one type-dependent thing is a parameter of one step, never a branch in six.
- **Alternatives:** a pipeline per document type — rejected: N half-tested pipelines and the end of
  "by step 2 every document is a PDF". Admin-authored schemas in the DB — **deferred, not refused**:
  an editor for field schemas is a form builder, and the registry is shaped so its rows can move
  into a table without the stored values changing shape — the answer on a document already names the
  schema slug and version it speaks. A separate receipts service — rejected: the archive is one
  product and one search, and what specialisation needs is a provider behind a port (the
  Stirling/Docling/vision pattern of ADR-012/018/019), never a second product.
- **Consequences:** a sixth step-status column and a `NO_SCHEMA` skip reason; the `extracted` JSON of
  `03 §3.3.10a`; the FTS column rebuilt to carry the searchable values; a manual type change
  re-runs the step under the new schema ([`07 §7.3`](./07-api-specification.md#73-endpoints)).
  Schemas version forward: a bumped version is re-read on the next run, and a stored answer always
  says which version wrote it.

### ADR-023. Document links — undirected, untyped, person-confirmed

- **Decision:** two documents can be **linked**: an undirected, untyped edge
  ([`03 §3.3.23`](./03-domain-model.md)), created by a person and deleted by a person. The pipeline
  **suggests** candidates — from identifiers the documents visibly share
  ([`05 §5.6b`](./05-library-and-processing.md#56b-noticing-that-documents-cite-each-other)) — and
  never creates one.
- **Why:** the papers of one matter arrive as separate documents and stay that way: an act is not a
  page of its contract (ADR-021 keeps "one paper, one document"), and a receipt has a type and
  fields of its own. What is missing is the connective tissue between them, and the smallest honest
  edge is an undirected one.
- **Alternatives:** typed links (fulfils / pays-for / annex-of) — deferred exactly as person roles
  were (`03 §3.3.19`): the vocabulary is real and not yet knowable, and a half-guessed one is worse
  than none. Auto-created links — rejected: `05 §5.6a`'s rule stands — a machine proposes, a person
  confirms — because an edge is a claim about both of its ends. Collections as the only grouping —
  kept, but a collection answers "my shelf", not "this paper answers that one".
- **Consequences:** a `document_links` table — pair-unique, hard-deleted like a collection item,
  cascading with a hard-deleted document; three endpoints and a suggestions endpoint (`07 §7.3`); a
  tab of its own in the viewer (`11 §11.5e`); a link is visible only where **both** ends are
  (`03 §3.4`).

### ADR-024. MCP — the archive as a tool set, spoken by hand

- **Decision:** the instance serves the **Model Context Protocol** at a single route,
  `POST /api/mcp` ([`07 §7.3a`](./07-api-specification.md)), so an assistant somebody already talks
  to — Claude, an agent of their own, whatever comes next — can search this archive and read what it
  finds. The protocol is implemented **in this repository, by hand**: JSON-RPC 2.0 over one POST,
  four methods (`initialize`, `ping`, `tools/list`, `tools/call`), three read-only tools, JSON
  responses and no session state.
- **Why:** what people want from their documents is a conversation, and the honest way to give them
  one is not to grow a chat product inside a document manager — it is to let the model they already
  use reach the archive. The credential for exactly that already exists and already says what it
  allows: a read-only API token that inherits its owner's access
  ([`08 §8.2a`](./08-auth-and-authorization.md)), whose own documentation names "an assistant
  answering questions about what is filed here" as the case it was built for. Nothing about the
  retrieval is new either: the tools are the hybrid search and the document reads this API already
  serves.
- **Alternatives:** the official SDK and its Streamable HTTP transport — rejected for now: it wants
  to own the request and the response, it brings sessions, SSE and resumability this route does not
  use, and the part actually needed is a JSON-RPC dispatcher over four methods. A chat screen inside
  Legere (retrieval, context assembly, streaming, citations, and prompt injection from documents the
  archive did not write) — deferred: it is a second product, and this is the cheapest way to find out
  whether the retrieval is good enough to build one. A separate process — rejected: one process is
  ADR-002, and a second one would need this one's database and its access rules.
- **Consequences:** 🔒 one route where a POST carries a bearer token, which the origin check, the
  read-only middleware and the session guard all have to know about — declared once and consulted by
  all three ([`08 §8.2a`](./08-auth-and-authorization.md)). On that route **a cookie authenticates
  nothing**, which is what makes the exception to the CSRF rule safe rather than trusted: a browser
  cannot be tricked into a call it has no credential for. The tools are a closed list over read use
  cases, so "read-only" is a property of the registry and not a promise about future routes.

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

**Amended: an admin deleting a document is a real deletion** ([`03 §3.3.10`](./03-domain-model.md)).
Everything else here stands — this is one exception, made deliberately, for the one row a person
points at and says "this should not be here". Soft delete answers the question it was chosen for,
which is "can a mistake be undone"; it cannot answer the two this case asks. **Space is one:** an
archive of scans is measured in gigabytes, and a delete that frees nothing is a delete that leaves an
instance with no way to get smaller. **A deliberate absence is the other:** a document deleted for
being junk, a duplicate or somebody's private paper is not meant to sit in the database being
excluded from every query for ever, waiting for the query that forgets to. The undo is on the other
side of it — a `LIBRARY` file's bytes are on a volume Legere may not write to and are still there
afterwards ([`03 §3.3.9`](./03-domain-model.md)) — and the UI says exactly what will and will not
survive before it happens ([`11 §11.5`](./11-ui-ux-spec.md)). A document *absorbed* into another is
not this case and keeps its soft delete.

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
   Markdown extraction (text layer or OCR) → analysis → chunking + embeddings into pgvector.
   Each step's artifacts are saved to S3; each step's status is recorded on the document — progress is
   visible in the admin panel.
5. **web:** the user sees the document in the list (preview), opens the viewer, searches by text and by
   meaning. TanStack Query fetches data from `/api`; authorization — session + library visibility.

The chain is identical for all documents; only the per-format steps differ (an image needs no
text-layer extraction — it goes straight to OCR; plain text needs no canonicalization for reading, and
so on, see [`05 §5.5`](./05-library-and-processing.md)).
