-- A number is findable in the alphabet it is typed in, not the one it was printed in (docs/04 §4.3,
-- docs/07 §7.3).
--
-- Twelve Cyrillic capitals are drawn exactly like Latin ones — А В Е К М Н О Р С Т У Х — which is
-- why a Russian number plate is made of those twelve and no others: they are the letters that read
-- the same to a foreign camera. OCR keeps whichever alphabet the glyph came from, so a VIN read off
-- a Russian registration is stored as `ХТА210700М0596136` with four Cyrillic letters inside it, and
-- the person who types `XTA210700M0596136` off their own papers gets an empty screen. The two
-- strings are the same string on the page; to Postgres they are two unrelated tokens. The same holds
-- in reverse for a Serbian polis printed in Latin and searched by somebody thinking in Russian.
--
-- The fold is confined to alphanumeric runs that contain a digit, because a run with a digit in it
-- is an identifier — a VIN, a plate, an account, the number off an act — and identifiers are what
-- people copy across keyboards. Words are left exactly as written: `Москва` is never quietly indexed
-- as `Mockba`, and no Latin word can be made to match a Russian one by folding.
--
-- 🔒 Additive, never in place. `search_tokens` keeps every token as written and adds its twins
-- beside it, so nothing findable yesterday stops being findable, and the query keeps asking for the
-- words a person actually typed — which is what keeps `ts_headline` marking them.

-- The mapping, written once and in one direction each way. `translate` is per character, and the two
-- alphabets are given in the same order, so the pairing is readable down the column.
CREATE FUNCTION fold_to_latin(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'АВЕКМНОРСТУХавекмнорстух', 'ABEKMHOPCTYXabekmhopctyx')
  $$;

CREATE FUNCTION fold_to_cyrillic(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'ABEKMHOPCTYXabekmhopctyx', 'АВЕКМНОРСТУХавекмнорстух')
  $$;

-- Both readings of every identifier in the text, and nothing else. A run without a digit is a word
-- and is left alone; a run without a look-alike letter reads the same either way and adds nothing.
CREATE FUNCTION homoglyph_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(
      string_agg(fold_to_latin(run) || ' ' || fold_to_cyrillic(run), ' '),
      ''
    )
    FROM (
      SELECT match[1] AS run
      FROM regexp_matches($1, '[[:alnum:]]*[0-9][[:alnum:]]*', 'g') AS match
      WHERE match[1] ~ '[АВЕКМНОРСТУХавекмнорстухABEKMHOPCTYXabekmhopctyx]'
    ) AS runs
  $$;

-- 🔒 How any text in this archive becomes searchable, said once. Underscore, hyphen and dot are
-- separators (the migration before this one), and every identifier is stored in both alphabets. The
-- query (docs/07 §7.3) is compared against this and must never be folded itself: the twins are here
-- so that the words a person typed can be left exactly as they typed them.
CREATE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT to_tsvector('simple', translate($1, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins($1))
  $$;

-- A generated column's expression cannot be altered in place, so the column and its index are
-- rebuilt and Postgres recomputes every row as the column is created (docs/04 §4.3).
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

-- The names that live in other tables, by the same rule — a scan called `ХТА210700М.pdf` answers to
-- the VIN off the registration. The index is on the expression the query asks, or it cannot serve it.
DROP INDEX "files_name_fts_idx";
DROP INDEX "people_name_fts_idx";
DROP INDEX "subjects_name_fts_idx";
CREATE INDEX "files_name_fts_idx" ON "files" USING GIN (search_tokens("name"));
CREATE INDEX "people_name_fts_idx" ON "people" USING GIN (search_tokens("name"));
CREATE INDEX "subjects_name_fts_idx" ON "subjects" USING GIN (search_tokens("name"));
