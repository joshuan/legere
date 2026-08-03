# 03. Domain Model

Entities, relations, enums, and invariants. This is the conceptual model; the physical schema (Prisma,
indexes, raw SQL) is in [`04-database-schema.md`](./04-database-schema.md).

Conventions: all IDs are UUID v4; all timestamps are UTC (`timestamptz`); soft delete via `deletedAt`
(ADR-015). "Active" record = `deletedAt IS NULL` (and, where applicable, not revoked/expired).

## 3.1. Entity map

```
User ─┬─< Session
      ├─< UserInvite (createdBy / acceptedBy)
      ├─< PasswordReset (user / createdBy)
      ├─< Collection ──< CollectionItem >── Document
      │        └──────< CollectionShare >── User? (null = whole instance)
      ├─< ScanSet ──< ScanSetItem >── Document (image source)
      │        └── resultDocument → Document (DERIVED)
      └─< LibraryAccess >── Library

Library ─┬─< FileRef >── Document (n:1, by contentHash)
         └─< ScanRun

Document ─┬─< DocumentChunk (embeddings)
          └── Category (n:1)

EmailVerification (standalone, keyed by email; used by registration & password reset)
```

## 3.2. Enums

| Enum | Values | Notes |
|------|--------|-------|
| `UserRole` | `ADMIN`, `USER` | |
| `Language` | `EN`, `RU` | `EN` is the default |
| `Theme` | `SYSTEM`, `LIGHT`, `DARK` | |
| `LibraryVisibility` | `ALL_USERS`, `RESTRICTED` | new libraries default to `RESTRICTED` (fail-closed) |
| `FileRefStatus` | `DISCOVERED`, `HASHED`, `MISSING` | |
| `DocumentSource` | `LIBRARY`, `DERIVED`, `UPLOAD` | where the bytes live and where they came from: a file in a read-only library, a scan-set merge, or a file a person sent from their browser. `DERIVED` and `UPLOAD` both keep their bytes in S3 |
| `StepStatus` | `PENDING`, `RUNNING`, `DONE`, `FAILED`, `SKIPPED` | per pipeline step. `RUNNING` is persisted, against the earlier decision to treat it as a queue state only: steps that take minutes exist — parsing with picture captions, OCR over a long scan, a local model thinking — and for those minutes `PENDING` reads as "stuck". The mark is best-effort and never the reason a job fails |
| `CategorySource` | `NONE`, `AUTO`, `MANUAL` | |
| `ScanSetStatus` | `DRAFT`, `QUEUED`, `PROCESSING`, `DONE`, `FAILED` | |
| `ScanRunStatus` | `RUNNING`, `DONE`, `FAILED` | |
| `VerificationPurpose` | `REGISTRATION`, `PASSWORD_RESET` | on `EmailVerification` |

## 3.3. Entities

### 3.3.1. User
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| email | string | stored lower-cased; unique among active users |
| passwordHash | string | Argon2id PHC string; never serialized |
| displayName | string | defaults to the local part of the email |
| role | UserRole | |
| language | Language | default `EN` |
| theme | Theme | default `SYSTEM` |
| deactivatedAt | timestamptz? | admin block: login refused, sessions revoked; reversible |
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- 🔒 At least one active, non-deactivated `ADMIN` must always exist. Any operation that would
  deactivate, demote, or soft-delete the last such admin fails with `LAST_ADMIN`.
- Email uniqueness is enforced among active users (partial unique index).
- Deactivation revokes all sessions and invalidates pending password resets.

### 3.3.2. Session
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tokenHash | string | sha256 of the opaque cookie token; unique |
| userId | uuid | |
| userAgent | string? | first 512 chars |
| createdAt / expiresAt / revokedAt? | | TTL = `SESSION_TTL_DAYS` (default 30) |

Active session = not revoked, not expired, user active and not deactivated.

### 3.3.3. EmailVerification
One row per verification attempt series; keyed by email, not by user (during registration the user
does not exist yet).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| email | string | lower-cased |
| purpose | VerificationPurpose | |
| codeHash | string | `HMAC-SHA256(AUTH_SECRET, code)` of a 6-digit code |
| attempts | int | burn the record after 5 wrong attempts |
| expiresAt | timestamptz | now + 10 min |
| verifiedAt | timestamptz? | set on correct code |
| ticketHash | string? | sha256 of the single-use registration/reset ticket |
| ticketExpiresAt | timestamptz? | now + 15 min |
| consumedAt | timestamptz? | set when the ticket is used |
| inviteId | uuid? | set when started from an invite link |
| passwordResetId | uuid? | set when started from a reset link |
| createdAt | | |

**Invariant:** at most one *active* record per (email, purpose) — creating a new one supersedes
(deletes) the previous.

### 3.3.4. UserInvite
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tokenHash | string | unique; sha256 of the opaque URL token |
| role | UserRole | role granted on acceptance |
| emailHint | string? | informational only, not enforced |
| createdById | uuid | admin |
| expiresAt | timestamptz | default now + 7 days |
| revokedAt / acceptedAt | timestamptz? | |
| acceptedById | uuid? | |
| createdAt | | |

Valid invite = not expired, not revoked, not accepted.

### 3.3.5. PasswordReset
Admin-generated reset link for an existing user (there is no self-service "forgot password" in MVP).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| userId | uuid | target user |
| tokenHash | string | unique |
| createdById | uuid | admin |
| expiresAt | timestamptz | default now + 24 h |
| revokedAt / usedAt | timestamptz? | |
| createdAt | | |

Completing a reset requires an email code (same 3-step flow, purpose `PASSWORD_RESET`) and revokes all
of the user's sessions.

### 3.3.6. Library
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| name | string | |
| rootPath | string | path **relative to** `LIBRARY_ROOT` (`""` = the root itself); unique among active libraries; normalized (no leading/trailing `/`, no `..`) |
| enabled | bool | disabled = no scans, content stays visible |
| visibility | LibraryVisibility | default `RESTRICTED` |
| scanIntervalMinutes | int | default 15, min 1 |
| excludeGlobs | string[] | e.g. `["**/.*", "**/node_modules/**"]`; hidden files excluded by default |
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- 🔒 `rootPath` must resolve to an existing directory inside `LIBRARY_ROOT` at creation time.
- Active libraries must not be nested in one another (`LIBRARY_PATH_CONFLICT`): a new `rootPath` may
  not be an ancestor or descendant of another active library's `rootPath` (a file must belong to at
  most one library).
- Soft-deleting a library removes its documents from user visibility immediately; `FileRef` rows are
  kept (history), documents remain (they may have refs in other libraries — impossible while nesting
  is forbidden, but kept for safety and for restore).

### 3.3.7. LibraryAccess
Grants a user access to a `RESTRICTED` library. `(libraryId, userId)` unique. Rows are hard-deleted on
revoke (pure ACL, no history requirement).

### 3.3.8. ScanRun
Journal of library scans.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| libraryId | uuid | |
| status | ScanRunStatus | |
| startedAt / finishedAt? | | |
| filesSeen / filesNew / filesChanged / filesMissing | int | counters |
| error | string? | on FAILED |

### 3.3.9. FileRef
A physical file inside a library. **No soft delete** — lifecycle is expressed by `status`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| libraryId | uuid | |
| path | string | relative to the library root; unique per library |
| size | bigint | bytes |
| mtime | timestamptz | filesystem mtime |
| status | FileRefStatus | |
| contentHash | string? | sha256 hex; set when HASHED |
| documentId | uuid? | set when HASHED |
| missingSince | timestamptz? | |
| firstSeenAt / lastSeenAt | timestamptz | |

**State machine:** `DISCOVERED → HASHED` (file-ingest), `HASHED → MISSING` (scan found it gone),
`MISSING → HASHED` (file returned, same hash), `HASHED → DISCOVERED` (size/mtime changed → rehash;
if the new hash differs, the ref re-points to another Document).

### 3.3.10. Document
The logical unit of content (deduplicated).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| contentHash | string | sha256 hex; unique among active documents |
| source | DocumentSource | |
| mimeType | string | detected from content (magic bytes), not from the extension |
| ext | string | lower-cased original extension, e.g. `pdf` |
| sizeBytes | bigint | |
| pageCount | int? | for PDFs (source or canonical) |
| title | string | initial = file name without extension: of the first FileRef (LIBRARY), of the scan set (DERIVED), of the uploaded file (UPLOAD); editable |
| markdown | text? | the extracted Markdown representation |
| searchVector | tsvector | generated from title + markdown (see 04) |
| canonicalStatus / previewStatus / markdownStatus / categorizationStatus / vectorizationStatus | StepStatus | pipeline step statuses |
| processingError | string? | last error message (truncated to 2000 chars) |
| skipReasons | json | why a step is `SKIPPED`, per step — see below; empty for steps that ran |
| autoValues | json | what the pipeline decided — `{title?, categorySlug?, languages?, country?, city?}` — kept beside the fields a person may correct, so the viewer can show "read as X" next to a hand-set Y. Merged per step, never erased by a correction |
| languages | string[] | BCP-47 tags of what the document is written in, most likely first — `['ru']`, `['ru','sr-Latn']`. Detected from the extracted text, editable; empty when there was too little text to tell |
| country | string? | ISO 3166-1 alpha-2 of where the document belongs — the issuer's country, the place of an event |
| city | string? | free text, as written in the document |
| failedStep | string? | which step produced `processingError` |
| ocrUsed | bool | whether Markdown came from OCR |
| categoryId | uuid? | |
| categorySource | CategorySource | default `NONE`; `MANUAL` is never overwritten by auto |
| createdById | uuid? | the owner; set for DERIVED and UPLOAD documents |
| scanSetId | uuid? | provenance for DERIVED documents |
| createdAt / updatedAt / deletedAt | | |

**Languages.** A document may be written in more than one — a bilingual contract has parallel
columns — so this is an array, most likely first. It is detected from the extracted text (an n-gram
detector plus the scripts actually present, offline, no model), and the script subtag is carried
where the same language exists in two of them: Serbian is `sr-Cyrl` or `sr-Latn`, never plain `sr`.
The set decides which languages OCR is given, and a wrong one costs accuracy — `EUR` read with
Cyrillic in the set comes back as `ЕОВ` — so below a length threshold the answer is an empty list
rather than a guess.

**Where a document belongs.** `country` and `city` answer "where is this from" — the issuing office
of a contract, the departure city on a ticket. They are inferred by the AI step when a provider is
configured, because the evidence is rarely literal: a Montenegrin train ticket says `ŽPCG` and
`Podgorica`, never "Montenegro", and the operator's full name lives in the logo, which is a picture.
Without a provider both stay empty until somebody fills them in; both are editable either way, and a
value a person set is never overwritten (the rule that already governs the category).

**Skip reasons.** `SKIPPED` on its own reads like something went wrong, and three of the five steps
skip for reasons an operator can act on. Each skipped step records why, from a closed set:

| Reason | Meaning |
|---|---|
| `NOT_NEEDED` | nothing to do for this format — a PDF needs no canonicalization, text has no page to render |
| `UNSUPPORTED_FORMAT` | the format has no representation the product can build |
| `NOT_CONFIGURED` | the instance has no classifier / embeddings provider (docs/05 §5.5) |
| `NO_CATEGORIES` | retained for documents processed before step 4 became a full analysis; no longer produced — with no categories defined the step still runs, because it also reads where the document is from |
| `NO_TEXT` | the document yielded no text to embed |
| `MANUAL_CATEGORY` | a person chose the category, and a machine never overwrites that |

**Derived state (computed, not stored):**
- `availability`: a LIBRARY document is `AVAILABLE` if it has ≥1 `FileRef` with status `HASHED` in an
  active, non-deleted library; otherwise `UNAVAILABLE`. DERIVED and UPLOAD documents are always
  `AVAILABLE` — their bytes are in S3, which is ours and does not go missing behind our back.
- `processing`: `true` while any step is `PENDING` or `RUNNING` and prerequisites are not `FAILED`.

**Invariants:**
- One active document per `contentHash`.
- A DERIVED document has `createdById` and `scanSetId` set and no `FileRef`s.
- An UPLOAD document has `createdById` set, no `scanSetId` and no `FileRef`s. It is the only kind a
  non-admin can create directly, and the read-only library volume is untouched by it (ADR-004).
- Soft delete of a document (admin) hides it everywhere, removes its chunks from search, and detaches
  it from collections/scan sets logically (items referencing it are hidden, not deleted).

**Artifact keys (deterministic, no DB columns — see 09):**
`documents/{id}/canonical.pdf`, `documents/{id}/preview.jpg`, `documents/{id}/thumb.jpg`,
`documents/{id}/source.{ext}` (DERIVED and UPLOAD — the bytes themselves; `.pdf` for a scan-set
merge, the uploaded file's own extension otherwise).

### 3.3.11. DocumentChunk
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| documentId | uuid | |
| index | int | 0-based; unique per document |
| content | text | the chunk text |
| charCount | int | |
| embedding | vector(1536) | pgvector; cosine ops |

Chunks are replaced wholesale on (re)vectorization: delete all → insert all (in one transaction).

### 3.3.12. Category
Admin-managed reference list.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| slug | string | unique among active; kebab-case; stable identifier used by the classifier |
| name | string | display name (English; shown as-is in both locales) |
| description | string? | shown to the classifier as guidance and to admins |
| createdAt / updatedAt / deletedAt | | |

Soft-deleting a category sets `categoryId = NULL`, `categorySource = NONE` on its documents
(application-level cascade inside the same transaction).

**Seeded defaults** (created by the first migration's seed, editable later): `passport`, `id-card`,
`contract`, `invoice`, `receipt`, `certificate`, `medical`, `financial`, `manual`, `letter`, `other`.

### 3.3.13. Collection
A user-created, flat (non-nested) named set of documents. This is the "shared folders" feature of the
product: users organize documents into collections and share them.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| ownerId | uuid | |
| name | string | unique per owner among active |
| description | string? | |
| createdAt / updatedAt / deletedAt | | |

### 3.3.14. CollectionItem
`(collectionId, documentId)` unique; `addedAt`, `addedById`. Hard-deleted on removal. Adding requires
read access to the document at add time; items whose document later becomes inaccessible to a viewer
are filtered out at read time for that viewer (the collection owner's access governs nothing for other
viewers — each viewer sees the intersection of the collection and their own access, **except** shared
DERIVED documents, which are readable via the share itself, see 08 §8.5).

### 3.3.15. CollectionShare
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| collectionId | uuid | |
| granteeUserId | uuid? | `NULL` = shared with the whole instance |
| createdAt / revokedAt? | | |

Unique active share per (collectionId, granteeUserId), including the NULL (instance-wide) row.
Sharing grants **read** access to the collection and, through it, to its DERIVED documents. LIBRARY
documents are never made accessible via shares — library visibility is the only gate for them
(deliberate: admins control library exposure, users cannot widen it).

### 3.3.16. ScanSet
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| name | string | becomes the result document's title |
| createdById | uuid | |
| status | ScanSetStatus | |
| cropMode | `TRIM` \| `NONE` | default `TRIM` (auto-trim margins per image) |
| resultDocumentId | uuid? | set on DONE |
| error | string? | on FAILED |
| createdAt / updatedAt / deletedAt | | |

**State machine:** `DRAFT → QUEUED` (user triggers merge; requires ≥1 item) → `PROCESSING` (job
started) → `DONE` | `FAILED`. `FAILED → QUEUED` (retry allowed, items may be edited first).
Items are editable only in `DRAFT`/`FAILED` (`SCANSET_INVALID_STATE` otherwise).

### 3.3.17. ScanSetItem
`(scanSetId, position)` unique; `documentId` must reference an image document (`mimeType image/*`)
readable by the scan set's creator (`SCANSET_ITEM_NOT_IMAGE` / `FORBIDDEN`). Position is a 0-based
contiguous order; reordering rewrites positions.

## 3.4. Access model (authoritative summary)

Full rules in [`08 §8.5`](./08-auth-and-authorization.md); the model in one place:

```
canReadDocument(user, doc):
  if user.role == ADMIN                → true
  if doc.deletedAt                     → false (404)
  if doc.source == LIBRARY:
      → any active FileRef of doc lies in an active library L where
          L.visibility == ALL_USERS or LibraryAccess(L, user) exists
  if doc.source == DERIVED or doc.source == UPLOAD:
      → doc.createdById == user.id
        or doc is an item of an active collection C such that
           C.ownerId == user.id
           or an active CollectionShare(C, user) or CollectionShare(C, NULL) exists

canEditDocumentMeta(user, doc):        # title, category
  → canReadDocument via a library (LIBRARY docs)  — collaborative editing
  → owner or ADMIN (DERIVED and UPLOAD docs)

canManageCollection(user, c):  c.ownerId == user.id or ADMIN
canReadCollection(user, c):    owner, ADMIN, or active share (user-specific or instance-wide)
```

## 3.5. Deletion semantics (summary)

| Action | Effect |
|--------|--------|
| File gone from disk | `FileRef.MISSING`; document possibly `UNAVAILABLE`; nothing deleted |
| Library soft-deleted | its documents disappear from all listings; artifacts/data retained |
| Document soft-deleted (admin) | hidden everywhere; chunks excluded from search; artifacts retained in S3 (cleaned by a later `maintenance` policy only if ever specified) |
| Category soft-deleted | documents' category reset to NONE |
| Collection soft-deleted | hidden for everyone incl. shares |
| User soft-deleted | sessions revoked; their collections/scan sets hidden; their DERIVED documents remain visible to users they were shared with? — **No:** shares die with the collection; DERIVED docs of a deleted user stay accessible to ADMIN only |

## 3.6. Open questions

None — previously open items are resolved in the corresponding documents (see 01 §1.7 note, 05 §5.9,
08 §8.7).
