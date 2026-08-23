# Mandatory-scenario coverage

Two maps of the same kind live in this file: the acceptance floor of
[`14 §14.8`](../14-coding-standards.md#148-testing) below, and
[the security checklist of `08 §8.6`](#the-security-checklist-of-08-86) at the end. Both work the same
way — one row per claim, naming the test that proves it by file and by the `it(...)` string, so any
row can be run with `vitest -t` instead of being taken on trust.

Keep both tables honest: a claim whose test is deleted or renamed must be updated here in the same
commit. Coverage of the two framework-free layers is enforced separately — `vitest.config.ts` fails
the run below 90% of lines in `src/server/domain` and `src/server/application`, and CI runs
`npm run test:coverage`.

The groups that follow — through `API` — are the mandatory scenarios of `14 §14.8`, in the order the
standard lists them.

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
| API token reads as its owner, never writes | `test/e2e/api-tokens.e2e.test.ts` — reads as its owner and shows the secret exactly once; is refused on every mutating method, before the route is even reached; carries the owner authority and no more |
| API token revoked / expired / owner blocked | `test/e2e/api-tokens.e2e.test.ts` — stops working when revoked, when expired, and when its owner is deactivated; `src/server/application/auth/authenticate-api-token.test.ts` — refuses a token that is unknown, malformed, expired or revoked |
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
| a number typed in either alphabet finds the paper, a word stays unreachable by its look-alike | `test/e2e/search.e2e.test.ts` — finds a number typed in either alphabet, whichever one it was scanned in; finds a Serbian paper through the letter its alphabet shares with Latin; leaves words alone, so a Latin one can never match a Russian one; `src/server/infrastructure/persistence/prisma-document.repository.test.ts` — asks in the alphabet the words were typed in and matches through one expression |
| a word is found with or without its diacritics, both ways, and the highlight keeps the paper's spelling | `test/e2e/search.e2e.test.ts` — finds a word whether or not the paper kept its diacritics, both ways round; keeps the highlight on the words as the paper spells them |
| a name and a city are found in either script, and short Cyrillic words are not read out into Latin | `test/e2e/search.e2e.test.ts` — reads a name out of Cyrillic into Latin, and finds it from either side; finds a Serbian city written in either alphabet; does not read short Cyrillic words out into Latin words |
| a hit reached only through a fold answers without a highlight | `test/e2e/search.e2e.test.ts` — answers without a highlight when only the fold matched |

## Typed fields

| Scenario | Test |
|---|---|
| a schema-typed document extracts, per-field validation drops a bad date and keeps a good vendor | `src/server/application/jobs/handle-document-process.test.ts` — fills the schema of the type the analysis just chose, validated per field; `src/shared/contracts/document-fields.test.ts` — keeps a real calendar day and drops what only looks like one |
| a `MANUAL` value survives a re-run | `src/server/application/jobs/handle-document-process.test.ts` — keeps a MANUAL value whatever the model reads — fill-blanks per field |
| a manual type change re-extracts under the new schema, replacing the old reading | `test/e2e/documents.e2e.test.ts` — a type changed by hand re-queues the fields step and clears the stale reading; `src/server/application/jobs/handle-document-process.test.ts` — replaces a reading that speaks another schema wholesale, manual corrections included |
| no schema → `SKIPPED NO_SCHEMA`; no provider → `NOT_CONFIGURED` | `src/server/application/jobs/handle-document-process.test.ts` — skips NO_SCHEMA where the type carries none, and where there is no type at all; skips NOT_CONFIGURED with a schema but no provider |
| FTS finds a document by an extracted value | `test/e2e/documents.e2e.test.ts` — edits a typed field, marks it MANUAL, and makes it findable (docs/03 §3.3.10a) |
| PATCH `fields` validates against the schema | `test/e2e/documents.e2e.test.ts` — refuses a field the schema does not know, and a document whose type has none |
| `reset: ['fields.<key>']` restores the read value as `AUTO` | `test/e2e/documents.e2e.test.ts` — puts a typed field back to what the model read, as AUTO (docs/07 §7.3) |

## Document links

| Scenario | Test |
|---|---|
| create/list/unlink round-trip on both ends | `test/e2e/document-links.e2e.test.ts` — creates one edge both ends list, and removes it from either end |
| duplicate → `LINK_EXISTS`, self → `LINK_SELF` | `test/e2e/document-links.e2e.test.ts` — refuses a duplicate in either spelling, and a document linked to itself |
| an edge whose other side the caller cannot read is absent from the list | `test/e2e/document-links.e2e.test.ts` — hides an edge whose other side the caller may not read — absent, not redacted |
| hard-deleting a document takes its edges | `test/e2e/document-links.e2e.test.ts` — takes the edges of a hard-deleted document with it |
| suggestions are deterministic, cite their identifiers, and store nothing | `test/e2e/document-links.e2e.test.ts` — proposes the documents that cite this one, saying which identifiers matched; excludes what is already linked, and stores nothing about a refusal; `src/server/domain/entities/document-link.test.ts` — reads number-bearing tokens off the title and the opening of the text |
| suggestions exclude self and the already-linked | `test/e2e/document-links.e2e.test.ts` — proposes the documents that cite this one (asserts self is absent); excludes what is already linked |

## Catalogue merge suggestions

| Scenario | Test |
|---|---|
| admin-only on both endpoints | `test/e2e/people-merge-suggestions.e2e.test.ts` — refuses both endpoints to a non-admin |
| the analyst's groups are validated, not trusted | `src/server/application/people/suggest-people-merges.test.ts` — drops what the model made up: unknown ids, groups of one, a row claimed twice; caps the groups at twenty |
| computed on request, stored nowhere; the cache answers the same catalogue, a changed catalogue asks anew | `src/server/application/people/suggest-people-merges.test.ts` — asks once for one catalogue, and again when it changes |
| no configured analyst → `configured: false`, never an error | `test/e2e/people-merge-suggestions.e2e.test.ts` — answers configured: false with no analyst, never an error; `test/e2e/catalogue-suggestions.e2e.test.ts` — answers configured: false on subjects and kinds alike, never an error |
| admin-only on the subjects and kinds endpoints too | `test/e2e/catalogue-suggestions.e2e.test.ts` — refuses every suggestion endpoint to a non-admin |
| a subject group's kind resolves to a kind the merged rows already have | `src/server/application/subjects/suggest-subject-merges.test.ts` — resolves the survivor kind to one the merged rows already have, and drops a group that cannot |
| placeholders are validated like groups | `src/server/application/subjects/suggest-subject-merges.test.ts` — passes the placeholder rows that are living things, and drops the made-up ones |
| 🔒 names and notes reach the model inside the fenced data channel | `src/server/infrastructure/ai/openai-compat-catalogue-analyst.test.ts` — sends the catalogue inside the fenced data channel, never the system message |
| the merge dialog's prefill never exceeds what the contract accepts | `src/web/screens/people/people-screen.test.tsx` — clamps a prefilled note longer than the contract to what the contract accepts |

## Catalogue identity

| Scenario | Test |
|---|---|
| the fold lowercases every alphabet and collapses whitespace | `src/server/domain/value-objects/name-fold.test.ts` — folds case across alphabets and collapses whitespace |
| a Cyrillic case-twin of a living name is the same name | `test/integration/catalogue-fold.integration.test.ts` — finds the living row under a Cyrillic case-twin in all three catalogues |
| the analysis links rather than spawns on a case-twin answer | `test/integration/catalogue-fold.integration.test.ts` — links the existing row when a name arrives in another case |
| a kinds merge moves the subjects and folds the twins | `src/server/application/subject-kinds/merge-subject-kinds.test.ts` — moves every subject onto the survivor and folds the things both kinds held, links deduplicated; `test/e2e/subject-kind-merge.e2e.test.ts` — folds two kinds into one, and the things they both held with them |
| the surviving kind name may not collide outside the merge | `test/e2e/subject-kind-merge.e2e.test.ts` — refuses a survivor name that belongs to a kind outside the merge |

## Analysis reuses the catalogue

| Scenario | Test |
|---|---|
| known people and things are shown most-filed first, under their caps | `src/server/infrastructure/ai/openai-compat-analyst.test.ts` — shows the people already known and says to answer with the catalogue's spelling; caps the known lists on their most-filed head |
| 🔒 the user-written catalogues travel inside the fence, never the system message | `src/server/infrastructure/ai/openai-compat-analyst.test.ts` — keeps every user-written catalogue inside the fence, and the system message clean of it |
| a catalogue answer in another case links the existing row | `test/integration/catalogue-fold.integration.test.ts` — links the existing row when a name arrives in another case |

## Files and documents

| Scenario | Test |
|---|---|
| a canonical PDF is built for every document, whatever it is made of | `test/integration/canonical-build.integration.test.ts` — assembles an image, a PDF and an office file into one canonical PDF |
| adding, reordering, cropping and splitting each rebuild the document | `test/e2e/document-files.e2e.test.ts` — every composition change enqueues a rebuild |
| splitting off a file yields a document of its own | `test/e2e/document-files.e2e.test.ts` — the file leaves and becomes its own document |
| the last file cannot be taken away (`DOCUMENT_LAST_FILE`) | `test/e2e/document-files.e2e.test.ts` — refuses to empty a document |
| combining moves files in the chosen order and soft-deletes the emptied documents | `test/e2e/document-files.e2e.test.ts` — combines two documents in the order asked for |
| a file belongs to exactly one document (`FILE_ALREADY_IN_DOCUMENT`) | `test/e2e/document-files.e2e.test.ts` — refuses bytes that already have a home |
| the crop is a quadrilateral applied as a perspective transform | `src/server/domain/entities/crop-geometry.test.ts` — maps a skewed quad onto a rectangle |
| corners are detected, and fall back to the content box | `src/server/domain/entities/page-detection.test.ts` — finds a rotated page; answers nothing for a frame with no page in it |
| a MANUAL crop survives a rebuild | `test/e2e/document-files.e2e.test.ts` — a rebuild does not overwrite a crop somebody dragged |
| a document with a missing original still serves its canonical | `test/e2e/document-files.e2e.test.ts` — the canonical downloads while the volume is gone |

## API

| Scenario | Test |
|---|---|
| unknown `/api/*` → JSON `NOT_FOUND` (not HTML) | `test/e2e/bootstrap.e2e.test.ts` — unknown /api route returns a JSON NOT_FOUND envelope, never HTML |
| envelope shape on success and error | `test/e2e/bootstrap.e2e.test.ts` — wraps success in { data } and failure in { error }, and nothing else (docs/07 §7.1) |
| BigInt as string | `test/e2e/documents.e2e.test.ts` — carries a size past what a JS number holds, exactly (docs/07 §7.4) |
| soft-deleted → 404 everywhere | `test/e2e/documents.e2e.test.ts` — soft-deletes a document, after which it is gone from every route |

## The security checklist of `08 §8.6`

One row per line of the checklist in
[`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist), in the order that section lists
them. A box there is ticked when — and only when — the tests named here exist and pass; the two lines
with no test are deployment properties, and they say so in the checklist rather than being struck
from it, because an operator still has to do them.

This map exists because of [SEC-45](./security-audit-2026-08.md#sec-45): the checklist was written as
an intent and never verified, and when the August 2026 audit finally read it against the code, two of
its lines were false. A claim nobody can run is a claim nobody is checking.

| Checklist line | Test |
|---|---|
| No open registration: first-admin onboarding once + single-use invite links (tokenHash, TTL, revocation) | `test/e2e/registration.e2e.test.ts` — reports onboarding as required on an empty instance and closed afterwards; creates exactly one admin when two onboardings race; refuses a tokenless registration once onboarding is closed; `test/e2e/invites-resets.e2e.test.ts` — returns the invite URL exactly once and never stores the token; previews a valid invite and reports invalidity for used, revoked and expired ones; mints one account when two registrations complete against the same invite in turn; …at once; refuses a completion when the invite is revoked inside the ticket window; …when the invite expires inside the ticket window; `src/server/application/auth/complete-registration.test.ts` — refuses a second completion against an invite already spent; turns a markAccepted that moved no row into INVITE_INVALID and creates nobody |
| Registration — 3 steps, email code (HMAC hash, TTL 10 min, ≤5 attempts); the `User` exists only after step 3, via a single-use ticket | `test/e2e/registration.e2e.test.ts` — walks the three-step happy path and signs the new admin in; burns the record after five wrong codes; rejects an expired code and an expired ticket; rejects a ticket that was already used; `src/server/application/auth/start-registration.test.ts` — sends a code valid for ten minutes; `src/server/application/auth/verify-email-code.test.ts` — counts wrong codes and burns the series on the fifth; issues a ticket valid for fifteen minutes on the right code; refuses to reuse a consumed series; `src/server/infrastructure/auth/hmac-verification-codes.test.ts` — stores an HMAC under AUTH_SECRET rather than the code itself; is not reproducible by somebody who has the row but not the secret |
| Login: a single `INVALID_CREDENTIALS` + dummy verify; Argon2id; no JWT | `src/server/application/auth/login.test.ts` — reports the same error for an unknown address and a wrong password; verifies a hash even for an address nobody registered, so both answers cost the same; `test/e2e/login.e2e.test.ts` — answers identically for an unknown address and a wrong password; `src/server/infrastructure/auth/argon2-password-hasher.test.ts` — produces a PHC string with the OWASP parameters of docs/08 §8.1.5; salts each hash, so the same password hashes differently. **No JWT** is a negative, proved by what the only credential *is*: `src/server/infrastructure/auth/crypto-session-tokens.test.ts` — generates a base64url token of 32 random bytes with its sha256 hash. Nothing signed is ever presented as a credential, and `package.json` carries no JWT library to present one with |
| The login backoff never locks an account out (§8.4.1a) | `src/server/application/auth/login.test.ts` — signs the owner in mid-backoff, because the password is checked before the streak; applies an exponential backoff to repeated failures against one address; backs an unknown address off exactly as it backs off one that exists; spends one verification per attempt whether or not the address is in backoff; `test/e2e/login.e2e.test.ts` — lets the owner sign in while somebody else is failing against their address; backs off after five failed attempts for one address; clears the failure streak after a successful login; backs an unknown address off exactly as it backs off one that exists |
| Session: an opaque token stored as a hash, new per login, revoked on logout; cookie httpOnly/SameSite=Lax/Secure over HTTPS | `src/server/infrastructure/auth/crypto-session-tokens.test.ts` — generates a base64url token of 32 random bytes with its sha256 hash; never repeats a token; hashes deterministically so a presented token can be looked up; `test/e2e/login.e2e.test.ts` — issues a brand-new session on every login (anti-fixation); populates the caller from the session cookie and revokes it on logout; signs a registered user in and sets a session cookie with the documented attributes; `src/server/presentation/http/session-cookie.test.ts` — is HttpOnly, SameSite=Lax and scoped to the whole site; marks the cookie Secure when the app is served over https; leaves it unset over plain http, or the browser would drop the session entirely; clears with the same attributes it was set with, or the browser keeps it |
| A user lists and ends their own sessions, and changes their own password with the current one (§8.1.6a, §8.2) | `test/e2e/account.e2e.test.ts` — changes the password, keeps this session, and ends every other one; refuses a wrong current password and leaves the account exactly as it was; holds the new password to the same rule as one chosen at sign-up; lists only this user live sessions and marks the one asking; revokes a chosen session and answers 404 for somebody else; lets the owner sign this device out, clearing the cookie with it; is a session-only surface: a read-only token reaches neither route; `src/server/application/auth/change-password.test.ts` — ends every other session and keeps the one making the request; refuses a wrong current password and changes nothing |
| Mutations — fail-closed `csrfOriginCheck` above the dispatcher; per-IP + per-email rate limiting; CAPTCHA on login/start | `test/e2e/login.e2e.test.ts` — CSRF (fail-closed origin check): rejects a mutation with no Origin or Referer; rejects a mutation from a foreign origin; accepts a same-origin mutation proven by Referer alone; leaves reads alone; guards every mutating method, not just POST; guards a mutation that never reaches /api at all; refuses further /api/auth requests from one address once the budget is spent; `test/e2e/registration.e2e.test.ts` — enforces the per-email cap of one code per minute; enforces the per-email daily cap of five codes; `src/server/application/auth/login.test.ts` — rejects a failed CAPTCHA before checking the password; `src/server/application/auth/start-registration.test.ts` — rejects a failed CAPTCHA before touching any state; `src/server/infrastructure/auth/turnstile-captcha-verifier.test.ts` — fails closed when the verification endpoint errors or is unreachable |
| API tokens: hashed at rest, shown once, mandatory expiry, revoked with the owner; a mutating request carrying one is refused before routing (§8.2a) | `test/e2e/api-tokens.e2e.test.ts` — reads as its owner and shows the secret exactly once; is refused on every mutating method, before the route is even reached; carries the owner authority and no more; stops working when revoked, when expired, and when its owner is deactivated; `src/server/application/auth/authenticate-api-token.test.ts` — issues a prefixed token, stores only its hash, and answers with the owner; defaults the lifetime to the instance setting and honours a chosen one; `src/server/presentation/auth/session.guard.test.ts` — refuses a token on a mutating method even with the middleware gone (the second of the two layers §8.2a promises) |
| `passwordHash`/`tokenHash`/codes/tickets and email bodies are never serialized or logged | `test/e2e/request-logging.e2e.test.ts` — writes the route and not the token when an invite link is previewed; …when a reset link is previewed; keeps neither token anywhere in everything the process has emitted; never says what somebody searched their archive for; never says what a document is called; `src/server/infrastructure/logging/logger.options.test.ts` — keeps a route and replaces the token an invite or reset link carries in its path; drops the query string, so a search never says what was searched for; logs the shaped URL and nothing else of what the request carried; removes the credentials and the document names a request carries in its headers; `src/server/infrastructure/email/log-email-sender.test.ts` — logs the recipient and the subject, and never the body; `test/e2e/security-events.e2e.test.ts` — keeps no password, code, ticket or token anywhere in anything it recorded; `test/e2e/users.e2e.test.ts` — returns the signed-in user and never their hash; `src/server/infrastructure/config/instance-view.test.ts` — keeps configured secrets out of the response entirely; names every key in the schema that looks like a credential |
| Every protected route — `SessionGuard` (+ `RolesGuard`/`DocumentAccessGuard`); file endpoints under the same authorization; a private bucket and short-lived signed URLs only | `src/server/presentation/auth/route-guards.test.ts` — puts every route that is not deliberately public behind SessionGuard; keeps no route in its public list that the application no longer serves; lets nothing under /api/admin through without RolesGuard and the ADMIN role it enforces; resolves the document before every route that names one, unless the route is admin-only. It walks the composition root, so "every" is read off the route table rather than asserted route by route. Reached over HTTP too: `test/e2e/documents.e2e.test.ts` — refuses every document route to an anonymous caller; `test/e2e/document-files.e2e.test.ts` — refuses every file route exactly like the metadata routes; lets a granted user download and compose the same document. The bucket: `test/integration/s3-file-storage.integration.test.ts` — refuses an unsigned request for a private object; rejects the same URL once its TTL has passed (both skip themselves when MinIO is not running — `npm run dev:up`); `src/server/infrastructure/storage/s3-file-storage.test.ts` — signs a GET that expires after the requested TTL; signs a different URL per key, so one URL never grants access to another artifact |
| Library paths are validated against the root (no traversal, no symlink out) | `test/e2e/libraries.e2e.test.ts` — rejects a path outside the volume, a missing one, and a file; rejects a root reached through an intermediate symlink (🔒); refuses to browse outside the volume (🔒); `test/integration/fs-library-reader.integration.test.ts` — skips symlinks, including one escaping the volume (🔒); `src/server/domain/value-objects/relative-path.test.ts` — rejects upward traversal in any position; rejects absolute paths, including Windows and UNC forms; rejects NUL bytes, which can truncate a path at the syscall boundary; re-validates on join, so a child cannot escape its parent |
| Libraries are mounted `:ro` | **No test, and none is possible from here.** The mount is a line in `deploy/docker-compose.yaml` ([`12 §12.7`](../12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)); an instance whose operator mounted the volume read-write behaves identically as far as this suite can see. The application's own half of that promise — it never opens a library file for writing — is the row above plus [`09 §9.1`](../09-file-storage.md). The box stays unticked. |
| The last active admin is protected (`LAST_ADMIN`) | `test/e2e/users.e2e.test.ts` — refuses to demote the last admin; refuses to deactivate the last admin; allows demoting an admin once a second one exists |
| SMTP credentials from a secret manager; the `SMTP_FROM` domain with SPF/DKIM | **No test, and none is possible from here.** Both are properties of the environment an operator builds, not of this codebase — and what ships is honestly weaker than the line claims: `deploy/init.sh` generates the secrets into a `chmod 600` `.env` ([`12 §12.7`](../12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)), and SPF/DKIM is a production note ([`12 §12.8`](../12-build-config-run.md#128-production-notes)). The box stays unticked. |
