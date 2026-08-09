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

`nestjs-pino` (pino, JSON to stdout; pretty in development only — a transport is a worker thread,
and a test asserting what the process did *not* emit has to be able to read what it did). Every
request gets a `requestId` (uuid) — propagated into job payloads it triggers (`meta.requestId`) for
traceability. **Never logged:** passwords, tokens, codes, session ids, email bodies, signed URLs.
Job handlers log `{ job, payload-ids, durationMs, outcome }`.

🔒 **A request line says the route, not the request.** `pino-http` logs the URL of everything it
serves, and two links this product hands out carry a bearer credential in a path segment
([`08 §8.1.2`](./08-auth-and-authorization.md#812-admin-invite),
[`08 §8.1.6`](./08-auth-and-authorization.md#816-password-reset-admin-initiated)). The `req`
serializer therefore rewrites the URL into the shape of its route before anything is written:

| In the request | In the log | Why |
|---|---|---|
| `/api/invites/<43 chars of base64url>` | `/api/invites/:x` | A path segment survives only when it is plainly part of a route — lower-case letters and hyphens, no longer than a word. It is an allow-list, not two exceptions: the next route to put a secret in a path would not think to add itself to a deny-list |
| `/api/documents/<uuid>/files` | `/api/documents/:x/files` | Identifiers share the fate of tokens; `requestId` already ties a line to the rest of its request, and handlers log the ids they act on deliberately |
| `?q=<what somebody searched for>` | dropped whole | A search of one's own archive is as private as the archive. No query parameter is worth keeping at the cost of a rule that has to know which ones are safe |
| `X-Legere-Filename` / `X-File-Name` | removed | A file's name is often the most sensitive metadata an archive holds — one `biopsy-results.pdf` says what a folder of PDFs does not |
| `Cookie`, `Authorization`, `Set-Cookie` | removed | Session and API-token material |

Express's own `req.route.path` would name the parameters (`:token` rather than `:x`) and is
deliberately unused: it is empty exactly when a request never reached its handler — throttled,
refused by the origin check, an unknown route — which is when a URL carrying a token is most likely
to be the one being logged. `req.query` and `req.params` are dropped from the serialized shape
entirely, since Express fills both with the same material the URL is scrubbed of.

### 6.7.1. The account journal

🔒 A request line says that `POST /api/auth/login` answered 200. It does not say **whose** account,
**which** invite, or that somebody's role changed — the document event journal
([`03 §3.3.18`](./03-domain-model.md)) covers documents, not accounts. So account-affecting facts are
written as records of their own, and after an incident they are what answers *who signed in, from
where, and when their authority changed*.

**The port.** `SecurityEvents.record(event)` in `src/server/application/ports/security-events.ts`;
the pino-backed `PinoSecurityEvents` implements it in `infrastructure/logging`. Use cases depend on
the port, so the layer that knows the facts stays framework-free (§6.1). `record` returns nothing
and throws nothing: no account operation may fail, or wait, because a record could not be written.

**The record.** One JSON line, at `info`, with `context: "security"`:

| Field | What it is |
|---|---|
| `event` | one of the names below, e.g. `login.failed` |
| `actor` | `{ userId, ip? }` — who did it. `userId` is null when the caller had not proved who they were; `ip` is carried by the login events only, because "from where" is the question they exist to answer, and every other record joins to a request line that already holds `remoteAddress` |
| `target` | `{ userId?, email?, id? }` — the account it was done to, the address a caller *claimed*, and the invite / reset / session / token row it was about |
| `detail` | a closed shape — `reason`, `role`, `fromRole`, `sessions`. Deliberately not a free-form bag: that is how a token, a code or a password eventually reaches a log line, and the type is what makes "records carry no credential" a property of the compiler rather than of review |
| `requestId` | the id the request already has — `pino-http` minted it, answered with it as `X-Request-Id` and wrote it on the request line. A record therefore joins to its own request, and through it to the address, the method and the route |
| `time` | pino's, in epoch milliseconds |
| `msg` | `security.<event>`, so the stream can be filtered by prefix where the reader does not parse JSON |

The id reaches the application layer through the `CallContext` port
(`AsyncLocalStorage`, the same one a pipeline step opens — [`03 §3.3.18`](./03-domain-model.md)): an
Express middleware mounted directly after `pino-http` runs the rest of every `/api` request inside
it. Off a request — a cron, a job — `requestId` is `null` rather than invented.

**What is recorded**

| Event | Emitted by | Actor / target |
|---|---|---|
| `login.succeeded` `login.failed` `login.throttled` | `Login` | the address attempted; the account only once a correct password has named it |
| `account.created` | `CompleteRegistration` (onboarding) | the first administrator ([`08 §8.1.1`](./08-auth-and-authorization.md)) |
| `invite.issued` `invite.accepted` `invite.revoked` | `CreateInvite` / `CompleteRegistration` / `RevokeInvite` | the admin, then the account the link created |
| `password_reset.issued` `password_reset.completed` | `CreatePasswordReset` / `CompleteRegistration` | the admin who issued it, then the owner who spent it |
| `password.changed` | `ChangePassword` | the owner, with the sessions the change ended ([`08 §8.1.6a`](./08-auth-and-authorization.md#816a-password-change-self-service-authenticated)) |
| `role.changed` `account.deactivated` `account.reactivated` | `ChangeUserRole` / `DeactivateUser` / `ReactivateUser` | the admin who made it, against the account it happened to |
| `session.revoked` | `RevokeUserSessions` / `RevokeMySession` | whoever ended them — an admin, or the owner |
| `api_token.created` `api_token.revoked` | `CreateApiToken` / `RevokeApiToken` | the owner, and the row ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)) |

Nothing is recorded when nothing happened: a role set to the role it already had, a session revoked
twice, a refused completion. A record inside a transaction is written after it commits — an account
that rolled back was not created, and a journal that says otherwise is worse than one that says
nothing.

🔒 **A failed login names the address, not the account.** The record says the address that was
*attempted*, exactly as the caller typed it, and does not say whether an account answers to it — the
use case knows, because it has just looked, and deliberately does not tell. `08 §8.1.4` gives the
existing and the non-existing address the same answer at the same cost precisely so that login is
not an enumeration oracle; a record that told them apart would not have closed that oracle, only
moved it to whoever can read a log, which is more people than can read the database. The two records
therefore have identical fields and differ in the address alone. A refusal names the account in one
case only — when a *correct* password was presented to a deactivated one — and there the caller has
already proved the account exists.

**Where they go, and how long they live.** The same stream as everything else: one JSON line on
stdout, which in the shipped deployment is `docker compose logs app`
([`12 §12.7`](./12-build-config-run.md)). Not a second stream and not a file: the container runs with
a read-only root filesystem ([`12 §12.6`](./12-build-config-run.md#126-dockerfile-one-image)), so a
file beside the process would be a place nothing rotates, nothing ships and `docker compose logs`
cannot show. Retention is therefore **the container log driver's, not the application's** — Legere
enforces none and stores none of this in the database. The shipped compose sets the `json-file`
driver's `max-size` and `max-file` on the `app` service (defaults: 10 MB × 5, overridable through
`LOG_MAX_SIZE` / `LOG_MAX_FILES`), so the honest statement is: *these records survive as long as the
last few tens of megabytes of that container's output, and no longer.* An operator who needs an
account history that outlives a rotation — or a restart with `docker compose down` — must ship the
stream somewhere that keeps it; the format is one JSON object per line and `context: "security"`
selects it. Two consequences worth stating rather than discovering: the stream contains account
email addresses, so it is as private as the instance is; and deleting a user does not delete their
history from a log already written.

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
5. `trust proxy` is set **only** when `TRUST_PROXY` says so, and is off by default
   ([`12 §12.8`](./12-build-config-run.md#128-production-notes)). 🔒 Every per-IP limit in the app
   reads `req.ip`, and Express reads that from `X-Forwarded-For` once this is on — so believing the
   header with nothing in front to rewrite it lets a caller choose their own rate-limit bucket. A
   deployment that forgets to set it behind a real proxy over-throttles, which is the safe direction
   to be wrong in.
6. Multipart is not used (no user uploads); no multer.
7. Dev runner: `nodemon` watches `server/`, `src/server/`, `src/shared/` and re-executes
   `node server/dev.mjs`, which registers the SWC ESM loader (decorator metadata, ADR-017) and runs
   the same bootstrap with `dev: true` (Next HMR handles the client side).

## 6.10. Health

`GET /api/health` → `200 { data: { status: 'ok', db: 'ok', queue: 'ok' } }`; DB checked with
`SELECT 1`, queue with a pg-boss state read. Any check failing → `503` with the failing component.
Used as the container liveness/readiness probe. 🔒 The answer stands for one second and a burst
arriving together costs one round trip: the route is unauthenticated because a probe cannot
authenticate, so without that every caller buys a database round trip and anybody may call it as
fast as they like. A second is far below any probe interval, so the answer is never stale to an
operator. Throttling it instead would be worse — the probe would be the thing refused. S3 and Stirling are **not** part of health (their
outage must not restart the app).

## 6.11. Open questions

None.
