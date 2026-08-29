-- A stored page order was a permutation or it was nothing (docs/03 §3.3.17, docs/04 §4.5).
--
-- The migration that turned `document_files` into `document_pages` (ADR-025) read each file's stored
-- `page_order` and accepted it as an order when it was an array of `page_count` non-negative whole
-- numbers. The build it replaced demanded more of the same list — `isPagePermutation` also required
-- the indices to be **distinct** and **below the page count** — so two orders the old code would have
-- thrown away were written into rows instead:
--
--   * `[0, 0, 2]` on a three-page file became two entries for page 0 and none for page 1;
--   * `[0, 1, 5]` on a three-page file became an entry naming a page the file does not have.
--
-- Both break the invariant of `03 §3.3.17` (`0 ≤ page_index < File.page_count`, one entry per page),
-- and neither is reachable through the API — which is not the test: a migration exists precisely for
-- rows an older version or a person wrote by hand, and this one ran against real databases. An
-- applied migration is never edited (docs/04 §4.5), so the rule is repaired forward, here.
--
-- 🔒 **What is repaired, and nothing else.** Only a group that could have come from the order branch:
-- the entries of one file in one document, exactly as many of them as the file has pages, none of
-- them standing for the file whole, whose indices are not the file's own pages once each. That is the
-- shape the order branch always produced and the shape no other branch can produce — the "counted
-- file with no order" branch writes `0…n-1` by construction, and a document holding a *subset* of a
-- file's pages (a split at a page) has fewer entries than the file has pages, so it is not touched.
-- The repair gives those entries the file's own page order in the positions they already occupy,
-- which is exactly what the build would have read had the stored order been rejected.
--
-- Nothing is deleted and nothing is invented: the group keeps its size, its place in the document and
-- its crops and turns, and only which page of the file each entry names is rewritten.

WITH grouped AS (
    SELECT dp.document_id,
           dp.file_id,
           f.page_count,
           count(*) AS entries,
           count(*) FILTER (WHERE dp.page_index IS NULL) AS whole_file_entries,
           count(DISTINCT dp.page_index) AS distinct_pages,
           max(dp.page_index) AS highest,
           min(dp.page_index) AS lowest
    FROM "document_pages" dp
    JOIN "files" f ON f.id = dp.file_id
    WHERE f.page_count IS NOT NULL AND f.page_count > 0
    GROUP BY dp.document_id, dp.file_id, f.page_count
),
broken AS (
    SELECT document_id, file_id
    FROM grouped
    WHERE whole_file_entries = 0
      -- As many entries as the file has pages: the only shape the stored-order branch produced.
      AND entries = page_count
      -- And not the file's own pages once each: a duplicate, a gap, or a page it does not have.
      AND (distinct_pages <> entries OR highest >= page_count OR lowest < 0)
),
renumbered AS (
    SELECT dp.id,
           (row_number() OVER (PARTITION BY dp.document_id, dp.file_id
                                   ORDER BY dp.position) - 1)::int AS page_index
    FROM "document_pages" dp
    JOIN broken b ON b.document_id = dp.document_id AND b.file_id = dp.file_id
)
UPDATE "document_pages" dp
SET "page_index" = r.page_index
FROM renumbered r
WHERE r.id = dp.id;

-- And the half of the invariant a column can hold on its own from now on. The other half —
-- `page_index < File.page_count` — spans two tables and stays where it already is: the application
-- checks it on every write (`isPagePermutation`, `assertPagesOf`) and the canonical build skips an
-- entry naming a page its file does not have rather than failing the document (docs/05 §5.5 step 1).
--
-- Valid over the rows that are already here: the migration this repairs rejected any element that
-- was not `^[0-9]+$`, so a negative index was never written, and no route can write one.
-- `CHECK` constraints are invisible to `prisma migrate diff`, so the known residue of `04 §4.3`
-- stays at its five lines.
ALTER TABLE "document_pages"
    ADD CONSTRAINT "document_pages_page_index_non_negative"
    CHECK ("page_index" IS NULL OR "page_index" >= 0);
