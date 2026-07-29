-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('EN', 'RU');

-- CreateEnum
CREATE TYPE "Theme" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

-- CreateEnum
CREATE TYPE "LibraryVisibility" AS ENUM ('ALL_USERS', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "FileRefStatus" AS ENUM ('DISCOVERED', 'HASHED', 'MISSING');

-- CreateEnum
CREATE TYPE "DocumentSource" AS ENUM ('LIBRARY', 'DERIVED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('NONE', 'AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScanSetStatus" AS ENUM ('DRAFT', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('REGISTRATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "ScanSetCropMode" AS ENUM ('TRIM', 'NONE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "language" "Language" NOT NULL DEFAULT 'EN',
    "theme" "Theme" NOT NULL DEFAULT 'SYSTEM',
    "deactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "ticket_hash" TEXT,
    "ticket_expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "invite_id" UUID,
    "password_reset_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invites" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "email_hint" TEXT,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "libraries" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "visibility" "LibraryVisibility" NOT NULL DEFAULT 'RESTRICTED',
    "scan_interval_minutes" INTEGER NOT NULL DEFAULT 15,
    "exclude_globs" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_access" (
    "library_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_access_pkey" PRIMARY KEY ("library_id","user_id")
);

-- CreateTable
CREATE TABLE "scan_runs" (
    "id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "status" "ScanRunStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "files_seen" INTEGER NOT NULL DEFAULT 0,
    "files_new" INTEGER NOT NULL DEFAULT 0,
    "files_changed" INTEGER NOT NULL DEFAULT 0,
    "files_missing" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_refs" (
    "id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtime" TIMESTAMPTZ(6) NOT NULL,
    "status" "FileRefStatus" NOT NULL,
    "content_hash" TEXT,
    "document_id" UUID,
    "missing_since" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "source" "DocumentSource" NOT NULL,
    "mime_type" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "page_count" INTEGER,
    "title" TEXT NOT NULL,
    "markdown" TEXT,
    "canonical_status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "preview_status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "markdown_status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "categorization_status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "vectorization_status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "processing_error" TEXT,
    "failed_step" TEXT,
    "ocr_used" BOOLEAN NOT NULL DEFAULT false,
    "category_id" UUID,
    "category_source" "CategorySource" NOT NULL DEFAULT 'NONE',
    "created_by_id" UUID,
    "scan_set_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_items" (
    "collection_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("collection_id","document_id")
);

-- CreateTable
CREATE TABLE "collection_shares" (
    "id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "grantee_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "collection_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_sets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "status" "ScanSetStatus" NOT NULL DEFAULT 'DRAFT',
    "crop_mode" "ScanSetCropMode" NOT NULL DEFAULT 'TRIM',
    "result_document_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "scan_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_set_items" (
    "scan_set_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "document_id" UUID NOT NULL,

    CONSTRAINT "scan_set_items_pkey" PRIMARY KEY ("scan_set_id","position")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_ticket_hash_key" ON "email_verifications"("ticket_hash");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_email_purpose_key" ON "email_verifications"("email", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_hash_key" ON "user_invites"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- CreateIndex
CREATE INDEX "scan_runs_library_id_started_at_idx" ON "scan_runs"("library_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "file_refs_document_id_idx" ON "file_refs"("document_id");

-- CreateIndex
CREATE INDEX "file_refs_library_id_status_idx" ON "file_refs"("library_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "file_refs_library_id_path_key" ON "file_refs"("library_id", "path");

-- CreateIndex
CREATE INDEX "documents_category_id_idx" ON "documents"("category_id");

-- CreateIndex
CREATE INDEX "documents_created_at_idx" ON "documents"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_index_key" ON "document_chunks"("document_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "scan_sets_result_document_id_key" ON "scan_sets"("result_document_id");

-- CreateIndex
CREATE INDEX "scan_sets_created_by_id_idx" ON "scan_sets"("created_by_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_access" ADD CONSTRAINT "library_access_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_access" ADD CONSTRAINT "library_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_refs" ADD CONSTRAINT "file_refs_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "libraries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_refs" ADD CONSTRAINT "file_refs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_shares" ADD CONSTRAINT "collection_shares_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_shares" ADD CONSTRAINT "collection_shares_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sets" ADD CONSTRAINT "scan_sets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sets" ADD CONSTRAINT "scan_sets_result_document_id_fkey" FOREIGN KEY ("result_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_set_items" ADD CONSTRAINT "scan_set_items_scan_set_id_fkey" FOREIGN KEY ("scan_set_id") REFERENCES "scan_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_set_items" ADD CONSTRAINT "scan_set_items_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Raw SQL required by docs/04 §4.3 (appended to the generated DDL, in order).
-- ---------------------------------------------------------------------------

-- 2) FTS: generated column + index (Prisma sees the column as Unsupported).
-- The 'simple' configuration is deliberate: content is mixed ru/en (and OCR
-- output); a language-specific stemmer would mis-stem half of it.
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(markdown, '')), 'B')
  ) STORED;
CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);

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

-- ---------------------------------------------------------------------------
-- Default category set (docs/04 §4.6, docs/03 §3.3.12) so a fresh production
-- instance has categories out of the box. Editable later; idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO categories (id, slug, name, description, created_at, updated_at) VALUES
  (gen_random_uuid(), 'passport',    'Passport',    'Passports and travel documents.',                       now(), now()),
  (gen_random_uuid(), 'id-card',     'ID card',     'National ID cards, driver licenses, permits.',          now(), now()),
  (gen_random_uuid(), 'contract',    'Contract',    'Agreements, contracts, addenda.',                       now(), now()),
  (gen_random_uuid(), 'invoice',     'Invoice',     'Invoices and bills issued or received.',                now(), now()),
  (gen_random_uuid(), 'receipt',     'Receipt',     'Purchase receipts and payment confirmations.',          now(), now()),
  (gen_random_uuid(), 'certificate', 'Certificate', 'Certificates, diplomas, registrations.',                now(), now()),
  (gen_random_uuid(), 'medical',     'Medical',     'Medical records, prescriptions, test results.',         now(), now()),
  (gen_random_uuid(), 'financial',   'Financial',   'Bank statements, tax filings, financial reports.',      now(), now()),
  (gen_random_uuid(), 'manual',      'Manual',      'Manuals, instructions, technical documentation.',       now(), now()),
  (gen_random_uuid(), 'letter',      'Letter',      'Letters and official correspondence.',                  now(), now()),
  (gen_random_uuid(), 'other',       'Other',       'Documents that do not fit any other category.',         now(), now())
ON CONFLICT DO NOTHING;
