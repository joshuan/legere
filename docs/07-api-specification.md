# 07. API Specification

REST over `/api`. All request/response bodies are described by Zod schemas in
`src/shared/contracts` — those schemas are the machine-readable source of truth; this document is the
human-readable index and must stay in sync with them.

## 7.1. Conventions

- **Envelope:** success → `{ "data": ... }`; error → `{ "error": { "code", "message", "details" } }`.
  `code` is a machine string from §7.2; `message` is an English developer hint (the UI localizes by
  `code`, never shows `message`); `details` is `null` or a structured object (e.g. Zod issues).
- **Status codes:** 200 (read/update), 201 (create), 204 — never used (bodies always present),
  401/403/404/409/422/429/500 per §7.2. Unknown `/api/*` route → 404 `NOT_FOUND` (JSON, never HTML).
- **Auth:** session cookie `sid` (httpOnly). 🔒 = requires session; 🔒ᴬ = requires role ADMIN.
  Mutations additionally pass the fail-closed Origin check ([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)).
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
| 404 | `NOT_FOUND` | unknown route/malformed id |
| 404 | `USER_NOT_FOUND`, `LIBRARY_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `COLLECTION_NOT_FOUND`, `SCANSET_NOT_FOUND`, `INVITE_NOT_FOUND` | resource lookups (incl. soft-deleted) |
| 409 | `EMAIL_ALREADY_REGISTERED` | registration race |
| 409 | `LAST_ADMIN` | demote/deactivate/delete last admin |
| 409 | `LIBRARY_PATH_CONFLICT` | nested/duplicate library path |
| 409 | `CATEGORY_SLUG_TAKEN`, `COLLECTION_NAME_TAKEN` | uniqueness |
| 409 | `SCANSET_INVALID_STATE` | editing/merging in a wrong status |
| 409 | `DOCUMENT_UNAVAILABLE` | source download when all refs MISSING |
| 410 | `ONBOARDING_CLOSED` | onboarding after first user exists |
| 422 | `VALIDATION_FAILED` | Zod failure (`details.issues`) |
| 422 | `LIBRARY_PATH_INVALID` | path outside root / not a directory |
| 422 | `SCANSET_ITEM_NOT_IMAGE` | non-image item |
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
| `GET /api/documents` | 🔒 | paginated, newest first; filters: `libraryId?`, `categoryId?`, `availability?` (`AVAILABLE`\|`UNAVAILABLE`), `processing?` (bool), `source?`; only documents the caller can read |
| `GET /api/documents/:id` | 🔒 | → `DocumentDetailDto` |
| `PATCH /api/documents/:id` | 🔒 | `{ title?, categoryId? }` per canEditDocumentMeta (03 §3.4); setting categoryId flips `categorySource` to MANUAL (null → NONE) |
| `DELETE /api/documents/:id` | 🔒ᴬ | soft delete |
| `POST /api/documents/:id/reprocess` | 🔒ᴬ | `{ steps?: ('canonical'\|'preview'\|'markdown'\|'categorization'\|'vectorization')[] }` → re-enqueues `document-process` |
| `GET /api/documents/:id/markdown` | 🔒 | → `{ markdown: string \| null }` |
| `GET /api/documents/:id/source` | 🔒 | LIBRARY: streams the original file (`Content-Type`, `Content-Disposition: attachment`); DERIVED: 302 → signed URL of `source.pdf`; `DOCUMENT_UNAVAILABLE` if no live ref |
| `GET /api/documents/:id/preview` | 🔒 | 302 → signed URL of `preview.jpg` (404 `NOT_FOUND` if step not DONE) |
| `GET /api/documents/:id/thumb` | 🔒 | 302 → signed URL of `thumb.jpg` |
| `GET /api/documents/:id/canonical` | 🔒 | 302 → signed URL of `canonical.pdf`; for PDF sources equals `/source` |

`DocumentListDto`: `{ id, title, ext, mimeType, sizeBytes(string), pageCount, category: {id,slug,name}|null, availability, processing, source, hasPreview, createdAt }`.
`DocumentDetailDto` = list dto + `{ contentHash, ocrUsed, categorySource, steps: {canonical, preview, markdown, categorization, vectorization}, processingError, failedStep, fileRefs: [{ libraryId, libraryName, path, status }] (only refs in libraries visible to the caller; ADMIN sees all), createdBy?, scanSetId? }`.

### Search
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/search?q=&mode=&limit=&libraryId?=&categoryId?=` | 🔒 | `mode`: `hybrid` (default) \| `text` \| `semantic`. → `{ items: [{ document: DocumentListDto, score, snippet }], semanticAvailable: boolean }`. Text: FTS `websearch_to_tsquery('simple')` over `search_vector`, snippet via `ts_headline`. Semantic: embed `q`, top-k chunks by cosine, group by document (best chunk wins; snippet = chunk excerpt). Hybrid: Reciprocal Rank Fusion (k = 60) over both lists. Access filter applied **in SQL** before limit. Provider unconfigured → `semanticAvailable: false`, hybrid silently = text |

### Categories
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/categories` | 🔒 | active, sorted by name |
| `POST /api/admin/categories` | 🔒ᴬ | `{ slug, name, description? }` |
| `PATCH /api/admin/categories/:id` | 🔒ᴬ | `{ name?, description? }` (slug immutable) |
| `DELETE /api/admin/categories/:id` | 🔒ᴬ | soft delete; resets documents to NONE |

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

### Scan sets
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/scan-sets` | 🔒 | own, newest first |
| `POST /api/scan-sets` | 🔒 | `{ name, cropMode?, items: [documentId, ...] }` (order = page order) → `ScanSetDto` (status DRAFT) |
| `GET /api/scan-sets/:id` | 🔒 owner | with items (position, thumb) and `resultDocumentId` |
| `PATCH /api/scan-sets/:id` | 🔒 owner | `{ name?, cropMode?, items? }` — DRAFT/FAILED only (`SCANSET_INVALID_STATE`) |
| `POST /api/scan-sets/:id/merge` | 🔒 owner | DRAFT/FAILED → QUEUED, enqueues `scanset-merge` |
| `DELETE /api/scan-sets/:id` | 🔒 owner | soft delete (result document, if any, stays) |

### Admin: queue
| Method & path | Auth | Notes |
|---------------|------|-------|
| `GET /api/admin/queue/overview` | 🔒ᴬ | per queue: `{ name, queued, active, failedRecent }` + document step counters + `storage: { objects, bytes, measuredAt } \| null` (hourly aggregate, `null` before the first `maintenance` run) |
| `GET /api/admin/queue/failures` | 🔒ᴬ | paginated failed jobs: `{ jobId, queue, payload, error, failedAt, retryCount }` |
| `POST /api/admin/queue/failures/:jobId/retry` | 🔒ᴬ | re-enqueues a copy of the job → `{ ok: true }` |

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
`documents.ts`, `search.ts`, `categories.ts`, `collections.ts`, `scan-sets.ts`, `queue.ts`,
`common.ts` — envelope, pagination, error codes enum, shared enums). Each file exports request
schemas, response schemas, and inferred types. The server validates requests with them; the client
validates responses with them (fail loudly on drift).

## 7.6. Open questions

None.
