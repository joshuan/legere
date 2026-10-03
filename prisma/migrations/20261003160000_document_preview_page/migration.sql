ALTER TABLE "documents"
  ADD COLUMN "preview_page_id" UUID,
  ADD COLUMN "canonical_page_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "preview_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "documents" ADD CONSTRAINT "documents_preview_page_id_fkey"
  FOREIGN KEY ("preview_page_id") REFERENCES "document_pages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing completed PDFs have one page per expanded entry. Only backfill an unambiguous map;
-- the next canonical build establishes the map for incomplete or not-yet-expanded documents.
UPDATE "documents" AS d
SET "canonical_page_ids" = held.ids
FROM (
  SELECT "document_id", array_agg("id" ORDER BY "position") AS ids
  FROM "document_pages"
  WHERE "page_index" IS NOT NULL
  GROUP BY "document_id"
) AS held
WHERE d.id = held.document_id AND d.canonical_status = 'DONE'
  AND cardinality(held.ids) = d.page_count;
