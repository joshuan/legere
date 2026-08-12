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
| 404 | `USER_NOT_FOUND`, `LIBRARY_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_TYPE_NOT_FOUND`, `COLLECTION_NOT_FOUND`, `FILE_NOT_FOUND`, `INVITE_NOT_FOUND`, `API_TOKEN_NOT_FOUND`, `SESSION_NOT_FOUND` | resource lookups (incl. soft-deleted); a session belonging to somebody else is *not found* rather than forbidden ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)) |
| 409 | `EMAIL_ALREADY_REGISTERED` | registration race |
| 409 | `LAST_ADMIN` | demote/deactivate/delete last admin |
| 409 | `DOCUMENT_DUPLICATE` | upload whose content already exists as a document the caller may not read |
| 409 | `LIBRARY_PATH_CONFLICT` | nested/duplicate library path |
| 409 | `DOCUMENT_TYPE_SLUG_TAKEN`, `COLLECTION_NAME_TAKEN` | uniqueness |
| 409 | `DOCUMENT_LAST_FILE` | removing the only file of a document |
| 409 | `FILE_ALREADY_IN_DOCUMENT` | attaching a file that already belongs to a document |
| 409 | `CANONICAL_NOT_READY` | the canonical PDF has not been built yet |
| 409 | `DOCUMENT_UNAVAILABLE` | source download when all refs MISSING |
| 410 | `ONBOARDING_CLOSED` | onboarding after first user exists |
| 422 | `VALIDATION_FAILED` | Zod failure (`details.issues`) — including the timestamp cursor of `GET /api/admin/queue/failures` (§7.1) |
| 422 | `CURSOR_SORT_MISMATCH` | a cursor cut from one named order handed to a request asking for another (§7.1) |
| 422 | `LIBRARY_PATH_INVALID` | path outside root / not a directory |
| 422 | `FILE_NOT_IMAGE` | cropping something that is not an image |
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
| `POST /api/documents` | 🔒 | **upload**: the file as the raw request body, its name in `X-Legere-Filename` (RFC 5987 or plain). Mime detected from content; `UPLOAD_MAX_BYTES` cap → 413. Deduplicated by **file** (ADR-009, ADR-021): bytes that are already a file resolve to that file's document when the caller may read it (`200`), and to `409 DOCUMENT_DUPLICATE` when they may not. Otherwise `201` with a new document holding the new file, processing already enqueued |
| `GET /api/documents` | 🔒 | paginated; `sort?` = `documentDate` (default) \| `createdAt` \| `lastEventAt` — the closed set of named orders of §7.1, all three newest-first with the id as the tiebreak (see below); filters: `libraryId?`, `typeId?`, `personId?`, `subjectId?`, `subjectKindId?` (every subject of that kind at once, 03 §3.3.20a), `year?`, `country?` (ISO 3166-1 alpha-2, upper-cased on the way in like the PATCH does, so `?country=me` is the same question), `city?` (matched exactly as stored, which is what a link carrying a document's own place hands over), `availability?` (`AVAILABLE`\|`PARTIAL`\|`UNAVAILABLE`), `processing?` (bool), `origin?` (`LIBRARY`\|`MANAGED`), `unassigned?` (a grouping dimension: the documents that have **no** value in it — no type, no date, nobody named on them; a question no uuid filter has room to ask, and the one a grouped grid needs for its last section, `11 §11.3`), `step?` + `stepStatus?` (given together: the documents whose named pipeline step sits in that status — what a queue counter links to, 11 §11.13); only documents the caller can read. Every one of them is what a name in the viewer's details pane links to (11 §11.5); `subjectId` and `subjectKindId` given together are one question and not two — a kind with a thing of another kind finds nothing |
| `GET /api/documents/years` | 🔒 | `{ items: [{ year, count }] }`, newest first — the years the caller's documents carry (11 §11.4). Declared before `:id`, or the router reads "years" as a document id
| `GET /api/documents/groups?by=` | 🔒 | `{ items: [{ key, label, count }] }`, where a `key` of `null` is the group of documents that have **no** value in that dimension — last, and outside the cap, because dropping it would take those documents off the screen rather than off a shelf (`11 §11.3`); its contents are this list with `unassigned=<dimension>` — the shelves of one dimension under the filters in force (see below). `by` = `type`\|`person`\|`subject`\|`year`\|`country`\|`city`; takes **every filter `GET /api/documents` takes** and no pagination. Declared before `:id`, like the years |
| `GET /api/documents/:id` | 🔒 | → `DocumentDetailDto`, including `skipReasons`, `pageFormat`, `titleSource` and `auto` — what the pipeline decided before anybody corrected it, `auto.textQuality` among it (03 §3.3.10) |
| `PATCH /api/documents/:id` | 🔒 | `{ title?, description?, languages?, country?, city?, typeId?, peopleIds?, subjectIds?, documentDate?, pageFormat? }` per canEditDocumentMeta (03 §3.4); setting typeId flips `typeSource` to MANUAL (null → NONE), and setting `title` flips `titleSource` to MANUAL, after which no analysis renames the document. `languages` are BCP-47 tags, `country` ISO 3166-1 alpha-2 (upper-cased on the way in), `city` free text; all three are corrections of what detection guessed (03 §3.3.10). `reset: ('title'\|'description'\|'documentType'\|'languages'\|'country'\|'city'\|'documentDate')[]` puts fields back to what the pipeline read and, for the title and the document type, restores `AUTO` — it is applied after the explicit values, so a payload carrying both ends with the reset. `pageFormat` is the one field here that is not a correction to a record but an instruction for the next build: it is stored, and **nothing is enqueued**. The shape of a page is decided while the page is being made (`05 §5.5` step 1), so the pages keep the shape they have until the canonical is built again — which is what `POST /api/documents/:id/reprocess` is for. 🔒 A metadata edit may not start a rebuild of the whole document: somebody who picked A4 out of a select asked for the field to say A4, not for forty pages to be remade, their text recognised afresh and every artifact derived from them replaced. So the format travels with the same PATCH as the city, and the rebuild is asked for separately and on purpose |
| `DELETE /api/documents/:id` | 🔒ᴬ | soft delete |
| `POST /api/documents/:id/reprocess` | 🔒ᴬ | `{ steps?: ('canonical'\|'preview'\|'markdown'\|'analysis'\|'vectorization')[], analyseInFull?: boolean }` → re-enqueues `document-process`. `analyseInFull` asks for this one document to be analysed however long it is: the page limit of `05 §5.5` step 4 is on what the pipeline does unasked, and this is the asking. Per document on purpose — a limit any bulk re-run could lift would not be a limit |
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

`DocumentListDto`: `{ id, title, fileCount, primaryExt, sizeBytes(string, the files together), pageCount, documentType: {id,slug,name}|null, availability, processing, origin, hasPreview, createdAt, documentDate, people: {id,name}[], subjects: {id,name}[], country, city, languages }`.
The last six are **what a card may show** (`11 §11.3`): they travel on every row of every page whether
or not the screen draws them, because which of them appear is the reader's choice and lives in their
URL rather than in the request. They cost the page two more queries and not one per card — the people
and the subjects of `document_id IN (…)`, both index-served by the link tables' own primary keys
(`04 §4.4`).
`DocumentDetailDto` = list dto + `{ ocrUsed, pageFormat, titleSource, typeSource, steps: {canonical, preview, markdown, analysis, vectorization}, skipReasons, processingError, failedStep, createdBy?, files: DocumentFileDto[], people: {id,name,deleted}[], subjects: {id,kindId,kind,name,deleted}[], description, auto }`. The people and subjects are the list's own, said more fully: `deleted` says the catalogue no longer holds that name — the link survives a deletion on purpose (03 §3.3.19), so the flag is the only thing that distinguishes a name still worth choosing from one kept as a record, and it is on the detail because that is where a name can still be chosen. A subject carries its kind by id as well as by name, because the kind is a row of its own (03 §3.3.20a) and each half is a way into the documents filed under it (11 §11.5).

`DocumentFileDto` = `{ id, position, name, mimeType, ext, sizeBytes, origin: 'LIBRARY' | 'MANAGED', available: boolean, crop: { points: [[x,y] ×4] } | null, cropSource: 'NONE' | 'AUTO' | 'MANUAL', isImage, refs: [{ libraryId, libraryName, path, status }], storageKey: string | null }` — ordered by position; `refs` lists only libraries visible to the caller (ADMIN sees all) and is empty for a managed file. **A location is answered for every file**, and the two fields divide it: `refs` for bytes on a volume, `storageKey` for the object in the bucket a `MANAGED` file's bytes lie under (`09 §9.2`), null for a `LIBRARY` file, which has no object at all. 🔒 The key is a location and not a way in — the bucket is private and only a signed URL reads it, issued by an endpoint that has already passed the access check — and it discloses nothing new either: the layout is `files/{fileId}/original.{ext}` and both halves are already on this DTO.

### Search
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/search?q=&mode=&limit=&libraryId?=&typeId?=` | 🔒 | `mode`: `hybrid` (default) \| `text` \| `semantic`. → `{ items: [{ document: DocumentListDto, score, snippet }], semanticAvailable: boolean }`. Text: FTS `websearch_to_tsquery('simple')` over `search_vector`, snippet via `ts_headline`. Semantic: embed `q`, top-k chunks by cosine, group by document (best chunk wins; snippet = chunk excerpt). Hybrid: Reciprocal Rank Fusion (k = 60) over both lists. Access filter applied **in SQL** before limit. Provider unconfigured → `semanticAvailable: false`, hybrid silently = text |

### People
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/people` | 🔒 | the catalogue with a document count each, by name |
| `POST /api/people` | 🔒 | `{ name, note? }` → `PersonDto`; `409 PERSON_EXISTS` on a name that already lives. Open to any signed-in caller (03 §3.3.19) |
| `PATCH /api/admin/people/:id` | 🔒ᴬ | `{ name?, note? }` |
| `POST /api/admin/people/merge` | 🔒ᴬ | `{ ids[≥2], name, note? }` → the surviving `PersonDto`. The oldest of the rows survives, takes the name, and receives every document link the others had (duplicates collapsed); the rest are soft-deleted, all in one transaction. `409 PERSON_EXISTS` when the chosen name belongs to somebody outside the merge (03 §3.3.19) |
| `DELETE /api/admin/people/:id` | 🔒ᴬ | soft delete; the links on existing documents stay |

### Subjects
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/subjects` | 🔒 | the catalogue with a document count each, by kind then name. Each row carries `kindId` and the kind's `name`, because every screen that shows a subject shows both halves |
| `POST /api/subjects` | 🔒 | `{ kindId, name, note? }` → `SubjectDto`; `409 SUBJECT_EXISTS` on a living `(kindId, name)`, `404 SUBJECT_KIND_NOT_FOUND` for a kind that is not in the catalogue. Open to any signed-in caller (03 §3.3.20) |
| `PATCH /api/admin/subjects/:id` | 🔒ᴬ | `{ kindId?, name?, note? }` — moving a thing to another kind is an ordinary correction |
| `POST /api/admin/subjects/merge` | 🔒ᴬ | `{ ids[≥2], kindId, name, note? }` → the surviving `SubjectDto`; same rules as the people merge, plus the kind the survivor is filed under, since the merged rows may disagree about it (03 §3.3.20) |
| `DELETE /api/admin/subjects/:id` | 🔒ᴬ | soft delete; the links on existing documents stay |

### Subject kinds
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/subject-kinds` | 🔒 | the catalogue by name, each with how many things it holds and how many documents they are on |
| `POST /api/subject-kinds` | 🔒 | `{ name, note? }` → `SubjectKindDto`; stored as typed, in any language and any case, unique case-insensitively; `409 SUBJECT_KIND_EXISTS`. Open to any signed-in caller, like people and subjects (03 §3.3.20a) |
| `PATCH /api/admin/subject-kinds/:id` | 🔒ᴬ | `{ name?, note? }` — one edit renames every thing filed under it |
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
| `PATCH /api/documents/:id/files/:fileId` | 🔒 canEdit | `{ crop: { points: [[x,y] ×4] } \| null }` — normalized `0…1`, clockwise from top-left; `null` clears it. `422 FILE_NOT_IMAGE` for anything but an image |
| `DELETE /api/documents/:id/files/:fileId` | 🔒 canEdit | **split**: the file leaves and becomes its own document → `{ document, splitDocumentId }`. `409 DOCUMENT_LAST_FILE` when it is the only one |
| `GET /api/documents/:id/files/:fileId/crop-suggestion` | 🔒 | edge detection over the image → `{ crop: { points }, method: 'EDGES' \| 'CONTENT_BOX' }`. A proposal; nothing is stored until the client saves it (`05 §5.6`) |
| `GET /api/documents/:id/files/:fileId/content` | 🔒 | the original bytes of one file: streamed from the volume, or 302 to a signed URL for a managed file. `409 DOCUMENT_UNAVAILABLE` when the volume no longer has it |
| `POST /api/documents/:id/combine` | 🔒 canEdit | `{ documentIds: [uuid, ...] }` (1…50, the caller must be able to edit each) — their files are appended in that order and the emptied documents are soft-deleted |
| `GET /api/documents/grouping-suggestions` | 🔒 | `{ items: [{ documentIds, libraryId, libraryName, folder, reason }] }` — single-file image documents that look like one document (`05 §5.6a`), newest first, max 20 groups. Computed, never stored |

### Admin: queue
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/queue/overview` | 🔒ᴬ | per queue: `{ name, queued, active, failedRecent }` + document step counters + `storage: { objects, bytes, measuredAt } \| null` (hourly aggregate, `null` before the first `maintenance` run) |
| `GET /api/admin/queue/failures` | 🔒ᴬ | paginated failed jobs: `{ jobId, queue, payload, error, failedAt, retryCount }`, newest first; `cursor` is the `failedAt` of the last row and is validated as a timestamp (§7.1) |
| `POST /api/admin/queue/failures/:jobId/retry` | 🔒ᴬ | re-enqueues a copy of the job → `{ ok: true }` |
| `GET /api/admin/queue/settings` | 🔒ᴬ | → `{ concurrency: { <queue>: number }, unitConcurrency }` — every queue, with the env defaults where nothing is stored (03 §3.3.21) |
| `PATCH /api/admin/queue/settings` | 🔒ᴬ | the same shape, sent whole; values are clamped to 1…32 rather than refused, and the workers are re-registered immediately so the change needs no restart. `paused` is the list of queues whose workers are not registered at all: jobs still arrive and wait, nothing consumes them (05 §5.4) |
| `POST /api/admin/queue/reprocess` | 🔒ᴬ | `{ step?, status? }` → `{ enqueued: number }`. Each absence widens the question by a level: both — the documents whose named step sits in that status; `step` alone — that step whatever state it is in; neither — the whole pipeline of every document, which is the same work the button on one document's own page asks for. Re-enqueues `document-process` for every document whose named step sits in that status, newest first, at most `QUEUE_REPROCESS_MAX` (default 500) a call — the answer to "the previews failed, run them again" without opening five hundred documents |

### Admin: the instance itself

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/instance` | 🔒ᴬ | the effective configuration, grouped, as the process actually resolved it: `{ groups: [{ key, settings: [{ key, value, source, consequence }] }] }`. 🔒 **A secret is never a value here** — a password, an API key, a token or a secret key appears as `source: 'SET'` with no value, or `'UNSET'`; everything else carries what it resolved to, with `source: 'ENV'` when the environment set it and `'DEFAULT'` when nothing did. `DATABASE_URL` is decomposed into host, port, database and user, and its password is not one of them. `consequence` says what a value nobody set costs, and travels as an UPPER_SNAKE token the client localizes (`EMAIL_UNDELIVERABLE`, `ANALYSIS_SKIPPED_NO_PROVIDER`, …) — never as prose, which would arrive in one language on a page rendered in another; `null` where a blank costs nothing |

### Health
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/health` | — | `{ status, db, queue }`; 503 on failure. Not rate-limited |

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
