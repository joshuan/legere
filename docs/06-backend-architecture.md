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
  `DocumentChunkRepository`, `DocumentTypeRepository`, `CollectionRepository`, `FileRepository` —
  which owns the bytes *and* the list of pages a document is (`03 §3.3.17`), because a composition
  edit is one rewrite of one list and splitting it across two ports would split the transaction too.
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
| documents | `ListDocuments`, `GetDocument`, `UpdateDocumentMeta`, `SoftDeleteDocument`ᴬ, `ReprocessDocument`ᴬ, `GetDocumentMarkdown`, `OpenSourceStream`, `GetArtifactUrl`, `ListDocumentLinks`, `CreateDocumentLink`, `DeleteDocumentLink`, `SuggestDocumentLinks` |
| search | `SearchDocuments` |
| people | `ListPeople`, `CreatePerson`, `UpdatePerson`ᴬ, `DeletePerson`ᴬ, `MergePeople`ᴬ, `SuggestPeopleMerges`ᴬ, `PreviewPeopleMerge`ᴬ |
| subjects | `ListSubjects`, `CreateSubject`, `UpdateSubject`ᴬ, `DeleteSubject`ᴬ, `MergeSubjects`ᴬ, `SuggestSubjectMerges`ᴬ, `PreviewSubjectMerge`ᴬ |
| subject kinds | `ListSubjectKinds`, `CreateSubjectKind`, `UpdateSubjectKind`ᴬ, `DeleteSubjectKind`ᴬ, `MergeSubjectKinds`ᴬ, `SuggestSubjectKindMerges`ᴬ, `PreviewSubjectKindMerge`ᴬ |
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
| `HandleMaintenance` (also re-enqueues documents whose steps have not started — `PENDING`, nothing scheduled, or `QUEUED`, a job that went missing — and marks what it takes as `QUEUED` at once, 05 §5.4) | `{}` | purge expired EmailVerifications/invites/resets; delete S3 artifacts of documents soft-deleted > 30 days ago is **not** done (retention: keep); compact nothing else |

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
| `PdfToolbox` | `toPdf({body, fileName})`, `pdfPageJpg(source, {page?, dpi?})`, `ocrPdf(source, langs)`, `imagesToPdf([{body, fileName}])`, `scalePages(source, {pageSize, orientation})`, `mergePdfs(parts[])`, `stampMetadata(source, {title, date})`, `pdfPageCount(source)`, `pdfToMarkdown(source)` — a source is a stream or a buffer; the file name travels with office/image input because the converter picks its filter from the extension | `StirlingPdfToolbox` (HTTP client, `STIRLING_URL`) |
| `ImageTool` | `toJpegPreview(source, {maxDim})`, `dimensions(source)`, `correctPage(source)`, `contentBox(source)`, `applyCrop(source, crop)`, `grayscaleRaster(source, maxDim)` | `SharpImageTool` |
| `EmbeddingProvider` | `embed(texts[]): number[][]`, `isConfigured` | `OpenAiCompatEmbeddings` (fetch, `EMBEDDINGS_*` env) |
| `DocumentAnalyst` | `analyze(excerpt, document types[], subject kinds[], known subjects[], known people[], language, pages[], confirmed?): { title, description, typeSlug, languages, country, city, people, date, subjects, textQuality, legibility, extraction, usage }`, `extractFields(schema, excerpt, pages[], confirmed?): { values, confidence, usage }` — the fields step (`05 §5.5` step 5), same provider, same gate, validated in code per field, `isConfigured`, `endpoint`. `legibility`, `extraction` and `confidence` are the marks each call gives its own work, 0–100 and `null` where it gave none: clamped and dropped by the adapter, since 🔒 a missing mark is not a zero (`03 §3.3.18`) and only the adapter sees what actually came back. `confidence` is answered under a key of that name beside the fields, and never reaches `values` — a schema field could not be called `confidence` and be read. `confirmed` is what a person has settled about this document — title, type, typed fields, date, place, description, people, subjects (`05 §5.5` step 4); the application layer decides what belongs in it, and 🔒 the adapter writes it **inside the same nonce-fenced data channel as the excerpt**, because a human-entered string is data whoever typed it. 🔒 The user-written catalogues — kinds, known subjects, known people — ride inside that fence too, in a nonce-marked section of their own, never in the system message (SEC-55, `05 §5.5` step 4); only the admin-written document-type list stays with the instructions | `OpenAiCompatAnalyst` (chat-completions JSON answer; the pages travel as images) |
| `CatalogueAnalyst` | `suggestMerges(catalogue, rows[]): { groups: { ids[], name, kind?, aka[] }[], placeholders: id[] }`, `previewMerge(catalogue, rows[]): { name, kind?, aka[] } \| null`, `isConfigured` — the duplicate-noticer of `05 §5.6c` over all three catalogues: the same provider and gate as `DocumentAnalyst`, asked which living rows are one entry. `catalogue` is which of the three is being read — `people`, `subjects`, `subject-kinds` — and exists so that a failure names its question in the log (§6.7): one port and one provider serve all three, and "the analyst is down" is not actionable without saying which reading it broke. One reading is **not one call**: rows are ordered by the blocking key of `05 §5.6c` and cut into chunks of at most sixty, one completion and one gate unit each, their answers unioned before the caller judges them — a catalogue that fits in one chunk is one call with the rows untouched. A row may carry a `kind` (the subjects call does); the answer then names the kind the survivor keeps — resolved by the caller against the kinds the merged rows already have — and points beside the groups at **placeholders**, rows naming a kind rather than a thing. Rows without kinds answer groups alone. The adapter owns the shape — schema-parsed, lengths capped, a parse failure an empty answer rather than an error — and the use cases own the sense: unknown ids, groups of one and twice-claimed rows are dropped against the living catalogue, at most twenty groups pass (where the unit floor can see it). 🔒 The rows travel **inside the nonce-fenced data channel**, never in the system message — every signed-in user writes these rows | `OpenAiCompatCatalogueAnalyst` (chat-completions JSON answer, `CLASSIFIER_*` env, `classifier` gate) |
| `PageTranscriber` | `transcribe(pages[], languages[]): { markdown, usage }`, `isConfigured`, `endpoint` | `OpenAiCompatTranscriber` — the recogniser of last resort (05 §5.5 step 3): a vision model reading the pages of a document that had to be recognised at all |
| `JobQueue` | `enqueue(name, payload, opts?)`, `enqueueAfterTx(...)`, `scheduleCron(name, cron)` | `PgBossJobQueue` |
| `QueueMonitor` | `overview()`, `failedJobs(cursor)`, `retry(jobId)` | `PgBossQueueMonitor` (raw SQL over the `pgboss` schema) |
| `UnitOfWork` | `run<T>(fn: (tx) => Promise<T>, bounds?: { timeoutMs })` | `PrismaUnitOfWork` (`$transaction`; repositories accept the tx handle). The bound is optional and the adapter's default stands without it (§6.3.4) |
| `MimeDetector` | `detect(streamHead): {mime, ext}` | `FileTypeMimeDetector` (`file-type` package; fallback to extension for text) |

### 6.3.4. Transactions
`UnitOfWork.run` wraps every multi-write use case. Job enqueueing inside a transaction uses
`JobQueue.enqueueAfterTx`, implemented via pg-boss's `send` executed on the same Postgres connection
as the transaction (pg-boss supports passing a client/`db` option) — entity write + job insert commit
atomically.

**A transaction is given the time its work takes.** Prisma bounds an interactive transaction at 5
seconds and waits 2 for a connection to open one, and both numbers are the driver's rather than this
product's: a transaction that outruns them is not rolled back for being wrong, it is refused at the
commit and everything it wrote is thrown away. That is ample for a use case writing a handful of
rows, and it is not ample for one of them — the wholesale chunk replacement of
[`03 §3.3.11`](./03-domain-model.md#3311-documentchunk), which deletes a document's vectors and
inserts the new set, every row an insertion into an HNSW index over 1024 dimensions
([`04 §4.4`](./04-database-schema.md#44-query-patterns-the-schema-must-support-index-rationale)).
Seventy-one documents on the live instance are FAILED at vectorization with exactly that refusal, the
longest of them after 94 seconds. So `run` takes an optional `{ timeoutMs }`: given none the adapter
behaves as it always did, and given one it passes it to `$transaction` as `timeout` and raises
`maxWait` with it — the load that makes a write slow is the same load that keeps the pool busy, so
raising one bound and not the other only moves the failure. The bound is a **constant beside the work
it bounds**, its arithmetic written out where it is declared — the same rule as
[`05 §5.4a`](./05-library-and-processing.md#54a-what-one-document-may-cost) applies to what one
document may cost — because a number chosen for one caller belongs to that caller, and raising
Prisma's default for everybody would hide the next transaction that does too much.

What the bound is not is permission to split the write. `03 §3.3.11` promises that no reader sees
half of one vectorization and half of another, so the delete and the insert stay inside the one
transaction; where the insert is cut into batches to keep a single statement within what the wire
protocol can carry, the batches are cut inside that transaction and commit with it.

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
- **Rate limiting:** `@nestjs/throttler` with four named budgets — `auth`, `catalogue`, `password`,
  `search` — counted against the signed-in caller where there is one and against `req.ip` otherwise,
  over a sliding-window storage of this application's own
  ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha),
  [`08 §8.4.1b`](./08-auth-and-authorization.md#841b-what-the-throttles-forget-when-the-process-restarts));
  per-email limits live inside the auth use cases (they read `EmailVerification`/login-failure
  state).
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
DocumentAnalyst, PageTranscriber), `QueueModule` (JobQueue, QueueMonitor, worker bootstrap), and the feature
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

**A degraded answer still writes a line.** Where a failing external call is caught and turned into a
lesser answer rather than an error — the catalogue suggester's `UNAVAILABLE` reading is the one that
taught this (`05 §5.6c`) — the adapter that made the call logs `warn` with what an operator can act
on: which catalogue was being read, which service and model were asked, how many rows the failed
call carried, and the provider's own sentence, truncated. 🔒 The rows themselves never travel to the
log: they are a catalogue every signed-in user writes into, and a log line is not the place for it.
A caught failure with no line is how a feature stays dead for months.

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

Express's own `req.route.path` would name the parameters (`:token` rather than `:x`) and is
deliberately unused: it is empty exactly when a request never reached its handler — throttled,
refused by the origin check, an unknown route — which is when a URL carrying a token is most likely
to be the one being logged. `req.query` and `req.params` are dropped from the serialized shape
entirely, since Express fills both with the same material the URL is scrubbed of.

🔒 **And its headers are an allow-list, exactly like the response's below.** They were a deny-list of
four names — `Cookie`, `Authorization`, and both spellings of the upload file-name header — with the
rest of `req.headers` kept whole. That is the shape [SEC-23](./tasks/security-audit-2026-08.md#sec-23)
is about, and the header nobody would have added to it is `Referer`: invite and reset links carry a
bearer credential in their path (§8.1.2, §8.1.6), `Referrer-Policy: no-referrer`
([`12 §12.8a`](./12-build-config-run.md#128a-security-headers)) is a rule about *browsers*, and the
client that follows such a link out of a chat window or a mail client is not always one. So the
request keeps four headers and drops everything else by omission:

| In the request | In the log | Why |
|---|---|---|
| `Content-Type`, `Content-Length` | kept | What kind of request, and how big — the mirror of the two the response keeps |
| `User-Agent` | kept | Which client it says it is, which is what an access log is read for |
| `Origin` | kept | A fail-closed `403` from the CSRF origin check ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)) is unanswerable without it — and an origin is a scheme, a host and a port, so it has no path in which to carry a token |
| `Referer` | dropped | The URL the request side is already scrubbed of, arriving by another door |
| `Cookie`, `Authorization` | dropped | Session and API-token material |
| `X-Legere-Filename` / `X-File-Name` | dropped | A file's name is often the most sensitive metadata an archive holds — one `biopsy-results.pdf` says what a folder of PDFs does not — and an upload carries it in a header, since the body is the file itself ([`07 §7.3`](./07-api-specification.md#73-endpoints)) |
| `Host`, and every other header | dropped | The address the app answers under is `APP_BASE_URL`, which the operator set; everything else, by omission |

There is therefore **no `redact` block** in the pino options any more. Both serializers now drop what
it used to name before pino sees the object, so every path in it could only match something that is
no longer there — and a rule that can never fire is a claim about a defence standing somewhere it
does not stand.

🔒 **A response line says how it ended, not what it handed over.** `pino-http` serializes the
response of every completed request, and its standard serializer writes `res.getHeaders()` whole.
Two of the headers this application sets on the way out are exactly what the rule above exists to
keep out of a log: a download answers `302` with a presigned URL in `Location` — a bearer credential
for the bytes behind it, valid for `SIGNED_URL_TTL_SEC` with no session, no cookie and no token
([`09 §9.2`](./09-file-storage.md)) — and both of a download's two branches set `Content-Disposition`,
which spells out the file name the request side is already scrubbed of. So the `res` serializer keeps
an **allow-list** and drops the rest:

| In the response | In the log | Why |
|---|---|---|
| `statusCode` | kept | How the request ended, which is what the line is for |
| `Content-Type`, `Content-Length`, `Retry-After` | kept | What kind of answer, how big, and how long a throttled caller was told to wait — none of them says anything about the archive |
| `Location` | dropped | A download's redirect target is a presigned URL; whoever reads the log would otherwise hold the document ([SEC-58](./tasks/security-audit-2026-08-second-pass.md#sec-58)) |
| `Content-Disposition` | dropped | The file name, on both the redirect and the streamed branch |
| `Set-Cookie`, and every other header | dropped | Session material — and everything else, by omission |

An allow-list for the same reason the URL is one, and it is the lesson of
[SEC-23](./tasks/security-audit-2026-08.md#sec-23) applied to headers: a deny-list has to be told
about each secret in advance, and the next response header to carry one would not think to add
itself. `X-Request-Id` is not on the list because `req.id` on the same line already is it.

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
  `document-process` settles a
  document's own failures inside the handler and lets exactly one error class reach this policy:
  `ServiceUnavailableError`, a service being away, which is retried because it is transient and must
  not be recorded against a document ([`05 §5.4e`](./05-library-and-processing.md#54e-an-outage-is-not-a-verdict)).
- 🔒 **A singleton key means nothing unless the queue's policy says it does**, and the key is
  therefore decided in one place — the queue adapter, off the payload — rather than at each of the
  eight call sites that ask for work. pg-boss's dedup indexes cover only the `short`, `singleton` and
  `stately` policies; a key passed to a `standard` queue deduplicates nothing at all, silently. Two
  queues carry one:
  - **`library-scan` is `stately`**, keyed by libraryId: at most one scan of a library queued and at
    most one running, which is what makes "one scan per library at a time" hold at the database level
    ([`05 §5.2`](./05-library-and-processing.md), §5.4).
  - **`document-process` is `short`**, keyed by the documentId and the steps the payload asks for
    (`<documentId>[#full][#step+step]`): at most one *queued* job per key, with nothing said about
    what is running. `short` and not `stately`, because a rebuild asked for while the previous one
    runs is asking about a document that has changed since and must still be queued; what has to
    collapse is the queue of identical requests. The steps are in the key because a `short` queue
    silently declines to create the second job, so a key of the document alone would drop a rebuild
    whenever a one-step job happened to be waiting ([`05 §5.5`](./05-library-and-processing.md#55-document-processing-pipeline-document-process)).
- **A batch is delivered together and settled one job at a time.** A worker fetches `concurrency`
  jobs and runs them in parallel; pg-boss's own wrapper then completes or fails **every id in the
  batch** on the callback's single outcome. Each job's outcome is recorded against that job instead,
  so one failure cannot cost its neighbours a re-run
  ([`05 §5.4e`](./05-library-and-processing.md#54e-an-outage-is-not-a-verdict)).
- **`expireInSeconds` is per queue**, and it is a recovery time rather than a work timeout: it is how
  long a job stays `active` after its worker disappeared — a crash, a deploy, a dev restart — before
  pg-boss gives it to someone else. Under the `stately` policy an abandoned job keeps its singleton
  slot, so this interval is exactly how long a library stays unscannable (and its ScanRun stuck at
  RUNNING) after a restart mid-scan. Values: `library-scan` 15 min, `file-ingest` 10 min,
  `document-process` **3 h**, `maintenance` 15 min —
  generous multiples of the real work, safe because every handler is idempotent
  ([`05 §5.4`](./05-library-and-processing.md#54-job-queue-pg-boss)).
  🔒 The three hours are arithmetic rather than generosity, and the reason is that this expiry is
  *also* a work timeout in one direction: pg-boss does not cancel a handler that outruns it, it fails
  the job and delivers another copy beside the first. An hour was below the sum of the per-step
  budgets §5.4a documents (165 minutes), so any long document produced a duplicate run of itself
  every hour. The arithmetic is in
  [`05 §5.4a`](./05-library-and-processing.md#54a-what-one-document-may-cost); the price is that a
  `document-process` job whose worker died waits three hours rather than one, which the hourly
  maintenance sweep and the handler's own refusal to run a document twice both cover.
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
