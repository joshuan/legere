-- The words a person types are not the tokens Postgres stores (docs/04 §4.3, docs/07 §7.3).
--
-- The parser reads `kadastar.pdf` as one `file` token and `IMG_0042.jpg` as one `img_0042.jpg`, so
-- the migration before this one made file names searchable and left them answering only to the name
-- typed out in full, punctuation and extension included. Nobody searches like that: they type
-- `kadastar`, or `IMG_0042`, or the number off the act — and an archive that holds exactly that file
-- answers with an empty screen. The same held for every uploaded document, whose title *is* its file
-- name (docs/05 §5.1), and for a document number stored as `12-2019`.
--
-- `translate` makes `_`, `-` and `.` separators on both sides of every comparison: this vector, the
-- three name indexes, and the query itself (docs/07 §7.3). What is stored and what is asked for are
-- then tokenised by one rule, which is the only way the two can meet. Its own migration rather than
-- an edit of the one above, because that one has been applied and a migration that has run is a
-- record of what happened (docs/04 §4.5).
ALTER TABLE "documents" DROP COLUMN "search_vector";
ALTER TABLE "documents"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', translate(coalesce("title", ''), '_-.', '   ')), 'A') ||
    setweight(
      to_tsvector('simple', translate(coalesce("extracted_search_text", ''), '_-.', '   ')),
      'A'
    ) ||
    setweight(to_tsvector('simple', translate(coalesce("description", ''), '_-.', '   ')), 'B') ||
    setweight(to_tsvector('simple', translate(coalesce("markdown", ''), '_-.', '   ')), 'B') ||
    setweight(
      to_tsvector(
        'simple',
        translate(coalesce("country", '') || ' ' || coalesce("city", ''), '_-.', '   ')
      ),
      'C'
    )
  ) STORED;
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");

DROP INDEX "files_name_fts_idx";
DROP INDEX "people_name_fts_idx";
DROP INDEX "subjects_name_fts_idx";
CREATE INDEX "files_name_fts_idx" ON "files"
  USING GIN (to_tsvector('simple', translate("name", '_-.', '   ')));
CREATE INDEX "people_name_fts_idx" ON "people"
  USING GIN (to_tsvector('simple', translate("name", '_-.', '   ')));
CREATE INDEX "subjects_name_fts_idx" ON "subjects"
  USING GIN (to_tsvector('simple', translate("name", '_-.', '   ')));
