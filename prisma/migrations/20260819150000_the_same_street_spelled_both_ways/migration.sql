-- The same street, spelled both ways (docs/04 §4.3, docs/07 §7.3).
--
-- This archive holds one address written twice: `STANISLAVA SREMCEVICA 020A` on an invoice from a
-- Belgrade parts shop, and `Stanislava Sremčevića 20/1` on the utility bill for the same flat. A
-- person searching either spelling finds one of the two documents and has no way to learn the other
-- exists. It is not an OCR accident and not a look-alike: `č` and `c` are different letters that look
-- different, and whether a paper carries the diacritics depends on who typed it — a Serbian
-- registry, a Turkish car rental, a German hotel, or a system that could not.
--
-- 🔒 Unlike the homoglyph fold, this one is about **words**, so both sides fold: the stored side
-- keeps a second reading of every word that carries a mark (`unaccented_twins`), and the query gets
-- a second branch with its own marks removed (`07 §7.3`). Neither alone is enough — a marked query
-- must reach an unmarked paper as surely as the other way round — and OR-ing the branches rather
-- than replacing the query is what keeps the first branch matching the text as written, which is
-- what the highlight is cut from.
--
-- The fold is `unaccent`, not a hand-written table: it already knows Serbian `đ`, Turkish `ı` and
-- `ğ`, and every Latin mark this archive has yet to meet. It leaves Cyrillic exactly as it is.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- The one-argument `unaccent(text)` is STABLE — it resolves its dictionary through `search_path` —
-- and so may appear in neither a generated column nor an index. The two-argument form names the
-- dictionary and is IMMUTABLE; this wrapper is the form the rest of the schema calls.
CREATE FUNCTION fold_diacritics(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT unaccent('unaccent'::regdictionary, $1)
  $$;

-- A second reading of every word that carries a mark, and nothing for the words that do not. The
-- whole text is folded once first: an archive is mostly documents with no marks in them at all, and
-- for those this answers without looking at a single word.
CREATE FUNCTION unaccented_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN fold_diacritics($1) = $1 THEN '' ELSE (
      SELECT coalesce(string_agg(folded, ' '), '')
      FROM (
        SELECT fold_diacritics(match[1]) AS folded, match[1] AS run
        FROM regexp_matches($1, '[[:alnum:]]+', 'g') AS match
      ) AS runs
      WHERE folded <> run
    ) END
  $$;

CREATE OR REPLACE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT to_tsvector('simple', translate($1, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins($1)) ||
           to_tsvector('simple', unaccented_twins($1))
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
