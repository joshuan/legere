-- A bound that holds, and a floor that does (docs/04 §4.3).
--
-- Three things the folds above got wrong, all found by reading them back against real numbers.
--
-- 1. THE BOUND WAS ON THE WRONG FUNCTION. `transliterated_twins` was capped at 64 000 characters
--    because it fires on every word of every Cyrillic document; the other two were left unbounded on
--    the reasoning that they fire only on the few tokens carrying a digit or a mark. That reasoning
--    is about *frequency*, and the ceiling is about *size*. Serbian Latin prose is diacritic-dense,
--    and an OCR'd parts list or bank statement is almost nothing but identifiers, so both functions
--    reach whole-document amplification on exactly the papers this archive is full of. Measured: a
--    326 kB Serbian document indexed to 543 kB before any of this and to 1 060 kB after — over the
--    1 MB a tsvector may hold.
--
--    🔒 That is not a search that misses. `search_vector` is STORED, so it is computed on write: the
--    document's markdown step fails and the OCR that was already paid for is thrown away. Worse,
--    `ADD COLUMN … GENERATED … STORED` recomputes every existing row, so one stored document over
--    the line aborts the migration — which runs on container start, on an instance whose whole
--    promise is that it looks after itself. All three folds are bounded here, by the same constant,
--    for the same reason.
--
-- 2. THREE CHARACTERS WAS NOT A FLOOR. It was chosen to keep two-letter function words — `на`, `он`,
--    `но` — from becoming `na`, `on`, `no`. It does, and it lets through the three-letter ones:
--    `год`→`god`, `сам`→`sam`, `дом`→`dom`, `нет`→`net`, `все`→`vse`, `как`→`kak`, `мир`→`mir`,
--    `сто`→`sto`. `год` is on every dated Russian paper and `сам` in every Serbian sentence, so a
--    search for `god` answered with half the archive. Four characters, and the words that survive
--    are cognates — `план`/`plan`, `дата`/`data`, `банк`/`bank`, `тест`/`test` — which mean the same
--    thing in both languages and are a match worth having rather than a collision.
--
-- 3. HALF OF EVERY FOLD WAS A DUPLICATE. A reading equal to the run it came from is already in the
--    vector this one is concatenated onto, so storing `fold_to_latin` of an all-Latin identifier
--    wrote that token a second time for nothing. Dropping those, and the 32 000 bound, leave the
--    identifier-dense worst case at 931 kB against the 1 MB ceiling where it was 1 240 kB.
--
-- 🔒 32 000 characters covers every title, name, description and place — none of which come near it
-- — and roughly a dozen pages of prose. It is not where the names are: the people and things a
-- document is about are indexed in their own tables (§4.3), whose rows are short and are folded
-- whole, so a name found by the analysis is reachable in every script no matter how long the paper
-- that carries it.
CREATE OR REPLACE FUNCTION homoglyph_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT coalesce(string_agg(DISTINCT reading, ' '), '')
    FROM (
      SELECT match[1] AS run
      FROM regexp_matches(left($1, 32000), '[[:alnum:]]*[0-9][[:alnum:]]*', 'g') AS match
      WHERE match[1] ~ '[АВЕКМНОРСТУХЈЅІавекмнорстухјѕіABEKMHOPCTYXJSIabekmhopctyxjsi]'
    ) AS runs,
    LATERAL (VALUES (fold_to_latin(run)), (fold_to_cyrillic(run))) AS readings(reading)
    WHERE reading <> run
  $$;

CREATE OR REPLACE FUNCTION unaccented_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN fold_diacritics($1) = $1 THEN '' ELSE (
      SELECT coalesce(string_agg(DISTINCT folded, ' '), '')
      FROM (
        SELECT fold_diacritics(match[1]) AS folded, match[1] AS run
        FROM regexp_matches(left($1, 32000), '[[:alnum:]]+', 'g') AS match
      ) AS runs
      WHERE folded <> run
    ) END
  $$;

CREATE OR REPLACE FUNCTION transliterated_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN $1 !~ '[Ѐ-ӿ]' THEN '' ELSE (
      SELECT coalesce(string_agg(DISTINCT reading, ' '), '')
      FROM (
        SELECT lower(match[1]) AS run
        FROM regexp_matches(left($1, 32000), '[[:alnum:]]{4,}', 'g') AS match
        WHERE match[1] ~ '[Ѐ-ӿ]'
      ) AS runs,
      LATERAL (VALUES
        (fold_diacritics(transliterate_serbian(run))),
        (transliterate_russian(run))
      ) AS readings(reading)
      WHERE reading <> run
    ) END
  $$;

-- 🔒 The rule of §4.3: a function these depend on has changed, so the stored column and every
-- expression index built on it are rebuilt rather than left to answer by the old definition.
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
