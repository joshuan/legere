-- Search over every field the document has a word in (docs/04 §4.3, docs/07 §7.3).
--
-- Two of the document's own columns were searchable by nobody: the description, which is the one
-- sentence saying what the paper is, and the place, which is how half an archive is remembered.
-- They join the vector — description at B beside the prose it summarises, place at C, because a city
-- is a fact about a document and not something the document says.
--
-- A generated column's expression cannot be altered in place, so the column and its index are
-- rebuilt; the values are recomputed by Postgres as the column is created.
ALTER TABLE "documents" DROP COLUMN "search_vector";
ALTER TABLE "documents"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("extracted_search_text", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("markdown", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("country", '') || ' ' || coalesce("city", '')), 'C')
  ) STORED;
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");

-- The names that live in other tables, indexed where they live (docs/04 §4.3): what a document is
-- made of and what it is about. A generated column can only see its own row, and the alternative —
-- a projection column rewritten on every attach, detach, replace, split, combine, rename and merge —
-- is a dozen write paths, each of which makes a document silently unfindable the day it forgets. The
-- search joins these three tables instead, each through a GIN index on the very expression it asks.
CREATE INDEX "files_name_fts_idx" ON "files" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "people_name_fts_idx" ON "people" USING GIN (to_tsvector('simple', "name"));
CREATE INDEX "subjects_name_fts_idx" ON "subjects" USING GIN (to_tsvector('simple', "name"));
