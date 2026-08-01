# Mandatory-scenario coverage

Every scenario of the acceptance floor in [`14 §14.8`](../14-coding-standards.md#148-testing), mapped
to the test that proves it. One row per scenario, in the order the standard lists them; the test name
is the `it(...)` string, so it can be run with `vitest -t`.

Keep this table honest: a scenario whose test is deleted or renamed must be updated here in the same
commit. Coverage of the two framework-free layers is enforced separately — `vitest.config.ts` fails
the run below 90% of lines in `src/server/domain` and `src/server/application`, and CI runs
`npm run test:coverage`.

## Auth

| Scenario | Test |
|---|---|
| onboarding only once (race → one admin) | `test/e2e/registration.e2e.test.ts` — creates exactly one admin when two onboardings race |
| 3-step registration happy path | `test/e2e/registration.e2e.test.ts` — walks the three-step happy path and signs the new admin in |
| wrong code ×5 burn | `test/e2e/registration.e2e.test.ts` — burns the record after five wrong codes; `src/server/application/auth/verify-email-code.test.ts` — counts wrong codes and burns the series on the fifth |
| invite accept | `test/e2e/invites-resets.e2e.test.ts` — creates the user with the invite role and marks the invite used |
| invite expiry / revoke | `test/e2e/invites-resets.e2e.test.ts` — previews a valid invite and reports invalidity for used, revoked and expired ones; refuses a revoked and an expired invite at registration |
| login timing-equal `INVALID_CREDENTIALS` | `src/server/application/auth/login.test.ts` — reports the same error for an unknown address and a wrong password; verifies a hash even for an address nobody registered, so both answers cost the same |
| session fixation (new sid on login) | `test/e2e/login.e2e.test.ts` — issues a brand-new session on every login (anti-fixation) |
| logout revocation | `test/e2e/login.e2e.test.ts` — populates the caller from the session cookie and revokes it on logout |
| CSRF fail-closed | `test/e2e/login.e2e.test.ts` — CSRF (fail-closed origin check), five tests |
| per-email rate caps | `test/e2e/registration.e2e.test.ts` — enforces the per-email cap of one code per minute; enforces the per-email daily cap of five codes |
| password reset revokes sessions | `test/e2e/invites-resets.e2e.test.ts` — changes the password through the code flow and revokes every existing session |
| `LAST_ADMIN` on role change | `test/e2e/users.e2e.test.ts` — refuses to demote the last admin |
| `LAST_ADMIN` on deactivate | `test/e2e/users.e2e.test.ts` — refuses to deactivate the last admin |
| `LAST_ADMIN` on delete | **N/A in MVP** — there is no user-delete endpoint: [`07 §7.3`](../07-api-specification.md) lists only `PATCH /api/admin/users/:id`, `/deactivate` and `/reactivate`. Deactivation is the removal path, and it is guarded. |

## Library & scan

| Scenario | Test |
|---|---|
| create validates path (outside root, file-not-dir, nested library) | `test/e2e/libraries.e2e.test.ts` — rejects a path outside the volume, a missing one, and a file; rejects a duplicate path and either direction of nesting |
| scan discovers nested files | `test/integration/scan-ingest.integration.test.ts` — discovers new files, records a ScanRun and enqueues one ingest each; `test/integration/fs-library-reader.integration.test.ts` — walks nested files depth-first in a deterministic, sorted order |
| applies `excludeGlobs` | `test/integration/scan-ingest.integration.test.ts` — honours excludeGlobs and skips hidden entries; `test/integration/fs-library-reader.integration.test.ts` — honours excludeGlobs |
| skips symlinks (incl. one escaping the root) | `test/integration/fs-library-reader.integration.test.ts` — skips symlinks, including one escaping the volume (🔒) |
| rescan with no changes = zero jobs | `test/integration/scan-ingest.integration.test.ts` — enqueues nothing on a rescan with no changes |
| size/mtime change → rehash | `test/integration/scan-ingest.integration.test.ts` — re-ingests a file whose size or mtime moved; notices a touched file even when its size is unchanged; `src/server/domain/entities/file-ref.test.ts` — needsRehash |
| rename detection (MISSING + re-attach by hash) | `test/integration/scan-ingest.integration.test.ts` — treats a rename as the old path missing and the new one attached to the same document |
| missing → unavailable → return restores | `test/integration/scan-ingest.integration.test.ts` — marks a vanished file MISSING without deleting anything; restores availability when a file comes back |

## Dedup

| Scenario | Test |
|---|---|
| two paths, one content → one Document, two FileRefs, pipeline ran once | `test/integration/scan-ingest.integration.test.ts` — gives two paths with identical content one document and two refs, running the pipeline once |

## Pipeline

| Scenario | Test |
|---|---|
| pdf-with-text, no OCR | `src/server/application/jobs/handle-document-process.test.ts` — reads a PDF that carries its own text, without paying for OCR |
| scanned pdf → OCR | `src/server/application/jobs/handle-document-process.test.ts` — sends a PDF whose text layer is too thin to OCR; measures the text layer per page, not in total |
| office → canonical | `src/server/application/jobs/handle-document-process.test.ts` — an office document is converted, and the preview comes from the canonical PDF |
| image → trim/preview | `src/server/application/jobs/handle-document-process.test.ts` — an image previews directly, with no PDF anywhere in the path; OCRs an image through a one-page PDF |
| txt/md passthrough | `src/server/application/jobs/handle-document-process.test.ts` — plain text and Markdown skip both steps; passes text through, normalizing what a file may carry |
| unsupported → SKIPPED | `src/server/application/jobs/handle-document-process.test.ts` — an unsupported format settles steps 1-3 and 5 without touching the tooling; `test/integration/document-process.integration.test.ts` — leaves an unsupported format settled without any artifact |
| step failure isolates | `src/server/application/jobs/handle-document-process.test.ts` — keeps a markdown failure from touching the preview; records the failing step with its error and leaves the document usable |
| reprocess subset only re-runs requested steps | `src/server/application/jobs/handle-document-process.test.ts` — runs only the requested step and leaves the others exactly as they were; `test/e2e/queue-admin.e2e.test.ts` — resets only the steps asked for and carries them into the job |
| vectorization SKIPPED without provider | `src/server/application/jobs/handle-document-process.test.ts` — skips itself when no provider is configured, and touches no vectors; `test/integration/document-process.integration.test.ts` — skips both AI steps, without error, when no provider is configured |
| `semanticAvailable=false` in search | `test/e2e/search.e2e.test.ts` — reports semantic search as unavailable and falls back to text; `src/server/application/search/search-documents.test.ts` — with no embedding provider configured (three tests) |

## Jobs

| Scenario | Test |
|---|---|
| idempotency: `library-scan` | `test/integration/scan-ingest.integration.test.ts` — is idempotent under double delivery (the scan diff) |
| idempotency: `file-ingest` | `test/integration/scan-ingest.integration.test.ts` — is idempotent under double delivery (ingest and deduplication) |
| idempotency: `document-process` | `src/server/application/jobs/handle-document-process.test.ts` — rewrites artifacts and statuses on a re-run without duplicating anything |
| idempotency: `scanset-merge` | `test/integration/scanset-merge.integration.test.ts` — does nothing when the job is delivered twice |
| idempotency: `maintenance` | `src/server/application/jobs/handle-maintenance.test.ts` — changes nothing when the same job is delivered twice |
| singleton scan per library | `test/integration/scan-ingest.integration.test.ts` — enqueues per-library scans under a singleton key; `test/integration/queue.integration.test.ts` — collapses repeated enqueues that share a singleton key |
| enqueue-in-transaction rollback | `test/integration/queue.integration.test.ts` — discards the job when the transaction rolls back; commits the job together with the entity write |

## Access

| Scenario | Test |
|---|---|
| USER vs RESTRICTED library: list | `test/e2e/documents.e2e.test.ts` — hides a RESTRICTED library from a user without a grant, and shows it once granted |
| USER vs RESTRICTED library: detail | `test/e2e/documents.e2e.test.ts` — 404s a document in a library the caller cannot see |
| USER vs RESTRICTED library: files | `test/e2e/document-files.e2e.test.ts` — refuses every file route exactly like the metadata routes; lets a granted user download the same file |
| ALL_USERS visible | `test/e2e/libraries.e2e.test.ts` — shows an ALL_USERS library to everyone, and every library to an admin |
| DERIVED visibility via collection share (user-specific) | `test/e2e/collections.e2e.test.ts` — shares with one user, who then sees the collection but not the library documents in it |
| DERIVED visibility via collection share (instance-wide) | `test/e2e/collections.e2e.test.ts` — shares with the whole instance |
| share grants no LIBRARY-doc access | `test/e2e/collections.e2e.test.ts` — shares with one user, who then sees the collection but not the library documents in it |
| collection item filtering per viewer | `src/web/screens/collection-detail/collection-detail-screen.test.tsx` — shows the documents the viewer may see; `test/e2e/collections.e2e.test.ts` — adds a document the caller can read, and refuses one they cannot |
| admin sees everything | `test/e2e/documents.e2e.test.ts` — shows an admin everything, including documents in no library at all |

## Search

| Scenario | Test |
|---|---|
| FTS finds title & body | `test/e2e/search.e2e.test.ts` — finds a document by a word in its body, with the match highlighted; finds a document by its title alone |
| access filtering inside search | `test/e2e/search.e2e.test.ts` — never surfaces a document from a library the caller cannot see |
| hybrid = text when no provider | `src/server/application/search/search-documents.test.ts` — answers a hybrid query with text alone |
| RRF merge ordering deterministic | `src/server/application/search/search-documents.test.ts` — merges the two orderings by rank rather than by score; answers the same order for the same input; `test/e2e/search.e2e.test.ts` — orders the same query the same way every time |

## Scan sets

| Scenario | Test |
|---|---|
| non-image item rejected | `test/e2e/scan-sets.e2e.test.ts` — refuses a page that is not an image |
| edit in QUEUED → `SCANSET_INVALID_STATE` | `test/e2e/scan-sets.e2e.test.ts` — queues a merge and refuses to edit the set while it is queued |
| merge produces DERIVED doc with provenance and enqueues processing | `test/integration/scanset-merge.integration.test.ts` — merges the pages into a derived document owned by the person who built the set |
| result dedup (identical result reuses document) | `test/integration/scanset-merge.integration.test.ts` — reuses the document when the same set is merged again, without processing it twice; refuses to steal a result that already belongs to another scan set |
| FAILED retry after edit | `test/integration/scanset-merge.integration.test.ts` — records a failure on the set and leaves it editable; `test/e2e/scan-sets.e2e.test.ts` — lets a failed set be edited and merged again |

## API

| Scenario | Test |
|---|---|
| unknown `/api/*` → JSON `NOT_FOUND` (not HTML) | `test/e2e/bootstrap.e2e.test.ts` — unknown /api route returns a JSON NOT_FOUND envelope, never HTML |
| envelope shape on success and error | `test/e2e/bootstrap.e2e.test.ts` — wraps success in { data } and failure in { error }, and nothing else (docs/07 §7.1) |
| BigInt as string | `test/e2e/documents.e2e.test.ts` — carries a size past what a JS number holds, exactly (docs/07 §7.4) |
| soft-deleted → 404 everywhere | `test/e2e/documents.e2e.test.ts` — soft-deletes a document, after which it is gone from every route |
