-- "Category" was always the wrong word for what it held: a document is a contract, an invoice, a
-- passport — that is its *type*. The name mattered little while it was the only classification;
-- it matters now that a document is also about people, a date and a subject, and "category" would
-- have to mean one of four things depending on who was reading (docs/03 §3.3.12).
--
-- The pipeline step is renamed with it: it stopped being categorization when it started reading
-- where a document is from, and it is about to read more.
--
-- Renames, not drops: everything in these tables is somebody's filing.
ALTER TYPE "CategorySource" RENAME TO "TypeSource";

ALTER TABLE "categories" RENAME TO "document_types";
ALTER INDEX IF EXISTS "categories_pkey" RENAME TO "document_types_pkey";
ALTER INDEX IF EXISTS "categories_slug_active_uq" RENAME TO "document_types_slug_active_uq";

ALTER TABLE "documents" RENAME COLUMN "category_id" TO "type_id";
ALTER TABLE "documents" RENAME COLUMN "category_source" TO "type_source";
ALTER TABLE "documents" RENAME COLUMN "categorization_status" TO "analysis_status";
ALTER INDEX IF EXISTS "documents_category_id_idx" RENAME TO "documents_type_id_idx";

-- The provenance of a machine-read value keeps the same shape, under the name the field now has.
UPDATE "documents"
   SET "auto_values" = ("auto_values" - 'categorySlug')
                       || jsonb_build_object('typeSlug', "auto_values" -> 'categorySlug')
 WHERE "auto_values" ? 'categorySlug';

-- Step statuses and skip reasons name their step; the ones already written keep pointing at it.
UPDATE "documents"
   SET "skip_reasons" = ("skip_reasons" - 'categorization')
                        || jsonb_build_object('analysis', "skip_reasons" -> 'categorization')
 WHERE "skip_reasons" ? 'categorization';

UPDATE "documents" SET "failed_step" = 'analysis' WHERE "failed_step" = 'categorization';

UPDATE "document_events"
   SET "payload" = ("payload" - 'step') || jsonb_build_object('step', 'analysis')
 WHERE "payload" ->> 'step' = 'categorization';
