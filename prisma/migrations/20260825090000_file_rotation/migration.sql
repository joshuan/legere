-- A file remembers which way up it lies (docs/03 §3.3.16, docs/05 §5.5 step 1 and step 1.1).
--
-- `rotation` is `{ "quarterTurns": 0…3, "mirrored": bool }` for an image — the mirror first, left to
-- right, then that many quarter turns clockwise — and `page_rotations` is one quarter turn per page
-- for a PDF, as many entries as `page_count`, because a forty-page scan has three pages lying
-- sideways and not forty. Both sit beside `crop` and `page_order` and mean what those mean: an
-- instruction the canonical build reads, never an edit to the file. A LIBRARY original lies on a
-- read-only volume (ADR-007) and a MANAGED original stays the original somebody uploaded.
--
-- Nullable and without a backfill on purpose. Every existing file reads as "the way it arrived",
-- which is the truth: nothing has ever turned anything, and clearing a turn writes exactly this
-- NULL back.

ALTER TABLE "files" ADD COLUMN "rotation" JSONB;
ALTER TABLE "files" ADD COLUMN "page_rotations" JSONB;
