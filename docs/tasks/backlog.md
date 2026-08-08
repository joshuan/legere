# Implementation Backlog

Execution rules — [`README.md`](./README.md). Take the first unchecked task. One task = one PR.

---

## M0 — Foundations

- [x] **M0.1 — Repository scaffolding**
  **Goal:** the repo skeleton with all tooling configs; `npm run typecheck` and `npm run lint` pass on
  an empty-but-structured codebase.
  **Docs:** [`02 §2.3`](../02-architecture-overview.md#23-repository-layout-one-package-no-workspaces), [`12 §12.1–12.3`](../12-build-config-run.md), [`14 §14.1–14.4`](../14-coding-standards.md)
  **Acceptance:**
  - `package.json` (single, no workspaces) with the dependency set from docs 02/06/10/12; `.nvmrc` (Node 26); `package-lock.json` committed.
  - `tsconfig.json` / `tsconfig.server.json` / `tsconfig.test.json` / `.swcrc` exactly per 12 §12.3.
  - ESLint flat config with all boundary rules from 14 §14.2 (layer restrictions, FSD, client/server, contracts isolation); `.prettierrc.json`, `.editorconfig`, `.gitignore`, `.dockerignore`.
  - Folder skeleton: `server/`, `src/server/{domain,application,infrastructure,presentation}`, `src/web/{screens,widgets,features,entities,shared}`, `src/app`, `src/shared/contracts`, `prisma/`, `messages/`.
  - `.env.example` verbatim per 12 §12.4.

- [x] **M0.2 — Local dev dependencies (docker compose)**
  **Goal:** `npm run dev:up` starts PostgreSQL(+pgvector), Stirling-PDF, MinIO with bucket init.
  **Docs:** [`12 §12.5`](../12-build-config-run.md#125-local-development), [`09 §9.4`](../09-file-storage.md#94-local-development)
  **Acceptance:** compose file matches 12 §12.5; `dev:up`/`dev:down` scripts work; MinIO console reachable; bucket `legere` exists after up; Stirling answers on :8080.

- [x] **M0.3 — SWC transpilation spike (dev runner + Vitest)**
  **Goal:** proof that Nest DI (decorator metadata) works under the dev runner and Vitest.
  **Docs:** [ADR-017](../02-architecture-overview.md#adr-017-devtest-transpilation--swc-for-decorator-metadata), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:**
  - `server/dev.mjs` registers the SWC ESM loader; a minimal Nest module with constructor injection resolves under `npm run dev`.
  - `vitest.config.ts` with two projects (`server`: node + `unplugin-swc`; `web`: jsdom); a server test instantiating a Nest testing module with DI passes; a jsdom component test passes.

- [x] **M0.4 — One-process bootstrap (Express + Nest + Next), config, logging, health**
  **Goal:** the single process serves a Next placeholder page and `/api/health`; all integration invariants hold.
  **Docs:** [`02 §2.2`](../02-architecture-overview.md#22-entry-point-servermaints), [`06 §6.6–6.10`](../06-backend-architecture.md), [`07 §7.1`](../07-api-specification.md#71-conventions)
  **Acceptance:**
  - `server/main.ts` implements the bootstrap contract (dispatcher before `init`, `/api`-scoped parsers, no Nest `listen`, trust proxy).
  - Zod-validated config module (fails fast with readable error on bad env); `nestjs-pino` logging with requestId.
  - `GET /api/health` → `{ data: { status, db, queue } }` (db real, queue stubbed `'ok'` until M3.2); unknown `/api/*` → JSON `NOT_FOUND`; a Next page renders on `/`.
  - `DomainExceptionFilter` + envelope + `ZodValidationPipe` skeleton with `VALIDATION_FAILED` mapping.
  - `contracts/common.ts`: envelope, pagination, `ErrorCode` enum per 07 §7.2.

- [x] **M0.5 — CI workflow**
  **Goal:** every PR runs typecheck/lint/test/build against pgvector Postgres.
  **Docs:** [`13 §13.1–13.2, §13.4`](../13-ci-cd.md)
  **Acceptance:** `.github/workflows/ci.yml` verbatim-equivalent to 13 §13.2; green on the current tree; branch protection requirements documented in the PR description for the repo owner to enable.

- [x] **M0.6 — Dockerfile + release workflow**
  **Goal:** one production image, published to GHCR on main/tags.
  **Docs:** [`12 §12.6`](../12-build-config-run.md#126-dockerfile-one-image), [`13 §13.3`](../13-ci-cd.md#133-githubworkflowsreleaseyml)
  **Acceptance:** multi-stage Dockerfile per 12 §12.6 builds locally; `CMD` = migrate deploy + start; `release.yml` per 13 §13.3; image runs and serves `/api/health` (with compose deps).

## M1 — Persistence

- [x] **M1.1 — Prisma schema, first migration, seed**
  **Goal:** the full physical schema exists and migrates; seed provides dev users/document types/library.
  **Docs:** [`04`](../04-database-schema.md) (entire), [`03`](../03-domain-model.md)
  **Acceptance:**
  - `schema.prisma` matches 04 §4.1; migration 1 includes all raw SQL of 04 §4.3 **and** the default-document type inserts (04 §4.6).
  - `prisma migrate deploy` on a fresh pgvector DB succeeds; re-running is a no-op.
  - `db:seed` idempotently creates `admin@legere.local`/`user@legere.local` (password `password`) and the dev library; running twice creates no dupes.

- [x] **M1.2 — PersistenceModule + UnitOfWork + integration-test harness**
  **Goal:** repositories can be written and integration-tested.
  **Docs:** [`06 §6.2, §6.3.3–6.3.4, §6.5`](../06-backend-architecture.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** Prisma client provider with graceful shutdown; `UnitOfWork.run` wraps `$transaction` and repositories accept the tx handle; test helper truncates all tables between integration tests; example round-trip repo test passes in CI.

## M2 — Auth & users

- [x] **M2.1 — Auth/users contracts**
  **Goal:** all Zod schemas for auth, me, admin users, invites, resets.
  **Docs:** [`07 §7.3`](../07-api-specification.md#73-endpoints) (Auth & account, Admin users & invites), [`07 §7.4–7.5`](../07-api-specification.md)
  **Acceptance:** `contracts/auth.ts`, `contracts/users.ts` export request/response schemas + inferred types for every endpoint of those sections; password rule (8–128 + denylist) lives here; no runtime deps beyond zod.

- [x] **M2.2 — Auth infrastructure ports**
  **Goal:** working `PasswordHasher` (Argon2id), `SessionTokens`, `EmailSender` (SMTP + Log fallback), `CaptchaVerifier` (Turnstile + no-op), `Clock`.
  **Docs:** [`08 §8.1.5, §8.4.2`](../08-auth-and-authorization.md), [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository)
  **Acceptance:** Argon2id params per 08 §8.1.5 (PHC string round-trip test); LogEmailSender used when `SMTP_HOST` empty; CaptchaVerifier no-op when keys unset; unit tests for each.

- [x] **M2.3 — Registration & onboarding (3-step flow)**
  **Goal:** first-admin onboarding and the email-code registration machine work end to end.
  **Docs:** [`08 §8.1.1–8.1.3`](../08-auth-and-authorization.md), [`03 §3.3.3`](../03-domain-model.md#333-emailverification), [`07`](../07-api-specification.md) (register endpoints)
  **Acceptance (e2e):** onboarding-required flag; concurrent onboarding creates exactly one ADMIN; start/verify/complete happy path (code read from mock sender); wrong code ×5 burns the record (`EMAIL_CODE_TOO_MANY_ATTEMPTS`); expired code/ticket rejected; per-email caps (1/60s, 5/day) → `RATE_LIMITED`; anti-enumeration (`start` always 200); registration race → `EMAIL_ALREADY_REGISTERED`.

- [x] **M2.4 — Login, sessions, CSRF, rate limiting**
  **Goal:** session authn hardened per spec.
  **Docs:** [`08 §8.1.4, §8.2, §8.4`](../08-auth-and-authorization.md), [`06 §6.4`](../06-backend-architecture.md#64-presentation-layer)
  **Acceptance (e2e):** login sets new `sid` each time (anti-fixation); dummy-verify keeps unknown-email and wrong-password responses identical (`INVALID_CREDENTIALS`); `SessionGuard` populates `currentUser`; logout revokes; deactivated user → 403; CSRF fail-closed on all mutations (missing/foreign Origin → 403); per-IP throttling on `/api/auth/*`; login backoff after 5 failures; cookie attributes per 08 §8.2.

- [x] **M2.5 — Invites & password resets**
  **Goal:** closed-registration growth path + admin resets.
  **Docs:** [`08 §8.1.2, §8.1.6`](../08-auth-and-authorization.md), [`03 §3.3.4–3.3.5`](../03-domain-model.md), [`07`](../07-api-specification.md) (invites, resets)
  **Acceptance (e2e):** invite create returns URL once; preview endpoint reports validity; accept path creates a user with the invite's role and marks it used; expired/revoked/used → `INVITE_INVALID`; reset link + code flow updates the password and revokes all sessions; reset for a deactivated user rejected.

- [x] **M2.6 — Me & admin user management**
  **Goal:** profile settings and the full admin user API.
  **Docs:** [`07`](../07-api-specification.md) (me, admin users), [`08 §8.3`](../08-auth-and-authorization.md#83-roles), [`03 §3.3.1`](../03-domain-model.md#331-user)
  **Acceptance (e2e):** `PATCH /api/me` updates displayName/language/theme and refreshes `NEXT_LOCALE`; admin list/role-change/deactivate/reactivate/revoke-sessions; every `LAST_ADMIN` path covered (role change, deactivate — and later delete); non-admin on admin routes → 403.

- [x] **M2.7 — Frontend foundations**
  **Goal:** the client platform every screen builds on.
  **Docs:** [`10`](../10-frontend-architecture.md) (entire)
  **Acceptance:** providers (AntdRegistry, ConfigProvider with theme algorithm + antd locale sync, QueryClient per 10 §10.5, next-intl without routing); typed api client with envelope parsing, Zod response validation, `ApiError`, 401 redirect; exhaustive `ErrorCode → message key` map (type-checked); `messages/en.json` + `messages/ru.json` bootstrapped; ErrorBoundary widget; `error/global-error/not-found` pages.

- [x] **M2.8 — Auth screens**
  **Goal:** login, onboarding/invite/reset wizard, settings.
  **Docs:** [`11 §11.2, §11.9`](../11-ui-ux-spec.md), [`10 §10.2, §10.6`](../10-frontend-architecture.md)
  **Acceptance:** the shared 3-step wizard (Steps, code input with TTL countdown + resend cooldown, password rules) drives all three entry flows; login form with Turnstile slot and localized errors; `(app)` layout session guard redirects with `returnTo`; settings screen saves immediately and switches locale live; component tests for wizard and login (msw).

- [x] **M2.9 — Admin UI: users & invites**
  **Goal:** the admin can run the user lifecycle from the browser.
  **Docs:** [`11 §11.11`](../11-ui-ux-spec.md#1111-admin-users-adminusers)
  **Acceptance:** users table with role/status actions and `LAST_ADMIN` error toasts; invite modal → one-time URL display with copy; active invites list with revoke; reset-link modal (shown once); admin route guard (`notFound` for USER).

## M3 — Libraries & scanning

- [x] **M3.1 — `RelativePath` + `LibraryReader` (fs)**
  **Goal:** safe, tested filesystem access under `LIBRARY_ROOT`.
  **Docs:** [`09 §9.1`](../09-file-storage.md#91-library-volume), [`05 §5.1`](../05-library-and-processing.md#51-external-libraries), [`06 §6.2`](../06-backend-architecture.md#62-domain-layer)
  **Acceptance:** `RelativePath` VO rejects traversal/absolute/`..`; `FsLibraryReader.walk` yields deterministic ordered entries with size/mtime; symlinks and special files skipped (fixture includes a symlink escaping the root — must be ignored); hidden files and excludeGlobs honored; unreadable dir recorded, not fatal; integration tests on tmp fixtures.

- [x] **M3.2 — Queue integration (pg-boss)**
  **Goal:** `JobQueue`/`QueueMonitor` ports live; workers boot with the app.
  **Docs:** [`06 §6.8`](../06-backend-architecture.md#68-queue-integration-pg-boss), [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss)
  **Acceptance:** pg-boss starts in bootstrap step 5 (schema `pgboss`); worker registry maps queue names → DI-resolved handlers with per-queue concurrency/retry config; `enqueueAfterTx` commits atomically with the entity write (test: rollback → no job); singletonKey support; cron registration API; graceful shutdown drains; `/api/health` `queue` becomes real.

- [x] **M3.3 — Libraries admin API + visibility**
  **Goal:** the admin can define what gets scanned and who sees it.
  **Docs:** [`03 §3.3.6–3.3.7`](../03-domain-model.md), [`07`](../07-api-specification.md) (admin libraries, user-facing list), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Acceptance (e2e):** create validates path (`LIBRARY_PATH_INVALID` for outside-root/nonexistent/file; `LIBRARY_PATH_CONFLICT` for nesting/duplicate); create enqueues the first scan and registers cron; path-candidates endpoint browses only inside `LIBRARY_ROOT`; visibility RESTRICTED default + userIds round-trip; `GET /api/libraries` returns only visible ones; soft delete hides content; rootPath immutable.

- [x] **M3.4 — Scan & ingest pipeline (FileRefs → Documents)**
  **Goal:** the core promise: mounted folder in → deduplicated documents in the DB.
  **Docs:** [`05 §5.2–5.4, §5.7`](../05-library-and-processing.md), [`03 §3.3.9–3.3.10`](../03-domain-model.md)
  **Acceptance (integration over fixtures):** `HandleLibraryScan` implements the §5.2 diff exactly (new/changed/missing/unchanged) and writes a correct `ScanRun`; singleton scan per library; re-scan with no changes enqueues zero ingests; `HandleFileIngest` streams sha256, attaches to existing document on hash match (pipeline NOT re-run), creates + enqueues `document-process` otherwise (`MimeDetector` sets mime/ext/title); rename = old path MISSING + new ref attached, document untouched; file return restores availability; both handlers pass a double-delivery idempotency test; scan endpoints (`scan now`, journal) work.

- [x] **M3.5 — Admin UI: libraries**
  **Goal:** the primary product scenario is operable from the browser.
  **Docs:** [`11 §11.10`](../11-ui-ux-spec.md#1110-admin-libraries-adminlibraries-adminlibrariesid)
  **Acceptance:** table with counters, enabled switch, Scan-now; create/edit drawer with the directory picker (path-candidates), visibility controls, exclude globs; detail page with the scan journal and a live-updating running row; validation errors surfaced inline.

## M4 — Processing pipeline

- [x] **M4.1 — `FileStorage` (S3) + `MimeDetector`**
  **Goal:** artifact storage works against MinIO/S3.
  **Docs:** [`09 §9.2–9.3`](../09-file-storage.md), [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository)
  **Acceptance:** put/getStream/getSignedUrl/exists/delete implemented (multipart >8 MiB); path-style for MinIO; `InMemoryFileStorage` for tests; integration suite against MinIO (skippable in CI); signed URL expires (assert TTL param); MimeDetector via magic bytes with extension fallback for text.

- [x] **M4.2 — `PdfToolbox` (Stirling), `ImageTool` (sharp), `TextExtractor` (pdfjs)**
  **Goal:** every heavy operation behind a tested port.
  **Docs:** [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository), [ADR-012/017](../02-architecture-overview.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** Stirling client: officeToPdf, pdfFirstPageJpg, ocrPdf(langs), imagesToPdf, pdfPageCount — integration-tested against the dev Stirling container (skippable in CI, mocked otherwise); sharp: JPEG preview with EXIF orientation + max-dim, `trim()`; pdfjs text-by-page extraction validated on a fixture PDF (this closes the pdfjs spike).

- [x] **M4.3 — `document-process`: canonicalization + previews**
  **Goal:** steps 1–2 of the pipeline with per-format routing and step statuses.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process) (steps 1–2), [`09 §9.2`](../09-file-storage.md#92-s3-bucket)
  **Acceptance (integration, ports mocked/in-memory):** format matrix — pdf: no canonical; office: canonical.pdf written; image: direct preview; txt/md: skips; unsupported: SKIPPED 1–3,5; preview.jpg + thumb.jpg written with configured dims; statuses/pageCount recorded; a failing step records FAILED+error but independent steps still run; handler idempotent (re-run overwrites, no dupes).

- [x] **M4.4 — `document-process`: Markdown extraction + OCR**
  **Goal:** step 3; documents become readable text.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process) (step 3), [`05 §5.9`](../05-library-and-processing.md#59-open-questions) (threshold), [`12 §12.4`](../12-build-config-run.md#124-envexample)
  **Acceptance:** text-layer PDFs below `PDF_TEXT_MIN_CHARS_PER_PAGE` go to OCR (`ocrUsed=true`); images OCR'd directly; txt/md normalized passthrough; markdown persisted (FTS picks it up via the generated column — verify with a query); encoding normalization test (utf-8 with BOM, cp1251 fallback → replacement, not crash).

- [x] **M4.5 — Analysis + vectorization**
  **Goal:** steps 4–5; AI-optional enrichment.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md) (steps 4–5), [`06 §6.3.3`](../06-backend-architecture.md) (EmbeddingProvider, DocumentClassifier), [`04`](../04-database-schema.md) (chunks)
  **Acceptance:** classifier prompt gets document type slugs+descriptions, answer validated against active slugs (invalid → NONE); `MANUAL` never overwritten; chunking per configured target/overlap splitting on headings/paragraphs (unit-tested edge cases: huge paragraph, empty doc); chunks+embeddings replaced wholesale in a transaction; unconfigured providers → steps SKIPPED, no error; provider HTTP failure → step FAILED, retryable.

- [x] **M4.6 — Reprocess + queue administration**
  **Goal:** operational control over the pipeline.
  **Docs:** [`07`](../07-api-specification.md) (reprocess, admin queue), [`05 §5.8`](../05-library-and-processing.md#58-observability-admin-panel), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue)
  **Acceptance:** reprocess with step subset re-runs only those steps (e2e); `QueueMonitor` overview (per-queue depths + document step counters) and failures list with payload/error; retry re-enqueues; queue admin UI: overview cards, failures table with expandable errors and Retry, 5 s auto-refresh with pause.

## M5 — Documents UX

- [x] **M5.1 — Documents API + access guards**
  **Goal:** the read model of the product, correctly authorized.
  **Docs:** [`07`](../07-api-specification.md) (documents), [`03 §3.4`](../03-domain-model.md#34-access-model-authoritative-summary), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Acceptance (e2e):** list with all filters + cursor pagination, only readable docs (RESTRICTED library invisible to outsiders — 404 on detail too); availability computed per 03 §3.3.10; detail exposes fileRefs only from caller-visible libraries (admin sees all); PATCH meta per canEditDocumentMeta incl. `typeSource` transitions; admin soft delete → 404 everywhere; `DocumentAccessGuard` attaches the loaded doc (no double fetch).

- [x] **M5.2 — File endpoints**
  **Goal:** bytes flow: source streaming + signed-URL redirects.
  **Docs:** [`07`](../07-api-specification.md) (file endpoints), [`09 §9.1–9.2`](../09-file-storage.md)
  **Acceptance (e2e):** source streams with correct headers (length/type/RFC5987 filename); ENOENT during stream → ref MISSING + `DOCUMENT_UNAVAILABLE`; DERIVED source 302 → signed URL; preview/thumb/canonical 302 (404 when step not DONE); markdown endpoint; every file route rejects a non-authorized caller exactly like metadata routes.

- [x] **M5.3 — Browse API (virtual folders)**
  **Goal:** navigate the mounted folder structure of any nesting.
  **Docs:** [`07`](../07-api-specification.md) (browse), [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browselibraryidpath)
  **Acceptance (e2e):** folders derived from FileRef paths with document counts; nested paths of arbitrary depth; documents of the exact folder paginated; path validated (no traversal); RESTRICTED enforcement.

- [x] **M5.4 — Document types: API + admin UI**
  **Goal:** the reference list is manageable.
  **Docs:** [`07`](../07-api-specification.md) (document types), [`03 §3.3.12`](../03-domain-model.md#3312-document type), [`11 §11.12`](../11-ui-ux-spec.md#1112-admin-document types-admincategories)
  **Acceptance:** CRUD with slug immutability + `DOCUMENT_TYPE_SLUG_TAKEN`; delete resets documents to NONE in one transaction (e2e); admin table UI with counts and confirms.

- [x] **M5.5 — UI: documents grid**
  **Goal:** the home screen.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`10 §10.5, §10.8`](../10-frontend-architecture.md)
  **Acceptance:** responsive card grid (thumb via `/thumb`, fallback icon, processing/unavailable badges); filter bar synced to URL; infinite scroll; 5 s polling while any visible doc is processing; empty states per spec; component tests for the card and filters.

- [x] **M5.6 — UI: document viewer**
  **Goal:** read and manage a single document.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsid), [`10 §10.8`](../10-frontend-architecture.md#108-media-in-the-ui)
  **Acceptance:** Preview/Text/Details tabs per spec (PDF `<object>`, sanitized markdown render, metadata incl. copyable hash and file locations with MISSING badges); sidebar: inline title edit, document type select with auto tag, download (disabled tooltip when unavailable), add-to-collection stub until M7, processing panel with per-step states + admin Reprocess with step checkboxes.

- [x] **M5.7 — UI: browse**
  **Goal:** folder navigation UI.
  **Docs:** [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browselibraryidpath)
  **Acceptance:** sidebar submenu of visible libraries; breadcrumb + folder list + document grid; URL-driven (`?path=`); works on deep nesting.

## M6 — Search

- [x] **M6.1 — Search API (FTS + semantic + hybrid)**
  **Goal:** find by words and by meaning.
  **Docs:** [`07`](../07-api-specification.md) (search), [`04 §4.3–4.4`](../04-database-schema.md)
  **Acceptance (e2e):** text mode: `websearch_to_tsquery('simple')` + `ts_headline` snippet, finds title and body matches; semantic mode: query embedding → HNSW top-k → grouped by document; hybrid: RRF (k=60) merge, deterministic order; access filtering inside SQL (RESTRICTED docs never surface — test with two users); provider unset → `semanticAvailable:false`, hybrid falls back to text; filters (library/document type) apply.

- [x] **M6.2 — UI: search**
  **Goal:** the search screen + global search input.
  **Docs:** [`11 §11.6`](../11-ui-ux-spec.md#116-search-searchq), [`11 §11.1`](../11-ui-ux-spec.md#111-shell--navigation)
  **Acceptance:** mode toggle (semantic disabled with tooltip when unavailable); snippet highlighting; filters; topbar input navigates to `/search?q=`; empty/no-results states.

## M7 — Collections & sharing

- [x] **M7.1 — Collections API + shares + user lookup**
  **Goal:** organize and share.
  **Docs:** [`07`](../07-api-specification.md) (collections, lookup), [`03 §3.3.13–3.3.15`](../03-domain-model.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Acceptance (e2e):** CRUD with per-owner name uniqueness; items add/remove (add requires read access); shares: user-specific + instance-wide incl. unique-active constraints; viewer sees the intersection rule of 03 §3.3.14 (LIBRARY docs filtered by own access; shared DERIVED docs readable via the share — both directions tested); share grants no library-doc access; lookup returns ≤10 active users.

- [x] **M7.2 — UI: collections**
  **Goal:** collections screens + viewer integration.
  **Docs:** [`11 §11.7`](../11-ui-ux-spec.md#117-collections-collections-collectionsid)
  **Acceptance:** My/Shared-with-me groups; detail grid with owner-only edit affordances; share modal (autocomplete + everyone switch + revoke list); "Add to collection" live in the viewer sidebar (replaces M5.6 stub).

## M8 — Scan sets

- [x] **M8.1 — Scan sets API + merge handler**
  **Goal:** the passport scenario end to end on the backend.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-scan-sets-merging-into-a-pdf-on-explicit-request), [`03 §3.3.16–3.3.17`](../03-domain-model.md), [`07`](../07-api-specification.md) (scan sets)
  **Acceptance (e2e + integration):** CRUD with the DRAFT/FAILED-only edit rule (`SCANSET_INVALID_STATE`); non-image item → `SCANSET_ITEM_NOT_IMAGE`; merge: TRIM crops via sharp, NONE doesn't; result = DERIVED document (owner, provenance, `source.pdf` in S3) enqueued into the standard pipeline; identical result content → existing document reused; failure records error, retry after edit works; handler idempotent.

- [x] **M8.2 — UI: scan-set builder + grid multi-select**
  **Goal:** the flow is usable.
  **Docs:** [`11 §11.8`](../11-ui-ux-spec.md#118-scan-sets-scan-sets-scan-setsid)
  **Acceptance:** list with status tags; builder: drag-reorder strip, image picker, crop toggle, merge button, live status, failure panel, result link; documents-grid multi-select → "Create scan set from selection" (non-images skipped with notice).

## M9 — Hardening & release

- [x] **M9.1 — Maintenance job + admin metrics**
  **Goal:** the instance stays clean and observable.
  **Docs:** [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`06 §6.3.2`](../06-backend-architecture.md#632-job-handlers), [`09 §9.5`](../09-file-storage.md#95-operational-notes)
  **Acceptance:** hourly cron purges expired EmailVerifications/invites/resets and orphaned S3 objects; S3 usage aggregation cached and shown on the queue overview; pipeline/document counters on the overview match reality (test).

- [x] **M9.2 — Mandatory-scenario audit + coverage gates**
  **Goal:** every scenario of 14 §14.8 provably covered.
  **Docs:** [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a checklist in the PR maps each mandatory scenario to a test file/name; missing ones implemented; coverage thresholds (domain+application ≥90% lines) enforced in `vitest.config`; CI green.

- [x] **M9.3 — Release v0.1.0**
  **Goal:** a deployable, documented first release.
  **Docs:** [`12 §12.7–12.8`](../12-build-config-run.md), [`13`](../13-ci-cd.md)
  **Acceptance:** fresh-instance walkthrough executed against the built image (onboarding → add library over a real folder → scan → processed docs → search → scan-set merge) and recorded in the PR; root `README.md` quickstart verified; tag `v0.1.0` → GHCR image with semver tag; CLAUDE.md updated with the real build/lint/test commands (closing the "Project status" placeholder).

## M10 — Correcting what the machine read

- [x] **M10.1 — Pick a language by its name**
  **Goal:** the languages field offers every language rather than only the ones already on the document.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** the picker lists every language `Intl` can name, searched by that name ("Rus" finds "Russian (ru)"); tags the document already carries that no two-letter sweep finds (`sr-Latn`) stay on the list; a typed tag is still accepted.

- [x] **M10.2 — OCR asks for a language the recognizer has**
  **Goal:** a Russian scan stops failing the text step on an instance whose Stirling never had `rus`.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [ADR-018](../02-architecture-overview.md), [`12 §12.5–12.6`](../12-build-config-run.md)
  **Bug:** a JPEG whose languages are known to be `ru` sends `rus` to Stirling, whose stock image carries `chi_sim deu eng fra osd por` only, and the step dies on `Invalid OCR languages format: none of the selected languages are valid`. The same instance's Docling has the languages, because only Docling was ever given an image of its own.
  **Acceptance:** Stirling is built from a `deploy/stirling` image carrying the same tesseract languages as `deploy/docling`, in dev compose and in the deployment example; the step no longer fails on a recognizer missing a language — the failure names the codes asked for and the service asked, rather than passing on a Java stack trace.

- [x] **M10.3 — Apply what the pipeline read in one click**
  **Goal:** "read as Russian" under a corrected field is the way to put it back, without opening the form.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`03 §3.3.10`](../03-domain-model.md)
  **Acceptance:** the grey "read as …" line is a control in read mode; one click sends the same `reset` the form's reset button sends (never the value typed in, so a document type goes back to `AUTO`); the row settles to the read value without an edit session; nothing else on the document travels with it.

- [x] **M10.4 — The analysis names the document**
  **Goal:** a title read from the document itself, correctable by hand like every other read field.
  **Docs:** [`03 §3.3.10`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`07`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** the analysis answers a title; it is applied only where nobody has chosen one (a file name is not a choice), recorded in `autoValues.title` either way; `PATCH /api/documents/:id` takes `title` and the viewer shows "read as …" and the reset for it exactly as it does for the document type.

- [x] **M10.5 — The log says which service did the work**
  **Goal:** a step in the log can be followed into the service that ran it.
  **Docs:** [`03 §3.3.18`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** every `STEP_STARTED`/`STEP_FINISHED` carries the service it talks to and a request id shared by the pair; the id travels to the external service as `X-Request-Id` and appears in this instance's own log lines for that step; the host is shown to an admin only, and stripped from the payload for everyone else.

- [x] **M10.6 — The analysis says what a document is, in a sentence**
  **Goal:** an unfamiliar document can be judged without opening it.
  **Docs:** [`03 §3.3.10`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`07`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** `Document.description` — a few hundred characters answering what this is, who it is between and what it is for; answered by the analysis, applied only where the field is empty, recorded in `autoValues.description` either way; `PATCH /api/documents/:id` takes it and `reset: ['description']` puts it back; the viewer shows it under the title, editable in place.

- [x] **M10.7 — Subject kinds become a catalogue**
  **Goal:** what sort of thing a subject is stops being free text on every row.
  **Docs:** [`03 §3.3.20`](../03-domain-model.md), [`04`](../04-database-schema.md), [`07`](../07-api-specification.md)
  **Acceptance:** a `SubjectKind` table with a forward-only migration that backfills one row per living `subjects.kind` and repoints the rows; `Subject.kindId` replaces `Subject.kind`; reading and adding a kind are open to anyone, renaming and removing are an admin's, and a kind still used by a living subject cannot be removed; the analysis resolves a kind it names and creates the missing one; browsing by kind keeps working.

- [x] **M10.8 — Manage people, subjects and kinds outside a document**
  **Goal:** the catalogues have screens of their own, so correcting one is not an edit of some document that happens to name it.
  **Docs:** [`11 §11.12`](../11-ui-ux-spec.md#1112-admin-document-types-admindocument-types)
  **Acceptance:** `/admin/people`, `/admin/subjects` and `/admin/subject-kinds` are tables in the pattern of the document types — create, rename, delete behind a confirmation that says how many documents it reaches — reachable from the admin menu and closed to everyone else.

- [x] **M10.9 — The text tab is typeset, not just rendered**
  **Goal:** extracted Markdown reads like a document rather than like unstyled HTML.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`11 §11.15`](../11-ui-ux-spec.md#1115-visual-identity--the-reading-room)
  **Acceptance:** headings, paragraphs and lists carry the reading-room rhythm rather than the browser's defaults — no stray leading margin at the top, spacing that groups rather than separates; tables fill the pane with real cell borders, header weight and horizontal scrolling instead of overflowing; code, quotes, links and images are styled to match; long OCR output stays readable at every width.

- [x] **M10.10 — Merge what the analysis saw twice**
  **Goal:** four rows for one flat — or one person spelled three ways — become one row, without losing a single document.
  **Docs:** [`03 §3.3.19–20`](../03-domain-model.md), [`07`](../07-api-specification.md), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-admin-catalogues-adminpeople-adminsubjects-adminsubject-kinds)
  **Acceptance:** rows are selectable on `/admin/people` and `/admin/subjects`; **Merge** asks for the surviving name — offered as a choice among the selected ones, or typed — and, for subjects, for the kind when the selected rows disagree; every document link moves to the survivor with duplicates collapsed, the others are soft-deleted, and no document loses the person or the thing it named; an admin's, and refused when the result would collide with a row that was not selected.

- [x] **M10.11 — A kind is named in the owner's own words**
  **Goal:** "Квартира" stops being turned into "apartment".
  **Docs:** [`03 §3.3.20a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** a kind is stored exactly as it is typed, in any language and any case, while remaining unique case-insensitively; the analysis is shown the kinds the catalogue already has and reuses one rather than inventing a synonym, and names a new one in the document's own language.

- [x] **M10.12 — The count is the way to the documents**
  **Goal:** "40" in a catalogue row is a question, and clicking it should answer it.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-admin-catalogues-adminpeople-adminsubjects-adminsubject-kinds), [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browse)
  **Acceptance:** the documents count on `/admin/people` and `/admin/subjects` links to that person's or that thing's browse page; a count of zero is plain text, since there is nothing to go to.

## M11 — Uploading, throughput, and knowing a thing again

- [x] **M11.1 — An upload is a queue on the page, not a modal that blocks**
  **Goal:** choosing forty files puts forty cards on the screen at once and fills them in one by one.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`05 §5.1a`](../05-library-and-processing.md#51a-uploads)
  **Acceptance:** the chosen files appear in the grid immediately as client-side cards marked "uploading", before a byte is sent; they upload **one at a time**, in order, however many there are; each becomes the real server card as it lands; pressing Upload again appends to the same queue rather than replacing it; a failure marks its own card and the queue carries on.

- [x] **M11.2 — The queue's throughput is a setting, not a rebuild**
  **Goal:** an admin can tune how hard the instance works without editing env and restarting.
  **Docs:** [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue)
  **Acceptance:** `/admin/queue` sets, per job type, how many run at once — and, within one job, how many of its own units run in parallel (pages of a document, files of a scan); the values take effect without a restart and survive one; the defaults stay what `12 §12.4` documents.

- [x] **M11.3 — A subject says how to recognise it**
  **Goal:** the analysis matches a document to a thing already in the catalogue instead of inventing a fifth spelling of it.
  **Docs:** [`03 §3.3.20`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** a subject carries a description — the address, the plate, the account number, whatever identifies *this* one — written by hand or by the analysis; the analysis is given the catalogue's things with their descriptions and links an existing one when the document is about it, creating a row only when nothing matches. **Why now:** after the first months almost no genuinely new things appear, so the job stops being "read a name" and becomes "recognise which one of these".

- [x] **M11.4 — One language for everything the machine writes**
  **Goal:** an archive does not end up with a Russian title over an English description.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.10`](../03-domain-model.md), [`12 §12.4`](../12-build-config-run.md)
  **Acceptance:** the instance says which language the analysis writes in — the title, the description, and the names it invents for people, things and their kinds — rather than each field following whatever the document happened to be written in; documents already processed keep what they have until they are analysed again. **Open:** whether this is an env value like the rest of the pipeline settings, or a row on an admin settings screen (which M11.2 needs anyway) — the second is friendlier and the first is how every other processing setting works today.

- [x] **M11.5 — The catalogues are content, not administration**
  **Goal:** people, things, kinds and document types stop living behind an admin door.
  **Docs:** [`11 §11.1`](../11-ui-ux-spec.md#111-shell--navigation), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-admin-catalogues-adminpeople-adminsubjects-adminsubject-kinds)
  **Acceptance:** they move out of `Administration` to their own places in the menu, beside Documents and Browse, and off the `/admin` routes; anyone signed in may read them and add to them, exactly as the API has always allowed; renaming, deleting and merging stay an admin's and simply are not offered to anyone else, rather than the whole screen being hidden.

## M12 — Reading the instance from outside

- [x] **M12.1 — A script may read the archive; nothing but a browser may change it**
  **Goal:** an export job, a backup, an assistant — anything that needs to *read* this instance gets a credential of its own, and it can only read.
  **Docs:** [`03 §3.3.22`](../03-domain-model.md), [`08 §8.2a`](../08-auth-and-authorization.md#82a-api-tokens-read-only), [`07 §7.1–7.3`](../07-api-specification.md), [`11 §11.9`](../11-ui-ux-spec.md#119-settings-settings)
  **Acceptance:** a user issues a named, expiring token to themselves on `/settings` and sees the secret exactly once; `Authorization: Bearer` authenticates every `GET` the owner could make, with their role and their visibility, and nothing else — any other method on `/api` is refused with `READ_ONLY_TOKEN` before routing, valid token or not; only the hash is stored; revoking, expiry, and deactivating the owner each end it on the next request; the token list says when each was last used.

## M13 — A file is not a document

The refactor of [`02 ADR-021`](../02-architecture-overview.md): files and documents become two
things, every document gains a rebuildable canonical PDF, and scan sets are replaced by editing the
composition of a document. Tasks are ordered by dependency — M13.1 lands first and alone, the rest
build on it.

- [x] **M13.1 — Two tables where there was one**
  **Goal:** the bytes get a row of their own, and a document becomes an ordered list of them.
  **Docs:** [`03 §3.3.9–3.3.10, §3.3.16–3.3.17`](../03-domain-model.md), [`04 §4.1`](../04-database-schema.md), [`05 §5.3`](../05-library-and-processing.md)
  **Acceptance:** `files` and `document_files` exist; a file carries the content hash, mime, size, name, origin, storage key and crop that used to sit on the document; `file_refs.file_id` replaces `document_id`; the dedup unique moves to `files`; every existing document keeps working as a one-file document and every existing scan set is gone, its result documents intact; the FTS, HNSW and partial-unique objects survive the migration untouched.

- [x] **M13.2 — Every document is a PDF**
  **Goal:** one artifact to view, download, OCR and search, whatever the document is made of.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`09 §9.2`](../09-file-storage.md)
  **Acceptance:** step 1 builds `canonical.pdf` for every document — images cropped and laid one per page, office and text converted, PDFs taken as they are, parts merged in position order; a merged PDF with too thin a text layer is OCR'd into a searchable one and that is what is stored; the title and date are stamped into its metadata best-effort; page count comes from it; steps 2–5 read it and nothing else; a file whose format nothing can render leaves the step incomplete with `UNSUPPORTED_FORMAT` instead of failing the document.

- [x] **M13.3 — The crop is a quadrilateral**
  **Goal:** a page photographed at an angle comes out flat and rectangular.
  **Docs:** [`03 §3.3.16`](../03-domain-model.md), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files)
  **Acceptance:** a file carries four normalized points and who chose them; building the canonical applies them as a perspective transform whose output size comes from the quad's own edges; a `MANUAL` crop is never overwritten by a rebuild; the geometry is pure, framework-free and unit-tested against known homographies.

- [x] **M13.4 — The corners find themselves**
  **Goal:** "auto-detect corners" answers with the page, not with the table it is lying on.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** grayscale → Sobel → Hough finds the dominant near-horizontal and near-vertical lines and intersects the strongest well-separated pair into a quad; a picture with no convincing page falls back to the content bounding box and says which method answered; the detector is pure and tested on synthetic pages, including a rotated one and one that fills the frame.

- [x] **M13.5 — Composition is editable**
  **Goal:** add a file, reorder, split one off, combine documents — and the document rebuilds itself.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** the six routes of `07` behave as documented, each answering with the whole document and enqueueing a rebuild; splitting off a file creates a document of its own and refuses to empty the last one; combining moves files in the chosen order and soft-deletes the emptied documents; a file already in a document cannot be attached to another; access is the document's own, and every change is recorded as a document event.

- [x] **M13.6 — Download the document, or what it was made of**
  **Goal:** "Download" means the PDF; the originals are one level down and always reachable.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.5b`](../11-ui-ux-spec.md#115b-download-the-document-or-what-it-was-made-of)
  **Acceptance:** `/canonical` serves the assembled PDF as an attachment on demand and refuses honestly while it is being built; `/files/:fileId/content` streams one original from the volume or redirects to its signed URL; the old `/source` route is gone; a document whose volume vanished still downloads as a PDF and says its originals are missing.

- [x] **M13.7 — The viewer shows the document, and the details show the files**
  **Goal:** the reading surface stops being "whatever the single file happened to be".
  **Docs:** [`11 §11.5, §11.5a, §11.5b`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** the preview tab embeds the canonical for every document; the details tab grows a Files section — thumbnail, name, kind, size, library path, missing badge — with per-row download, move up/down and split-off, and an Add files queue above it; the Download control is a split button with the originals in its dropdown; the grid shows a file count and a partial-availability badge.

- [x] **M13.8 — Dragging the corners**
  **Goal:** the crop is something a person can see and adjust, not a number in a database.
  **Docs:** [`11 §11.5c`](../11-ui-ux-spec.md#115c-the-crop-editor)
  **Acceptance:** a modal over the image with four draggable handles, a dimmed outside, keyboard nudging, Auto-detect corners filling them from the server's proposal, Reset clearing the crop and Save storing it and rebuilding; the editor is a component of its own with its own tests and no knowledge of how the transform is applied.

- [x] **M13.9 — Scan sets are gone**
  **Goal:** one way to say "these are one document", not two.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`07`](../07-api-specification.md)
  **Acceptance:** the `/scan-sets` routes, screens, entity, contracts, API, job, repository and tables are gone; the documents grid's multi-select says Combine and calls the new route; nothing in the product mentions a scan set; the release notes say what happened to the old ones.

- [x] **M13.10 — These look like one document**
  **Goal:** forty scans that arrived together are offered as one document instead of being found by hand.
  **Docs:** [`05 §5.6a`](../05-library-and-processing.md#56a-noticing-that-files-belong-together), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** single-file image documents in one folder whose names form a consecutive sequence and whose mtimes fall inside `GROUPING_WINDOW_MINUTES` are proposed as a group, newest first, at most twenty; a document somebody has already titled, typed or filed is never proposed; the suggestion cards on the grid combine or dismiss, and dismissing is client-side; nothing about a suggestion is stored.

## M14 — Repairs and the operator's view

- [x] **M14.1 — Merging a thing into its own name**
  **Goal:** picking the surviving name from the list of names being merged stops answering 500.
  **Docs:** [`03 §3.3.19–3.3.20`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** the merged rows are soft-deleted before the survivor is renamed, so a name that belongs to one of them is free by the time it is taken; merging into a name held by a row that was *not* selected is still `409`; people and subjects behave the same, and both cases are tested.

- [x] **M14.2 — A merge keeps what the rows carried**
  **Goal:** the note nobody wants to lose is offered rather than dropped.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-admin-catalogues-adminpeople-adminsubjects-adminsubject-kinds)
  **Acceptance:** the merge dialog's note arrives prefilled with the names about to disappear and every note the selected rows had, editable before confirming, and empty when there was nothing to keep.

- [x] **M14.3 — Saving a person, and a date**
  **Goal:** choosing a person in the editor and pressing Save actually saves.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** the viewer's save sends `peopleIds`, `subjectIds` and `documentDate` when they changed and only when they changed, alongside the fields it already sent; a change to any one of them alone produces exactly one request; covered by tests that would have caught the silence.

- [x] **M14.4 — A counter is a way to the documents**
  **Goal:** "12 failed previews" becomes those twelve documents.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue)
  **Acceptance:** `GET /api/documents` filters by `step` + `stepStatus` (either alone is a `422`); every number on the queue screen links to that filter; the documents screen shows the filter and can clear it.

- [x] **M14.5 — A queue can be paused, and a step can be run again**
  **Goal:** an operator can stop one misbehaving step and re-run what failed, without a restart and without opening five hundred documents.
  **Docs:** [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`07 §7.3`](../07-api-specification.md), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue)
  **Acceptance:** `paused` joins the queue settings and takes effect immediately by re-registering the workers; a paused queue accepts jobs and runs none, and says so wherever its depth is shown; `POST /api/admin/queue/reprocess` re-enqueues every document whose step sits in a status, bounded per call, and answers with how many.

- [x] **M14.6 — What this server is actually running**
  **Goal:** the operator's questions answered on a page instead of inside a container.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.13a`](../11-ui-ux-spec.md#1113a-admin-instance-admininstance), [`12 §12.4`](../12-build-config-run.md)
  **Acceptance:** `/admin/instance` shows the effective configuration grouped as `12 §12.4` groups it, each row saying where the value came from; 🔒 no secret is ever a value — a password, key or token reads as Set or Not set, and `DATABASE_URL` appears decomposed without its password; a test proves that a configured secret's value appears nowhere in the response.

## M15 — Closing what the audit found

The findings register is [`security-audit-2026-08.md`](./security-audit-2026-08.md); every task below
names the `SEC-nn` ids it closes, and the register holds the evidence, the attack, and the options.
Tasks are ordered by what an attacker reaches first, not by how hard they are.

Three of these need a **documentation decision before any code** — M15.13, M15.17 and M15.19 change
behaviour that `docs/08` currently specifies, so per golden rule 3 the doc moves first and the task
is blocked until it has. Each says so in its Goal.

Every task ends the same way: the scenario it fixes joins
[`14 §14.8`](../14-coding-standards.md#148-testing) and
[`scenario-coverage.md`](./scenario-coverage.md), with a test that fails on today's tree.

- [x] **M15.1 — A share is not a licence to re-share**
  **Goal:** a document its owner shared with one person stops being publishable to the whole instance by that person.
  **Closes:** SEC-01, SEC-26
  **Docs:** [`03 §3.3.15`](../03-domain-model.md), [`03 §3.4`](../03-domain-model.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Options (decide in the PR description):** (1) add `document.createdById = collection.ownerId` to the share branch of the access predicate in both dialects — smallest, fixes read and search at once, and the predicate gets simpler because the owner alternative collapses into the existing creator branch; (2) refuse the add in `AddCollectionItem` instead — fails at the mistake rather than silently, but breaks curating a collection of library documents and repairs nothing already laundered; (3) document-level ACLs — disproportionate, and contradicts `03 §3.4`.
  **Acceptance:** a document reachable only through somebody else's share cannot be made readable to a third party by adding it to a second collection — proven end to end with three users, through `GET /api/documents/:id`, `/canonical`, `/markdown` **and** `/api/search`, because the rule lives in two dialects and both must hold; revoking the first share removes the access it granted with nothing surviving in a second collection; `DELETE /api/collections/:id/shares/:shareId` answers 404 for a share belonging to another collection; a query is written and run that lists items already laundered, and what it found is recorded in the PR.

- [x] **M15.2 — A login lands where it started**
  **Goal:** `?returnTo=` stops being a way to hand a signed-in person to somebody else's page.
  **Closes:** SEC-02
  **Docs:** [`10 §10.2`](../10-frontend-architecture.md), [`11 §11.2`](../11-ui-ux-spec.md)
  **Acceptance:** a `safeReturnTo` helper in `src/web/shared/lib` resolves the candidate against the current origin and keeps only `pathname + search + hash` when the origins match, falling back to `/documents` otherwise; it is applied at **both** sinks — the login form and the auth wizard — not at the one place that reads the query today, so the next feature to wire the prop inherits the guard; unit tests cover an absolute off-origin URL, protocol-relative `//host`, backslash variants, a same-origin path with a query and hash, and `javascript:`; the `javascript:` case is additionally checked in a real browser and the result recorded in the PR, because whether it navigates or executes decides whether this was a redirect or an XSS.

- [x] **M15.3 — Nothing uploaded can run in a browser**
  **Goal:** a file a user uploads is served as bytes to save, never as a page to execute.
  **Closes:** SEC-03
  **Docs:** [`09 §9.1`](../09-file-storage.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Options (decide in the PR description):** (1) set `ResponseContentDisposition` and `ResponseContentType` on the presign — one choke point, retroactive for objects already in the bucket, and the signature covers the overrides so they cannot be stripped; the preview and canonical paths then need `inline` plus their real type, so the port grows a "how is this served" argument; (2) normalize the stored `ContentType` to `application/octet-stream` off a render allow-list — two lines, but leaves existing objects and the next careless presign unprotected; (3) stream managed originals through the app like library ones, so the existing `nosniff` + `attachment` block applies uniformly — one rule for all file serving, but it gives up range requests, so it fits `…/files/:fileId/content` only.
  **Acceptance:** an uploaded `.html`, `.htm`, `.svg` and `.xml` are each retrieved through `GET /api/documents/:id/files/:fileId/content` and none of them arrives with a content type a browser will render as a document; `X-Content-Type-Options: nosniff` and a `Content-Disposition` are present on **every** file-serving response, the redirect branch included — the branch that skips them today; the preview, thumbnail and canonical PDF still display inline in the viewer; whichever option is chosen, option 2 is also applied as depth.

- [x] **M15.4 — An invite is used once, and a reset is still valid when it is spent**
  **Goal:** one invite link stops being able to mint a second admin nobody can see.
  **Closes:** SEC-04, SEC-24, SEC-28
  **Docs:** [`08 §8.1.2`](../08-auth-and-authorization.md#812-admin-invite), [`08 §8.1.6`](../08-auth-and-authorization.md#816-password-reset-admin-initiated)
  **Acceptance:** `CompleteRegistration` re-checks `isInviteValid` **inside** the transaction and `markAccepted` is a conditional write whose zero-row result is `INVITE_INVALID`, so two completions racing on one invite produce exactly one account; the same for a password reset — validity and the target account's active state are re-read at completion, and `markUsed` is conditional; verifying an email code makes the attempt counter the gate rather than a value read before it is written, so N concurrent guesses consume N attempts; tests cover one invite driven to completion twice (sequentially and concurrently), an account deactivated inside the ticket window, and a burst of concurrent verifies.

- [ ] **M15.5 — A log is not a place to keep credentials**
  **Goal:** reading the application log stops being a way to take over an account.
  **Closes:** SEC-10, SEC-18
  **Docs:** [`08 §8.1.2`](../08-auth-and-authorization.md#812-admin-invite), [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist), [`12 §12.4`](../12-build-config-run.md)
  **Acceptance:** the request serializer logs a route-shaped URL, so an invite or reset token in a path segment reaches no log line; the document filename headers and the search query are redacted or dropped by an explicit decision recorded in the code; `LogEmailSender` logs the recipient and subject and never the body; under `NODE_ENV=production` an empty `SMTP_HOST` refuses to start unless an explicit opt-in is set, so the demo path cannot be reached by accident on a real instance, and `deploy/init.sh` and `12 §12.8` say how the first admin is created instead; a test drives an invite preview and a reset preview and asserts the token appears in no emitted log record.

- [x] **M15.6 — The server knows who is really calling**
  **Goal:** rate limiting stops being switched off by a header the caller writes themselves.
  **Closes:** SEC-05, SEC-36
  **Docs:** [`06 §6.4`](../06-backend-architecture.md), [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha), [`12 §12.4`](../12-build-config-run.md), [`12 §12.8`](../12-build-config-run.md)
  **Options (decide in the PR description):** (1) a `TRUST_PROXY` setting defaulting to off — correct for both topologies, and an operator behind a proxy who forgets it gets over-throttling, which is the safe direction to fail; (2) put a reverse proxy in the shipped compose and stop publishing the app port — also brings the TLS the `Secure` cookie already rewards, at the cost of a heavier default stack. Whichever is chosen, add a concurrency bound around password hashing so no future keying mistake can saturate the libuv threadpool again.
  **Acceptance:** `X-Forwarded-For` changes nothing about which bucket a request falls into unless the deployment is configured to sit behind a proxy; `12 §12.8` stops describing `trust proxy` as simply "already set" and says what it costs without an ingress; concurrent password verifications are bounded and the bound is exercised by a test; `/api/health` is throttled generously enough that a five-second container probe never trips it, or answers from a short-lived cache.

- [x] **M15.7 — Headers that say no**
  **Goal:** the instance stops being framable, sniffable and free of any policy about what may execute.
  **Closes:** SEC-06, SEC-37
  **Docs:** [`02 §2.2`](../02-architecture-overview.md#22-entry-point-servermaints-integration-contract), [`12 §12.8`](../12-build-config-run.md)
  **Options (decide in the PR description):** (1) helmet with a permissive CSP in `Report-Only` — fifteen lines, works unchanged with Ant Design's CSS-in-JS, delivers `frame-ancestors`, HSTS, nosniff and `Referrer-Policy` immediately, but `script-src 'unsafe-inline'` is a floor rather than a defence and must not be mistaken for one; (2) a nonce-based CSP threaded through the Ant Design registry — the only option that actually stops the XSS in SEC-03, and the most expensive: nonces disable static optimization and the custom Express dispatcher needs care; (3) the non-CSP headers globally now plus a strict `default-src 'none'` on `/api` only, with the page CSP deferred to a tracked task. Recommended: 3 now, 2 next; not 1 alone.
  **Acceptance:** every response carries `X-Content-Type-Options`, `Referrer-Policy`, a frame policy that refuses embedding, and — only when the instance is served over HTTPS — HSTS, because turning it on for the `http://<lan-ip>` deployments `08 §8.2` deliberately supports would lock their operators out; the policy is built from `AppConfig` at boot rather than written as a constant, because presigned URLs point the browser at `S3_PUBLIC_ENDPOINT` and a static policy would block the viewer; neither Express nor Next advertises itself; a test asserts the header set on a page response and on an `/api` response, and the deferred page CSP is a task in this backlog rather than a comment.

- [ ] **M15.8 — Dependencies with known holes, and a pipeline that would have said so**
  **Goal:** the image stops shipping a native image decoder with four open CVEs, and stops being able to do it again quietly.
  **Closes:** SEC-07, SEC-21
  **Docs:** [`13 §13.1–13.2`](../13-ci-cd.md), [`12 §12.6`](../12-build-config-run.md#126-dockerfile-one-image)
  **Acceptance:** `npm audit --omit=dev` reports nothing of high severity or above; `sharp` and `nodemailer` are on majors that carry the fixes and the breaking changes they bring are absorbed with the suite green; `ci.yml` declares a least-privilege `permissions:` block like `release.yml` already does; every third-party action is pinned to a commit SHA with the version in a comment; a dependency audit runs in CI and fails the build above a chosen threshold, and an image scan runs on release; Dependabot (or an equivalent) is configured so the next advisory arrives as a pull request rather than as an audit finding.

- [x] **M15.9 — One document cannot take down the server**
  **Goal:** a file chosen to be expensive costs its own processing step and nothing else.
  **Closes:** SEC-08, SEC-17, SEC-20, SEC-25
  **Docs:** [`05 §5.4–5.5`](../05-library-and-processing.md#54-job-queue-pg-boss), [`09 §9.1`](../09-file-storage.md), [`12 §12.4`](../12-build-config-run.md)
  **Acceptance:** every `sharp` pipeline declares a pixel budget and the process-wide cache and concurrency are set once at load, so a small file that decodes to a gigabyte fails its step with a recorded reason instead of ending the process — which in a one-process architecture is also the HTTP surface; every outbound call carries a timeout and reads its response through a bound, the captcha check included, because that one sits on the login path; `toBuffer` takes a maximum and library ingest refuses a file above it using the size it already knows before reading; the search headline runs over a bounded prefix of the Markdown and the text query is computed once rather than three times; a `statement_timeout` is set for the application role; each of these has a test that would hang or exhaust memory without it.

- [x] **M15.10 — The container is not root, and does not hold the keys to everything**
  **Goal:** a hole in a native library stops being a hole in the host.
  **Closes:** SEC-09, SEC-14, SEC-22, SEC-43
  **Docs:** [`12 §12.6`](../12-build-config-run.md#126-dockerfile-one-image), [`12 §12.5`](../12-build-config-run.md#125-local-development), [`12 §12.8`](../12-build-config-run.md)
  **Acceptance:** the runtime image drops to an unprivileged user and the shipped compose adds `cap_drop`, `no-new-privileges`, a memory limit and a read-only root filesystem with an explicit writable path for what genuinely needs one; the application is given a scoped object-store service account limited to its own bucket rather than the store's root credentials, and root stays for administration; the development compose binds its five services to loopback instead of every interface; migrations run as a one-shot step with a role that may change the schema, and the application connects with one that may not; the image still starts, serves `/api/health`, and processes a document end to end under all of it.

- [x] **M15.11 — Configuration that refuses to run insecurely**
  **Goal:** the published example secret stops being a working production secret.
  **Closes:** SEC-15, SEC-23, SEC-39
  **Docs:** [`12 §12.4`](../12-build-config-run.md), [`11 §11.13a`](../11-ui-ux-spec.md#1113a-admin-instance-admininstance)
  **Acceptance:** under `NODE_ENV=production` the configuration loader refuses the example `AUTH_SECRET` and the example S3 credentials by value, and says which ones in the same collected-errors style the loader already uses; the S3 credentials lose their defaults entirely, so an unconfigured instance fails rather than works with a published key; a plain-HTTP `APP_BASE_URL` in production is a loud warning that names what it costs — the `Secure` attribute on the session cookie; the loader asserts that `S3_PUBLIC_ENDPOINT` and `APP_BASE_URL` are different origins, because the PDF viewer's isolation silently depends on it; a test asserts that every configuration key whose name contains `SECRET`, `PASSWORD`, `KEY` or `TOKEN` is on the instance page's redaction list, so the next secret added is caught by CI rather than by an admin's screenshot.

- [x] **M15.12 — The archive cannot be talked into leaking**
  **Goal:** a document stops being able to give the analysis instructions.
  **Closes:** SEC-11
  **Docs:** [`05 §5.5`](../05-library-and-processing.md), [`03 §3.3.19–3.3.20`](../03-domain-model.md)
  **Options (decide in the PR description):** (1) a nonce-delimited fence with the nonce stripped from the excerpt — five lines, removes the escape but not an obedient model; (2) instructions and catalogue in the system message, the excerpt alone in the user message, stated as data — cheap and standard, soft by nature; (3) stop putting the instance-wide catalogue next to untrusted text, or scope it to what the document's owner can already see — the only one that removes the disclosure rather than raising its cost, at some cost to classification quality; (4) let analysis link to existing people and subjects freely but require confirmation before a **new** catalogue row is created — removes the poisoning permanently, adds a review step. Recommended: 1+2+3 for the disclosure, 4 for the poisoning.
  **Acceptance:** a fixture document whose text instructs the model to copy the known-subjects list into a field does not produce a document whose title, description, people or subjects contain another user's catalogue entries; the excerpt cannot terminate its own delimiter; whatever is chosen for new catalogue rows, an operator can tell from the UI which rows analysis proposed and which a person confirmed.

- [ ] **M15.13 — A lockout that cannot be pointed at somebody**
  **Goal:** knowing an address stops being enough to keep its owner out indefinitely.
  **Closes:** SEC-12, SEC-19
  **Blocked on a decision:** the current behaviour is exactly what `08 §8.4` specifies, so this task cannot start until `docs/08` says something different. Bring the options to the owner first.
  **Docs:** [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)
  **Options:** (1) verify the password first and apply the backoff only to failures, so the legitimate owner is never locked out — but the expensive hash then runs before the cheap gate, which only works together with the hashing bound from M15.6; (2) key on address **and** address+origin, keeping the per-address delay small and letting the per-origin one grow — an attacker spread across many origins regains speed unless a captcha is required after N failures; (3) replace the lockout with a mandatory captcha after N failures — no lockout at all, but a hard dependency on a captcha that is optional today and a no-op when unconfigured.
  **Acceptance:** whatever `08 §8.4` ends up specifying, a person who knows their own password can sign in while somebody else is failing against their address; an invite whose `emailHint` is set only starts a registration for that address; the send throttle is keyed per purpose, so flooding an address with registration letters cannot deny it a password reset; a code series is chosen by the purpose being verified rather than by which one is found first; the attempt and throttle state survives a restart, because a crash loop currently resets every cap.

- [x] **M15.14 — The event log respects the same walls as everything else**
  **Goal:** a document's history stops naming folders inside libraries the reader cannot open.
  **Closes:** SEC-13
  **Docs:** [`03 §3.3.18`](../03-domain-model.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model)
  **Options (decide in the PR description):** (1) filter the recorded path by library visibility, which needs the event payload to carry its `libraryId` — forward-only, with older rows falling back to redacted; (2) strip the path from library-sourced events for non-admins, mirroring what the same function already does for the internal endpoint — one line, ships today, and loses a useful detail for readers who *could* see that library; (3) stop recording the event when known bytes turn up in a second library, which loses provenance `03 §3.3.18` exists to keep. Recommended: 2 now, 1 once the payload carries the library.
  **Acceptance:** a user who may read a document because its bytes also live in a library they can see does not learn, from `GET /api/documents/:id/events`, the path those bytes occupy in a library they cannot; the same document's `refs` already hide that path, and a test asserts the two answers agree.

- [ ] **M15.15 — Inputs stay inside their bounds**
  **Goal:** the small sharp edges found across parsing, matching and path handling stop being there.
  **Closes:** SEC-16, SEC-29, SEC-30, SEC-31, SEC-32, SEC-33, SEC-44
  **Docs:** [`05 §5.1`](../05-library-and-processing.md), [`07 §7.1–7.2`](../07-api-specification.md#71-conventions), [`14 §14.4`](../14-coding-standards.md)
  **Acceptance:** an exclude glob whose wildcards multiply is refused by the contract rather than compiled, and the matcher is built once per scan instead of recompiled per directory entry; a browse path containing `%` or `_` matches literally, and the folder listing and its offsets agree; a filename header containing control characters is stripped of them before the path is split, so nothing with a newline reaches a title, an S3 key or another container's multipart part; the library-creation check calls the `realpath` containment function that already exists, so a root reached through an intermediate symlink is refused, and a fixture proves it; both raw-body upload routes are exempt from the body parsers, declared in one place rather than by a path equality that the second route silently missed; the table-separator test is bounded so a megabyte-long line costs nothing; an unparseable cursor answers 422 rather than 500.

- [ ] **M15.16 — An account has a history**
  **Goal:** after an incident it is possible to say who signed in, from where, and when their authority changed.
  **Closes:** SEC-34
  **Docs:** [`06 §6.7`](../06-backend-architecture.md), [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist)
  **Acceptance:** a successful login, a failed login, a lockout, an invite issued and accepted, a password reset issued and completed, a role change, a deactivation, a session revocation and an API token created or revoked each emit one structured record naming the actor, the target, the request id and the time; the records carry no token, code or password, and a test asserts that; the request id is the one the request already has, so a record joins to its request; where these records go, and how long they live, is written down in `06 §6.7`.

- [ ] **M15.17 — A user can look after their own account**
  **Goal:** somebody who thinks their password leaked can change it without asking an administrator.
  **Closes:** SEC-35
  **Blocked on a decision:** `08 §8.1.7` rules out self-service *recovery*; an authenticated *rotation* is a different thing and simply absent. `docs/08` has to say which of these it wants before code is written.
  **Docs:** [`08 §8.1.7`](../08-auth-and-authorization.md), [`08 §8.2`](../08-auth-and-authorization.md#82-server-side-sessions), [`11 §11.11`](../11-ui-ux-spec.md)
  **Acceptance:** whatever `08` decides, the outcome is testable: an authenticated password change that requires the current password and revokes every other session; a user's own sessions listed and revocable on `/settings` beside the API tokens they can already manage; a documented answer on whether a 30-day session should end earlier when idle and whether a role change should re-issue it; `08 §8.2` says what `COOKIE_DOMAIN` costs — every sibling subdomain receives the session cookie — because today it does not.

- [x] **M15.18 — The second layers the documentation promises**
  **Goal:** two claims in `docs/08` that describe a defence in depth become true.
  **Closes:** SEC-27, SEC-42
  **Docs:** [`08 §8.2a`](../08-auth-and-authorization.md#82a-api-tokens-read-only), [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha), [`02 §2.2`](../02-architecture-overview.md#22-entry-point-servermaints-integration-contract)
  **Acceptance:** the session guard refuses to resolve a bearer credential on an unsafe method, so the middleware in front of it stops being the only thing standing between a read-only token and a write — which is what `08 §8.2a` already claims happens; the origin check covers every mutating request rather than every mutating `/api` request, or a lint rule makes it impossible to add a route outside `/api` that could accept one, and `02 §2.2` records which of the two was chosen; a test mutates through the guard with the middleware removed and is refused.

- [ ] **M15.19 — Two questions the audit could not answer**
  **Goal:** decide, in the documentation, two things that are currently accidents rather than choices.
  **Closes:** SEC-40, SEC-41
  **Blocked on a decision:** both behaviours match what `docs/07` and `docs/08` say today. They are here because the consequence looks unintended, not because the code disagrees with the docs — so the owner decides, and the doc changes, before anything is written.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model), [`03 §3.3.19–3.3.20`](../03-domain-model.md)
  **The questions:** (1) the people, subject and subject-kind catalogues are instance-wide, with global document counts, and their rows are mined by analysis from documents the reader may not open — is a name extracted from a restricted library meant to be visible to everyone? If not, the count becomes viewer-scoped and rows a viewer can reach nothing through disappear. (2) A user holding grants on two libraries can combine a document from the restricted one into a document from the open one, and the rebuilt PDF and Markdown then carry its pages to everyone who can see the open library — is `08 §8.5`'s "visible given access to at least one" a statement about deduplicated identical bytes, or a licence to bridge two libraries by hand?
  **Acceptance:** each question is answered in the document that owns it, and whichever answer is chosen has a test proving the behaviour is now deliberate.

- [ ] **M15.20 — The security checklist stops being decoration**
  **Goal:** `08 §8.6` becomes a set of claims something proves, like the mandatory scenarios already are.
  **Closes:** SEC-45
  **Docs:** [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist), [`14 §14.8`](../14-coding-standards.md#148-testing), [`tasks/scenario-coverage.md`](./scenario-coverage.md)
  **Acceptance:** every line of `08 §8.6` maps to the test that proves it, in the table that already exists for the mandatory scenarios, and a line with no test is either given one or struck from the checklist with a reason; the boxes are ticked only once their tests are green — two of them ("single-use invite links", "codes and tickets are never logged") were false when this audit ran, which is what a checklist nobody verifies is worth; `security-audit-2026-08.md` gains a closing note recording which findings were fixed, which were accepted, and by whom.

## M16 — Reading the archive the way you keep it

Two defects in the viewer, and the home screen learning to be arranged. Three decisions were taken
before any of it was written down, because the documentation was silent on all three and each
changes the work by an order of magnitude:

1. **A chosen arrangement lives in the URL**, beside the filters that already live there
   (`11 §11.3`). A view can be linked and bookmarked; it does not follow the person to another
   screen, and that is the accepted cost.
2. **"When did this document last change" means the newest entry in its journal** — any event, not
   only a human edit. Nothing can rank documents by that today, so it becomes a column kept beside
   the log.
3. **Grouping is real groups with real counts, from the server** — not headers drawn over whatever
   the current page happened to contain.

- [x] **M16.1 — The selects say names, not identifiers**
  **Goal:** pressing Edit stops showing a column of UUIDs where people and subjects should be.
  **Docs:** [`10 §10.5`](../10-frontend-architecture.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **The mechanism:** the selected values come from the document, which is polled every five seconds; the option list comes from `/api/people` and `/api/subjects`, fetched once at mount and never again — no `refetchInterval`, `refetchOnWindowFocus` off, and the effect that reacts to a step changing state invalidates the extracted text and the log but not the catalogues. The analysis creates people and subjects *after* that list is frozen, so a value has no option and rc-select falls back to rendering the raw value. A reload fixes it, which is the instability that was reported.
  **Acceptance:** the option list is the union of the catalogue and the names the document itself carries, so a value always has a label even when the catalogue has never heard of it, the request failed, or the row is gone; the catalogues are additionally invalidated when a step changes state, which is the rule `10 §10.5` already states for the viewer's other queries and forgot to extend to these two; a test drives a document whose people arrive after the screen mounted and asserts no UUID is rendered; `10 §10.5` names the catalogues alongside the queries it already lists.

- [x] **M16.2 — A name that is gone says so**
  **Goal:** a person or subject that was deleted from the catalogue stops looking like one that was not.
  **Docs:** [`03 §3.3.19–3.3.20`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-admin-catalogues-adminpeople-adminsubjects-adminsubject-kinds)
  **They stay, and that is not the bug.** `03 §3.3.19`, `07 §7.3` and `11 §11.12a` all say the links survive a deletion, and the confirmation dialog says it to the operator's face — "they stay on the N documents that name them". Removing them would make a shipped sentence a lie. What is missing is any way to *tell*, and the DTO carries nothing to tell it with.
  **Acceptance:** the document detail says, per person and per subject, whether the catalogue still holds it; the viewer strikes such a name through and says why on hover, in both the reading pane and the editor, where it is present but cannot be chosen again; `PATCH /api/documents/:id` refuses an id that has been deleted rather than silently re-linking it — which is what `03 §3.3.19` already promises when it says only new documents stop being able to name them; people and subjects behave identically, and a test proves each.

- [x] **M16.3 — A kind is not an object, and every name is a way in**
  **Goal:** the details pane stops running two facts together, and starts leading somewhere.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`04 §4.4`](../04-database-schema.md)
  **Acceptance:** the subject row becomes two — the kind and the object — rather than one line reading `name · kind`; every person, subject, kind, document type, year and place in the pane is a link to the documents filtered by it; the filters that do not exist yet are added to `GET /api/documents` — `country`, `city` and `subjectKindId` — with the index each needs, since `personId`, `subjectId`, `typeId` and `year` are already there and only the place was missing; `04 §4.4`'s index table is brought back in line, having gone stale when the document date arrived.

- [x] **M16.4 — Where the bytes actually are**
  **Goal:** a document made of uploads stops being silent about where it lives.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`09 §9.2`](../09-file-storage.md), [`11 §11.5a`](../11-ui-ux-spec.md)
  **Acceptance:** a file's location is answered for every file rather than only for the ones on a volume — `refs` is empty for a managed file today, so the viewer says nothing at all about an upload; the object storage is named as such, with the key the bytes are under, in the same place a library file names its volume and path; 🔒 the key is a location and not a way in — it grants nothing without a signed URL, and the pane says so rather than looking like a link.

- [ ] **M16.5 — The shelf can be arranged**
  **Goal:** the newest-scanned order stops being the only one.
  **Docs:** [`07 §7.1`](../07-api-specification.md#71-conventions), [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`04 §4.4`](../04-database-schema.md)
  **This one amends a rule.** `07 §7.1` says in as many words: "Sorting is fixed per endpoint; no arbitrary sort params in MVP." A closed enum of named orders is not an arbitrary sort param, and that sentence has to say so before any of this is written.
  **Acceptance:** `GET /api/documents` takes a `sort` from a closed set — the document's own date (the default, newest first, with the undated *before* everything rather than after), when Legere first saw it, and when it last changed; 🔒 the cursor carries the order it was cut from and a request whose `sort` disagrees with its cursor is refused rather than quietly answered from the wrong column, because the encoding has no version and this is the change that decides how the next one is made; the two orders that no index serves get one — `(document_date DESC NULLS FIRST, id DESC)`, which the existing `NULLS LAST` index cannot be scanned backwards to produce; "when it last changed" is the newest entry in the document's journal, kept as a column beside it and written where every event is already routed through one method (`03 §3.3.18`), because ranking an archive by an aggregate over the log is not something an index can serve; a test walks a second page in every order and asserts the access rule still holds there, the way the collections test already does.

- [ ] **M16.6 — The card shows what you came for**
  **Goal:** the badges under a card stop being one fixed pair.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** `DocumentListDto` carries the fields a card may show — the document's date, its people, its subjects, its place, its languages — fetched per page in the batched way the file counts already are, and not one query per card; the home screen chooses which of them appear, the type and the extension included, so both can be switched off; the choice travels in the URL beside the filters; the four other screens that render the same card keep the arrangement they have today rather than inheriting a home-screen setting.

- [ ] **M16.7 — Real groups, with real counts**
  **Goal:** an archive can be looked at a shelf at a time without leaving the list.
  **Docs:** [`07 §7.1`](../07-api-specification.md#71-conventions), [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** a grouping endpoint answers `{ key, label, count }` for a chosen dimension under the filters in force, in the shape `GET /api/documents/years` already answers in — so the paginated envelope of `07 §7.1` is not broken, because a group's contents are the ordinary list filtered by that group's value; the dimensions offered are the ones that can be filtered, which is what makes the contents reachable at all; a document that belongs to several groups — it has two people — appears under each, and the documentation says so, because the alternative is a card that vanishes from a shelf it belongs on; the counts are the archive's, not the current page's.

- [x] **M16.8 — The whole page is the drop zone**
  **Goal:** dropping a file stops being a small target with no feedback.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`05 §5.1a`](../05-library-and-processing.md)
  **Acceptance:** a file dragged anywhere over the documents screen is caught, not only one dragged over the grid; while something is being dragged the page says so unmistakably and stops saying it the moment the drag ends or leaves the window — including the case a browser makes easy to get wrong, where entering a child element fires a leave for its parent; a drag that carries no file — text, a link — is ignored rather than promising something that will not happen.
