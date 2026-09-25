# Service audit — 2026-09-25

## Scope and baseline

Requested scope: architecture, security/correctness, interface/design, documentation, backlog,
operations and validation, with all confirmed source defects fixed and committed on `main`.
Baseline: `bd6160560701854b718a4d9dc07679d0d1304d19` (`0.35.0`); the working tree was clean and
GitHub `main` matched it. Independent backend, frontend and operations agents audited separate
file sets; the parent owns specification reconciliation and integrated verification.

The architecture remains one Express/Nest/Next process, framework-free domain/application layers,
Prisma/PostgreSQL/pgvector, pg-boss, private S3, Ant Design and next-intl. The external library remains
read-only. The owner explicitly authorized this audit to resolve documentation drift and implement fixes
in parallel; new product changes still follow the repository approval rules. No stack migration,
production data migration, release or deployment is required by this change. The task checklist and acceptance criteria are [M64](./backlog.md#m64--september-service-audit).

## Confirmed findings and resolution

| Priority | Finding | Resolution / evidence |
|---|---|---|
| High | Receipt deduplication can disclose another user's DTO when concurrent upload wins after the initial access check. | Recheck access in the transaction and clean up the losing uploaded object. |
| High | The same File can acquire a receipt and document home through upload, append, replacement or conversion races. | Serialize identity acquisition and file attachment; reject incompatible product profiles without disclosing identities. |
| High | Receipt processing has no page or aggregate image bound and can exhaust worker memory. | Fail visibly beyond 100 pages or 32 MiB of retained extraction JPEGs, including reused previews; never truncate a successful answer. |
| Medium | Recent documents and infinite document lists reuse a query key for different data shapes. | Give recent results their own key and keep cursor list cache shapes consistent. |
| Medium | Facet, collection and administrator user lists stop at the first server cursor page. | Expose continuation and preserve ordering and accumulated rows. |
| Medium | Several reads display an empty archive or endless spinner on request failure. | Localized inline error/retry states; retain existing data on refresh failures. |
| Medium | Receipt media failures leave blank/spinning content; narrow navigation consumes most of a phone screen. | Recoverable media state and responsive shell/gutters. |
| Medium | Installer corrupts literal paths/passwords and briefly creates secrets with default permissions. | Literal Compose dotenv serialization and owner-only creation permissions, verified with adversarial values. |
| High | Real development pages are blank: CSP blocks the Next development runtime. | Explicit dev bootstrap alone permits development script evaluation; production and API policies retain strict defaults, with middleware and browser checks. |
| Medium | Release publishing uses a non-atomic push and can accept empty CI evidence after polling. | Require nonempty exact-SHA CI evidence and atomically push only the intended branch and tag. |
| Medium | Saved theme is ignored by the shell and Settings. | Apply stored preference on login and successful save; reset on logout; add keyboard skip navigation. |
| Medium | Queue migration omits local dotenv and can retain its database connection after an error. | Load dotenv with exported variables taking precedence; stop pg-boss in cleanup. |
| High | The destructive integration harness trusts arbitrary application/migration database URLs. | Require one explicitly named test database before connecting or truncating. |
| Low | Language negotiation accepts forbidden/invalid ranges; a receipt screen imports another screen's formatter. | Validate language preferences and move shared receipt presentation to its entity layer. |
| Low | Guides contradict accepted runtime, deduplication, deletion, ingestion and Git workflow decisions. | Reconcile the actual TypeScript 5.9 toolchain, `db:migrate`, Processing naming, product identity and scoped inbox semantics; fix the broken API-spec link. |

## Architecture assessment

Layer boundaries are enforced by ESLint and remained intact: application/domain code does not gain
framework dependencies, clients consume shared contracts, and receipt formatting now lives below
screen composition. Processing keeps pg-boss delivery, durable document/receipt steps and external
service gates as separate mechanisms under the existing control plane. No evidence justified
replacing this architecture. The material defects were transaction ownership, resource bounds,
cache identity and missing failure/continuation states.

Production dependency audit covers the npm lockfile, not operating-system or parser-image CVEs.
The existing image scan workflow and recorded exceptions remain necessary. The optional restricted
PostgreSQL role is exercised separately from the default self-migrating deployment owner role.

## Backlog and dependency triage

There were no open GitHub issues and no unchecked implementation tasks before M64. GitHub had 13
open Dependabot PRs: production patches #39, development patches #38, action updates #37, Docling
#36, and major proposals #31, #30, #29, #28, #27, #26, #23, #22 and #21. These are upgrade proposals,
not evidence that a documented feature is absent. Major framework/toolchain migrations are outside
this audit's fixed-stack scope; they must retain their compatibility review rather than be merged
without inspection. PRs #37–39 were inspected: patch/minor updates did not demonstrate a current defect or urgent
security fix. Current production lockfile audit reports **zero known vulnerabilities**.

## Runtime observations and boundaries

The local host's Node was 25.9.0 despite the repository requiring Node 26. For this audit the exact
`.nvmrc` version, 26.5.1, was downloaded into `/tmp` and SHA-256 verified against Node's published
checksums. A separate temporary PostgreSQL/pgvector container on loopback port 55432 isolates test
and UI databases from existing data; all 48 committed migrations and queue schema applied from zero.

An existing legacy local app container was restarting with Prisma `P1000` (database authentication
failure). That installation is not launched by the current root development Compose file, which
contains dependencies only. No credentials, container environment or live database were rewritten.
The deployed instance's public `GET /api/health` also returned `status=ok`, `db=ok`, `queue=ok`.
That is a connectivity/liveness signal, not proof that every external provider or queued item works.
The sanctioned remote observability configuration (`~/.config/legere/ops.env`) is absent, so deeper
production log/database inspection was not performed. Repairing the separate legacy local
installation requires its operator configuration; committing source changes cannot repair an
already-created database password mismatch.

## Integrated validation

Initial baseline typecheck and lint passed. Final validation uses Node 26.5.1 and the isolated
PostgreSQL database, with a DML-only runtime role and a separate owner URL for cleanup. MinIO runs
in its own temporary container on loopback port 59000; its real adapter tests execute.

- `npm run typecheck`: passed across app, server and tests.
- `npm run lint`: passed with no warnings; formatting passed.
- `npm run build`: passed; the compiled server also started successfully.
- Built-server `GET /api/health`: `status=ok`, `db=ok`, `queue=ok`.
- Built-page HTTP policy: nonce present, neither `unsafe-eval` nor `unsafe-inline`.
- Browser smoke: local seed login, archive and receipt empty states, settings, live dark-theme save
  and keyboard navigation. At 390 px the receipt page has a 64 px sidebar, 326 px main content and
  no horizontal overflow; default viewport restored afterwards.
- Local Markdown file links and scenario-file references: no missing targets.
- `npm run test:coverage`: **224 files / 2506 tests passed**, one optional suite and
  **25 tests skipped** (2531 total). Domain/application lines **97.19%**, branches **90.44%**,
  functions **98.66%**; the configured 90% line floor passed.
- After the final lock/retry fixes, `npm run test:coverage -- --project server`: **164 files /
  1945 tests passed**, one optional suite and the same **25 tests skipped**. This includes four
  additional regression cases; lines **97.19%** (12675/13041), branches **90.44%**, functions
  **98.66%**. Typecheck, lint and the production build were rerun successfully on these changes.

The installer regression also verifies that private secret permissions do not leak into new library
directory permissions: library creation remains traversable without changing existing folders.
Document file claims use compatible `KEY SHARE` locks, while receipt claims require `UPDATE` locks.
Contested claims refuse the entire operation with `409 DOCUMENT_CHANGED`; concurrent document
split/reorder/expansion remains safe. Saved-preview transport failures remain retryable while
exceeding the resource budget is terminal. These cases have explicit regression coverage.

The regression map is [scenario coverage, M64](./scenario-coverage.md#september-service-audit-m64).
Real Stirling-PDF and a configured AI provider were unavailable: their 24 parser checks and one
live-AI check are explicitly skipped. PDF/service behavior is otherwise tested through port and HTTP
doubles, which is not evidence of a successful live provider call. Deep remote production inspection,
external SMTP delivery, a container-image build/scan and release publication are outside the executed
checks; no deployment or release was performed.
