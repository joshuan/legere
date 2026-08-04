-- What a document is about (docs/03 §3.3.20): a flat, a car, a country. The kind says what sort of
-- thing it is, the name says which one — a lease is about *that* flat, a tax return about *that*
-- country, and "the papers for the car" is how anybody actually looks for them.
--
-- `kind` is free text rather than a catalogue of its own. Which kinds a household files by is not
-- knowable in advance, and a fixed list would be wrong in both directions at once: too long to pick
-- from and missing the one thing this person owns. Whether kinds become a catalogue is an open
-- question in docs/03 §3.5.
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create (docs/04 §4.3).
CREATE TABLE "subjects" (
  "id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- One row per living (kind, name): the same flat named twice is the failure this table exists to
-- prevent. Two things of different kinds may share a name — "Montenegro" the country and
-- "Montenegro" the boat — so the kind is part of the identity.
CREATE UNIQUE INDEX "subjects_kind_name_active_uq"
  ON "subjects" (lower("kind"), lower("name")) WHERE "deleted_at" IS NULL;

CREATE INDEX "subjects_kind_idx" ON "subjects" (lower("kind"));

CREATE TABLE "document_subjects" (
  "document_id" UUID NOT NULL,
  "subject_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "document_subjects_pkey" PRIMARY KEY ("document_id", "subject_id")
);

CREATE INDEX "document_subjects_subject_id_idx" ON "document_subjects" ("subject_id");

ALTER TABLE "document_subjects"
  ADD CONSTRAINT "document_subjects_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_subjects"
  ADD CONSTRAINT "document_subjects_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
