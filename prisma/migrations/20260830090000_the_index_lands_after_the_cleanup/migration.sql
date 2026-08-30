-- The index lands after the cleanup (backlog M49.4, docs/04 §4.3). The fold columns of
-- 20260823120000 carried identity while the duplicates the ASCII-blind lower(name) indexes had
-- admitted were merged away by the operator; with the catalogues clean, uniqueness moves into the
-- database, where a race between two writers cannot slip past the application's check. The
-- lower(name) indexes retire, and the plain fold indexes retire with them: the unique ones serve
-- the same lookups. Partial on living rows, as before — the soft-deleted twins every merge leaves
-- behind stay out of the namespace, which is also what lets this apply on an instance that has
-- just been cleaned by merging.

DROP INDEX "people_name_active_uq";
DROP INDEX "people_name_folded_idx";
CREATE UNIQUE INDEX "people_name_folded_uq"
  ON "people" ("name_folded") WHERE "deleted_at" IS NULL;

DROP INDEX "subjects_kind_name_active_uq";
DROP INDEX "subjects_kind_name_folded_idx";
CREATE UNIQUE INDEX "subjects_kind_name_folded_uq"
  ON "subjects" ("kind_id", "name_folded") WHERE "deleted_at" IS NULL;

DROP INDEX "subject_kinds_name_active_uq";
DROP INDEX "subject_kinds_name_folded_idx";
CREATE UNIQUE INDEX "subject_kinds_name_folded_uq"
  ON "subject_kinds" ("name_folded") WHERE "deleted_at" IS NULL;
