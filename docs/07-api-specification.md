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
  response `{ data: { items: [...], nextCursor: string | null } }`. Sorting is fixed per endpoint
  (documented below); no arbitrary sort params in MVP.
- **IDs** are UUIDs in paths. Path params are validated; malformed UUID → 404 (not 422).

## 7.2. Error codes

| HTTP | Code | Where |
|------|------|-------|
| 401 | `UNAUTHENTICATED` | no/invalid session |
| 401 | `INVALID_CREDENTIALS` | login |
| 403 | `FORBIDDEN` | authz failure, CSRF failure, deactivated user |
| 403 | `READ_ONLY_TOKEN` | a mutating request carrying an `Authorization: Bearer` header ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)) |
| 404 | `NOT_FOUND` | unknown route/malformed id |
| 404 | `USER_NOT_FOUND`, `LIBRARY_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_TYPE_NOT_FOUND`, `COLLECTION_NOT_FOUND`, `FILE_NOT_FOUND`, `INVITE_NOT_FOUND`, `API_TOKEN_NOT_FOUND` | resource lookups (incl. soft-deleted) |
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
| 422 | `VALIDATION_FAILED` | Zod failure (`details.issues`) |
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
| `GET /api/me/api-tokens` | 🔒 | own tokens, newest first; usable ones and the recently dead alike, never a secret → `{ items: ApiTokenDto[] }` |
| `POST /api/me/api-tokens` | 🔒 | `{ name, expiresInDays? }` (1…365, default `API_TOKEN_TTL_DAYS`) → `{ token, apiToken: ApiTokenDto }` — `token` appears in this response and nowhere else |
| `DELETE /api/me/api-tokens/:id` | 🔒 owner | revoke → `{ ok: true }`; already revoked is not an error, `404 API_TOKEN_NOT_FOUND` for somebody else's |

`ApiTokenDto` = `{ id, name, createdAt, expiresAt, lastUsedAt, revokedAt, status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }`.
`status` is derived on read rather than stored, so a token that expired while nobody was looking
reports as expired.

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
| `GET /api/libraries/:id/browse?path=&cursor=` | 🔒 | virtual folder view derived from FileRef paths: `{ path, folders: [{ name, documentCount }], documents: { items: [DocumentListDto], nextCursor } }`; folders sorted by name, documents by title |

### Documents
| Method & path | Auth | Notes |
|---------------|------|-------|
| `POST /api/documents` | 🔒 | **upload**: the file as the raw request body, its name in `X-Legere-Filename` (RFC 5987 or plain). Mime detected from content; `UPLOAD_MAX_BYTES` cap → 413. Deduplicated by **file** (ADR-009, ADR-021): bytes that are already a file resolve to that file's document when the caller may read it (`200`), and to `409 DOCUMENT_DUPLICATE` when they may not. Otherwise `201` with a new document holding the new file, processing already enqueued |
| `GET /api/documents` | 🔒 | paginated, newest first; filters: `libraryId?`, `typeId?`, `personId?`, `subjectId?`, `year?`, `availability?` (`AVAILABLE`\|`PARTIAL`\|`UNAVAILABLE`), `processing?` (bool), `origin?` (`LIBRARY`\|`MANAGED`), `step?` + `stepStatus?` (given together: the documents whose named pipeline step sits in that status — what a queue counter links to, 11 §11.13); only documents the caller can read |
| `GET /api/documents/years` | 🔒 | `{ items: [{ year, count }] }`, newest first — the years the caller's documents carry (11 §11.4). Declared before `:id`, or the router reads "years" as a document id |
| `GET /api/documents/:id` | 🔒 | → `DocumentDetailDto`, including `auto` — what the pipeline decided before anybody corrected it (03 §3.3.10) |
| `PATCH /api/documents/:id` | 🔒 | `{ title?, description?, languages?, country?, city?, typeId?, peopleIds?, subjectIds?, documentDate? }` per canEditDocumentMeta (03 §3.4); setting typeId flips `typeSource` to MANUAL (null → NONE), and setting `title` flips `titleSource` to MANUAL, after which no analysis renames the document. `languages` are BCP-47 tags, `country` ISO 3166-1 alpha-2 (upper-cased on the way in), `city` free text; all three are corrections of what detection guessed (03 §3.3.10). `reset: ('title'\|'description'\|'documentType'\|'languages'\|'country'\|'city'\|'documentDate')[]` puts fields back to what the pipeline read and, for the title and the document type, restores `AUTO` — it is applied after the explicit values, so a payload carrying both ends with the reset |
| `DELETE /api/documents/:id` | 🔒ᴬ | soft delete |
| `POST /api/documents/:id/reprocess` | 🔒ᴬ | `{ steps?: ('canonical'\|'preview'\|'markdown'\|'analysis'\|'vectorization')[] }` → re-enqueues `document-process` |
| `GET /api/documents/:id/events` | 🔒 | paginated, newest first → `{ items: DocumentEventDto[], nextCursor }` — the document's history (03 §3.3.18). Same access as the document itself |
| `GET /api/documents/:id/markdown` | 🔒 | → `{ markdown: string \| null }` |
| `GET /api/documents/:id/preview` | 🔒 | 302 → signed URL of `preview.jpg` (404 `NOT_FOUND` if step not DONE) |
| `GET /api/documents/:id/thumb` | 🔒 | 302 → signed URL of `thumb.jpg` |
| `GET /api/documents/:id/canonical` | 🔒 | 302 → signed URL of `canonical.pdf`, `Content-Disposition` chosen by `?download=1`. This **is** the document as far as reading and downloading go (`05 §5.5`); `409 CANONICAL_NOT_READY` while the step has not finished. The originals are one level down, under `/files/:fileId/content` |

`DocumentListDto`: `{ id, title, fileCount, primaryExt, sizeBytes(string, the files together), pageCount, documentType: {id,slug,name}|null, availability, processing, origin, hasPreview, createdAt }`.
`DocumentDetailDto` = list dto + `{ ocrUsed, typeSource, steps: {canonical, preview, markdown, analysis, vectorization}, processingError, failedStep, createdBy?, files: DocumentFileDto[], people: {id,name,deleted}[], subjects: {id,kind,name,deleted}[], documentDate, description, country, city, languages, auto }`. `deleted` says the catalogue no longer holds that name: the link survives a deletion on purpose (03 §3.3.19), so the flag is the only thing that distinguishes a name still worth choosing from one kept as a record.

`DocumentFileDto` = `{ id, position, name, mimeType, ext, sizeBytes, origin: 'LIBRARY' | 'MANAGED', available: boolean, crop: { points: [[x,y] ×4] } | null, cropSource: 'NONE' | 'AUTO' | 'MANUAL', isImage, refs: [{ libraryId, libraryName, path, status }] }` — ordered by position; `refs` lists only libraries visible to the caller (ADMIN sees all) and is empty for a managed file.

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
| `POST /api/documents/:id/files` | 🔒 canEdit | the file **is** the body (as `POST /api/documents`), name in `X-Legere-Filename` (`X-File-Name` is accepted too); appended last. `413` over `UPLOAD_MAX_BYTES`, `409 FILE_ALREADY_IN_DOCUMENT` when those bytes already live in another document |
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
| `GET /api/admin/queue/failures` | 🔒ᴬ | paginated failed jobs: `{ jobId, queue, payload, error, failedAt, retryCount }` |
| `POST /api/admin/queue/failures/:jobId/retry` | 🔒ᴬ | re-enqueues a copy of the job → `{ ok: true }` |
| `GET /api/admin/queue/settings` | 🔒ᴬ | → `{ concurrency: { <queue>: number }, unitConcurrency }` — every queue, with the env defaults where nothing is stored (03 §3.3.21) |
| `PATCH /api/admin/queue/settings` | 🔒ᴬ | the same shape, sent whole; values are clamped to 1…32 rather than refused, and the workers are re-registered immediately so the change needs no restart. `paused` is the list of queues whose workers are not registered at all: jobs still arrive and wait, nothing consumes them (05 §5.4) |
| `POST /api/admin/queue/reprocess` | 🔒ᴬ | `{ step, status }` → `{ enqueued: number }`. Re-enqueues `document-process` for every document whose named step sits in that status, newest first, at most `QUEUE_REPROCESS_MAX` (default 500) a call — the answer to "the previews failed, run them again" without opening five hundred documents |

### Admin: the instance itself

| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/instance` | 🔒ᴬ | the effective configuration, grouped, as the process actually resolved it: `{ groups: [{ key, settings: [{ key, value, source, consequence }] }] }`. 🔒 **A secret is never a value here** — a password, an API key, a token or a secret key appears as `source: 'SET'` with no value, or `'UNSET'`; everything else carries what it resolved to, with `source: 'ENV'` when the environment set it and `'DEFAULT'` when nothing did. `DATABASE_URL` is decomposed into host, port, database and user, and its password is not one of them. `consequence` says what a value nobody set costs, and travels as an UPPER_SNAKE token the client localizes (`EMAIL_CODES_TO_LOG`, `ANALYSIS_SKIPPED_NO_PROVIDER`, …) — never as prose, which would arrive in one language on a page rendered in another; `null` where a blank costs nothing |

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
