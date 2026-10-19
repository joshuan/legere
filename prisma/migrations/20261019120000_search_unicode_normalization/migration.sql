-- Compose equivalent Unicode spellings before tokenization and alternative readings (M84.1).
-- In particular, a decomposed Cyrillic й must not become two separate search tokens.
CREATE OR REPLACE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    WITH normalized AS MATERIALIZED (SELECT normalize($1, NFC) AS value)
    SELECT to_tsvector('simple', translate(value, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins(value)) ||
           to_tsvector('simple', unaccented_twins(value)) ||
           to_tsvector('simple', transliterated_twins(value))
    FROM normalized
  $$;

-- Stored vectors and expression indexes do not refresh when their function changes.
-- Rebuild both for the existing archive without changing original text or running OCR/AI.
ALTER TABLE "documents" DROP COLUMN "search_vector";
ALTER TABLE "documents"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(search_tokens(coalesce("title", '')), 'A') ||
    setweight(search_tokens(coalesce("extracted_search_text", '')), 'A') ||
    setweight(search_tokens(coalesce("description", '')), 'B') ||
    setweight(search_tokens(coalesce("markdown", '')), 'B') ||
    setweight(search_tokens(coalesce("country", '') || ' ' || coalesce("city", '')), 'C')
  ) STORED;
CREATE INDEX "documents_search_vector_idx" ON "documents" USING GIN ("search_vector");

DROP INDEX "files_name_fts_idx";
DROP INDEX "people_name_fts_idx";
DROP INDEX "subjects_name_fts_idx";
CREATE INDEX "files_name_fts_idx" ON "files" USING GIN (search_tokens("name"));
CREATE INDEX "people_name_fts_idx" ON "people" USING GIN (search_tokens("name"));
CREATE INDEX "subjects_name_fts_idx" ON "subjects" USING GIN (search_tokens("name"));
