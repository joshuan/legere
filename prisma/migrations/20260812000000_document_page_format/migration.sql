-- What shape the pages of the canonical take (docs/05 §5.5 step 1). AUTO reads it off the files the
-- document is made of: pages that are sheet-shaped become A4 in their own orientation, and the ones
-- that are not — a receipt, a panorama, a square — keep the shape they were photographed in.
CREATE TYPE "PageFormat" AS ENUM ('AUTO', 'A4', 'MATCH_SOURCE');

ALTER TABLE "documents"
  ADD COLUMN "page_format" "PageFormat" NOT NULL DEFAULT 'AUTO';

-- Every canonical built before this release was laid on a portrait A4 whatever it was made from, and
-- a page that is half white margin is a page OCR reads as blank. Those documents have to be built
-- again — the canonical, the preview taken from it, and the text nobody could extract the first time.
UPDATE "documents"
   SET "canonical_status" = 'PENDING',
       "preview_status"   = 'PENDING',
       "markdown_status"  = 'PENDING',
       "skip_reasons"     = "skip_reasons" - 'canonical' - 'preview' - 'markdown'
 WHERE "deleted_at" IS NULL;
