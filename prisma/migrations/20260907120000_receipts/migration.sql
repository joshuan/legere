-- Receipts are a product profile beside documents, sharing one stable archive identity (docs/15).
-- Existing documents are backfilled without changing their public ids.
CREATE TYPE "ArchiveItemKind" AS ENUM ('DOCUMENT', 'RECEIPT');

ALTER TYPE "TrashReason" ADD VALUE 'RECEIPT_DELETED';
ALTER TYPE "DocumentEventType" ADD VALUE 'KIND_CHANGED';

CREATE TABLE "archive_items" (
  "id" UUID NOT NULL,
  "kind" "ArchiveItemKind" NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_event_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "archive_items_pkey" PRIMARY KEY ("id")
);

INSERT INTO "archive_items" (
  "id", "kind", "created_by_id", "created_at", "updated_at", "last_event_at", "deleted_at"
)
SELECT
  "id", 'DOCUMENT'::"ArchiveItemKind", "created_by_id", "created_at", "updated_at",
  "last_event_at", "deleted_at"
FROM "documents";

ALTER TABLE "archive_items"
  ADD CONSTRAINT "archive_items_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "archive_items_kind_created_at_id_idx"
  ON "archive_items" ("kind", "created_at" DESC, "id" DESC);
CREATE INDEX "archive_items_created_by_id_kind_idx"
  ON "archive_items" ("created_by_id", "kind");
CREATE INDEX "archive_items_last_event_at_idx" ON "archive_items" ("last_event_at" DESC);

-- The document columns remain as a compatibility projection while the mature document read model
-- is moved independently. This trigger makes archive_items canonical for lifecycle writes made by
-- existing document code during that transition.
CREATE FUNCTION "sync_document_archive_item"() RETURNS trigger AS $$
BEGIN
  UPDATE "archive_items"
     SET "created_by_id" = NEW."created_by_id",
         "created_at" = NEW."created_at",
         "updated_at" = NEW."updated_at",
         "last_event_at" = NEW."last_event_at",
         "deleted_at" = NEW."deleted_at"
   WHERE "id" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Compatibility for maintenance scripts and older test fixtures which insert documents directly:
-- mint the shared identity before the profile row is checked by its foreign key.
CREATE FUNCTION "ensure_document_archive_item"() RETURNS trigger AS $$
BEGIN
  -- Prisma normally expands @default(uuid()) client-side, but old unchecked fixtures and migration
  -- scripts may omit the id at the SQL boundary. The profile and its shared identity must receive
  -- the same value before either NOT NULL/FK check runs.
  IF NEW."id" IS NULL THEN
    NEW."id" := gen_random_uuid();
  END IF;
  INSERT INTO "archive_items" (
    "id", "kind", "created_by_id", "created_at", "updated_at", "last_event_at", "deleted_at"
  ) VALUES (
    NEW."id", 'DOCUMENT', NEW."created_by_id", NEW."created_at", NEW."updated_at",
    NEW."last_event_at", NEW."deleted_at"
  ) ON CONFLICT ("id") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "documents_ensure_archive_item"
BEFORE INSERT ON "documents"
FOR EACH ROW EXECUTE FUNCTION "ensure_document_archive_item"();

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_id_fkey"
  FOREIGN KEY ("id") REFERENCES "archive_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "documents_sync_archive_item"
AFTER INSERT OR UPDATE OF
  "created_by_id", "created_at", "updated_at", "last_event_at", "deleted_at"
ON "documents"
FOR EACH ROW EXECUTE FUNCTION "sync_document_archive_item"();

CREATE TABLE "receipts" (
  "id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "page_count" INTEGER,
  "preview_status" "StepStatus" NOT NULL DEFAULT 'QUEUED',
  "extraction_status" "StepStatus" NOT NULL DEFAULT 'QUEUED',
  "extracted" JSONB,
  "source_text" TEXT,
  "processing_error" TEXT,
  "failed_step" TEXT,
  "skip_reasons" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipts_file_id_key" ON "receipts" ("file_id");
CREATE INDEX "receipts_preview_status_idx" ON "receipts" ("preview_status");
CREATE INDEX "receipts_extraction_status_idx" ON "receipts" ("extraction_status");

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_id_fkey"
  FOREIGN KEY ("id") REFERENCES "archive_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A receipt can only own an original Legere manages and must always have an owner.
CREATE FUNCTION "check_receipt_storage"() RETURNS trigger AS $$
DECLARE
  owner_id UUID;
  file_origin "FileOrigin";
  file_key TEXT;
BEGIN
  SELECT "created_by_id" INTO owner_id FROM "archive_items" WHERE "id" = NEW."id";
  SELECT "origin", "storage_key" INTO file_origin, file_key FROM "files" WHERE "id" = NEW."file_id";
  IF owner_id IS NULL OR file_origin IS DISTINCT FROM 'MANAGED' OR file_key IS NULL THEN
    RAISE EXCEPTION 'receipt % requires an owner and a managed stored file', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "receipts_check_storage"
BEFORE INSERT OR UPDATE OF "id", "file_id" ON "receipts"
FOR EACH ROW EXECUTE FUNCTION "check_receipt_storage"();

ALTER TABLE "document_events"
  DROP CONSTRAINT "document_events_document_id_fkey";
ALTER TABLE "document_events"
  RENAME COLUMN "document_id" TO "archive_item_id";
DROP INDEX "document_events_document_id_at_idx";
CREATE INDEX "document_events_archive_item_id_at_idx"
  ON "document_events" ("archive_item_id", "at" DESC);
ALTER TABLE "document_events"
  ADD CONSTRAINT "document_events_archive_item_id_fkey"
  FOREIGN KEY ("archive_item_id") REFERENCES "archive_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "files"
  ADD COLUMN "trashed_archive_kind" "ArchiveItemKind",
  ADD COLUMN "trashed_owner_id" UUID;
