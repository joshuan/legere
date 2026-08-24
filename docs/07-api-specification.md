# 07. API Specification

REST over `/api`. All request/response bodies are described by Zod schemas in
`src/shared/contracts` — those schemas are the machine-readable source of truth; this document is the
human-readable index and must stay in sync with them.

## 7.1. Conventions

- **Envelope:** success → `{ "data": ... }`; error → `{ "error": { "code", "message", "details" } }`.
  `code` is a machine string from §7.2; `message` is an English developer hint (the UI localizes by
  `code`, never shows `message`); `details` is `null` or a structured object (e.g. Zod issues).
- **Status codes:** 200 (read/update), 201 (create), 204 — never used (bodies always present),
  401/403/404/409/413/422/429/500 per §7.2 (413 only for an upload over `UPLOAD_MAX_BYTES`). Unknown `/api/*` route → 404 `NOT_FOUND` (JSON, never HTML).
- **Auth:** session cookie `sid` (httpOnly), or `Authorization: Bearer <api token>` for reads
  ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)). 🔒 = requires session;
  🔒ᴬ = requires role ADMIN. A bearer token satisfies 🔒/🔒ᴬ on safe methods as its owner would;
  on any other method the request is refused with `READ_ONLY_TOKEN`, so every mutation below means
  "session only". Mutations additionally pass the fail-closed Origin check
  ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)).
- **Pagination:** cursor-based: request `?limit=` (default 30, max 100) `&cursor=` (opaque);
  response `{ data: { items: [...], nextCursor: string | null } }`. An **aggregate** is not a list of
  resources and is not paginated: `GET /api/documents/years` and `GET /api/documents/groups` answer a
  bounded `{ items }` of counts with no cursor, and what those counts stand for is reached through
  the ordinary paginated list filtered by them (`§7.3`).
- **Sorting** is fixed per endpoint (documented below) unless the endpoint declares a **closed enum
  of named orders**, which it takes as `?sort=`. A named order is not an arbitrary sort param: every
  value is spelled out in the contract, has an index behind it (`04 §4.4`), and a name the enum does
  not hold is a `VALIDATION_FAILED`, not a sequential scan. `GET /api/documents` is the only such
  endpoint today (`§7.3`); every other list keeps exactly one order and takes no `sort` at all.
- **The cursor carries the question it was cut from.** It is an opaque base64url string, and
  opaque is not secret — anybody can write one — so it is versioned, and where a list offers more
  than one order it also names the order the page was cut in. Two rules follow, and they are the
  rules for the next change to the encoding as much as for this one:
  - a cursor this version **cannot read** — a stale version, a key that does not fit its order — is
    not an error: the list starts from the beginning, because a client cannot repair an opaque
    string, and this is also how a page held open across a deploy recovers;
  - 🔒 a cursor this version **can read but which names another order** is refused with
    `422 CURSOR_SORT_MISMATCH`. A keyset predicate applied to the wrong column does not fail — it
    answers, skipping and repeating rows while looking like an ordinary page, and here there is a
    right answer, so quietly giving the wrong one is worse than saying no.

  One list is outside this: `GET /api/admin/queue/failures` reads pg-boss's own tables, which Prisma
  does not model (`04 §4.2`), and its cursor is the `failedAt` timestamp of the last row returned.
  Being a timestamp it is validated as one — 🔒 anything else is `422 VALIDATION_FAILED`, a malformed
  query parameter rather than an opaque string to start over from, because an unparsed one reaches
  the driver as an `Invalid Date` and answers 500.
- **IDs** are UUIDs in paths. Path params are validated; malformed UUID → 404 (not 422).

## 7.2. Error codes

| HTTP | Code | Where |
|------|------|-------|
| 401 | `UNAUTHENTICATED` | no/invalid session |
| 401 | `INVALID_CREDENTIALS` | login; the current password of `POST /api/me/password` ([`08 §8.1.6a`](./08-auth-and-authorization.md)) |
| 403 | `FORBIDDEN` | authz failure, CSRF failure, deactivated user |
| 403 | `READ_ONLY_TOKEN` | a mutating request carrying an `Authorization: Bearer` header ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)) |
| 404 | `NOT_FOUND` | unknown route/malformed id |
| 404 | `USER_NOT_FOUND`, `LIBRARY_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_TYPE_NOT_FOUND`, `COLLECTION_NOT_FOUND`, `FILE_NOT_FOUND`, `INVITE_NOT_FOUND`, `API_TOKEN_NOT_FOUND`, `SESSION_NOT_FOUND`, `LINK_NOT_FOUND` | resource lookups (incl. soft-deleted); a session belonging to somebody else is *not found* rather than forbidden ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)) |
| 409 | `EMAIL_ALREADY_REGISTERED` | registration race |
| 409 | `LAST_ADMIN` | demote/deactivate/delete last admin |
| 409 | `DOCUMENT_DUPLICATE` | upload whose content already exists as a document the caller may not read |
| 409 | `LIBRARY_PATH_CONFLICT` | nested/duplicate library path |
| 409 | `DOCUMENT_TYPE_SLUG_TAKEN`, `COLLECTION_NAME_TAKEN` | uniqueness |
| 409 | `DOCUMENT_LAST_FILE` | removing the only file of a document |
| 409 | `LINK_EXISTS` | linking two documents that are already linked |
| 409 | `FILE_ALREADY_IN_DOCUMENT` | attaching a file that already belongs to a document |
| 409 | `CANONICAL_NOT_READY` | the canonical PDF has not been built yet |
| 409 | `DOCUMENT_UNAVAILABLE` | source download when all refs MISSING |
| 409 | `STEPS_PAUSED` | a reprocess whose every requested step is paused ([`05 §5.4d`](./05-library-and-processing.md#54d-a-step-can-be-paused)) — the job would do nothing, so it is refused rather than enqueued |
| 410 | `ONBOARDING_CLOSED` | onboarding after first user exists |
| 415 | `UNSUPPORTED_FORMAT` | an uploaded file whose detected content type the pipeline cannot render into pages ([`05 §5.1a`](./05-library-and-processing.md#51a-uploads)) — all three upload routes |
| 422 | `VALIDATION_FAILED` | Zod failure (`details.issues`) — including the timestamp cursor of `GET /api/admin/queue/failures` (§7.1) |
| 422 | `CURSOR_SORT_MISMATCH` | a cursor cut from one named order handed to a request asking for another (§7.1) |
| 422 | `LIBRARY_PATH_INVALID` | path outside root / not a directory |
| 422 | `FILE_NOT_IMAGE` | cropping something that is not an image |
| 422 | `FILE_NOT_PDF` | ordering the pages of something that has none — only a PDF does (`03 §3.3.16`) |
| 422 | `LINK_SELF` | linking a document to itself |
| 400 | `EMAIL_CODE_INVALID`, `REGISTRATION_TICKET_INVALID`, `INVITE_INVALID`, `RESET_INVALID`, `CAPTCHA_FAILED` | auth flows |
| 429 | `RATE_LIMITED`, `EMAIL_CODE_TOO_MANY_ATTEMPTS` | limits |
| 500 | `INTERNAL` | unexpected |

## 7.3. Endpoints

### Auth & account
| Method & path | Auth | Body → Response (`data`) |
|---------------|------|--------------------------|
| `GET /api/auth/onboarding` | — | → `{ required: boolean }` |
| `POST /api/auth/register/start` | — | `{ email, inviteToken?, resetToken?, captchaToken? }` → `{ expiresAt }` (always 200; starts REGISTRATION or PASSWORD_RESET series). Onboarding: allowed with no token only while `onboarding.required`; otherwise a valid `inviteToken`/`resetToken` is mandatory → else `INVITE_INVALID`/`RESET_INVALID` |
| `POST /api/auth/register/verify` | — | `{ email, code }` → `{ ticket, expiresAt }` |
| `POST /api/auth/register/complete` | — | `{ ticket, password }` → `UserDto` + sets `sid` (creates the user: first user → ADMIN; via invite → invite.role; via reset → updates password, revokes sessions) |
| `POST /api/auth/login` | — | `{ email, password, captchaToken? }` → `UserDto` + sets `sid` |
| `POST /api/auth/logout` | 🔒 | `{}` → `{ ok: true }` + clears `sid` |
| `GET /api/invites/:token` | — | → `{ role, emailHint, expiresAt, valid: boolean }` |
| `GET /api/password-resets/:token` | — | → `{ email(masked), expiresAt, valid: boolean }` |
| `GET /api/me` | 🔒 | → `UserDto` |
| `PATCH /api/me` | 🔒 | `{ displayName?, language?, theme? }` → `UserDto` (also refreshes `NEXT_LOCALE` cookie) |
| `POST /api/me/password` | 🔒 session | `{ currentPassword, newPassword }` → `{ revoked }` — an authenticated rotation ([`08 §8.1.6a`](./08-auth-and-authorization.md)); wrong current → `401 INVALID_CREDENTIALS`; revokes every **other** session of the caller and keeps this one, `revoked` counting them |
| `GET /api/me/sessions` | 🔒 session | own live sessions, newest first → `{ items: SessionDto[] }` |
| `DELETE /api/me/sessions/:id` | 🔒 session, owner | revoke → `{ ok: true }`; already revoked is not an error, `404 SESSION_NOT_FOUND` for somebody else's; revoking the current one is allowed and clears `sid` |
| `GET /api/me/api-tokens` | 🔒 | own tokens, newest first; usable ones and the recently dead alike, never a secret → `{ items: ApiTokenDto[] }` |
| `POST /api/me/api-tokens` | 🔒 | `{ name, expiresInDays? }` (1…365, default `API_TOKEN_TTL_DAYS`) → `{ token, apiToken: ApiTokenDto }` — `token` appears in this response and nowhere else |
| `DELETE /api/me/api-tokens/:id` | 🔒 owner | revoke → `{ ok: true }`; already revoked is not an error, `404 API_TOKEN_NOT_FOUND` for somebody else's |

`ApiTokenDto` = `{ id, name, createdAt, expiresAt, lastUsedAt, revokedAt, status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }`.
`status` is derived on read rather than stored, so a token that expired while nobody was looking
reports as expired.

`SessionDto` = `{ id, userAgent, current, createdAt, expiresAt }` — never the token or its hash.
`current` marks the session the request itself is carrying. **🔒 session** in the table above means
the route needs a cookie session: an `Authorization: Bearer` credential is refused with `403
FORBIDDEN` on the read and `403 READ_ONLY_TOKEN` on the two mutations, because a token has no
session and cannot answer "which of these is you" ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)).

`UserDto`: `{ id, email, displayName, role, language, theme, createdAt }` — never contains hashes.

### Admin: users & invites
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/users` | 🔒ᴬ | paginated; `{ id, email, displayName, role, deactivatedAt, createdAt }`; sort: createdAt asc |
| `PATCH /api/admin/users/:id` | 🔒ᴬ | `{ role? }`; `LAST_ADMIN` guard |
| `POST /api/admin/users/:id/deactivate` \| `/reactivate` | 🔒ᴬ | `LAST_ADMIN` guard; deactivate revokes sessions |
| `POST /api/admin/users/:id/revoke-sessions` | 🔒ᴬ | → `{ revoked: number }` |
| `POST /api/admin/users/:id/password-reset` | 🔒ᴬ | → `{ url, expiresAt }` (single-use link; admin delivers it out of band) |
| `POST /api/admin/invites` | 🔒ᴬ | `{ role, emailHint? }` → `{ id, url, role, expiresAt }` (the token appears **only** in this response) |
| `GET /api/admin/invites` | 🔒ᴬ | active invites (no tokens) |
| `DELETE /api/admin/invites/:id` | 🔒ᴬ | revoke → `{ ok: true }` |

### Admin: libraries & scans
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/library-path-candidates?path=` | 🔒ᴬ | lists subdirectories of `LIBRARY_ROOT/<path>` to pick from in the UI → `{ path, dirs: [{ name }] }` |
| `POST /api/admin/libraries` | 🔒ᴬ | `{ name, rootPath, visibility, scanIntervalMinutes?, excludeGlobs?, userIds? }` → `LibraryAdminDto`; validates path (`LIBRARY_PATH_INVALID`/`_CONFLICT`); enqueues the first scan |
| `GET /api/admin/libraries` | 🔒ᴬ | with counters `{ files, documents, missing }` |
| `GET /api/admin/libraries/:id` | 🔒ᴬ | |
| `PATCH /api/admin/libraries/:id` | 🔒ᴬ | `{ name?, enabled?, visibility?, scanIntervalMinutes?, excludeGlobs?, userIds? }` (rootPath is immutable — create a new library instead) |
| `DELETE /api/admin/libraries/:id` | 🔒ᴬ | soft delete |
| `POST /api/admin/libraries/:id/scan` | 🔒ᴬ | "Scan now" → `{ scanRunId }` (no-op `{ alreadyRunning: true }` if a scan is active) |
| `GET /api/admin/libraries/:id/scans` | 🔒ᴬ | paginated ScanRun journal, newest first |

`LibraryAdminDto`: `{ id, name, rootPath, enabled, visibility, scanIntervalMinutes, excludeGlobs, userIds, createdAt }`.

### Libraries & browsing (user-facing)
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/libraries` | 🔒 | libraries visible to the caller: `{ id, name }` — used for filters and browse roots |
| `GET /api/libraries/:id/browse?path=&cursor=` | 🔒 | virtual folder view derived from FileRef paths: `{ path, folders: [{ name, documentCount }], documents: { items: [DocumentListDto], nextCursor } }`; folders sorted by name, documents by title. 🔒 `path` names a folder and nothing else: `%` and `_` are letters here, matched literally rather than as the `LIKE` wildcards they are underneath (`05 §5.1`) |

### Documents
| Method & path | Auth | Notes |
|---------------|------|-------|
| `POST /api/documents` | 🔒 | **upload**: the file as the raw request body, its name in `X-Legere-Filename` (RFC 5987 or plain). Mime detected from content; a format the pipeline cannot render → `415 UNSUPPORTED_FORMAT` (`05 §5.1a`); `UPLOAD_MAX_BYTES` cap → 413. Deduplicated by **file** (ADR-009, ADR-021): bytes that are already a file resolve to that file's document when the caller may read it (`200`), and to `409 DOCUMENT_DUPLICATE` when they may not. Otherwise `201` with a new document holding the new file, processing already enqueued |
| `GET /api/documents` | 🔒 | paginated; `sort?` = `documentDate` (default) \| `createdAt` \| `lastEventAt` — the closed set of named orders of §7.1, all three newest-first with the id as the tiebreak (see below); filters: `libraryId?`, `typeId?`, `personId?`, `subjectId?`, `subjectKindId?` (every subject of that kind at once, 03 §3.3.20a), `year?`, `country?` (ISO 3166-1 alpha-2, upper-cased on the way in like the PATCH does, so `?country=me` is the same question), `city?` (matched exactly as stored, which is what a link carrying a document's own place hands over), `availability?` (`AVAILABLE`\|`PARTIAL`\|`UNAVAILABLE`), `processing?` (bool), `origin?` (`LIBRARY`\|`MANAGED`), `unassigned?` (a grouping dimension: the documents that have **no** value in it — no type, no date, nobody named on them; a question no uuid filter has room to ask, and the one a grouped grid needs for its last section, `11 §11.3`), `step?` + `stepStatus?` (given together: the documents whose named pipeline step sits in that status — what a queue counter links to, 11 §11.13); only documents the caller can read. Every one of them is what a name in the viewer's details pane links to (11 §11.5); `subjectId` and `subjectKindId` given together are one question and not two — a kind with a thing of another kind finds nothing |
| `GET /api/documents/years` | 🔒 | `{ items: [{ year, count }] }`, newest first — the years the caller's documents carry (11 §11.4). Declared before `:id`, or the router reads "years" as a document id
| `GET /api/documents/groups?by=` | 🔒 | `{ items: [{ key, label, count }] }`, where a `key` of `null` is the group of documents that have **no** value in that dimension — last, and outside the cap, because dropping it would take those documents off the screen rather than off a shelf (`11 §11.3`); its contents are this list with `unassigned=<dimension>` — the shelves of one dimension under the filters in force (see below). `by` = `type`\|`person`\|`subject`\|`year`\|`country`\|`city`; takes **every filter `GET /api/documents` takes** and no pagination. Declared before `:id`, like the years |
| `GET /api/documents/:id` | 🔒 | → `DocumentDetailDto`, including `skipReasons`, `pageFormat`, `titleSource` and `auto` — what the pipeline decided before anybody corrected it, `auto.textQuality` and the marks in `auto.quality` among it (03 §3.3.10) |
| `PATCH /api/documents/:id` | 🔒 | `{ title?, description?, languages?, country?, city?, typeId?, peopleIds?, subjectIds?, documentDate?, pageFormat?, fields? }` per canEditDocumentMeta (03 §3.4); setting typeId flips `typeSource` to MANUAL (null → NONE), and setting `title` flips `titleSource` to MANUAL, after which no analysis renames the document. `languages` are BCP-47 tags, `country` ISO 3166-1 alpha-2 (upper-cased on the way in), `city` free text; all three are corrections of what detection guessed (03 §3.3.10). `fields` is a partial map over the document's field schema (03 §3.3.10a): each key set marks that field `MANUAL`, `null` clears value and source both; a key the schema does not know, a value the wrong shape for its kind, or a document whose type has no schema → `VALIDATION_FAILED`. `reset: ('title'\|'description'\|'documentType'\|'languages'\|'country'\|'city'\|'documentDate'\|'fields'\|'fields.<key>')[]` puts fields back to what the pipeline read and, for the title, the document type and the typed fields, restores `AUTO` — it is applied after the explicit values, so a payload carrying both ends with the reset; `fields` resets the whole map, `fields.<key>` one field. `pageFormat` is the one field here that is not a correction to a record but an instruction for the next build: it is stored, and **nothing is enqueued**. The shape of a page is decided while the page is being made (`05 §5.5` step 1), so the pages keep the shape they have until the canonical is built again — which is what `POST /api/documents/:id/reprocess` is for. 🔒 A metadata edit may not start a rebuild of the whole document: somebody who picked A4 out of a select asked for the field to say A4, not for forty pages to be remade, their text recognised afresh and every artifact derived from them replaced. So the format travels with the same PATCH as the city, and the rebuild is asked for separately and on purpose. **The one edit that does enqueue is a change of type** — by `typeId` or by `reset: ['documentType']` — and it enqueues exactly the `fields` step (`05 §5.5` step 5), because the typed fields are a reading of the document *under its type* and a stale reading under the wrong schema is wrong data, not old data. One model call, not a rebuild: the pages, the text and the vectors stay |
| `DELETE /api/documents/:id` | 🔒ᴬ | **hard delete** — the one endpoint that destroys user data (03 §3.3.10, ADR-015 as amended). The document row and everything cascading from it (journal, chunks, people/subject links, `document_files`), its collection items and its `File` rows are deleted; so are its artifacts and the S3 originals of its `MANAGED` files. Every `FileRef` of those files is kept and set `EXCLUDED`, so the bytes stay on the read-only volume and no scan ingests them again (03 §3.3.9). Not reversible; `{ ok: true }`. The rows go first and the objects after, so a bucket that refuses mid-way leaves orphans the hourly `maintenance` sweep collects (09 §9.2) rather than rows pointing at nothing |
| `POST /api/documents/:id/reprocess` | 🔒ᴬ | `{ steps?: ('canonical'\|'preview'\|'markdown'\|'analysis'\|'fields'\|'vectorization')[], analyseInFull?: boolean }` → re-enqueues `document-process`. `analyseInFull` asks for this one document to be analysed however long it is: the page limit of `05 §5.5` steps 4–5 is on what the pipeline does unasked, and this is the asking. Per document on purpose — a limit any bulk re-run could lift would not be a limit. 🔒 **A run clears the slate of the steps it was asked to run, and of nothing else** — their statuses go to `QUEUED` and their skip reasons go, here and again in the handler. `processingError` and `failedStep` follow the same rule rather than being wiped every time: they are cleared only where the run may actually re-run the step that owns them, so an extraction failure survives a reprocess of the analysis alone. Otherwise the field that says why there is nothing to analyse would be emptied by the very run that has nothing to analyse, and `failedStep` would stop being *the* failed step (03 §3.3.10). 🔒 **A paused step is not run for the asking** (`05 §5.4d`): the paused ones are dropped from the request, the answer names the steps actually enqueued, and a request whose every step is paused is refused with `409 STEPS_PAUSED` — a pause an admin can talk around on one document is not a pause |
| `GET /api/documents/:id/events` | 🔒 | paginated, newest first → `{ items: DocumentEventDto[], nextCursor }` — the document's history (03 §3.3.18). Same access as the document itself |
| `GET /api/documents/:id/markdown` | 🔒 | → `{ markdown: string \| null }` |
| `GET /api/documents/:id/preview` | 🔒 | 302 → signed URL of `preview.jpg` (404 `NOT_FOUND` if step not DONE) |
| `GET /api/documents/:id/thumb` | 🔒 | 302 → signed URL of `thumb.jpg` |
| `GET /api/documents/:id/canonical` | 🔒 | 302 → signed URL of `canonical.pdf`, `Content-Disposition` chosen by `?download=1`. This **is** the document as far as reading and downloading go (`05 §5.5`); `409 CANONICAL_NOT_READY` while the step has not finished. The originals are one level down, under `/files/:fileId/content` |

**The three orders of `GET /api/documents?sort=`** (§7.1; the control that chooses them is `11 §11.3`):

| `sort` | Means | Ordering |
|---|---|---|
| `documentDate` *(default)* | the date written on the paper (`03 §3.3.10`) | `document_date DESC NULLS FIRST, id DESC` — newest first, and **the undated before everything**: a document whose date nobody has read yet is the one still wanting attention, and NULLS LAST files it behind a century of dated ones |
| `createdAt` | when Legere first saw it | `created_at DESC, id DESC` — the order every list had before this existed |
| `lastEventAt` | when it last changed: the newest entry in the document's journal, of **any** type (`03 §3.3.18`) | `last_event_at DESC, id DESC` |

`lastEventAt` is deliberately **not** `updatedAt`: the pipeline bumps that whenever it rewrites a
step status, and two raw writes skip Prisma's stamping altogether, so it is an honest "row touched"
and a dishonest "edited". It is a column kept beside the log rather than `max(document_events.at)`
computed per row, because ranking an archive by an aggregate over the log is not something an index
can serve (`03 §3.3.18`, `04 §4.4`). A document with **no journal entries at all** reads as the
moment it came into being — its `createdAt` — which is the only honest thing to say about when it
last changed, and keeps the column non-null.

🔒 The cursor names which of the three it was cut from; changing `sort` mid-pagination earns
`422 CURSOR_SORT_MISMATCH` rather than a page read off the wrong column (§7.1). A client changing
the order therefore starts the list again, which is what it wanted anyway.

**The shelves of a dimension: `GET /api/documents/groups?by=`** (the control that chooses one is
`11 §11.3`). An answer is `{ items: [{ key, label, count }] }` — the same bounded `{ items }` shape
`/years` uses, and for the same reason: these are counts, not resources, so there is nothing to
paginate and the envelope of §7.1 is not broken by having no cursor. **A group's contents are the
ordinary list filtered by that group's `key`**, which is what makes a shelf reachable at all — and
why every dimension offered is one `GET /api/documents` can filter by:

| `by` | The shelf | Its `key` goes in | `label` |
|---|---|---|---|
| `type` | the document type (`03 §3.3.12`) | `typeId` | the type's name |
| `person` | who the document is about (`03 §3.3.19`) | `personId` | the person's name |
| `subject` | what it is about (`03 §3.3.20`) | `subjectId` | the subject's name, without its kind — the two are separate facts (`11 §11.5`) |
| `year` | the year on the paper | `year` | the year itself |
| `country` / `city` | where it is from | `country` / `city` | the value as the document carries it: an ISO code, a city as written |

Two rules chose that set out of the filters, and both are about not answering a wrong number:

- a group's key must **identify** a shelf. `availability`, `processing`, `origin` and
  `step`+`stepStatus` say what the machine is doing with a document rather than what the document is
  about, and the filter bar already draws every value of them (`11 §11.3`);
- a group's count must be a count of **documents**, which is exact only where the dimension meets a
  document at most once — a column of the document, or a link table whose primary key holds it once
  (`04 §4.4`). `libraryId` and `subjectKindId` are left out for that reason and no other: a document
  holds many files in one library (and one file may lie at two paths in it), and it may name two
  subjects of the same kind, so counting either would count joins. Both remain filters.

**A document on several shelves appears on each of them.** One naming two people is counted under
both, and the same for subjects. The alternative — counting it once, wherever "once" fell — is a card
missing from a shelf it belongs on, which is worse than a total larger than the archive. And a
document with **no value** in the dimension — no type read, no date, no place — is on no shelf of it
rather than on an "unknown" one: the filters have no way to say "typeId is null", so such a shelf
would be one whose contents nothing could open. The counts therefore need not add up to the number
of documents, in either direction.

**The counts are the archive's under the filters in force, not the current page's**: they are
computed by the database over everything the filters select, so a page of thirty may sit under a
shelf that says 812. 🔒 And they are computed under the same access rule as the list itself
(`03 §3.4`): a count over documents this caller may not open would be a leak dressed as a number, and
a shelf they can reach nothing through does not exist for them. At most **100 shelves** come back,
fullest first with the label breaking a tie — a dimension is unbounded (a person, a city), and an
unbounded aggregate on a request any signed-in caller can repeat is not something to serve.

`DocumentListDto`: `{ id, title, fileCount, primaryExt, sizeBytes(string, the files together), pageCount, documentType: {id,slug,name}|null, availability, processing, origin, hasPreview, createdAt, documentDate, people: {id,name}[], subjects: {id,name}[], country, city, languages, extractedSummary }`.
The last seven are **what a card may show** (`11 §11.3`): they travel on every row of every page whether
or not the screen draws them, because which of them appear is the reader's choice and lives in their
URL rather than in the request. They cost the page two more queries and not one per card — the people
and the subjects of `document_id IN (…)`, both index-served by the link tables' own primary keys
(`04 §4.4`). `extractedSummary` is `Record<string, unknown> | null` — the values of the
summary-flagged fields of the document's schema (03 §3.3.10a), as stored; the client formats them by
the registry it ships with, keyed off `documentType.slug`, and it costs the page nothing extra — the
values are a projection of a column already on the row.
`DocumentFileDto` also carries `earlierVersions: DocumentFileVersionDto[]` — the copies of that page
that have been replaced (`05 §5.6`), newest first, each `{ id, name, mimeType, ext, sizeBytes, origin,
available, trashedAt, refs, storageKey }`. They are in the trash, so they are not part of the
document; they are on the file because "what did this page look like before" is a question about the
page. Their bytes download from the same `…/files/:fileId/content` route as any other file of the
document, by their own id.

`DocumentDetailDto` = list dto + `{ ocrUsed, pageFormat, titleSource, typeSource, steps: {canonical, preview, markdown, analysis, fields, vectorization}, skipReasons, pausedSteps, processingError, failedStep, createdBy?, files: DocumentFileDto[], people: {id,name,deleted}[], subjects: {id,kindId,kind,name,deleted}[], description, auto, extracted }`.
Which steps the instance is **holding** is not on the document, because it is not about the document:
it is one instance-wide fact read from `GET /api/pipeline/paused-steps` (below) and shown against the
steps of whichever document is open (`11 §11.5`).
`extracted` is the whole typed-fields answer of `03 §3.3.10a` — `{ schema: {slug, version}, values,
sources } | null` — and `auto.fields` beside it is what the model last read, which is what the
"read as X" line and the per-field reset are drawn from. The people and subjects are the list's own, said more fully: `deleted` says the catalogue no longer holds that name — the link survives a deletion on purpose (03 §3.3.19), so the flag is the only thing that distinguishes a name still worth choosing from one kept as a record, and it is on the detail because that is where a name can still be chosen. A subject carries its kind by id as well as by name, because the kind is a row of its own (03 §3.3.20a) and each half is a way into the documents filed under it (11 §11.5).

`DocumentFileDto` = `{ id, position, name, mimeType, ext, sizeBytes, origin: 'LIBRARY' | 'MANAGED', available: boolean, crop: { points: [[x,y] ×4] } | null, cropSource: 'NONE' | 'AUTO' | 'MANUAL', pageOrder: number[] | null, pageCount: number | null, isImage, refs: [{ libraryId, libraryName, path, status }], storageKey: string | null }` — ordered by position; `pageOrder` and `pageCount` are the file's own pages (`03 §3.3.16`): the order they are read in, `null` where they stand as they arrived, and how many of them the last canonical build counted, `null` until one has — which together are what says whether a row has pages to arrange at all (`11 §11.5a`); `refs` lists only libraries visible to the caller (ADMIN sees all) and is empty for a managed file. **A location is answered for every file**, and the two fields divide it: `refs` for bytes on a volume, `storageKey` for the object in the bucket a `MANAGED` file's bytes lie under (`09 §9.2`), null for a `LIBRARY` file, which has no object at all. 🔒 The key is a location and not a way in — the bucket is private and only a signed URL reads it, issued by an endpoint that has already passed the access check — and it discloses nothing new either: the layout is `files/{fileId}/original.{ext}` and both halves are already on this DTO.

### Document links

Two documents that belong together and stay two documents (`03 §3.3.23`, ADR-023). Undirected: both
ends list the same edge, and either may act on it (per the rules of `03 §3.4`). The list is not
paginated — an edge set a person curates by hand is bounded the way collection shares are.

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/documents/:id/links` | 🔒 | → `{ items: [{ document: DocumentListDto, linkedAt }] }`, newest first. 🔒 An edge whose other side the caller may not read is absent from the answer entirely — not present, not redacted (`03 §3.3.23`) |
| `POST /api/documents/:id/links` | 🔒 canEdit | `{ documentId }` → `{ document: DocumentListDto, linkedAt }` (201). Requires read on the other document, which otherwise answers `DOCUMENT_NOT_FOUND`; `LINK_SELF` for the document itself, `LINK_EXISTS` for an edge already there. Writes a `LINKED` journal entry on **both** documents (`03 §3.3.18`) |
| `DELETE /api/documents/:id/links/:documentId` | 🔒 canEdit | removes the edge (hard, `03 §3.3.23`) → `{ ok: true }`; `LINK_NOT_FOUND` where there is none. `canEditDocumentMeta` on either end suffices. Writes `UNLINKED` on both |
| `GET /api/documents/:id/link-suggestions` | 🔒 | → `{ items: [{ document: DocumentListDto, matchedTokens: string[] }] }`, at most 5 — documents that cite this one's identifiers (`05 §5.6b`). Computed on request, never stored; already-linked documents and the document itself are excluded; each row says which identifiers matched |

### Search
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/search?q=&mode=&limit=&libraryId?=&typeId?=` | 🔒 | `mode`: `hybrid` (default) \| `text` \| `semantic`. → `{ items: [{ document: DocumentListDto, score, snippet, matchedIn }], semanticAvailable: boolean }`. **Text searches everything the document has a word in** (`04 §4.3`): its title, its **searchable extracted values**, its description, its Markdown and its place — all of them in the generated `search_vector` — **and the names of what it is made of and about**: the **names of its files**, of the people on it and of the things it is about, each matched in its own table through a GIN index on that very expression and joined back through `document_files` / `document_people` / `document_subjects`. A name is never copied onto the document, so a file that arrived a second ago and a person renamed a second ago are both findable at once (`04 §4.3`). 🔒 The caller's words and everything they are compared against are tokenised by one rule — `_`, `-` and `.` are separators (`04 §4.3`) — so `kadastar`, `IMG_0042` and `12-2019` find the scan, the upload and the act, which none of them did while Postgres read each name as a single token. 🔒 **A number is findable in the alphabet it is typed in, not the one it was printed in** (`04 §4.3`): every identifier — an alphanumeric run containing a digit — is stored in both, so `XTA210700M0596136` finds the VIN a Russian registration spells `ХТА210700М0596136` and a Cyrillic query finds the Latin one on a Serbian polis. The fold reaches identifiers only, never words, so no Latin word is made to match a Russian one; and the caller's words are never rewritten, which is what keeps the highlight on the ones they actually typed. 🔒 **Diacritics fold on both sides** (`04 §4.3`): a mark is not a look-alike and cannot be put back, so the stored side keeps a second reading of every word carrying one and the query gets a **second branch** with its own marks removed, OR-ed onto the first — `Sremcevica` reaches `Sremčevića` and `Sremčevića` reaches `SREMCEVICA`, each branch is the whole query so what was joined with a space stays joined, and the first branch still matches the text as written, which is where the highlight comes from. 🔒 A hit reached **only** through a fold carries no highlight: `ts_headline` marks the query against the text as written, so a snippet with no `<mark>` in it means the paper spells the word differently from the way it was asked for. 🔒 **A name is one name in two scripts** (`04 §4.3`): every Cyrillic word of three letters or more is stored under both its Serbian and its Russian Latin reading, and the query carries **two further branches** reading Cyrillic out the same two ways — so `Shershnev` finds the Russian paper and `Шершнев` finds the Serbian one, `Beograd` finds `Београд` and back. Words shorter than four letters are deliberately left alone: they are the function words of both languages and would make `no`, `on`, `god` and `sam` match every Russian or Serbian document, the `simple` configuration having no stop words. Four branches in all, parsed once in `q` and read from there by every comparison. Ranking is one `ts_rank` over the document's vector **with the matched names appended at weight `A`**, so a hit on a file name ranks like a hit on the title rather than trailing the archive. The snippet is `ts_headline` over the title, the matched names, the description and the head of the Markdown, in that order, so the highlight lands on whatever actually matched instead of on the first paragraph of a document that matched elsewhere; the names are quoted in their separated form (`IMG 0042 jpg`), because that is the form the query tokenises to and an unmarked snippet under a `fileName` reason answers nothing. **`matchedIn`** says why the row is here — a subset of `title`, `fileName`, `person`, `subject`, `fields`, `description`, `place`, `text`, `meaning` — computed for the answered page only, never for the whole candidate set; 🔒 the prose reason is read out of the stored vector rather than tokenising the Markdown a second time (SEC-25), which is why a word that is in both the description and the text is credited to the description alone — an incomplete reason, never a wrong one; `meaning` is the semantic half's, and a fused hit carries both halves' reasons (`11 §11.6`). Semantic: embed `q`, top-k chunks by cosine, group by document (best chunk wins; snippet = chunk excerpt). Hybrid: Reciprocal Rank Fusion (k = 60) over both lists. Access filter applied **in SQL** before limit — a name matching in a document the caller may not read is not a row. Provider unconfigured → `semanticAvailable: false`, hybrid silently = text |

### People
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/people` | 🔒 | one page of the catalogue with a document count each, by name — paginated like every other list (§7.1, SEC-56) |
| `POST /api/people` | 🔒 | `{ name, note? }` → `PersonDto`; `409 PERSON_EXISTS` on a name that already lives. Open to any signed-in caller (03 §3.3.19), 🔒 rate-limited (SEC-56): the row lands in a namespace every user reads |
| `PATCH /api/admin/people/:id` | 🔒ᴬ | `{ name?, note? }` |
| `POST /api/admin/people/merge` | 🔒ᴬ | `{ ids[≥2], name, note? }` → the surviving `PersonDto`. The oldest of the rows survives, takes the name, and receives every document link the others had (duplicates collapsed); the rest are soft-deleted, all in one transaction. `409 PERSON_EXISTS` when the chosen name belongs to somebody outside the merge (03 §3.3.19) |
| `GET /api/admin/people/merge-suggestions` | 🔒ᴬ | → `{ configured, groups: [{ ids[≥2], name, aka[] }] }` — the analyst's reading of the living catalogue (05 §5.6c): rows it takes for one person, the spelling it would keep, the distinct other spellings. Computed on request and cached in-process against the catalogue's content; **nothing stored, a refusal never remembered**. At most 20 groups. No analyst configured → `{ configured: false, groups: [] }`, never an error |
| `POST /api/admin/people/merge-preview` | 🔒ᴬ | `{ ids[≥2] }` → `{ available, name?, aka? }` — the same reading for rows an admin selected by hand, so the merge dialog opens tidy (11 §11.12a). `404 PERSON_NOT_FOUND` for an id that is not a living person; `available: false` when the analyst is unconfigured or its answer did not parse — the dialog then falls back to the raw prefill |
| `DELETE /api/admin/people/:id` | 🔒ᴬ | soft delete; the links on existing documents stay |

### Subjects
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/subjects` | 🔒 | one page of the catalogue with a document count each, by name (§7.1, SEC-56). Each row carries `kindId` and the kind's `name`, because every screen that shows a subject shows both halves |
| `POST /api/subjects` | 🔒 | `{ kindId, name, note? }` → `SubjectDto`; `409 SUBJECT_EXISTS` on a living `(kindId, name)`, `404 SUBJECT_KIND_NOT_FOUND` for a kind that is not in the catalogue. Open to any signed-in caller (03 §3.3.20) |
| `PATCH /api/admin/subjects/:id` | 🔒ᴬ | `{ kindId?, name?, note? }` — moving a thing to another kind is an ordinary correction |
| `POST /api/admin/subjects/merge` | 🔒ᴬ | `{ ids[≥2], kindId, name, note? }` → the surviving `SubjectDto`; same rules as the people merge, plus the kind the survivor is filed under, since the merged rows may disagree about it (03 §3.3.20) |
| `GET /api/admin/subjects/merge-suggestions` | 🔒ᴬ | → `{ configured, groups: [{ ids[≥2], name, kindId, aka[] }], placeholders: [id] }` — the analyst's reading of the things catalogue (05 §5.6c), kind-aware: a group may fold rows across duplicate kinds, and `kindId` is the kind the survivor keeps, always one the merged rows already have. `placeholders` are rows whose name is a kind rather than a thing, offered for deletion. Same terms as the people endpoint: computed on request, cached in-process, nothing stored, `configured: false` without an analyst |
| `POST /api/admin/subjects/merge-preview` | 🔒ᴬ | `{ ids[≥2] }` → `{ available, name?, kindId?, aka? }` — the tidy reading for a hand-picked selection, the kind included (11 §11.12a). `404 SUBJECT_NOT_FOUND` for an id that is not a living thing; `available: false` degrades to the raw prefill |
| `DELETE /api/admin/subjects/:id` | 🔒ᴬ | soft delete; the links on existing documents stay |

### Subject kinds
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/subject-kinds` | 🔒 | one page of the catalogue by name, each with how many things it holds and how many documents they are on (§7.1, SEC-56) |
| `POST /api/subject-kinds` | 🔒 | `{ name, note? }` → `SubjectKindDto`; stored as typed, in any language and any case, unique case-insensitively; `409 SUBJECT_KIND_EXISTS`. Open to any signed-in caller, like people and subjects (03 §3.3.20a) |
| `PATCH /api/admin/subject-kinds/:id` | 🔒ᴬ | `{ name?, note? }` — one edit renames every thing filed under it |
| `POST /api/admin/subject-kinds/merge` | 🔒ᴬ | `{ ids[≥2], name, note? }` → the surviving `SubjectKindDto`. The oldest kind survives, takes the name, and receives every subject the others held; things two merged kinds both held under one folded name are folded too — links moved, duplicates collapsed, latecomers soft-deleted — all in one transaction (03 §3.3.20a). `409 SUBJECT_KIND_EXISTS` when the chosen name belongs to a kind outside the merge |
| `GET /api/admin/subject-kinds/merge-suggestions` | 🔒ᴬ | → `{ configured, groups: [{ ids[≥2], name, aka[] }] }` — the analyst's reading of the kinds catalogue (05 §5.6c), on the people endpoint's terms |
| `POST /api/admin/subject-kinds/merge-preview` | 🔒ᴬ | `{ ids[≥2] }` → `{ available, name?, aka? }`; `404 SUBJECT_KIND_NOT_FOUND` for an id that is not a living kind |
| `DELETE /api/admin/subject-kinds/:id` | 🔒ᴬ | soft delete; 🔒 `409 SUBJECT_KIND_IN_USE` while a living subject still files under it |

### Document types
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/document-types` | 🔒 | active, sorted by name |
| `POST /api/admin/document-types` | 🔒ᴬ | `{ slug, name, description? }` |
| `PATCH /api/admin/document-types/:id` | 🔒ᴬ | `{ name?, description? }` (slug immutable) |
| `DELETE /api/admin/document-types/:id` | 🔒ᴬ | soft delete; resets documents to NONE |

### Collections & sharing
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/collections` | 🔒 | own + shared-with-me (flag `sharedByMe`/`sharedWithMe`), sorted by name |
| `POST /api/collections` | 🔒 | `{ name, description? }` |
| `GET /api/collections/:id` | 🔒 | canReadCollection; items = documents the caller can read (03 §3.3.14), paginated |
| `PATCH /api/collections/:id` | 🔒 owner | `{ name?, description? }` |
| `DELETE /api/collections/:id` | 🔒 owner | soft delete |
| `POST /api/collections/:id/items` | 🔒 owner | `{ documentId }` |
| `DELETE /api/collections/:id/items/:documentId` | 🔒 owner | |
| `GET /api/collections/:id/shares` | 🔒 owner | |
| `POST /api/collections/:id/shares` | 🔒 owner | `{ granteeUserId: uuid \| null }` (null = whole instance) |
| `DELETE /api/collections/:id/shares/:shareId` | 🔒 owner | revoke |
| `GET /api/users/lookup?q=` | 🔒 | minimal directory for the share picker: `[{ id, displayName, email }]`, max 10, active users only |

### Document files

A document is an ordered list of files (`03 §3.3.10`, `05 §5.6`). Every route below changes the
composition and therefore enqueues a canonical rebuild + the rest of the pipeline; all of them
answer with the whole `DocumentDetailDto`, because a composition change is never local.

| Method & path | Auth | Notes |
|---------------|------|-------|
| `POST /api/documents/:id/files` | 🔒 canEdit | the file **is** the body (as `POST /api/documents`, and exempt from the body parsers on the same terms — `05 §5.1a`), name in `X-Legere-Filename` (`X-File-Name` is accepted too); appended last. `413` over `UPLOAD_MAX_BYTES`, `409 FILE_ALREADY_IN_DOCUMENT` when those bytes already live in another document |
| `PATCH /api/documents/:id/files` | 🔒 canEdit | `{ order: [fileId, ...] }` — the complete order, every file exactly once (`422 VALIDATION_FAILED` otherwise) |
| `PATCH /api/documents/:id/files/:fileId` | 🔒 canEdit | `{ crop?: { points: [[x,y] ×4] } \| null, pageOrder?: number[] \| null }` — what one file says about itself. At least one of the two keys, or `422 VALIDATION_FAILED`: a PATCH that changes nothing is not an edit. In practice a body names one of them, because the two never apply to the same file — only an image is cropped, only a PDF has pages to order. **`crop`**: normalized `0…1`, clockwise from top-left; `null` clears it; `422 FILE_NOT_IMAGE` for anything but an image. **`pageOrder`**: the complete order of that file's pages, sent whole as a file reorder is (`03 §3.3.16`) — every 0-based index of the file exactly once, at most 2000 of them, checked against the page count the last canonical build recorded; `422 FILE_NOT_PDF` for anything but a PDF, and `422 VALIDATION_FAILED` for a list that is not a permutation of exactly that file's pages or for a file whose pages no build has counted yet. `null` restores the order the file arrived in. Saving either enqueues the rebuild every composition change enqueues (`05 §5.6`), once |
| `POST /api/documents/:id/files/:fileId/replacement` | 🔒 canEdit | **replace**: the body is the new file, on the same terms as `POST /api/documents/:id/files` above, and it takes the named file's **position** → the whole `DocumentDetailDto`. The file it replaces goes to the trash with `REPLACED` (`05 §5.6`, `05 §5.7a`) and stays listed under its successor as an earlier version. `409 FILE_ALREADY_IN_DOCUMENT` when the new bytes are a live file of another document; bytes that are an earlier version of this same file are taken back out of the trash rather than refused |
| `DELETE /api/documents/:id/files/:fileId` | 🔒 canEdit | **split**: the file leaves and becomes its own document → `{ document, splitDocumentId }`. `409 DOCUMENT_LAST_FILE` when it is the only one |
| `GET /api/documents/:id/files/:fileId/crop-suggestion` | 🔒 | edge detection over the image → `{ crop: { points }, method: 'EDGES' \| 'CONTENT_BOX' }`. A proposal; nothing is stored until the client saves it (`05 §5.6`) |
| `GET /api/documents/:id/files/:fileId/content` | 🔒 | the original bytes of one file: streamed from the volume, or 302 to a signed URL for a managed file. `409 DOCUMENT_UNAVAILABLE` when the volume no longer has it |
| `GET /api/documents/:id/files/:fileId/pages/:page/thumb` | 🔒 | 302 → signed URL of a small JPG of one page of the **original** file — the pages as they arrived, which is what somebody putting them in order looks at (`11 §11.5a`). `:page` is 0-based, the way `pageOrder` counts (`03 §3.3.16`). Rendered on the first request and kept in the bucket under `files/{fileId}/pages/{n}.jpg` (`09 §9.2`); every request after that is a redirect to the object, and it may be cached for as long as anybody likes, because file bytes are immutable. `422 FILE_NOT_PDF` for a file that has no pages, `404 NOT_FOUND` for a page beyond the count the last canonical build recorded — including every page of a file no build has opened yet, since nothing yet says how many there are. 🔒 Behind the same access guard as the file's own content: it is the same bytes, one page at a time |
| `POST /api/documents/:id/combine` | 🔒 canEdit | `{ documentIds: [uuid, ...] }` (1…50, the caller must be able to edit each) — their files are appended in that order and the emptied documents are soft-deleted |
| `GET /api/documents/grouping-suggestions` | 🔒 | `{ items: [{ documentIds, libraryId, libraryName, folder, reason }] }` — single-file image documents that look like one document (`05 §5.6a`), newest first, max 20 groups. Computed, never stored |

### The pipeline, as everybody sees it

One route, and it is not an admin's: which steps of `05 §5.5` this instance is holding (`05 §5.4d`).
A step that reads `PENDING` for ever is either waiting for a worker or paused, and whoever opened the
document is owed the difference — so the fact is published to every signed-in caller rather than kept
behind `/api/admin`. Nothing else about the queue is here: no depths, no concurrencies, no gates.

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/pipeline/paused-steps` | 🔒 | → `{ pausedSteps: ('canonical'\|'preview'\|'markdown'\|'analysis'\|'fields'\|'vectorization')[] }` — the stored list, in pipeline order, empty on an instance that holds nothing (which is every instance until somebody says otherwise). The same list an admin sets through `PATCH /api/admin/queue/settings` |

### Admin: queue
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/queue/overview` | 🔒ᴬ | per queue: `{ name, queued, active, failedRecent }` + document step counters + `gates: [{ service, inFlight, waiting, longestWaitMs }]` + `storage: { objects, bytes, measuredAt } \| null` + `vectors: { chunks, byModel: [{ model, chunks }] }` — how many chunks the archive holds and which embedder made them (`03 §3.3.11`). One grouped count, on the same 5-second clock as the rest; `byModel` with more than one row is a model switch that has not finished, which is the one state where semantic distances mean nothing (`04 §4.5`), and a chunk written before the column existed answers `null` for its model (hourly aggregate, `null` before the first `maintenance` run). `gates` is what each gate of `05 §5.4b` is doing this instant — read off the in-process semaphore, one row per service in the order `SERVICE_NAMES` gives, `longestWaitMs` being how long the caller at the front of the queue has been standing there (`0` when nobody is). It rides in the overview because it belongs to the same 5-second clock as the counters, and deliberately **not** in `/services`, whose answer is a cached probe of somebody else's container (§7.3 below) |
| `GET /api/admin/queue/failures` | 🔒ᴬ | paginated failed jobs: `{ jobId, queue, payload, error, failedAt, retryCount }`, newest first; `cursor` is the `failedAt` of the last row and is validated as a timestamp (§7.1) |
| `POST /api/admin/queue/failures/:jobId/retry` | 🔒ᴬ | re-enqueues a copy of the job → `{ ok: true }` |
| `GET /api/admin/queue/settings` | 🔒ᴬ | → `{ concurrency: { <queue>: number }, unitConcurrency, paused, pausedSteps, services: { <service>: { concurrency, cooldownSeconds } } }` — every queue and every gated service, with the env defaults where nothing is stored, and where what is stored reads as a number outside its range: a row written by another version of this code is not trusted into the workers (03 §3.3.21) |
| `PATCH /api/admin/queue/settings` | 🔒ᴬ | the same shape, sent whole; a value outside its range is **refused** (`422 VALIDATION_FAILED`) rather than quietly bent to fit — 1…32 for a queue concurrency and for `unitConcurrency` — and the workers are re-registered immediately so the change needs no restart. `paused` is the list of queues whose workers are not registered at all: jobs still arrive and wait, nothing consumes them (05 §5.4). `pausedSteps` is the same idea one level down (05 §5.4d) — the steps of `05 §5.5` that no job runs, held at `PENDING` with nothing written against them, with a step name this version does not know dropped the way an unknown queue name is. It needs no re-registration, being read per job; **releasing a step enqueues what it was holding** — that step for the documents whose it is `PENDING`, newest first, at most `QUEUE_REPROCESS_MAX` a call, the same work `POST /api/admin/queue/reprocess` does — and the hourly sweep takes whatever the bound left behind. `services` carries the same kind of override for the five gated services of `05 §5.4b` — `stirling`, `docling`, `classifier`, `transcriber`, `embeddings`, keyed the way the environment names them rather than the way the pipeline names its steps — with `concurrency` bounded to `0`…32 (`0` = ungated, and the default) and `cooldownSeconds` to 0…600, refused on exactly the terms the knobs beside them are; a service name this version does not know is dropped rather than refused, as an unknown queue name is, and a gate changes for the callers already waiting at it no later than their next acquisition, so it needs a restart no more than a concurrency does |
| `GET /api/admin/queue/services` | 🔒ᴬ | → `{ services: [{ service, url, status, httpStatus, latencyMs, checkedAt, detail }] }` — one row per gated service of `05 §5.4b`, in that order, saying where this instance calls it and whether it answered: `url` is the resolved base URL with any userinfo stripped (`''` where none is configured), `status` one of `UP` / `UNAUTHORIZED` / `ANSWERED` / `DOWN` / `NOT_CONFIGURED` per `05 §5.4c`, `httpStatus` the code where there was one, `latencyMs` how long the probe took, `checkedAt` when it was taken and `detail` a short truncated reason where there is one to give. The probe runs outside the queues and outside the gates — "everything is stuck" is when this is asked — under its own timeout, all five in parallel, and the answer is cached for a few seconds so reloading tabs do not multiply traffic to a container that may already be struggling; a cached answer is visible as one through `checkedAt`. 🔒 No secret is in this answer: an API key is not published, not even in part |
| `POST /api/admin/queue/reprocess` | 🔒ᴬ | `{ step?, status? }` → `{ enqueued: number }`. Each absence widens the question by a level: both — the documents whose named step sits in that status; `step` alone — that step whatever state it is in; neither — the whole pipeline of every document, which is the same work the button on one document's own page asks for. Re-enqueues `document-process` for every document whose named step sits in that status, newest first, at most `QUEUE_REPROCESS_MAX` (default 500) a call — the answer to "the previews failed, run them again" without opening five hundred documents. A **paused** step (`05 §5.4d`) is not run here either: naming one is `409 STEPS_PAUSED`, and the widest question — the whole pipeline of every document — enqueues the documents and lets the handler hold the paused steps inside each of them |

### Admin: the trash

Every file that leaves a document lands here rather than being destroyed (`05 §5.7a`). An admin's,
because everything on it either destroys bytes or creates a document.

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/trash` | 🔒ᴬ | paginated, newest first → `{ items: TrashItemDto[], nextCursor, total: { items, bytes } }`. The total is the whole trash and not the page: "what is this costing me" is the question the screen exists for. `cursor` is the `trashedAt` of the last row (§7.1) |
| `DELETE /api/admin/trash/:fileId` | 🔒ᴬ | deletes one item for good → `{ ok: true }`: the row goes, a `MANAGED` file's object with it, and a `LIBRARY` file's `FileRef`s are left `EXCLUDED` so the scan does not ingest those bytes again (03 §3.3.9). The bytes on a volume are not touched — Legere may not (ADR-007) |
| `DELETE /api/admin/trash` | 🔒ᴬ | the same for everything in it → `{ deleted: number }`. Not "empty what is due", but everything: the retention window says when an item goes at the latest, and this is a person saying "now" |
| `GET /api/admin/trash/:fileId/content` | 🔒ᴬ | the bytes of one item: streamed from the volume, or 302 to a signed URL for a file of ours — the same two answers `…/files/:fileId/content` gives, and it exists because that route needs a document and a trashed file has none. Getting a scan back out is often all somebody wants, and it does not require restoring it first. `409 DOCUMENT_UNAVAILABLE` when the volume no longer has it |
| `POST /api/admin/trash/:fileId/restore` | 🔒ᴬ | the file becomes a **new** document holding exactly it, titled after the file and processed from scratch → `{ documentId }`. It does not return to the document it came from, which has moved on or does not exist (`05 §5.7a`). `409 FILE_ALREADY_IN_DOCUMENT` if those bytes found a home in the meantime |

`TrashItemDto` = `{ id, name, mimeType, ext, sizeBytes, origin, available, reason, trashedAt,
trashedFrom, purgeAfter, refs: DocumentFileRef[], storageKey }`. `purgeAfter` is the ISO instant the
sweep will delete it — `null` for a `LIBRARY` file, which no sweep will ever delete and which says so
in as many words rather than showing a date that will never arrive.

### Admin: the instance itself

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/instance` | 🔒ᴬ | the effective configuration, grouped, as the process actually resolved it: `{ groups: [{ key, settings: [{ key, value, source, consequence }] }] }`. 🔒 **A secret is never a value here** — a password, an API key, a token or a secret key appears as `source: 'SET'` with no value, or `'UNSET'`; everything else carries what it resolved to, with `source: 'ENV'` when the environment set it and `'DEFAULT'` when nothing did. `DATABASE_URL` is decomposed into host, port, database and user, and its password is not one of them. `consequence` says what a value nobody set costs, and travels as an UPPER_SNAKE token the client localizes (`EMAIL_UNDELIVERABLE`, `ANALYSIS_SKIPPED_NO_PROVIDER`, …) — never as prose, which would arrive in one language on a page rendered in another; `null` where a blank costs nothing |

### Health
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/health` | — | `{ status, db, queue }`; 503 on failure. Not rate-limited |

## 7.3a. MCP — the archive as a tool set (`POST /api/mcp`)

One route, so an assistant can be pointed at this instance and search it (ADR-024). **JSON-RPC 2.0
over a single POST** — the Model Context Protocol's HTTP transport in its simplest honest form: a
JSON request, a JSON response, no SSE stream, no session id, nothing kept between calls.

| Method | Answer |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'legere', version } }`. The client's `protocolVersion` is echoed when this server knows it and the server's own is answered when it does not — the client then decides whether it can live with that |
| `notifications/initialized` | nothing: a notification has no `id`, so the route answers `202` with an empty body, as every notification does |
| `ping` | `{}` |
| `tools/list` | the three tools below, each with its JSON Schema |
| `tools/call` | `{ content: [{ type: 'text', text }], isError? }` — the tool's answer as one JSON text block, which is what a model reads best |

🔒 **The credential is a read-only API token and nothing else** (`08 §8.2a`): `Authorization: Bearer
legere_…`. A session cookie is refused here even when it is valid, which is what keeps the CSRF rule
of `08 §8.4` intact rather than excepted — a browser cannot be induced into a call whose only
credential it does not hold. The caller is the token's owner: every tool runs under that person's
access rule, so an assistant sees exactly the archive its owner sees, and a document in a library
they were never granted does not exist for it.

**The tools**, a closed list over read use cases:

| Tool | Input | What it answers |
|---|---|---|
| `search_documents` | `{ query, mode?: hybrid\|text\|semantic, limit?: 1…20 }` | the hybrid search of §7.3, as JSON rows: `id`, `title`, `documentType`, `documentDate`, `place`, `snippet` (the `<mark>` stripped — a model does not read markup), `matchedIn` (why the row is here) and `url`, so an answer can cite the document rather than describe it |
| `get_document` | `{ documentId }` | what the archive knows about one document: title, description, type, date, place, people, subjects, languages, pages, files, availability, whether it has text at all, and its `url` |
| `read_document` | `{ documentId, offset?, limit?: 1…50 000 }` | the extracted Markdown, **in slices**: a forty-page scan is a quarter of a million characters and a context window is not, so the answer carries `totalChars` and `nextOffset` and the caller asks again. 🔒 The `text` arrives between two lines carrying a per-call nonce, beside a `notice` naming them: the document's words are **data for the calling model, never instructions** — the same declaration this repository makes to its own analyst about this same text (SEC-72) |

A tool that fails answers `isError: true` with the reason as text, because a model recovers from a
sentence and not from a transport error. Everything that is not a tool's business is JSON-RPC:
`-32700` for unparsable JSON, `-32600` for a request that is not one (a batch among them — this
protocol version has none), `-32601` for an unknown method, `-32602` for parameters that do not fit
the tool's schema.

## 7.4. DTO serialization

- Persisted "no value" is `null` (Zod `.nullable()`); `undefined`/absent fields are allowed only in
  **request** payloads (Zod `.optional()`). Mappers convert `undefined → null` explicitly.
- `BigInt` → decimal string. Dates → ISO 8601 UTC strings.
- Secrets (`passwordHash`, any `tokenHash`, codes, tickets) never appear in any DTO. Invite/reset
  URLs appear exactly once, in the creating response.
- Enum values pass through as UPPER_SNAKE strings and are typed in contracts.

## 7.5. Contracts package layout

`src/shared/contracts/` — one file per resource (`auth.ts`, `users.ts`, `libraries.ts`,
`documents.ts`, `files.ts`, `search.ts`, `document types.ts`, `collections.ts`, `queue.ts`,
`common.ts` — envelope, pagination, error codes enum, shared enums). Each file exports request
schemas, response schemas, and inferred types. The server validates requests with them; the client
validates responses with them (fail loudly on drift).

## 7.6. Open questions

None.
