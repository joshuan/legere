-- A file remembers the order of its pages (docs/03 §3.3.16, docs/05 §5.5 step 1.1).
--
-- `page_order` is a permutation of the file's 0-based page indices — NULL meaning the order the
-- pages arrived in — and `page_count` is how many pages the last canonical build counted in it.
-- Both are meaningful only for a PDF, exactly as `crop` is meaningful only for an image, and
-- neither is ever a change to the file: the build reads the order and the bytes stay as they are.
--
-- Nullable and without a backfill on purpose. Every existing file reads as "the pages as they
-- arrived, and nobody has counted them yet", which is the truth: the count is written by the next
-- canonical build, and until it is, an order cannot be checked and is therefore not accepted
-- (docs/07 §7.3).

ALTER TABLE "files" ADD COLUMN "page_order" JSONB;
ALTER TABLE "files" ADD COLUMN "page_count" INTEGER;
