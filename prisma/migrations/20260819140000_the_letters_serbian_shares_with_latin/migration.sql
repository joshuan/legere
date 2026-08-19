-- The three look-alikes the previous migration missed (docs/04 §4.3).
--
-- The twelve pairs were taken from a Russian number plate, which is made of exactly the Cyrillic
-- letters that read the same to a foreign camera. That is the right set for Russian and the wrong
-- set for the rest of the script: `Ј` (U+0408) is an everyday letter of the Serbian alphabet and is
-- drawn exactly like a Latin `J`, so a JMBG or a chassis number an OCR pass read off a Serbian
-- Cyrillic dozvola came back with a letter no Latin query could reach. `Ѕ` (U+0405) and `І` (U+0406)
-- are Macedonian and Ukrainian rather than Serbian, but an OCR engine set to Cyrillic can emit
-- either where a paper says `S` or `I`, and they belong to the same rule for the same reason.
--
-- 🔒 Replacing the function is not enough. A stored generated column is not recomputed when a
-- function it calls changes, and an expression index is not rebuilt — Postgres has no way to know.
-- Both would go on answering with the old fifteen-less-three mapping, silently, so the column and
-- all four indexes are rebuilt here exactly as they were created.
CREATE OR REPLACE FUNCTION fold_to_latin(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'АВЕКМНОРСТУХЈЅІавекмнорстухјѕі', 'ABEKMHOPCTYXJSIabekmhopctyxjsi')
  $$;

CREATE OR REPLACE FUNCTION fold_to_cyrillic(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate($1, 'ABEKMHOPCTYXJSIabekmhopctyxjsi', 'АВЕКМНОРСТУХЈЅІавекмнорстухјѕі')
  $$;

-- The same three letters join the test for "is there anything here worth a second reading".
CREATE OR REPLACE FUNCTION homoglyph_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(
      string_agg(fold_to_latin(run) || ' ' || fold_to_cyrillic(run), ' '),
      ''
    )
    FROM (
      SELECT match[1] AS run
      FROM regexp_matches($1, '[[:alnum:]]*[0-9][[:alnum:]]*', 'g') AS match
      WHERE match[1] ~ '[АВЕКМНОРСТУХЈЅІавекмнорстухјѕіABEKMHOPCTYXJSIabekmhopctyxjsi]'
    ) AS runs
  $$;

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
