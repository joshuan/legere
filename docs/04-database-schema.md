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
  // The document these bytes were part of was deleted by an admin (03 §3.3.9). The row stays as the
  // tombstone that keeps the next scan from ingesting the file again; `file_id` is null, because the
  // file it pointed at is gone.
  EXCLUDED
}

// How a file came to be in the trash (03 §3.2, 05 §5.7a).
enum TrashReason {
  REPLACED
  DOCUMENT_DELETED
}

enum FileOrigin {
  LIBRARY
  MANAGED
}

enum StepStatus {
  // PENDING and QUEUED are the two halves of what used to be one word (03 §3.3.10): QUEUED says a
  // job exists, PENDING says nothing is scheduled — which is what a migration that resets a step
  // leaves behind.
  PENDING
  QUEUED
  RUNNING
  DONE
  FAILED
  SKIPPED
}

// What shape the pages of the canonical take (05 §5.5 step 1). AUTO reads it off the files.
enum PageFormat {
  AUTO
  A4
  MATCH_SOURCE
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
  canonicalStatus      StepStatus     @default(QUEUED) @map("canonical_status")
  previewStatus        StepStatus     @default(QUEUED) @map("preview_status")
  markdownStatus       StepStatus     @default(QUEUED) @map("markdown_status")
  analysisStatus StepStatus     @default(QUEUED) @map("analysis_status")
  fieldsStatus         StepStatus     @default(QUEUED) @map("fields_status")
  vectorizationStatus  StepStatus     @default(QUEUED) @map("vectorization_status")
  extracted            Json?
  extractedSearchText  String?        @map("extracted_search_text")
  processingError      String?        @map("processing_error")
  skipReasons          Json           @default("{}") @map("skip_reasons")
  languages            String[]
  autoValues           Json           @default("{}") @map("auto_values")       @map("languages")
  country              String?        @map("country")
  city                 String?        @map("city")
  failedStep           String?        @map("failed_step")
  ocrUsed              Boolean        @default(false) @map("ocr_used")
  pageFormat       PageFormat  @default(AUTO) @map("page_format")
  titleSource      ValueSource @default(NONE) @map("title_source")
  typeId           String?        @map("type_id") @db.Uuid
  typeSource       ValueSource @default(NONE) @map("type_source")
  createdById          String?        @map("created_by_id") @db.Uuid
  createdAt            DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt            DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt            DateTime?      @map("deleted_at") @db.Timestamptz(6)

  document type        Document type?        @relation(fields: [typeId], references: [id])
  createdBy       User?            @relation(fields: [createdById], references: [id])
  pages           DocumentPage[]
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

model DocumentLink {
  id          String   @id @default(uuid()) @db.Uuid
  aId         String   @map("a_id") @db.Uuid
  bId         String   @map("b_id") @db.Uuid
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  a         Document @relation("DocumentLinkA", fields: [aId], references: [id], onDelete: Cascade)
  b         Document @relation("DocumentLinkB", fields: [bId], references: [id], onDelete: Cascade)
  createdBy User?    @relation(fields: [createdById], references: [id])

  @@unique([aId, bId])
  @@index([bId])
  @@map("document_links")
}

model DocumentChunk {
  id         String                    @id @default(uuid()) @db.Uuid
  documentId String                    @map("document_id") @db.Uuid
  index      Int
  content    String
  charCount  Int                       @map("char_count")
  embedding  Unsupported("vector(1024)")
  // Which embedder produced this vector (docs/03 §3.3.11). Null on a chunk written before the
  // column existed; never null on one written since.
  model      String?

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
  // How many pages are inside these bytes (03 §3.3.16): what the last canonical build counted, and
  // what a page index is checked against. Null until a build has opened the file, which is the one
  // state in which a document cannot name its pages one by one (ADR-025).
  pageCount     Int?         @map("page_count")
  // In the trash since, and how it got there (05 §5.7a). A file with no live page anywhere is in
  // the trash; `replaced_by_id` is the file that took its place, for the versions of a page.
  trashedAt     DateTime?    @map("trashed_at") @db.Timestamptz(6)
  trashedReason TrashReason? @map("trashed_reason")
  trashedFrom   String?      @map("trashed_from")
  replacedById  String?      @map("replaced_by_id") @db.Uuid
  createdAt   DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime   @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt   DateTime?  @map("deleted_at") @db.Timestamptz(6)

  refs     FileRef[]
  pages    DocumentPage[]
  // The versions of one page: every earlier copy points at the file now in the document (03 §3.3.16).
  replacedBy      File?  @relation("FileVersions", fields: [replacedById], references: [id])
  earlierVersions File[] @relation("FileVersions")

  // The trash is read newest first and swept by age, and both are this one index.
  @@index([trashedAt(sort: Desc)])
  @@index([replacedById])
  @@map("files")
}

// One page of one document (03 §3.3.17, ADR-025): which file it is read from, which page of that
// file, which way up it lies and how much of it is paper. The turn and the crop live here rather
// than on the file because they are answers about this page in this document, and the same file may
// be read by pages of two documents at once.
model DocumentPage {
  id         String      @id @default(uuid()) @db.Uuid
  documentId String      @map("document_id") @db.Uuid
  position   Int
  fileId     String      @map("file_id") @db.Uuid
  // Null is "this file, whole, in the order it arrived" — the entry a file takes while nobody has
  // counted its pages; the first canonical build expands it into one entry per page.
  pageIndex  Int?        @map("page_index")
  turn       Json?
  crop       Json?
  cropSource ValueSource @default(NONE) @map("crop_source")

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  file     File     @relation(fields: [fileId], references: [id])

  @@unique([documentId, position])
  @@index([fileId])
  @@map("document_pages")
}
```

## 4.2. Notes on the Prisma schema

- `searchVector` and `embedding` use `Unsupported(...)` — Prisma cannot model them natively; they are
  written/queried via `$queryRaw`/`$executeRaw` in repositories, and created/altered via raw SQL in
  migrations (§4.3).
- BigInt columns (`size`, `sizeBytes`) are serialized to JSON as strings in DTOs (contract rule,
  [`07 §7.4`](./07-api-specification.md#74-dto-serialization)).
- `onDelete: Cascade` is used on what belongs to a document and cannot outlive it: `DocumentChunk`,
  `DocumentEvent`, `DocumentPerson`, `DocumentSubject` and `DocumentPage`. Deleting a document for
  real (`03 §3.3.10`) is then one `DELETE` and not five, and — more to the point — no future
  statement can leave a chunk or a journal entry behind pointing at a row that is gone.
  **`CollectionItem` deliberately has none:** a collection is somebody else's list, and a document is
  taken off it by application code that knows it is doing so, not by a foreign key. Everything else
  has no DB-level cascades, because everything else is deleted softly and in application code.
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

**Amended by the typed-fields migration (M22.1):** the searchable extracted values
(`extracted_search_text`, `03 §3.3.10a`) join the vector, at weight `A` — a field the model read off
the paper is as precise a hit as the title. A generated column's expression cannot be altered in
place, so the migration drops and recreates the column and its index:

```sql
ALTER TABLE documents DROP COLUMN search_vector;
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(extracted_search_text, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(markdown, '')), 'B')
  ) STORED;
CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);

-- document_links: the pair is unordered and the storage says so
ALTER TABLE document_links ADD CONSTRAINT document_links_pair_ordered CHECK (a_id < b_id);
```

The same migration backfills `fields_status` for the archive that predates the step: `PENDING` where
the document's type carries a schema (the hourly sweep of `05 §5.4` walks them through the new step
over the following hours), `SKIPPED` with `skip_reasons.fields = 'NO_SCHEMA'` everywhere else — so an
archive of mostly schemaless documents does not spend a week reading as "processing" for a step that
has nothing to do.

**Amended again by M37.1 (a search over every field the document has):** two of the document's own
columns were searchable by nobody — the **description**, which is the one sentence saying what the
paper is, and the **place**, which is how half the archive is remembered ("that Podgorica thing").
They join the vector, description at `B` beside the prose it summarises and place at `C`, because a
city is a fact about a document and not what the document says. Recreated the same way, an
expression being unalterable in place:

```sql
ALTER TABLE documents DROP COLUMN search_vector;
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', translate(coalesce(title, ''), '_-.', '   ')), 'A') ||
    setweight(
      to_tsvector('simple', translate(coalesce(extracted_search_text, ''), '_-.', '   ')), 'A') ||
    setweight(to_tsvector('simple', translate(coalesce(description, ''), '_-.', '   ')), 'B') ||
    setweight(to_tsvector('simple', translate(coalesce(markdown, ''), '_-.', '   ')), 'B') ||
    setweight(
      to_tsvector(
        'simple',
        translate(coalesce(country, '') || ' ' || coalesce(city, ''), '_-.', '   ')
      ), 'C')
  ) STORED;
CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);

-- The names that live in other tables, indexed where they live (§4.4), by the same rule.
CREATE INDEX files_name_fts_idx ON files
  USING GIN (to_tsvector('simple', translate(name, '_-.', '   ')));
CREATE INDEX people_name_fts_idx ON people
  USING GIN (to_tsvector('simple', translate(name, '_-.', '   ')));
CREATE INDEX subjects_name_fts_idx ON subjects
  USING GIN (to_tsvector('simple', translate(name, '_-.', '   ')));
```

🔒 **`translate` is not decoration: it is the rule that lets what is stored meet what is typed.**
Postgres' parser reads `kadastar.pdf` as one `file` token and `IMG_0042.jpg` as one `img_0042.jpg`,
so an index built straight off a name answers only to that name typed out in full, extension
included — while people type `kadastar`, or `IMG_0042`, or the number off the act. `_`, `-` and `.`
therefore become separators on **both sides of every comparison**: here, in the three name indexes,
and in the query (`07 §7.3`), which must translate the caller's words by the same expression or the
index cannot serve it. It is why an uploaded document — whose title *is* its file name (`05 §5.1`) —
and a document number stored as `12-2019` became findable at all.

🔒 **A name is matched where it lives and is never copied onto the document.** The **file names** —
which is what a person types when they remember the scan and not the paper — and the names of the
**people** and **things** a document is about are rows in other tables, and a generated column can
only see its own row. The alternative was a projection column beside `extracted_search_text`,
rewritten whenever a file is attached, detached, replaced, split, combined or renamed and whenever a
person or a thing is renamed, merged or relinked: a dozen write paths, each of which silently makes
a document unfindable when it forgets, and one merge that renames somebody on a thousand documents
at once. The query joins the three tables instead (`07 §7.3`), each through a GIN index on the very
expression the query asks — so a rename is searchable the moment it is committed, and nothing can
drift because nothing is copied.

**Amended again by M41.1 (a number in either alphabet):** twelve Cyrillic capitals are drawn exactly
like Latin ones — `А В Е К М Н О Р С Т У Х` — which is why a Russian number plate is made of those
twelve and no others: they are the letters that read the same to a foreign camera. OCR keeps
whichever alphabet the glyph came from, so a VIN read off a Russian registration is stored as
`ХТА210700М0596136` with four Cyrillic letters inside it, and the person who types
`XTA210700M0596136` off their own papers gets an empty screen. The two strings are the same string on
the page; to Postgres they are two unrelated tokens. The same holds in reverse for a Serbian polis
printed in Latin and searched by somebody thinking in Russian.

```sql
-- The mapping, written once and in one direction each way; `translate` is per character, so the two
-- alphabets are given in the same order and the pairing reads down the column.
CREATE FUNCTION fold_to_latin(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'АВЕКМНОРСТУХавекмнорстух', 'ABEKMHOPCTYXabekmhopctyx') $$;
CREATE FUNCTION fold_to_cyrillic(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'ABEKMHOPCTYXabekmhopctyx', 'АВЕКМНОРСТУХавекмнорстух') $$;

-- Both readings of every identifier in the text, and nothing else.
CREATE FUNCTION homoglyph_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(string_agg(fold_to_latin(run) || ' ' || fold_to_cyrillic(run), ' '), '')
    FROM (
      SELECT match[1] AS run
      FROM regexp_matches($1, '[[:alnum:]]*[0-9][[:alnum:]]*', 'g') AS match
      WHERE match[1] ~ '[АВЕКМНОРСТУХавекмнорстухABEKMHOPCTYXabekmhopctyx]'
    ) AS runs $$;

-- How any text in this archive becomes searchable, said once.
CREATE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT to_tsvector('simple', translate($1, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins($1)) $$;

ALTER TABLE documents DROP COLUMN search_vector;
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(search_tokens(coalesce(title, '')), 'A') ||
    setweight(search_tokens(coalesce(extracted_search_text, '')), 'A') ||
    setweight(search_tokens(coalesce(description, '')), 'B') ||
    setweight(search_tokens(coalesce(markdown, '')), 'B') ||
    setweight(search_tokens(coalesce(country, '') || ' ' || coalesce(city, '')), 'C')
  ) STORED;
CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);

-- The names that live in other tables, by the same rule and through the same expression.
CREATE INDEX files_name_fts_idx    ON files    USING GIN (search_tokens(name));
CREATE INDEX people_name_fts_idx   ON people   USING GIN (search_tokens(name));
CREATE INDEX subjects_name_fts_idx ON subjects USING GIN (search_tokens(name));
```

🔒 **The fold is confined to alphanumeric runs that contain a digit**, because a run with a digit in
it is an identifier — a VIN, a plate, an account, the number off an act — and identifiers are what
people copy across keyboards. Words are left exactly as written: every letter of `Москва` has a Latin
look-alike, and folding words would index it as `Mockba`, make every Russian word answer to something
Latin, and turn `сор` and `cop` into one token. A digit is the cheap, honest signal that a string is
a number and not a word.

🔒 **Additive on the stored side, and the query is never folded.** `search_tokens` keeps every token
as written and adds its twins beside it, so nothing findable before this migration stopped being
findable and the ranking of ordinary prose did not move. The query (`07 §7.3`) therefore asks for the
words a person typed, in the alphabet they typed them in — which is what leaves `ts_headline` able to
mark them in the snippet. Folding the query instead would have found the same documents and lost the
highlight on every one of them.

`search_tokens` is the one expression both sides are written in: the generated column above, the
three name indexes, and every comparison in the search (`07 §7.3`) — an index is only usable by a
query that asks in the very expression it was built on, so there is exactly one place to change if
the rule ever changes again.

**Amended by M41.2 (the letters Serbian shares with Latin):** the twelve pairs were taken from a
Russian number plate, which is the right set for Russian and the wrong set for the rest of the
script. `Ј` (U+0408) is an everyday letter of the Serbian alphabet drawn exactly like a Latin `J`;
`Ѕ` (U+0405) and `І` (U+0406) are Macedonian and Ukrainian, but an OCR pass set to Cyrillic emits
either where a paper says `S` or `I`. All three join `fold_to_latin` / `fold_to_cyrillic` and the
test inside `homoglyph_twins`, making fifteen pairs:

```sql
CREATE OR REPLACE FUNCTION fold_to_latin(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'АВЕКМНОРСТУХЈЅІавекмнорстухјѕі', 'ABEKMHOPCTYXJSIabekmhopctyxjsi') $$;
```

🔒 **Replacing a function is not enough, and nothing warns you.** A stored generated column is not
recomputed when a function it calls changes, and an expression index is not rebuilt — Postgres has
no way to know either happened. Both would go on answering by the old mapping, silently and
indefinitely. Every migration that changes one of these functions therefore rebuilds
`documents.search_vector` and all four indexes exactly as they were created, and that is the rule for
any future change to them.

**Amended by M42.1 (the same street, spelled both ways):** this archive holds one address written
twice — `STANISLAVA SREMCEVICA 020A` on an invoice from a Belgrade parts shop and
`Stanislava Sremčevića 20/1` on the utility bill for the same flat. A person searching either
spelling found one of the two and had no way to learn the other existed. This is not the homoglyph
case: `č` and `c` are different letters that look different, and whether a paper carries the mark
depends on who typed it — a Serbian registry, a Turkish rental desk, or a system that could not.

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Both forms of `unaccent` are STABLE — each resolves its dictionary through `search_path` — so
-- neither may appear in a generated column or an index. The hand-declared IMMUTABLE wrapper is the
-- workaround PostgreSQL's own documentation prescribes; naming the dictionary is what makes the
-- declaration honest rather than a lie the planner will believe.
CREATE FUNCTION fold_diacritics(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT unaccent('unaccent'::regdictionary, $1) $$;

-- A second reading of every word that carries a mark, and nothing for the words that do not.
CREATE FUNCTION unaccented_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN fold_diacritics($1) = $1 THEN '' ELSE (
      SELECT coalesce(string_agg(folded, ' '), '')
      FROM (
        SELECT fold_diacritics(match[1]) AS folded, match[1] AS run
        FROM regexp_matches($1, '[[:alnum:]]+', 'g') AS match
      ) AS runs
      WHERE folded <> run
    ) END $$;

CREATE OR REPLACE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT to_tsvector('simple', translate($1, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins($1)) ||
           to_tsvector('simple', unaccented_twins($1)) $$;
```

🔒 **This one folds words, so both sides fold.** The homoglyph rule could leave the query untouched
because it stored both readings of every identifier; a mark cannot be put back — `c` could have been
`c`, `č` or `ć` — so the stored side folds the words it holds and the query (`07 §7.3`) gets a second
branch with its own marks removed. Each branch is the whole query, so what a person joined with a
space stays joined; the branches are OR-ed rather than the query replaced, which is what keeps the
first branch matching the text as written and the highlight landing on the word the paper spells.

The dictionary is `unaccent` rather than a hand-written table: it already knows Serbian `đ`, Turkish
`ı` and `ğ` and every Latin mark this archive has yet to meet, and it leaves Cyrillic exactly as it
is. The whole text is folded once before any word is looked at, so a document with no marks in it —
most of them — costs one comparison.

**Amended by M43.1 (one name, two scripts):** the owner of this archive is
`Шершнев Евгений Константинович` on every Russian paper in it and `SHERSHNEV EVGENII` on every
Serbian one — the same person, filed twice, and neither spelling reached the other. `Београд` and
`Beograd` are the same city. This is neither rule above it: `Б` looks nothing like `B`, so no fold of
glyphs joins them, and no mark is involved. It is **transliteration**, a mapping between alphabets,
which rewrites whole words and therefore has to be pointed at exactly what it is for.

Two mappings, because Cyrillic does not have one. **Serbian** Latin is the official bijective
companion of Serbian Cyrillic (`ц`→`c`, `ч`→`č`, `х`→`h`); **Russian** goes to Latin by the ICAO
passport rules (`ц`→`ts`, `ч`→`ch`, `х`→`kh`) — not a choice of taste but the spelling printed on
this archive's own documents. A Cyrillic word is stored under **both** readings rather than guessed
at, because guessing the language of a word is how an archive loses a document quietly. The Serbian
reading is folded through `fold_diacritics`, so `чачак` is reachable as `cacak` and not only `čačak`.

```sql
CREATE FUNCTION transliterate_serbian(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate(
      replace(replace(replace($1, 'љ', 'lj'), 'њ', 'nj'), 'џ', 'dž'),
      'абвгдђежзијклмнопрстћуфхцчш', 'abvgdđežzijklmnoprstćufhcčš') $$;

CREATE FUNCTION transliterate_russian(source text) RETURNS text  -- ICAO Doc 9303
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        $1, 'щ','shch'), 'ж','zh'), 'х','kh'), 'ц','ts'), 'ч','ch'),
        'ш','sh'), 'ъ','ie'), 'ю','iu'), 'я','ia'), 'ь',''),
      'абвгдеёзийклмнопрстуфыэ', 'abvgdeeziiklmnoprstufye') $$;

CREATE FUNCTION transliterated_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN $1 !~ '[Ѐ-ӿ]' THEN '' ELSE (
      SELECT coalesce(string_agg(DISTINCT reading, ' '), '')
      FROM (
        SELECT lower(match[1]) AS run
        FROM regexp_matches(left($1, 64000), '[[:alnum:]]{3,}', 'g') AS match
        WHERE match[1] ~ '[Ѐ-ӿ]'
      ) AS runs,
      LATERAL (VALUES
        (fold_diacritics(transliterate_serbian(run))),
        (transliterate_russian(run))
      ) AS readings(reading)
    ) END $$;
```

🔒 **Both functions require their input already lowercased.** `translate` is per character and the
mappings are written in lowercase only, so an uppercase Cyrillic letter would pass through untouched
and leave Cyrillic sitting inside a Latin word. `transliterated_twins` lowercases every run before
handing it over, and the result only ever reaches `to_tsvector('simple', …)`, which lowercases
anyway.

**Corrected by M43.2 (a bound that holds, and a floor that does).** Two of the three rules above were
written from reasoning rather than measurement, and both were wrong. What follows is what the schema
actually does.

🔒 **Four characters is the floor.** Three was chosen to keep the two-letter function words — `на`,
`он`, `но` — from becoming `na`, `on`, `no`, and it does exactly that while letting the three-letter
ones through: `год`→`god`, `сам`→`sam`, `дом`→`dom`, `нет`→`net`, `все`→`vse`, `как`→`kak`. `год` is
on every dated Russian paper and `сам` in every Serbian sentence, so a search for `god` answered with
half the archive. At four, what survives are cognates — `план`/`plan`, `дата`/`data`, `банк`/`bank`,
`тест`/`test` — which mean the same thing in both languages and are a match worth having. The
configuration is `simple` and has no stop words, so nothing else protects the archive from this.
Identifiers are unaffected: they carry digits and are `homoglyph_twins`' business.

🔒 **All three folds read the first 32 000 characters of a value, and that bound is load-bearing.** A
`tsvector` may not exceed 1 MB. The bound was first put on `transliterated_twins` alone, reasoning
that it fires on every word of every Cyrillic document while the other two fire only on the few
tokens carrying a digit or a mark — but that reasoning is about *frequency* and the ceiling is about
*size*. Serbian Latin prose is diacritic-dense and an OCR'd parts list is almost nothing but
identifiers, so all three reach whole-document amplification on exactly the papers this archive is
full of: measured, a 326 kB Serbian document indexed to 543 kB before any of this and to 1 060 kB
after. **Exceeding the ceiling is not a search that misses.** `search_vector` is `STORED`, so it is
computed on write: the document's markdown step fails and the OCR already paid for is thrown away —
and `ADD COLUMN … GENERATED … STORED` recomputes every existing row, so one stored document over the
line aborts a migration that runs on container start. A search that misses the tail of one long scan
is the smaller failure by a wide margin.

🔒 **A reading equal to the run it came from is not stored.** It is already in the vector these are
concatenated onto, so `fold_to_latin` of an all-Latin identifier was writing that token twice. With
the duplicates gone and the bound at 32 000, the identifier-dense worst case sits at 931 kB against
the ceiling where it was 1 240 kB. Note the ceiling itself predates all of this: 450 kB of entirely
distinct words already overflowed a plain `to_tsvector`.

32 000 characters covers every title, name, description and place — none come near it — and roughly a
dozen pages of prose. It is **not** where the names are: the people and things a document is about
are indexed in their own tables, whose rows are short and are folded whole, so a name the analysis
found is reachable in every script no matter how long the paper carrying it.

Two limits worth stating plainly, because nothing above implies them. A **fold carries no
highlight**: `ts_headline` marks the query against the text as written, so a document reached only
through a twin — `Sremcevica` finding `Sremčevića`, `Shershnev` finding `Шершнев` — comes back with a
snippet and no `<mark>` in it. And a **fold does not cross a phrase query**: twins are appended after
the text, so their positions do not sit beside their neighbours' and `"ulica sremcevica"` will not
match `Ulica Sremčevića`.

The query side (`07 §7.3`) carries the other direction, since the stored side only reads Cyrillic
*out*: somebody typing `Шершнев` reaches the Serbian paper that says `SHERSHNEV` through two further
branches, one per mapping.

```sql
-- 3) vector index (cosine)
CREATE INDEX document_chunks_embedding_idx ON document_chunks
  USING hnsw (embedding vector_cosine_ops);  -- vector(1024) since the bge-m3 migration (§4.5)

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

**The catalogue identity fold** (`03 §3.3.19`). The database is created with collation `C`, whose
`lower()` folds ASCII alone — so the `lower(name)` partial unique indexes on `people`,
`subjects` and `subject_kinds` never held for Cyrillic, and case-twins of one name lived beside
each other. Identity therefore moves onto stored `name_folded` columns, written by the application
(Unicode lowercase, whitespace collapsed) and backfilled once in the migration with the ICU
collation, which folds what `lower()` under `C` cannot:

```sql
ALTER TABLE people ADD COLUMN name_folded text NOT NULL DEFAULT '';
UPDATE people SET name_folded = btrim(regexp_replace(lower(name COLLATE "und-x-icu"), '\s+', ' ', 'g'));
CREATE INDEX people_name_folded_idx ON people (name_folded) WHERE deleted_at IS NULL;
-- likewise subjects (kind_id, name_folded) and subject_kinds (name_folded)
```

The indexes are **plain, not unique, on purpose**: the old ASCII-blind indexes admitted duplicates
that live in real instances, and a unique index cannot be built over rows that already violate it.
Uniqueness on the fold is enforced by the application on every write path meanwhile, and the unique
indexes land in a later migration once the duplicates are merged away (backlog M49) — at which
point the old `lower(name)` indexes retire with them.

## 4.4. Query patterns the schema must support (index rationale)

Every filter `GET /api/documents` takes (`07 §7.3`) is in this table, because a filter nothing serves
is a sequential scan of the archive on a request any signed-in user can repeat.

| Query | Served by |
|-------|-----------|
| scan: lookup by `(libraryId, path)` | `file_refs` unique index |
| dedup: `File` by `contentHash` | partial unique index |
| the pages of one document, in order | `document_pages` unique `(document_id, position)` |
| the documents a file is read by | `document_pages(file_id)` — an index and no longer a unique one: a file may be read by pages of any number of documents (ADR-025) |
| document list ordered by when Legere first saw it (`?sort=createdAt`) | `documents(created_at DESC)` |
| document list ordered by the date on the paper, undated first (`?sort=documentDate`) | `documents(document_date DESC NULLS FIRST, id DESC)` (raw SQL, §4.3) — a separate index from the `NULLS LAST` one below, which cannot be scanned backwards to produce it; `id` is in the index because a DATE ties constantly and the cursor needs the tiebreak to continue a page inside one day |
| document list ordered by when it last changed (`?sort=lastEventAt`) | `documents(last_event_at DESC)` — the denormalised newest journal entry (`03 §3.3.18`); `max(document_events.at)` is a correlated aggregate no index serves |
| filter by document type | `documents(type_id)` |
| filter by library | `file_refs(library_id, status)` + join through `document_pages` |
| availability and origin for a document | derived from the files its pages name: `document_pages(file_id)` + `file_refs(file_id)` |
| filter by person | `document_people(person_id)` index; the PK `(document_id, person_id)` closes the join |
| filter by subject | `document_subjects(subject_id)` index, PK `(document_id, subject_id)` |
| the people and subjects of a **page** of documents (`07 §7.3`, the card fields) | the same two PKs, read from the left: `document_id IN (…)` once per link table per page, never once per row |
| counting the shelves of a dimension (`GET /api/documents/groups`) | the index the same filter already uses, plus the grouped column: `documents(type_id)` and `documents(document_date …)` for `type` and `year`, the two partial place indexes for `country`/`city`, and `document_people`/`document_subjects` grouped by their own key for `person`/`subject`. Nothing new — every dimension is a column of the document or a link table whose PK holds the document once, which is exactly what makes its count a count of documents (`07 §7.3`) |
| filter by subject **kind** | the same two, then `subjects(kind_id)` — a kind needs no index of its own |
| filter/browse by year, "what happened in March" | `documents(document_date DESC NULLS LAST)` (raw SQL, §4.3) |
| filter by place | `documents(country) WHERE country IS NOT NULL`, `documents(city) WHERE city IS NOT NULL` — partial, because the analysis finds a place for only some documents and an index over the rest would be NULL entries nothing looks up (raw SQL, §4.3) |
| filter by pipeline step + status | none: five low-cardinality enum columns, and the queue screen's counters bound the answer |
| FTS: the document's own words | GIN on `search_vector`, query via `websearch_to_tsquery('simple', $1)` — title, extracted field values (via `extracted_search_text`), description, Markdown and place, all in the generated column (§4.3) |
| FTS: the names of what a document is made of and about | GIN on `to_tsvector('simple', name)` over `files`, `people` and `subjects` (§4.3) — one index scan per table, joined to the document through `document_pages` / `document_people` / `document_subjects` — the first of the three **distinct**, since one file may be read by several pages of one document. Deliberately not denormalised onto the document: a name is matched where it lives (§4.3) |
| semantic search | HNSW cosine on `document_chunks.embedding`, `ORDER BY embedding <=> $1 LIMIT k` |
| the links of one document, from either end | `document_links` unique `(a_id, b_id)` read from the left + the `(b_id)` index — one edge, findable from both sides |
| link suggestions: probing the archive for a document's identifiers (`05 §5.6b`) | the same GIN on `search_vector` — a probe is an ordinary FTS query |
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
- **Changing the embedding model is a migration and a full re-vectorization, and that is on purpose.**
  The column is `vector(1024)` — the width of the model this instance ships pointed at (`12 §12.4`) —
  and a vector of another width cannot live in it. Changing it means one migration that empties
  `document_chunks`, retypes the column, recreates the HNSW index and sets every document's
  vectorization step back to `PENDING`, which the hourly sweep of `05 §5.4` then walks through 200 at
  a time. 🔒 **Nothing is lost by that:** a chunk is derived data whose text was cut from the
  document's own Markdown, which stays where it is — re-embedding never re-reads a scan, never calls
  Docling, and costs one pass of the cheapest step in the pipeline. What bounds the choice is
  pgvector: `vector` holds up to 16 000 dimensions but **HNSW indexes at most 2 000**, so a
  3 072-wide model has to be truncated before it can be indexed at all.
- **Which model wrote a vector is stored beside it** (`document_chunks.model`, `03 §3.3.11`). Two
  models in one table is a search that quietly lies — cosine distance between vectors from different
  embedders is a number with no meaning — and without the column the only way to notice would be to
  remember. `/admin/queue` counts the chunks per model (`07 §7.3`) so a half-finished switch is
  visible on the screen that owns the pipeline.

## 4.6. Seed (dev)

`prisma/seed.ts` (dev/test only, idempotent):
- admin user `admin@legere.local` / password `password` (role ADMIN, language EN);
- regular user `user@legere.local` / password `password`;
- the default document type set (03 §3.3.12) — the same list is also inserted by production migration 1,
  so a fresh prod instance has document types out of the box — followed by the types added since,
  whose field schemas ship in the registry (03 §3.3.10a) and which a live instance's admin creates
  like any other;
- one library pointing at `LIBRARY_ROOT` (rootPath `""`, visibility ALL_USERS, enabled) — dev
  compose mounts `./dev-library` there;
- no documents — they appear via a real scan, which keeps the seed honest.

## 4.7. Open questions

None.
