# 04. Database Schema

PostgreSQL 16 + the `pgvector` extension. ORM — Prisma (client + migrations); DB access only in the
infrastructure layer. This document is the authoritative physical schema: implement `schema.prisma`
exactly as written here, plus the raw-SQL migration steps in §4.3.

Conventions: table/column names — `snake_case` via `@@map`/`@map`; Prisma model fields — `camelCase`;
enums stored as Postgres enums; money does not exist in this domain; time — `timestamptz` (Prisma
`DateTime @db.Timestamptz(6)`).

## 4.1. Prisma schema

The block below is `prisma/schema.prisma`, character for character, apart from the two-line header
that file carries naming this section. They are one artefact kept in two places, because somebody
asking whether a `Person` row is scoped to a user, or whether a link table cascades, or whether a
`DocumentType` slug has to be unique, must not have to read the implementation to find out. So the
answer to any difference between them is that both move together, in the same commit and in that
order — and because the block is whole and valid Prisma, that claim is checkable rather than
asserted: paste it into `prisma validate` and it parses.

```prisma
generator client {
  provider        = "prisma-client-js"
  // Required for the `extensions` datasource property below (pgvector, docs/04 §4.1).
  previewFeatures = ["postgresqlExtensions"]
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
  // An admin deleted the document these bytes were part of (docs/03 §3.3.9). The row survives as the
  // tombstone that keeps the next scan from ingesting the file again — the volume is read-only, so
  // this mark is the whole of what a deletion can do out there.
  EXCLUDED
}

enum FileOrigin {
  LIBRARY
  MANAGED
}

// How a file came to be in the trash (docs/03 §3.2, docs/05 §5.7a). Not who put it there but what
// happened to it, which is what decides whether there is a newer copy to compare it with.
enum TrashReason {
  REPLACED
  DOCUMENT_DELETED
  // The last page reading these bytes was taken out of a document that is still there (docs/05 §5.6).
  PAGE_REMOVED
}

enum StepStatus {
  // PENDING and QUEUED are the two halves of what used to be one word (docs/03 §3.3.10): QUEUED says
  // a job exists, PENDING says nothing is scheduled — which is what a migration that resets a step
  // leaves behind.
  PENDING
  QUEUED
  RUNNING
  DONE
  FAILED
  SKIPPED
}

// What can happen to a document, in the order a person would tell it (docs/03 §3.3.18).
enum DocumentEventType {
  CREATED
  FILE_ATTACHED
  FILE_MISSING
  QUEUED
  STEP_STARTED
  STEP_FINISHED
  META_CHANGED
  // An edge to another document, made or removed by a person (docs/03 §3.3.23); written on both.
  LINKED
  UNLINKED
}

// Where a value came from: nobody, the pipeline, or a person (docs/03 §3.3.10).
enum ValueSource {
  NONE
  AUTO
  MANUAL
}

// What shape the pages of the canonical take (docs/05 §5.5 step 1). AUTO reads it off the files.
enum PageFormat {
  AUTO
  A4
  MATCH_SOURCE
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
  updatedAt     DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt     DateTime? @map("deleted_at") @db.Timestamptz(6)

  sessions         Session[]
  apiTokens        ApiToken[]
  createdInvites   UserInvite[]      @relation("InviteCreator")
  acceptedInvites  UserInvite[]      @relation("InviteAcceptor")
  passwordResets   PasswordReset[]   @relation("ResetTarget")
  createdResets    PasswordReset[]   @relation("ResetCreator")
  documentLinks    DocumentLink[]
  libraryAccess    LibraryAccess[]
  collections      Collection[]
  collectionShares CollectionShare[]
  derivedDocuments Document[]
  documentEvents   DocumentEvent[]

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

// A read-only bearer credential its owner issues to a script (docs/03 §3.3.22, docs/08 §8.2a).
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

  // one active series per (email, purpose); new request replaces the row
  @@unique([email, purpose])
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
  updatedAt           DateTime          @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
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
  id                  String                   @id @default(uuid()) @db.Uuid
  pageCount           Int?                     @map("page_count")
  title               String
  // What this document is, for somebody who has never seen it (docs/03 §3.3.10). Null until the
  // analysis writes it, or where nobody has.
  description         String?
  markdown            String?
  searchVector        Unsupported("tsvector")? @map("search_vector")
  canonicalStatus     StepStatus               @default(QUEUED) @map("canonical_status")
  previewStatus       StepStatus               @default(QUEUED) @map("preview_status")
  markdownStatus      StepStatus               @default(QUEUED) @map("markdown_status")
  analysisStatus      StepStatus               @default(QUEUED) @map("analysis_status")
  fieldsStatus        StepStatus               @default(QUEUED) @map("fields_status")
  vectorizationStatus StepStatus               @default(QUEUED) @map("vectorization_status")
  processingError     String?                  @map("processing_error")
  skipReasons         Json                     @default("{}") @map("skip_reasons")
  // The typed fields of the document's type (docs/03 §3.3.10a): { schema: {slug, version}, values,
  // sources }. Null until the fields step first writes it or a person does. The search text beside
  // it is a projection of the searchable values, read by the search_vector generated column
  // (docs/04 §4.3) — rewritten whenever `extracted` is, never edited on its own.
  extracted           Json?
  extractedSearchText String?                  @map("extracted_search_text")
  languages           String[]                 @default([]) @map("languages")
  autoValues          Json                     @default("{}") @map("auto_values")
  // The date written on the document, not the day it was filed. A date, not a timestamp: a signing
  // has no clock (docs/03 §3.3.10).
  documentDate        DateTime?                @map("document_date") @db.Date
  country             String?                  @map("country")
  city                String?                  @map("city")
  failedStep          String?                  @map("failed_step")
  ocrUsed             Boolean                  @default(false) @map("ocr_used")
  // A file name is not a title anybody chose, so a fresh document is NONE and the analysis may name
  // it; a person titling it makes it MANUAL, and no machine touches it again (docs/03 §3.3.10).
  pageFormat          PageFormat               @default(AUTO) @map("page_format")
  titleSource         ValueSource              @default(NONE) @map("title_source")
  typeId              String?                  @map("type_id") @db.Uuid
  typeSource          ValueSource              @default(NONE) @map("type_source")
  createdById         String?                  @map("created_by_id") @db.Uuid
  createdAt           DateTime                 @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt           DateTime                 @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  // When this document last changed: the newest entry in its journal, whatever kind (docs/03
  // §3.3.18). Denormalised because ranking an archive by max(document_events.at) is a correlated
  // aggregate no index serves; maintained by the one method every event is written through. Never
  // null — a document with no journal at all reads as the moment it came into being.
  lastEventAt         DateTime                 @default(now()) @map("last_event_at") @db.Timestamptz(6)
  deletedAt           DateTime?                @map("deleted_at") @db.Timestamptz(6)

  documentType    DocumentType?     @relation(fields: [typeId], references: [id])
  createdBy       User?             @relation(fields: [createdById], references: [id])
  pages           DocumentPage[]
  chunks          DocumentChunk[]
  events          DocumentEvent[]
  people          DocumentPerson[]
  subjects        DocumentSubject[]
  collectionItems CollectionItem[]
  linksA          DocumentLink[]    @relation("DocumentLinkA")
  linksB          DocumentLink[]    @relation("DocumentLinkB")

  @@index([typeId])
  @@index([createdAt(sort: Desc)])
  // "When it last changed", newest first (docs/07 §7.1). Expressible here, unlike the document-date
  // order it sits beside, which needs NULLS FIRST and lives in raw SQL (docs/04 §4.3).
  @@index([lastEventAt(sort: Desc)])
  @@map("documents")
}

model DocumentEvent {
  id         String            @id @default(uuid()) @db.Uuid
  documentId String            @map("document_id") @db.Uuid
  type       DocumentEventType
  // Who did it; null is the pipeline acting on its own.
  actorId    String?           @map("actor_id") @db.Uuid
  // What the event needs to be readable: the step, the values that changed, the error.
  payload    Json              @default("{}")
  at         DateTime          @default(now()) @db.Timestamptz(6)

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  // Restricted, not the default SET NULL: null here is "the pipeline acting on its own", so a
  // database that nulled the column on a deleted user would reattribute that person's every action
  // to the machine rather than record that they are gone (docs/04 §4.2).
  actor    User?    @relation(fields: [actorId], references: [id], onDelete: Restrict)

  // The log is always read for one document, newest first.
  @@index([documentId, at(sort: Desc)])
  @@map("document_events")
}

// Two documents that belong together and stay two documents (docs/03 §3.3.23, ADR-023). An
// unordered pair — a_id < b_id always, checked in SQL (docs/04 §4.3) — hard-deleted on removal
// like a collection item, and cascading with a hard-deleted document.
model DocumentLink {
  id          String   @id @default(uuid()) @db.Uuid
  aId         String   @map("a_id") @db.Uuid
  bId         String   @map("b_id") @db.Uuid
  // The person who confirmed it; links are never machine-made (ADR-023).
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  a         Document @relation("DocumentLinkA", fields: [aId], references: [id], onDelete: Cascade)
  b         Document @relation("DocumentLinkB", fields: [bId], references: [id], onDelete: Cascade)
  createdBy User?    @relation(fields: [createdById], references: [id])

  @@unique([aId, bId])
  // One edge, findable from either end: the unique above serves a_id, this serves b_id.
  @@index([bId])
  @@map("document_links")
}

model DocumentChunk {
  id         String                      @id @default(uuid()) @db.Uuid
  documentId String                      @map("document_id") @db.Uuid
  index      Int
  content    String
  charCount  Int                         @map("char_count")
  embedding  Unsupported("vector(1024)")
  // Which embedder produced this vector (docs/03 §3.3.11). Two models in one table is a search whose
  // distances mean nothing, and this is what makes a half-finished switch visible. Null only on a
  // chunk written before the column existed.
  model      String?

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@unique([documentId, index])
  @@map("document_chunks")
}

// A person a document is about: the parties to a contract, the passenger on a ticket, the patient in
// a report (docs/03 §3.3.19). A shared catalogue, so the same person on forty documents is one row
// and renaming them fixes all forty.
model Person {
  id         String    @id @default(uuid()) @db.Uuid
  name       String
  // The identity fold (docs/03 §3.3.19): written by the application on every create and
  // rename; the C-collation database cannot compute it, but since M49.4 it enforces uniqueness
  // over it with a partial unique index on living rows (docs/04 §4.3).
  nameFolded String    @default("") @map("name_folded")
  // Anything that tells two people with the same name apart, in whatever words the owner likes.
  note       String?
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)

  documents DocumentPerson[]

  @@map("people")
}

model DocumentPerson {
  documentId String   @map("document_id") @db.Uuid
  personId   String   @map("person_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  person   Person   @relation(fields: [personId], references: [id], onDelete: Cascade)

  @@id([documentId, personId])
  @@index([personId])
  @@map("document_people")
}

// What a document is about: a flat, a car, a country (docs/03 §3.3.20). The kind says what sort of
// thing it is; the name says which one. A tax return is about a country, an insurance policy about a
// car — and both are the thing you want the document by.
// What sort of thing a subject is: "apartment", "car", "country" (docs/03 §3.3.20a). A catalogue
// rather than a string on every row — renaming a kind is then one edit rather than forty.
model SubjectKind {
  id         String    @id @default(uuid()) @db.Uuid
  name       String
  // The identity fold (docs/03 §3.3.19): written by the application on every create and
  // rename; the C-collation database cannot compute it, but since M49.4 it enforces uniqueness
  // over it with a partial unique index on living rows (docs/04 §4.3).
  nameFolded String    @default("") @map("name_folded")
  note       String?
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)

  subjects Subject[]

  @@map("subject_kinds")
}

model Subject {
  id         String    @id @default(uuid()) @db.Uuid
  kindId     String    @map("kind_id") @db.Uuid
  name       String
  // The identity fold (docs/03 §3.3.19): written by the application on every create and
  // rename; the C-collation database cannot compute it, but since M49.4 it enforces uniqueness
  // over it with a partial unique index on living rows (docs/04 §4.3).
  nameFolded String    @default("") @map("name_folded")
  note       String?
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)

  // Restricted rather than cascading: a kind still used by a living subject cannot be removed, and
  // a subject with no kind is not a thing anybody can file by (docs/03 §3.3.20a).
  kind      SubjectKind       @relation(fields: [kindId], references: [id], onDelete: Restrict)
  documents DocumentSubject[]

  @@index([kindId])
  @@map("subjects")
}

model DocumentSubject {
  documentId String   @map("document_id") @db.Uuid
  subjectId  String   @map("subject_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  subject  Subject  @relation(fields: [subjectId], references: [id], onDelete: Cascade)

  @@id([documentId, subjectId])
  @@index([subjectId])
  @@map("document_subjects")
}

model DocumentType {
  id          String    @id @default(uuid()) @db.Uuid
  slug        String
  name        String
  description String?
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
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
  updatedAt   DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
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
  // 🔒 Restricted, not the default SET NULL: null here is not "grantee unknown", it is the
  // instance-wide share (docs/03 §3.3.15). A database that nulled the column on a deleted user
  // would turn every private grant that user held into a grant to everybody, and the partial unique
  // index on (collection_id) WHERE grantee_user_id IS NULL would make the result look canonical.
  grantee    User?      @relation(fields: [granteeUserId], references: [id], onDelete: Restrict)

  @@map("collection_shares")
}

// The bytes themselves, once, however many places they turn up in (docs/03 §3.3.16, ADR-021).
model File {
  id            String       @id @default(uuid()) @db.Uuid
  contentHash   String       @map("content_hash")
  origin        FileOrigin
  storageKey    String?      @map("storage_key")
  mimeType      String       @map("mime_type")
  ext           String
  sizeBytes     BigInt       @map("size_bytes")
  name          String
  // How many pages are inside these bytes (docs/03 §3.3.16): an image is one, a PDF is what its page
  // tree says, an office document is what the converter laid it out as. Counted afresh by every
  // canonical build that opens the file, null until one has — and while it is null a document cannot
  // name the file's pages one by one, so it holds it as a single entry standing for it whole
  // (ADR-025). It is also what a page index is checked against, without a round trip to Stirling.
  pageCount     Int?         @map("page_count")
  // In the trash since, and how it got there (docs/05 §5.7a): a file with no live page anywhere is
  // in the trash, and the trash is where every file that leaves the last document reading it waits
  // to be deleted or restored. `trashedFrom` is the title the document had when it left — a record
  // and not a link, because that document is usually gone by the time anybody reads this.
  trashedAt     DateTime?    @map("trashed_at") @db.Timestamptz(6)
  trashedReason TrashReason? @map("trashed_reason")
  trashedFrom   String?      @map("trashed_from")
  // For REPLACED: the file that took this one's place. Every earlier copy of a page points at the
  // file in the document *now*, so "the versions of this page" stays one query however many times
  // the page is replaced (docs/03 §3.3.16).
  replacedById  String?      @map("replaced_by_id") @db.Uuid
  createdAt     DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime     @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt     DateTime?    @map("deleted_at") @db.Timestamptz(6)

  refs            FileRef[]
  pages           DocumentPage[]
  replacedBy      File?          @relation("FileVersions", fields: [replacedById], references: [id])
  earlierVersions File[]         @relation("FileVersions")

  // The trash is read newest first and swept by age; both are this index.
  @@index([trashedAt(sort: Desc)])
  @@index([replacedById])
  @@map("files")
}

// A document is an ordered list of pages (docs/03 §3.3.17, ADR-025): one page, read out of one file,
// standing a particular way up and showing a particular part of itself. The turn and the crop live
// here rather than on the file because they are answers about this page in this document — the same
// file may be read by pages of two documents, and a twenty-page scan has three pages lying sideways
// and not twenty.
model DocumentPage {
  id         String      @id @default(uuid()) @db.Uuid
  documentId String      @map("document_id") @db.Uuid
  position   Int
  fileId     String      @map("file_id") @db.Uuid
  // Which page of the file, by the file's own 0-based index. Null is "this file, whole, in the order
  // it arrived" — the entry a file takes while nobody has counted its pages, which the first
  // canonical build expands into one entry per page (docs/05 §5.5 step 1).
  pageIndex  Int?        @map("page_index")
  // Which way up this page lies: `{ quarterTurns: 0…3, mirrored: bool }`, the mirror first and the
  // quarter turns clockwise after it, null for the way it arrived. A mirror is offered only for a
  // page of an image. Never a change to the bytes — the build applies it after the crop.
  turn       Json?
  // The quadrilateral of what is worth keeping, normalized to 0…1 of the page, and who chose it. A
  // crop somebody dragged is MANUAL and no rebuild replaces it (docs/03 §3.3.17).
  crop       Json?
  cropSource ValueSource @default(NONE) @map("crop_source")

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  file     File     @relation(fields: [fileId], references: [id])

  @@unique([documentId, position])
  @@index([fileId])
  @@map("document_pages")
}

// Instance settings an admin changes at runtime (docs/03 §3.3.21): a key-value store, because these
// arrive one knob at a time and a migration per knob is a migration nobody wants to write. The env
// values remain the defaults; a row here is a deliberate override (docs/12 §12.4).
model Setting {
  key       String   @id
  value     Json
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("settings")
}
```

## 4.2. Notes on the Prisma schema

- `searchVector` and `embedding` use `Unsupported(...)` — Prisma cannot model them natively; they are
  written/queried via `$queryRaw`/`$executeRaw` in repositories, and created/altered via raw SQL in
  migrations (§4.3).
- BigInt columns (`size`, `sizeBytes`) are serialized to JSON as strings in DTOs (contract rule,
  [`07 §7.4`](./07-api-specification.md#74-dto-serialization)).
- `onDelete: Cascade` is used on what belongs to a document and cannot outlive it: `DocumentChunk`,
  `DocumentEvent`, `DocumentPerson`, `DocumentSubject`, `DocumentPage` and both ends of
  `DocumentLink`. Deleting a document for real (`03 §3.3.10`) is then one `DELETE` and not six, and —
  more to the point — no future statement can leave a chunk or a journal entry behind pointing at a
  row that is gone.
  **`CollectionItem` deliberately has none:** a collection is somebody else's list, and a document is
  taken off it by application code that knows it is doing so, not by a foreign key.
- **Six foreign keys carry `ON DELETE SET NULL`, and none of them may ever be one where NULL is an
  answer rather than the absence of one.** This is the rule, because Prisma's default for an optional
  relation *is* `SET NULL` — it is what you get by not choosing, and what you get by not choosing is
  a database that invents a value when a row goes away. Where null already means something, that is a
  silent rewrite of meaning; where it means "we no longer know", it is the truth. The six, and what
  null says in each:

  | Foreign key | What NULL means |
  |---|---|
  | `documents.type_id` → `document_types` | nobody has said what this document is (`03 §3.3.10`) |
  | `documents.created_by_id` → `users` | a library document: it arrived by a scan and nobody made it |
  | `document_links.created_by_id` → `users` | the person who confirmed the edge is no longer on the instance; the edge stands (`03 §3.3.23`) |
  | `file_refs.file_id` → `files` | the path has not been hashed yet, or the file it named is excluded (`03 §3.3.9`) |
  | `files.replaced_by_id` → `files` | nothing has taken this file's place (`03 §3.3.16`) |
  | `user_invites.accepted_by_id` → `users` | nobody has accepted the invite |

  🔒 Two more were `SET NULL` and are now `Restrict`, because in both of them NULL is a value with a
  meaning of its own. `collection_shares.grantee_user_id` NULL is the **instance-wide share**
  (`03 §3.3.15`), so a hard-deleted user's every private grant would silently become a grant to
  everybody — and `collection_shares_instance_active_uq` (§4.3) would make the result look like a row
  its owner had made on purpose. `document_events.actor_id` NULL is **the pipeline acting on its
  own** (`03 §3.3.18`), so the same `DELETE` would reattribute that person's whole history to the
  machine. No product code path hard-deletes a user and the `RESTRICT` edges from `sessions`,
  `api_tokens`, `collections`, `library_access`, `password_resets` and `user_invites.created_by_id`
  would refuse one — which is the only reason this was a landmine rather than a hole, and the reason
  it is defused here rather than described.
- Every other foreign key is `RESTRICT`: the database refuses the delete rather than repairing it,
  because everything else is deleted softly and in application code.
- **Every `updated_at` carries `@default(now())` beside `@updatedAt`.** Prisma writes the value on
  every create and update, so the default never decides anything at runtime; it is there so that a
  hand-written `INSERT` in a future migration cannot leave the column null, and so that the ten
  tables answer the question the same way. Five of them carried the default and five did not — an
  accident of which migration wrote the table, and one of the seven differences that kept
  `prisma migrate diff` from being usable as a gate (§4.3).
- pg-boss creates and evolves its objects in a separate `pgboss` schema; Prisma does not manage
  them. The owner-only `queue-migrate` one-shot applies those revisions. In the shipped deployment
  that same step creates/updates the four fixed queues and their partitions. The application role
  then operates them through table grants while the migrator retains ownership; runtime has no DDL
  or DDL-helper execution in either schema (SEC-43, [`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)).
  The admin queue view reads those objects through the `QueueMonitor` port (raw SQL), never via
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

**The known residue of `prisma migrate diff`.** Because the migration chain is hand-written, the one
mechanical proof that this document, `schema.prisma` and the live tables still describe one thing is

```
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

against a fully migrated database. It cannot be empty — the raw SQL above says things Prisma's schema
language cannot — so it is **exactly these five statements, and nothing else is acceptable**:

```sql
DROP INDEX "document_chunks_embedding_idx";
DROP INDEX "documents_document_date_idx";
DROP INDEX "documents_document_date_nulls_first_idx";
DROP INDEX "documents_search_vector_idx";
ALTER TABLE "documents" ALTER COLUMN "search_vector" DROP DEFAULT;
```

🔒 **Every one of them must never be run.** The four indexes are the HNSW vector index, the GIN
full-text index and the two document-date orders — Prisma proposes dropping them only because it did
not create them and cannot express them, and running the proposal turns semantic search, every search
query and the default document list into sequential scans of the archive on a request any signed-in
user can repeat (§4.4). The fifth is Prisma reading `search_vector`'s `GENERATED ALWAYS AS … STORED`
expression as a column default; dropping it would drop the whole of the full-text projection.

That is the point of writing the residue down. The output of this command is a list of statements
that look alike and are not: a line inside this allow-list is the price of raw SQL, and a line outside
it is drift and has to be explained or fixed before anything else ships. Until M47.17 it was seven
lines longer — a foreign key still carrying its pre-rename name and six columns whose defaults
`schema.prisma` did not declare — and the noise made the check unusable as a gate, which is how a
`schema.prisma` that no longer matched the documentation went unnoticed for a milestone (SEC-81,
SEC-82).

🔒 **And it is a gate rather than a habit.** `scripts/check-schema.mjs` runs both mechanical proofs —
this diff against the block above, and the fenced Prisma of §4.1 against `prisma/schema.prisma`
character for character — and `test/integration/schema-and-docs.integration.test.ts` is what makes
the suite, and therefore CI, run them. The script **reads the allow-list out of the SQL block above**
rather than carrying its own copy, so the five statements have one home and no change to the code can
quietly widen what the documentation says is acceptable; it is anchored on the sentence that
introduces the block, which is why that sentence is worded to be found. Both directions fail: a
statement the database emits that is not listed here is drift, and a statement listed here that the
database has stopped emitting is a note about the database that is no longer true. Run it by hand as

```
node scripts/check-schema.mjs
```

from a fully migrated `DATABASE_URL`; without one the diff half reports itself as skipped rather than
passing quietly, and the block half still runs.

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

The indexes shipped **plain, not unique, on purpose**: the old ASCII-blind indexes admitted
duplicates that lived in real instances, and a unique index cannot be built over rows that already
violate it. Uniqueness on the fold was the application's alone until the operator had merged those
duplicates away; then a later migration (backlog M49.4) replaced the plain fold indexes **and** the
old `lower(name)` unique indexes with partial unique indexes over the fold — `people
(name_folded)`, `subjects (kind_id, name_folded)`, `subject_kinds (name_folded)`, each `WHERE
deleted_at IS NULL`, so the soft-deleted twins every merge leaves behind stay out of the
namespace. The application's check still answers first with its named `409`; when two writers race
past it, the index picks a winner and the loser's `P2002` is mapped in the repositories to the same
`PERSON_EXISTS` / `SUBJECT_EXISTS` / `SUBJECT_KIND_EXISTS` rather than surfacing as a `500`.

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
| one page of a catalogue in a named order (`07 §7.3`: `lastDocumentAt`, `documents`, `things`, `name`) | **none, and deliberately**: every key but the name is an aggregate — `max(documents.document_date)` across the link table, or a count of it — which no index can order by, and the keyset is applied to the aggregated result. One page is one aggregation over the **living** catalogue plus a top-N sort, and what bounds it is the catalogue ceiling rather than the archive: 10 000 people, 20 000 subjects, 500 kinds (`08 §8.4`). Measured at those ceilings it is 60–120 ms, with a top-N heapsort and no full sort. The joins underneath are the ones above — `document_people(person_id)`, `document_subjects(subject_id)`, `subjects(kind_id)` — and `documents` is reached by primary key |
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
- 🔒 **A backfill that validates less than the code it replaces is a bug with a schedule.** The
  migration that turned `document_files` into `document_pages` (ADR-025) read each file's stored
  `page_order` and accepted it as an order if it was an array of that many non-negative whole
  numbers — where the build it was replacing also demanded that the indices be **distinct** and
  **below the page count**. `[0, 0, 2]` on a three-page file therefore became two entries for page 0
  and none for page 1, and `[0, 1, 5]` became an entry naming a page that does not exist, both
  breaking `03 §3.3.17`'s invariant on rows the application itself could never write. Unreachable
  through the API is not the test: a migration exists precisely for rows an older version or a person
  wrote by hand. The rule is repaired forward, in a migration of its own — an applied migration is
  never edited — which re-indexes each affected `(document, file)` group to the file's own page order
  in the positions it already occupies, exactly what the build would have read had the stored order
  been rejected. A `CHECK` keeps the impossible half impossible from now on.
- **A migration is finished when `prisma migrate diff` is back to its five known lines** (§4.3) and
  §4.1 quotes `schema.prisma` again — `node scripts/check-schema.mjs` asks both questions at once,
  and the test suite asks them on every run. The fix for anything else in that output is another
  migration, never an edit to the applied one.
  This is the whole of what a hand-written chain can offer in place of a generated one, so it is not
  optional: a defaulted foreign-key action and a column default nobody declared are precisely the
  things a person writing SQL by hand does not notice, and precisely the things this command names.
  🔒 **A referential action is a decision and is written out even when it is the default.** Prisma
  gives an optional relation `onDelete: SetNull` for free, which means an FK acquires it by nobody
  choosing — and where NULL is already an answer in that column, "SET NULL on delete" is a rule that
  rewrites meaning behind a `DELETE` that reads as clean-up (§4.2).
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
