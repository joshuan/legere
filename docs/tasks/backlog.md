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
