-- What sort of thing a subject is becomes a catalogue of its own (docs/03 §3.3.20a). It was free
-- text on the argument that the list of kinds a household files by is not knowable in advance —
-- which was an argument about the *list*, not about the storage. The list stays open: anyone signed
-- in may add a kind and the analysis adds the ones it meets. But now it is a list, so renaming
-- "flat" to "apartment" is one edit rather than forty, browsing has something to show, and the same
-- kind cannot exist twice under two spellings.
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create (docs/04 §4.3).
CREATE TABLE "subject_kinds" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "subject_kinds_pkey" PRIMARY KEY ("id")
);

-- One row per living name, case-insensitively: "Apartment" and "apartment" were one kind while this
-- was a string, and they stay one kind now.
CREATE UNIQUE INDEX "subject_kinds_name_active_uq"
  ON "subject_kinds" (lower("name")) WHERE "deleted_at" IS NULL;

-- One kind per distinct spelling already in use, soft-deleted subjects included: a subject that
-- comes back must still point at something.
INSERT INTO "subject_kinds" ("id", "name")
SELECT gen_random_uuid(), lower("kind")
  FROM "subjects"
 GROUP BY lower("kind");

ALTER TABLE "subjects" ADD COLUMN "kind_id" UUID;

UPDATE "subjects" AS s
   SET "kind_id" = k."id"
  FROM "subject_kinds" AS k
 WHERE k."name" = lower(s."kind");

-- Only now that every row points somewhere: a NOT NULL added before the backfill would fail on the
-- first instance that has any subjects at all.
ALTER TABLE "subjects" ALTER COLUMN "kind_id" SET NOT NULL;

ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_kind_id_fkey"
  FOREIGN KEY ("kind_id") REFERENCES "subject_kinds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The identity of a subject is (kind, name) and always was; what changes is that the kind half is
-- now a row rather than a repeated string.
DROP INDEX "subjects_kind_name_active_uq";
DROP INDEX "subjects_kind_idx";
CREATE UNIQUE INDEX "subjects_kind_name_active_uq"
  ON "subjects" ("kind_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE INDEX "subjects_kind_id_idx" ON "subjects" ("kind_id");

ALTER TABLE "subjects" DROP COLUMN "kind";
