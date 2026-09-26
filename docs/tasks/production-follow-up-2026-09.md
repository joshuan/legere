# Production follow-up and frontend verification — 2026-09-25

This follows [M64](./service-audit-2026-09.md) and tracks the owner's request to inspect production,
diagnose the search crash, enforce FSD boundaries, and verify responsive light/dark interfaces in a
real browser. Implementation and acceptance criteria are [M65](./backlog.md#m65--production-follow-up-and-frontend-verification).
Production observations were collected on September 25; final source verification continued on
September 26.

## Production observations

The owner supplied a monitoring SSH account. It has no direct Docker socket access; its existing
sudo policy allows read-only Docker `ps`, `logs`, `inspect`, `stats`, `info` and `version` commands.
No permissions, credentials, data, provider configuration or running containers were changed.
Raw logs remain in a private temporary file and are not committed; only aggregates belong here.

The bounded 72-hour app-log sample contains **12,812 JSON records**: 8,981 completed HTTP requests,
2,478 completed jobs, 1,351 failed jobs and two worker-start records. There are no HTTP 5xx records
in this sample. That does not exclude client-side failures or failures outside this window.

### Search crash

The deployed UI reports **0.35.0**. A direct load of `/search` works, but a full load of `/documents`
followed by client navigation to Search crashes into the application error boundary. The browser
records `TypeError: Cannot read properties of undefined (reading 'length')` in the search page.
This is the incompatible finite/infinite query-cache identity fixed by M64 (`401fee0`), which was
committed locally but not deployed. The browser regression must navigate between both routes in one
session; separate direct-page screenshots cannot reproduce this defect.

### Provider timeouts and stranded receipts

| Service | Actual timeout records | Circuit-breaker refusal records |
|---|---:|---:|
| Receipt extractor | 38 | 1,169 |
| Embeddings | 48 | 96 |

The observed timeouts match the adapter timeout limits (300 s and 120 s respectively). A breaker
refusal means the application deliberately did not call a recently failing provider; it is not a
separate measured upstream outage. This sample provides no evidence of credential rejection or a
specific provider HTTP error, so extending timeouts or changing credentials would be speculative.

Fifty-nine receipt **job IDs**, not necessarily distinct receipts, exhausted the initial attempt
plus five retries without a later completion in this sample. The receipt handler leaves provider
outages `QUEUED`; pg-boss eventually stops delivering; existing maintenance only recovered documents,
while administrator receipt retry selected only `FAILED`. This combination can strand unfinished
receipts without a delivery or a usable bulk retry path.

Read-only administrator UI counters show **4,445 receipts**: 3,306 processed, 949 failed and
190 waiting, with none processing. The enabled receipt queue shows zero queued and zero active
jobs; the existing retry action recognizes only the 949 failures. The aggregate proves the mismatch,
but does not establish the age of every waiting receipt. M65 adds bounded recovery of stale orphaned
work and the same guarded eligibility to manual retry, preserving finished previews and terminal
failure semantics.

### Host capacity

The shared host's root filesystem is **98% full**, with about **1.8 GiB free**; inode usage is 52%.
The app's writable container layer is only 40 KiB and Docker log rotation is already capped at two
100-MB files; system journals occupy about 190 MiB. The application used about 191 MiB RAM during
inspection, had one recorded restart and was not marked OOM-killed. The sample does not identify the
cause of disk usage. Host cleanup/capacity work requires an operator decision; deleting shared data
or Docker resources is not part of read-only application diagnosis.

## Frontend work and verification

### Structure and behavior

- ESLint enforces downward dependencies, independent slices and public `index.ts` entry points,
  including type imports, lazy imports and re-exports. Production code cannot import its own slice
  barrel; regression tests exercise the actual configured rule. Shared segments remain reusable.
- The document viewer and processing dashboard are widgets with separate tab/section modules;
  route screens compose them. Page arrangement and cropping belong to one document-pages feature.
  Receipt upload/filtering and the search shortcut are features; receipt formatting, document
  presentation and routing models live with their entities; captcha is a shared integration.
- Layouts adapt from 320 px upward: controls and card actions wrap, narrow definition lists and
  file rows stack, and tables scroll inside their own container. No global overflow clipping hides
  inaccessible content. Public forms use the same light/dark tokens as the authenticated shell.
- Missing document images expose an accessible fallback without changing authenticated artifact
  URLs or downloads. The receipt retry interface explains failures and stale abandoned work, and
  enables recovery even when all eligible receipts are queued rather than failed.
- Filter loading/options now use a consistent initial hydration snapshot. The browser matrix found
  that a shell-populated query cache could leave the server's loading SVG in the DOM after the
  request succeeded. A server-render-to-prefilled-cache regression failed before this fix and passes
  afterward; queries are not delayed.

### Browser coverage

Playwright renders the production build through the actual Next/Nest server, logs in through the
real password endpoint and uses an isolated migrated database with deterministic, nonempty fixtures.
No production authentication bypass or queue worker is introduced. External ports are in-memory;
artifact routes still authorize access before returning deterministic preview/PDF bytes. Personal
content in the screenshots is invented, not copied from production.

The matrix has five viewport widths (320, 390, 768, 1024 and 1440 CSS pixels) in each of two themes.
Phone/tablet projects enable touch. It checks 33 populated route views, six additional resolved
routes, public forms and validation, empty/error states, repeated archive/search client navigation,
keyboard focus, source expansion, sharing and document page arrangement/cropping. Assertions cover
uncaught browser errors, visible image loading, rendered theme and horizontal page overflow.
Captures return the document to the top and normalize tab focus without changing the selected route.
The PDF case waits for Chromium's real viewer and two-page metadata, then closes its optional
thumbnail sidebar through the browser's own control before capturing the document.

Baselines use pinned Playwright 1.63.0/Chromium in one Linux ARM image, with fixed time, fonts and
disabled animations; the same image runs on the CI ARM runner. Native baseline updates are refused.
CI retains reports and failure traces for seven days. These are Chromium layout/interaction checks,
not a claim that every browser engine, device or possible document has been tested.
The repository contains **440 PNG baselines** (44 per viewport/theme project, 92.83 MiB total).
The container runs the installed CLI directly without a pseudo-terminal; both successful and failed
test runs were checked for natural exit, preserved status and disposable-database cleanup.

During visual review, screenshots exposed squeezed card headers, configuration-value overflow,
overcompressed file metadata, low-contrast configuration notes and an unbounded device column that
hid session dates/actions even on desktop. They also revealed incomplete test artifact interception.
These were corrected before accepting baselines. Table-wrapper and failed-image regressions protect
defects found during the refactor.

### Integrated validation

- Node **26.5.1**, full application/server/test TypeScript checks.
- Full ESLint and Prettier checks pass, including the enforced frontend dependency rules.
- Final full Vitest suite: **228 files passed, one skipped; 2,525 tests passed, 25 skipped**.
  Domain/application line coverage is **97.20%** (required floor: 90%); branch coverage is 90.50%.
  This used a freshly migrated isolated PostgreSQL database and the restricted runtime database
  role, plus an isolated MinIO instance for all 12 real S3 integration cases.
- The skipped checks are 24 live Stirling-PDF cases and one opt-in live analyst integration.
  Adapter contracts, orchestration, permissions and failure behavior are covered by the remaining
  suites, but this run does not prove live office/PDF conversion or live model output quality.
- Scenario mapping resolves all **113** current source references after the FSD moves.
- Production dependency audit with the updated lockfile reports **zero vulnerabilities**.
- The pinned Docker environment builds the production application successfully. Its final
  comparison run passes **501/501 browser tests** in 4.2 minutes, with no retries, failures or
  skips, and without updating baselines. The HTML report is complete, the command exits with
  status zero, and the wrapper removes its disposable database and network.
- Representative phone, tablet and desktop images were reviewed in both themes. The final
  capture-readiness changes were reviewed against the preceding images: PDF sidebar state,
  tab positions, settled table text and fixed navigation on expanded receipt pages are intentional.
  The comparison tolerance was not increased.

## Production handoff

The source changes do not deploy themselves. Production remained at the observed 0.35.0 throughout
this read-only investigation; no bulk retry, service restart, release or host cleanup was performed.
After deployment, the search regression is resolved by M64 and M65 can requeue orphaned receipts
older than two hours through maintenance or administrator retry. Successful extraction still depends
on provider availability. The 949 terminal failures remain an explicit operator retry decision.
Provider availability/latency and the shared host's disk
capacity need operational attention; this log sample alone cannot establish their root causes.
