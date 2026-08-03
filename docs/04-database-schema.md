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

enum DocumentSource {
  LIBRARY
  DERIVED
  UPLOAD
}

enum StepStatus {
  PENDING
  DONE
  FAILED
  SKIPPED
}

enum CategorySource {
  NONE
  AUTO
  MANUAL
}

enum ScanSetStatus {
  DRAFT
  QUEUED
  PROCESSING
  DONE
  FAILED
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

enum ScanSetCropMode {
  TRIM
  NONE
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
  scanSets          ScanSet[]
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
  documentId   String?       @map("document_id") @db.Uuid
  missingSince DateTime?     @map("missing_since") @db.Timestamptz(6)
  firstSeenAt  DateTime      @default(now()) @map("first_seen_at") @db.Timestamptz(6)
  lastSeenAt   DateTime      @default(now()) @map("last_seen_at") @db.Timestamptz(6)

  library  Library   @relation(fields: [libraryId], references: [id])
  document Document? @relation(fields: [documentId], references: [id])

  @@unique([libraryId, path])
  @@index([documentId])
  @@index([libraryId, status])
  @@map("file_refs")
}

model Document {
  id                   String         @id @default(uuid()) @db.Uuid
  contentHash          String         @map("content_hash")
  source               DocumentSource
  mimeType             String         @map("mime_type")
  ext                  String
  sizeBytes            BigInt         @map("size_bytes")
  pageCount            Int?           @map("page_count")
  title                String
  markdown             String?
  searchVector         Unsupported("tsvector")? @map("search_vector")
  canonicalStatus      StepStatus     @default(PENDING) @map("canonical_status")
  previewStatus        StepStatus     @default(PENDING) @map("preview_status")
  markdownStatus       StepStatus     @default(PENDING) @map("markdown_status")
  categorizationStatus StepStatus     @default(PENDING) @map("categorization_status")
  vectorizationStatus  StepStatus     @default(PENDING) @map("vectorization_status")
  processingError      String?        @map("processing_error")
  skipReasons          Json           @default("{}") @map("skip_reasons")
  languages            String[]       @map("languages")
  country              String?        @map("country")
  city                 String?        @map("city")
  failedStep           String?        @map("failed_step")
  ocrUsed              Boolean        @default(false) @map("ocr_used")
  categoryId           String?        @map("category_id") @db.Uuid
  categorySource       CategorySource @default(NONE) @map("category_source")
  createdById          String?        @map("created_by_id") @db.Uuid
  scanSetId            String?        @map("scan_set_id") @db.Uuid
  createdAt            DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt            DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt            DateTime?      @map("deleted_at") @db.Timestamptz(6)

  category        Category?        @relation(fields: [categoryId], references: [id])
  createdBy       User?            @relation(fields: [createdById], references: [id])
  fileRefs        FileRef[]
  chunks          DocumentChunk[]
  collectionItems CollectionItem[]
  scanSetItems    ScanSetItem[]
  resultOf        ScanSet?         @relation("ScanSetResult")

  @@index([categoryId])
  @@index([createdAt(sort: Desc)])
  @@map("documents")
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

model Category {
  id          String    @id @default(uuid()) @db.Uuid
  slug        String
  name        String
  description String?
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt   DateTime? @map("deleted_at") @db.Timestamptz(6)

  documents Document[]

  @@map("categories")
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

model ScanSet {
  id               String          @id @default(uuid()) @db.Uuid
  name             String
  createdById      String          @map("created_by_id") @db.Uuid
  status           ScanSetStatus   @default(DRAFT)
  cropMode         ScanSetCropMode @default(TRIM) @map("crop_mode")
  resultDocumentId String?         @unique @map("result_document_id") @db.Uuid
  error            String?
  createdAt        DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime        @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt        DateTime?       @map("deleted_at") @db.Timestamptz(6)

  createdBy      User          @relation(fields: [createdById], references: [id])
  resultDocument Document?     @relation("ScanSetResult", fields: [resultDocumentId], references: [id])
  items          ScanSetItem[]

  @@index([createdById])
  @@map("scan_sets")
}

model ScanSetItem {
  scanSetId  String @map("scan_set_id") @db.Uuid
  position   Int
  documentId String @map("document_id") @db.Uuid

  scanSet  ScanSet  @relation(fields: [scanSetId], references: [id])
  document Document @relation(fields: [documentId], references: [id])

  @@id([scanSetId, position])
  @@map("scan_set_items")
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
CREATE UNIQUE INDEX documents_content_hash_active_uq ON documents (content_hash) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX categories_slug_active_uq    ON categories (slug)    WHERE deleted_at IS NULL;
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

## 4.4. Query patterns the schema must support (index rationale)

| Query | Served by |
|-------|-----------|
| scan: lookup by `(libraryId, path)` | `file_refs` unique index |
| dedup: `Document` by `contentHash` | partial unique index |
| document list, newest first, filtered by category/library | `documents(created_at DESC)`, `documents(category_id)`, `file_refs(library_id, status)` + join |
| availability check for a document | `file_refs(document_id)` index |
| FTS | GIN on `search_vector`, query via `websearch_to_tsquery('simple', $1)` |
| semantic search | HNSW cosine on `document_chunks.embedding`, `ORDER BY embedding <=> $1 LIMIT k` |
| admin scan journal | `scan_runs(library_id, started_at DESC)` |

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
- the default category set (03 §3.3.12) — the same list is also inserted by production migration 1,
  so a fresh prod instance has categories out of the box;
- one library pointing at `LIBRARY_ROOT` (rootPath `""`, visibility ALL_USERS, enabled) — dev
  compose mounts `./dev-library` there;
- no documents — they appear via a real scan, which keeps the seed honest.

## 4.7. Open questions

None.
