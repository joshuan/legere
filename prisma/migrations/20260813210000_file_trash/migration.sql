-- The trash (docs/05 §5.7a): every file that leaves a document waits here instead of being
-- destroyed by the act that removed it. Replacing a page puts the old scan in; deleting a document
-- puts all of its files in. A file of ours is deleted by the hourly sweep once it is older than
-- TRASH_RETENTION_DAYS; a library original can only ever wait for the person who owns the volume,
-- since Legere may not write to it (ADR-007).
CREATE TYPE "TrashReason" AS ENUM ('REPLACED', 'DOCUMENT_DELETED');

ALTER TABLE "files"
  ADD COLUMN "trashed_at"     TIMESTAMPTZ(6),
  ADD COLUMN "trashed_reason" "TrashReason",
  -- The title the document had when the file left it: a record, not a link. That document is
  -- usually gone by the time anybody reads the trash, and "which paper was this a page of" is the
  -- question they are asking.
  ADD COLUMN "trashed_from"   TEXT,
  -- The file that took this one's place, for the versions of a page (docs/03 §3.3.16).
  ADD COLUMN "replaced_by_id" UUID;

ALTER TABLE "files"
  ADD CONSTRAINT "files_replaced_by_id_fkey"
  FOREIGN KEY ("replaced_by_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The trash is read newest first and swept by age; both are this index.
CREATE INDEX "files_trashed_at_idx" ON "files" ("trashed_at" DESC);
CREATE INDEX "files_replaced_by_id_idx" ON "files" ("replaced_by_id");
