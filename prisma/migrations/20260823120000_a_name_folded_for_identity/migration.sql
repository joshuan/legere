-- The catalogue identity fold (docs/03 §3.3.19, docs/04 §4.3). The database's collation is C,
-- whose lower() folds ASCII alone, so the lower(name) unique indexes below these tables never held
-- for Cyrillic: ШЕРШНЕВ and Шершнев passed as two people. Identity moves onto a stored fold —
-- Unicode-lowercased, whitespace-collapsed — written by the application from here on and backfilled
-- once with the ICU collation, which folds what lower() under C cannot.
--
-- The indexes are plain, not unique, on purpose: the old ASCII-blind indexes admitted duplicates
-- that live in real instances, and a unique index cannot be built over rows that already violate
-- it. Uniqueness on the fold is the application's until the duplicates are merged away; the unique
-- indexes land in a later migration (backlog M49.4), where the lower(name) indexes retire.

ALTER TABLE people ADD COLUMN name_folded text NOT NULL DEFAULT '';
UPDATE people SET name_folded =
  btrim(regexp_replace(lower(normalize(name, NFC) COLLATE "und-x-icu"), '\s+', ' ', 'g'));
CREATE INDEX people_name_folded_idx ON people (name_folded) WHERE deleted_at IS NULL;

ALTER TABLE subjects ADD COLUMN name_folded text NOT NULL DEFAULT '';
UPDATE subjects SET name_folded =
  btrim(regexp_replace(lower(normalize(name, NFC) COLLATE "und-x-icu"), '\s+', ' ', 'g'));
CREATE INDEX subjects_kind_name_folded_idx ON subjects (kind_id, name_folded) WHERE deleted_at IS NULL;

ALTER TABLE subject_kinds ADD COLUMN name_folded text NOT NULL DEFAULT '';
UPDATE subject_kinds SET name_folded =
  btrim(regexp_replace(lower(normalize(name, NFC) COLLATE "und-x-icu"), '\s+', ' ', 'g'));
CREATE INDEX subject_kinds_name_folded_idx ON subject_kinds (name_folded) WHERE deleted_at IS NULL;
