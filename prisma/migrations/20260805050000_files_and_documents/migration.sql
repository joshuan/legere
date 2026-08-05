-- A file is not a document (docs/02 ADR-021, docs/03 §3.3.16–3.3.17, docs/05 §5.3).
--
-- The bytes move out of `documents` into `files`; a document becomes an ordered list of them.
-- Hand-written, like every migration here: Prisma's generator proposes dropping the FTS generated
-- column, the HNSW index and the partial uniques that docs/04 §4.3 installs, none of which the
-- Prisma schema can express.

-- The origin of a file's bytes.
CREATE TYPE "FileOrigin" AS ENUM ('LIBRARY', 'MANAGED');

CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "origin" "FileOrigin" NOT NULL,
    "storage_key" TEXT,
    "mime_type" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "crop" JSONB,
    "crop_source" "ValueSource" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_files" (
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("document_id", "position")
);

-- Deduplication moves one level down: one live file per content hash (ADR-009 at the file level).
CREATE UNIQUE INDEX "files_content_hash_active_uq" ON "files" ("content_hash") WHERE "deleted_at" IS NULL;
-- A file belongs to exactly one document.
CREATE UNIQUE INDEX "document_files_file_id_key" ON "document_files" ("file_id");

ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every existing document becomes a one-file document. The file id is the document id: it makes the
-- backfill self-evident and lets the legacy storage key be derived without a lookup table.
INSERT INTO "files" ("id", "content_hash", "origin", "storage_key", "mime_type", "ext", "size_bytes", "name", "crop_source", "created_at", "updated_at", "deleted_at")
SELECT
  d."id",
  d."content_hash",
  CASE WHEN d."source" = 'LIBRARY' THEN 'LIBRARY'::"FileOrigin" ELSE 'MANAGED'::"FileOrigin" END,
  -- Managed bytes keep the key they were written under: documents/{id}/source.{ext} (docs/09 §9.2).
  CASE WHEN d."source" = 'LIBRARY' THEN NULL
       ELSE 'documents/' || d."id"::text || '/source.' || CASE WHEN d."ext" = '' THEN 'bin' ELSE d."ext" END END,
  d."mime_type",
  d."ext",
  d."size_bytes",
  d."title" || CASE WHEN d."ext" = '' THEN '' ELSE '.' || d."ext" END,
  'NONE',
  d."created_at",
  d."updated_at",
  d."deleted_at"
FROM "documents" d;

INSERT INTO "document_files" ("document_id", "position", "file_id")
SELECT d."id", 0, d."id" FROM "documents" d;

-- A ref points at the file its bytes are, not at the document that reads them.
ALTER TABLE "file_refs" ADD COLUMN "file_id" UUID;
UPDATE "file_refs" SET "file_id" = "document_id" WHERE "document_id" IS NOT NULL;

ALTER TABLE "file_refs" DROP CONSTRAINT IF EXISTS "file_refs_document_id_fkey";
DROP INDEX IF EXISTS "file_refs_document_id_idx";
ALTER TABLE "file_refs" DROP COLUMN "document_id";

CREATE INDEX "file_refs_file_id_idx" ON "file_refs" ("file_id");
ALTER TABLE "file_refs" ADD CONSTRAINT "file_refs_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Scan sets are gone: a document made of many files is now the model itself (docs/05 §5.6).
-- Their result documents survive as ordinary one-file documents; drafts do not survive.
ALTER TABLE "documents" DROP COLUMN "scan_set_id";
DROP TABLE IF EXISTS "scan_set_items";
DROP TABLE IF EXISTS "scan_sets";
DROP TYPE IF EXISTS "ScanSetStatus";
DROP TYPE IF EXISTS "ScanSetCropMode";

-- What the bytes are is now a property of the file. `search_vector` is generated from title and
-- markdown only, so dropping these columns does not touch it.
DROP INDEX IF EXISTS "documents_content_hash_active_uq";
ALTER TABLE "documents"
  DROP COLUMN "content_hash",
  DROP COLUMN "mime_type",
  DROP COLUMN "ext",
  DROP COLUMN "size_bytes",
  DROP COLUMN "source";

DROP TYPE IF EXISTS "DocumentSource";

-- Every document must be rebuilt into a canonical PDF: until this release only office documents had
-- one, and now the canonical is what the viewer, the download and every step read (docs/05 §5.5).
UPDATE "documents"
   SET "canonical_status" = 'PENDING',
       "preview_status"   = 'PENDING',
       "markdown_status"  = 'PENDING',
       "page_count"       = NULL,
       "skip_reasons"     = "skip_reasons" - 'canonical' - 'preview' - 'markdown'
 WHERE "deleted_at" IS NULL;
