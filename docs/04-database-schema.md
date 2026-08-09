# 04. Database Schema

PostgreSQL 16 + the `pgvector` extension. ORM — Prisma (client + migrations); DB access only in the
infrastructure layer. This document is the authoritative physical schema: implement `schema.prisma`
exactly as written here, plus the raw-SQL migration steps in §4.3.

Conventions: table/column names — `snake_case` via `@@map`/`@map`; Prisma model fields — `camelCase`;
enums stored as Postgres enums; money does not exist in this domain; time — `timestamptz` (Prisma
`DateTime @db.Timestamptz(6)`).

## 4.1. Prisma schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector(map: "vector")]
}

enum UserRole {
  ADMIN
  USER
}

enum Language {
  EN
  RU
}

enum Theme {
  SYSTEM
  LIGHT
  DARK
}

enum LibraryVisibility {
  ALL_USERS
  RESTRICTED
}

enum FileRefStatus {
  DISCOVERED
  HASHED
  MISSING
}

enum FileOrigin {
  LIBRARY
  MANAGED
}

enum StepStatus {
  PENDING
  RUNNING
  DONE
  FAILED
  SKIPPED
}

model Setting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("settings")
}

enum ValueSource {
  NONE
  AUTO
  MANUAL
}

enum ScanRunStatus {
  RUNNING
  DONE
  FAILED
}

enum VerificationPurpose {
  REGISTRATION
  PASSWORD_RESET
}

model User {
  id            String    @id @default(uuid()) @db.Uuid
  email         String
  passwordHash  String    @map("password_hash")
  displayName   String    @map("display_name")
  role          UserRole
  language      Language  @default(EN)
  theme         Theme     @default(SYSTEM)
  deactivatedAt DateTime? @map("deactivated_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt     DateTime? @map("deleted_at") @db.Timestamptz(6)

  sessions          Session[]
  createdInvites    UserInvite[]    @relation("InviteCreator")
  acceptedInvites   UserInvite[]    @relation("InviteAcceptor")
  passwordResets    PasswordReset[] @relation("ResetTarget")
  createdResets     PasswordReset[] @relation("ResetCreator")
  libraryAccess     LibraryAccess[]
  collections       Collection[]
  collectionShares  CollectionShare[]
  derivedDocuments  Document[]

  @@map("users")
}

model Session {
  id        String    @id @default(uuid()) @db.Uuid
  tokenHash String    @unique @map("token_hash")
  userId    String    @map("user_id") @db.Uuid
  userAgent String?   @map("user_agent")
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@map("sessions")
}

model ApiToken {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  name       String
  tokenHash  String    @unique @map("token_hash")
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz(6)
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz(6)
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@map("api_tokens")
}

model EmailVerification {
  id              String              @id @default(uuid()) @db.Uuid
  email           String
  purpose         VerificationPurpose
  codeHash        String              @map("code_hash")
  attempts        Int                 @default(0)
  expiresAt       DateTime            @map("expires_at") @db.Timestamptz(6)
  verifiedAt      DateTime?           @map("verified_at") @db.Timestamptz(6)
  ticketHash      String?             @unique @map("ticket_hash")
  ticketExpiresAt DateTime?           @map("ticket_expires_at") @db.Timestamptz(6)
  consumedAt      DateTime?           @map("consumed_at") @db.Timestamptz(6)
  inviteId        String?             @map("invite_id") @db.Uuid
  passwordResetId String?             @map("password_reset_id") @db.Uuid
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)

  @@unique([email, purpose]) // one active series per (email, purpose); new request replaces the row
  @@map("email_verifications")
}

model UserInvite {
  id           String    @id @default(uuid()) @db.Uuid
  tokenHash    String    @unique @map("token_hash")
  role         UserRole
  emailHint    String?   @map("email_hint")
  createdById  String    @map("created_by_id") @db.Uuid
  expiresAt    DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(6)
  acceptedAt   DateTime? @map("accepted_at") @db.Timestamptz(6)
  acceptedById String?   @map("accepted_by_id") @db.Uuid
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  createdBy  User  @relation("InviteCreator", fields: [createdById], references: [id])
  acceptedBy User? @relation("InviteAcceptor", fields: [acceptedById], references: [id])

  @@map("user_invites")
}

model PasswordReset {
  id          String    @id @default(uuid()) @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  tokenHash   String    @unique @map("token_hash")
  createdById String    @map("created_by_id") @db.Uuid
  expiresAt   DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz(6)
  usedAt      DateTime? @map("used_at") @db.Timestamptz(6)
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user      User @relation("ResetTarget", fields: [userId], references: [id])
  createdBy User @relation("ResetCreator", fields: [createdById], references: [id])

  @@index([userId])
  @@map("password_resets")
}

model Library {
  id                  String            @id @default(uuid()) @db.Uuid
  name                String
  rootPath            String            @map("root_path")
  enabled             Boolean           @default(true)
  visibility          LibraryVisibility @default(RESTRICTED)
  scanIntervalMinutes Int               @default(15) @map("scan_interval_minutes")
  excludeGlobs        String[]          @map("exclude_globs")
  createdAt           DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt           DateTime          @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt           DateTime?         @map("deleted_at") @db.Timestamptz(6)

  fileRefs FileRef[]
  access   LibraryAccess[]
  scanRuns ScanRun[]

  @@map("libraries")
}

model LibraryAccess {
  libraryId String   @map("library_id") @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  library Library @relation(fields: [libraryId], references: [id])
  user    User    @relation(fields: [userId], references: [id])

  @@id([libraryId, userId])
  @@map("library_access")
}

model ScanRun {
  id           String        @id @default(uuid()) @db.Uuid
  libraryId    String        @map("library_id") @db.Uuid
  status       ScanRunStatus
  startedAt    DateTime      @default(now()) @map("started_at") @db.Timestamptz(6)
  finishedAt   DateTime?     @map("finished_at") @db.Timestamptz(6)
  filesSeen    Int           @default(0) @map("files_seen")
  filesNew     Int           @default(0) @map("files_new")
  filesChanged Int           @default(0) @map("files_changed")
  filesMissing Int           @default(0) @map("files_missing")
  error        String?

  library Library @relation(fields: [libraryId], references: [id])

  @@index([libraryId, startedAt(sort: Desc)])
  @@map("scan_runs")
}

model FileRef {
  id           String        @id @default(uuid()) @db.Uuid
  libraryId    String        @map("library_id") @db.Uuid
  path         String
  size         BigInt
  mtime        DateTime      @map("mtime") @db.Timestamptz(6)
  status       FileRefStatus
  contentHash  String?       @map("content_hash")
  fileId       String?       @map("file_id") @db.Uuid
  missingSince DateTime?     @map("missing_since") @db.Timestamptz(6)
  firstSeenAt  DateTime      @default(now()) @map("first_seen_at") @db.Timestamptz(6)
  lastSeenAt   DateTime      @default(now()) @map("last_seen_at") @db.Timestamptz(6)

  library Library @relation(fields: [libraryId], references: [id])
  file    File?   @relation(fields: [fileId], references: [id])

  @@unique([libraryId, path])
  @@index([fileId])
  @@index([libraryId, status])
  @@map("file_refs")
}

model Document {
  id                   String         @id @default(uuid()) @db.Uuid
  pageCount            Int?           @map("page_count")
  title                String
  description          String?        @map("description")
  markdown             String?
  searchVector         Unsupported("tsvector")? @map("search_vector")
  canonicalStatus      StepStatus     @default(PENDING) @map("canonical_status")
  previewStatus        StepStatus     @default(PENDING) @map("preview_status")
  markdownStatus       StepStatus     @default(PENDING) @map("markdown_status")
  analysisStatus StepStatus     @default(PENDING) @map("analysis_status")
  vectorizationStatus  StepStatus     @default(PENDING) @map("vectorization_status")
  processingError      String?        @map("processing_error")
  skipReasons          Json           @default("{}") @map("skip_reasons")
  languages            String[]
  autoValues           Json           @default("{}") @map("auto_values")       @map("languages")
  country              String?        @map("country")
  city                 String?        @map("city")
  failedStep           String?        @map("failed_step")
  ocrUsed              Boolean        @default(false) @map("ocr_used")
  titleSource      ValueSource @default(NONE) @map("title_source")
  typeId           String?        @map("type_id") @db.Uuid
  typeSource       ValueSource @default(NONE) @map("type_source")
  createdById          String?        @map("created_by_id") @db.Uuid
  createdAt            DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt            DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt            DateTime?      @map("deleted_at") @db.Timestamptz(6)

  document type        Document type?        @relation(fields: [typeId], references: [id])
  createdBy       User?            @relation(fields: [createdById], references: [id])
  files           DocumentFile[]
  chunks          DocumentChunk[]
  collectionItems CollectionItem[]

  @@index([typeId])
  @@index([createdAt(sort: Desc)])
  @@map("documents")
}

model DocumentEvent {
  id         String            @id @default(uuid()) @db.Uuid
  documentId String            @map("document_id") @db.Uuid
  type       DocumentEventType
  actorId    String?           @map("actor_id") @db.Uuid
  payload    Json              @default("{}")
  at         DateTime          @default(now()) @db.Timestamptz(6)

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  actor    User?    @relation(fields: [actorId], references: [id])

  @@index([documentId, at(sort: Desc)])
  @@map("document_events")
}

model DocumentChunk {
  id         String                    @id @default(uuid()) @db.Uuid
  documentId String                    @map("document_id") @db.Uuid
  index      Int
  content    String
  charCount  Int                       @map("char_count")
  embedding  Unsupported("vector(1536)")

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@unique([documentId, index])
  @@map("document_chunks")
}

model Document type {
  id          String    @id @default(uuid()) @db.Uuid
  slug        String
  name        String
  description String?
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt   DateTime? @map("deleted_at") @db.Timestamptz(6)

  documents Document[]

  @@map("document_types")
}

model Collection {
  id          String    @id @default(uuid()) @db.Uuid
  ownerId     String    @map("owner_id") @db.Uuid
  name        String
  description String?
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt   DateTime? @map("deleted_at") @db.Timestamptz(6)

  owner  User              @relation(fields: [ownerId], references: [id])
  items  CollectionItem[]
  shares CollectionShare[]

  @@map("collections")
}

model CollectionItem {
  collectionId String   @map("collection_id") @db.Uuid
  documentId   String   @map("document_id") @db.Uuid
  addedById    String   @map("added_by_id") @db.Uuid
  addedAt      DateTime @default(now()) @map("added_at") @db.Timestamptz(6)

  collection Collection @relation(fields: [collectionId], references: [id])
  document   Document   @relation(fields: [documentId], references: [id])

  @@id([collectionId, documentId])
  @@map("collection_items")
}

model CollectionShare {
  id            String    @id @default(uuid()) @db.Uuid
  collectionId  String    @map("collection_id") @db.Uuid
  granteeUserId String?   @map("grantee_user_id") @db.Uuid
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  revokedAt     DateTime? @map("revoked_at") @db.Timestamptz(6)

  collection Collection @relation(fields: [collectionId], references: [id])
  grantee    User?      @relation(fields: [granteeUserId], references: [id])

  @@map("collection_shares")
}

model File {
  id          String     @id @default(uuid()) @db.Uuid
  contentHash String     @map("content_hash")
  origin      FileOrigin
  storageKey  String?    @map("storage_key")
  mimeType    String     @map("mime_type")
  ext         String
  sizeBytes   BigInt     @map("size_bytes")
  name        String
  crop        Json?
  cropSource  ValueSource @default(NONE) @map("crop_source")
  createdAt   DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime   @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt   DateTime?  @map("deleted_at") @db.Timestamptz(6)

  refs     FileRef[]
  document DocumentFile?

  @@map("files")
}

model DocumentFile {
  documentId String @map("document_id") @db.Uuid
  position   Int
  fileId     String @unique @map("file_id") @db.Uuid

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  file     File     @relation(fields: [fileId], references: [id])

  @@id([documentId, position])
  @@map("document_files")
}
```

## 4.2. Notes on the Prisma schema

- `searchVector` and `embedding` use `Unsupported(...)` — Prisma cannot model them natively; they are
  written/queried via `$queryRaw`/`$executeRaw` in repositories, and created/altered via raw SQL in
  migrations (§4.3).
- BigInt columns (`size`, `sizeBytes`) are serialized to JSON as strings in DTOs (contract rule,
  [`07 §7.4`](./07-api-specification.md#74-dto-serialization)).
- `onDelete: Cascade` is used **only** on `DocumentChunk` (chunks are derived data, wholesale
  replaced). Everything else has no DB-level cascades — deletion is soft and handled in application
  code.
- pg-boss creates and owns its objects in a separate `pgboss` schema at first start; Prisma does not
  manage them. The admin queue view reads them through the `QueueMonitor` port (raw SQL), never via
  Prisma models.

## 4.3. Raw SQL in migrations (required steps)

The first migration must include (in this order):

```sql
-- 1) extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) FTS: generated column + index (Prisma sees the column as Unsupported)
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(markdown, '')), 'B')
  ) STORED;
CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);
```

> The `simple` configuration is deliberate: content is mixed ru/en (and OCR output), a
> language-specific stemmer would mis-stem half of it. Exactness is compensated by `websearch_to_tsquery`
> prefix matching and by semantic search.

```sql
-- 3) vector index (cosine)
CREATE INDEX document_chunks_embedding_idx ON document_chunks
  USING hnsw (embedding vector_cosine_ops);

-- 4) partial unique indexes (soft-delete aware)
CREATE UNIQUE INDEX users_email_active_uq        ON users (email)        WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX libraries_root_path_active_uq ON libraries (root_path) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX files_content_hash_active_uq ON files (content_hash) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX document_types_slug_active_uq    ON document_types (slug)    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX collections_owner_name_active_uq ON collections (owner_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX collection_shares_grantee_active_uq
  ON collection_shares (collection_id, grantee_user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX collection_shares_instance_active_uq
  ON collection_shares (collection_id) WHERE revoked_at IS NULL AND grantee_user_id IS NULL;

-- 5) at most one RUNNING scan per library
CREATE UNIQUE INDEX scan_runs_running_uq ON scan_runs (library_id) WHERE status = 'RUNNING';
```

Because of these raw statements, the corresponding plain `@unique` attributes are **omitted** in
`schema.prisma` for soft-deletable models (as written above) — uniqueness lives in the partial
indexes. `prisma migrate dev` generates the base DDL; the raw statements are appended to the generated
`migration.sql` before committing.

Later migrations follow the same rule, and it applies to plain indexes too: `documents(document_date)`
and the two partial place indexes of §4.4 are written by hand, because `prisma migrate dev` proposes
**dropping** every raw-SQL index it did not create, and because Prisma's `@@index` cannot express a
`WHERE` at all. An index that exists only in a migration is the accepted cost of that; the table in
§4.4 is where it is recorded, and it is the thing to keep in step.

The dividing line is what the schema language can say, not habit: an index Prisma **can** express
stays in `schema.prisma` as `@@index`, and only what it cannot goes into raw SQL. `@@index` cannot
say `WHERE`, cannot say `NULLS FIRST`, and cannot mix a sorted expression with a second column — so
`documents(document_date DESC NULLS FIRST, id DESC)`, which serves the default order of
`GET /api/documents` (`07 §7.1`), is hand-written, while `documents(last_event_at DESC)`, which
serves the order beside it, is an `@@index` like `documents(created_at DESC)` already is. Note that
the `NULLS FIRST` index does **not** replace `documents(document_date DESC NULLS LAST)`: an index
scanned backwards yields `ASC NULLS FIRST`, which is the wrong order among the dated rows, so the
two orders need two indexes and both stay.

## 4.4. Query patterns the schema must support (index rationale)

Every filter `GET /api/documents` takes (`07 §7.3`) is in this table, because a filter nothing serves
is a sequential scan of the archive on a request any signed-in user can repeat.

| Query | Served by |
|-------|-----------|
| scan: lookup by `(libraryId, path)` | `file_refs` unique index |
| dedup: `File` by `contentHash` | partial unique index |
| the files of one document, in order | `document_files` PK `(document_id, position)` |
| the document a file belongs to | `document_files.file_id` unique |
| document list ordered by when Legere first saw it (`?sort=createdAt`) | `documents(created_at DESC)` |
| document list ordered by the date on the paper, undated first (`?sort=documentDate`, the default) | `documents(document_date DESC NULLS FIRST, id DESC)` (raw SQL, §4.3) — a separate index from the `NULLS LAST` one below, which cannot be scanned backwards to produce it; `id` is in the index because a DATE ties constantly and the cursor needs the tiebreak to continue a page inside one day |
| document list ordered by when it last changed (`?sort=lastEventAt`) | `documents(last_event_at DESC)` — the denormalised newest journal entry (`03 §3.3.18`); `max(document_events.at)` is a correlated aggregate no index serves |
| filter by document type | `documents(type_id)` |
| filter by library | `file_refs(library_id, status)` + join through `document_files` |
| availability and origin for a document | derived from its files: `document_files` PK + `file_refs(file_id)` |
| filter by person | `document_people(person_id)` index; the PK `(document_id, person_id)` closes the join |
| filter by subject | `document_subjects(subject_id)` index, PK `(document_id, subject_id)` |
| filter by subject **kind** | the same two, then `subjects(kind_id)` — a kind needs no index of its own |
| filter/browse by year, "what happened in March" | `documents(document_date DESC NULLS LAST)` (raw SQL, §4.3) |
| filter by place | `documents(country) WHERE country IS NOT NULL`, `documents(city) WHERE city IS NOT NULL` — partial, because the analysis finds a place for only some documents and an index over the rest would be NULL entries nothing looks up (raw SQL, §4.3) |
| filter by pipeline step + status | none: five low-cardinality enum columns, and the queue screen's counters bound the answer |
| FTS | GIN on `search_vector`, query via `websearch_to_tsquery('simple', $1)` |
| semantic search | HNSW cosine on `document_chunks.embedding`, `ORDER BY embedding <=> $1 LIMIT k` |
| the events of one document, newest first | `document_events(document_id, at DESC)` |
| admin scan journal | `scan_runs(library_id, started_at DESC)` |
| at most one RUNNING scan per library | `scan_runs_running_uq` partial unique index |
| authenticating a bearer token, once per request | `api_tokens.token_hash` unique index |
| a user's own token list | `api_tokens(user_id)` index |

## 4.5. Migration policy

- The instance is **live**: every schema change ships as a forward-only Prisma migration that applies
  **automatically on container start** (`npm run db:migrate` = `prisma migrate deploy` in the image
  `CMD`).
- Forbidden: `prisma db push`, `prisma migrate reset` against a live database, editing an
  already-applied migration, dropping/renaming a column without a data backfill in the same migration.
- Data moves (backfills) are written inside the migration itself (SQL), so a freshly cloned instance
  and a long-lived one converge to identical states.
- Changing `EMBEDDING` dimensions (the `vector(1536)` type) requires a migration that recreates
  `document_chunks` and a full re-vectorization (a `maintenance` job re-enqueues `document-process`
  vectorization for all documents); do not do this casually.

## 4.6. Seed (dev)

`prisma/seed.ts` (dev/test only, idempotent):
- admin user `admin@legere.local` / password `password` (role ADMIN, language EN);
- regular user `user@legere.local` / password `password`;
- the default document type set (03 §3.3.12) — the same list is also inserted by production migration 1,
  so a fresh prod instance has document types out of the box;
- one library pointing at `LIBRARY_ROOT` (rootPath `""`, visibility ALL_USERS, enabled) — dev
  compose mounts `./dev-library` there;
- no documents — they appear via a real scan, which keeps the seed honest.

## 4.7. Open questions

None.
