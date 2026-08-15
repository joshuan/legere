-- Typed fields (docs/03 §3.3.10a, ADR-022): a sixth pipeline step fills the schema a document's
-- type carries, and the searchable values join the FTS vector.

ALTER TABLE "documents"
  ADD COLUMN "fields_status" "StepStatus" NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "extracted" JSONB,
  ADD COLUMN "extracted_search_text" TEXT;

-- The archive predates the step. Documents whose type carries a schema genuinely await it — PENDING,
-- for the hourly sweep to walk through over the following hours (docs/05 §5.4). Everything else has
-- nothing to wait for, and a step that reads as unstarted on a document it will never run for would
-- make the whole archive read as "processing" (docs/04 §4.3): SKIPPED, saying why. The slugs are the
-- registry as of this migration — a snapshot, which is what a forward-only migration is.
UPDATE "documents"
   SET "fields_status" = 'PENDING'
 WHERE "deleted_at" IS NULL
   AND "type_id" IN (
     SELECT "id" FROM "document_types"
      WHERE "slug" IN ('receipt', 'passport', 'id-card') AND "deleted_at" IS NULL
   );

UPDATE "documents"
   SET "fields_status" = 'SKIPPED',
       "skip_reasons"  = coalesce("skip_reasons", '{}'::jsonb) || '{"fields": "NO_SCHEMA"}'::jsonb
 WHERE "fields_status" = 'QUEUED';

-- The FTS vector gains the searchable extracted values, at weight A: a field the model read off the
-- paper is as precise a hit as the title (docs/04 §4.3). A generated column's expression cannot be
-- altered in place, so the column and its index are rebuilt.
ALTER TABLE "documents" DROP COLUMN "search_vector";
ALTER TABLE "documents"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("extracted_search_text", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("markdown", '')), 'B')
  ) STORED;
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");
