-- One name, two scripts (docs/04 §4.3, docs/07 §7.3).
--
-- The owner of this archive is `Шершнев Евгений Константинович` on every Russian paper in it and
-- `SHERSHNEV EVGENII` on every Serbian one — the same person, filed twice, and neither spelling
-- reaches the other. `Београд` and `Beograd` are the same city. This is neither of the two rules
-- before it: `Б` looks nothing like `B` and `Г` looks nothing like `G`, so no fold of glyphs can
-- join them, and no mark is involved. It is transliteration — a mapping between alphabets, which
-- rewrites whole words and therefore has to be pointed at exactly what it is for.
--
-- Two mappings, because Cyrillic does not have one. Serbian Latin is the official bijective
-- companion of Serbian Cyrillic (`ц`→`c`, `ч`→`č`, `х`→`h`); Russian goes to Latin by the ICAO
-- passport rules (`ц`→`ts`, `ч`→`ch`, `х`→`kh`) — which is not a choice of taste but the spelling
-- printed on this archive's own documents: `SHERSHNEV`, `EVGENII`. A Cyrillic word is stored under
-- both readings rather than guessed at, because guessing the language of a word is how an archive
-- loses a document quietly.
--
-- 🔒 Both functions require their input already lowercased. `translate` is per character and the
-- mappings are written in lowercase only, so an uppercase Cyrillic letter would pass through
-- untouched and leave Cyrillic sitting inside a Latin word. `transliterated_twins` lowercases every
-- run before handing it over; the result is only ever fed to `to_tsvector('simple', …)`, which
-- lowercases anyway, so nothing is lost by it.
CREATE OR REPLACE FUNCTION transliterate_serbian(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate(
      replace(replace(replace($1, 'љ', 'lj'), 'њ', 'nj'), 'џ', 'dž'),
      'абвгдђежзијклмнопрстћуфхцчш',
      'abvgdđežzijklmnoprstćufhcčš'
    )
  $$;

CREATE OR REPLACE FUNCTION transliterate_russian(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT translate(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        $1,
        'щ', 'shch'), 'ж', 'zh'), 'х', 'kh'), 'ц', 'ts'), 'ч', 'ch'),
        'ш', 'sh'), 'ъ', 'ie'), 'ю', 'iu'), 'я', 'ia'), 'ь', ''),
      'абвгдеёзийклмнопрстуфыэ',
      'abvgdeeziiklmnoprstufye'
    )
  $$;

-- Both readings of every Cyrillic word, deduplicated — the two mappings agree far more often than
-- they differ (`Београд` and `москва` read the same either way), and a token is worth storing once.
-- The Serbian reading is folded through `fold_diacritics` so that `чачак` is reachable as `cacak`
-- and not only as `čačak`.
--
-- 🔒 **Three characters is the floor, and it is not arbitrary.** Two-letter Cyrillic words are the
-- function words of both languages — `на`, `он`, `но`, `то`, `за`, `да`, `из`, `по` — and they
-- transliterate into `na`, `on`, `no`, `to`, `za`, `da`, `iz`, `po`, which are words a Latin query
-- uses. The configuration is `simple` and has no stop words, so folding them would let a search for
-- `no` or `on` match every Russian document in the archive. Identifiers are unaffected: they carry
-- digits and are already handled by `homoglyph_twins`.
--
-- 🔒 **The first 64 000 characters of a value, and that bound is load-bearing.** A tsvector may not
-- exceed 1 MB, and this is the only one of the three twin functions that fires on *every word of
-- every Cyrillic document* rather than on the few tokens carrying a digit or a mark — measured, two
-- readings of 12 000 distinct words are 300 kB of vector on their own. Past the bound a document
-- stays findable in the script it was written in, which is exactly the guarantee it had before any
-- of this; under it — every title, every name, every description, every place, and some thirty pages
-- of prose — it is findable in both. A search that misses the tail of one long scan is a smaller
-- failure than a document that cannot be written at all.
CREATE OR REPLACE FUNCTION transliterated_twins(source text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN $1 !~ '[Ѐ-ӿ]' THEN '' ELSE (
      SELECT coalesce(string_agg(DISTINCT reading, ' '), '')
      FROM (
        SELECT lower(match[1]) AS run
        FROM regexp_matches(left($1, 64000), '[[:alnum:]]{3,}', 'g') AS match
        WHERE match[1] ~ '[Ѐ-ӿ]'
      ) AS runs,
      LATERAL (VALUES
        (fold_diacritics(transliterate_serbian(run))),
        (transliterate_russian(run))
      ) AS readings(reading)
    ) END
  $$;

CREATE OR REPLACE FUNCTION search_tokens(source text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT to_tsvector('simple', translate($1, '_-.', '   ')) ||
           to_tsvector('simple', homoglyph_twins($1)) ||
           to_tsvector('simple', unaccented_twins($1)) ||
           to_tsvector('simple', transliterated_twins($1))
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
