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
  **Docs:** [`02 §2.2`](../02-architecture-overview.md#22-entry-point-servermaints-integration-contract), [`06 §6.6–6.10`](../06-backend-architecture.md), [`07 §7.1`](../07-api-specification.md#71-conventions)
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
  **Docs:** [`07`](../07-api-specification.md) (browse), [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browse)
  **Acceptance (e2e):** folders derived from FileRef paths with document counts; nested paths of arbitrary depth; documents of the exact folder paginated; path validated (no traversal); RESTRICTED enforcement.

- [x] **M5.4 — Document types: API + admin UI**
  **Goal:** the reference list is manageable.
  **Docs:** [`07`](../07-api-specification.md) (document types), [`03 §3.3.12`](../03-domain-model.md#3312-document-type), [`11 §11.12`](../11-ui-ux-spec.md#1112-document-types-document-types)
  **Acceptance:** CRUD with slug immutability + `DOCUMENT_TYPE_SLUG_TAKEN`; delete resets documents to NONE in one transaction (e2e); admin table UI with counts and confirms.

- [x] **M5.5 — UI: documents grid**
  **Goal:** the home screen.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`10 §10.5, §10.8`](../10-frontend-architecture.md)
  **Acceptance:** responsive card grid (thumb via `/thumb`, fallback icon, processing/unavailable badges); filter bar synced to URL; infinite scroll; 5 s polling while any visible doc is processing; empty states per spec; component tests for the card and filters.

- [x] **M5.6 — UI: document viewer**
  **Goal:** read and manage a single document.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`10 §10.8`](../10-frontend-architecture.md#108-media-in-the-ui)
  **Acceptance:** Preview/Text/Details tabs per spec (PDF `<object>`, sanitized markdown render, metadata incl. copyable hash and file locations with MISSING badges); sidebar: inline title edit, document type select with auto tag, download (disabled tooltip when unavailable), add-to-collection stub until M7, processing panel with per-step states + admin Reprocess with step checkboxes.

- [x] **M5.7 — UI: browse**
  **Goal:** folder navigation UI.
  **Docs:** [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browse)
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
  **Docs:** `05 §5.6` (scan sets — the section was removed by M13.9), [`03 §3.3.16–3.3.17`](../03-domain-model.md), [`07`](../07-api-specification.md) (scan sets)
  **Acceptance (e2e + integration):** CRUD with the DRAFT/FAILED-only edit rule (`SCANSET_INVALID_STATE`); non-image item → `SCANSET_ITEM_NOT_IMAGE`; merge: TRIM crops via sharp, NONE doesn't; result = DERIVED document (owner, provenance, `source.pdf` in S3) enqueued into the standard pipeline; identical result content → existing document reused; failure records error, retry after edit works; handler idempotent.

- [x] **M8.2 — UI: scan-set builder + grid multi-select**
  **Goal:** the flow is usable.
  **Docs:** `11 §11.8` (scan sets — the section was removed by M13.9)
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
  **Docs:** [`11 §11.12`](../11-ui-ux-spec.md#1112-document-types-document-types)
  **Acceptance:** `/admin/people`, `/admin/subjects` and `/admin/subject-kinds` are tables in the pattern of the document types — create, rename, delete behind a confirmation that says how many documents it reaches — reachable from the admin menu and closed to everyone else.

- [x] **M10.9 — The text tab is typeset, not just rendered**
  **Goal:** extracted Markdown reads like a document rather than like unstyled HTML.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`11 §11.15`](../11-ui-ux-spec.md#1115-visual-identity--the-reading-room)
  **Acceptance:** headings, paragraphs and lists carry the reading-room rhythm rather than the browser's defaults — no stray leading margin at the top, spacing that groups rather than separates; tables fill the pane with real cell borders, header weight and horizontal scrolling instead of overflowing; code, quotes, links and images are styled to match; long OCR output stays readable at every width.

- [x] **M10.10 — Merge what the analysis saw twice**
  **Goal:** four rows for one flat — or one person spelled three ways — become one row, without losing a single document.
  **Docs:** [`03 §3.3.19–20`](../03-domain-model.md), [`07`](../07-api-specification.md), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** rows are selectable on `/admin/people` and `/admin/subjects`; **Merge** asks for the surviving name — offered as a choice among the selected ones, or typed — and, for subjects, for the kind when the selected rows disagree; every document link moves to the survivor with duplicates collapsed, the others are soft-deleted, and no document loses the person or the thing it named; an admin's, and refused when the result would collide with a row that was not selected.

- [x] **M10.11 — A kind is named in the owner's own words**
  **Goal:** "Квартира" stops being turned into "apartment".
  **Docs:** [`03 §3.3.20a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** a kind is stored exactly as it is typed, in any language and any case, while remaining unique case-insensitively; the analysis is shown the kinds the catalogue already has and reuses one rather than inventing a synonym, and names a new one in the document's own language.

- [x] **M10.12 — The count is the way to the documents**
  **Goal:** "40" in a catalogue row is a question, and clicking it should answer it.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types), [`11 §11.4`](../11-ui-ux-spec.md#114-browse-browse)
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
  **Docs:** [`11 §11.1`](../11-ui-ux-spec.md#111-shell--navigation), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
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
  **Since revised:** the Files section is a **tab** of its own (`11 §11.5a`), not a section at the foot of `Details`. Everything it holds is unchanged; what changed is that reaching it is one press rather than a scroll past a metadata form and a table of step costs, and that the composition has an address — `/documents/:id/files`.

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
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
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

- [x] **M15.5 — A log is not a place to keep credentials**
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

- [x] **M15.8 — Dependencies with known holes, and a pipeline that would have said so**
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

- [x] **M15.13 — A lockout that cannot be pointed at somebody**
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

- [x] **M15.15 — Inputs stay inside their bounds**
  **Goal:** the small sharp edges found across parsing, matching and path handling stop being there.
  **Closes:** SEC-16, SEC-29, SEC-30, SEC-31, SEC-32, SEC-33, SEC-44
  **Docs:** [`05 §5.1`](../05-library-and-processing.md), [`07 §7.1–7.2`](../07-api-specification.md#71-conventions), [`14 §14.4`](../14-coding-standards.md)
  **Acceptance:** an exclude glob whose wildcards multiply is refused by the contract rather than compiled, and the matcher is built once per scan instead of recompiled per directory entry; a browse path containing `%` or `_` matches literally, and the folder listing and its offsets agree; a filename header containing control characters is stripped of them before the path is split, so nothing with a newline reaches a title, an S3 key or another container's multipart part; the library-creation check calls the `realpath` containment function that already exists, so a root reached through an intermediate symlink is refused, and a fixture proves it; both raw-body upload routes are exempt from the body parsers, declared in one place rather than by a path equality that the second route silently missed; the table-separator test is bounded so a megabyte-long line costs nothing; an unparseable cursor answers 422 rather than 500.

- [x] **M15.16 — An account has a history**
  **Goal:** after an incident it is possible to say who signed in, from where, and when their authority changed.
  **Closes:** SEC-34
  **Docs:** [`06 §6.7`](../06-backend-architecture.md), [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist)
  **Acceptance:** a successful login, a failed login, a lockout, an invite issued and accepted, a password reset issued and completed, a role change, a deactivation, a session revocation and an API token created or revoked each emit one structured record naming the actor, the target, the request id and the time; the records carry no token, code or password, and a test asserts that; the request id is the one the request already has, so a record joins to its request; where these records go, and how long they live, is written down in `06 §6.7`.

- [x] **M15.17 — A user can look after their own account**
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

- [x] **M15.19 — Two questions the audit could not answer**
  **Goal:** decide, in the documentation, two things that are currently accidents rather than choices.
  **Closes:** SEC-40, SEC-41
  **Blocked on a decision:** both behaviours match what `docs/07` and `docs/08` say today. They are here because the consequence looks unintended, not because the code disagrees with the docs — so the owner decides, and the doc changes, before anything is written.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model), [`03 §3.3.19–3.3.20`](../03-domain-model.md)
  **The questions:** (1) the people, subject and subject-kind catalogues are instance-wide, with global document counts, and their rows are mined by analysis from documents the reader may not open — is a name extracted from a restricted library meant to be visible to everyone? If not, the count becomes viewer-scoped and rows a viewer can reach nothing through disappear. (2) A user holding grants on two libraries can combine a document from the restricted one into a document from the open one, and the rebuilt PDF and Markdown then carry its pages to everyone who can see the open library — is `08 §8.5`'s "visible given access to at least one" a statement about deduplicated identical bytes, or a licence to bridge two libraries by hand?
  **Acceptance:** each question is answered in the document that owns it, and whichever answer is chosen has a test proving the behaviour is now deliberate.

- [x] **M15.20 — The security checklist stops being decoration**
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
  **Docs:** [`03 §3.3.19–3.3.20`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
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

- [x] **M16.5 — The shelf can be arranged**
  **Goal:** the newest-scanned order stops being the only one.
  **Docs:** [`07 §7.1`](../07-api-specification.md#71-conventions), [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`04 §4.4`](../04-database-schema.md)
  **This one amends a rule.** `07 §7.1` says in as many words: "Sorting is fixed per endpoint; no arbitrary sort params in MVP." A closed enum of named orders is not an arbitrary sort param, and that sentence has to say so before any of this is written.
  **Acceptance:** `GET /api/documents` takes a `sort` from a closed set — the document's own date (the default, newest first, with the undated *before* everything rather than after), when Legere first saw it, and when it last changed; 🔒 the cursor carries the order it was cut from and a request whose `sort` disagrees with its cursor is refused rather than quietly answered from the wrong column, because the encoding has no version and this is the change that decides how the next one is made; the two orders that no index serves get one — `(document_date DESC NULLS FIRST, id DESC)`, which the existing `NULLS LAST` index cannot be scanned backwards to produce; "when it last changed" is the newest entry in the document's journal, kept as a column beside it and written where every event is already routed through one method (`03 §3.3.18`), because ranking an archive by an aggregate over the log is not something an index can serve; a test walks a second page in every order and asserts the access rule still holds there, the way the collections test already does.

- [x] **M16.6 — The card shows what you came for**
  **Goal:** the badges under a card stop being one fixed pair.
  **Docs:** [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** `DocumentListDto` carries the fields a card may show — the document's date, its people, its subjects, its place, its languages — fetched per page in the batched way the file counts already are, and not one query per card; the home screen chooses which of them appear, the type and the extension included, so both can be switched off; the choice travels in the URL beside the filters; the four other screens that render the same card keep the arrangement they have today rather than inheriting a home-screen setting.

- [x] **M16.7 — Real groups, with real counts**
  **Goal:** an archive can be looked at a shelf at a time without leaving the list.
  **Docs:** [`07 §7.1`](../07-api-specification.md#71-conventions), [`07 §7.3`](../07-api-specification.md), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** a grouping endpoint answers `{ key, label, count }` for a chosen dimension under the filters in force, in the shape `GET /api/documents/years` already answers in — so the paginated envelope of `07 §7.1` is not broken, because a group's contents are the ordinary list filtered by that group's value; the dimensions offered are the ones that can be filtered, which is what makes the contents reachable at all; a document that belongs to several groups — it has two people — appears under each, and the documentation says so, because the alternative is a card that vanishes from a shelf it belongs on; the counts are the archive's, not the current page's.

- [x] **M16.8 — The whole page is the drop zone**
  **Goal:** dropping a file stops being a small target with no feedback.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`05 §5.1a`](../05-library-and-processing.md)
  **Acceptance:** a file dragged anywhere over the documents screen is caught, not only one dragged over the grid; while something is being dragged the page says so unmistakably and stops saying it the moment the drag ends or leaves the window — including the case a browser makes easy to get wrong, where entering a child element fires a leave for its parent; a drag that carries no file — text, a link — is ignored rather than promising something that will not happen.

---

## M17 — A page that can be read

- [x] **M17.1 — A page keeps the shape of what it was made from**
  **Goal:** the canonical stops stamping every photograph onto a portrait A4 — and stops blinding the recognizer that has to read it.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`03 §3.3.10`](../03-domain-model.md), [`04 §4.4`](../04-database-schema.md), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md)
  **This one is a bug with a feature around it.** Measured on a real document — a landscape photograph of an A4 page, laid on a portrait A4 sheet: tesseract reads **0 characters** from the rendered page in every segmentation mode, and **649** from the same pixels with the white bands cropped away. The margins dominate the histogram, the threshold lands on the paper's own grey, and the text goes with it. The step reports `DONE` and `ocrUsed: true` over an empty result, so the Markdown is empty, the analysis sees only a file name, and the document is unsearchable — one flag deep, three steps wide.
  **Acceptance:** step 1 decides the page from the source rather than from a constant — a ratio within tolerance of √2 becomes A4 **in the source's own orientation**, and one outside it becomes a page of the source's ratio with its long side 297 mm, so a receipt is a strip and not a stamp in the middle of a sheet; 🔒 **recognition happens in the source's geometry and the format is applied after it** — the text layer is vector and survives being scaled, which is what makes "strictly A4 *and* searchable" possible at all (measured: 125 text operators before normalisation, 125 after); the document carries its page format, `AUTO` until somebody sets it, and setting it rebuilds the canonical the way any change to the composition does; the instance default is A4; a test asserts the resulting page size for the four shapes an archive actually meets — A4 portrait, A4 landscape, a strip, a square — and that the text layer is still there after the format is applied.
  **Since revised:** "setting it rebuilds the canonical" is no longer true, and the clause is kept here as the record of what was accepted. Setting the format never wrote the column at all — so the answer came back as the value it replaced while a rebuild was enqueued on the strength of a change nobody had saved — and the rebuild itself turned out to be the wrong half to keep: a metadata form does not get to remake forty pages and recognise their text afresh because a select changed. The format is now stored as an instruction the next build reads, the form warns that the pages keep their shape until then, and the rebuild is `POST /api/documents/:id/reprocess` (`07 §7.3`, `11 §11.5`).

- [x] **M17.2 — The analyst sees the document, not a keyhole**
  **Goal:** the step that decides what a document *is* stops reading the first 4000 characters of it, and stops being blind on the documents that have no characters at all.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.10`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`12 §12.4`](../12-build-config-run.md)
  **Acceptance:** the excerpt cap becomes a setting rather than a constant, and its default stops truncating — the sentence in `05 §5.5` that justifies the 4000 characters ("not a 4000-character excerpt") is part of what this task rewrites; the pages of the document travel with the text as images, at most **20** of them, because past that a document is a book rather than a paper and its text carries it; the answer gains a verdict on **how well the text was extracted**, which is the signal nobody has today — an OCR pass that recognised nothing currently reports success, and the only way to notice is to open the document; a document whose pages could not be rendered still gets analysed on its text, because a missing picture is not a reason to learn nothing.

- [x] **M17.3 — What a step cost, written down**
  **Goal:** the journal says how long each step took and what it spent, instead of leaving both to be guessed.
  **Docs:** [`03 §3.3.18`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md)
  **Acceptance:** every `STEP_FINISHED` carries the duration of the step — the pair of entries already brackets it, so this is what the reader should not have to subtract by hand; the steps that call a model record what it reported spending, which the client currently drops on the floor: `usage` is not in the response schema at all, so prompt and completion tokens are read and kept; the steps that recognise record what they produced — characters extracted, pages OCR'd, whether OCR ran — because "it took four minutes" and "it returned nothing" are the two halves of the same question; the details pane shows them next to the step they belong to.

- [x] **M17.4 — While picking, the card is the target**
  **Goal:** choosing documents stops being an exercise in aiming at a checkbox.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** while the grid is in selection mode the whole card toggles the document instead of opening it — the card is the hit area, and the checkbox becomes what it looks like, a state rather than the only way in; leaving selection mode gives the card its link back, so the mode is the only thing that decides what a press means and there is never a screen where the same gesture does two things; the card says which mode it is in without being read — a picked one is visibly picked from across the grid, not by a tick in its corner; the keyboard reaches it the way it reaches a link, because a hit area that only a mouse can use is half a fix.

- [x] **M17.5 — Grouping that groups**
  **Goal:** choosing a grouping arranges the grid into groups with headings, instead of offering shortcuts into a filter.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`07 §7.3`](../07-api-specification.md)
  **This one amends a rule.** `11 §11.3` currently specifies the opposite in as many words: "Pressing a shelf puts its key into that dimension's filter, so the grid below becomes that shelf's contents". That sentence, and the paragraph explaining why the shelves are counted under every filter except their own, are what this task rewrites — the shelves stop being a way into a filter and become the headings of the grid itself.
  **Acceptance:** with a grouping chosen the grid is drawn as sections — a heading with the group's label and its real count from `GET /api/documents/groups`, then that group's cards — and no filter is set by looking at it, so leaving the grouping leaves the archive where it was; 🔒 **a section for the documents that have no value in that dimension**, because `countByGroup` excludes nulls by construction and without such a section they would not be filtered out of view but silently absent from it — in this archive that is 9 documents of 35 with no type, 11 with no date, 17 with nobody named on them; a document that belongs to several groups is drawn in each of them, which is already true of the shelves and becomes visible once they are headings, and the documentation says so rather than leaving it to be discovered; each section pages on its own, because one cursor cannot walk a grid whose order is now two levels deep, and the count in the heading is the archive's while the cards under it are as many as have been fetched.

---

## M18 — Reading what a camera saw

- [x] **M18.1 — A photograph is read by something that can see**
  **Goal:** the text of a photographed document stops being whatever a full-page binariser managed, and becomes what is actually on the page.
  **Docs:** [`02`](../02-architecture-overview.md) (a new ADR: the recogniser of last resort), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.10`](../03-domain-model.md), [`12 §12.4`](../12-build-config-run.md), [`11 §11.5`](../11-ui-ux-spec.md)
  **Measured, on one real document.** A photograph of a lab report: 665 characters are legible on the page, 415 reach the database. The losses are in the middle and the tail survives, so nothing truncated it — the recogniser dropped whole regions. The results table, which is the only reason that document exists, arrives with three of nine row labels and two of nine values. It is not the page geometry: the same loss reproduces on the raw photograph with no page around it, and cropping to the table alone reads it correctly. Uneven lighting and bold text pressed against thin cell rules defeat a global threshold and the layout pass that follows it.
  **Acceptance:** a document that needed recognition at all — `ocrUsed`, which is exactly the photographed and scanned case — has its pages **transcribed by a vision model** and that transcription becomes the Markdown; a document that arrived carrying its own text layer is untouched, because reading it is both free and perfect and no model improves on it; the pages go as images through the same OpenAI-compatible provider the analysis already uses, under its own configuration so an instance may point the two at different models or run without this one at all — unconfigured means the tesseract result stands rather than the step failing; 🔒 **a transcription that comes back shorter than what OCR already had is not an improvement and is not kept** — the model that cannot see the page must not be able to empty it; what produced the text is recorded on the step beside what it cost, because two engines now write the same field and "which one wrote this" is the first question about a bad result; the page cap and the analysis page limit are separate settings, since transcribing forty pages is a different decision from analysing them.

- [x] **M18.2 — The recogniser is given a page it can read**
  **Goal:** the cheap path stops being defeated by things a camera does and a scanner does not.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files)
  **Acceptance:** before an image becomes a page, its lighting is levelled and its skew taken out — a photograph is lit from one side and held at an angle, and both are why a global threshold loses the darker half of the sheet; the correction is applied to the page the canonical carries, so what the reader downloads is the improved one and not a second copy; a scan that is already flat and evenly lit comes out unchanged rather than "corrected" into something worse; measured against the same document this task exists for, and the number that has to move is how much of its text survives.

- [x] **M18.3 — "Half recognised" stops passing for done**
  **Goal:** the threshold that tells nothing from something stops being asked whether a page was read well.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.10`](../03-domain-model.md), [`11 §11.5`](../11-ui-ux-spec.md)
  **Acceptance:** `PDF_TEXT_MIN_CHARS_PER_PAGE` keeps the one job it can do — deciding whether there is a text layer at all — and stops being the only gate before the text is called final: 415 characters on a page holding 665 sails past a threshold of 32 and the second pass never runs; the verdict the analysis already returns (`textQuality`, `03 §3.3.10`) is acted on rather than filed — a document whose text is judged partial or absent says so where its text is read, and offers the better recogniser rather than requiring somebody to notice; nothing re-runs itself in a loop on that verdict, because a model that says "partial" twice is not a reason to spend twice.

---

## M19 — Where an upload is watched

- [x] **M19.1 — The upload panel, and a grid that holds documents only**
  **Goal:** forty files going up are watched in one column of the application that follows the person from screen to screen, and the grid stops filling with grey cards for things that are not documents yet.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`11 §11.3a`](../11-ui-ux-spec.md#113a-the-upload-panel), [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab), [`10 §10.5a`](../10-frontend-architecture.md)
  **This one replaces a behaviour.** `11 §11.3` used to specify the opposite in as many words — "The moment files are chosen they are cards in the grid — ahead of everything" — and M11.1 built exactly that, correctly. The documentation has since been rewritten around the panel; M11.1 stays ticked as the record of what was built, and this task is what supersedes the queue-in-the-grid behaviour it describes.
  **Acceptance:** the panel is drawn by the `(app)` layout as a **right-hand column about a third of the viewport wide**, not as something floating over the page — the screen's content is laid out beside it and **narrows and reflows** while it is up, the grid dropping to fewer columns rather than having a corner of itself covered — and below `lg` it becomes a full-width block of bounded height above the screen's content instead; it is sticky under the application header, reaches the bottom of the viewport and **scrolls inside itself**, so a queue of forty rows never lengthens the page beside it; it appears with the first queued file and is gone when the queue is empty, and because it belongs to the layout, moving from the documents screen to a document, or to search, no longer abandons what is in flight; the queue is one for the whole application and still sequential, files going up one at a time in the order they were added, whether they were addressed to the library (`POST /api/documents`) or to a document's Files tab (`POST /api/documents/:id/files`); **no placeholder cards or rows anywhere** — the grid and the Files tab hold only what the server has, a document appears the moment its upload lands, where the order in force puts it, with a brief highlight on the new card, and a **grouped** grid shows it under the heading it belongs to, which is the view that showed nothing at all while forty files went up; one row per file in the order added, never reordered, moving in place through queued → uploading → uploaded / duplicate / failed — a duplicate links to the document those bytes already are (`200`, `05 §5.1a`) rather than reading as an error, a failure carries its reason in a tooltip and a retry of its own while the rest of the queue carries on, and the row being sent is kept in view; the header reads "Uploading N of M" over a bar **weighted by bytes** rather than by how many files have finished — the sizes are known before anything is sent, and a settled file counts its whole size; per-file progress is the bytes that actually left, which is what moves the upload transport to `XMLHttpRequest` (`10 §10.5a`) while the routes, the envelope, the contracts and the error codes stay exactly as they are; when everything has settled the header says "M uploaded" and the panel takes itself away after about five seconds, giving the width back, but **only when no row failed and none was a duplicate** — otherwise it stays up with **Retry failed** in the header until it is closed; there is no collapsed state to fall back on, so **closing with files in flight is a cancellation and asks first** — confirming aborts the request in flight, drops every waiting row and empties the queue, while a settled queue's ✕ simply clears and hides; and nothing about processing is in it, because the card's `processing` tag and the viewer's step panel already have that job.

- [x] **M19.2 — An upload the pipeline could never render is refused at the door**
  **Goal:** a torrent dropped on the grid stops becoming a document of nothing but skipped steps.
  **Docs:** [`05 §5.1a`](../05-library-and-processing.md#51a-uploads), [`07 §7.2–7.3`](../07-api-specification.md), [`11 §11.3a`](../11-ui-ux-spec.md#113a-the-upload-panel)
  **Acceptance:** all three upload routes — a new document, a file added to one, a page replacement — refuse a file whose **content-detected** type classifies as `UNSUPPORTED` (`415 UNSUPPORTED_FORMAT`), before anything is stored and before deduplication is consulted; the gate is `classifyFormat` itself, the same branch the canonical build takes (`05 §5.5` step 1), so what an upload accepts and what becomes pages cannot drift apart; a library scan keeps registering such files unchanged — a scan answers to nobody, an upload is a person who can be told no; the panel row fails wearing a localized reason naming what is taken (PDFs, images, office documents, plain text), and the picker's `accept` steers the file dialog to the same set, the drop zone being unfilterable by nature.

---

## M20 — Work that waits for what it needs

- [x] **M20.1 — A step that read nothing stops reporting success**
  **Goal:** the analysis and the vectorization run on what the extraction produced, and say plainly when it produced nothing, instead of reporting `DONE` over an input that was never there.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.10`](../03-domain-model.md)
  **This one is a bug the pipeline reports as done.** Steps 4 and 5 run whatever step 3 did. A document whose extraction failed is analysed on its bare file name — plus whatever an earlier run left in the `markdown` column, which a failure deliberately does not clear — and the step records `DONE` over it, so the document ends up carrying a type, a title and a date nobody can tell were read off nothing, with the one row that said something broke sitting one line above four rows that say everything is fine. Steps 2 and 3 already ask this question of step 1 and answer it correctly; this is the same rule, one link further down the chain.
  **Acceptance:** the analysis and the vectorization run only where the document row's `markdown` step is `DONE`, read from the database after step 3 rather than from the copy the job started with, so the rule holds for a full run and for a reprocess of a subset alike; markdown `FAILED` → the step records `FAILED` without running and 🔒 **without writing `processingError` or `failedStep`**, so the recorded reason stays the one step 3 hit — exactly what the preview already does when the canonical failed; markdown `SKIPPED` → the step records `SKIPPED` carrying the reason step 3 recorded (`UNSUPPORTED_FORMAT` for a document nothing can render), falling back to `NO_TEXT` where none was recorded; markdown still `PENDING` or `QUEUED` → `SKIPPED` with `NO_TEXT`, which is the state `POST /api/documents/:id/reprocess` with `steps: ['analysis']` leaves a document that never had an extraction in; the dependency is asked **before** each step's own gates, so a forty-page document whose extraction failed reads as a failed extraction rather than as `TOO_MANY_PAGES`, and an instance with no embeddings provider reads as the failure rather than as `NOT_CONFIGURED`; unchanged where step 3 succeeded and found nothing — markdown `DONE` over empty text still runs the analysis, which has the pages as pictures, and still has the vectorization clear the chunks and record `NO_TEXT`; 🔒 **where the dependency fires, the stored chunks are not touched at all** — the last good vectors stay for the same reason the stale Markdown stays searchable, a run that learnt nothing being no reason for a findable document to stop being findable; no new value joins the skip-reason set; tests cover each of the four states of step 3 against both steps, one asserting that a document whose extraction failed still names step 3 in `failedStep` and still carries step 3's error text, and one asserting that a gated vectorization leaves an earlier run's chunks in place.

- [x] **M20.2 — One gate per service, instead of one speed for everything**
  **Goal:** an operator can bound the calls to one overloaded container, and demand a pause between them, without serializing the steps that were never competing with it.
  **Docs:** [`05 §5.4b`](../05-library-and-processing.md#54b-per-service-gates), [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`07 §7.3`](../07-api-specification.md), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue), [`12 §12.4`](../12-build-config-run.md)
  **What is missing today.** Stirling, Docling and whichever provider answers as the analyst, the transcriber and the embeddings usually share one physical host with the app, where they compete for the same memory and the same cores. The only knobs are per-queue concurrency and units-inside-a-job, and neither can say "at most one OCR at a time" without also saying "at most one document at a time" — so the one move available is to turn every concurrency down to 1, which also serializes an analyst call and a page render that were never in each other's way.
  **Acceptance:** five gated services — `stirling`, `docling`, `classifier`, `transcriber`, `embeddings`, keyed after the environment variables that turn each one on rather than after the pipeline steps that call them, so the service behind the analysis is `classifier` beside its own `CLASSIFIER_API_BASE_URL` while `DocumentAnalyst` stays what the code calls the port — each with a `concurrency` (`0` = ungated, otherwise 1…`QUEUE_CONCURRENCY_MAX`) bounding how many units of that service's work are in flight at once, and a `cooldownSeconds` (0…600) holding a finished unit's slot shut after a success and after a failure alike, waiters served in **FIFO** order, so `concurrency: 1` reads as one call at a time with a guaranteed pause between consecutive calls; the gated unit is one unit of external work rather than one HTTP request where the two differ — each Stirling call is a unit, one whole Docling parse from submitting through every poll to collecting the result is a **single** unit because the expensive work happens on the Docling server in between, and one analyst call, one transcription and one batch of embeddings are each a unit; 🔒 **the defaults are `0`/`0`**, so an instance that upgrades into this waits nowhere until somebody says otherwise, with env defaults named `SERVICE_CONCURRENCY_<SERVICE>` / `SERVICE_COOLDOWN_<SERVICE>` — `STIRLING`, `DOCLING`, `CLASSIFIER`, `TRANSCRIBER`, `EMBEDDINGS` — after the pattern of `QUEUE_CONCURRENCY_PROCESS` and `QUEUE_UNIT_CONCURRENCY`, and a stored setting overriding env exactly as a queue concurrency does; the overrides live in the same settings row and travel in the same `GET`/`PATCH /api/admin/queue/settings` payload beside `concurrency`, `unitConcurrency` and `paused`, with a service name this version does not know dropped on write, a value outside its range refused by the contract exactly as an out-of-range queue concurrency is, and whatever the stored row holds checked as it is read so that a number left behind by another version falls back to the env default instead of stopping the workers — the hygiene the queue names already get; a change takes effect without a restart and reaches a caller that is already waiting no later than its next acquisition, the gate being in-process and therefore instance-wide (ADR-002); `/admin/queue` gains an **External services** block, one row per service named twice with a line on what work it serves and the two inputs beside it, saving only once something differs from what the server holds, localized ru/en with the keys in English; `/admin/instance` shows the resolved values under the group its queue knobs already live in; tests cover a gate of 1 admitting one caller at a time and releasing the next in arrival order, a cooldown holding the slot for its seconds after a failed unit as well as a successful one, `0` behaving as no gate at all, one Docling parse occupying a single slot across all of its polls, and a caller already queued at a gate seeing a widened concurrency without a restart.

---

## M21 — The screen gives its height to the document

- [x] **M21.1 — The viewer's chrome is one strip**
  **Goal:** a document opens with as much of the document on screen as the viewport can give, and its name stands beside it in the panel of things about it rather than above it.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md), [`03 §3.3.10`](../03-domain-model.md)
  **What is being spent.** The main column currently opens with the document's title and its description, and only then the tabs — three rows of chrome over the one thing the screen exists to show. The title was read once, on arrival, and is charged to every page of every document afterwards; the thing it names is already on the screen, being looked at. `11 §11.5`'s sidebar list has meanwhile always begun with "title (inline-editable when permitted)", which nothing rendered — this task makes that line literally true and leaves exactly one of each.
  **Acceptance:** the viewer's main column renders **nothing whatever above the tabs row** — no title, no description, no toolbar — so the tabs are the single strip of chrome above the document and the open tab takes the rest of the viewport's height; the **title moves to the head of the right sidebar**, above the document type select and everything already there, still inline-editable in place for whoever may edit it, wrapping rather than truncating because a document's name is the one string here nobody may be shown half of; the **description** sits directly beneath it in secondary text, a line or two, inline-editable on the same terms, drawn as an em dash where the analysis has written none; 🔒 **exactly one title and one description exist on the screen** — a name rendered in two places is a name somebody edits in the wrong one, and the duplication between the old header and the sidebar list is resolved in the sidebar's favour; both keep editing **in place**, a click on the text rather than a form, so neither joins the Details editor, where a field is corrected rather than written; every existing keyboard behaviour is untouched — the Details pane's **E** still opens its editor and **Escape** still leaves it — and 🔒 **E does nothing while an inline editor holds the focus**, since a bare-letter shortcut that fires in the middle of a title being typed eats the title; the open tab is still the last URL segment, `/documents/:id` still opens the preview and an unknown tab is still a 404; tests assert that the main column renders no heading above the tabs row, that the title and the description are editable from the sidebar and save through the same `PATCH /api/documents/:id` they always did, and that `E` typed into the title input types an `e`.

- [x] **M21.2 — The shell loses its bar, and search comes to the foreground**
  **Goal:** the authenticated shell becomes the sider and the content and nothing else, and search stops being a permanent field on every screen to become something raised over the screen you are on.
  **Docs:** [`11 §11.1`](../11-ui-ux-spec.md#111-shell--navigation), [`11 §11.1a`](../11-ui-ux-spec.md#111a-the-search-overlay), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`11 §11.3a`](../11-ui-ux-spec.md#113a-the-upload-panel), [`11 §11.6`](../11-ui-ux-spec.md#116-search-searchq), [`11 §11.11`](../11-ui-ux-spec.md), [`11 §11.15`](../11-ui-ux-spec.md), [`10 §10.1–10.2`](../10-frontend-architecture.md), [`07 §7.3`](../07-api-specification.md)
  **One task and not two.** The top bar is where the global search input lives, so removing the bar without the overlay would leave the product searchable only by typing a URL. They land together or not at all.
  **And it replaces two behaviours.** `11 §11.1` specified the bar in as many words — "screen title, contextual actions, a global search input (submits to `/search?q=`)" — and **M6.2** built exactly that, correctly, down to "topbar input navigates to `/search?q=`"; **M19.1** then hung the upload panel from it, "sticky under the application header". Both stay ticked as the record of what was built, and this task is what supersedes the bar together with everything that referred to it.
  **Acceptance:** **no screen renders the top bar** — the `(app)` layout is the sider and the content, and every screen title, contextual action and the global search input that lived up there is gone from it; the two actions that lived there are relocated and named: **Upload** to the end of the documents screen's own row of controls beside the order and the grouping — not among the filters, since it makes something rather than narrowing something — and **Invite user** to directly above the users table and the invites list it fills; screens whose content already opens with a heading stop drawing one twice, and screens that earn a heading keep it inside their content; the upload panel is **sticky to the top of the viewport** rather than under an application header that no longer exists, and nothing else about it changes; the **Search menu item stays in the sider and stops navigating** — it opens the overlay, and the item carries the chord as a hint on its right; the overlay also opens on **Cmd+K / Ctrl+K from every authenticated screen**, the listener bound once by the `(app)` layout rather than per screen, because a hotkey registered by four screens is a bug on the fifth; it is centred over the current screen, dims rather than replaces it, focuses its input on appearing, and shows results **as the query is typed**, debounced, from the same `GET /api/search` in the same default `hybrid` mode the page runs (`07 §7.3`) — never a second search with its own idea of what matches; result rows reuse the search row's anatomy — thumbnail, title, highlighted snippet, document type; the **whole keyboard path works**: ↑/↓ move the highlight visibly, **Enter** opens the highlighted result, **Enter with nothing highlighted** and the **All results** row both go to `/search?q=` carrying what was typed, **Escape** closes, and 🔒 **focus returns to whatever opened the overlay**, because an overlay that dissolves onto `<body>` has ended a keyboard session that had not finished; the screen underneath is unchanged by opening and closing — it was dimmed, not navigated away from; an **empty query shows the recent documents**, the same behaviour and the same source as the search page's empty state rather than a second answer to "nothing typed yet", and nothing found says so in the words `11 §11.6` uses; **`/search` survives entire** — reachable from the overlay and by its own URL, keeping its own input inside its own content, its modes, its filters and its full ranked list, and a page opened with `?q=` already set runs that search on arrival instead of waiting to be asked again; localized ru/en with the keys in English; tests cover the hotkey opening the overlay from a screen that is not `/documents`, the menu item opening it without a navigation, the arrow/Enter/Escape path including focus restoration, All results landing on `/search?q=` with the typed query, and `/search?q=…` opened cold rendering results without a second submission.

---

## M22 — The paper knows its fields, and its neighbours

- [x] **M22.1 — A document type carries a schema, and the pipeline fills it**
  **Goal:** a photographed till receipt stops being only prose and a preview: the vendor, the total and the day are typed values on the document — validated, searchable, correctable, and never overwritten once corrected.
  **Docs:** [ADR-022](../02-architecture-overview.md#adr-022-typed-fields--a-schema-per-document-type-shipped-as-data-in-code), [`03 §3.3.10a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a versioned **field-schema registry** lives in `src/shared/contracts`, keyed by document type slug, carrying `receipt`, `passport` and `id-card` with the field kinds of `03 §3.3.10a` (`string`, `number`, `date`, `money`, `table`) — data, not code paths, so the day schemas become admin-editable they move into a table without the stored answers changing shape; a sixth pipeline step **`fields`** runs between the analysis and the vectorization through the same `DocumentAnalyst` provider and the same `classifier` gate, asking for exactly the schema's fields and validating each on its own in code — a bad date is dropped and a good vendor beside it is kept; the answer lands on the document as `extracted = { schema: {slug, version}, values, sources }` with the model's reading recorded in `autoValues.fields` either way, and **fill-blanks holds per field** — a `MANUAL` value survives every re-run; the step's gates ask in order: the step-3 dependency of `05 §5.5`, then `NO_SCHEMA` (no type, or a type without a schema), then `NOT_CONFIGURED`, then `TOO_MANY_PAGES` lifted by the same `analyseInFull` that lifts the analysis's; 🔒 **a manual type change re-queues exactly this step** — by `typeId` or by `reset: ['documentType']` — and the step replaces a reading whose stored schema disagrees with the type wholesale, manual corrections included, the journal keeping what they were; the searchable values are flattened into `extracted_search_text` and the **`search_vector` generated column is rebuilt** to carry them at weight A (`04 §4.3`), so FTS finds a receipt by a vendor OCR mangled in the prose; the migration backfills `fields_status` — `PENDING` where the type carries a schema, `SKIPPED` with `NO_SCHEMA` everywhere else — so the archive neither reads as processing for a week nor waits for a step with nothing to do, and the hourly sweep walks the `PENDING` ones through; `PATCH /api/documents/:id` takes `fields` (partial, per-field `MANUAL`, `null` clears value and source) and `reset: ['fields']` / `['fields.<key>']` restoring the read value as `AUTO`, refusing unknown keys, wrong shapes and schemaless documents with `VALIDATION_FAILED`; the Details pane renders the schema's rows formatted for the reader — an em dash where nothing was read, the `table` field as a read-only table — edits the scalars in the same Edit form (`money` as two inputs sharing one width), carries the same "read as …" line and one-click reset the place already has, and badges the group with the step's own status while it has not settled; the viewer's processing panel says six steps; `DocumentDetailDto` carries `extracted` and `steps.fields`, `reprocess` accepts `'fields'`; localized ru/en with the keys in English; tests cover the 14 §14.8 typed-fields scenarios at the levels they name.

- [x] **M22.2 — The card says what was read off the paper**
  **Goal:** a shelf of receipts answers "which one" without opening any of them.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen), [`07 §7.3`](../07-api-specification.md), [`03 §3.3.10a`](../03-domain-model.md)
  **Acceptance:** `DocumentListDto` gains `extractedSummary` — the values of the summary-flagged fields of the document's schema, as stored, `null` where there is no schema or nothing read — costing the list no extra query, being a projection of a column already on the row; the card multi-select of `11 §11.3` gains **extracted fields**, drawn as one line of secondary text in schema order, formatted for the reader's locale by the registry the client ships (`Intl` dates and currency amounts), middle dots between values, cut off rather than wrapped, and nothing at all where the document has nothing to say — so the option costs nothing on the shelves it does not serve; the choice lives in the URL under the `card=` rule already in force and the four other screens that render the card keep their arrangement; localized ru/en with the keys in English; web tests cover a receipt card drawing the line, a schemaless card drawing nothing, and the URL round-trip of the option.

- [x] **M22.3 — Papers that belong together are linked, and cite each other**
  **Goal:** the act stands beside its contract and the receipt beside the act — still four documents, each of its own type, connected where a person said so.
  **Docs:** [ADR-023](../02-architecture-overview.md#adr-023-document-links--undirected-untyped-person-confirmed), [`03 §3.3.23`](../03-domain-model.md), [`05 §5.6b`](../05-library-and-processing.md#56b-noticing-that-documents-cite-each-other), [`07 §7.3`](../07-api-specification.md), [`11 §11.5`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a `document_links` table holds an **unordered pair** — `a_id < b_id` enforced in the application and checked in SQL, unique per pair, hard-deleted on removal, cascading with a hard-deleted document — with `LINKED`/`UNLINKED` journal entries written on **both** documents carrying the other's id and title as a record; `GET /api/documents/:id/links` answers the edge from either end, newest first, and 🔒 **an edge whose other side the caller may not read is absent entirely**; `POST` requires `canEditDocumentMeta` on the document and read on the other (`LINK_SELF`, `LINK_EXISTS`, `DOCUMENT_NOT_FOUND` per `07 §7.2–7.3`), `DELETE` takes `canEditDocumentMeta` on either end and answers `LINK_NOT_FOUND` where there is no edge; `GET /api/documents/:id/link-suggestions` computes candidates **deterministically and stores nothing** — probes are the document's own identifiers per `05 §5.6b` (searchable extracted string values carrying a digit, then number-bearing tokens of the title and the opening of the text, bare years excluded), each probed as one FTS phrase query under the caller's access rule, candidates ranked by probes answered then `lastEventAt`, self and the already-linked excluded, at most five, each naming its matched tokens; the viewer's sidebar gains the **Related documents** card of `11 §11.5` — linked rows with unlink, a search picker to link by hand, suggestions beneath with Link and Dismiss (client-side, for the session), and no card at all when there is nothing to draw; localized ru/en with the keys in English; tests cover the 14 §14.8 document-links scenarios at the levels they name.

---

## M23 — The panel says where a service is, and whether it answers

- [x] **M23.1 — Every external service shows its address and its health**
  **Goal:** an admin opening `/admin/queue` can tell a container that is down from one that is merely busy, and a provider that refuses this instance's key from one nobody ever configured — without reading the environment, opening a shell, or waiting for a document to fail into the answer.
  **Docs:** [`05 §5.4c`](../05-library-and-processing.md#54c-is-the-service-even-there), [`05 §5.4b`](../05-library-and-processing.md#54b-per-service-gates), [`07 §7.3`](../07-api-specification.md), [`11 §11.13`](../11-ui-ux-spec.md#1113-admin-queue-adminqueue), [`06 §6.10`](../06-backend-architecture.md)
  **What is missing today.** The External services block says how hard each of the five services may be asked and nothing about whether any of them is there. The address each one is called at is knowable only from `/admin/instance` (and only for the two that have a `*_URL` of their own), and reachability is knowable only by processing a document and reading the failure — so the first symptom of a renamed container or an expired key is a step that failed an hour ago, on a screen that had every reason to say so at the time.
  **Acceptance:** `GET /api/admin/queue/services` (🔒ᴬ) answers one row per gated service of `05 §5.4b` in that order — `{ service, url, status, httpStatus, latencyMs, checkedAt, detail }` — where `url` is the base URL this instance resolved, the same string the job log carries as `endpoint`, 🔒 **with any userinfo stripped and no API key in the answer at all**, and `status` is one of the five states of `05 §5.4c`: `UP` (`2xx`), `UNAUTHORIZED` (`401`/`403` — the service is there and refuses this instance), `ANSWERED` (any other code, which is carried in `httpStatus` because `404` on a provider without `/models` and `502` on a container still starting are different repairs), `DOWN` (refused, unresolved, or past the timeout) and `NOT_CONFIGURED` (no base URL — not a fault, and never drawn as one); the probe is the cheapest request each service defines — `/api/v1/info/status` for Stirling, `/health` for Docling, `/models` with the service's own bearer token for the three OpenAI-compatible providers — 🔒 **taken outside the queues and outside the gates**, since "everything is stuck" is precisely when this is asked, under its own short timeout, all five in parallel so five dead services cost one timeout rather than five, and cached for a few seconds so reloading tabs do not multiply traffic to a container that may already be struggling, with `checkedAt` making a held answer visible as one; the External services block of `11 §11.13` gains the **address** under each service's line, as code, truncated rather than wrapped, saying so in words where none is configured, and a **state column** — green `UP`, amber `UNAUTHORIZED` and `ANSWERED`, red `DOWN`, grey `NOT_CONFIGURED` — with the code, the latency, the time and the reason on hover; the block carries one **Check** button for all five, checks on opening, and otherwise refreshes only when asked or while the page's own auto-refresh runs, at a slower cadence than the queue counters; 🔒 **the gates draw and save while the probes are still out** — a page that waits for a dead container to time out is unusable at the moment it is needed; localized ru/en with the keys in English; tests cover each state from a mocked transport (including a `2xx`, a `401`, a `500`, a refusal and an unconfigured service), userinfo stripped from a published URL, the bearer token sent to a provider that has one and absent where there is none, the cache answering twice from one probe, one failing probe not taking the other four with it, the endpoint refusing a non-admin, and the block rendering an address and a state tag per service.

---

## M24 — The panel beside the document stops being a second screen

- [x] **M24.1 — Every action moves to the tab that owns its subject**
  **Goal:** the viewer's sidebar says what the document is called, what it is about and what it looks like — and nothing else; Download and Delete stand with the files, the links get a tab of their own, and the processing panel stands beside the history of the same work.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab), [`11 §11.5b`](../11-ui-ux-spec.md#115b-download-the-document-or-what-it-was-made-of), [`11 §11.5d`](../11-ui-ux-spec.md#115d-deleting-a-document), [`11 §11.5e`](../11-ui-ux-spec.md#115e-the-related-tab), [ADR-023](../02-architecture-overview.md#adr-023-document-links--undirected-untyped-person-confirmed), [`05 §5.6b`](../05-library-and-processing.md#56b-noticing-that-documents-cite-each-other)
  **What is being spent.** The panel is 8 columns of a two-pane screen and it currently carries a title, a description, a download split button, a collection select, a link picker with its suggestions, a thumbnail, six step rows with checkboxes and a reprocess button, and a delete — drawn in full on every document, whether or not anybody came to act on one. Meanwhile the tabs, which is where somebody who *has* come to act already looks, hold five panes and none of the actions that belong to them: Download is not with the files it lists, Delete asks about files from a card that shows none, and the processing panel says "is it finished" from a column away from the log that says what happened. Nothing here is new behaviour — every control keeps what it does, its permissions and its wording. What changes is which pane it stands in.
  **Acceptance:** the viewer gains a sixth tab **`related`** with an address of its own, `/documents/:id/related`, validated on the server exactly as the other five are and 404 for anything else; `VIEWER_TABS` carries it, the tabs render in the order `Preview · Text · Related · Log · Details · Files`; the **Related tab** holds what the sidebar card held (`11 §11.5e`) — the search picker **above** the list, the linked documents as full-width rows carrying the other document's first-page thumbnail, its title as a link into its own viewer, its type and an unlink, and the suggestions of `05 §5.6b` under their own heading with **Link** and **Dismiss**, dismissing still client-side for the session; the tab's two queries are **asked for only when it is opened**, as the log's are — the suggestions cost the server a phrase search per identifier and were being computed on every visit to every document to fill a card most readers never looked at; 🔒 **the tab is drawn whether or not there is anything in it** — the card's "draw nothing at all" rule was right for a card and wrong for a tab, since a tab that vanished with the last link would take the picker with it and the first link could then be made only on documents that already have one — so an empty state says there are none and the picker stays; the **Download split button** of `11 §11.5b` moves to the head of the `Files` tab, beside **Add files**, unchanged in behaviour down to the disabled main half while the canonical is being assembled and the originals staying reachable throughout; the admin **Delete** of `11 §11.5d` moves to the **foot of the same tab**, under the file rows and a rule of its own, still red, still opening the same modal with the same inventory, still sending the reader to `/documents` on success — 🔒 **and not next to Download**, since the whole list stands between them precisely so that the destructive one is not reached by accident; the **processing panel** moves to the head of the `Log` tab under a **Processing** heading, with the history below it under a **History** heading, keeping the step grid, the skip reasons, the per-step error, the admin checkboxes, **Reprocess** and **Analyse the whole document**, and neither section repeating the word on the tab; the panel's cards give way to plain sections inside the tabs, so the main column still draws no card of its own (`11 §11.5`); what is left in the sidebar is the title, the description, the Add-to-collection select and the thumbnail; the whole-document Download is renamed **Download the document**, since on the Files tab it stands over a column of per-file Downloads and "Download" twice in one pane names two different things; localized ru/en with the keys in English; the viewer's web tests follow each control to its new pane, and cover the new tab's address, its empty state with a working picker, a linked row's thumbnail and unlink, and the distance between Download and Delete.

---

## M25 — The pages come back in the order the paper meant

A PDF sometimes arrives with its pages shuffled — a duplex scanner interleaves them, a phone app
appends the page that was rescanned, a batch lands back-to-front. Today nothing in the product can
say so: the ordering unit is the **file** (`05 §5.6` Reorder rewrites `document_files.position` and
nothing finer), and a multi-page PDF is merged into the canonical verbatim (`05 §5.5` step 1.1: "a
PDF → itself, as is"). The pages inside one file have no order of their own, no way to be seen one
by one, and no way to be corrected short of re-scanning. These two tasks give a file a page order —
stored beside `crop`, obeyed by the canonical build, arranged by hand in the Files tab. Per golden
rule 3 the docs move first with each task: `03 §3.3.16`, `05 §5.5`/`§5.6`, `07 §7.3`, `09 §9.2` and
`11 §11.5a` say nothing about pages inside a file today.

- [x] **M25.1 — A file remembers the order of its pages**
  **Goal:** a three-page PDF scanned in the wrong order becomes a canonical whose pages read first to last — without rewriting a byte of the original.
  **Docs:** [`03 §3.3.16`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md), [`09 §9.2`](../09-file-storage.md), [ADR-021](../02-architecture-overview.md#adr-021-a-file-is-not-a-document)
  **Acceptance:** `File.pageOrder` — a permutation of the file's 0-based page indices, `null` meaning the natural order, meaningful only for PDFs exactly as `crop` is only meaningful for images (`03 §3.3.16`); the file's **page count** is recorded on the file every time the canonical build reads it, so the contract can refuse a wrong permutation without asking Stirling at edit time; `PATCH /api/documents/:id/files/:fileId` takes `pageOrder` beside `crop` — `422 FILE_NOT_PDF` for anything else, `422 VALIDATION_FAILED` for a list that is not a permutation of exactly that file's recorded pages or for a file whose page count no build has recorded yet, `null` restoring the natural order — and saving enqueues the same rebuild every composition change does (`05 §5.6`); the canonical build applies the order to that part **before the merge**, through a new `PdfToolbox` operation backed by Stirling's page-rearrange endpoint, and 🔒 **the original bytes are never rewritten** — a LIBRARY file is read-only by ADR-007 and a MANAGED original stays the original, the order living beside it as an instruction the build reads, which is also why clearing it simply restores what arrived; `GET /api/documents/:id/files/:fileId/pages/:page/thumb` answers a small JPG of one page of the **original** file — rendered through the existing page-to-JPG operation on first request, cached in the private bucket beside the file's other artifacts and served by signed URL like every artifact (`09 §9.2`), cacheable indefinitely because file bytes are immutable, purged with the file when the trash empties; 🔒 the route sits behind the same access guard as the file's content; `DocumentFileDto` carries `pageOrder` and `pageCount`; tests cover the permutation validation (wrong length, repeated index, out-of-range index, not a PDF, no recorded count), a rebuilt canonical whose page text stands in the stored order, a cleared order rebuilding to the natural one, a thumb rendered once and then served from the bucket, and the order surviving a reprocess of every step.

- [x] **M25.2 — The pages are put in order by hand**
  **Goal:** the Files tab shows the pages of a shuffled PDF and lets a person drag them into the order the paper meant.
  **Docs:** [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab), [`07 §7.3`](../07-api-specification.md), [`10 §10.2`](../10-frontend-architecture.md)
  **Acceptance:** a PDF row with more than one recorded page gains **Arrange pages**, expanding the row into a strip of numbered page thumbnails in the stored order (the natural one where none is stored), fetched lazily from the thumbs endpoint of M25.1 so opening the tab costs nothing for the rows nobody expands; a page is dragged into place with a pointer — touch included — and moved with the keyboard once focused (arrows move it one position, with the same reasoning as M17.4: a hit area only a mouse can use is half a fix); the strip holds the pending order locally with **Save** and **Cancel** — Save sends the whole permutation, exactly as file reorder sends the whole order (`07 §7.3`), Cancel discards it — and the tab's existing rebuild note covers what happens next; **Restore original order** clears the stored order the way Clear crop clears a crop; a row whose stored order differs from natural wears a **Rearranged** tag beside the **Cropped** one, so the list says at a glance which files were touched; the strip never renders for a single-page or non-PDF file; localized ru/en with the keys in English; web tests cover the keyboard path end to end, Save sending the permutation and Cancel sending nothing, Restore sending `null`, the tag appearing and disappearing, and the strip's absence on single-page and image rows.

---

## M26 — A loupe over the corner being dragged

- [x] **M26.1 — The corner is watched through a loupe**
  **Goal:** on a 14-inch screen, the corner of a photographed A4 sheet can be placed to the pixel instead of to the general area.
  **Docs:** [`11 §11.5c`](../11-ui-ux-spec.md#115c-the-crop-editor)
  **What is being spent.** The crop editor shows the image at whatever size fits under 60 vh — a 3000-pixel-wide photograph lands on screen at roughly a fifth of its resolution, and the corner being placed is hidden under the very pointer placing it. The handles nudge by exact pixels, but nobody can see what they are nudging onto.
  **Acceptance:** while a handle is being dragged, a **loupe** floats beside it showing the neighbourhood of that corner from the source image at **no less than its natural resolution** — the modal scales the image down, the loupe does not — with the crop outline drawn through it and a crosshair marking the exact point; it follows the corner as it moves, keeps out from under the pointer and inside the modal, and disappears on release; the keyboard path gets the same precision — the loupe shows while a focused handle is being nudged — because the arrow keys are exactly the moment one pixel matters; no second fetch: the loupe draws from the image element the editor already loaded; the editor's coordinate model, its save path and its layout seam (`use-image-frame`) are untouched, so every existing test still passes unchanged; localized strings only if the loupe says anything at all; web tests cover the loupe appearing on drag and on a focused nudge, disappearing on release, and magnifying beyond the frame's own scale on a frame smaller than the source.

---

## M27 — What a person confirmed, the machine believes

- [x] **M27.1 — Confirmed values travel with every later reading**
  **Goal:** a value a person corrected stops being invisible to the model that reads the document next — it becomes the one thing that model is told to trust.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`06 §6.3.3`](../06-backend-architecture.md), [`03 §3.3.10`](../03-domain-model.md), [`03 §3.3.10a`](../03-domain-model.md)
  **This one amends a rule.** `05 §5.5` step 4 currently skips the analysis wholesale when the document's type was chosen by hand — `MANUAL_TYPE`, introduced when the analysis could only have overwritten the choice. That protection now costs the document everything else the analysis reads: a manually-typed document never gets a date, a place, its people or a description from the pipeline again. The skip retires; the confirmed type rides along instead, and so does everything else a person has fixed.
  **Acceptance:** the analysis and the fields calls both carry a **"confirmed by a person"** block: every value whose source says `MANUAL` — the title, the document type, each typed field — and every present metadata value that differs from the machine's own recorded reading in `autoValues` (date, country, city, description, people, subjects: the columns that carry no source of their own, whose divergence from `autoValues` is precisely a person's hand); the prompt states what the block is — validated by a person, outranking anything read off the page, to be used to resolve what the page leaves ambiguous and never contradicted; 🔒 **the block travels inside the same nonce-fenced data channel as the document text** — human-entered strings are data, not instructions, whoever typed them; a document whose type is `MANUAL` is **analysed rather than skipped** — the model is told the type, asked for everything else, and its opinion on the type is recorded in `autoValues.typeSlug` and applied nowhere; `MANUAL_TYPE` leaves the skip-reason set, the migration clearing it from stored `skipReasons` where it gated an analysis that can now run, and the hourly sweep walks those documents through; every fill-blanks and per-field `MANUAL` protection of `05 §5.5` holds exactly as before — this task changes what the model is told, never what may be overwritten; tests cover the assembled prompt carrying a `MANUAL` title, type and field and a diverged country, a `MANUAL`-typed document running the analysis with the type answer ignored, confirmed fields surviving a fields re-run byte for byte, and the block absent entirely on a document nobody has touched.

---

## M28 — The pane about the document, in three sections

- [x] **M28.1 — What it says, what it is, what it cost**
  **Goal:** the Details pane separates what a person may correct from what simply is — and the Edit button visibly owns the first and nothing else.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab), [`03 §3.3.18`](../03-domain-model.md)
  **What is being spent.** The pane opens with two rows nobody can edit (size, pages), runs every correctable row under them, drops created and OCR at the foot, and floats one Edit button at the top right of the whole pane — so the button claims rows it cannot touch, and the reader learns which rows are facts of the artifact and which are readings off the paper only by pressing it. The step-cost table beneath, meanwhile, is the one section `11 §11.5` never enumerates — `§11.5a` refers to it in passing as "a table of step costs nobody had asked for", and this task is where the spec finally asks for it.
  **Acceptance:** the Details pane renders three titled sections, in order: **What it says** — every correctable row: document type, people, subject kinds, subjects, document date, page format, languages, place, and the typed-fields group of the document's schema — with the **Edit button in this section's own header**, `E` and `Escape` behaving exactly as before; **What it is** — the rows nobody can edit: size, pages, created, OCR used; **What it cost** — the step-cost table exactly as it stands, which `11 §11.5` now describes in words (one row per step, the newest run only, a missing number is not a zero); edit mode turns rows into inputs in the first section **only** — the other two never re-render; the "read as …" line and the one-click reset keep working row for row; the ru catalog renders the three as «Что здесь написано» / «Что это» / «Что это стоило» (final wording lives with the catalog, keys in English); web tests cover each row landing in its section, edit mode leaving the second and third sections untouched, and the Edit control living in the first section's header rather than the pane's.

---

## M29 — The pipeline grades its own work

- [x] **M29.1 — Every reading step says how well it went**
  **Goal:** "how badly was this document read" becomes a number on the document, not a discovery made by opening it.
  **Docs:** [`03 §3.3.10`](../03-domain-model.md), [`03 §3.3.18`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`06 §6.3.3`](../06-backend-architecture.md), [`11 §11.5`](../11-ui-ux-spec.md)
  **What is missing today.** The only judgement in the product is `textQuality` — a ternary, answered in passing, acted on by one alert. The fields step answers values with no word on how sure it is. Nothing anywhere says "this scan was barely legible and the reading shows it" in a form that can be compared, sorted or watched.
  **Acceptance:** the analysis answers **two marks from 0 to 100** beside its existing verdict — **legibility** (how readable the source pages themselves are: focus, lighting, resolution, cut-off edges) and **extraction** (how faithfully the stored text carries what the pages visibly say — the numeric refinement of `textQuality`, whose ternary survives as the coarse verdict the Text tab already acts on); the fields step answers **confidence** from 0 to 100 over its whole reading; each mark is validated in code — clamped to the range, dropped when absent or unparseable, and 🔒 **a missing mark is not a zero** (`03 §3.3.18`'s rule, word for word); the marks land in `autoValues.quality` and on the step's `STEP_FINISHED` payload beside its cost, so the journal keeps what each run thought of itself; the **What it cost** table of M28.1 draws each mark beside its step's other numbers as `87/100`, and the Text tab's quality alert carries the extraction mark beside its words where one exists; 🔒 **a mark is the model's opinion of its own output and gates nothing** — no re-run, no failure, no threshold acts on it (M18.3's reasoning: a model that says "partial" twice is not a reason to spend twice); tests cover the parsing (in-range kept, out-of-range clamped, absent dropped, non-numeric dropped), the marks landing in `autoValues` and the journal, and the two render sites.

---

## M30 — Schemas for the papers this archive actually holds

Three new schemas and three revisions, written from twelve documents of a real archive read in the
original: two e-tickets and a boarding pass, utility bills from three countries — among them a
combined bill collecting seven providers onto one payable total — a clinical lab report, a driving
licence, a webshop invoice and a till receipt. Three decisions, taken from the papers themselves:
(1) **one `flight` type** covers e-tickets, itinerary receipts and boarding passes — the papers
differ in which fields they fill, not in what they are, and a table of coupons (one row per
passenger per leg) absorbs the four-passengers-one-flight ticket and the one-passenger boarding pass
alike; (2) **a combined utility bill is one `invoice`** whose line items each name their provider —
the paper is one bill with one total, and splitting it would invent documents the drawer does not
hold; (3) **card-format identity papers and state papers on blanks split** — `id-card` and
`passport` stay for what lives in a wallet, and `civil-certificate` covers what a registry office
prints on a numbered blank (birth, death, marriage, divorce). A version bump re-reads on the next
`fields` run with `MANUAL` values preserved per field (`03 §3.3.10a`) — that rule already exists and
these are its first users.

- [x] **M30.1 — A flight is a booking, its people and its coupons**
  **Goal:** "when did we fly to Istanbul and what did it cost" is answered by fields, not by re-reading the ticket.
  **Docs:** [`03 §3.3.10a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`11 §11.5`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** the registry gains `flight` v1 — `airline` (string, searchable, summary), `bookingReference` (string, searchable, summary: the PNR, the one string every airline paper repeats), `totalPrice` (money, summary: what the booking cost where the paper says, absent on a bare boarding pass), and a `coupons` table of one row per passenger per leg: `passenger` (searchable), `flightNumber` (searchable), `from` (searchable), `to` (searchable), `date` (yyyy-mm-dd as a string column), `departure`, `arrival`, `seat`, `class`, `ticketNumber` (searchable) — so the four-passenger single-leg e-ticket is four rows, the two-passenger itinerary is two, and the boarding pass is one with no price; the hints teach the shapes the papers use (airport codes with the city as printed, times as printed, the ticket number as the airline's own digits); the `flight` type joins the seed; labels `viewer.fields.flight.*` land in both catalogs; tests exercise `sanitizeFieldValues` and the details table against answers shaped like the three travel papers this task was written from, and the summary line of the card carries airline, PNR and price.

- [x] **M30.2 — A bill is lines that have to add up**
  **Goal:** a utility bill — single-provider or the town's combined one — keeps its positions, its amounts and its due date as data.
  **Docs:** [`03 §3.3.10a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`11 §11.5`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** the registry gains `invoice` v1 — `vendor` (string, searchable, summary: the biller, which on a combined bill is the collector everyone pays), `accountNumber` (string, searchable: the personal account the payment names), `invoiceNumber` (string, searchable), `billingPeriod` (string, summary: the month the bill charges, as yyyy-mm), `issuedAt` (date), `dueAt` (date, summary), `totalDue` (money, summary: the figure actually asked for, debt and penalties folded in where the paper folds them), `previousBalance` (money), `paidAt` (date: filled when the paper knows it, otherwise a person's note after paying), `paymentReference` (string, searchable: poziv na broj, назначение платежа — the string that ties a bank statement line back to this paper) — and an `items` table: `provider` (searchable: who renders this line's service, equal to the vendor on a single-provider bill, one of seven on the combined one), `service` (searchable), `quantity` (number), `unit` (string), `rate` (number), `accrued` (number), `adjustment` (number, signed: перерасчёт and popust both), `due` (number: this line's own "к оплате"); line amounts are bare numbers in the bill's one currency — the currency lives once, on `totalDue`; `receipt` moves to v2, built on the owner's proven finance-parser scheme — a till receipt's second job in an archive is answering "which bank-statement line is this", so beside the vendor as printed it gains `statementDescriptor` (string, searchable: merchant, city and country code the way a bank statement prints them, e.g. `TROPIC MALOPRODAJA VISEGRAD BA`), `purchasedTime` (string, hh:mm — two same-day receipts differ by it), `paymentMethod` (string: `cash` or `card`, the hint teaching the tell-tale markings — a masked PAN, POS/TID/RRN lines, "Безналичными"/"Platna kartica" say card; "Наличными"/"Gotovina" say cash), `card` (string, searchable: the masked digits as printed, e.g. `*8534`), `vendorTaxId` (string, searchable), `receiptNumber` (string, searchable: the fiscal or order number), `taxAmount` (number: the total VAT in the receipt's own currency — the currency lives once, on `total`), and the items table gains `unitPrice` (number: per unit or per kilogram) and `discount` (number) beside name, quantity and amount — ATM and exchange slips stay `receipt` with the bank or the menjačnica as the vendor, a dedicated schema owed only if that proves too small; the seed carries the `invoice` slug the instances already use; labels in both catalogs; tests exercise sanitization against answers shaped like the five bills read for this task — including the combined one whose items name seven providers — and the photographed till receipt with its card digits, method and time, and a v2 reading preserving a `MANUAL` v1 value per `03 §3.3.10a`.

- [x] **M30.3 — The papers about a person**
  **Goal:** a lab report keeps its analytes, a licence its categories, a certificate its blank number — each findable by the string a person remembers.
  **Docs:** [`03 §3.3.10a`](../03-domain-model.md), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`11 §11.5`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** the registry gains `lab-report` v1 — `patient` (string, searchable, summary), `facility` (string, searchable), `orderNumber` (string, searchable), `collectedAt` (date, summary: when the sample was taken, which is the date that matters medically), `reportedAt` (date), and a `results` table: `analyte` (searchable), `value` (string: numbers and verdicts both — "positive" is a result), `unit`, `reference` (the printed interval), `flag` (the out-of-range mark or note, as printed) — one row per analyte, panels flattened; the registry gains `civil-certificate` v1 for the state papers on numbered blanks — `certificateNumber` (string, searchable, summary: the blank's series and number), `actNumber` (string, searchable), `actDate` (date), `issuedBy` (string, searchable: the registry office), `eventDate` (date, summary), `eventPlace` (string, searchable), `issuedAt` (date) — and who the paper is about stays on the document's people links, because that is what the links are for; `id-card` moves to v2 with `issuingCountry` (string, searchable: the state that issued it, which the document's own country row does not answer when a Serbian archive holds a Russian licence), `birthDate` (date) and `categories` (string: a licence's vehicle classes as printed); `passport` moves to v2 with `issuingCountry` on the same reasoning; the `lab-report` and `civil-certificate` types join the seed; labels in both catalogs; tests exercise sanitization against answers shaped like the lab report and the driving licence read for this task, and the version bumps preserving `MANUAL` values per field.

---

## M31 — A click on a link is a navigation, not a request

Pressing a document in the archive does nothing at all until the server answers. The link is a
proper `<Link>` and the address is right; what is wrong is underneath it. Every page of the
authenticated area is an `async` server component whose first act is `await currentUser()` — a
loopback call to `/api/me` — and the `(app)` layout has *already* made that call one component
above, so a navigation pays for the same answer twice, in sequence. Meanwhile `src/app/` holds no
`loading.tsx` at all, and in the App Router a segment with no loading boundary above it cannot
commit until its payload arrives: the URL does not change, nothing is drawn, and the archive sits
there looking broken. `11` has asked for loading as a universal state since its first paragraph, and
`10 §10.2`'s routing map never named a boundary.

The rule this milestone applies is one the viewer already wrote down for its own tabs — *the tab
switches on the click rather than after the navigation: a tab that waits for the router to come back
feels broken* — and never applied to the routes themselves.

- [x] **M31.1 — The page is drawn before the server is asked**
  **Goal:** a click in the archive lands on the document's screen at once, and the document arrives into it.
  **Docs:** [`10 §10.2`](../10-frontend-architecture.md#102-routing-map), [`11 §11.1`](../11-ui-ux-spec.md#111-shell--navigation), [`11 §11.14`](../11-ui-ux-spec.md#1114-cross-cutting-ui-rules), [`08`](../08-auth-and-authorization.md)
  **Acceptance:** the signed-in user is fetched **once per request** — `currentUser` is memoized for the render pass, so the `(app)` layout, the `admin` layout and anything else asking in the same pass share one answer instead of queueing loopback calls; the layout **provides the user to the client tree** it already renders, and every page of `(app)` stops calling `currentUser` for `isAdmin` and becomes a **synchronous** server component — `documents`, `documents/:id`, `documents/:id/:tab`, `collections/:id`, `people`, `subjects`, `subject-kinds`, `document-types` — so the segment has nothing to await and the navigation commits on the press; the screens read the role from that context rather than from a prop handed down by a page that no longer knows it; 🔒 **the `admin` segment's guard stays on the server** — it is authorization, it answers `404` as `08` says, and it does not move into the client because a role read in the browser is a role a browser can lie about; it is merely no longer a second round trip, being a cache hit off the layout's own call; a `loading.tsx` covers the authenticated area as a genuine safety net for a segment that does suspend, drawn as the screen's own skeleton rather than a spinner (`11` opening paragraph), and 🔒 **it must not fire on a viewer tab switch** — `router.replace` between `/documents/:id/preview` and `/documents/:id/text` would otherwise blank the screen it is standing on, which is the very defect this task removes, one level down; localized ru/en with the keys in English; tests cover a page rendering without awaiting anything, the role reaching a screen through the provider, the admin guard still answering `404` to a non-admin, and one `/api/me` per navigation where there were two.

---

## M32 — A release is over when the image is out

`npm run release` waits for the check that lets it cut the release and then stops waiting for
anything: it pushes the tag, prints where to watch, and hands back a prompt while the thing a
release is *for* — the image every deployment pulls — has not been built yet. So the person who ran
one command runs a second one, `gh run list --workflow Release`, and then a third, until `latest`
finally moves; and the failure that matters most — a red release build, an image that never got
published — is the one the command never sees, because it stopped looking one minute in.

The end of a release is not "the tag is pushed". It is `latest` in the registry resolving to the
image this tag built, and that is the line the command should be allowed to print.

- [x] **M32.1 — The release command waits for `latest`**
  **Goal:** one command from a green `main` to a pullable image, with nothing to watch afterwards.
  **Docs:** [`13 §13.3`](../13-ci-cd.md#133-githubworkflowsreleaseyml), [`13 §13.3a`](../13-ci-cd.md#133a-releasing)
  **Acceptance:** after the push, `scripts/release.mjs` follows `release.yml` to its end and finishes on the registry — it picks **the tag's run** out of the two the one push starts (`head_branch === vX.Y.Z`; `main`'s run tags the branch and never moves `latest`), reports it on the same rewriting line as the CI wait now counting jobs (`3/5 jobs`), waits 2 minutes for the run to appear and 45 for it to finish, then asks GHCR what `X.Y.Z` and `latest` resolve to — an anonymous pull token and a `HEAD` on the manifest, no docker and no extra token scope — and prints the digest only when the two agree; a red run refuses with the failing job names **and** the line saying whether `latest` moved anyway, which is what separates a failed `build` from a failed `scan`; 🔒 **the push stays the point of no return** — everything after it only watches, so a timeout and a Ctrl-C both say the tag is out and CI carries on without the command; `13 §13.3`'s tag list is corrected to what `metadata-action` actually publishes (`X.Y.Z`, not `vX.Y.Z`).

---

## M33 — One step is stopped without stopping the stage

A pause exists and it is the wrong size. `document-process` is one queue holding the six steps of
`05 §5.5`, so an operator whose analyst has started answering nonsense has exactly one switch, and
throwing it stops the canonical PDFs, the previews, the extraction and the vectors as well — every
document in the archive waits on a step that was never the problem. The alternative available today
is worse: turn the provider off in env and restart, and every document processed meanwhile records
`SKIPPED / NOT_CONFIGURED` — a verdict about the document, written because a container was broken,
which somebody has to undo afterwards one screen at a time.

The knob that is missing is the one the trouble has the shape of: **the step**. Held rather than
skipped, because a step that did not run has learnt nothing and must record nothing; drained on
resume, because that is what separates a pause from an off switch.

- [x] **M33.1 — A step of the pipeline can be paused, and it holds**
  **Goal:** an operator stops the one step that is misbehaving, and the archive goes on doing everything else.
  **Docs:** [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`05 §5.4d`](../05-library-and-processing.md#54d-a-step-can-be-paused), [`03 §3.3.10`](../03-domain-model.md), [`03 §3.3.21`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `pausedSteps` joins the queue settings row and travels in `GET`/`PATCH /api/admin/queue/settings` beside `paused`, a step name this version does not know dropped on write and a stored value it cannot read ignored — the hygiene the queue names already get (`03 §3.3.21`); `document-process` reads the list **per job**, so it needs no re-registered worker, and **holds** every paused step: no status, no skip reason, no journal entry, the row left exactly as it was, because a step that has not run has reached no verdict to record; it holds what the pause leaves without an input too — `preview` and `markdown` where `canonical` is held and no canonical was built before, `analysis`, `fields` and `vectorization` where `markdown` is held and no text was extracted before, `fields` where `analysis` is held and the document has no type at all — while an input missing for a reason of its own is untouched, so a `FAILED` extraction still fails the steps that read it and a `SKIPPED` one still passes its reason down; a reprocess drops the paused steps from what it asks for and is refused with `409 STEPS_PAUSED` where they are all of them, on `POST /api/documents/:id/reprocess` and `POST /api/admin/queue/reprocess` alike; the hourly sweep asks for **the unstarted steps of a document rather than its whole pipeline** — a document waiting on its vectors is worth one embedding call, not an OCR pass it has already had — and passes over a step that is paused, so a held document is not re-enqueued hourly to be held again; releasing a step enqueues it for the documents whose it is `PENDING`, newest first and bounded by `QUEUE_REPROCESS_MAX`, through the same use case a repair uses, with the sweep taking what the bound left; `GET /api/pipeline/paused-steps` publishes the list to every signed-in caller — one instance-wide fact rather than a field repeated on every document response, read by the page that shows a document's steps; tests cover a held step leaving its row untouched while the steps beside it run and settle, a held `canonical` holding the two steps that read it rather than failing them, an already-built canonical letting them run under the same pause, a held `analysis` holding `fields` only where the document has no type, a reprocess of a paused step refused and a mixed one enqueueing the rest, the sweep passing over a document held on its only unstarted step and asking for the unstarted steps of one it does take, and a release enqueueing what waited.

- [x] **M33.2 — The switch is where the step is named**
  **Goal:** pausing a step, and seeing that one is paused, happen on the screens that already talk about steps.
  **Docs:** [`11 §11.13`](../11-ui-ux-spec.md), [`11 §11.5`](../11-ui-ux-spec.md), [`05 §5.4d`](../05-library-and-processing.md#54d-a-step-can-be-paused)
  **Acceptance:** the pipeline-counters table of `/admin/queue` gains a switch on each step's row, read exactly as a stage's is — **on means the step runs** — with the row tagged paused beside its counts the way a paused queue is tagged beside its depth, and one line saying the documents queue at a held step rather than being skipped past it; the per-status and per-step run-again icons are **not offered** for a paused step, an icon that answers `409` being worse than no icon; the document's **Processing** panel tags a paused step for every reader and says under its name that it is `PENDING` on purpose, and an admin's checkbox for that step is not selectable; saving rides the same `PATCH` the concurrencies do, offered only once something differs from what the server holds; localized ru/en with the keys in English; tests cover the switch saving what it changed and nothing else, the tag on both screens, and a paused step offering neither a re-run icon nor a checkbox.

---

## M34 — The panel is read at a glance, and a wait says it is waiting

Two failures of the same screen, found the same afternoon. `/admin/queue` grew into one column a metre
long — five stage cards, a table of steps inside one of them, a block of external services, a table of
failures, a storage figure — where everything was present and nothing was findable; and when an
operator set the Stirling gate to one call at a time, the panel gave them no way to tell a throttle
that was working from a setting that never took. Two documents sat at `Канонический PDF` with
identical start times, because the worker starts a batch the size of its concurrency and a step is
marked `RUNNING` before it asks the gate for a slot — which is exactly what a broken gate looks like
too. The gate was fine. The screen was not: the counters that would have answered it in one glance
were never published, and `05 §5.4b` claimed the cost of gating "shows up on /admin/queue" while
nothing there named a wait.

- [x] **M34.1 — Four tabs, one question each**
  **Goal:** an operator opens the panel and knows within a second whether anything is wrong, and where.
  **Docs:** [`11 §11.13`](../11-ui-ux-spec.md), [`10 §10.2`](../10-frontend-architecture.md#102-routing-map), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `/admin/queue` becomes four tabs — **Overview**, **Pipeline**, **Services**, **Failures** — with the open one in the address (`/admin/queue/:tab`, `overview` at the bare path) through a `[tab]` segment that is **synchronous** and validated on the server, an unknown tab answering `404`; the tab switches **on the click** rather than after the navigation, by the `router.replace` pattern the viewer already uses, and 🔒 **no `loading.tsx` may sit at or below `admin/queue/`** — the test that enumerates boundaries under `src/app` covers this segment too (`10 §10.2`); **Overview** replaces the five stage cards with one row per stage — named twice, one line of what it does, queued / active / failed in 24 h, its concurrency, its runs-switch and a paused tag — over a **summary line** naming what is not in order (queues paused, steps held, failures in a day, a service that did not answer), each part linking to the tab that deals with it, and saying so plainly when nothing is wrong; the bucket figure stays on Overview; **Pipeline** holds the step table with its counters, links, re-run icons and per-step switches, plus units-per-job and the analysis language; **Services** holds one row per service with its address, health tag, gate inputs and Check button; **Failures** holds the failed-jobs table and its tab label carries the count; 🔒 the auto-refresh switch stops calling itself a pause — one screen with three different pauses, one of which only stopped the numbers moving, is the difference between reading this page and misreading it — and it applies to whichever tab is open, on the slower cadence for the probes; localized ru/en with the keys in English; tests cover each tab drawing its own block and not the others', the address following the press, an unknown tab answering `404`, the summary line naming a paused step and a failure count, and saving a stage's concurrency from the Overview row.

- [x] **M34.2 — A gate says what it is doing**
  **Goal:** "is the throttle working" is answered by looking, not by reading logs on the host.
  **Docs:** [`05 §5.4b`](../05-library-and-processing.md#54b-per-service-gates), [`07 §7.3`](../07-api-specification.md), [`11 §11.13`](../11-ui-ux-spec.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `ServiceGates` answers a snapshot — per service `inFlight`, `waiting` and `longestWaitMs`, the last being how long the caller at the front has stood there and `0` when nobody has — read straight off the semaphore, stored nowhere and computed from a clock the tests control; it travels in `GET /api/admin/queue/overview` beside the counters it shares a 5-second clock with, one row per service in `SERVICE_NAMES` order, and deliberately **not** in `/services`, whose answer is a cached probe of somebody else's container; the **Services** tab shows the three numbers on each service's row beside the two that decide them, so one call in flight with three waiting reads as a throttle doing its job and three in flight reads as a setting that never took; the **Pipeline** tab tags the step whose service has callers waiting — *waiting for Stirling: 2* — mapping step to service exactly as the journal does (`canonical`/`preview` → stirling, `markdown` → docling where it is configured and stirling where it is not, `analysis`/`fields` → classifier, `vectorization` → embeddings), which is what makes two documents reading `RUNNING` at one step legible instead of alarming; an ungated service (`0`) shows no counters rather than three zeroes, because nothing is being metered there; localized ru/en with the keys in English; tests cover a gate of one reporting one in flight and the rest waiting with a growing longest wait, the numbers falling back as slots free, an ungated gate reporting nothing, the overview carrying a row per service, and the pipeline row tagging the step whose service has waiters.

---

## M35 — The emit that ships is the emit that was tested

`0.16.0` took the `canonical` step of 318 documents down with
`Cannot read properties of undefined (reading 'now')`, and every one of 1695 tests was green when it
shipped. The class the gates live in read a constructor parameter property from a field initializer —
legal TypeScript, and `undefined` at run time under native class fields, because a field initializes
before the constructor body it is assigned in. It only fires where a caller actually waits, which is
what an operator gets the moment they set a gate to one call at a time.

The reason no test saw it is the more important half: `.swcrc`, which the test runner and the dev
server transpile with, lowers class fields to constructor assignments, while `tsc` at `target:
ES2023` emits them natively. CI ran one language and production ran another.

- [x] **M35.1 — The gate keeps its clock, and the two toolchains agree**
  **Goal:** the failure is gone from the code, and the class of failure is gone from the repository.
  **Docs:** [`14 §14.1`](../14-coding-standards.md#141-typescript--strictly-by-the-types), [`05 §5.4b`](../05-library-and-processing.md#54b-per-service-gates)
  **Acceptance:** `ServiceGates` builds its gates **inside the constructor, from the parameter**, so no field initializer reads `this.` of anything the constructor body assigns; `tsconfig.server.json` states `useDefineForClassFields: false` explicitly beside the `experimentalDecorators` it belongs with — the value `.swcrc` already uses, and the pairing legacy decorators want — so the build and the test transform emit the same JavaScript; `14 §14.1` carries both rules, the second naming what it cost; a test asserts the two config files still agree, because behaviour cannot catch a divergence that only exists in the emit; and the built artifact is exercised the way production exercises it — a gate of one, three callers, one in flight and two waiting — which fails on the code as it shipped and passes on the code that replaces it.

---

## M36 — A suggestion is a document, and a document can be looked at

The Related tab proposes at most five documents that cite this one's identifiers (`05 §5.6b`), and
each proposal was a thumbnail, a title and "cites № 12-2019". That is enough to tell two acts apart
and not enough to decide anything about them: the reader asked "is this the contract that receipt
settles" had to leave the tab, read the other document in its own viewer and find the way back — so
the list was read and never acted on. And the two answers people actually have for a pair of papers
were missing from it entirely: *these are one document*, and *this one is the same scan twice*.

- [x] **M36.1 — Look at the suggestion before deciding about it**
  **Goal:** a proposal can be read where it is proposed, and the three things a reader may decide about the pair are offered in the same place.
  **Docs:** [`11 §11.5e`](../11-ui-ux-spec.md#115e-the-related-tab), [`05 §5.6`](../05-library-and-processing.md), [`05 §5.6b`](../05-library-and-processing.md), [`03 §3.3.10`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** pressing a suggestion row in the Related tab opens the candidate **in a modal, as the viewer draws it** — preview, text, log, details and files, under the same tabs, with the title at the head as a link into the full viewer; 🔒 the peek **reads and never writes**: no Edit button and no `e` shortcut on Details, no add / replace / crop / arrange / reorder / split on Files, no reprocess controls on Log, no re-read on Text and no Delete section, the downloads staying because reading needs them — each pane taking a `readOnly` state rather than growing a second copy of itself; 🔒 the peeked document's own **Related tab is not drawn**, since suggestions inside a suggestion are a corridor; the peek's foot and the row both carry **Link**, **Combine**, **It's a duplicate** (ADMIN only) and the way out, so nothing is offered in one place and hidden in the other; **Combine** appends the other's files to this document and rebuilds it (`POST /api/documents/:id/combine`) behind a confirmation, because a press in a list of proposals is a smaller gesture than the tick-two-and-press of §11.3; **It's a duplicate** deletes the candidate (`DELETE /api/documents/:id`) behind the inventory §11.5d already reads out — files and bytes going, originals on the volume staying and never re-ingested, not reversible — and is drawn for nobody else, since the endpoint refuses them; the peek costs one document fetch and asks for the catalogues of a form it will never open; localized ru/en with the keys in English; tests cover the row opening the peek, the peek drawing the candidate's panes with no Related tab and no editing affordance, Link posting the edge, Combine posting the combine after the confirmation, the duplicate deleting the other document for an admin and being absent for a reader, and Cancel leaving the suggestion where it was.

---

## M37 — Search over every field, and a search that says what it searched

`search_vector` carried the title, the extracted values and the Markdown, and nothing else: a
document's **description** and its **place** were written down and searchable by nobody, and the one
string a person actually remembers about a scan — **what the file is called** — was in another table
and therefore in no search at all. Typing `IMG_0042` or `act-12-2019.pdf` returned an empty screen
over an archive that holds exactly that file. And because nothing on the screen ever said what was
being looked at, the empty answer read as "not here" instead of "not searched".

- [x] **M37.1 — Everything the document has a word in**
  **Goal:** the archive answers to any word it holds, including the names of the files it is made of and the people and things it is about.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`04 §4.4`](../04-database-schema.md), [`07 §7.3`](../07-api-specification.md), [`05 §5.6b`](../05-library-and-processing.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** hand-written forward-only migrations drop and recreate `search_vector` with **description** at `B` and **country/city** at `C` beside what it already carried, recreate its GIN index, and add a GIN index over the names of `files`, `people` and `subjects`; 🔒 every one of those expressions — and the query itself — tokenises by one rule, `_`, `-` and `.` as separators (`translate`), because Postgres reads `kadastar.pdf` as a single token and an archive that answers only to a file name typed out in full answers nobody; the text search matches those three tables **where the names live** — joined through `document_files` / `document_people` / `document_subjects`, never denormalised onto the document, so a rename or a merge is searchable the moment it commits and no write path can silently make a document unfindable (`04 §4.3`); 🔒 the candidate set is a union of index scans and the access rule is still applied in SQL before the limit, so a name matching inside a document the caller may not read is not a row; ranking stays one `ts_rank`, over the document's vector with the matched names appended at weight `A`; the snippet is cut from the title, the matched names, the description and the head of the Markdown, so the highlight lands on what matched; each hit carries **`matchedIn`** — `title`, `fileName`, `person`, `subject`, `fields`, `description`, `place`, `text` for the text half and `meaning` for the semantic one, computed for the answered page only and fused when both halves found the same document; the link-suggestion probes of `05 §5.6b` inherit all of it, since a probe is an ordinary search; tests cover finding a document by its file name and by nothing else, by a person's name straight after a rename, by its description and by its city, the access rule holding for a name match, `matchedIn` naming the right parts, and the ranking putting a file-name hit among the titles rather than below the archive.

- [x] **M37.2 — A search that says what it is looking at**
  **Goal:** an empty answer means "not here", not "you searched for something I was not looking at".
  **Docs:** [`11 §11.6`](../11-ui-ux-spec.md#116-search-searchq), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `/search` names its own reach in one line under the input — title, fields, description, text, place, and the names of files, people and things — and each mode says in a tooltip what it does with the words (match them, match the meaning, both fused); every result row carries quiet tags for the parts that matched, from `matchedIn`, localized ru/en with the keys in English; 🔒 the tags stand on the search screen and **not** in the overlay of §11.1a, which is three rows and a way in; the shared result row keeps drawing identically in both places when it is given no reasons; tests cover the reach line, a row tagged as a file-name match, a row tagged as a meaning match, and the overlay drawing no tags at all.

---

## M38 — Vectors an instance can actually have

Semantic search has been shipped, documented and unusable: the vector half needs an embeddings
provider, the column was sized `vector(1536)` for a hosted model, and the usual local ones are 768
or 1024 wide — so the honest way to switch on the second half of hybrid search was to sign up
somewhere and send the archive out. The live instance has run that way since the beginning: 0 chunks,
`semanticAvailable: false`, and 1828 journal entries saying the step was skipped for want of a
provider.

And the table records nothing about which model wrote a vector, so the day somebody changes models
the archive holds two incomparable geometries in one column and search goes quietly wrong.

- [x] **M38.1 — A local model by default, and a vector that says who made it**
  **Goal:** an operator with ollama on the network has semantic search after three environment variables, and a model change can never be a silent one.
  **Docs:** [`03 §3.3.11`](../03-domain-model.md), [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`04 §4.5`](../04-database-schema.md), [`05 §5.5`](../05-library-and-processing.md), [`07 §7.3`](../07-api-specification.md), [`12 §12.4`](../12-build-config-run.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a hand-written forward-only migration empties `document_chunks` — derived data whose text was cut from the document's own Markdown, so nothing that cost a scan is lost — retypes `embedding` to `vector(1024)`, adds `model`, recreates the HNSW index, and sets every document whose vectorization was `DONE` or `SKIPPED` back to `PENDING` with its skip reason cleared, so the hourly sweep of `05 §5.4` walks the archive through the new model 200 at a time; a `FAILED` step is left alone, being blocked on its own extraction; the defaults become `EMBEDDINGS_MODEL=bge-m3` and `EMBEDDING_DIMENSIONS=1024`, which is what the column is sized for; `EmbeddingProvider` answers `model` beside `isConfigured` and `endpoint`, and the vectorization step writes it on every chunk it stores; `GET /api/admin/queue/overview` carries `vectors: { chunks, byModel }` from one grouped count, and the Pipeline tab draws it on the vectorization row — 🔒 more than one model in that list is a switch that has not finished, which is the one state where a cosine distance means nothing (`04 §4.5`); localized ru/en with the keys in English; the test fixtures stop repeating the width as a literal and read one shared constant; tests cover a vectorised document storing chunks of the configured width **with** the model that made them, a provider answering another width failing the step rather than half-writing the document, the overview grouping chunks by model, and the admin row drawing the count.

---

## M39 — Talking to the archive

The vectors are in (M38), the search answers by words and by meaning, and the only way to ask this
archive a question is still to type into its own search box. What people actually want — "which
contract does that receipt settle", "what did we sign in March" — is a conversation, and the
honest way to give them one is not a chat product inside a document manager: it is to let the model
they already talk to reach the archive. The credential for exactly that has been sitting in `08
§8.2a` since it was written, naming "an assistant answering questions about what is filed here" as
the case it exists for.

- [x] **M39.1 — MCP over the read-only token**
  **Goal:** point Claude, or any MCP client, at this instance and ask it about the papers in it.
  **Docs:** [`02 ADR-024`](../02-architecture-overview.md), [`07 §7.3a`](../07-api-specification.md), [`08 §8.2a`](../08-auth-and-authorization.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `POST /api/mcp` speaks JSON-RPC 2.0 by hand — `initialize`, `notifications/initialized` (answered `202`, empty), `ping`, `tools/list`, `tools/call` — with JSON responses, no SSE and no session state; three read-only tools over existing use cases: `search_documents` (the hybrid search, snippets stripped of `<mark>`, each row carrying `matchedIn` and a `url`), `get_document` (the metadata) and `read_document` (the Markdown **in slices**, `totalChars` + `nextOffset`, capped, because a forty-page scan does not fit a context window); 🔒 the credential is a read-only API token and **only** that — a session cookie is refused on this route even when valid, which is what leaves the CSRF rule of `08 §8.4` inapplicable rather than excepted; 🔒 the one place where a POST may carry a bearer is declared once (`isReadOnlyPostRoute`) and consulted by the origin check, the read-only middleware and `SessionGuard` alike, with a test that the exception is exactly this route and that `POST /api/documents/:id/reprocess` with a bearer is still `403 READ_ONLY_TOKEN`; every tool runs under the token owner's access rule, so a document in a library they were never granted is not in an answer; unknown method → `-32601`, parameters that do not fit → `-32602`, unparsable body → `-32700`, a batch → `-32600`, and a tool that fails answers `isError` with a sentence rather than a transport error; tests cover the handshake, the tool list, each tool against a seeded archive, the access rule holding for a user's token, the slicing of a long document, and every refusal above.

---

## M40 — An outage is not a verdict, and a parse no bigger than the window

On 2026-08-18 the host that runs Docling ran out of memory, and the kernel killed the parser eight
times in one evening — taking the reverse proxy and sshd with it, because one parse of one long PDF
wants 3–4 GB on a box that has four. Every failure the pipeline met that night was an infrastructure
failure — `fetch failed` while the host thrashed, `502` while the container was down, "did not
finish within 5 minutes" while it crawled through swap — and the pipeline recorded every one of them
as the fate of a document: ~350 documents `FAILED`, each waiting for a person to press Retry, on the
instance whose whole promise is that the pipeline runs itself. Two diseases, two cures: the pipeline
must tell a service being away from a document being broken, and no single document may cost the
parser more memory than the box can give.

- [x] **M40.1 — An outage is not a verdict**
  **Goal:** a service being unreachable costs the pipeline time, never a manual retry.
  **Docs:** [`05 §5.4`](../05-library-and-processing.md#54-job-queue-pg-boss), [`05 §5.4e`](../05-library-and-processing.md#54e-an-outage-is-not-a-verdict), [`06 §6.8`](../06-backend-architecture.md#68-queue-integration-pg-boss), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a typed `ServiceUnavailableError` names the service and what failed, and every service client — Stirling, Docling, the analyst, the transcriber, the embeddings provider — throws it where the transport failed (undici's `fetch failed`, an abort on the call's own `05 §5.4a` timeout) or the answer was `502`/`503`/`504`, and nowhere else: a `500` from a model that choked on one document is still that document's failure, and a `404` is configuration, not weather; 🔒 when the error reaches a step of `document-process`, the step goes **back to `QUEUED`** — not `FAILED`, with `processingError` and `failedStep` untouched — and the error is rethrown so pg-boss retries the job with its backoff, exhaustion leaving the steps `QUEUED` for the hourly sweep of `05 §5.4`, so a document is never marked failed because a container was away; the transcriber stays best-effort as `05 §5.5` step 3 already has it — its outage leaves the recognised text and interrupts nothing; the gate of the failed service refuses the units that follow with the same error for 30 seconds (a constant, like every `05 §5.4a` bound), fail-fast and working even on a `0/0` gate, the first caller past the hold being the probe; tests cover each classified shape becoming the typed error in the clients, an unclassified `500` still failing the document, an interrupted markdown step left `QUEUED` with no `processingError` and the job rethrowing, the analysis and vectorization paths doing the same, the transcriber outage falling back to the recognised text, and the breaker refusing during the hold and admitting after it.

- [x] **M40.2 — A parse no bigger than the window**
  **Goal:** the longest document costs Docling no more memory than a two-dozen-page one.
  **Docs:** [`05 §5.4a`](../05-library-and-processing.md#54a-what-one-document-may-cost), [`05 §5.4b`](../05-library-and-processing.md#54b-per-service-gates), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `ParseOptions` carries the canonical's page count (`0` where unknown) and the handler passes it from the canonical it just built, falling back to the row; a document longer than the window — 24 pages, a code constant per `05 §5.4a` — is submitted to Docling window by window through `page_range` on the same async endpoint, the same upload each time with only the range moving, ranges 1-based, in order, clamped to the page count because a range past the last page is a request Docling rejects; the Markdown of the windows is stitched in page order; 🔒 **each window is one unit of the `docling` gate**, so the operator's cooldown breathes between the windows of one document; a document at or under the window sends **no `page_range` field at all** — byte for byte the request this step has always sent, including every document whose page count is unknown; the `05 §5.4a` budgets hold per window and the whole parse shares one 55-minute deadline under the job's hour; the Stirling fallback is untouched; tests cover a long document fanning into the right ranges and stitching in order, a short document and an unknown page count sending no `page_range`, the ranges clamping at the last page, each window passing through the gate as its own unit, a mid-parse window failure surfacing as the step's failure, and the shared deadline cutting a parse that overstays.

---

## M41 — A number in either alphabet

Twelve Cyrillic capitals are drawn exactly like Latin ones — А В Е К М Н О Р С Т У Х — which is why
a Russian number plate is made of those twelve and no others: they are the letters that read the same
to a foreign camera. OCR keeps whichever alphabet the glyph came from, so the VIN on a Russian
registration is stored as `ХТА210700М0596136` with four Cyrillic letters inside it, and the person
who types `XTA210700M0596136` off their own papers gets an empty screen from an archive that is
holding exactly that document. The two strings are the same string on the page; to Postgres they are
two unrelated tokens. The same holds in reverse for a Serbian polis printed in Latin and searched by
somebody thinking in Russian.

- [x] **M41.1 — A number is findable in the alphabet it is typed in**
  **Goal:** a VIN, a plate or an account number finds its paper whichever keyboard it was typed on, and no word is folded to reach it.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a hand-written forward-only migration adds `fold_to_latin` / `fold_to_cyrillic` — the mapping of the twelve pairs, written once and in one direction each way — `homoglyph_twins`, which emits both readings of every **alphanumeric run containing a digit**, and `search_tokens`, the one expression any text in this archive becomes searchable through: the separator rule of the migration before it, plus the twins beside the token as written; 🔒 the fold reaches identifiers only — a run with a digit in it is a number and not a word — so `Москва` is never indexed as `Mockba`, no Latin word can be made to match a Russian one, and the ranking of ordinary prose does not move; 🔒 the stored side is **additive**, so nothing findable before the migration stops being findable, and the **query is never folded**: the caller's words reach Postgres in the alphabet they were typed in, which is what keeps `ts_headline` marking them; the `search_vector` generated column and the three name indexes are rebuilt on `search_tokens`, and the search (`07 §7.3`) asks through that same expression everywhere it compares — the three name branches, the name ranking and each of the five reasons a hit may carry — because an index is only usable by a query written in the expression it was built on; tests cover a Cyrillic-scanned number found by a Latin query and a Latin one found by a Cyrillic query, a Russian word staying unreachable by its Latin look-alike, the query travelling unfolded as a bound parameter, and every comparison going through the one expression.

- [x] **M41.2 — The letters Serbian shares with Latin**
  **Goal:** the rule covers the whole script it claims to, not the alphabet of one country's number plates.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** `Ј` (U+0408), `Ѕ` (U+0405) and `І` (U+0406) join the mapping and the test inside `homoglyph_twins`, making fifteen pairs — `Ј` is an everyday letter of the Serbian alphabet drawn exactly like a Latin `J`, and an OCR pass set to Cyrillic emits `Ѕ` or `І` where a paper says `S` or `I`; 🔒 the migration rebuilds `documents.search_vector` and all four indexes rather than only replacing the functions, because a stored generated column is not recomputed and an expression index is not rebuilt when a function they call changes — both would answer by the old mapping silently and for ever, and that rebuild is the rule for every future change to these functions; a test covers a Serbian paper found through `Ј`.

---

## M42 — The same street, spelled both ways

This archive holds one address written twice: `STANISLAVA SREMCEVICA 020A` on an invoice from a
Belgrade parts shop, and `Stanislava Sremčevića 20/1` on the utility bill for the same flat. A person
searching either spelling finds one of the two documents and has no way to learn the other exists.
It is not the homoglyph case: `č` and `c` are different letters that look different, and whether a
paper carries the mark depends on who typed it — a Serbian registry, a Turkish rental desk, a German
hotel, or a system that could not.

- [x] **M42.1 — A mark is not a spelling**
  **Goal:** the same word finds the same papers whether or not anybody typed its diacritics.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a hand-written forward-only migration enables `unaccent` and adds `fold_diacritics` — a hand-declared IMMUTABLE wrapper naming the dictionary, because both forms of `unaccent` are STABLE and may appear in neither a generated column nor an index — and `unaccented_twins`, a second reading of every word that carries a mark and nothing for the words that do not, the whole text folded once first so a document with no marks costs one comparison; `search_tokens` gains that third reading and the column and all four indexes are rebuilt per the rule of `04 §4.3`; 🔒 **this fold reaches words, so both sides fold**: a mark cannot be put back — `c` could have been `c`, `č` or `ć` — so the query (`07 §7.3`) gains a **second branch** with its own marks removed, OR-ed onto the first rather than replacing it, each branch being the whole query so that what a person joined with a space stays joined, and the first branch still matching the text as written, which is where the highlight comes from; the dictionary is `unaccent` rather than a hand-written table, so Serbian `đ`, Turkish `ı` and `ğ` and every Latin mark the archive has yet to meet are already known, and Cyrillic is left exactly as it is; tests cover the marked paper found by a plain query and the plain paper found by a marked one, and the highlight still landing on the spelling the paper carries.

---

## M43 — One name, two scripts

The owner of this archive is `Шершнев Евгений Константинович` on every Russian paper in it and
`SHERSHNEV EVGENII` on every Serbian one — the same person, filed twice, and neither spelling reaches
the other. `Београд` and `Beograd` are the same city. This is neither of the two rules before it:
`Б` looks nothing like `B`, so no fold of glyphs joins them, and no mark is involved. It is
transliteration — a mapping between alphabets, which rewrites whole words and therefore has to be
pointed at exactly what it is for.

- [x] **M43.1 — A name is one name in two scripts**
  **Goal:** the person, the street and the city are found whichever alphabet the paper that mentions them was printed in.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** a hand-written forward-only migration adds `transliterate_serbian` (the official bijective Serbian Latin) and `transliterate_russian` (ICAO Doc 9303 — not a choice of taste but the spelling printed on this archive's own documents), and `transliterated_twins`, which stores every Cyrillic word under **both** readings rather than guessing its language, the Serbian one folded through `fold_diacritics` so `чачак` is reachable as `cacak`; `search_tokens` gains that fourth reading and the column and all four indexes are rebuilt per the rule of `04 §4.3`; the query (`07 §7.3`) gains **two further branches** reading Cyrillic out the same two ways, for the direction the stored side cannot serve — somebody typing `Шершнев` reaching the paper that says `SHERSHNEV`; 🔒 both mappings require lowercase input and `transliterated_twins` lowercases every run, because `translate` is per character and an uppercase letter would otherwise leave Cyrillic sitting inside a Latin word; 🔒 **three characters is the floor** — two-letter Cyrillic words are the function words of both languages and read out as `na`, `on`, `no`, `to`, `za`, `da`, which the `simple` configuration has no stop words to protect the archive from; 🔒 **the first 64 000 characters of a value** — a `tsvector` may not exceed 1 MB and this is the one twin function that fires on every word of every Cyrillic document, so past the bound a document stays findable in the script it was written in, a search that misses the tail of one long scan being a smaller failure than a document that cannot be written at all; tests cover the name found from either side, the city in either alphabet, and short words staying unreadable as Latin.

- [x] **M43.2 — A bound that holds, and a floor that does**
  **Goal:** the three folds cost what they claim to cost, and stop where they claim to stop.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`07 §7.3`](../07-api-specification.md), [`14 §14.8`](../14-coding-standards.md#148-testing)
  **Acceptance:** three corrections, each found by measuring rather than reasoning. 🔒 **The bound was on the wrong function**: only `transliterated_twins` was capped, on the argument that the other two fire on few tokens — which is about frequency where the ceiling is about size, and Serbian Latin prose is diacritic-dense while an OCR'd parts list is almost nothing but identifiers; measured, a 326 kB Serbian document indexed to 543 kB before this work and 1 060 kB after, over the 1 MB a `tsvector` may hold, and `search_vector` being `STORED` that is a **failed document write**, plus a `ADD COLUMN … GENERATED` that aborts a migration running on container start — all three folds are now bounded at 32 000 characters, which covers every title, name, description and place and a dozen pages of prose, and is not where the names are since people and things are indexed in their own short rows. 🔒 **Three characters was not a floor**: it stopped `на`/`он`/`но` and let through `год`→`god`, `сам`→`sam`, `дом`→`dom`, `нет`→`net` — `год` is on every dated Russian paper — so the floor is four, where what survives are cognates (`план`/`plan`, `банк`/`bank`) worth matching. 🔒 **A reading equal to the run it came from is no longer stored**, being already in the vector it is concatenated onto; with that and the bound the identifier-dense worst case sits at 931 kB where it was 1 240 kB. Two limits are now stated in the docs rather than left to be discovered: a hit reached only through a fold carries **no highlight**, and a fold does **not cross a phrase query**. Tests cover the five short words staying unreadable as Latin and a fold-only hit answering without a mark.

---

## M44 — The instance observed, not visited

Development keeps asking a running instance two questions — *what is the app logging?* and *what
does the data say?* — and until now each answer was an interactive ssh session with the standing
permission that implies. Both questions are read-only and narrow; the access should be too. This
repository is public, so the tooling can carry the shape of the access and none of its values.

- [x] **M44.1 — Two read-only questions, two scripts**
  **Goal:** the app log and the database are readable from the dev machine through committed, fixed-shape, read-only tooling, with every deployment-specific value outside the repository.
  **Docs:** [`12 §12.8b`](../12-build-config-run.md#128b-observing-a-live-instance-from-the-dev-machine)
  **Acceptance:** `scripts/ops/prod-logs.sh` (targets `app` and `health`) and `scripts/ops/prod-db.sh` (SQL from argument, file or stdin; `--csv`) exist and read every host name, container name and credential from `~/.config/legere/ops.env` (`LEGERE_OPS_ENV` overrides; `scripts/ops/ops.env.example` names the variables), refusing with exit 2 and the template's name when it is missing or incomplete; 🔒 nothing caller-supplied reaches the remote command — targets are fixed templates, `--since`/`--tail` are validated, `--grep` filters locally; 🔒 the database is reached as a dedicated role that is read-only by its PostgreSQL privileges, with `default_transaction_read_only=on` and a 15 s `statement_timeout` as the wrapper's seat belt, and the credential is never printed; `.claude/settings.json` (committed) allows exactly these two scripts unprompted, replacing the blanket ssh permission for routine observation; two project skills under `.claude/skills/` teach when each script answers and that Stirling/Docling/AI-provider health is read from `documents.processing_error` and `document_events`, not from anybody's host.

---

## M45 — A budget per page, not per window

A 13-page scanned bank statement failed its markdown step four times over two days with `Docling
did not finish within 5 minutes`, while a 40-page credit-bureau report passed beside it — split
into windows, each inside the budget. The flat five minutes was a per-page allowance in disguise:
12.5 s/page over a full 24-page window, where a dense-table scan — the paper this archive mostly
holds — measures 23–25 s/page on the live instance. Thirteen documents of exactly that class sat
`FAILED` while their host answered everything else in seconds; a document was punished not for
being long but for being dense, and only when it was short enough to arrive whole.

- [x] **M45.1 — Thirty seconds a page, and a smaller window**
  **Goal:** a document that is dense rather than long parses to Markdown instead of timing out on a healthy host.
  **Docs:** [`05 §5.4a`](../05-library-and-processing.md#54a-what-one-document-may-cost), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** one window's conversion budget is **30 s per page of the window, floored at 2 minutes** — set by measuring rather than reasoning: dense-table scans parse at 23–25 s/page, so the flat 5 minutes starved a 13-page statement sent as a single window while longer siblings passed, windowed; a window-less request is budgeted by the page count it knows, and by a full window's worth where nothing counted anything; the captions budget stays flat — a vision model runs once per picture, and pages say nothing about pictures — and the whole parse keeps its one 55-minute deadline under the job's hour; `DOCLING_PAGE_WINDOW` drops from 24 to 12, halving the memory ceiling a window puts on Docling along with the wait a slow window can cost, and doubling the headroom the per-page budget buys; 🔒 the request timeouts of `05 §5.4a` are untouched, being bounds on the HTTP exchanges that carry a window rather than on the conversion between them; tests cover the scaled budget cutting a 12-page window at 6 minutes, the floor cutting a one-page window at 2, an unknown page count budgeted as a full window, and the window arithmetic at 12.

---

## M46 — The log reads as one story

The Log tab told the truth in the wrong shape. The processing panel was a form first — a checkbox
column at rest, six identical grey `QUEUED` pills, the enum untranslated in a localized UI — when
almost every visit is a glance at six states. The history under it spent two rows on every step and
a mostly-empty Who column, and silently ended at the server's default page: the client never sent a
cursor and never read `nextCursor`, so a document a few re-runs deep had already lost its own
creation off the end of what presented itself as the whole history. And the two sections, which
answer one question at two depths, shared no visual language at all.

- [x] **M46.1 — The panel as an instrument, the history as a journal**
  **Goal:** the Log tab reads as one story — the current state above, its journal below, in one row grammar — and the history is complete rather than silently cut.
  **Docs:** [`11 §11.5`](../11-ui-ux-spec.md#115-document-viewer-documentsidtab)
  **Acceptance:** the processing panel draws each step as glyph · name · dotted leader · state in the reader's words, with the newest settled duration read off the events query the tab already fetches; skip reasons, pause hints and failures stay under their own step, and the remedy stands beside the complaint it answers — **Retry this step** under a failure, **Analyse the whole document** beside the length skip — admin-only; reprocess lives in the section head (**Reprocess everything**, with **Choose steps…** beside it — only then do checkboxes appear, with a count-named button and a Cancel), a paused step still not selectable; the history groups each run under its `QUEUED` entry with one line per step folding the started/settled pair — *running*/*interrupted* told honestly for a pair an outage severed — under day headings, short times with ISO on hover, authors beside human entries, a copy control on the monospace ids, and **Show more** paging through `nextCursor`, fixing the silent cut at the server's default page; step statuses are written out translated everywhere they appear (the Details pending badges included), `reprocessSelected` takes an ICU plural, and the Russian tab name becomes «Журнал»; the peek modal keeps the journal and loses the controls, as before.

---

## M47 — Closing what the second audit found

The findings of [`security-audit-2026-08-second-pass.md`](./security-audit-2026-08-second-pass.md),
fixed and tested. Forty-four confirmed findings against `v0.22.0`, none of them Critical and three of
them High — the shape of a codebase that was audited once and kept its habits, with the new surface
of the last eleven months as the part nobody had read.

Ordered, like M15, by what an attacker reaches first rather than by where the code lives. Tasks that
need a documentation decision before any code say so and are **blocked**: take the first unchecked
task that is not blocked, and raise the blocked ones with the owner instead (golden rule 3).

The last five tasks are the ones the audit would have missed. A completeness critic read the nine
reviews' coverage claims against the real route table and named four subsystems nobody had opened —
the catalogues, the rate limiter's actual reach, request-path mutation racing a worker, and the
schema against its own migrations. Fifteen of the twenty-seven findings that came back from those
probes survived refutation, which is a better yield than the reviews themselves managed.

- [x] **M47.1 — Composing a document is not the same right as naming it**
  **Goal:** an ordinary user can no longer destroy or forge a library document they did not create.
  **Docs:** [`03 §3.4a`](../03-domain-model.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** closes [SEC-47](./security-audit-2026-08-second-pass.md#sec-47). `canEditDocumentMeta`'s "anyone may tidy up a library document" branch is what `PATCH /documents/:id` keeps; composition asks a second question of its own, and the operations that destroy stop inheriting the metadata rule. **The decision taken** is the second shape, written into `docs/03 §3.4a` with its reason: creator-and-admin would collapse to admin-only on a library document, whose `createdById` is `null`, and would kill the very affordance the comment argues for. The line is one test — *does the operation, on its own, make a page stop being read anywhere?* Arranging (add at a position, reorder files, reorder pages, page order and turns inside a file, crop, turn, split off a file, split at a page, move pages, and combine's **target**) stays with `canEditDocumentMeta`; destroying (**remove a page**, **replace a file**, and combine's treatment of each **source**) is `canDestroyDocumentContent` — the creator's or an `ADMIN`'s. Remove-a-page is the one the audit could not name and it falls on the destroying side: the file behind the last page reading it goes to an `ADMIN`-only trash with its refs `EXCLUDED`. Tests: a `USER` who did not create a library document is refused replace, remove-a-page and combine-as-source on it and an ADMIN is not; the same `USER` may still add, crop, turn, reorder, split and move; the metadata path keeps its current behaviour and its current test.

- [x] **M47.2 — One document still cannot take down the server**
  **Goal:** no single upload, crop or scan makes the one process stop answering.
  **Docs:** [`05 §5.4a`](../05-library-and-processing.md#54a-what-one-document-may-cost), [`09 §9.1`](../09-file-storage.md)
  **Acceptance:** closes [SEC-48](./security-audit-2026-08-second-pass.md#sec-48), [SEC-49](./security-audit-2026-08-second-pass.md#sec-49), [SEC-52](./security-audit-2026-08-second-pass.md#sec-52), [SEC-61](./security-audit-2026-08-second-pass.md#sec-61), [SEC-75](./security-audit-2026-08-second-pass.md#sec-75). The 80 Mpx budget binds the **crop** path as well as the decode path, so a small PNG with a large requested region is refused rather than allocated; the canonical build streams or bounds the number of converted parts it holds at once, and a document's file count is bounded explicitly rather than by whatever the disk allows; `tidyMarkdown`'s backtracking regex gets an input bound or a linear rewrite; the request-path routes that buffer a whole file take a concurrency bound like the pipeline's gates; and the `excludeGlobs` complexity cap counts extglob constructs, not only `*`. Tests: each bound refuses its own bomb, and each refusal is a 422 rather than a timeout.

- [x] **M47.3 — The queue does one thing per document at a time**
  **Goal:** a document is processed once per change, and a neighbour's failure is not a document's problem.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`06 §6.6`](../06-backend-architecture.md)
  **Acceptance:** closes [SEC-50](./security-audit-2026-08-second-pass.md#sec-50), [SEC-53](./security-audit-2026-08-second-pass.md#sec-53), [SEC-59](./security-audit-2026-08-second-pass.md#sec-59), [SEC-85](./security-audit-2026-08-second-pass.md#sec-85). `document-process` is singleton-keyed per document, so a burst of cheap PATCHes coalesces instead of queueing a full run each; the job's expiry is longer than the run it carries, or the run renews it, so a slow document is not re-delivered beside itself; a batch handler fails only the job that failed; and a stored queue concurrency is bounded on read like the service gates beside it. Tests: N rapid PATCHes produce one run; a run outliving the old expiry is not duplicated; one poisoned job in a batch leaves its neighbours completed.

- [x] **M47.4 — A log is still not a place to keep credentials**
  **Goal:** a support bundle does not hand over the archive.
  **Docs:** [`06 §6.7`](../06-backend-architecture.md#67-logging), [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist)
  **Acceptance:** closes [SEC-58](./security-audit-2026-08-second-pass.md#sec-58). The request log stops writing response headers wholesale: `Location` on a presigned redirect and `Content-Disposition` are the two that carry a credential and a filename, and an allow-list of headers replaces the current shape — the deny-list lesson of [SEC-23](./security-audit-2026-08.md#sec-23) applies to headers as much as to config. Tests: a download's log line contains neither the signature query nor the filename, asserted on both the redirect and the streamed branch.

- [x] **M47.5 — The catalogue is not a channel into the analyst**
  **Goal:** what one user types cannot steer the analysis of documents they cannot read.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`03 §3.3.19`](../03-domain-model.md)
  **Acceptance:** closes [SEC-55](./security-audit-2026-08-second-pass.md#sec-55). Subject notes and catalogue names reach the model as **data**, not as part of the system message — the two-channel design [SEC-11](./security-audit-2026-08.md#sec-11)'s fix rests on is restored for the catalogue as it already is for the document — and the kind list is capped like the subject list beside it. Tests: a subject note containing an instruction does not change the analysis of an unrelated document; the system message is bounded whatever the catalogue holds.

- [x] **M47.6 — An address cannot be denied its own recovery**
  **Goal:** a stranger cannot spend somebody else's verification attempts.
  **Docs:** [`08 §8.1.3`](../08-auth-and-authorization.md#813-the-three-account-setup-steps-shared-by-onboarding-invites-and-password-resets), [`08 §8.4.1a`](../08-auth-and-authorization.md#841a-the-login-backoff-and-what-it-may-never-do)
  **Acceptance:** closes [SEC-57](./security-audit-2026-08-second-pass.md#sec-57). §8.4.1a's principle — a backoff may slow an attacker down and may never stand between an account and its own password — gets its verification-code twin: an attempt is charged only to a caller who proves they hold the link the series was created from, or the cap is per-(series, IP) with a larger per-series ceiling, or exhaustion re-issues rather than deletes. Tests: five wrong codes from a stranger do not stop the holder's correct code; the brute-force cap the attempts exist to enforce still holds.

- [x] **M47.7 — The login queue is not a user's to fill**
  **Goal:** one signed-in account cannot deny login to everybody.
  **Docs:** [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)
  **Acceptance:** closes [SEC-54](./security-audit-2026-08-second-pass.md#sec-54). `POST /api/me/password` is throttled before it reaches the Argon2 concurrency gate, so the gate serves logins rather than a user's replay. Tests: sustained password-change requests from one account leave login latency unchanged.

- [x] **M47.8 — The walls hold on every read path**
  **Goal:** a list never shows what its detail refuses.
  **Docs:** [`03 §3.4`](../03-domain-model.md), [`08 §8.5`](../08-auth-and-authorization.md#85-content-access-model), [`05 §5.3`](../05-library-and-processing.md)
  **Acceptance:** closes [SEC-63](./security-audit-2026-08-second-pass.md#sec-63), [SEC-64](./security-audit-2026-08-second-pass.md#sec-64), [SEC-71](./security-audit-2026-08-second-pass.md#sec-71), [SEC-84](./security-audit-2026-08-second-pass.md#sec-84). The document journal stops publishing the title and id of a link the reader may not read — resolved for the whole page through `listReadableItems`, and applied to every payload carrying `otherDocumentId`, so a split's and a move's entries are covered as well as a link's; `processingError` and a journal entry's `error` are admin-only, the reader keeping `failedStep`; a shared collection reports the count the grantee may actually list, soft-deleted items excluded. **The decision taken** (the register numbers this one under SEC-71, not SEC-65, which is the API-token finding of M47.10): `docs/03 §3.3.16` is the document that was wrong, and it moves — deduplication is by `contentHash` alone, so a `MANAGED` file may have `FileRef`s, which is what `05 §5.3` describes and what the ingest path does. The fix is therefore in the read path: `listInFolder` takes a `Viewer` and ANDs `readableSql` like every other list, rather than assuming a granted library makes everything a ref in it reaches readable. Tests: browse and detail agree for every viewer, including the upload-then-scan order nothing covered before.

- [x] **M47.9 — What the client is told, and what it keeps**
  **Goal:** the browser stops leaking a reader's attention and a signed-out user's data.
  **Docs:** [`10 §10.x`](../10-frontend-architecture.md), [`12 §12.8`](../12-build-config-run.md#128-production-notes)
  **Acceptance:** closes [SEC-66](./security-audit-2026-08-second-pass.md#sec-66), [SEC-68](./security-audit-2026-08-second-pass.md#sec-68), [SEC-77](./security-audit-2026-08-second-pass.md#sec-77), [SEC-89](./security-audit-2026-08-second-pass.md#sec-89). The CSP gains the directives a one-directive policy is missing — `img-src` at minimum, so a document's Markdown cannot beacon to the uploader's host; ending your own last session clears the query cache exactly as Sign out does; and the Turnstile widget either mints a token on the client or the CAPTCHA claim leaves §8.4 and §8.6 — an empty div is the worst of both, since enabling the secret key today locks everyone out. The follow-up task `docs/12 §12.8a` says is tracked gets written or the sentence goes.

- [x] **M47.10 — A revocation revokes everything**
  **Goal:** the product's one remediation actually remediates.
  **Docs:** [`08 §8.2a`](../08-auth-and-authorization.md#82a-api-tokens-read-only), [`08 §8.1.6`](../08-auth-and-authorization.md#816-password-reset-admin-initiated)
  **Acceptance:** closes [SEC-65](./security-audit-2026-08-second-pass.md#sec-65). An admin-issued password reset revokes the account's API tokens along with its sessions, or the admin screen says plainly that it does not and offers the second button. Tests: a token minted before a reset does not answer after it.

- [x] **M47.11 — The deployment hardens what parses**
  **Goal:** the containers that open attacker-supplied bytes are not the unhardened ones.
  **Docs:** [`12 §12.7`](../12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository), [`13`](../13-ci-cd.md)
  **Acceptance:** closes [SEC-62](./security-audit-2026-08-second-pass.md#sec-62), [SEC-78](./security-audit-2026-08-second-pass.md#sec-78), [SEC-79](./security-audit-2026-08-second-pass.md#sec-79). Stirling and Docling get the hardening the app container already has (non-root, `no-new-privileges`, dropped capabilities, a read-only rootfs where the image allows); SMTP requires TLS rather than accepting a stripped STARTTLS; and the two unpinned, unscanned images are pinned by digest and scanned by the same job that scans the rest. **SEC-62 is closed from the deployment only** — 465 with implicit TLS in the compose defaults, `.env.example` and `init.sh`, which is as far as a compose file reaches; the transport-level floor is application code and is M47.11a.

- [x] **M47.11a — Mail is encrypted, or it is not sent**
  **Goal:** a relay that will not encrypt gets an error, not the six-digit code.
  **Docs:** [`12 §12.4`](../12-build-config-run.md#124-envexample), [`12 §12.4a`](../12-build-config-run.md#124a-what-production-refuses-to-start-with), [`12 §12.8`](../12-build-config-run.md#128-production-notes)
  **Acceptance:** the residue of [SEC-62](./security-audit-2026-08-second-pass.md#sec-62) that M47.11 could not reach from `deploy/`. `SmtpEmailSender` passes `requireTLS: true` whenever `SMTP_SECURE` is false, so a server whose EHLO is missing the `STARTTLS` line — one line, deleted by anyone on the path — fails the send instead of opening a plaintext session that carries the relay password and every verification code and looks like success from both ends. An explicit opt-out (`SMTP_ALLOW_PLAINTEXT`, refused in production like the rest of §12.4a) keeps the relay-on-the-same-host case, and the failure says TLS rather than "mail is broken". Tests: a transport built with `SMTP_SECURE=false` requires the upgrade; the opt-out is refused in production.

- [x] **M47.12 — The MCP surface says what it is**
  **Goal:** the agent-facing API is as exact about its own rules as the register is.
  **Docs:** [`07 §7.3a`](../07-api-specification.md), [`08 §8.2a`](../08-auth-and-authorization.md#82a-api-tokens-read-only)
  **Acceptance:** closes [SEC-72](./security-audit-2026-08-second-pass.md#sec-72), [SEC-87](./security-audit-2026-08-second-pass.md#sec-87), [SEC-88](./security-audit-2026-08-second-pass.md#sec-88). The read-only-POST exemption matches paths the way the router resolves them rather than by exact string, so `/api/MCP` is the same route as `/api/mcp` to both; the CSRF exemption covers the API path and not Next's; and document text handed to a calling agent is marked as untrusted data, since the same repository already fences that identical text for its own model.

- [x] **M47.13 — An unreadable cursor is not an error**
  **Goal:** `docs/07 §7.1`'s promise holds for a forged cursor.
  **Docs:** [`07 §7.1`](../07-api-specification.md)
  **Acceptance:** closes [SEC-86](./security-audit-2026-08-second-pass.md#sec-86), the residue of [SEC-44](./security-audit-2026-08.md#sec-44). A cursor whose id is not a UUID starts the list over rather than reaching the driver and answering 500. Tests: a forged cursor answers 200 with the first page.

- [x] **M47.14 — The catalogue is a namespace, not a scratchpad**
  **Goal:** the instance-wide catalogues stop being an unbounded, unpaginated, wildcard-matched write surface open to every user.
  **Docs:** [`03 §3.3.19`](../03-domain-model.md), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** closes [SEC-51](./security-audit-2026-08-second-pass.md#sec-51), [SEC-56](./security-audit-2026-08-second-pass.md#sec-56), [SEC-69](./security-audit-2026-08-second-pass.md#sec-69), [SEC-76](./security-audit-2026-08-second-pass.md#sec-76). `POST /api/people`, `/api/subjects` and `/api/subject-kinds` are rate-limited and bounded, so one account cannot fill a namespace every other user reads; the catalogue read endpoints paginate like every other list; `subjectKindList` is capped the way the subject list beside it already is; and the uniqueness check stops compiling a user's `%`, `_` and `\` into an `ILIKE` pattern — it is a different predicate from the `lower(name)` unique index the database actually enforces, which is its own bug. Tests: a name containing a wildcard is matched as letters; the check and the index agree.
  *Since revised: "the check and the index agree" fully lands with M49.4 (the fold indexes) — M49.1 moved the uniqueness check onto `name_folded` while the indexes still enforce `lower(name)`, a divergence the fold migration deliberately deferred until the operator has merged the duplicates the old indexes admitted.*

- [x] **M47.15 — A composition cannot orphan what it touches**
  **Goal:** no sequence of composition operations leaves a document nobody but an admin can see, or bytes nobody can delete.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md), [`03 §3.4a`](../03-domain-model.md), [`09 §9.2`](../09-file-storage.md)
  **Acceptance:** closes [SEC-60](./security-audit-2026-08-second-pass.md#sec-60), [SEC-67](./security-audit-2026-08-second-pass.md#sec-67). **The decision taken:** the **behaviour** moves — `05 §5.6`'s "nothing else about the document changes" stands, and a composition may never change who may read a document. One invariant, `keepsItsReaders`, is asked before the write of every operation that can leave a document holding fewer pages, of the document it takes from *and* of every part it makes: replace, split off a file, remove a page, split at a page, move pages. A document with no creator that would hold no library page is refused with `422 DOCUMENT_WOULD_HAVE_NO_READERS` instead of being written and then reported missing. `reload` throwing on a committed write is now the assertion it accidentally was — an invariant violation the operator is told about, not a 404 for a change that happened. And combine deletes each absorbed document's canonical PDF, preview and thumbnail once the transaction commits, since nothing reaches a soft-deleted document again and `09 §9.2`'s "that delete is reversible" is not true of this one. Tests: a replacement never changes who may read the document; the refusal fires on the source and on the parts; the absorbed documents' artifacts are gone and their originals are not.

- [x] **M47.16 — Throttle state is bounded, and one client's burst is not everyone's**
  **Goal:** the rate limiter cannot be turned into either a memory leak or a shared penalty.
  **Docs:** [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha), [`08 §8.4.1b`](../08-auth-and-authorization.md#841b-what-the-throttles-forget-when-the-process-restarts)
  **Acceptance:** closes [SEC-70](./security-audit-2026-08-second-pass.md#sec-70), [SEC-73](./security-audit-2026-08-second-pass.md#sec-73), [SEC-74](./security-audit-2026-08-second-pass.md#sec-74). `InMemoryLoginAttempts.streaks` is swept or capped rather than growing forever on attacker-chosen 254-character addresses; a throttled IP stops cancelling every other client's decay timers, so the documented 20-per-60s window slides for everybody; and semantic search and the MCP `search_documents` tool are limited, since each spends an outbound embeddings call and shares the pipeline's gate.

- [x] **M47.17 — The schema is what the documents say it is**
  **Goal:** `docs/04` can be read as the truth about the database again.
  **Docs:** [`04 §4.1`](../04-database-schema.md), [`04 §4.3`](../04-database-schema.md), [`04 §4.5`](../04-database-schema.md#45-migration-policy)
  **Acceptance:** closes [SEC-81](./security-audit-2026-08-second-pass.md#sec-81), [SEC-82](./security-audit-2026-08-second-pass.md#sec-82), [SEC-83](./security-audit-2026-08-second-pass.md#sec-83). `docs/04 §4.1` gains the six models and one enum it is missing and loses the three lines that are not valid Prisma; `prisma migrate diff` against the migrated database is empty, or the residue (a foreign key still carrying its pre-rename name, six columns whose defaults `schema.prisma` does not declare) is recorded deliberately; and `collection_shares.grantee_user_id` stops being `ON DELETE SET NULL` when NULL is the value that means *everyone* — no user is hard-deleted today, which is the only reason this is Info rather than a live hole, and that is exactly the kind of landmine a forward-only migration policy exists to defuse.

- [x] **M47.18 — Two races and a long transaction**
  **Goal:** the pipeline and the request path stop disagreeing about what exists.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`09 §9.2`](../09-file-storage.md)
  **Acceptance:** closes [SEC-80](./security-audit-2026-08-second-pass.md#sec-80), [SEC-90](./security-audit-2026-08-second-pass.md#sec-90). The pipeline no longer outruns the object write of the request that enqueued it — the comment saying it cannot is wrong, and the resulting canonical failure is permanent — and `DELETE /api/admin/document-types/:id` stops resetting every document that carried the type inside one 5-second transaction over rows whose `search_vector` is recomputed on rewrite.

- [x] **M47.19 — The page CSP that two documents said was already a task**
  **Goal:** a script that reaches the viewer has no way to run, and the promise made in [SEC-06](./security-audit-2026-08.md#sec-06) option 2 stops being a sentence about a task nobody wrote.
  **Docs:** [`12 §12.8a`](../12-build-config-run.md#128a-security-headers), [`10 §10.4a`](../10-frontend-architecture.md#104a-how-the-csp-nonce-reaches-a-page)
  **Acceptance:** this is the task [SEC-89](./security-audit-2026-08-second-pass.md#sec-89) found missing — written down first (M47.9), done here. Pages get `script-src 'self' 'nonce-…' 'strict-dynamic'` from a per-request nonce threaded through `@ant-design/nextjs-registry` and Next's own script tags, and the `connect-src` that is only worth having beside it: `'self'`, the browser-facing bucket origin the page policy already names, and whatever the login page's Turnstile widget calls ([`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)) — a directive that constrains fetches is worth nothing while any script may run, which is why it waits for this task and not for M47.9's. `'unsafe-inline'` is not the answer if the nonce turns out to be awkward: it would buy nothing while looking like it bought something, which is the reason the directive was deferred rather than shipped weak. **The decision taken:** the channel is the **request**, not React — `securityHeaders` writes the policy onto `req.headers['content-security-policy']` as well as onto the response, and Next's own `app-render` reads that header and stamps the nonce on every script tag it writes, so nothing is threaded through a provider and the middleware's place above the dispatcher becomes load-bearing rather than tidy (`10 §10.4a`). **`@ant-design/nextjs-registry` needed nothing**: it emits one `<style>` and no script, `script-src` does not reach a style, and `StyleProvider` has no `nonce` prop to give one — which is also why the policy gains no `style-src`, since a `style-src` nothing could carry a nonce for would have to say `'unsafe-inline'`. And the CAPTCHA origin is named in `connect-src` **unconditionally**, because the site key that decides whether there is a widget is baked into the client bundle and not into this process, exactly as `08 §8.4` argues for the secret's warning. Tests: a page carries a nonce that matches its own script tags and a different one on the next request; the viewer still renders a document, its preview and its canonical PDF; `/api` keeps the strict policy it already has.

- [x] **M47.20 — What the batch left behind**
  **Goal:** the five residues a review of this milestone's own commits found — each one true while the suite was green, which is what makes them worth a task rather than a follow-up comment.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`04 §4.5`](../04-database-schema.md#45-migration-policy), [`06 §6.7`](../06-backend-architecture.md#67-logging), [`08 §8.4`](../08-auth-and-authorization.md#84-csrf-rate-limiting-captcha), [`12 §12.4a`](../12-build-config-run.md#124a-what-production-refuses-to-start-with), [`12 §12.8`](../12-build-config-run.md#128-production-notes)
  **Acceptance:** (1) 🔒 `listFoldersUnder` takes a `Viewer` and ANDs the same `readableSql` its sibling in the same `Promise.all` was given for [SEC-71](./security-audit-2026-08-second-pass.md#sec-71) — a subfolder's `documentCount` is a count of documents this caller may open, and a folder holding none of them is not shown, because a cardinality is a smaller answer than a title and still an answer about the archive. (2) 🔒 The Turnstile lockout is signalled. **The decision taken:** a `configWarnings` entry fired **unconditionally** whenever `TURNSTILE_SECRET_KEY` is set, not a boot refusal — a refusal would have to read `NEXT_PUBLIC_TURNSTILE_SITE_KEY` from the runtime environment, where a correctly self-built image does not carry it (it is inlined into the bundle at build time), so it would refuse exactly the instance that did it right; and unconditional because copying both keys into `.env` is the natural thing to do and is precisely what silences the `/admin/instance` row. `08 §8.4` and `12 §12.4a` say what the code does. (3) 🔒 The request serializer becomes an allow-list like the response one — four headers kept, `Referer` dropped by rule rather than by name, and the `redact` block retired because every path in it had become unreachable ([SEC-23](./security-audit-2026-08.md#sec-23)). (4) 🔒 `12 §12.8` and both `.env.example`s say what an unset `TRUST_PROXY` now costs: since the throttle key became one budget per caller (M47.16), every anonymous caller behind an untrusted proxy is one caller, sharing a 20-per-60 s `auth` allowance that the sign-in page spends from on every load. No boot warning — at boot the two topologies are indistinguishable and warning on every correct deployment teaches operators to skip warnings — but one `warn` line, once per process, the first time a request arrives carrying `X-Forwarded-For` while `TRUST_PROXY` is empty, worded to push neither way because that header is the caller's to write (SEC-05). (5) `scripts/check-schema.mjs` holds both mechanical proofs of [SEC-81](./security-audit-2026-08-second-pass.md#sec-81)/[SEC-82](./security-audit-2026-08-second-pass.md#sec-82) — the fenced block of `04 §4.1` against `schema.prisma`, and `prisma migrate diff` against the five-line residue **read out of `04 §4.3` itself** — and the test suite runs both, so CI does. Tests: browse counts and the listing agree for every viewer, and a folder of unreadable documents is absent; the warning fires with the site key set beside the secret and production still starts; the log keeps four request headers and no `Referer`, end to end; the notice is written once and refuses nobody; the guard passes here and fails on a tampered copy of `docs/04` in both directions.

- [x] **M47.21 — The composition layer speaks pages, or it speaks the model ADR-025 retired**
  **Goal:** no composition path can trash a file another document reads, invent a file's pages, refuse what ADR-025 allowed, or write an older list back over a newer one.
  **Docs:** [`02` ADR-025](../02-architecture-overview.md#adr-025-a-document-is-an-ordered-list-of-pages), [`03 §3.3.16`](../03-domain-model.md), [`03 §3.3.17`](../03-domain-model.md), [`03 §3.4a`](../03-domain-model.md), [`05 §5.6`](../05-library-and-processing.md), [`07 §7.2`](../07-api-specification.md), [`07 §7.3`](../07-api-specification.md), [`04 §4.5`](../04-database-schema.md#45-migration-policy)
  **Acceptance:** ADR-025 made a document an ordered list of **pages** and retired "a file belongs to exactly one live document", but `FileRepository.attach` / `detach` / `reorder` were left speaking the old model and four use cases called them. **The decision taken:** the three methods are **removed** rather than patched, and every caller expresses itself in **entries** over two primitives — `replacePages`, which rewrites the whole list under the document's own lock and only if the list is still the reading the rewrite was computed from, and `appendPages`, which puts entries after whatever is there and therefore needs no precondition. Six defects close at that root: a replacement no longer trashes a file live pages still read (it goes through `filterFilesWithoutLivePages` like every other destroying path, with its refs `EXCLUDED`); combine and split-off no longer answer `409` for a file a second document reads; both carry the **pages the document actually held** — their turns, their crops, and none of the pages a split cut away; every edit that rewrites from a snapshot names that snapshot and is refused with `409 DOCUMENT_CHANGED` rather than reverting somebody's work; the canonical build's expansion re-reads the list inside its own transaction instead of overwriting it with a snapshot taken before minutes in Stirling; and a replacement stands where the old file's **first page** stood instead of regrouping the list into blocks of one file each. A replacement now reaches **every** document holding a live page of the bytes (the ADR's own sentence), bounded by the right to destroy content in each of them — `409 FILE_READ_ELSEWHERE` otherwise, which is what "the asker is told how many documents that is" became, a permission check being worth more than a warning. **SEC-47's remainder:** a file split off a document takes the **original's owner**, as a split at a page and a move into a new document already did — the caller's id made a reader the private owner of somebody else's uploaded page. Also: `POST …/files` and the replacement write their bytes **before** the transaction, minting the file id in the application, closing SEC-90 on the two routes M47.18 did not reach; the crop proposal joins the whole-file read gate; and a forward-only migration repairs the `page_order` values ADR-025's migration validated more weakly than the build it replaced (`[0,0,2]`, `[0,1,5]`), with a `CHECK` for the half a column can hold. Tests: a regression test per defect, each failing before its fix; the in-memory fake honours the precondition and no longer re-derives pages from a page count; and the three proofs M47.1 and M47.15 claimed but did not have — `DOCUMENT_WOULD_HAVE_NO_READERS` on a split's parts, on a move into a new document and on a page removal, a real crop request in the reader-may-arrange test, and a `MANUAL` crop asserted across an actual rebuild.

---

## M48 — The catalogue reads itself

One person is twenty-two rows. The people catalogue holds every spelling the documents ever used —
`ШЕРШНЕВ ЕВГЕНИЙ КОНСТАНТИНОВИЧ`, `SHERSHNEV/EVGENII MR`, a patronymic with its letters swapped —
and the screen that exists to fold them together makes the admin find them by reading a hundred and
thirty names like a proofreader. The machinery that could recognise them is already in the house:
the analyst read every one of those names off the documents, search already knows the two scripts
are one name (M43), and the merge dialog has asked the right question since M10.10. Nobody ever asks
it, because nobody sees the twenty-two rows as one person until they already know.

And when the dialog does open, its prefill is a raw dump — every spelling, every note, one per line
— which on real rows exceeds the note's own contract: the client-side schema then throws before any
request is made, and the screen answers the admin's merge with "an unexpected error" and an empty
network tab. A prefill the server would refuse is a bug twice over: once for breaking, once for
burying the one feature the screen is for.

---

- [x] **M48.1 — The prefill keeps the contract it was written under**
  **Goal:** the merge dialog never composes a default its own API refuses.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** the prefilled note is cut to the contract's limit from the end, the note field validates that limit like any other field instead of letting a Zod parse throw past the form, and a merge of rows whose combined notes exceed the limit reaches the server and succeeds. Tests: a prefill longer than the limit is clamped and submitted; the people and subjects dialogs both.

- [x] **M48.2 — An analyst for the catalogue itself**
  **Goal:** the model that read the names can be asked which of them are one person — from a request, not only from the pipeline.
  **Docs:** [`05 §5.6c`](../05-library-and-processing.md#56c-noticing-that-one-person-arrived-many-times), [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository)
  **Acceptance:** a `CatalogueAnalyst` port with `suggestMerges` and `previewMerge` beside the pipeline's ports, implemented against the same `classifier` endpoint and gate; 🔒 the rows travel inside the nonce-fenced data channel and never the system message; the adapter owns the answer's shape — schema-parsed, lengths capped, a parse failure an empty answer rather than an error — and unconfigured reports itself unconfigured. Tests: the adapter against a recorded answer, the fencing, the capping, the failure shapes.

- [x] **M48.3 — The suggestions, asked for and answered**
  **Goal:** an admin request can ask "which rows are one person" and get yesterday's answer free when nothing changed.
  **Docs:** [`03 §3.3.19`](../03-domain-model.md#3319-person), [`05 §5.6c`](../05-library-and-processing.md#56c-noticing-that-one-person-arrived-many-times), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** `GET /api/admin/people/merge-suggestions` answers the analyst's groups, validated against the living catalogue, computed on request and cached in-process by the catalogue's content with concurrent requests deduplicated; `POST /api/admin/people/merge-preview` answers a tidy name and spellings for hand-picked ids, `404` for a dead one; both admin-only; no analyst → `configured: false` / `available: false`, never an error; nothing stored, a refusal never remembered. Tests: the scenarios of [`scenario-coverage.md`](./scenario-coverage.md#catalogue-merge-suggestions).

- [x] **M48.4 — The screen notices first**
  **Goal:** the duplicates announce themselves, and the dialog opens already tidy.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** `/people` shows an admin a banner of the analyst's groups — the names each would fold, a Merge per group — opening the ordinary dialog preselected and prefilled with the analyst's name and its "also known as" line; a hand-selected merge asks for the same reading when the dialog opens, showing the raw prefill at once and replacing it only while the person has not edited; a merged or dismissed group leaves the banner without a new question to the server; no analyst, no banner, and the screen otherwise unchanged. Tests: the banner from a mocked answer, the preselected dialog, the untouched-fields replacement, the fallback when the preview is unavailable.

---

## M49 — The shelves hold their shape

The people catalogue was the visible half of the disease. The other two catalogues the analysis
writes into are worse: eleven kinds of which six are real — `жильё`, `Жильё` and the typo `жилё`
side by side, `car` beside `автомобиль` — and two hundred things among which one flat is eight
spellings of one address, some filed under two of the duplicate kinds at once, with placeholder
rows ("жильё" the thing, of kind жильё) the analysis left as noise. Kinds cannot merge at all: the
one catalogue whose duplicates split every shelf under them is the one without the tool.

And under all of it, a broken promise: "unique case-insensitively" has never been true in any
alphabet but Latin. The database's collation is `C`, its `lower()` folds ASCII alone, and the
unique indexes built on it admitted `ШЕРШНЕВ` beside `Шершнев` — which is where a good part of
every catalogue's twins came from. Until the namespace holds, every cleanup is a cleanup that
comes back.

---

- [x] **M49.1 — The namespace holds its promise**
  **Goal:** one living name is one row in any alphabet, on every path that writes one.
  **Docs:** [`03 §3.3.19`](../03-domain-model.md#3319-person), [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps)
  **Acceptance:** a `name_folded` column on people, subjects and subject kinds — Unicode-lowercased, whitespace-collapsed, written by the application and backfilled once with the ICU collation — with every "is this name here" lookup asking the fold: the analysis matching what it read, the uniqueness checks, the merges checking the survivor; 🔒 a Cyrillic case-twin of a living name reaches the existing row rather than creating a second one; the indexes ship plain, and uniqueness is the application's until M49.4. Tests: the fold unit-tested in domain; the three catalogues integration-tested against the real collation.

- [x] **M49.2 — Kinds merge like everything else**
  **Goal:** the catalogue whose duplicates split shelves gets the same fold-things-together the other two have.
  **Docs:** [`03 §3.3.20a`](../03-domain-model.md#3320a-subjectkind), [`07 §7.3`](../07-api-specification.md), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** `POST /api/admin/subject-kinds/merge` folds kinds the way people fold — oldest survives, takes the chosen name, receives every subject the others held — and the things two merged kinds both held under one folded name are folded along the way, links moved and deduplicated, latecomers soft-deleted, all in one transaction; `409 SUBJECT_KIND_EXISTS` outside the merge; `/subject-kinds` gets the checkboxes and the same dialog. Tests: the unit scenarios of the merge, an e2e fold of two kinds and their shared things, the web dialog.

- [x] **M49.3 — The suggester reads all three catalogues**
  **Goal:** every catalogue notices its own duplicates, and the things catalogue names its noise.
  **Docs:** [`05 §5.6c`](../05-library-and-processing.md#56c-noticing-that-one-person-arrived-many-times), [`03 §3.3.20`](../03-domain-model.md#3320-subject), [`07 §7.3`](../07-api-specification.md), [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** merge-suggestions and merge-preview on subjects and subject kinds, on the people endpoints' terms; the subjects call is kind-aware — a group may fold rows across duplicate kinds, its answer names the kind the survivor keeps, resolved against the kinds the merged rows already have — and answers placeholders beside its groups: rows naming a kind rather than a thing, each offered for deletion behind the ordinary confirmation; banners on both screens open the ordinary dialogs preselected and prefilled, and a hand-picked merge on either screen gets the async tidy prefill of M48.4. Tests: the scenarios of [`scenario-coverage.md`](./scenario-coverage.md#catalogue-merge-suggestions).

- [x] **M49.4 — The index lands after the cleanup**
  **Goal:** the fold's uniqueness moves from the application into the database, where a race cannot slip past it.
  **Docs:** [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps)
  **Acceptance:** blocked on the operator merging the duplicates the old indexes admitted (the banners of M48–M49 are the tool); then one forward-only migration replaces the `lower(name)` partial unique indexes with unique indexes over `name_folded` (people; subjects `(kind_id, name_folded)`; subject kinds), and the create paths keep answering `409` rather than `500` on the race the application check cannot close. Tests: the migration applies on an instance whose duplicates are merged; a case-twin create still answers `PERSON_EXISTS` / `SUBJECT_EXISTS` / `SUBJECT_KIND_EXISTS`.

---

## M50 — The analysis asks the catalogue first

The archive stopped meeting new people months ago, and the analysis never noticed: it reads
`SHERSHNEV/EVGENII MR` off a boarding pass and writes a twenty-third spelling of the one man the
archive is mostly about, because nobody ever showed it the list. The things fare better — the
catalogue is in the prompt — but as an alphabetical first sixty of two hundred rows, which is a
list of whatever sorts early, and the rule "prefer what is already here" is implied rather than
said. And the whole of what users type — kinds, things, notes — stands in the system message,
where instructions stand, which is the surface SEC-55 named.

---

- [x] **M50.1 — The analysis knows who it already knows**
  **Goal:** a document about a known person files under the row the archive already has, whatever the paper's spelling.
  **Docs:** [`03 §3.3.19`](../03-domain-model.md#3319-person), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** `analyze` is shown the known people — name and note, the merges' "also known as" lines doing the recognising — and the prompt says the rule outright for people, kinds and things alike: answer with the catalogue's own spelling when the document is genuinely about an entry already there, create only when nothing matches; the answered names still pass the fold match of M49.1, so a near-miss links rather than spawns. Tests: the adapter shows the list and the rule; the pipeline passes the catalogue in.

- [x] **M50.2 — The lists it is shown are the lists that matter**
  **Goal:** the caps fall on the tail nobody files by, not on the alphabet.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process)
  **Acceptance:** known things and known people arrive ordered by how many documents name them, capped at sixty and two hundred; the caps are the adapter's own and documented. Tests: the ordering and the caps, at the adapter.

- [x] **M50.3 — The catalogue is data even when it is the prompt's**
  **Goal:** closes M47.5 / [SEC-55](./security-audit-2026-08-second-pass.md#sec-55) — what one user types cannot steer the analysis of documents they cannot read.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository)
  **Acceptance:** 🔒 the user-written catalogue lists — kinds, known subjects, known people — travel inside the nonce-fenced data channel in a nonce-marked section of their own, never in the system message, the nonce scrubbed from every name and note; the system message keeps only the rules and the admin-written document-type list; both analyst calls and the fields call hold the line. Tests: the fence read back out of the request, the system message asserted clean.

---

## M51 — The budget learns what a phone bill costs

The per-page conversion budget was measured on bank statements and set at 30 s a page, and then a
phone bill's call detail arrived and measured ~46: Docling finished the 12-page window in 549
seconds, the app stopped polling at 360, and a parse that succeeded was thrown away — twice, once
per attempt, the three steps behind markdown failing in its shadow each time. The budget exists to
cut a conversion that will never finish, not one that is merely slower than a bank statement.

---

- [x] **M51.1 — Sixty seconds a page**
  **Goal:** a dense call-detail table parses to Markdown instead of outliving a budget measured on lighter documents.
  **Docs:** [`05 §5.4a`](../05-library-and-processing.md#54a-what-one-document-may-cost)
  **Acceptance:** the per-page conversion budget is 60 s (`BUDGET_PER_PAGE_MS`), the floor and the captions budget unchanged; the worst window — a dozen pages, twelve minutes — stays far under the parse's own 55-minute deadline and the job's hour; §5.4a records the second measurement beside the first. Tests: the window-budget cases follow the constant.

---

## M52 — A silence that says which silence it is

The merge suggester has been dead on the live instance for as long as anyone has looked, and nothing
anywhere said so. `GET /api/admin/people/merge-suggestions` asked the analyst with the whole people
catalogue — 167 rows, a 20.6 KB prompt — and the provider answered `500` after 13.4 seconds; the
cache caught the exception, returned the empty value, and wrote nothing to the log. The endpoint
answered `200 {"configured":true,"groups":[]}`, the screen drew no banner, and *the analyst found no
duplicates* became indistinguishable from *the analyst cannot be asked* — from the screen, from the
log, and from the response. The same code serves the subjects and the kinds banners, so all three
were lying in the same voice.

Two faults, one incident. A failure that reads as an answer is the first. The second is what
produced it: one call carrying an entire catalogue, which scales with the archive and tips a
provider over at the size a real archive reaches — and some OpenAI-compatible endpoints are agents
rather than completions, which reach for a tool when they should be reading a list.

---

- [x] **M52.1 — An outage is not an answer**
  **Goal:** "nothing to merge" and "nobody to ask" stop being the same answer, on the wire and in the log.
  **Docs:** [`05 §5.6c`](../05-library-and-processing.md#56c-noticing-that-one-person-arrived-many-times), [`06 §6.7`](../06-backend-architecture.md#67-logging), [`07 §7.3`](../07-api-specification.md)
  **Acceptance:** all three suggestion endpoints answer a `state` of `ANSWERED`, `UNCONFIGURED` or `UNAVAILABLE` in place of the boolean that could only say two of the three — an analyst that was asked and proposed nothing is not an analyst that could not be asked; the failure writes one line naming the catalogue, the service, the model and how many rows the failed call carried, and 🔒 never the fenced rows themselves; a failure is still not cached, so the next request asks again (`05 §5.4e`). Tests: the cache reports an unavailable reading and remembers nothing of it; the three use cases answer each of the three states; e2e — all three endpoints answer `200` with `UNAVAILABLE` against a failing analyst and ask again on the next request.

- [x] **M52.2 — The screens say it instead of showing nothing**
  **Goal:** an admin looking at a catalogue with no banner knows which of the two silences it is.
  **Docs:** [`11 §11.12a`](../11-ui-ux-spec.md#1112a-catalogues-people-subjects-subject-kinds-document-types)
  **Acceptance:** `/people`, `/subjects` and `/subject-kinds` draw a quiet, dismissible notice in the banner's own place and visual language when the reading is `UNAVAILABLE` — the analyst could not be asked, nothing is wrong with the catalogue, the next visit asks again — localized in `en` and `ru`; `UNCONFIGURED` still draws nothing at all, and a catalogue with no duplicates still draws nothing. Tests: the notice on all three screens from a mocked answer, and its absence when the analyst simply proposed nothing.

- [x] **M52.3 — The catalogue is asked in portions**
  **Goal:** the question stops growing with the archive, and the rows that need comparing are compared.
  **Docs:** [`05 §5.6c`](../05-library-and-processing.md#56c-noticing-that-one-person-arrived-many-times), [`06 §6.3.3`](../06-backend-architecture.md#633-application-ports-non-repository)
  **Acceptance:** one reading of a catalogue is asked in deterministic chunks of at most sixty rows, each its own unit of the `classifier` gate, the groups and placeholders unioned and judged against the living catalogue exactly as one answer was — `MAX_GROUPS` and `MAX_GROUP_IDS` holding for the union; the order rows are cut in is a **blocking key** that reads a name out of Cyrillic into Latin the way search already does (M43) and down to a skeleton both scripts share, so `ШЕРШНЕВ ЕВГЕНИЙ` and `SHERSHNEV/EVGENII MR` are neighbours and land in one chunk; a catalogue that fits in one chunk is still exactly one call, with the rows in the order they arrived; the system message tells the analyst to answer from the message rather than reach for a tool, because an OpenAI-compatible endpoint is not always a completion; §5.6c states plainly what chunking cannot catch — a pair the key separates is a pair nobody is asked about. Tests: the blocking key across the two scripts and the airline format; one call under the cap and the rows unchanged; several calls over it, each within the cap, their groups unioned; the same catalogue chunked the same way twice.

---

## M53 — Which way up the paper was

The crop editor taught the archive that a photograph carries the desk it was lying on (`05 §5.6`).
It never taught it which way up the paper was. A page photographed sideways is built sideways into
the canonical PDF and stays sideways through the preview, the Markdown and the text layer — and text
read at ninety degrees is read worse than text read straight. A quarter-turn is the correction a
reader makes in a second and cannot make at all today: the crop editor has no rotate, the file rows
have no rotate, and the only way to stand a page upright is to edit the file in a library the
archive is forbidden to write to (ADR-007).

A turn belongs beside the crop and the page order, and for the same reason: it is a number written
beside a file, never a change to it.

---

- [x] **M53.1 — A file remembers which way up it lies**
  **Goal:** a page that arrived sideways is built upright, without a byte of the original being touched.
  **Docs:** [`03 §3.3.16`](../03-domain-model.md#3316-file), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md#73-endpoints)
  **Acceptance:** `File.rotation` — a quarter turn and a mirror — is meaningful for images exactly as `crop` is, and `File.pageRotations` — one quarter turn per page, `null` for none — for PDFs exactly as `pageOrder` is, because a forty-page scan has three pages lying sideways and not forty; `PATCH /api/documents/:id/files/:fileId` takes both beside `crop` and `pageOrder`, refuses a page rotation on an image the way it already refuses `pageOrder` on one, validates the list against the file's recorded page count, and takes `null` as "the way it arrived"; saving enqueues the same rebuild every composition change does (`05 §5.6`); the canonical build applies an image's turn **after its crop**, so the stored quadrilateral keeps meaning what it meant in the pixels that arrived, and a PDF's page turns **before the merge**, through a new `PdfToolbox` operation over Stirling's rotate endpoint; sharp's EXIF auto-orientation stays what it is and a person's turn is a turn on top of it; 🔒 the original bytes are never rewritten — a LIBRARY file is read-only and a MANAGED original stays the original, the turn living beside it as an instruction the build reads, which is why clearing it restores what arrived; the page thumb of `GET …/files/:fileId/pages/:page/thumb` keeps answering the **original** page, since its cache key is bytes that cannot change and a turn would otherwise purge an artifact on every click — the editor turns what it draws; `DocumentFileDto` carries both. Tests: the validation refusals, a canonical rebuilt with one page standing upright, an image whose crop and turn compose in that order, a cleared turn rebuilding to what arrived, and the turn surviving a reprocess of every step.

- [x] **M53.2 — The turn is made where the crop is made**
  **Goal:** one editor answers "which part of this" and "which way up", because they are one question about one page.
  **Docs:** [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab), [`11 §11.5c`](../11-ui-ux-spec.md#115c-the-crop-editor)
  **Acceptance:** the crop editor gains **rotate left**, **rotate right** and **mirror**, keyboard-reachable like everything else in it; what it draws turns with them, the crop outline and the loupe of `11 §11.5c` following the turn rather than staying behind on a page that moved; a PDF is turned per page on the page strip, one page at a time; **Reset** clears the turn the way **Clear crop** clears a crop — it sends `null` and the file goes back to reading as it arrived; a file row carries **Turned** beside **Cropped** on the same terms, present while the stored value differs from what arrived; localized in `en` and `ru`. Tests: the buttons compose a turn and send it, the outline follows, Reset clears, the badge appears and disappears on the stored value.

---

## M54 — The shelf opens the way somebody left it

Two things the home screen gets wrong for the person who opens it every day. It arranges the archive
by the date written on the paper — the right answer for reading a shelf, the wrong one for the
question actually asked on arrival, which is *what came in since I was last here*. And a grouped grid
draws every section open at once, so grouping by person turns the screen into a scroll nobody can see
the shape of: the headings cannot be folded, and folding is what headings are for.

---

- [x] **M54.1 — Newest first means newest here**
  **Goal:** the home screen opens on what arrived last.
  **Docs:** [`07 §7.3`](../07-api-specification.md#73-endpoints), [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** `createdAt` becomes the default named order of `GET /api/documents?sort=` and the order `/documents` opens in, the other two unchanged and the tiebreak with them; the default is by definition the order that leaves no trace in the query string, so `documentDate` now travels in the URL and `createdAt` does not, and an unknown `?sort=` still falls back to the default rather than being sent on; **`11 §11.3` loses the argument it made for the old default** — that a document whose date nobody has read yet is the one still wanting attention — instead of keeping a reason under a sentence that now says something else, and `07 §7.3` names the default in one place only, so the two documents cannot drift; the four other screens that render this grid keep the orders they have, because an order belongs to a screen and not to a person. Tests: the API's default order; the screen opening on it; a link carrying `sort=documentDate` still honoured; the query string empty on the default and not on the others.

- [x] **M54.2 — A group folds**
  **Goal:** a grouped grid reads as an index and opens where it matters.
  **Docs:** [`11 §11.3`](../11-ui-ux-spec.md#113-documents-documents--the-home-screen)
  **Acceptance:** a section's heading folds and unfolds it, **the real count from the server staying visible while it is folded** — a folded section is an index line, not a hidden one — with **Collapse all** / **Expand all** over the grid and the section for what the dimension cannot place folding like any other; a folded section asks the server for nothing until it is opened, which is the one thing a grid that pages per section gets in return for paging per section; 🔒 folding is not a filter — it narrows nothing, and **Clear filters** leaves it alone; the state is client-side and lasts the **tab**, in `window.sessionStorage` the way the dismissed suggestions of `11 §11.5e` already are, keyed by the grouping dimension and the group's own value, so walking into a document and pressing Back finds the grid as it was left, and a group folded under `groupBy=person` is still folded after the filters change, because what was folded is the group and not the page; deliberately **not** in the URL, where a dozen folded groups make a link nobody can read. Tests: folding and unfolding, the count on a folded heading, no request fired for a folded section, the state surviving a remount, collapse-all, and the URL untouched by any of it.

---

## M55 — A document is pages

Three things asked of the archive on one day, and one answer under all of them. Turn page eight of a
scan. Cut a twenty-page scan where the eighth page begins another contract. Take a five-page PDF, add
a photograph, and put it **between pages two and three**. None of them is possible today, and none
of them is missing by oversight: `03 §3.3.10` says a document is an ordered list of **files**, each
part handing over its pages in a block, and `03 §3.3.16` says with a lock on it that a file belongs
to exactly one live document. A page cannot be turned because a turn is written on a file; a
document cannot be cut because two documents cannot read the same bytes; a photograph cannot go
between two pages of a PDF because there is no position between them to go to.

Extracting pages into new bytes would answer all three and cost too much: derived originals in an
archive that has none, one paper under two hashes, and a first document that still has to say which
pages it kept. The bytes are not the problem. The unit is. **What a document is an ordered list of
is pages**, each naming the file it was read from, which page of it, which way up it lies and how
much of it is paper. The file goes back to being what ADR-021 called it — bytes with a hash and a
name — and stops carrying instructions about documents it has never heard of.

---

- [x] **M55.1 — The page is the unit, written down as a decision**
  **Goal:** the model changes on purpose and in the documentation first, not as a consequence discovered in a migration.
  **Docs:** [`02` ADR-025](../02-architecture-overview.md#adr-021-a-file-is-not-a-document), [`03 §3.3.10`](../03-domain-model.md#3310-document), [`03 §3.3.16`](../03-domain-model.md#3316-file), [`03 §3.3.17`](../03-domain-model.md#3317-documentpage), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`05 §5.7a`](../05-library-and-processing.md#57a-the-trash)
  **Acceptance:** **ADR-025 — a document is an ordered list of pages** in the voice of its neighbours, superseding the half of [ADR-021](../02-architecture-overview.md#adr-021-a-file-is-not-a-document) that made it a list of files and leaving the other half exactly as it stands — the canonical PDF is still built for every document, always, and the originals are still never touched (ADR-007); it records what a page is (a file, one of its pages, a turn, a crop), what a file goes back to being, and why extracting bytes was refused; 🔒 the invariant "a file belongs to exactly one live document" is **retired in the same breath**, because pages of one file living in two documents is the point — and the rules that leaned on it are re-stated rather than dropped: a file with no live page is in the trash (`05 §5.7a`) and `trashedFrom` still names the document it left **last**, since leaving the last one is when it enters; a replacement replaces the bytes for **every** page that reads them, a better scan being better wherever the page is read, and the screen says how many documents it touches before it does it; ingest is unchanged, deduplication by hash having never implied one document, only one row. No code in this task.

- [x] **M55.2 — The composition becomes a list of pages**
  **Goal:** the schema says what the model says, and the canonical is built from the list.
  **Docs:** [`03 §3.3.17`](../03-domain-model.md#3317-documentpage), [`04 §4.3`](../04-database-schema.md#43-raw-sql-in-migrations-required-steps), [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`07 §7.3`](../07-api-specification.md#73-endpoints)
  **Acceptance:** `DocumentPage` — `(documentId, position)` unique and contiguous, `fileId`, `pageIndex`, `turn`, `crop`, `cropSource` — replaces `DocumentFile` as the thing that is ordered, and `File` loses `crop`, `cropSource`, `pageOrder` and the turn M53 wrote on it, keeping only what describes bytes: hash, mime, size, name, `pageCount`, the trash fields; **a file whose pages nobody has counted is held as one entry with `pageIndex` `NULL`** — "this file, whole, in the order it arrived" — which the first canonical build expands into one entry per page the moment it knows how many there are (`File.pageCount`, `05 §5.5` step 1.1), and that is the only two-level state left, a transitional one with a written end; a hand-written forward-only migration turns every existing row into pages — a stored `pageOrder` into that many entries in that order, a file with a known `pageCount` into its pages, anything uncounted into the `NULL` entry — carrying each file's crop onto the page it belonged to, and drops the unique index on `document_files.file_id`; a crop on a page of a PDF is honoured exactly as a crop on an image is, the page rendered and warped, because **a scanned page is already raster and loses nothing by it** and a vector page cropped becomes raster, which is what somebody who dragged its corners asked for; the canonical build reads the list, in order, each page turned and cropped as its entry says. Tests: the migration over each of the three shapes; a document whose pages come from two files; the expansion of a `NULL` entry on first build; two documents cropping one photograph apart; the rebuild enqueued by every composition change as before.

- [x] **M55.3 — A page goes anywhere in the order**
  **Goal:** a photograph goes between page two and page three of a PDF, which is the whole of what "a document is pages" buys.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md#73-endpoints)
  **Acceptance:** the composition endpoints speak pages — insert a file's pages **at a position** rather than only at the end, move a page to a position, remove a page from the document, restore the order a file arrived in; the whole order is sent at once the way the page strip already sends a whole permutation (`11 §11.5a`), so a reorder is one request and one truth; a file with no page left in any document goes to the trash by the rule that already exists; a page index the file does not have, a position outside the list, or a document left with no pages at all is `422` and not a half-applied edit; every one of them enqueues the rebuild that every composition change enqueues. Tests: a JPEG inserted between pages two and three of a five-page PDF and the canonical holding six in that order; a page removed; a whole order sent; the refusals; the file emptied into the trash.

- [x] **M55.4 — A document splits at a page**
  **Goal:** the scan whose eighth page begins another contract becomes two documents and no new bytes.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md#73-endpoints), [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab)
  **Acceptance:** an endpoint that cuts a document at one or more page boundaries into two or more documents, the entries dividing between them — 🔒 no bytes copied, no file extracted, the library untouched (ADR-007), the same file simply read by pages in two places; each new document takes the original's owner and access and nothing it has not earned — no title, no type, no people, because half a paper is not the paper and the pipeline reads it afresh; the halves are **linked** to each other ([ADR-023](../02-architecture-overview.md#adr-023-document-links--undirected-untyped-person-confirmed)), which is what makes them separate-but-together; both sides rebuild and both journals say what happened, each naming the other. Tests: a twelve-page document cut at eight; one file read by both halves afterwards; the link; each canonical holding its own pages; a cut at the first page or past the last refused.

- [x] **M55.5 — A page moves to another document**
  **Goal:** the page that belongs elsewhere goes there instead of being scanned again.
  **Docs:** [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md#73-endpoints)
  **Acceptance:** pages picked in one document move into another — an existing one, at a chosen position, or a new one made to hold them — the entries leaving one list and joining the other, and a file with no live page anywhere going to the trash; both documents rebuild; 🔒 the mover must be allowed to edit **both** documents, and a move into one they may not edit is refused whole rather than done by halves. Tests: a page moved between two documents and both canonicals afterwards; a move that empties a file into the trash; the access refusal; a move into a new document.
  *Since revised: "a move that empties a file into the trash" is unreachable by construction — a move takes the pages into the target, where they stay live, so no move can leave a file without a live page anywhere; the trash rule is proven where a page is removed (`05 §5.7a`), and the clause stands here as the record of what was accepted.*

- [x] **M55.6 — The pages are the screen**
  **Goal:** the composition is worked on as pages, with a hand, because that is how somebody puts twenty scans in order.
  **Docs:** [`11 §11.5a`](../11-ui-ux-spec.md#115a-the-files-tab), [`11 §11.5c`](../11-ui-ux-spec.md#115c-the-crop-editor)
  **Acceptance:** the tab that was `Files` leads with **the pages of the document** — every page of every file in the order the canonical will hold them, thumbnails from the endpoint that already serves them (`GET …/pages/:page/thumb`), each saying its number and where it came from; **drag and drop across the whole document**, not inside one file: a page picked up anywhere lands anywhere, the strip closing around where it will fall, and 🔒 the arrow keys do the same work for the reason `11 §11.3` gives — a hit area only a mouse can use is half a fix; **a file dropped between two pages goes between them** — the upload panel of `11 §11.3a` hands its pages to the position it was dropped at, which is the gesture this whole milestone exists for; per page, in place: **turn** (M53), **crop** (§11.5c), **remove**, **split here**, **move to…**; the file rows keep what is genuinely about files and move below the pages — download, replace, the path, the storage key; **nothing is sent until it is saved**, the strip keeping the pending order with Save and Cancel as it already does; localized in `en` and `ru`. Tests: the strip across two files, a drag across the boundary, a file dropped at a position, a turn and a crop from the strip, a split and a move from a selection, and Cancel sending nothing.

- [x] **M55.7 — A page is cropped and turned as a page**
  **Goal:** the crop `03 §3.3.17` promises a page of a PDF can actually be asked for.
  **Docs:** [`03 §3.3.17`](../03-domain-model.md#3317-documentpage), [`05 §5.6`](../05-library-and-processing.md#56-composing-a-document-out-of-files), [`07 §7.3`](../07-api-specification.md#73-endpoints)
  **Acceptance:** M55.2 moved the crop and the turn onto the page and M55.2 says the build honours a crop on a page of a PDF by rendering and warping it — but the only route that sets either still addresses a **file** and answers `422 FILE_NOT_IMAGE` to anything that is not one, so the promise is unreachable; **`PATCH /api/documents/:id/pages/:pageId`** takes `{ crop?, turn? }`, `null` for either clearing it, and answers the whole `DocumentDetailDto` like every other page route, `404 PAGE_NOT_FOUND` for a page this document has not got; a crop is accepted on **any** page, an image's or a PDF's, because that is what the model already says the build does; `mirrored` stays an image's own — a page of a PDF turns in quarters — and asking for it elsewhere is `422 FILE_NOT_IMAGE`, which is now the only thing that error means; the file route keeps setting what is still genuinely per file and stops being the way a crop is set. Tests: a crop set on a page of a PDF and honoured by the build; a turn set on a page; both cleared; the refusals; the file route's remaining shape.

- [x] **M55.8 — The page order is proven against the real thing**
  **Goal:** what the fake toolbox proves at the call level, Stirling proves on bytes.
  **Docs:** [`05 §5.5`](../05-library-and-processing.md#55-document-processing-pipeline-document-process), [`14 §14.8`](../14-coding-standards.md)
  **Acceptance:** the Stirling-backed canonical-build integration suite gains the two cases M55.3–M55.5 could only assert against a fake: a document with a page **inserted between two pages of one PDF** builds a canonical whose pages stand in the composed order, and **each half of a split** builds a canonical holding its own pages of the one file and nothing of the other half's; the assertions read the built PDF rather than the calls that made it (page count, and the page text where the fixtures carry any); the suite skips itself without the Stirling container exactly as its neighbours do. Tests: are the deliverable.

- [x] **M47.22 — The scan the parsers had never had**
  **Goal:** the eight HIGH findings the first scan of all three images returned are answered or written down as answered by somebody else.
  **Docs:** [`13`](../13-ci-cd.md), [`12 §12.7`](../12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)
  **Acceptance:** M47.11 put Stirling and Docling under the same Trivy job as the app, and `v0.26.0` is the first release where that job ran: it came back red with **eight HIGH and no CRITICAL** — the app's `libcrypto3` `CVE-2026-14456` (fixed in `3.5.8-r0`, and the app's base is the floating `node:26-alpine`, so this clears when upstream Node rebuilds and not before); Docling's four, including `jackson-core` `GHSA-r7wm-3cxj-wff9` inside `ray_dist.jar` (fixed in 2.18.8 / 2.21.4); Stirling's two Ubuntu ones, `CVE-2026-45447` and `CVE-2026-69244`/`CVE-2026-69247`. 🔒 **The image was published and `latest` moved** — a red `scan` is a report about bytes that already exist, which is exactly the difference `13 §13.3a` draws between a failed build and a failed scan, and the release command said so on the line above the failure. What this task owes: for each finding, either the pinned digest moved to an upstream build that fixes it, or a line in `12 §12.7` naming the CVE, saying which of the three images carries it, why it is not reachable in this deployment, and what would make it reachable — a scan nobody answers becomes a scan nobody reads. And a decision recorded in `13`: whether a red scan on findings already recorded should keep failing the release run, or whether the recorded set is subtracted first, so the next red one means something new.
  *Since revised: the "eight HIGH" were only the report's first tables — the run held 58 distinct HIGH advisories (one in the app image, six in Docling, fifty-one in Stirling), and the register of `12 §12.7` carries the full set.*
