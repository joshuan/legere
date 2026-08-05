# 06. Backend Architecture

NestJS on `/api` with Clean Architecture inside; pg-boss workers in the same process. This document
fixes the layer rules, the port catalog, the module/use-case inventory, error handling, configuration,
and the exact Next.js integration contract.

## 6.1. Layers and the dependency rule

```
src/server/
├── domain/          # entities, value objects, domain services, domain errors, repository ports
├── application/     # use cases, application ports, job handlers, DTO mapping
├── infrastructure/  # Prisma, pg-boss, S3, fs, Stirling client, Argon2, SMTP, embeddings, Nest providers
├── presentation/    # Nest controllers, modules, guards, filters, pipes, cookie helpers
└── app.module.ts
```

Dependencies point inward only: `presentation → application → domain`;
`infrastructure → application → domain`.

- `domain/` and `application/` are **framework-free**: imports of `@nestjs/*`, `@prisma/client`,
  `express`, `next`, `pg-boss`, `@aws-sdk/*` are forbidden there (ESLint-enforced, see 14). Pure
  TypeScript classes and functions.
- Nest decorators, DI wiring, controllers, guards, filters, pipes — only in `infrastructure/` and
  `presentation/`.
- DI is done with Nest custom providers binding **abstract classes** (ports) to implementations:
  `{ provide: DocumentRepository, useClass: PrismaDocumentRepository }`. Ports are declared as
  `abstract class` (not `interface`) so they can serve as runtime DI tokens without string tokens.

## 6.2. Domain layer

- **Entities** are plain classes/types mirroring [`03`](./03-domain-model.md) (e.g. `Document`,
  `FileRef`, `File`, `Library`) with behavior where it belongs:
  `document.availability(fileRefs, libraries)`, `scanSet.canEditItems()`,
  `fileRef.needsRehash(size, mtime)`.
- **Value objects:** `RelativePath` (normalized, traversal-safe — the only way to represent a library
  path in the domain), `ContentHash` (sha256 hex, lower-case), `EmailAddress` (normalized).
- **Domain errors:** a sealed hierarchy `DomainError { code, httpStatus, details? }` — e.g.
  `NotFoundError('DOCUMENT_NOT_FOUND')`, `ForbiddenError`, `LastAdminError`,
  `LibraryPathConflictError`, `DocumentLastFileError`. The full code list — [`07 §7.2`](./07-api-specification.md#72-error-codes).
- **Repository ports** (abstract classes) — one per aggregate: `UserRepository`, `SessionRepository`,
  `EmailVerificationRepository`, `UserInviteRepository`, `PasswordResetRepository`,
  `LibraryRepository`, `FileRefRepository`, `ScanRunRepository`, `DocumentRepository`,
  `DocumentChunkRepository`, `DocumentTypeRepository`, `CollectionRepository`, `FileRepository`.
  Repositories accept/return domain entities, never Prisma types.

## 6.3. Application layer

### 6.3.1. Use cases
One class per operation, constructor-injected ports, a single `execute(input): Promise<output>`.
Inputs are already validated (Zod at the presentation boundary); use cases re-check **business** rules
only. Inventory (module → use cases):

| Module | Use cases |
|--------|-----------|
| auth | `GetOnboardingStatus`, `StartRegistration`, `VerifyEmailCode`, `CompleteRegistration`, `Login`, `Logout`, `PreviewInvite`, `PreviewPasswordReset`, `CompletePasswordReset` |
| users | `GetMe`, `UpdateMe`, `ListUsers`ᴬ, `ChangeUserRole`ᴬ, `DeactivateUser`ᴬ, `ReactivateUser`ᴬ, `RevokeUserSessions`ᴬ, `CreateInvite`ᴬ, `ListInvites`ᴬ, `RevokeInvite`ᴬ, `CreatePasswordReset`ᴬ |
| libraries | `CreateLibrary`ᴬ, `UpdateLibrary`ᴬ, `DeleteLibrary`ᴬ, `ListLibrariesAdmin`ᴬ, `ListVisibleLibraries`, `TriggerScan`ᴬ, `ListScanRuns`ᴬ, `BrowseLibrary`, `ListLibraryPathCandidates`ᴬ |
| documents | `ListDocuments`, `GetDocument`, `UpdateDocumentMeta`, `SoftDeleteDocument`ᴬ, `ReprocessDocument`ᴬ, `GetDocumentMarkdown`, `OpenSourceStream`, `GetArtifactUrl` |
| search | `SearchDocuments` |
| document types | `ListCategories`, `CreateCategory`ᴬ, `UpdateCategory`ᴬ, `DeleteCategory`ᴬ |
| collections | `CreateCollection`, `ListMyCollections`, `GetCollection`, `UpdateCollection`, `DeleteCollection`, `AddCollectionItem`, `RemoveCollectionItem`, `ShareCollection`, `RevokeCollectionShare`, `ListCollectionShares` |
| document files | `AddFileToDocument`, `ReorderDocumentFiles`, `SetFileCrop`, `SuggestFileCrop`, `SplitFileIntoDocument`, `CombineDocuments`, `SuggestDocumentGroups`, `DownloadFile` |
| queue-admin | `GetQueueOverview`ᴬ, `ListFailedJobs`ᴬ, `RetryFailedJob`ᴬ |
| health | `CheckHealth` |

ᴬ = admin-only (enforced by `RolesGuard` at presentation + asserted in the use case).

### 6.3.2. Job handlers
Job handlers live in `application/jobs/` and are use cases with the signature
`handle(payload): Promise<void>`; the queue adapter calls them:

| Handler | Payload | Behavior (authoritative logic in [`05`](./05-library-and-processing.md)) |
|---------|---------|--------------------------------------------------------------------------|
| `HandleLibraryScan` | `{ libraryId, scanRunId? }` | walk, diff, create/update FileRefs, enqueue `file-ingest`, write ScanRun |
| `HandleFileIngest` | `{ fileRefId }` | hash stream, attach/create Document, enqueue `document-process` for new documents |
| `HandleDocumentProcess` | `{ documentId, steps?: string[] }` | run steps 1–5 sequentially; `steps` limits re-processing to a subset |
| `HandleMaintenance` (also re-enqueues documents stuck at PENDING, 05 §5.4) | `{}` | purge expired EmailVerifications/invites/resets; delete S3 artifacts of documents soft-deleted > 30 days ago is **not** done (retention: keep); compact nothing else |

Every handler starts with an idempotency check ("already done? → return") and must tolerate
re-delivery (pg-boss is at-least-once).

### 6.3.3. Application ports (non-repository)

| Port | Methods (shape) | Implementation (infrastructure) |
|------|-----------------|--------------------------------|
| `Clock` | `now(): Date` | `SystemClock` |
| `PasswordHasher` | `hash(pw)`, `verify(hash, pw)` | `Argon2PasswordHasher` |
| `EmailSender` | `send({to, subject, text})` | `SmtpEmailSender` (nodemailer) / `LogEmailSender` (dev fallback) |
| `CaptchaVerifier` | `verify(token, ip): Promise<boolean>` | `TurnstileCaptchaVerifier` / no-op when keys unset |
| `SessionTokens` | `generate(): {token, hash}`, `hash(token)` | `CryptoSessionTokens` |
| `FileStorage` | `put(key, body, contentType)`, `getSignedUrl(key, ttlSec)`, `exists(key)`, `delete(key)` | `S3FileStorage` (AWS SDK v3) |
| `LibraryReader` | `stat(lib, relPath)`, `list(lib, relPath)`, `openStream(lib, relPath)`, `walk(lib): AsyncIterable<FsEntry>` | `FsLibraryReader` (validates every path against the library root; follows no symlinks — `lstat`, skip links) |
| `PdfToolbox` | `officeToPdf({body, fileName})`, `pdfFirstPageJpg(source, {dpi?})`, `ocrPdf(source, langs)`, `imagesToPdf([{body, fileName}])`, `pdfPageCount(source)`, `pdfToMarkdown(source)` — a source is a stream or a buffer; the file name travels with office/image input because the converter picks its filter from the extension | `StirlingPdfToolbox` (HTTP client, `STIRLING_URL`) |
| `ImageTool` | `toJpegPreview(stream, {maxDim})`, `trim(stream, threshold)` | `SharpImageTool` |
| `EmbeddingProvider` | `embed(texts[]): number[][]`, `isConfigured` | `OpenAiCompatEmbeddings` (fetch, `EMBEDDINGS_*` env) |
| `DocumentAnalyst` | `analyze(markdownExcerpt, document types[]): { typeSlug, languages, country, city }`, `isConfigured` | `OpenAiCompatAnalyst` (chat-completions JSON answer) |
| `JobQueue` | `enqueue(name, payload, opts?)`, `enqueueAfterTx(...)`, `scheduleCron(name, cron)` | `PgBossJobQueue` |
| `QueueMonitor` | `overview()`, `failedJobs(cursor)`, `retry(jobId)` | `PgBossQueueMonitor` (raw SQL over the `pgboss` schema) |
| `UnitOfWork` | `run<T>(fn: (tx) => Promise<T>)` | `PrismaUnitOfWork` (`$transaction`; repositories accept the tx handle) |
| `MimeDetector` | `detect(streamHead): {mime, ext}` | `FileTypeMimeDetector` (`file-type` package; fallback to extension for text) |

### 6.3.4. Transactions
`UnitOfWork.run` wraps every multi-write use case. Job enqueueing inside a transaction uses
`JobQueue.enqueueAfterTx`, implemented via pg-boss's `send` executed on the same Postgres connection
as the transaction (pg-boss supports passing a client/`db` option) — entity write + job insert commit
atomically.

## 6.4. Presentation layer

- **Controllers** are thin: parse/validate (Zod pipe) → call the use case → map the result to a DTO.
  No business logic, no Prisma.
- **Guards** (execution order): `SessionGuard` (the `sid` cookie, or an `Authorization: Bearer` API
  token on a safe method — [`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)) →
  `RolesGuard` (`@Roles('ADMIN')` routes) →
  `DocumentAccessGuard` / `CollectionAccessGuard` (resolve the resource by path
  param, run the 03 §3.4 checks, attach the loaded resource to the request via `@CurrentDocument()`
  etc. so use cases don't re-fetch).
- **Pipes:** a global `ZodValidationPipe` that looks up the Zod schema declared per-route
  (`@ZodBody(schema)`, `@ZodQuery(schema)` custom decorators) and returns `422 VALIDATION_FAILED`
  with flattened issues in `details`.
- **Filters:** a global `DomainExceptionFilter` mapping `DomainError → { status, body }` per
  [`07 §7.1`](./07-api-specification.md#71-conventions); unknown errors → `500 INTERNAL` (logged with
  stack, response body carries no internals).
- **Rate limiting:** `@nestjs/throttler` per-IP on `/api/auth/*` and `/api/invites/*`; per-email
  limits live inside the auth use cases (they read `EmailVerification`/login-failure state).
- **CSRF:** an Express-level middleware on `/api` for mutating methods — fail-closed
  `Origin`/`Referer` check against `APP_BASE_URL` (see [`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)).
- **Read-only bearer:** a second middleware beside it, also on `/api` and also for mutating methods:
  an `Authorization: Bearer` header there is refused with `READ_ONLY_TOKEN` before routing
  ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)).
- **Cookie helpers:** `setSessionCookie(res, token)` / `clearSessionCookie(res)` in one module;
  attributes per [`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions).

## 6.5. Nest modules (DI wiring)

`AppModule` imports: `ConfigModule` (global), `LoggerModule` (nestjs-pino), `ThrottlerModule`,
`PersistenceModule` (Prisma client + repositories + UnitOfWork), `StorageModule` (FileStorage,
LibraryReader), `PdfModule` (PdfToolbox, ImageTool), `AiModule` (EmbeddingProvider,
DocumentAnalyst), `QueueModule` (JobQueue, QueueMonitor, worker bootstrap), and the feature
modules: `AuthModule`, `UsersModule`, `LibrariesModule`, `DocumentsModule`, `SearchModule`,
`DocumentTypesModule`, `CollectionsModule`, `QueueAdminModule`, `HealthModule`.

## 6.6. Configuration

All env is parsed **once** at bootstrap with a Zod schema (`src/server/infrastructure/config`):
invalid/missing required vars → process exits with a readable message. The full variable list —
[`12 §12.4`](./12-build-config-run.md#124-envexample). Config is exposed to DI as a typed
`AppConfig` provider; `process.env` is read nowhere else.

## 6.7. Logging

`nestjs-pino` (pino, JSON to stdout; pretty in dev). Every request gets a `requestId` (uuid) —
propagated into job payloads it triggers (`meta.requestId`) for traceability. **Never logged:**
passwords, tokens, codes, session ids, email bodies, signed URLs. Job handlers log
`{ job, payload-ids, durationMs, outcome }`.

## 6.8. Queue integration (pg-boss)

- One `PgBoss` instance per process, started in bootstrap step 5 (§2.2) with `schema: 'pgboss'` on
  `DATABASE_URL`.
- Worker registration maps queue names to application handlers with per-queue concurrency from config
  (defaults in [`05 §5.4`](./05-library-and-processing.md#54-job-queue-pg-boss)); handlers are
  resolved from the Nest DI container (`app.get(HandleFileIngest)`).
- Retry policy per queue: `retryLimit: 5`, `retryBackoff: true` (exponential).
  `library-scan` uses a **singleton key** = libraryId (pg-boss `singletonKey`) so one scan per library
  runs at a time; `document-process` uses singletonKey = documentId.
- **`expireInSeconds` is per queue**, and it is a recovery time rather than a work timeout: it is how
  long a job stays `active` after its worker disappeared — a crash, a deploy, a dev restart — before
  pg-boss gives it to someone else. Under the `stately` policy an abandoned job keeps its singleton
  slot, so this interval is exactly how long a library stays unscannable (and its ScanRun stuck at
  RUNNING) after a restart mid-scan. Values: `library-scan` 15 min, `file-ingest` 10 min,
  `document-process` 60 min (assembly, conversion and OCR), `maintenance` 15 min —
  generous multiples of the real work, safe because every handler is idempotent
  ([`05 §5.4`](./05-library-and-processing.md#54-job-queue-pg-boss)).
- Cron: on start, the app (re)registers pg-boss schedules — per-library scans (`*/N` from
  `scanIntervalMinutes`; re-registered whenever a library is created/updated) and `maintenance`
  (hourly).
- Graceful shutdown: SIGTERM → stop accepting HTTP, `boss.stop({ graceful: true })` waits for active
  jobs (max 30 s), then exit.

## 6.9. Next.js integration in one process (normative)

The bootstrap contract is fixed in [`02 §2.2`](./02-architecture-overview.md#22-entry-point-servermaints).
Additional normative details:

1. `next({ dev })` is prepared **before** Nest is created; its request handler is captured once.
2. Nest is created with `{ bodyParser: false }`; `express.json({ limit: '1mb' })`,
   `express.urlencoded({ extended: true })`, and `cookie-parser` are mounted **only under `/api`**.
3. The dispatcher middleware (`isApi(req.path)` → Nest chain, else Next handler) is registered
   **before** `nestApp.init()`.
4. After `init()`, a terminal `/api` middleware returns
   `404 { error: { code: 'NOT_FOUND', message: 'Unknown API route', details: null } }`.
5. `server.set('trust proxy', 1)` — the app always runs behind a TLS-terminating proxy in prod.
6. Multipart is not used (no user uploads); no multer.
7. Dev runner: `nodemon` watches `server/`, `src/server/`, `src/shared/` and re-executes
   `node server/dev.mjs`, which registers the SWC ESM loader (decorator metadata, ADR-017) and runs
   the same bootstrap with `dev: true` (Next HMR handles the client side).

## 6.10. Health

`GET /api/health` → `200 { data: { status: 'ok', db: 'ok', queue: 'ok' } }`; DB checked with
`SELECT 1`, queue with a pg-boss state read. Any check failing → `503` with the failing component.
Used as the container liveness/readiness probe. S3 and Stirling are **not** part of health (their
outage must not restart the app).

## 6.11. Open questions

None.
