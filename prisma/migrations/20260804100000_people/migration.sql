-- People a document is about (docs/03 §3.3.19): the parties to a contract, the passenger on a
-- ticket, the patient in a report. A shared catalogue rather than names on the document, so the same
-- person on forty documents is one row — and correcting a spelling corrects all forty.
--
-- Many-to-many without a role on the link. A role (buyer, seller, payer) is real and wanted, but
-- what the roles *are* is not knowable yet, and a half-guessed vocabulary is worse than none: the
-- open question is recorded in docs/03 instead.
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create (docs/04 §4.3).
CREATE TABLE "people" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- One row per living name: two people genuinely called the same thing are told apart by the note,
-- which is part of what makes them distinct (docs/04 §4.3).
CREATE UNIQUE INDEX "people_name_active_uq" ON "people" (lower("name")) WHERE "deleted_at" IS NULL;

CREATE TABLE "document_people" (
  "document_id" UUID NOT NULL,
  "person_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "document_people_pkey" PRIMARY KEY ("document_id", "person_id")
);

CREATE INDEX "document_people_person_id_idx" ON "document_people" ("person_id");

ALTER TABLE "document_people"
  ADD CONSTRAINT "document_people_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade on the person too: a physically deleted person leaves no dangling links. Soft delete is
-- what the product uses (ADR-015), and that keeps the links.
ALTER TABLE "document_people"
  ADD CONSTRAINT "document_people_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
